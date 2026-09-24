#!/usr/bin/env python3
"""Single use applies to one signed approval, not to one kind of change.

Failure modes this suite pins down (written before the fix; final sweep
2026-09-22, probes ux1/tests/test_repeat_write.py and
test_session_death_retry.py):
  1. consume_approval recorded the op digest, which covers only the op,
     params, tenant, category, and request. An educator who renamed a
     page, renamed it back, and asked for the first name again approved
     a new plan-write and was refused ("already consumed") for 25 hours.
     The same held for publish, unpublish, publish on one day.
  2. After a session death during approve-write, SKILL.md said a retry
     needs a freshly signed approval. Every fresh approval of the same
     change had the same digest, so the retry was refused too.
  3. Replay of one signed record must still be refused, on the same op
     and on another op.

Hermetic: fake provider session; journal, approvals, the write halt,
and the signing key live in pytest's tmp_path.
"""

import json
import os
import uuid

import pytest

from dispatch import executor as ex
from dispatch.admission import ApprovalMismatch
from dispatch.test_round4_write_ceremony import (  # noqa: F401
    BASE, CONV, METHOD, NAME, PARAMS, PATH, TARGET, USER, FakeSession,
    _canvas, _cli, _entry, _fake_store, _pack, _plan, _plan_write_argv,
    _signed, _writes, hermetic, hermetic_keys)

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RENAMED = {"wiki_page": {"title": "Week 1 Overview"}}
ORIGINAL = {"wiki_page": {"title": "Week 1"}}


def _approve(op_id, words="Yes"):
    return _cli(["approve-write", "--op-id", op_id, "--authorization",
                 words, "--backend", "https", "--user-id", USER,
                 "--conversation-id", CONV])


def _plan_and_approve(body):
    code, out = _cli(_plan_write_argv(body))
    assert code == 0, out
    op_id = json.loads(out)["op_id"]
    code, out = _approve(op_id)
    return op_id, code, out


def test_rename_revert_rename_is_approved_each_time(monkeypatch):
    session = FakeSession(_canvas())
    _fake_store(monkeypatch, session)
    for body in (RENAMED, ORIGINAL, RENAMED):
        _op, code, out = _plan_and_approve(body)
        assert code == 0, out
        assert json.loads(out)["outcome"] == "verified"
    assert len(_writes(session)) == 3


def test_one_signed_record_is_still_single_use(hermetic):
    signed = _signed(RENAMED)
    session = FakeSession(_canvas())
    first = str(uuid.uuid4())
    out = ex.dispatch_catalog_op(
        NAME, METHOD, PATH, "write", PARAMS, plan=_plan(hermetic, first),
        op_id=first, extra={"body": RENAMED}, approval=signed,
        session=session, pack=_pack())
    assert out["outcome"] == "verified"
    second = str(uuid.uuid4())
    with pytest.raises(ApprovalMismatch, match="already consumed"):
        ex.dispatch_catalog_op(
            NAME, METHOD, PATH, "write", PARAMS,
            plan=_plan(hermetic, second), op_id=second,
            extra={"body": RENAMED}, approval=signed, session=session,
            pack=_pack())
    assert len(_writes(session)) == 1


def test_minted_records_carry_distinct_sealed_approval_ids():
    first, second = _signed(RENAMED), _signed(RENAMED)
    assert first["op_digest"] == second["op_digest"]
    assert first["approval_id"] != second["approval_id"]
    tampered = dict(first, approval_id=second["approval_id"])
    from dispatch import admission
    with pytest.raises(ApprovalMismatch):
        admission.consume_approval(tampered)


class SessionDead(ex.ExecutorError):
    """Name-matched by the executor as a lane session-death signal."""


def test_retry_after_session_death_is_a_new_plan_write(monkeypatch,
                                                      hermetic):
    from reauth import state_machine as rsm
    monkeypatch.setattr(rsm, "HALT_PATH", str(hermetic / "write_halt"))
    monkeypatch.setattr(rsm, "QUAR_PATH", str(hermetic / "quarantine.jsonl"))
    monkeypatch.setattr(rsm, "NOTIFY_PATH", str(hermetic / "notify.txt"))
    monkeypatch.setattr(rsm, "STATE_PATH",
                        str(hermetic / "reauth_state.json"))
    canvas = _canvas()
    dead = {"on": True}

    def handler(method, url, body):
        if method == "PUT" and dead["on"]:
            raise SessionDead("the session died during the write")
        return canvas(method, url, body)
    session = FakeSession(handler)
    _fake_store(monkeypatch, session)
    code, out = _cli(_plan_write_argv(RENAMED))
    assert code == 0, out
    op_id = json.loads(out)["op_id"]
    code, out = _approve(op_id)
    assert code != 0
    assert "SessionDead" in out
    # The educator signed in again and resume verified the account.
    dead["on"] = False
    rsm.lift_halt()
    # The used approval cannot be sent again; the prepared write is gone
    # and the refusal names the next step.
    code, out = _approve(op_id)
    assert code != 0
    assert "plan-write again" in out
    # The documented retry: a new plan-write and the educator's new reply.
    _op, code, out = _plan_and_approve(RENAMED)
    assert code == 0, out
    assert json.loads(out)["outcome"] == "verified"


def test_skill_md_names_the_retry_after_session_death():
    with open(os.path.join(TREE, "SKILL.md"), encoding="utf-8") as fh:
        text = " ".join(fh.read().split())
    assert "a retry needs a freshly signed approval" not in text
    assert "run plan-write again" in text
