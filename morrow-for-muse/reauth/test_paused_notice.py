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
    assert "operation(s) were paused" not in notice
    assert "nothing was paused" in notice
    assert rsm.paused_ops() == []


def test_a_change_parked_by_the_death_is_counted_once(home):
    _session_dies()
    assert rsm.verified_resume_after_manual_signin(777, "Edu T. Or") == 0
    op = str(uuid.uuid4())
    rsm.quarantine_op(op, "create_page", "paused by session death")
    _session_dies()
    assert "1 in-progress operation(s) were paused" in _notice()
    assert [entry["op_id"] for entry in rsm.paused_ops()] == [op]


def test_an_approved_change_is_no_longer_paused(home):
    op = str(uuid.uuid4())
    rsm.impose_halt({"signal": "test"})
    rsm.quarantine_op(op, "create_page", "paused by session death")
    assert rsm.verified_resume_after_manual_signin(777, "Edu T. Or") == 1
    assert "1 paused operation(s) are waiting" in _notice()
    assert rsm.approve_op(op, authorization="Yes") is True
    assert rsm.paused_ops() == []


def test_resume_with_nothing_waiting_clears_the_notice(home):
    _session_dies()
    assert os.path.exists(rsm.NOTIFY_PATH)
    assert rsm.verified_resume_after_manual_signin(777, "Edu T. Or") == 0
    assert not os.path.exists(rsm.NOTIFY_PATH)


def test_skill_tells_the_agent_to_relay_and_clear_the_notice():
    with open(os.path.join(_TREE, "SKILL.md"), encoding="utf-8") as fh:
        skill = fh.read()
    assert "reauth/state_machine.py notify" in skill
