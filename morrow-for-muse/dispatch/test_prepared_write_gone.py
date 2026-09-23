#!/usr/bin/env python3
"""approve-write for a prepared write that is no longer waiting says why,
in plain words, and sends nothing.

Failure modes this suite pins down (written before the fix; known-open
item known-3, final sweep 2026-09-23):
  1. approve-write on a prepared write that was already used (the change
     was sent with the educator's earlier approval) raised a bare
     MissingFrozenPlan. No catalog mode matched it, so the educator heard
     the "unknown" message: "I will not retry anything that might have
     applied" and "engineering review", for a refusal that sent nothing.
  2. The same for a prepared write that expired (plan-write keeps one for
     an hour) or an op id that was never prepared.
  3. The two cases need different next steps. After a used approval the
     change may already be in the course, so preparing it again blindly
     could make it twice: read the course first. After an expiry nothing
     was ever sent: prepare it again. The journal tells them apart.
  4. Asking the journal is a read, but on a tree that had journaled
     nothing yet, find_journal_op minted the journal secret and index
     without the journal file. The next journal read or claim then saw
     "secret without journal" and failed closed as a deleted journal,
     so no change could be made again until an operator repaired it.

Hermetic: fake provider session; journal, approvals, the write halt, and
the signing key live in pytest's tmp_path.
"""

import json
import uuid
from datetime import datetime, timedelta, timezone

from dispatch import executor as ex
from failures.funnel import agent_error_payload
from dispatch.test_round4_write_ceremony import (  # noqa: F401
    CONV, USER, FakeSession, _canvas, _cli, _fake_store, _plan_write_argv,
    _writes, hermetic, hermetic_keys)

RENAMED = {"wiki_page": {"title": "Week 1 Overview"}}


def _approve_argv(op_id):
    return ["approve-write", "--op-id", op_id, "--authorization", "Yes",
            "--backend", "https", "--user-id", USER,
            "--conversation-id", CONV]


def _refused(argv):
    """The CLI funnel's payload for an approve-write that raised."""
    try:
        ex.main(argv)
    except Exception as exc:  # noqa: BLE001 - the CLI funnel's input
        return agent_error_payload(ex._funnel_operation(argv, exc), exc), exc
    raise AssertionError("approve-write raised nothing")


def _prepare(monkeypatch, handler=None):
    session = FakeSession(handler or _canvas())
    _fake_store(monkeypatch, session)
    code, out = _cli(_plan_write_argv(RENAMED))
    assert code == 0, out
    return session, json.loads(out)["op_id"]


def _plain(payload):
    message = payload["message"]
    assert payload["mode_id"] != "unknown", payload
    assert "(unknown)" not in message
    assert "might have applied" not in message
    assert "engineering" not in message
    assert "\u2014" not in message
    assert payload["escalate"] is False
    return message


def test_approving_a_used_prepared_write_again_sends_nothing(monkeypatch):
    session, op_id = _prepare(monkeypatch)
    code, out = _cli(_approve_argv(op_id))
    assert code == 0, out
    assert json.loads(out)["outcome"] == "verified"
    payload, exc = _refused(_approve_argv(op_id))
    assert isinstance(exc, ex.MissingFrozenPlan)
    assert payload["mode_id"] == "prepared-write-already-used"
    message = _plain(payload)
    assert "already sent" in message
    assert "used only once" in message
    assert "read the course" in message
    assert len(_writes(session)) == 1


def test_a_write_that_may_have_reached_canvas_is_already_used(monkeypatch):
    canvas = _canvas()

    def handler(method, url, body):
        if method == "PUT":
            # What ChromiumSession raises when the tab lost its page
            # while the change was in flight.
            raise ex.UncertainWrite("the tab navigated while the change "
                                    "was in flight")
        return canvas(method, url, body)
    session, op_id = _prepare(monkeypatch, handler)
    code, out = _cli(_approve_argv(op_id))
    assert code != 0 and "UncertainWrite" in out
    assert ex.find_journal_op(op_id) is not None
    payload, exc = _refused(_approve_argv(op_id))
    assert payload["mode_id"] == "prepared-write-already-used"
    _plain(payload)
    # The documented next step stays in the technical detail.
    assert "plan-write again" in str(exc)
    assert len(_writes(session)) == 1


def test_an_expired_prepared_write_was_never_sent(monkeypatch):
    session, op_id = _prepare(monkeypatch)
    later = datetime.now(timezone.utc) + timedelta(hours=2)
    assert ex.expire_write_ceremony_files(now=later)[
        "pending_writes_removed"] == 1
    payload, exc = _refused(_approve_argv(op_id))
    assert isinstance(exc, ex.MissingFrozenPlan)
    assert payload["mode_id"] == "prepared-write-not-waiting"
    message = _plain(payload)
    assert "never sent" in message
    assert "nothing changed" in message
    assert "one hour" in message
    assert "prepare the change again" in message
    assert _writes(session) == []


def test_an_op_id_that_was_never_prepared_was_never_sent(monkeypatch):
    session = FakeSession(_canvas())
    _fake_store(monkeypatch, session)
    payload, _exc = _refused(_approve_argv(str(uuid.uuid4())))
    assert payload["mode_id"] == "prepared-write-not-waiting"
    _plain(payload)
    assert _writes(session) == []
    # The refusal read the journal of a tree that had journaled nothing
    # yet; the next change still goes.
    session, op_id = _prepare(monkeypatch)
    code, out = _cli(_approve_argv(op_id))
    assert code == 0, out
    assert json.loads(out)["outcome"] == "verified"


def test_reading_a_fresh_journal_leaves_it_usable(hermetic):
    op_id = str(uuid.uuid4())
    for _ in range(2):
        assert ex.find_journal_op(op_id) is None
        assert ex.claim_is_live(op_id) is False
    assert not (hermetic / "journal" / "ops.secret").exists()
    token = ex.claim_op_id(op_id, "dispatch", "probe", "write", "d" * 64)
    assert ex.claim_is_live(op_id) is True
    ex.release_op_id(op_id, token, "probe released")
    assert ex.claim_is_live(op_id) is False
