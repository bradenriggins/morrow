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

Hermetic: fake provider session; journal, approvals, the halt, and the
signing key live in pytest's tmp_path.
"""

import json

import pytest

from dispatch import executor as ex
from failures.funnel import agent_error_payload
from dispatch.test_round4_write_ceremony import (  # noqa: F401
    CONV, USER, FakeSession, _canvas, _cli, _fake_store, _plan_write_argv,
    hermetic, hermetic_keys)

FALSE_PROMISES = ("tell me when to lift it", "someone (or a safety routine)")


@pytest.fixture
def rsm(monkeypatch, hermetic):
    from reauth import state_machine
    for name, file_name in (("HALT_PATH", "write_halt"),
                            ("QUAR_PATH", "quarantine.jsonl"),
                            ("NOTIFY_PATH", "notify.txt"),
                            ("STATE_PATH", "reauth_state.json")):
        monkeypatch.setattr(state_machine, name, str(hermetic / file_name))
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
