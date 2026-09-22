#!/usr/bin/env python3
"""Selftest for the admission gate (dispatch/admission.py).

Covers: never-dispatch by name and by URL, unsupported, tenant-restricted,
learner-data gating, v2 write approval (missing / wrong approver / wrong op /
digest mismatch / tenant retarget / category mismatch / expired / future-dated /
no citation / replay / v1 retired / happy path), category derivation, op-digest
binding, reads needing no approval, and the mint/sign approval flow.
"""
import os as _home_os, sys as _home_sys  # noqa: E401
_home_sys.path.insert(0, _home_os.path.join(
    _home_os.path.dirname(_home_os.path.abspath(__file__)), '..'))
import config.selftest_home  # noqa: E402,F401  (scratch HOME/MORROW_HOME)
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "dispatch"))
# Repo root second: admission.py's `from privacy import learner_vault` needs
# it, while `import admission` above still resolves via the dispatch dir.
sys.path.insert(1, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from admission import (
    admit,
    approval_audit_for,
    canonical_params_digest,
    consume_approval,
    entry_category,
    load_approval,
    load_policy,
    mint_approval,
    op_digest_of,
    param_tokens,
    persist_signed_record,
    reverify_approval,
    sign_approval,
    touches_learner_data,
    APPROVAL_VERSION,
    MAX_APPROVAL_TTL_SECONDS,
    NeverDispatch,
    UnsupportedOperation,
    EvidenceHold,
    LearnerDataGated,
    WriteApprovalMissing,
    ApprovalMismatch,
)
import admission as _admission_mod

# Hermetic single-use store for this selftest: consumption must not touch
# the product's real consumed-approvals file.
_HERE = os.path.dirname(os.path.abspath(__file__))
_admission_mod.CONSUMED_PATH = os.path.join(_HERE, ".consumed-selftest.json")

# Start clean: remove any leftover consumed file or seal from a prior
# run (W6-P1-6: a surviving seal with a deleted file fails closed, so
# both must go).
for _p in (_admission_mod.CONSUMED_PATH,
           _admission_mod.CONSUMED_PATH + ".seal",
           _admission_mod.CONSUMED_PATH + ".lock"):
    try:
        os.remove(_p)
    except OSError:
        pass
del _p


def _write_consumed_sealed(data):
    """Write the consumed file directly AND re-seal it (W6-P1-6).

    Tests that plant consumed state via direct file writes must keep
    the HMAC seal in sync, or _load_consumed's verification fails
    closed."""
    with open(_admission_mod.CONSUMED_PATH, "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    _admission_mod._write_consumed_seal()

# Hermetic approvals dir and signing key: sealing, persistence, and the
# provenance tests must not touch the product's real ~/.morrow/approvals.
# Hygiene: never /tmp. Test scratch lives under this file's directory so it
# survives on the persistent workspace volume; the wave's authorized scratch
# area can take over via MORROW_SELFTEST_SCRATCH.
import tempfile as _tempfile
_SELFTEST_WORK = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              ".selftest-work")
if os.environ.get("MORROW_SELFTEST_SCRATCH"):
    _SELFTEST_WORK = os.path.join(os.environ["MORROW_SELFTEST_SCRATCH"],
                                  "admission")
os.makedirs(_SELFTEST_WORK, exist_ok=True)
_HERM_DIR = _tempfile.mkdtemp(prefix="morrow-approvals-selftest-",
                              dir=_SELFTEST_WORK)
_admission_mod.APPROVALS_DIR = _HERM_DIR
_admission_mod.SIGNING_KEY_PATH = os.path.join(_HERM_DIR, ".signing.key")

PASS = []
FAIL = []


def check(name, fn):
    try:
        fn()
    except AssertionError as exc:
        FAIL.append("%s: %s" % (name, exc))
    except Exception as exc:  # noqa: BLE001 - the test wants the message
        FAIL.append("%s: unexpected %r" % (name, exc))
    else:
        PASS.append(name)


def expect_raises(exc_type, fn):
    try:
        fn()
    except exc_type:
        return
    except Exception as exc:  # noqa: BLE001
        raise AssertionError("expected %s, got %r" % (exc_type.__name__, exc))
    raise AssertionError("expected %s, nothing raised" % exc_type.__name__)


def read_entry(name, method="GET", path="/api/v1/courses/{course_id}", effects="read"):
    return {
        "name": name,
        "effects": effects,
        "provider": "canvas",
        "request": {"method": method, "url": "{canvas_base}" + path},
    }


AUTH = ("selftest: the educator explicitly approved this exact action "
        "in the test harness")
IDENT_AUTH = ("selftest: the educator named the identities this op touches, "
              "in their own words, for this exact action")


def signed_approval(entry, params, tenant="https://x.instructure.com", ttl=3600,
                    channel="educator-chat"):
    # W6-P1-A2: the happy-path helper signs educator-channel, like a
    # genuine educator reply. Driver-channel cases pass
    # channel="driver" explicitly.
    rec = mint_approval(entry, params, tenant_base=tenant, ttl_seconds=ttl,
                        target_identity={
                            "course_id": params.get("course_id"),
                            "course_name": "Admission Selftest",
                        } if params.get("course_id") else None)
    return sign_approval(rec, AUTH, channel=channel)


def write_entry(name="canvas_create_page", method="POST",
                path="/api/v1/courses/{course_id}/pages"):
    return read_entry(name, method=method, path=path, effects="write")


# 1. Policy loads and has the expected shape.
def t_policy_shape():
    p = load_policy()
    assert p["version"] == "1.3.0", "policy version"
    assert len(p["never_dispatch"]["tool_names"]) == 8, "8 never-dispatch tools"
    assert "canvas_item_bank_get_item" in p["unsupported"]["tool_names"]
    assert "tenant_restricted" not in p, "no tenant allowlists anywhere"
    assert len(p["evidence_holds"]["tool_names"]) == 5, "5 evidence-held tools"
    assert "canvas_create_new_quiz" in p["admitted_on_proof"], \
        "create_new_quiz admitted on proof"
    assert "/users" in p["learner_data"]["url_substrings"]
check("policy loads with expected shape", t_policy_shape)


# 2. Never-dispatch by tool name.
def t_never_by_name():
    e = read_entry("canvas_set_feature_flag_courses", method="PUT",
                   path="/api/v1/courses/{course_id}/features/flags/{feature}",
                   effects="write")
    expect_raises(NeverDispatch, lambda: admit(e, {}, tenant_base="https://x.instructure.com"))
check("never-dispatch by tool name", t_never_by_name)


# 3. Never-dispatch by URL substring (messages to people).
def t_never_by_url():
    e = read_entry("some_custom_message_op", method="POST",
                   path="/api/v1/courses/1/discussion_topics/2/entries",
                   effects="write")
    e["request"]["url"] = "{canvas_base}/api/v1/conversations"
    expect_raises(NeverDispatch, lambda: admit(e, {}, tenant_base="https://x.instructure.com"))
check("never-dispatch by URL substring (conversations)", t_never_by_url)


# 4. Never-dispatch beats educator approval (no override).
def t_never_no_override():
    e = read_entry("canvas_remove_feature_flag_courses", method="DELETE",
                   path="/api/v1/courses/{course_id}/features/flags/{feature}",
                   effects="write")
    ap = signed_approval(e, {})
    expect_raises(NeverDispatch,
                  lambda: admit(e, {}, tenant_base="https://x.instructure.com", approval=ap))
check("never-dispatch cannot be overridden by approval", t_never_no_override)


# 5. Unsupported.
def t_unsupported():
    e = read_entry("canvas_item_bank_get_item", path="/api/banks/1/items/2")
    expect_raises(UnsupportedOperation, lambda: admit(e, {}))
check("unsupported operation refused", t_unsupported)


# 6. No tenant gating anywhere: create_new_quiz was admitted on proof
#    (2026-09-22 lane-7 battery, admission_policy.json v1.2.0), so it is
#    admitted on EVERY tenant, never by tenant.
def t_no_tenant_gating_create_quiz():
    e = read_entry("canvas_create_new_quiz", method="POST",
                   path="/api/quiz/v1/courses/{course_id}/quizzes",
                   effects="write")
    ap = signed_approval(e, {}, tenant="https://someothertenant.instructure.com")
    admit(e, {}, tenant_base="https://someothertenant.instructure.com", approval=ap)
check("create_new_quiz admitted on an arbitrary tenant (no tenant gating)",
      t_no_tenant_gating_create_quiz)


def t_evidence_hold_item_bank():
    e = read_entry("canvas_item_bank_attach_bank_to_quiz", method="POST",
                   path="/api/banks/{bank_id}/shares", effects="write")
    ap = signed_approval(e, {})
    expect_raises(EvidenceHold,
                  lambda: admit(e, {}, tenant_base="https://x.instructure.com", approval=ap))
check("evidence-hold refuses item-bank op on every tenant",
      t_evidence_hold_item_bank)


def t_evidence_hold_delete_conclude():
    e = read_entry("canvas_delete_conclude_course", method="DELETE",
                   path="/api/v1/courses/{id}", effects="write")
    ap = signed_approval(e, {})
    expect_raises(EvidenceHold,
                  lambda: admit(e, {}, tenant_base="https://x.instructure.com", approval=ap))
check("evidence-hold refuses delete/conclude course on every tenant",
      t_evidence_hold_delete_conclude)


# 7. Learner data gated (enrollments read).
def t_learner_gated():
    e = read_entry("canvas_list_enrollments", path="/api/v1/courses/{course_id}/enrollments")
    expect_raises(LearnerDataGated, lambda: admit(e, {}))
check("learner-data read refused until vault", t_learner_gated)


# 8. users/self is not learner data.
def t_users_self_ok():
    e = read_entry("canvas_get_own_profile", path="/api/v1/users/self")
    audit, record = admit(e, {})
    assert (audit, record) == (None, None), "reads return no audit block"
check("users/self admitted (educator's own profile)", t_users_self_ok)


# 8b. Bare roster collection URL is learner data (no trailing slash).
def t_users_collection_gated():
    e = read_entry("canvas_list_users", path="/api/v1/courses/{course_id}/users")
    assert touches_learner_data(e), \
        "the roster collection URL must route through the de-id boundary"
check("bare /users collection URL is learner data", t_users_collection_gated)


# 9. Plain read admitted without approval.
def t_read_ok():
    e = read_entry("canvas_get_course", path="/api/v1/courses/{course_id}")
    audit, record = admit(e, {})
    assert (audit, record) == (None, None), "reads return no audit block"
check("ordinary read admitted without approval", t_read_ok)


# 10. Write without approval refused.
def t_write_no_approval():
    e = write_entry()
    expect_raises(WriteApprovalMissing, lambda: admit(e, {"course_id": "1"}))
check("write without approval refused", t_write_no_approval)


# 10b. LANE2-4: list-shaped effects=["write"] is still a write and
# refuses without approval (the gate must not treat it as a read).
def t_write_list_effects_no_approval():
    e = write_entry()
    e["effects"] = ["write"]
    expect_raises(WriteApprovalMissing, lambda: admit(e, {"course_id": "1"}))
check("list-shaped effects write refused without approval",
      t_write_list_effects_no_approval)


# 10c. LANE2-4: tuple-shaped effects=("write",) is still a write.
def t_write_tuple_effects_no_approval():
    e = write_entry()
    e["effects"] = ("write",)
    expect_raises(WriteApprovalMissing, lambda: admit(e, {"course_id": "1"}))
check("tuple-shaped effects write refused without approval",
      t_write_tuple_effects_no_approval)


# 11. Write with agent self-approval refused.
def t_write_self_approval():
    e = write_entry()
    ap = signed_approval(e, {"course_id": "1"})
    ap["by"] = "agent"
    expect_raises(ApprovalMismatch,
                  lambda: admit(e, {"course_id": "1"}, approval=ap))
check("agent self-approval refused", t_write_self_approval)


# 12. Write with approval for a different op refused.
def t_write_wrong_op():
    e = write_entry()
    other = write_entry(name="canvas_update_page")
    ap = signed_approval(other, {"course_id": "1"})
    expect_raises(ApprovalMismatch,
                  lambda: admit(e, {"course_id": "1"}, approval=ap))
check("approval bound to a different op refused", t_write_wrong_op)


# 13. Write with approval for different params refused.
def t_write_param_mismatch():
    e = write_entry()
    ap = signed_approval(e, {"course_id": "1"})
    expect_raises(ApprovalMismatch,
                  lambda: admit(e, {"course_id": "2"}, approval=ap))
check("approval with different params refused", t_write_param_mismatch)


# 14. Write with a valid educator approval admitted.
def t_write_approved():
    e = write_entry()
    params = {"course_id": "1", "title": "Hello"}
    ap = signed_approval(e, params)
    assert ap["version"] == APPROVAL_VERSION
    assert "sig" in ap, "signed records carry the tamper seal"
    audit, record = admit(e, params, tenant_base="https://x.instructure.com",
                          approval=ap)
    assert audit["op_digest"] == ap["op_digest"]
    assert audit["provenance"] == "in_process"
    assert audit["by"] == "educator"
    assert audit["authorization"] == AUTH
    assert record is ap
check("write with valid educator approval admitted", t_write_approved)


# 15. Digest is stable and param-order independent.
def t_digest_stable():
    a = canonical_params_digest({"b": 2, "a": 1})
    b = canonical_params_digest({"a": 1, "b": 2})
    assert a == b and len(a) == 64
check("params digest stable across key order", t_digest_stable)


# 16. mint_approval never self-signs; sign_approval needs a non-empty
# verbatim citation (round-4 M1: "Yes" is a valid approval).
def t_mint_unsigned():
    e = write_entry()
    rec = mint_approval(e, {"course_id": "1"},
                        target_identity={"course_id": "1",
                                         "course_name": "Admission Selftest"})
    assert rec["by"] is None, "minted record must not sign itself"
    assert rec["authorization"] is None
    assert rec["version"] == APPROVAL_VERSION
    assert len(rec["op_digest"]) == 64
    try:
        sign_approval(rec, "", channel="driver")
        raise AssertionError("empty citation accepted")
    except ValueError:
        pass
    try:
        sign_approval(rec, "   ", channel="driver")
        raise AssertionError("blank citation accepted")
    except ValueError:
        pass
check("mint leaves by unsigned; stub citations refused", t_mint_unsigned)


# 17. v1 records are retired and refused.
def t_v1_refused():
    e = write_entry()
    v1 = {"by": "educator", "at": "2026-09-20T00:00:00+00:00",
          "op": e["name"],
          "params_digest": canonical_params_digest({"course_id": "1"}),
          "authorization": AUTH}
    expect_raises(ApprovalMismatch,
                  lambda: admit(e, {"course_id": "1"}, approval=v1))
check("v1 approval record refused", t_v1_refused)


# 18. Expired approval refused.
def t_expired_refused():
    e = write_entry()
    ap = signed_approval(e, {"course_id": "1"})
    ap["expires_at"] = "2020-01-01T00:00:00+00:00"
    expect_raises(ApprovalMismatch,
                  lambda: admit(e, {"course_id": "1"}, approval=ap))
check("expired approval refused", t_expired_refused)


# 19. Over-max-TTL minting refused at mint time.
def t_over_ttl_mint_refused():
    e = write_entry()
    try:
        mint_approval(e, {"course_id": "1"},
                      ttl_seconds=MAX_APPROVAL_TTL_SECONDS + 1,
                      target_identity={"course_id": "1",
                                       "course_name": "Admission Selftest"})
        raise AssertionError("over-TTL mint accepted")
    except ValueError:
        pass
check("over-TTL approval cannot be minted", t_over_ttl_mint_refused)


# 20. Category tampering refused.
def t_category_mismatch():
    e = write_entry()
    ap = signed_approval(e, {"course_id": "1"})
    ap["category"] = "canvas.user_admin"
    expect_raises(ApprovalMismatch,
                  lambda: admit(e, {"course_id": "1"}, approval=ap))
check("approval with wrong category refused", t_category_mismatch)


# 21. Tenant retargeting refused.
def t_tenant_retarget():
    e = write_entry()
    ap = signed_approval(e, {"course_id": "1"},
                         tenant="https://x.instructure.com")
    expect_raises(ApprovalMismatch,
                  lambda: admit(e, {"course_id": "1"},
                                tenant_base="https://evil.example.com",
                                approval=ap))
check("approval retargeted at another tenant refused", t_tenant_retarget)


# 22. Approvals are single-use: replay refused after consume_approval.
def t_replay_refused():
    e = write_entry()
    params = {"course_id": "9", "title": "once"}
    ap = signed_approval(e, params)
    audit, record = admit(e, params, tenant_base="https://x.instructure.com",
                          approval=ap)
    assert audit["op_digest"], "audit block returned on admission"
    consume_approval(record)
    expect_raises(ApprovalMismatch,
                  lambda: admit(e, params,
                                tenant_base="https://x.instructure.com",
                                approval=ap))
check("consumed approval cannot be replayed", t_replay_refused)


# 23. Missing authorization citation refused.
def t_no_auth_citation():
    e = write_entry()
    ap = signed_approval(e, {"course_id": "1"})
    del ap["authorization"]
    expect_raises(ApprovalMismatch,
                  lambda: admit(e, {"course_id": "1"}, approval=ap))
check("approval without authorization citation refused", t_no_auth_citation)


# 24. Future-dated issuance refused.
def t_future_issued():
    e = write_entry()
    ap = signed_approval(e, {"course_id": "1"})
    ap["at"] = "2999-01-01T00:00:00+00:00"
    expect_raises(ApprovalMismatch,
                  lambda: admit(e, {"course_id": "1"}, approval=ap))
check("future-dated approval refused", t_future_issued)


# 25. Category derivation is deterministic and documented.
def t_category_derivation():
    assert entry_category({"name": "canvas_create_assignment",
                           "provider": "canvas"}) == "canvas.assignment"
    assert entry_category({"name": "canvas_item_bank_create_item",
                           "provider": "canvas"}) == "canvas.item_bank_item"
    assert entry_category({"name": "moodle_reply_to_forum_post",
                           "provider": "moodle"}) == "moodle.forum_post"
    assert entry_category({"name": "proof_create_assignment",
                           "provider": "canvas"}) == "canvas.proof_assignment"
    assert entry_category({"name": "x", "provider": "canvas",
                           "category": "custom.family"}) == "custom.family"
check("category derivation deterministic", t_category_derivation)


# 25b. WORKSTREAM 4: category name-tokenizer on adversarial inputs.
# Never raises; explicit category always wins; provider prefix is
# stripped only when it is the first segment; unicode survives.
def t_category_adversarial():
    assert entry_category({"name": "", "provider": "canvas"}) == "canvas.unknown"
    assert entry_category({"name": "canvas___", "provider": "canvas"}) == \
        "canvas.canvas"
    assert entry_category({"name": "UPPER_CASE_NAME", "provider": "canvas"}) == \
        "canvas.upper_case_name"
    assert entry_category({"name": "caf\u00e9_page",
                           "provider": "canvas"}) == "canvas.caf\u00e9_page"
    assert entry_category({"name": "a.b.c", "provider": ""}) == "b_c"
    assert entry_category({"name": "canvas-hyphen-name",
                           "provider": "canvas"}) == "canvas.canvas-hyphen-name"
    # Action verbs collapse by design, but the op digest still binds the
    # exact entry name, so create and delete stay distinct approvals.
    c_create = entry_category({"name": "canvas_create_assignment",
                               "provider": "canvas"})
    c_delete = entry_category({"name": "canvas_delete_assignment",
                               "provider": "canvas"})
    assert c_create == c_delete == "canvas.assignment"
    d_create = op_digest_of("canvas_create_assignment", {"course_id": "1"},
                            "https://t", c_create)
    d_delete = op_digest_of("canvas_delete_assignment", {"course_id": "1"},
                            "https://t", c_delete)
    assert d_create != d_delete
check("category tokenizer adversarial inputs", t_category_adversarial)


# 26. op_digest binds op, params, tenant, and category.
def t_op_digest_binding():
    d1 = op_digest_of("op", {"a": 1}, "https://t1", "c.c")
    assert d1 == op_digest_of("op", {"a": 1}, "https://t1", "c.c")
    assert d1 != op_digest_of("op2", {"a": 1}, "https://t1", "c.c")
    assert d1 != op_digest_of("op", {"a": 2}, "https://t1", "c.c")
    assert d1 != op_digest_of("op", {"a": 1}, "https://t2", "c.c")
    assert d1 != op_digest_of("op", {"a": 1}, "https://t1", "c.d")
check("op digest binds op/params/tenant/category", t_op_digest_binding)


# 27. Unsigned record refused even with by="educator" and a citation:
# mint alone never passes the gate.
def t_unsigned_refused():
    e = write_entry()
    params = {"course_id": "1"}
    rec = mint_approval(e, params, tenant_base="https://x.instructure.com",
                        target_identity={"course_id": "1",
                                         "course_name": "Admission Selftest"})
    rec["by"] = "educator"
    rec["authorization"] = AUTH
    expect_raises(ApprovalMismatch,
                  lambda: admit(e, params,
                                tenant_base="https://x.instructure.com",
                                approval=rec))
check("unsigned minted record refused without sign_approval", t_unsigned_refused)


# 28. Post-signing tampering refused: editing any field breaks the seal.
def t_tamper_refused():
    e = write_entry()
    params = {"course_id": "1"}
    ap = signed_approval(e, params)
    ap["expires_at"] = "2999-01-01T00:00:00+00:00"  # extend after signing
    expect_raises(ApprovalMismatch,
                  lambda: admit(e, params,
                                tenant_base="https://x.instructure.com",
                                approval=ap))
check("post-signing tampering breaks the seal", t_tamper_refused)


# 29. Stripping the seal is refused (seal is mandatory, not best-effort).
def t_seal_stripped_refused():
    e = write_entry()
    params = {"course_id": "1"}
    ap = signed_approval(e, params)
    del ap["sig"]
    expect_raises(ApprovalMismatch,
                  lambda: admit(e, params,
                                tenant_base="https://x.instructure.com",
                                approval=ap))
check("record without tamper seal refused", t_seal_stripped_refused)


# 30. sign_approval stamps the ceremony channel; bad channels refused.
def t_channel_stamp():
    e = write_entry()
    params = {"course_id": "1"}
    ap = sign_approval(mint_approval(e, params,
                                     tenant_base="https://x.instructure.com",
                                     target_identity={
                                         "course_id": "1",
                                         "course_name": "Admission Selftest"}),
                       AUTH, channel="educator-chat")
    assert ap["channel"] == "educator-chat"
    ap2 = signed_approval(e, {"course_id": "2"}, channel="driver")
    assert ap2["channel"] == "driver", \
        "selftest helper passes channel explicitly (F1: no default)"
    expect_raises(ValueError,
                  lambda: sign_approval(
                      mint_approval(e, params,
                                    tenant_base="https://x.instructure.com",
                                    target_identity={
                                        "course_id": "1",
                                        "course_name": "Admission Selftest"}),
                      AUTH, channel="agent"))
check("sign_approval stamps channel; bad channel refused", t_channel_stamp)


# 31. File provenance: a signed record read from the approvals dir is
# marked provenance="file".
def t_file_provenance():
    import uuid as _uuid
    e = write_entry()
    params = {"course_id": "31"}
    ap = signed_approval(e, params)
    op_id = str(_uuid.uuid4())
    path = os.path.join(_HERM_DIR, op_id + ".json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(ap, f)
    os.chmod(path, 0o600)
    rec, prov = load_approval(op_id, None)
    assert prov == "file", "file ceremony provenance, got %r" % prov
    audit, _ = admit(e, params, tenant_base="https://x.instructure.com",
                     op_id=op_id)
    assert audit["provenance"] == "file"
check("file-based approval carries provenance=file", t_file_provenance)


# 32. persist_signed_record writes 0600; approval_audit_for rebuilds the block.
def t_persist_and_rebuild():
    import uuid as _uuid
    import stat as _stat
    e = write_entry()
    params = {"course_id": "32"}
    ap = signed_approval(e, params)
    op_id = str(_uuid.uuid4())
    persist_signed_record(ap, op_id)
    path = os.path.join(_HERM_DIR, op_id + ".json")
    assert _stat.S_IMODE(os.stat(path).st_mode) == 0o600
    audit = approval_audit_for(op_id)
    assert audit["op_digest"] == ap["op_digest"]
    assert audit["provenance"] == "file"
    assert audit["authorization"] == AUTH
check("persisted record is 0600 and rebuilds the audit block",
      t_persist_and_rebuild)


# 33. reverify_approval: happy path, missing record, digest mismatch.
def t_reverify():
    import uuid as _uuid
    e = write_entry()
    params = {"course_id": "33"}
    ap = signed_approval(e, params)
    op_id = str(_uuid.uuid4())
    audit, _rec = admit(e, params,
                        tenant_base="https://x.instructure.com",
                        approval=ap, op_id=op_id)
    persist_signed_record(ap, op_id)
    consume_approval(ap)
    rv = reverify_approval(e, params, "https://x.instructure.com", op_id)
    assert rv["op_digest"] == audit["op_digest"]
    assert rv["provenance"] == "file"
    # Missing record: an unadmitted op cannot complete.
    expect_raises(ApprovalMismatch,
                  lambda: reverify_approval(
                      e, params, "https://x.instructure.com",
                      str(_uuid.uuid4())))
    # Completing different params than approved: refused.
    expect_raises(ApprovalMismatch,
                  lambda: reverify_approval(
                      e, {"course_id": "34"}, "https://x.instructure.com",
                      op_id))
    # Reads need no approval.
    re_ = read_entry("canvas_get_course")
    assert reverify_approval(re_, {}, None, None) is None
check("reverify_approval enforces the complete-phase check", t_reverify)


# 34. Approvals dir is created 0700 and a loose pre-existing dir is tightened.
def t_approvals_dir_tightened():
    import stat as _stat
    sub = os.path.join(_HERM_DIR, "loose")
    os.makedirs(sub, mode=0o755, exist_ok=True)
    os.chmod(sub, 0o755)
    old = _admission_mod.APPROVALS_DIR
    _admission_mod.APPROVALS_DIR = sub
    try:
        _admission_mod._ensure_approvals_dir()
        assert _stat.S_IMODE(os.stat(sub).st_mode) == 0o700
    finally:
        _admission_mod.APPROVALS_DIR = old
check("approvals dir tightened to 0700", t_approvals_dir_tightened)


# 35. Crash between persist and consume is recoverable: the approval is
# not burned, the retry re-admits cleanly, and the op still completes.
def t_crash_between_persist_and_consume():
    import uuid as _uuid
    e = write_entry()
    params = {"course_id": "35"}
    ap = signed_approval(e, params)
    op_id = str(_uuid.uuid4())
    audit, record = admit(e, params, tenant_base="https://x.instructure.com",
                          approval=ap, op_id=op_id)
    persist_signed_record(record, op_id)
    # Simulated crash: consume_approval never ran.
    audit2, record2 = admit(e, params, tenant_base="https://x.instructure.com",
                           approval=ap, op_id=op_id)
    assert audit2["op_digest"] == audit["op_digest"], "retry re-admits"
    persist_signed_record(record2, op_id)
    consume_approval(record2)
    rv = reverify_approval(e, params, "https://x.instructure.com", op_id)
    assert rv["op_digest"] == audit["op_digest"], "op completes after retry"
check("crash between persist and consume is recoverable",
      t_crash_between_persist_and_consume)


# 36. Crash after consume: a replay is refused, but the original op still
# completes via reverify (the approval is not wasted).
def t_crash_after_consume():
    import uuid as _uuid
    e = write_entry()
    params = {"course_id": "36"}
    ap = signed_approval(e, params)
    op_id = str(_uuid.uuid4())
    audit, record = admit(e, params, tenant_base="https://x.instructure.com",
                          approval=ap, op_id=op_id)
    persist_signed_record(record, op_id)
    consume_approval(record)
    # Simulated crash after consume: a fresh dispatch is refused ...
    expect_raises(ApprovalMismatch,
                  lambda: admit(e, params,
                                tenant_base="https://x.instructure.com",
                                approval=ap, op_id=str(_uuid.uuid4())))
    # ... but the original op completes.
    rv = reverify_approval(e, params, "https://x.instructure.com", op_id)
    assert rv["op_digest"] == audit["op_digest"]
check("crash after consume still completes the original op",
      t_crash_after_consume)


# 37. admit() is check-only: repeated admission without consume never burns
# the approval, so a gate failure after admit cannot void it.
def t_admit_is_check_only():
    e = write_entry()
    params = {"course_id": "37"}
    ap = signed_approval(e, params)
    a1, _r1 = admit(e, params, tenant_base="https://x.instructure.com",
                    approval=ap)
    a2, _r2 = admit(e, params, tenant_base="https://x.instructure.com",
                    approval=ap)
    assert a1["op_digest"] == a2["op_digest"], "admission is idempotent"
    # Tampered record is still refused at consume time (fail closed).
    bad = dict(ap)
    bad["authorization"] = "forged citation that passes length checks xx"
    expect_raises(ApprovalMismatch, lambda: consume_approval(bad))
check("admission checks without mutating; consume refuses tampered records",
      t_admit_is_check_only)


# 38. W3-P2-37: the approval-display renderer is gone. No de-tokenizing
# display path exists anymore: no connector UX ever called it, and
# learner names must not be recoverable for display without an explicit
# educator consent ceremony. sign_approval (agent-relayed educator
# citation) is the consent mechanism; see dispatch/approval-ceremony.md.
def _herm_vault():
    import tempfile as _tf
    from privacy.learner_vault import LearnerVault
    d = _tf.mkdtemp(prefix="morrow-ceremony-vault-", dir=_SELFTEST_WORK)
    return d, LearnerVault(d)


def t_renderer_removed():
    assert not hasattr(_admission_mod, "render_approval_display"), \
        "render_approval_display must not exist"
    assert not hasattr(_admission_mod, "_display_name_for")
    assert not hasattr(_admission_mod, "_replace_tokens")
check("approval display renderer removed (no de-tokenizing path)",
      t_renderer_removed)


# 39. param_tokens survives the renderer removal: the gate still binds
# the signed resolved_identities schedule to the op's tokens.
def t_param_tokens_kept():
    token = "lrn_" + "a" * 20
    params = {"course_id": "1", "user_token": token,
              "nested": [{"deep_token": token}]}
    assert param_tokens(params) == [token]
    # The agent-side params are never mutated by the gate's token walk.
    assert params["user_token"] == token
check("param_tokens kept for the identity-schedule gate", t_param_tokens_kept)


# 40. sign_approval stamps a caller-supplied identity schedule under the
# seal; tampering with it breaks the seal. (The schedule used to come
# from the removed renderer; the agent now relays the educator's own
# citation of the identities, per dispatch/approval-ceremony.md.)
def t_sign_stamps_identities():
    e = write_entry()
    tenant = "https://x.instructure.com"
    token = "lrn_" + "b" * 20
    params = {"course_id": "1", "user_token": token}
    schedule = [{"token": token, "displayed_as": "Ada Lovelace"}]
    rec = mint_approval(e, params, tenant_base=tenant,
                        target_identity={"course_id": "1",
                                         "course_name": "Admission Selftest"})
    signed = sign_approval(rec, AUTH, channel="educator-chat",
                           resolved_identities=schedule,
                           identity_authorization=IDENT_AUTH)
    assert signed["resolved_identities"] == schedule
    assert signed["resolution_authority"] == \
        "approval:" + signed["op_digest"]
    # Tampering with the stamped schedule breaks the seal.
    signed["resolved_identities"][0]["displayed_as"] = "Evil Hacker"
    expect_raises(ApprovalMismatch,
                  lambda: admit(e, params, tenant_base=tenant,
                                approval=signed))
check("sign stamps identity schedule under the seal", t_sign_stamps_identities)


def t_identity_schedule_needs_own_citation():
    # W6-P2-A3: a nonempty identity schedule without the educator's
    # SEPARATE identity authorization is refused at signing time.
    e = write_entry()
    tenant = "https://x.instructure.com"
    token = "lrn_" + "e" * 20
    params = {"course_id": "1", "user_token": token}
    schedule = [{"token": token, "displayed_as": "Ada Lovelace"}]
    rec = mint_approval(e, params, tenant_base=tenant,
                        target_identity={"course_id": "1",
                                         "course_name": "Admission Selftest"})
    # Round-4 M1: a missing or empty citation is refused; any
    # non-empty verbatim reply ("yes, those students") is accepted.
    for bad in (None, "", "   "):
        expect_raises(ValueError,
                      lambda b=bad: sign_approval(
                          mint_approval(e, params, tenant_base=tenant,
                                        target_identity={
                                            "course_id": "1",
                                            "course_name": "Admission Selftest"}),
                          AUTH, channel="educator-chat",
                          resolved_identities=schedule,
                          identity_authorization=b))
    short = sign_approval(
        mint_approval(e, params, tenant_base=tenant,
                      target_identity={"course_id": "1",
                                       "course_name": "Admission Selftest"}),
        AUTH, channel="educator-chat", resolved_identities=schedule,
        identity_authorization="yes, those students")
    assert short["identity_authorization"] == "yes, those students"
    # An empty schedule needs no second citation.
    ok = sign_approval(rec, AUTH, channel="educator-chat",
                       resolved_identities=[],
                       identity_authorization=None)
    assert ok["identity_authorization"] is None
check("w6p2a3: nonempty identity schedule needs its own citation",
      t_identity_schedule_needs_own_citation)




# 41. Gate refuses when the schedule does not match the op's tokens; the
# full ceremony flow admits and completes.
def t_schedule_mismatch_refused():
    e = write_entry()
    tenant = "https://x.instructure.com"
    t1 = "lrn_" + "c" * 20
    t2 = "lrn_" + "d" * 20
    params = {"course_id": "1", "user_token": t1}
    rec = mint_approval(e, params, tenant_base=tenant,
                        target_identity={"course_id": "1",
                                         "course_name": "Admission Selftest"})
    # Signed for a DIFFERENT learner than the op touches.
    bad = sign_approval(rec, AUTH, channel="educator-chat",
                        resolved_identities=[{"token": t2,
                                              "displayed_as": "Someone Else"}],
                        identity_authorization=IDENT_AUTH)
    expect_raises(ApprovalMismatch,
                  lambda: admit(e, params, tenant_base=tenant, approval=bad))
check("schedule/op token mismatch refused", t_schedule_mismatch_refused)


def t_full_ceremony_flow():
    import uuid as _uuid
    e = write_entry()
    tenant = "https://x.instructure.com"
    token = "lrn_" + "e" * 20
    params = {"course_id": "1", "user_token": token}
    rec = mint_approval(e, params, tenant_base=tenant,
                        target_identity={"course_id": "1",
                                         "course_name": "Admission Selftest"})
    op_id = str(_uuid.uuid4())
    # The agent relays the educator's own citation of the identities;
    # sign_approval seals it. No renderer de-tokenizes anything.
    signed = sign_approval(rec, AUTH, channel="educator-chat",
                           resolved_identities=[
                               {"token": token,
                                "displayed_as": "Katherine Johnson"}],
                           identity_authorization=IDENT_AUTH)
    audit, record = admit(e, params, tenant_base=tenant, approval=signed,
                          op_id=op_id)
    assert audit["channel"] == "educator-chat"
    persist_signed_record(record, op_id)
    consume_approval(record)
    rv = reverify_approval(e, params, tenant, op_id)
    assert rv["op_digest"] == audit["op_digest"]
check("full ceremony flow admits and completes", t_full_ceremony_flow)


# 41b. W6-P1-A2: driver-channel approvals are refused by default and
# admitted only with an explicit opt-out.
def t_driver_channel_refused_by_default():
    e = write_entry()
    params = {"course_id": "1"}
    ap = signed_approval(e, params, channel="driver")
    expect_raises(ApprovalMismatch,
                  lambda: admit(e, params,
                                tenant_base="https://x.instructure.com",
                                approval=ap))
    # Explicit opt-out (proof drivers, tests) still admits.
    audit, record = admit(e, params,
                          tenant_base="https://x.instructure.com",
                          approval=ap, require_educator_channel=False)
    assert audit["channel"] == "driver"
    assert record is ap
check("w6p1a2: driver-channel refused by default; explicit opt-out admits",
      t_driver_channel_refused_by_default)


def t_educator_channel_admitted_by_default():
    e = write_entry()
    params = {"course_id": "1"}
    ap = signed_approval(e, params, channel="educator-chat")
    audit, record = admit(e, params,
                          tenant_base="https://x.instructure.com",
                          approval=ap)
    assert audit["channel"] == "educator-chat"
check("w6p1a2: educator-channel admitted by default",
      t_educator_channel_admitted_by_default)


# 42. vault.lookup call-site allowlist: no product code renders learner
# names for display. The removed renderer was the only caller, so the
# allowlist is now zero.
def t_lookup_allowlist():
    import re as _re
    repo = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
    offenders = []
    for dirpath, dirnames, filenames in os.walk(repo):
        dirnames[:] = [d for d in dirnames
                       if not d.startswith(".") and d != "__pycache__"]
        for fn in filenames:
            if not fn.endswith(".py"):
                continue
            if "selftest" in fn or fn.startswith("test_"):
                continue
            path = os.path.join(dirpath, fn)
            rel = os.path.relpath(path, repo)
            if rel == os.path.join("privacy", "learner_vault.py"):
                continue  # defines lookup()
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
            if _re.search(r"\.lookup\(", text):
                offenders.append(rel)
    assert offenders == [], \
        "vault.lookup callers in product code: %r" % (offenders,)
check("vault.lookup allowlist: no product callers", t_lookup_allowlist)


# 43. Double consume is a replay: refused.
def t_double_consume_refused():
    e = write_entry()
    params = {"course_id": "46a"}
    ap = signed_approval(e, params)
    consume_approval(ap)
    expect_raises(ApprovalMismatch, lambda: consume_approval(ap))
check("double consume refused as replay", t_double_consume_refused)


# 44. Concurrent consumption: N racers, exactly one winner, under every
# multiprocessing start method this platform has. The worker lives at
# module level in dispatch/admission_race.py (a local function cannot
# be pickled under spawn or forkserver) and the race runs in its own
# interpreter, so a spawned child never re-runs this selftest.
def t_concurrent_consume_single_winner():
    import multiprocessing as _mp
    import subprocess as _sp
    e = write_entry()
    params = {"course_id": "46b"}
    ap = signed_approval(e, params)
    rec_path = os.path.join(_admission_mod.APPROVALS_DIR, "race-record.json")
    os.makedirs(os.path.dirname(rec_path), exist_ok=True)
    tree = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    methods = [m for m in ("spawn", "forkserver", "fork")
               if m in _mp.get_all_start_methods()]
    assert methods, "no multiprocessing start method available"
    for method in methods:
        digest = ap["op_digest"]
        consumed = _admission_mod._load_consumed()
        consumed.pop(digest, None)
        with open(_admission_mod.CONSUMED_PATH, "w", encoding="utf-8") as fh:
            json.dump(consumed, fh)
        # W6-P1-6: the consumed set is HMAC-sealed; re-seal after the
        # direct write so workers' verification passes.
        _admission_mod._write_consumed_seal()
        _admission_mod._invalidate_consumed_cache()
        with open(rec_path, "w", encoding="utf-8") as fh:
            json.dump(ap, fh)
        n = 8
        overrides = []
        for name in ("APPROVALS_DIR", "CONSUMED_PATH", "SECRETS_DIR",
                     "SIGNING_KEY_PATH"):
            overrides += ["--set", "%s=%s"
                          % (name, getattr(_admission_mod, name))]
        r = _sp.run([sys.executable, "-m", "dispatch.admission_race",
                     rec_path, method, str(n)] + overrides,
                    cwd=tree, capture_output=True, text=True, timeout=300)
        assert r.returncode == 0, (method, r.stderr[-400:])
        out = json.loads(r.stdout.strip().splitlines()[-1])
        assert out["exitcodes"] == [0] * n, (method, out)
        assert out["results"].count("won") == 1, (method, out)
        assert out["results"].count("lost") == n - 1, (method, out)
    os.unlink(rec_path)
check("concurrent consume: exactly one winner", t_concurrent_consume_single_winner)


# 45. W5-P1-3: consumed.json retention, pruning, and cache behavior.
def t_consumed_retention_prunes_expired():
    import datetime as _dt
    old_ts = (_dt.datetime.now(_dt.timezone.utc)
              - _dt.timedelta(
                  seconds=_admission_mod.CONSUMED_RETENTION_S + 3600)
              ).isoformat()
    fresh_ts = _dt.datetime.now(_dt.timezone.utc).isoformat()
    _write_consumed_sealed({"digest-old": old_ts, "digest-fresh": fresh_ts})
    _admission_mod._invalidate_consumed_cache()
    _admission_mod._record_consumed("digest-new")
    consumed = _admission_mod._load_consumed()
    assert "digest-old" not in consumed, "expired digest pruned"
    assert "digest-fresh" in consumed, "fresh digest kept"
    assert "digest-new" in consumed, "new digest recorded"
check("W5-P1-3: expired digests pruned on write, fresh kept",
     t_consumed_retention_prunes_expired)


def t_consumed_pruned_digest_not_replayable():
    # A pruned digest cannot authorize a replay: the approval carrying
    # it is older than MAX_APPROVAL_TTL_SECONDS (24h) while retention
    # is 25h, so the approval is refused as expired before consumption
    # is even checked.
    import datetime as _dt
    assert (_admission_mod.CONSUMED_RETENTION_S
            > _admission_mod.MAX_APPROVAL_TTL_SECONDS), \
        "retention must exceed max approval TTL"
    e = write_entry()
    params = {"course_id": "47b"}
    ap = signed_approval(e, params)
    digest = ap["op_digest"]
    # Age the approval past its TTL (but the consumed entry is fresh,
    # so it would still be in the file).
    ap["issued_at"] = (
        _dt.datetime.now(_dt.timezone.utc)
        - _dt.timedelta(
            seconds=_admission_mod.MAX_APPROVAL_TTL_SECONDS + 60)
    ).isoformat()
    expect_raises(ApprovalMismatch, lambda: consume_approval(ap))
check("W5-P1-3: pruned digest cannot authorize a replay (approval expired)",
     t_consumed_pruned_digest_not_replayable)


def t_consumed_malformed_timestamp_kept():
    _write_consumed_sealed({"digest-bad-ts": "not-a-timestamp",
                            "digest-none-ts": None})
    _admission_mod._invalidate_consumed_cache()
    dropped = _admission_mod.prune_consumed()
    consumed = _admission_mod._load_consumed()
    assert dropped == 0, "nothing dropped, got %d" % dropped
    assert "digest-bad-ts" in consumed, "malformed ts kept fail-safe"
    assert "digest-none-ts" in consumed, "null ts kept fail-safe"
check("W5-P1-3: malformed timestamps are kept (fail-safe)",
     t_consumed_malformed_timestamp_kept)


def t_consumed_cache_invalidates_on_external_write():
    _write_consumed_sealed({"digest-a": "2026-01-01T00:00:00+00:00"})
    _admission_mod._invalidate_consumed_cache()
    first = _admission_mod._load_consumed()
    assert "digest-a" in first
    # External writer (another process) replaces the file.
    import time as _time
    _time.sleep(0.01)
    _write_consumed_sealed({"digest-b": "2026-01-01T00:00:00+00:00"})
    second = _admission_mod._load_consumed()
    assert "digest-b" in second and "digest-a" not in second, \
        "cache invalidated on mtime/size change: %r" % (second,)
    # Unchanged file: cache hit returns equal data.
    third = _admission_mod._load_consumed()
    assert third == second
check("W5-P1-3: cache invalidates on external write",
     t_consumed_cache_invalidates_on_external_write)


def t_consumed_backstop_caps_entries():
    import datetime as _dt
    saved_max = _admission_mod.CONSUMED_MAX_ENTRIES
    _admission_mod.CONSUMED_MAX_ENTRIES = 10
    try:
        base = _dt.datetime.now(_dt.timezone.utc)
        consumed = {
            "digest-%02d" % i: (base + _dt.timedelta(seconds=i)).isoformat()
            for i in range(15)
        }
        kept, dropped = _admission_mod._prune_consumed_dict(consumed)
        assert len(kept) == 10, "capped at 10, got %d" % len(kept)
        assert dropped == 5, "dropped 5, got %d" % dropped
        # Newest survive (lexicographic ISO-8601 order).
        assert "digest-14" in kept and "digest-05" in kept
        assert "digest-00" not in kept and "digest-04" not in kept
    finally:
        _admission_mod.CONSUMED_MAX_ENTRIES = saved_max
check("W5-P1-3: entry backstop keeps the newest",
     t_consumed_backstop_caps_entries)


def t_prune_consumed_standalone():
    import datetime as _dt
    old_ts = (_dt.datetime.now(_dt.timezone.utc)
              - _dt.timedelta(
                  seconds=_admission_mod.CONSUMED_RETENTION_S + 10)
              ).isoformat()
    fresh_ts = _dt.datetime.now(_dt.timezone.utc).isoformat()
    _write_consumed_sealed({"d-old": old_ts, "d-fresh": fresh_ts})
    _admission_mod._invalidate_consumed_cache()
    dropped = _admission_mod.prune_consumed()
    assert dropped == 1, "dropped 1, got %d" % dropped
    consumed = _admission_mod._load_consumed()
    assert consumed == {"d-fresh": fresh_ts}, repr(consumed)
check("W5-P1-3: standalone prune_consumed drops only expired",
     t_prune_consumed_standalone)


# 46. W6-P1-6: the consumed set is HMAC-sealed; tampering fails closed.
def t_consumed_seal_tamper_fails_closed():
    _write_consumed_sealed({"digest-victim": "2026-01-01T00:00:00+00:00"})
    _admission_mod._invalidate_consumed_cache()
    # Baseline: sealed state loads.
    assert "digest-victim" in _admission_mod._load_consumed()
    # Tamper with the file (parseable but seal no longer matches).
    with open(_admission_mod.CONSUMED_PATH, "w", encoding="utf-8") as fh:
        json.dump({"digest-victim": "2026-01-01T00:00:00+00:00",
                   "digest-forged": "2026-01-01T00:00:00+00:00"}, fh)
    _admission_mod._invalidate_consumed_cache()
    expect_raises(ApprovalMismatch, _admission_mod._load_consumed)
    # Restore by re-sealing the tampered content (operator re-blesses).
    _admission_mod._write_consumed_seal()
    _admission_mod._invalidate_consumed_cache()
    assert "digest-forged" in _admission_mod._load_consumed()
    # Clean up: remove file and seal so later tests start fresh.
    os.remove(_admission_mod.CONSUMED_PATH)
    os.remove(_admission_mod._consumed_seal_path())
    _admission_mod._invalidate_consumed_cache()
check("W6-P1-6: tampered consumed set fails closed",
     t_consumed_seal_tamper_fails_closed)


def t_consumed_seal_missing_fails_closed():
    _write_consumed_sealed({"digest-x": "2026-01-01T00:00:00+00:00"})
    _admission_mod._invalidate_consumed_cache()
    assert "digest-x" in _admission_mod._load_consumed()
    # Delete the seal: the unsealed file must not load.
    os.remove(_admission_mod._consumed_seal_path())
    _admission_mod._invalidate_consumed_cache()
    expect_raises(ApprovalMismatch, _admission_mod._load_consumed)
    # Clean up: remove the file so later tests start fresh.
    os.remove(_admission_mod.CONSUMED_PATH)
    _admission_mod._invalidate_consumed_cache()
check("W6-P1-6: missing seal fails closed",
     t_consumed_seal_missing_fails_closed)


def t_consumed_seal_malformed_fails_closed():
    _write_consumed_sealed({"digest-y": "2026-01-01T00:00:00+00:00"})
    _admission_mod._invalidate_consumed_cache()
    # Corrupt the seal file itself.
    with open(_admission_mod._consumed_seal_path(), "w",
              encoding="utf-8") as fh:
        fh.write("not-a-valid-seal")
    _admission_mod._invalidate_consumed_cache()
    expect_raises(ApprovalMismatch, _admission_mod._load_consumed)
    # Clean up: remove file and seal so later tests start fresh.
    os.remove(_admission_mod.CONSUMED_PATH)
    os.remove(_admission_mod._consumed_seal_path())
    _admission_mod._invalidate_consumed_cache()
check("W6-P1-6: malformed seal fails closed",
     t_consumed_seal_malformed_fails_closed)


# 47. W6-P2-1: reverify_approval enforces expiry at complete time.
def t_reverify_approval_expiry():
    import datetime as _dt
    import uuid as _uuid
    e = write_entry()
    params = {"course_id": "47a"}
    # Mint, then backdate expires_at BEFORE signing so the tamper seal
    # covers the expired time (a post-sign edit would break the seal
    # and fail at the seal check, not the expiry check).
    rec = mint_approval(e, params, tenant_base="https://x.instructure.com",
                        ttl_seconds=3600,
                        target_identity={"course_id": "47a",
                                         "course_name": "Admission Selftest"})
    rec["expires_at"] = (_dt.datetime.now(_dt.timezone.utc)
                         - _dt.timedelta(seconds=10)).isoformat()
    ap_expired = sign_approval(rec, AUTH, channel="educator-chat")
    op_id = str(_uuid.uuid4())
    _admission_mod.persist_signed_record(ap_expired, op_id)
    # The digest must be in the consumed set (proof of dispatch).
    _admission_mod._record_consumed(ap_expired["op_digest"])
    expect_raises(ApprovalMismatch,
                  lambda: _admission_mod.reverify_approval(
                      e, params, "https://x.instructure.com", op_id))
check("W6-P2-1: reverify_approval enforces expiry",
     t_reverify_approval_expiry)


# 48. W6-P2-2: clock rollback refuses admission.
def t_clock_rollback_refused():
    import datetime as _dt
    # Plant a high-water mark in the "future" (simulating that the
    # gate has seen a later time), then try to admit with now in the
    # past: the rollback guard must refuse.
    future = _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(hours=1)
    _admission_mod._write_time_highwater(future)
    past = _dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(hours=2)
    expect_raises(ApprovalMismatch,
                  lambda: _admission_mod._check_clock_rollback(past))
    # Reset: delete the high-water file (it is monotonic and never
    # moves backward via the API). A now with no high-water passes.
    os.remove(_admission_mod._time_highwater_path())
    now = _dt.datetime.now(_dt.timezone.utc)
    _admission_mod._check_clock_rollback(now)
    # Within tolerance (60s) behind the high-water also passes.
    near = now - _dt.timedelta(seconds=30)
    _admission_mod._check_clock_rollback(near)
    # Clean up the high-water file.
    try:
        os.remove(_admission_mod._time_highwater_path())
    except OSError:
        pass
check("W6-P2-2: clock rollback refuses admission",
     t_clock_rollback_refused)


# 49. W6-P2-4: the approval signing key is separated from the records
# it seals (lives under <morrow_home>/secrets/, not in the approvals
# dir), and it rotates with the old key retained for verification.
def t_signing_key_separation():
    import json as _json
    # The module default must point under secrets/, not the approvals
    # dir. (The test hermetically overrides SIGNING_KEY_PATH above;
    # here we check the import-time default construction.)
    import importlib.util as _ilu
    _spec = _ilu.spec_from_file_location(
        "admission_w6p24",
        os.path.join(os.path.dirname(os.path.abspath(__file__)),
                     "admission.py"))
    # Cannot re-import cleanly (module state); instead verify the
    # source constructs the path under secrets/.
    _src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "admission.py"), encoding="utf-8").read()
    assert 'os.path.join(SECRETS_DIR, "approval-signing.key")' in _src, \
        "SIGNING_KEY_PATH must be under SECRETS_DIR"
    assert "_LEGACY_SIGNING_KEY_PATH" in _src, \
        "legacy migration path must exist"
    return True
