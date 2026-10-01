#!/usr/bin/env python3
"""One educator reply can re-approve a whole dead batch after resume.

Failure modes this suite pins down (written before the fix):
  1. A batch dying mid-run forced one verbatim re-approval per op after
     re-sign-in. The educator's outage became a re-approval gauntlet.
  2. A batch path could approve ops that never reached awaiting_approval
     (no verified resume yet). Only awaiting_approval ops move.
  3. A batch path could approve some ops and refuse others. Denial,
     blank replies, and missing ledgers approve nothing: one atomic
     rewrite or no rewrite.
  4. A batch path could re-send an already-sent write. Sent ops are
     approved off the paused list only, exactly as the per-op path,
     and the output says so per op.

Hermetic: the re-auth store lives in pytest's tmp_path.
"""

import contextlib
import io
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
    return tmp_path


def _approve_all(monkeypatch, words="Yes, re-approve all three paused changes"):
    monkeypatch.setattr(sys, "argv", ["state_machine.py", "approve",
                                      "--all-awaiting",
                                      "--authorization", words])
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        ok = rsm.cmd_approve()
    return ok, out.getvalue()


def _park_two(home):
    rsm.quarantine_op("op-a-1", "canvas_update_page", "rename page one")
    rsm.quarantine_op("op-a-2", "canvas_update_page", "rename page two")
    assert rsm.mark_ops_awaiting_approval() == 2


def test_batch_approves_every_awaiting_op(home, monkeypatch):
    _park_two(home)
    ok, text = _approve_all(monkeypatch)
    assert ok is True, text
    assert "op-a-1" in text and "op-a-2" in text
    assert rsm.op_quarantine_status("op-a-1") == "approved"
    assert rsm.op_quarantine_status("op-a-2") == "approved"


def test_batch_leaves_quarantined_ops_until_resume(home, monkeypatch):
    rsm.quarantine_op("op-q-1", "canvas_update_page", "rename page")
    ok, text = _approve_all(monkeypatch)
    assert ok is False
    assert "nothing was approved" in text
    assert rsm.op_quarantine_status("op-q-1") == "quarantined"


def test_batch_denial_approves_nothing(home, monkeypatch):
    _park_two(home)
    ok, text = _approve_all(monkeypatch, "No, do not send any of them")
    assert ok is False
    assert rsm.op_quarantine_status("op-a-1") == "awaiting_approval"
    assert rsm.op_quarantine_status("op-a-2") == "awaiting_approval"


def test_batch_blank_reply_approves_nothing(home, monkeypatch):
    _park_two(home)
    ok, _ = _approve_all(monkeypatch, "   ")
    assert ok is False
    assert rsm.op_quarantine_status("op-a-1") == "awaiting_approval"


def test_batch_reports_already_sent_ops_without_resending(home, monkeypatch):
    rsm.quarantine_op("op-s-1", "canvas_update_page", "rename page",
                      write_sent=True)
    assert rsm.mark_ops_awaiting_approval() == 1
    ok, text = _approve_all(monkeypatch, "Yes, clear the paused change")
    assert ok is True, text
    assert "op-s-1" in text
    assert "never sent again" in text
    assert rsm.op_quarantine_status("op-s-1") == "approved"


def test_batch_with_no_ledger_approves_nothing(home, monkeypatch):
    ok, text = _approve_all(monkeypatch)
    assert ok is False
    assert "nothing was approved" in text
