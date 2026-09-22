#!/usr/bin/env python3
"""Selftest: F-2 catalog provenance gate (2026-09-21).

Covers dispatch_catalog_op's enforcement of the authoritative
proof-battery/OPERATION_CATALOG.md, offline (mocked ChromiumSession
transport; no provider touched):

  1. A live-proven catalog op dispatches normally, with no override.
  2. An unproven (pending) catalog op refuses with CatalogNotProven when
     --allow-unproven is absent; the refusal is journaled under its own
     refusal event id, so the requested op_id is not consumed.
  3. The same unproven op dispatches with allow_unproven=True plus an
     educator-signed approval record carrying allow_unproven: true; the
     journal records the catalog status and the signed override, and the
     override record is single-use.
  4. A never-dispatch op refuses (NeverDispatch) even with
     allow_unproven=True and a signed override record.
  5. An evidence-hold op refuses (EvidenceHold) even with
     allow_unproven=True and a signed override record.
  6. An unknown op name refuses (CatalogNotProven) and cannot be
     overridden even with a signed record.
  7. A descriptor mismatch (proven name, wrong method/path) refuses
     (CatalogNotProven): a proven name cannot be paired with arbitrary
     CLI arguments.
"""
import json
import os
import shutil
import sys
import uuid

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (REPO, os.path.join(REPO, "dispatch"), os.path.join(REPO, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from dispatch import executor as ex  # noqa: E402
from dispatch.admission import (  # noqa: E402
    mint_approval, sign_approval, load_policy,
    NeverDispatch, EvidenceHold, ApprovalMismatch)
import dispatch.admission as admission_mod  # noqa: E402
import chromium_session as cs  # noqa: E402

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(
        "%s%s" % (name, (" (%s)" % detail) if detail and not cond else ""))


BASE = "https://canvas.example.edu"

# W4-P1-14/W4-P2-27: dispatch binds the session tenant to the lane
# state's signed-in tenant. Stub the lane state to the fake tenant so
# this hermetic selftest stays self-consistent (the real lane state on
# a dev machine names a different tenant).
cs._lane_state_base = lambda: BASE  # noqa: E731

# Speed up: no real backoff sleeps in retry tests.
_ex_backoff = ex._backoff_sleep
ex._backoff_sleep = lambda attempt: None  # noqa: E731

# Hermetic journal + approvals (never touch the real ~/.morrow in tests).
_scratch = os.path.join(REPO, "dispatch", ".selftest-work", "catalog-gate")
if os.path.isdir(_scratch):
    shutil.rmtree(_scratch)
os.makedirs(os.path.join(_scratch, "journal"), exist_ok=True)
os.makedirs(os.path.join(_scratch, "approvals"), exist_ok=True)
_saved_journal, _saved_home = ex.JOURNAL_PATH, ex.MORROW_HOME
_saved_adir, _saved_consumed = admission_mod.APPROVALS_DIR, admission_mod.CONSUMED_PATH
ex.JOURNAL_PATH = os.path.join(_scratch, "journal", "ops.jsonl")
ex.MORROW_HOME = _scratch
admission_mod.APPROVALS_DIR = os.path.join(_scratch, "approvals")
admission_mod.CONSUMED_PATH = os.path.join(_scratch, "approvals", "consumed.json")

_AUTH = ("selftest authorization basis: offline mocked-CDP catalog gate "
         "checks; no live provider is involved")


class FakeTransport:
    """Scripted stand-in for LocalChromiumTransport (the CDP layer)."""

    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def ensure_session(self):
        return (1, "Test User")

    def api(self, method, path, data=None, _ws=None, timeout=60,
            as_json=False, max_bytes=None):
        self.calls.append({"method": method, "path": path, "data": data,
                           "as_json": as_json, "max_bytes": max_bytes})
        if not self.script:
            return 200, {}, "{}"
        kind = self.script.pop(0)
        return kind[0], {}, kind[1]


def _session(script):
    return cs.ChromiumSession(BASE, transport=FakeTransport(script))


def _pack():
    return {"credential_slots": {
        "canvas_pat": {"inject": {"header": "Authorization",
                                  "scheme": "Bearer"}}}}


def _journal_records():
    out = []
    if os.path.exists(ex.JOURNAL_PATH):
        with open(ex.JOURNAL_PATH, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    out.append(json.loads(line))
    return out


def _journal_for(op_id):
    # The journal holds claim records before outcome records; the
    # outcome is what the gate assertions need.
    return ex.find_journal_op(op_id)


# Fixtures are read from the authoritative catalog, not hardcoded: the
# gate must enforce whatever the catalog says today.
LIVE = "canvas_list_external_feeds_courses"
PENDING = "canvas_list_assignments_assignment_groups"
live_desc = ex.catalog_descriptor_for(LIVE)
pending_desc = ex.catalog_descriptor_for(PENDING)
check("fixture: live op is live-proven in the catalog",
      live_desc is not None and live_desc["status"] == "live-proven",
      repr(live_desc))
check("fixture: pending op is not live-proven in the catalog",
      pending_desc is not None and pending_desc["status"] != "live-proven",
      repr(pending_desc))
NEVER = "canvas_begin_migration_to_push_to_associated_courses"
HOLD = "canvas_item_bank_attach_bank_to_quiz"  # still on evidence hold
# (canvas_create_new_quiz was admitted on proof 2026-09-22, v1.2.0).
policy = load_policy()
check("fixture: never-dispatch op is in the admission policy",
      NEVER in policy["never_dispatch"]["tool_names"])
check("fixture: evidence-hold op is in the admission policy",
      HOLD in policy["evidence_holds"]["tool_names"])
UNKNOWN = "canvas_no_such_operation_xyz"
check("fixture: unknown op is not in the catalog",
      ex.catalog_descriptor_for(UNKNOWN) is None)

LIVE_PARAMS = {"course_id": "424242"}
PENDING_PARAMS = {"course_id": "424242", "assignment_group_id": "7"}


def _class_of(name, method, path, fallback="read"):
    # W3-P0-6: the catalog row's R/W column is the authoritative effect
    # class. Derive it from the catalog instead of hardcoding "read";
    # a hardcoded class contradicts the catalog for write rows and the
    # hardened executor refuses loudly. UNKNOWN (not a catalog row)
    # keeps the explicit fallback.
    d = ex.catalog_descriptor_for(name)
    if d is None:
        return fallback
    return "write" if d.get("effect_rw") == "W" else "read"


def _override_record(name, method, path, params):
    entry = ex.catalog_descriptor_to_entry(name, method, path,
                                           _class_of(name, method, path),
                                           "canvas", None)
    rec = mint_approval(entry, params, tenant_base=BASE, allow_unproven=True,
                        target_identity={
                            "course_id": params.get("course_id"),
                            "course_name": "Catalog Gate",
                        } if params.get("course_id") else None)
    sign_approval(rec, _AUTH, channel="driver")
    return rec


# 1. live-proven dispatches with no override.
op1 = str(uuid.uuid4())
out1 = ex.dispatch_catalog_op(
    LIVE, live_desc["method"], live_desc["path"], "read", dict(LIVE_PARAMS),
    provider="canvas", op_id=op1, pack=_pack(),
    session=_session([(200, '{"feeds": []}')]))
check("live-proven dispatches", out1["op_id"] == op1, repr(out1))
rec1 = _journal_for(op1)
check("live-proven journals catalog_status",
      rec1 is not None and rec1.get("catalog_status") == "live-proven",
      repr((rec1 or {}).get("catalog_status")))
check("live-proven needs no override",
      rec1 is not None and rec1.get("unproven_override") is None)

# 2. unproven without the flag refuses; refusal is journaled separately.
op2 = str(uuid.uuid4())
try:
    ex.dispatch_catalog_op(
        PENDING, pending_desc["method"], pending_desc["path"], "read",
        dict(PENDING_PARAMS), provider="canvas", op_id=op2, pack=_pack(),
        session=_session([(200, "{}")]))
    check("unproven without flag refuses", False, "no exception")
except ex.CatalogNotProven as exc:
    check("unproven without flag refuses", True)
    check("refusal names the catalog status",
          repr(pending_desc["status"]) in str(exc), str(exc))
except Exception as exc:  # noqa: BLE001
    check("unproven without flag refuses", False, "wrong: %r" % exc)
check("refused op_id was not journaled as a dispatch",
      _journal_for(op2) is None)
refusals = [r for r in _journal_records()
            if r.get("kind") == "catalog_gate_refusal"
            and r.get("entry_name") == PENDING]
check("refusal journaled under its own event id",
      len(refusals) == 1 and refusals[0]["op_id"] != op2,
      repr([r.get("op_id") for r in refusals]))
check("refusal record carries the catalog status",
      refusals and refusals[0].get("catalog_status") == pending_desc["status"],
      repr(refusals[0].get("catalog_status") if refusals else None))

# 3. unproven with a signed override dispatches.
op3 = str(uuid.uuid4())
rec3 = _override_record(PENDING, pending_desc["method"], pending_desc["path"],
                        dict(PENDING_PARAMS))
out3 = ex.dispatch_catalog_op(
    PENDING, pending_desc["method"], pending_desc["path"], "read",
    dict(PENDING_PARAMS), provider="canvas", op_id=op3, pack=_pack(),
    approval=rec3, allow_unproven=True,
    session=_session([(200, '{"assignments": []}')]))
check("unproven override dispatches", out3["op_id"] == op3, repr(out3))
jrec3 = _journal_for(op3)
check("override journals the catalog status",
      jrec3 is not None
      and jrec3.get("catalog_status") == pending_desc["status"],
      repr((jrec3 or {}).get("catalog_status")))
ov3 = (jrec3 or {}).get("unproven_override") or {}
check("override journals the signed override",
      ov3.get("allow_unproven") is True
      and ov3.get("by") == "educator", repr(ov3))
# The override record is single-use: replay refuses.
try:
    ex.dispatch_catalog_op(
        PENDING, pending_desc["method"], pending_desc["path"], "read",
        dict(PENDING_PARAMS), provider="canvas", op_id=str(uuid.uuid4()),
        pack=_pack(), approval=rec3, allow_unproven=True,
        session=_session([(200, "{}")]))
    check("override record is single-use", False, "replay dispatched")
except ApprovalMismatch:
    check("override record is single-use", True)
except Exception as exc:  # noqa: BLE001
    check("override record is single-use", False, "wrong: %r" % exc)

# 3b. allow_unproven with a record that lacks the signed flag refuses.
# Mint fresh with no allow_unproven field, then sign: the seal is valid
# but the flag is absent.
entry3b = ex.catalog_descriptor_to_entry(PENDING, pending_desc["method"],
                                         pending_desc["path"],
                                         _class_of(PENDING,
                                                   pending_desc["method"],
                                                   pending_desc["path"]),
                                         "canvas", None)
rec3b = mint_approval(entry3b, dict(PENDING_PARAMS), tenant_base=BASE,
                      target_identity={"course_id": "424242",
                                       "course_name": "Catalog Gate"})
sign_approval(rec3b, _AUTH, channel="driver")
try:
    ex.dispatch_catalog_op(
        PENDING, pending_desc["method"], pending_desc["path"], "read",
        dict(PENDING_PARAMS), provider="canvas", op_id=str(uuid.uuid4()),
        pack=_pack(), approval=rec3b, allow_unproven=True,
        session=_session([(200, "{}")]))
    check("override without the signed flag refuses", False, "dispatched")
except ApprovalMismatch:
    check("override without the signed flag refuses", True)
except Exception as exc:  # noqa: BLE001
    check("override without the signed flag refuses", False, "wrong: %r" % exc)

# 4. never-dispatch cannot be overridden.
rec4 = _override_record(NEVER, "POST",
                        "/api/v1/courses/{course_id}/blueprint_templates/migrations",
                        {"course_id": "424242"})
try:
    ex.dispatch_catalog_op(
        NEVER, "POST",
        "/api/v1/courses/{course_id}/blueprint_templates/migrations",
        _class_of(NEVER, "POST",
                  "/api/v1/courses/{course_id}/blueprint_templates/migrations"),
        {"course_id": "424242"}, provider="canvas",
        op_id=str(uuid.uuid4()), pack=_pack(), approval=rec4,
        allow_unproven=True, session=_session([(200, "{}")]))
    check("never-dispatch cannot be overridden", False, "dispatched")
except NeverDispatch:
    check("never-dispatch cannot be overridden", True)
except Exception as exc:  # noqa: BLE001
    check("never-dispatch cannot be overridden", False, "wrong: %r" % exc)

# 5. evidence-hold cannot be overridden.
hold_desc = ex.catalog_descriptor_for(HOLD)
hold_method = hold_desc["method"] if hold_desc else "POST"
hold_path = hold_desc["path"] if hold_desc else "/api/quizzes/{builder_quiz_id}/quiz_entries"
hold_params = {"builder_quiz_id": "424242"}
rec5 = _override_record(HOLD, hold_method, hold_path, hold_params)
try:
    ex.dispatch_catalog_op(
        HOLD, hold_method, hold_path,
        _class_of(HOLD, hold_method, hold_path),
        dict(hold_params),
        provider="canvas", op_id=str(uuid.uuid4()), pack=_pack(),
        approval=rec5, allow_unproven=True,
        session=_session([(200, "{}")]))
    check("evidence-hold cannot be overridden", False, "dispatched")
except EvidenceHold:
    check("evidence-hold cannot be overridden", True)
except Exception as exc:  # noqa: BLE001
    check("evidence-hold cannot be overridden", False, "wrong: %r" % exc)

# 6. unknown operations cannot be overridden.
rec6 = _override_record(UNKNOWN, "GET", "/api/v1/courses/{course_id}/nope",
                        {"course_id": "424242"})
try:
    ex.dispatch_catalog_op(
        UNKNOWN, "GET", "/api/v1/courses/{course_id}/nope", "read",
        {"course_id": "424242"}, provider="canvas",
        op_id=str(uuid.uuid4()), pack=_pack(), approval=rec6,
        allow_unproven=True, session=_session([(200, "{}")]))
    check("unknown op cannot be overridden", False, "dispatched")
except ex.CatalogNotProven:
    check("unknown op cannot be overridden", True)
except Exception as exc:  # noqa: BLE001
    check("unknown op cannot be overridden", False, "wrong: %r" % exc)

# 7. descriptor mismatch refuses.
try:
    ex.dispatch_catalog_op(
        LIVE, "DELETE", "/api/v1/courses/{course_id}/external_feeds", "read",
        dict(LIVE_PARAMS), provider="canvas", op_id=str(uuid.uuid4()),
        pack=_pack(), session=_session([(200, "{}")]))
    check("descriptor mismatch refuses", False, "dispatched")
except ex.CatalogNotProven as exc:
    check("descriptor mismatch refuses",
          "arbitrary CLI arguments" in str(exc), str(exc))
except Exception as exc:  # noqa: BLE001
    check("descriptor mismatch refuses", False, "wrong: %r" % exc)

print("PASS: %d" % len(PASS))
for name in PASS:
    print("  ok %s" % name)
if FAIL:
    print("FAIL: %d" % len(FAIL))
    for name in FAIL:
        print("  FAIL %s" % name)
    sys.exit(1)
