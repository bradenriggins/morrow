#!/usr/bin/env python3
"""A write refused while its approval burns leaves nothing pending.

Failure mode this suite pins down (written before the fix; final sweep
2026-09-22, probe final-sweep/muse-engine/test_p5_leak.py):
  The request phase caught only ExecutorError. An ApprovalMismatch (an
  AdmissionRefused, not an ExecutorError) raised by
  _burn_write_approval, because a concurrent dispatch consumed the same
  approval first or the approval could not be persisted, escaped after
  the op_id was claimed. A write that was never sent stayed a pending
  claim: journal-pending listed it as unreconciled, a retry of the same
  op was refused as a duplicate ("NOT safe to re-dispatch blindly"),
  and the approval record stayed persisted under the refused op_id.
  Any failure before a write provider call now releases the claim, and
  a failed burn removes the record it just persisted (never one that
  was on disk before).

Hermetic: fake provider session; journal, approvals, and the signing
key live in pytest's tmp_path.
"""

import os
import uuid

import pytest

from dispatch import executor as ex
import dispatch.admission as admission_mod
from dispatch.admission import ApprovalMismatch
from dispatch.test_round4_write_ceremony import (  # noqa: F401
    APPROVED_BODY, METHOD, NAME, PARAMS, PATH, FakeSession, _canvas,
    _pack, _plan, _signed, _writes, hermetic, hermetic_keys)


def _dispatch(hermetic, op_id, signed, session):
    return ex.dispatch_catalog_op(
        NAME, METHOD, PATH, "write", PARAMS, plan=_plan(hermetic, op_id),
        op_id=op_id, extra={"body": APPROVED_BODY}, approval=signed,
        session=session, pack=_pack())


def _pending(op_id):
    return [p for p in ex.journal_pending_ops() if p["op_id"] == op_id]


def _persisted(op_id):
    return os.path.exists(os.path.join(admission_mod.APPROVALS_DIR,
                                       op_id + ".json"))


def test_losing_the_approval_race_leaves_no_pending_claim(hermetic,
                                                          monkeypatch):
    signed = _signed(APPROVED_BODY)
    real = ex.recompute_before_state

    def winner_consumes_first(*args, **kwargs):
        admission_mod.consume_approval(signed)
        return real(*args, **kwargs)
    monkeypatch.setattr(ex, "recompute_before_state", winner_consumes_first)
    op_id = str(uuid.uuid4())
    session = FakeSession(_canvas())
    with pytest.raises(ApprovalMismatch):
        _dispatch(hermetic, op_id, signed, session)
    assert _writes(session) == []
    assert _pending(op_id) == []
    assert not _persisted(op_id)
    # The op_id is reusable: a fresh claim of it succeeds.
    monkeypatch.setattr(ex, "recompute_before_state", real)
    token = ex.claim_op_id(op_id, "dispatch", NAME, "write", "retry")
    ex.release_op_id(op_id, token, "test cleanup")


def test_an_approval_that_cannot_be_persisted_leaves_no_pending_claim(
        hermetic, monkeypatch):
    def cannot_persist(record, op_id):
        raise ApprovalMismatch("cannot persist signed approval record "
                               "(No space left on device)")
    monkeypatch.setattr(ex, "persist_signed_record", cannot_persist)
    op_id = str(uuid.uuid4())
    session = FakeSession(_canvas())
    with pytest.raises(ApprovalMismatch):
        _dispatch(hermetic, op_id, _signed(APPROVED_BODY), session)
    assert _writes(session) == []
    assert _pending(op_id) == []


def test_any_failure_before_the_write_releases_the_claim(hermetic,
                                                        monkeypatch):
    def broken(*args, **kwargs):
        raise OSError("disk went away")
    monkeypatch.setattr(ex, "recompute_before_state", broken)
    op_id = str(uuid.uuid4())
    session = FakeSession(_canvas())
    with pytest.raises(OSError):
        _dispatch(hermetic, op_id, _signed(APPROVED_BODY), session)
    assert _writes(session) == []
    assert _pending(op_id) == []


def test_a_failure_after_the_write_was_sent_stays_pending(hermetic,
                                                         monkeypatch):
    """After the provider call the effect may have applied: the claim
    stays for reconciliation."""
    def lost_response(method, url, body):
        if method == "PUT":
            raise RuntimeError("transport lost the response")
        return _canvas()(method, url, body)
    op_id = str(uuid.uuid4())
    session = FakeSession(lost_response)
    with pytest.raises(RuntimeError):
        _dispatch(hermetic, op_id, _signed(APPROVED_BODY), session)
    assert len(_writes(session)) == 1
    assert _pending(op_id)


def test_a_failed_burn_keeps_an_approval_file_that_was_there_before(
        hermetic, monkeypatch):
    """The file ceremony puts the signed record at approvals/<op_id>.json
    before dispatch; a failed consume must not delete the educator's
    approval."""
    signed = _signed(APPROVED_BODY)
    op_id = str(uuid.uuid4())
    admission_mod.persist_signed_record(signed, op_id)

    def cannot_consume(record):
        raise ApprovalMismatch("cannot record approval consumption "
                               "(No space left on device)")
    monkeypatch.setattr(ex, "consume_approval", cannot_consume)
    with pytest.raises(ApprovalMismatch):
        _dispatch(hermetic, op_id, signed, FakeSession(_canvas()))
    assert _persisted(op_id)
    assert _pending(op_id) == []
