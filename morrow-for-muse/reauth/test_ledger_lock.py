#!/usr/bin/env python3
"""The quarantine ledger fails closed when its lock is unavailable.

Failure modes this suite pins down (written before the fix; sweep 4):
  1. _ledger_locked fell back to an UNLOCKED mutation when flock failed,
     while every rewrite shared one ".mutate" tmp path. Concurrent
     approve/compaction runs then interleaved truncations and renames
     and silently dropped entries from the approval gate's trust
     anchor. An untakable lock now raises (loud, nothing written);
     only standalone compaction still skips, because it is a pure
     optimization that loses nothing.
  2. All rewrites shared one tmp path. Each rewrite now stages to a
     pid-suffixed tmp, so two concurrent rewrites cannot truncate
     each other's staging file.

Hermetic: the re-auth store lives in pytest's tmp_path.
"""

import errno
import os
import sys

import pytest

_TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE not in sys.path:
    sys.path.insert(0, _TREE)

from reauth import state_machine as rsm  # noqa: E402

_PATH_NAMES = ("STATE_PATH", "HALT_PATH", "QUAR_PATH", "NOTIFY_PATH",
               "APPROVAL_PATH", "SESSION_PATH", "SESSION_PREV",
               "LAST_DEATH_PATH", "SESSION_PREV_MONO")


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(rsm, "STORE_DIR", str(tmp_path))
    for name in _PATH_NAMES:
        monkeypatch.setattr(rsm, name, str(
            tmp_path / os.path.basename(getattr(rsm, name))))
    monkeypatch.setattr(rsm, "QUAR_LOCK_PATH",
                        str(tmp_path / "quarantine.jsonl.lock"))
    return tmp_path


def _park_two():
    rsm.quarantine_op("op-l-1", "canvas_update_page", "rename page one")
    rsm.quarantine_op("op-l-2", "canvas_update_page", "rename page two")
    assert rsm.mark_ops_awaiting_approval() == 2


def _break_flock(monkeypatch):
    import fcntl

    def _no_locks(fd, op):
        raise OSError(errno.ENOLCK, "No locks available")

    monkeypatch.setattr(fcntl, "flock", _no_locks)


def test_approve_fails_closed_when_the_lock_is_untakable(home, monkeypatch):
    _park_two()
    before = open(rsm.QUAR_PATH, "rb").read()
    _break_flock(monkeypatch)
    with pytest.raises(OSError):
        rsm.approve_op("op-l-1", "Yes, re-approve this paused change")
    assert open(rsm.QUAR_PATH, "rb").read() == before
    assert rsm.op_quarantine_status("op-l-1") == "awaiting_approval"


def test_quarantine_append_fails_closed_when_lock_is_untakable(home,
                                                               monkeypatch):
    _park_two()
    before = open(rsm.QUAR_PATH, "rb").read()
    _break_flock(monkeypatch)
    with pytest.raises(OSError):
        rsm.quarantine_op("op-l-3", "canvas_update_page", "a third page")
    assert open(rsm.QUAR_PATH, "rb").read() == before
    assert rsm.op_quarantine_status("op-l-3") is None


def test_compaction_skips_loudly_when_the_lock_is_untakable(home,
                                                            monkeypatch,
                                                            capsys):
    _park_two()
    before = open(rsm.QUAR_PATH, "rb").read()
    _break_flock(monkeypatch)
    assert rsm._maybe_compact_ledger() is None  # skipped, not raised
    assert "skipped" in capsys.readouterr().err
    assert open(rsm.QUAR_PATH, "rb").read() == before


def test_rewrites_do_not_use_one_shared_tmp_path(home):
    # A read-only decoy squats the old shared tmp name: a rewrite that
    # still staged there would die truncating it. The pid-suffixed
    # rewrite ignores it and succeeds.
    _park_two()
    decoy = rsm.QUAR_PATH + ".mutate"
    with open(decoy, "w") as fh:
        fh.write("another run's staging file\n")
    os.chmod(decoy, 0o444)
    try:
        assert rsm.approve_op("op-l-1",
                              "Yes, re-approve this paused change") is True
        assert rsm.op_quarantine_status("op-l-1") == "approved"
        with open(decoy) as fh:
            assert fh.read() == "another run's staging file\n"
    finally:
        os.chmod(decoy, 0o600)
