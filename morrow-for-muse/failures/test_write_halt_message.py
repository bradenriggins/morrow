#!/usr/bin/env python3
"""A paused write says why it is paused and what really lifts the pause.

Failure mode this suite pins down (written before the fix; final sweep
2026-09-22, probe ux1/tests/test_halt_message.py): after a session
expiry imposed the write halt, every write told the educator that
"someone (or a safety routine) deliberately paused writes" and "tell me
when to lift it". No command lifts the halt on the educator's word: it
lifts only after the educator signs in again and `resume` verifies the
account. The real next step was never stated.

The session-expiry halt (and an op quarantined by it) now names the
expired sign-in and the helper page. A halt an operator placed by hand
keeps its own wording: nothing the educator says lifts it.

Second failure mode (round-2 finding, 2026-09-23): the Chromium lane,
the lane Muse runs, wrote its own halts with other reasons ("chromium
session death (...)" and "a different Canvas account is signed in to
the helper"). halt_cause() read only the reason text, so both were
called an operator's pause: after an expired sign-in, or after another
account signed in to the helper, every later write told the educator
that someone else paused changes and nothing they say lifts it, while
the real remedy was to sign in again and run resume. The halt file now
records its cause, and each cause has its own message.

Hermetic: fake provider session; journal, approvals, the halt, and the
signing key live in pytest's tmp_path.
"""

import json

import pytest

from dispatch import executor as ex
from failures.funnel import agent_error_payload
from dispatch.test_round4_write_ceremony import (  # noqa: F401
    CONV, METHOD, NAME, PARAMS, PATH, USER, FakeSession, _canvas, _cli,
    _fake_store, _plan_write_argv, hermetic, hermetic_keys)
from dispatch.test_direct_lane_hardening import BASE, _pack
from transport import chromium_session as cs
from transport import state as lane_state

FALSE_PROMISES = ("tell me when to lift it", "someone (or a safety routine)")


@pytest.fixture
def rsm(monkeypatch, hermetic):
    from reauth import state_machine
    for name, file_name in (("HALT_PATH", "write_halt"),
                            ("QUAR_PATH", "quarantine.jsonl"),
                            ("NOTIFY_PATH", "notify.txt"),
                            ("STATE_PATH", "reauth_state.json"),
                            ("LAST_DEATH_PATH", "last_death.json"),
                            ("SESSION_PATH", "session.json")):
        monkeypatch.setattr(state_machine, name, str(hermetic / file_name))
    monkeypatch.setattr(lane_state, "STATE_PATH",
                        str(hermetic / "browser_lane.json"))
    return state_machine


def _approve_refused(monkeypatch):
    _fake_store(monkeypatch, FakeSession(_canvas()))
    code, out = _cli(_plan_write_argv({"wiki_page": {"title": "Week 2"}}))
    assert code == 0, out
    argv = ["approve-write", "--op-id", json.loads(out)["op_id"],
            "--authorization", "Yes", "--backend", "https",
            "--user-id", USER, "--conversation-id", CONV]
    with pytest.raises(ex.WriteHaltActive) as exc:
        ex.main(argv)
    return agent_error_payload(ex._funnel_operation(argv), exc.value)


def test_a_session_expiry_pause_names_the_sign_in(monkeypatch, rsm):
    rsm.impose_halt({"signal": "401_unauthenticated"})
    payload = _approve_refused(monkeypatch)
    assert payload["mode_id"] == "write-halt-session-expired"
    message = payload["message"]
    for phrase in FALSE_PROMISES:
        assert phrase not in message
    assert "sign-in expired" in message
    assert "Sign in again on the helper page" in message
    assert "ask you before" in message