check("W6-P2-4: signing key lives under secrets/, not with records",
      t_signing_key_separation)

def t_signing_key_rotation():
    # Rotate: the active key changes, the old key is retained, and a
    # record sealed before rotation still verifies.
    _ring_before = _admission_mod._read_signing_keyring()
    _kid_before = _ring_before["active"] if _ring_before else None
    # Mint an approval and seal it before rotation.
    _entry = {"name": "test.w6p24", "provider": "canvas"}
    _rec = _admission_mod.mint_approval(
        _entry, {"course_id": 1},
        tenant_base="https://example.instructure.com",
        ttl_seconds=3600,
        target_identity={"course_id": 1, "course_name": "T"})
    _signed = _admission_mod.sign_approval(
        _rec, "selftest: W6-P2-4 rotation fixture",
        channel="educator-chat")
    _kid_after = _admission_mod.rotate_signing_key()
    assert _kid_after != _kid_before, "rotation must change active key"
    _ring_after = _admission_mod._read_signing_keyring()
    assert _kid_before in _ring_after["keys"], \
        "retired key must be retained"
    # The pre-rotation record still verifies under the keyring.
    _admission_mod._verify_seal(_signed)
    return True
check("W6-P2-4: signing key rotates; old seals still verify",
      t_signing_key_rotation)


# Cleanup the hermetic consumed-approvals file and approvals dir.
# The lock file (admission.py creates CONSUMED_PATH + ".lock" and never
# deletes it) is test scratch too: leaving it trips the carve's
# exact-file-set check and litters the tree on every suite run.
for _p in (_admission_mod.CONSUMED_PATH,
           _admission_mod.CONSUMED_PATH + ".lock",
           _admission_mod._consumed_seal_path()):
    try:
        os.remove(_p)
    except OSError:
        pass
del _p
import shutil as _shutil
_shutil.rmtree(_HERM_DIR, ignore_errors=True)
# Self-clean: hermetic ceremony vaults carry secret.key files, which are
# deny-list-matching residue and must not linger in the tree.
import glob as _glob
for _d in _glob.glob(os.path.join(_SELFTEST_WORK, "morrow-ceremony-vault-*")):
    _shutil.rmtree(_d, ignore_errors=True)


print("pass: %d" % len(PASS))
for name in PASS:
    print("  ok %s" % name)
if FAIL:
    print("FAIL: %d" % len(FAIL))
    for name in FAIL:
        print("  FAIL %s" % name)
    sys.exit(1)
print("all admission selftests passed")
