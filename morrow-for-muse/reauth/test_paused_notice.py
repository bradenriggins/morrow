#!/usr/bin/env python3
"""The paused-changes notice counts only changes that are still paused.

Failure modes this suite pins down (written before the fix; round-2
finding, 2026-09-23):
  1. The notice the helper page shows counted every quarantine-ledger
     entry as an "in-progress operation paused", including the
     session-death records of past incidents. Three expired sign-ins
     with no change in flight read "3 in-progress operation(s) were
     paused and saved".
  2. After resume with nothing waiting, the notice kept saying "N
     paused operation(s) are waiting for your approval" on the helper
     page, because only `state_machine.py notify` clears it and
     SKILL.md never told the agent to run it.
  3. A change that was on its way to Canvas when the session ended was
     called "paused and saved. Nothing was lost", and the educator was
     told it would resume after their OK. Canvas may already hold it,
     and it never resumes: approve-write refuses it, and approve said
     "approved for re-dispatch". The notices must say Canvas may
     already have it and that Morrow checks the course before it
     prepares the change again, and approve must not promise to send
     it. (Round-2 finding muse-ux-r2-expiry-notice-uncertain-paused,
     2026-09-23, written before the fix.)
  4. The notices said "operation(s)". They say "change" or "changes".

Hermetic: the re-auth store and the pin record live in pytest's
tmp_path; the helper browser is a fake transport.
"""

import os
import sys
import uuid

import pytest

_TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (_TREE, os.path.join(_TREE, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from reauth import state_machine as rsm  # noqa: E402
from transport import chromium_session as cs  # noqa: E402
from transport import state as lane_state  # noqa: E402

BASE = "https://school.instructure.com"
_PATH_NAMES = ("STATE_PATH", "HALT_PATH", "QUAR_PATH", "NOTIFY_PATH",
               "APPROVAL_PATH", "SESSION_PATH", "SESSION_PREV",
               "LAST_DEATH_PATH", "SESSION_PREV_MONO")


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(rsm, "STORE_DIR", str(tmp_path))
    for name in _PATH_NAMES:
        monkeypatch.setattr(rsm, name, str(
            tmp_path / os.path.basename(getattr(rsm, name))))
    monkeypatch.setattr(lane_state, "STATE_PATH",
                        str(tmp_path / "browser_lane.json"))
    lane_state.save(BASE, 777, "Edu T. Or")
    return tmp_path


class _DeadHelper:
    def api(self, *args, **kwargs):
        raise cs.lc.SessionDead("no live Canvas session in the local "
                                "browser (GET users/self -> 302)")


def _session_dies():
    """One incident: the Chromium lane finds the helper's session dead."""
    session = cs.ChromiumSession(BASE, transport=_DeadHelper())
    with pytest.raises(cs.ChromiumSessionDead):
        session.raw_request("GET", BASE + "/api/v1/courses/101", {}, None)


def _notice():
    with open(rsm.NOTIFY_PATH, encoding="utf-8") as fh:
        return fh.read()


def test_past_incidents_are_not_counted_as_paused_changes(home):
    for _ in range(3):
        _session_dies()
        assert rsm.verified_resume_after_manual_signin(777, "Edu T. Or") \
            == 0
    _session_dies()
    assert len(rsm.session_deaths()) == 4
    notice = _notice()
    assert "stopped before Morrow sent" not in notice
    assert "nothing was paused" in notice
    assert rsm.paused_ops() == []


def test_a_change_parked_by_the_death_is_counted_once(home):
    _session_dies()
    assert rsm.verified_resume_after_manual_signin(777, "Edu T. Or") == 0
    op = str(uuid.uuid4())
    rsm.quarantine_op(op, "create_page", "paused by session death")
    _session_dies()
    assert "1 change was stopped before Morrow sent it" in _notice()
    assert [entry["op_id"] for entry in rsm.paused_ops()] == [op]


def test_an_approved_change_is_no_longer_paused(home):
    op = str(uuid.uuid4())
    rsm.impose_halt({"signal": "test"})
    rsm.quarantine_op(op, "create_page", "paused by session death")
    assert rsm.verified_resume_after_manual_signin(777, "Edu T. Or") == 1
    assert "1 change that was not sent is waiting for your OK" in _notice()
    assert rsm.approve_op(op, authorization="Yes") is True
    assert rsm.paused_ops() == []


def test_resume_with_nothing_waiting_clears_the_notice(home):
    _session_dies()
    assert os.path.exists(rsm.NOTIFY_PATH)
    assert rsm.verified_resume_after_manual_signin(777, "Edu T. Or") == 0
    assert not os.path.exists(rsm.NOTIFY_PATH)


# Words that promise a change Canvas may already hold comes back later,
# or that call it safe.
_RESUME_PROMISES = ("resume", "paused and saved", "Nothing was lost",
                    "operation")


def test_a_change_that_may_be_in_canvas_is_never_promised_to_resume(home):
    op = str(uuid.uuid4())
    rsm.quarantine_op(op, "canvas_update_create_page_courses",
                      "SessionDead mid-write", write_sent=True)
    _session_dies()
    notice = _notice()
    assert "1 change may already be in Canvas" in notice, notice
    assert "checks the course first" in notice
    assert "prepares the change again" in notice
    for promise in _RESUME_PROMISES:
        assert promise not in notice, promise
    assert rsm.verified_resume_after_manual_signin(777, "Edu T. Or") == 1
    notice = _notice()
    assert "1 change may already be in Canvas" in notice, notice
    assert "checks the course" in notice
    for promise in _RESUME_PROMISES:
        assert promise not in notice, promise


def test_sent_and_unsent_changes_are_counted_apart(home):
    for _ in range(2):
        rsm.quarantine_op(str(uuid.uuid4()), "create_page", "mid-write",
                          write_sent=True)
    for _ in range(3):
        rsm.quarantine_op(str(uuid.uuid4()), "create_page", "before send")
    _session_dies()
    notice = _notice()
    assert "2 changes may already be in Canvas" in notice, notice
    assert "prepares any of them again" in notice
    assert "3 changes were stopped before Morrow sent them" in notice
    assert "operation" not in notice
    assert rsm.verified_resume_after_manual_signin(777, "Edu T. Or") == 5
    notice = _notice()
    assert "2 changes may already be in Canvas" in notice, notice
    assert "3 changes that were not sent are waiting for your OK" in notice
    assert "operation" not in notice


def test_approving_a_change_that_may_be_in_canvas_does_not_promise_to_send(
        home, monkeypatch, capsys):
    op = str(uuid.uuid4())
    rsm.impose_halt({"signal": "test"})
    rsm.quarantine_op(op, "create_page", "mid-write", write_sent=True)
    assert rsm.verified_resume_after_manual_signin(777, "Edu T. Or") == 1
    monkeypatch.setattr(sys, "argv", ["state_machine.py", "approve",
                                      "--op-id", op, "--authorization",
                                      "Yes, go ahead"])
    assert rsm.cmd_approve() is True
    out = capsys.readouterr().out
    assert "re-dispatch" not in out, out
    assert "may already be in Canvas" in out
    assert "plan-write" in out
    assert rsm.paused_ops() == []


def test_the_ledger_records_whether_the_change_was_sent(
        home, monkeypatch, capsys):
    sent, unsent = str(uuid.uuid4()), str(uuid.uuid4())
    rsm.quarantine_op(sent, "create_page", "mid-write", write_sent=True)
    rsm.quarantine_op(unsent, "create_page", "before send")
    by_op = {entry["op_id"]: entry for entry in rsm.paused_ops()}
    assert by_op[sent]["write_sent"] is True
    assert by_op[unsent]["write_sent"] is False
    rsm.mark_ops_awaiting_approval()
    by_op = {entry["op_id"]: entry for entry in rsm.paused_ops()}
    assert by_op[sent]["write_sent"] is True
    # The agent reads which changes may be in Canvas from `status`.
    monkeypatch.setattr(rsm, "expiry_horizon_warning",
                        lambda: (None, False, "unknown"))
    monkeypatch.setattr(sys, "argv", ["state_machine.py", "status"])
    rsm.cmd_status()
    rows = {line.split(" op_id=")[1].split()[0]: line
            for line in capsys.readouterr().out.splitlines()
            if " op_id=" in line}
    assert "write_sent=True" in rows[sent]
    assert "write_sent" not in rows[unsent]


def test_skill_tells_the_agent_to_relay_and_clear_the_notice():
    with open(os.path.join(_TREE, "SKILL.md"), encoding="utf-8") as fh:
        skill = fh.read()
    assert "reauth/state_machine.py notify" in skill


def test_skill_says_to_check_the_course_before_preparing_a_sent_change_again():
    with open(os.path.join(_TREE, "SKILL.md"), encoding="utf-8") as fh:
        skill = " ".join(fh.read().split())
    assert "may already be in Canvas" in skill
    assert "write_sent=True" in skill
