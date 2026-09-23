#!/usr/bin/env python3
"""Approving a paused change that is not waiting says why, and that
nothing was sent.

Failure modes this suite pins down (written before the fix; final sweep
2026-09-23, item approve-refusal-reads-as-maybe-applied):
  1. `state_machine.py approve` refused an op still quarantined (resume
     had not run yet) with {"error": "ApprovalRefused"}. No catalog mode
     matched, so the educator heard the unknown message: "the task might
     have made a change", and to email support. Approving re-sends
     nothing; the refusal changed nothing.
  2. The same for an op already approved (approved twice) and an op id
     with no record.
  3. The next step differs by status: resume first (quarantined), it is
     already approved (approved), or check the op id (no record). The
     status reaches the translator as evidence.
  4. A blank reply ("   ") reached approve_op, whose ValueError also
     fell to the unknown message. A blank reply is no approval: the
     usage text says the educator must say the words.

Hermetic: the re-auth store lives in pytest's tmp_path.
"""

import contextlib
import io
import os
import subprocess
import sys

import pytest

_TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE not in sys.path:
    sys.path.insert(0, _TREE)

from reauth import state_machine as rsm  # noqa: E402

_PATH_NAMES = ("STATE_PATH", "HALT_PATH", "QUAR_PATH", "NOTIFY_PATH",
               "APPROVAL_PATH", "SESSION_PATH", "SESSION_PREV",
               "LAST_DEATH_PATH", "SESSION_PREV_MONO")
MAYBE_APPLIED = "might have made a change"


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(rsm, "STORE_DIR", str(tmp_path))
    for name in _PATH_NAMES:
        monkeypatch.setattr(rsm, name, str(
            tmp_path / os.path.basename(getattr(rsm, name))))
    return tmp_path


def _approve(monkeypatch, op_id, words="Yes, go ahead"):
    monkeypatch.setattr(sys, "argv", ["state_machine.py", "approve",
                                      "--op-id", op_id,
                                      "--authorization", words])
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        ok = rsm.cmd_approve()
    return ok, out.getvalue()


def _refusal(text, mode_id):
    assert "[mode: %s " % mode_id in text, text
    assert "escalate: no" in text, text
    assert MAYBE_APPLIED not in text
    assert "hello@meetmorrow.app" not in text
    assert "nothing" in text.lower()
    assert "—" not in text
    assert "(unknown" not in text


def test_approving_before_resume_says_to_sign_in_first(home, monkeypatch):
    rsm.quarantine_op("op-paused-1", "canvas_update_page", "rename page")
    assert rsm.op_quarantine_status("op-paused-1") == "quarantined"
    ok, text = _approve(monkeypatch, "op-paused-1")
    assert ok is False
    _refusal(text, "paused-change-not-resumed")
    assert "sign" in text.lower()
    assert rsm.op_quarantine_status("op-paused-1") == "quarantined"


def test_approving_twice_says_it_is_already_approved(home, monkeypatch):
    rsm.quarantine_op("op-paused-2", "canvas_update_page", "rename page")
    assert rsm.mark_ops_awaiting_approval() == 1
    ok, text = _approve(monkeypatch, "op-paused-2")
    assert ok is True, text
    assert rsm.op_quarantine_status("op-paused-2") == "approved"
    ok, text = _approve(monkeypatch, "op-paused-2")
    assert ok is False
    _refusal(text, "paused-change-already-approved")
    assert "already approved" in text
    assert rsm.op_quarantine_status("op-paused-2") == "approved"


def test_approving_an_unknown_op_says_nothing_is_waiting(home, monkeypatch):
    rsm.quarantine_op("op-paused-3", "canvas_update_page", "rename page")
    ok, text = _approve(monkeypatch, "op-typo")
    assert ok is False
    _refusal(text, "paused-change-not-waiting")
    assert rsm.op_quarantine_status("op-paused-3") == "quarantined"


def test_approving_with_an_empty_ledger_says_nothing_is_waiting(
        home, monkeypatch):
    ok, text = _approve(monkeypatch, "op-anything")
    assert ok is False
    _refusal(text, "paused-change-not-waiting")


def test_a_blank_reply_is_no_approval(home, monkeypatch):
    rsm.quarantine_op("op-paused-4", "canvas_update_page", "rename page")
    rsm.mark_ops_awaiting_approval()
    ok, text = _approve(monkeypatch, "op-paused-4", words="   ")
    assert ok is False
    assert MAYBE_APPLIED not in text
    assert "must actually say the words" in text
    assert rsm.op_quarantine_status("op-paused-4") == "awaiting_approval"


def test_the_cli_prints_the_refusal_end_to_end(tmp_path):
    env = dict(os.environ, HOME=str(tmp_path),
               MORROW_HOME=str(tmp_path / ".morrow"),
               PYTHONDONTWRITEBYTECODE="1")
    script = os.path.join(_TREE, "reauth", "state_machine.py")
    subprocess.run([sys.executable, script, "quarantine", "--op-id",
                    "op-cli-1", "--action", "canvas_update_page"],
                   env=env, cwd=str(tmp_path), check=True,
                   capture_output=True, text=True, timeout=60)
    proc = subprocess.run([sys.executable, script, "approve", "--op-id",
                           "op-cli-1", "--authorization", "Yes"],
                          env=env, cwd=str(tmp_path), capture_output=True,
                          text=True, timeout=60)
    assert proc.returncode == 1
    _refusal(proc.stdout, "paused-change-not-resumed")