def test_a_manual_pause_says_the_educator_cannot_lift_it(monkeypatch, rsm,
                                                         hermetic):
    (hermetic / "write_halt").write_text(json.dumps(
        {"halted_at": "2026-09-22T00:00:00Z", "reason": "operator pause"}))
    payload = _approve_refused(monkeypatch)
    assert payload["mode_id"] == "write-halt-active"
    message = payload["message"]
    for phrase in FALSE_PROMISES:
        assert phrase not in message
    assert "I cannot lift it" in message


def test_an_unreadable_pause_file_is_a_manual_pause(monkeypatch, rsm,
                                                    hermetic):
    (hermetic / "write_halt").write_text("")
    payload = _approve_refused(monkeypatch)
    assert payload["mode_id"] == "write-halt-active"


class _DeadHelper:
    """The helper browser holds no live Canvas session."""

    def api(self, *args, **kwargs):
        raise cs.lc.SessionDead("no live Canvas session in the local "
                                "browser (GET users/self -> 302)")


class _SignedInAs:
    """The helper browser is signed in as this Canvas account."""

    def __init__(self, account_id):
        self.account_id = account_id

    def api(self, method, path, body, **kwargs):
        return 200, {}, json.dumps({"id": self.account_id,
                                    "name": "Someone Else"})


def test_a_chromium_session_death_pause_names_the_sign_in(monkeypatch,
                                                          rsm):
    # Plan mode, expired sign-in: plan-write's course read finds the
    # helper's session dead, and the Chromium lane imposes the halt.
    session = cs.ChromiumSession(BASE, transport=_DeadHelper())
    with pytest.raises(cs.ChromiumSessionDead):
        ex.prepare_plan_write(NAME, METHOD, PATH, dict(PARAMS),
                              {"wiki_page": {"title": "Week 2"}}, session,
                              _pack())
    assert rsm.halt_cause() == "session_expired"
    payload = _approve_refused(monkeypatch)
    assert payload["mode_id"] == "write-halt-session-expired"
    message = payload["message"]
    assert "I cannot lift it" not in message
    assert "Sign in again on the helper page" in message


def test_another_account_signed_in_pause_says_to_sign_back_in(monkeypatch,
                                                              rsm):
    lane_state.save(BASE, 777, "Edu T. Or")
    session = cs.ChromiumSession(BASE)
    with pytest.raises(cs.PrincipalMismatch):
        session._verify_principal(_SignedInAs(999), is_write=True)
    assert rsm.halt_cause() == "account_mismatch"
    payload = _approve_refused(monkeypatch)
    assert payload["mode_id"] == "write-halt-account-mismatch"
    message = payload["message"]
    for phrase in FALSE_PROMISES + ("I cannot lift it",
                                    "person who looks after"):
        assert phrase not in message
    assert "different Canvas account" in message
    assert "sign back in with your own account" in message
    assert "reauth/state_machine.py resume" in payload["auto_action"]
    # The pinned account signing back in lifts it, as for an expiry.
    assert rsm.verified_resume_after_manual_signin(777, "Edu T. Or") == 0
    assert rsm.halt_cause() is None


@pytest.mark.parametrize("reason, cause", [
    ("session_expiry", "session_expired"),
    ("chromium session death (session_ended)", "session_expired"),
    ("a different Canvas account is signed in to the helper",
     "account_mismatch"),
    ("operator pause", "manual"),
])
def test_a_halt_written_before_causes_were_recorded(rsm, hermetic, reason,
                                                    cause):
    # 0.4.0 wrote only a reason; a halt standing across the upgrade keeps
    # its meaning.
    (hermetic / "write_halt").write_text(json.dumps(
        {"halted_at": "2026-09-22T00:00:00Z", "reason": reason}))
    assert rsm.halt_cause() == cause


def test_an_unknown_recorded_cause_is_a_manual_pause(rsm, hermetic):
    (hermetic / "write_halt").write_text(json.dumps(
        {"halted_at": "2026-09-22T00:00:00Z", "reason": "session_expiry",
         "cause": "operator"}))
    assert rsm.halt_cause() == "manual"
