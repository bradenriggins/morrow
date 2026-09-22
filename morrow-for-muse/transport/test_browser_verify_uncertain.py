#!/usr/bin/env python3
"""Browser lane: a failed verify readback after a 2xx write is uncertain.

Failure mode this suite pins down (written before the fix): in the
browser lane's verify phase (complete_browser_verify), a verify op that
came back non-2xx, went missing from the report, or hit a redirect was
journaled as "failed" and raised VerificationFailed "journaled as
failed". The write returned 2xx, so its effect is unconfirmed, not
failed: it must be journaled with verification "uncertain" and raise
UncertainWrite, which the failure catalog maps to
write-readback-unconfirmed (the same as dispatch_entry). A verify that
reads back and proves a different value is still a real failure.

Hermetic: journal, approvals, pending envelopes, and briefs live in
pytest's tmp_path.
"""

import json
import os
import sys
import uuid
from types import SimpleNamespace

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (TREE, os.path.join(TREE, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from dispatch import executor as ex  # noqa: E402
import dispatch.admission as adm  # noqa: E402
from transport import browser_backend as bb  # noqa: E402

BASE = "https://school.instructure.com"
LANE = {"canvas": {"base": BASE,
                   "principal": {"id": 28206, "name": "Test Educator"},
                   "lane": "session", "verified_at": 0}}
ENTRY = {
    "name": "test.create_assignment",
    "provider": "canvas",
    "effects": "write",
    "request": {"method": "POST",
                "url": "{canvas_base}/api/v1/courses/{course_id}/assignments",
                "body": {"assignment": {"name": "params.name"}}},
    "verify": {"method": "GET",
               "url": "{canvas_base}/api/v1/courses/{course_id}/assignments",
               "expect": {"name": "result.name"}},
}
PARAMS = {"course_id": "89585", "name": "Weasel Test"}
BODY = json.dumps({"id": 79, "name": "Weasel Test"})


@pytest.fixture
def lane(tmp_path, monkeypatch):
    monkeypatch.setattr(ex, "JOURNAL_PATH",
                        str(tmp_path / "journal" / "ops.jsonl"))
    monkeypatch.setattr(ex, "WRITE_HALT_PATH", str(tmp_path / "write_halt"))
    monkeypatch.setattr(ex, "live_proven_gate", lambda *a, **k: None)
    monkeypatch.setattr(adm, "APPROVALS_DIR", str(tmp_path / "approvals"))
    monkeypatch.setattr(adm, "CONSUMED_PATH",
                        str(tmp_path / "approvals" / "consumed.json"))
    monkeypatch.setattr(adm, "SECRETS_DIR", str(tmp_path / "secrets"))
    monkeypatch.setattr(adm, "SIGNING_KEY_PATH",
                        str(tmp_path / "secrets" / "approval-signing.key"))
    os.makedirs(str(tmp_path / "approvals"), exist_ok=True)
    return {"briefs": str(tmp_path / "briefs"),
            "pending": str(tmp_path / "pending")}


def _plan(op_id):
    return SimpleNamespace(op_id=op_id, entry_name=ENTRY["name"],
                           before_state_digest=None, digest="plan-digest",
                           path=None,
                           target_identity={"course_id": "89585",
                                            "course_name": "Test Course"},
                           frozen_readback="course 89585 Test Course")


def _report(*ops):
    return "\n".join(["BATCH test: %d operation(s)." % len(ops),
                      "RESULTS_JSON",
                      json.dumps([{"op_id": o[0], "status": o[1],
                                   "body": o[2]} for o in ops])])


def _parked_write(lane):
    op_id = str(uuid.uuid4())
    rec = adm.mint_approval(ENTRY, PARAMS, tenant_base=BASE,
                            target_identity={"course_id": "89585",
                                             "course_name": "Test Course"})
    adm.sign_approval(rec, "selftest: the educator approved this exact "
                           "fixture action", channel="educator-chat")
    env = bb.dispatch_browser_entry(
        ENTRY, PARAMS, LANE, {}, plan=_plan(op_id), op_id=op_id,
        brief_dir=lane["briefs"], pending_dir=lane["pending"], approval=rec)
    out = bb.complete_browser_request(
        op_id, ENTRY, PARAMS, _plan(op_id), _report((op_id, 201, BODY)),
        LANE, {}, brief_dir=lane["briefs"], pending_dir=lane["pending"],
        claim_token=env["claim_token"])
    assert out["phase"] == "verify"
    return op_id, env["claim_token"]


@pytest.mark.parametrize("verify_ops", [
    lambda op: [(op + "-verify", 503, "{}")],
    lambda op: [(op + "-verify", 500, "")],
    lambda op: [],
    lambda op: [(op + "-verify", 302, "")],
], ids=["http-503", "http-500", "missing", "redirect"])
def test_failed_verify_readback_is_uncertain_not_failed(lane, verify_ops):
    op_id, token = _parked_write(lane)
    with pytest.raises(ex.UncertainWrite) as info:
        bb.complete_browser_verify(op_id, _report(*verify_ops(op_id)),
                                   pending_dir=lane["pending"],
                                   claim_token=token)
    exc = info.value
    assert not isinstance(exc, ex.VerificationFailed)
    assert "journaled as failed" not in str(exc)
    rec = ex.find_journal_op(op_id)
    assert rec is not None
    assert rec.get("verification") == "uncertain", rec.get("verification")
    assert rec.get("uncertain") is True

    from failures.funnel import agent_error_payload
    payload = agent_error_payload("browser write", exc)
    assert payload["error"] == "UncertainWrite"
    assert payload["mode_id"] == "write-readback-unconfirmed", payload


def test_proven_verify_mismatch_is_still_failed(lane):
    op_id, token = _parked_write(lane)
    bad = json.dumps({"id": 79, "name": "Something Else"})
    with pytest.raises(ex.VerificationFailed):
        bb.complete_browser_verify(op_id,
                                   _report((op_id + "-verify", 200, bad)),
                                   pending_dir=lane["pending"],
                                   claim_token=token)
    assert ex.find_journal_op(op_id).get("verification") == "failed"
