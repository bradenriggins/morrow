#!/usr/bin/env python3
"""Selftest: silent-write hardening (D-009, D-010, D-011).

Covers the executor's write-path defenses offline, with a mocked CDP
layer (a fake transport injected into ChromiumSession; no Chromium is
launched, no Canvas touched):

  A. prevalidate_write_request: empty required fields are refused before
     any network call (D-010: discussion title; equivalents: assignment
     name, assignment-group name, module name, page title). Reads,
     unknown routes, and partial updates that omit the field pass.
  B. _write_field_matches: scalar comparison with provider normalization.
  C. _readback_target: member-GET derivation for POST/PUT/PATCH.
  D. D-009 end to end: a POST that returns 200 with a wrong object is
     detected on readback and raised as WriteFieldMismatch (hard failed
     write, journaled with uncertain=False, mismatched fields named).
  E. D-009 control: a readback that matches the intent passes.
  F. D-010 end to end: an empty discussion create is refused pre-network
     (no provider call, nothing journaled, op_id reusable).
  G. D-011 end to end: a page PUT to a missing URL is refused after the
     pre-check GET 404s (only the GET reaches the provider, no PUT).
  H. D-011 control: a page PUT to an existing page proceeds (GET, PUT,
     readback GET) and passes.
  I. Readback GET failure (500 x4) keeps the op uncertain, not failed:
     UncertainWrite from the readback journals uncertain=True and never
     becomes a WriteFieldMismatch.
  J. Page pre-check transport failure fails closed (WritePrevalidationFailed,
     no PUT attempted).
  K. DELETE writes are unaffected by the readback (skipped).
  L. run_multi_step applies prevalidation to write steps too.
  M. A declared verify block still runs after the readback passes.

No network, no Chromium, no session. Fakes only.
"""
import os as _home_os, sys as _home_sys  # noqa: E401
_home_sys.path.insert(0, _home_os.path.join(
    _home_os.path.dirname(_home_os.path.abspath(__file__)), '..'))
import config.selftest_home  # noqa: E402,F401  (scratch HOME/MORROW_HOME)
import json
import urllib.parse
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
    mint_approval, sign_approval, APPROVALS_DIR, CONSUMED_PATH)
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

# These scenarios use literal course/object ids in their paths, which
# are not catalog path templates. The live-proven catalog gate is
# covered by dispatch/test_direct_lane_hardening.py; here it is a no-op
# so the write-hardening gates are exercised in isolation.
ex.live_proven_gate = lambda *a, **k: None  # noqa: E731
# The signed-in account check (final muse audit M3) reads users/self
# before writes; these fakes script every provider call, so it is a
# no-op here. It is covered by transport/test_principal_check.py.
cs.ChromiumSession._verify_principal = lambda *a, **k: None  # noqa: E731


# Speed up: no real backoff sleeps in retry tests.
_ex_backoff = ex._backoff_sleep
ex._backoff_sleep = lambda attempt: None  # noqa: E731

# Hermetic journal + approvals (never touch the real ~/.morrow in tests).
# Wave-3 hygiene: MORROW_SELFTEST_SCRATCH redirects test scratch to the
# wave's authorized scratch area (never /tmp).
_scratch = os.path.join(REPO, "dispatch", ".selftest-work", "write-hardening")
if os.environ.get("MORROW_SELFTEST_SCRATCH"):
    _scratch = os.path.join(os.environ["MORROW_SELFTEST_SCRATCH"],
                            "write-hardening")
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

_AUTH = ("selftest authorization basis: offline mocked-CDP write hardening "
         "checks for D-009/D-010/D-011; no live provider is involved")


# ----------------------------------------------------------------------
# fakes
# ----------------------------------------------------------------------


def _is_roster_read(method, path):
    """The student roster read Morrow makes before it touches a course
    (dispatch/test_course_content_e2e.py checks it and its order)."""
    parts = urllib.parse.urlsplit(path)
    query = urllib.parse.parse_qs(parts.query)
    return method == "GET" and (
        (parts.path.endswith("/users")
         and "inactive" in query.get("enrollment_state[]", []))
        or (parts.path.endswith("/enrollments")
            and query.get("state[]") == ["deleted"]))


class FakeTransport:
    """Scripted stand-in for LocalChromiumTransport (the CDP layer)."""

    def __init__(self, script):
        self.script = list(script)
        self.calls = []
        self.roster_calls = []

    def ensure_session(self):
        return (1, "Test User")

    def api(self, method, path, data=None, _ws=None, timeout=60,
            as_json=False, max_bytes=None):
        if _is_roster_read(method, path):
            self.roster_calls.append(path)
            return 200, {}, "[]"
        self.calls.append({"method": method, "path": path, "data": data,
                           "as_json": as_json, "max_bytes": max_bytes})
        if not self.script:
            return 200, {}, "{}"
        kind = self.script.pop(0)
        if kind[0] == "raise":
            raise kind[1]
        headers = kind[3] if len(kind) > 3 else {}
        return kind[1], headers, kind[2]


def _session(script):
    return cs.ChromiumSession(BASE, transport=FakeTransport(script))


# W4-P0-11: the target-identity precheck GETs the course before any
# write that reaches dispatch; write scripts below prepend this
# response so the fake provider answers the precheck like Canvas would.
_COURSE_89585 = ("ok", 200, json.dumps({"id": 89585,
                                        "name": "Write Hardening"}))


def _pack():
    return {"credential_slots": {
        "canvas_pat": {"inject": {"header": "Authorization",
                                  "scheme": "Bearer"}}}}


def _admit(entry, params):
    plan_data = {
        "op_id": str(uuid.uuid4()),
        "entry_name": entry["name"],
        "params": params,
        "before_state_digest": ex.digest_of({"selftest": True}),
        # W4-P0-11: the target-identity gate requires the frozen
        # readback to corroborate the course the write targets, and the
        # plan to declare the human-readable target the educator reviewed.
        "frozen_readback": "write hardening selftest (course %s)"
        % (params.get("course_id") if isinstance(params, dict) else None),
        "target_identity": {
            "course_id": (params.get("course_id")
                          if isinstance(params, dict) else None),
            "course_name": "Write Hardening",
        },
    }
    plan = ex.FrozenPlan(plan_data, "selftest-plan")
    rec = mint_approval(entry, params, tenant_base=BASE,
                        target_identity={
                            "course_id": (params.get("course_id")
                                          if isinstance(params, dict)
                                          else None),
                            "course_name": "Write Hardening",
                        })
    sign_approval(rec, _AUTH, channel="driver")
    return plan, rec


# W4-P1-15: every write whose plan carries a before_state_digest must
# declare a reader or an explicit unsupported marker, or dispatch fails
# closed. These entries exercise other gates, so they declare the
# family unsupported with a reason (the verified/fresh-read path is
# covered in wave4_dispatch_integrity_selftest.py).
_UNSUPPORTED_BEFORE_STATE = {
    "unsupported": True,
    "reason": ("selftest: these entries exercise the D-009/D-010/D-011 "
               "gates, not the before-state freshness guard"),
}


def _write_entry(name, method, path, body=None, verify=None,
                 before_state=None):
    extra = {}
    if body is not None:
        extra["body"] = body
    if verify is not None:
        extra["verify"] = verify
    extra["before_state"] = (before_state if before_state is not None
                             else _UNSUPPORTED_BEFORE_STATE)
    return ex.catalog_descriptor_to_entry(
        name, method, path, "write", provider="canvas",
        extra=extra or None)


def _dispatch(entry, params, sess, plan, rec):
    return ex.dispatch_entry(entry, params, sess, _pack(), plan=plan,
                             op_id=None, approval=rec,
                             require_educator_channel=False)


# ----------------------------------------------------------------------
# A. prevalidate_write_request (pure function, no network)
# ----------------------------------------------------------------------

def _refused_prevalidate(method, url, body):
    try:
        ex.prevalidate_write_request({"name": "t"}, method, url, body)
    except ex.WritePrevalidationFailed as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        return "WRONG-EXC:%r" % exc
    return None


_DT = BASE + "/api/v1/courses/89585/discussion_topics"
_AG = BASE + "/api/v1/courses/89585/assignment_groups"

msg = _refused_prevalidate("POST", _DT, {})
check("D-010: empty discussion body refused pre-network",
      msg is not None and "'title'" in msg, repr(msg))
msg = _refused_prevalidate("POST", _DT, {"title": "   ", "message": "x"})
check("D-010: blank discussion title refused", msg is not None, repr(msg))
msg = _refused_prevalidate("POST", _DT, {"discussion_topic": {"title": ""}})
check("D-010: blank nested discussion title refused",
      msg is not None and "'title'" in msg, repr(msg))
check("discussion create with a title passes",
      _refused_prevalidate("POST", _DT, {"title": "Hi"}) is None)
check("discussion create with nested title passes",
      _refused_prevalidate(
          "POST", _DT, {"discussion_topic": {"title": "Hi"}}) is None)
msg = _refused_prevalidate(
    "POST", BASE + "/api/v1/courses/89585/assignments",
    {"assignment": {"name": ""}})
check("assignment create with empty name refused",
      msg is not None and "'name'" in msg, repr(msg))
check("assignment create with a name passes",
      _refused_prevalidate(
          "POST", BASE + "/api/v1/courses/89585/assignments",
          {"assignment": {"name": "A"}}) is None)
msg = _refused_prevalidate("POST", _AG, {"assignment_group": {}})
check("assignment-group create with missing name refused",
      msg is not None and "'name'" in msg, repr(msg))
msg = _refused_prevalidate(
    "POST", BASE + "/api/v1/courses/89585/modules", {"module": {"name": ""}})
check("module create with empty name refused",
      msg is not None and "'name'" in msg, repr(msg))
msg = _refused_prevalidate(
    "POST", BASE + "/api/v1/courses/89585/pages", {"wiki_page": {"title": ""}})
check("page create with empty title refused",
      msg is not None and "'title'" in msg, repr(msg))
check("partial update omitting the field passes",
      _refused_prevalidate(
          "PUT", _DT + "/2", {"message": "only a message edit"}) is None)
msg = _refused_prevalidate("PUT", _DT + "/2", {"title": ""})
check("update blanking the title is refused", msg is not None, repr(msg))
check("PATCH renaming an assignment passes",
      _refused_prevalidate(
          "PATCH", BASE + "/api/v1/courses/89585/assignments/1",
          {"assignment": {"name": "New"}}) is None)
check("reads are untouched by prevalidation",
      _refused_prevalidate("GET", _DT, None) is None)
check("unknown routes are untouched by prevalidation",
      _refused_prevalidate(
          "POST", BASE + "/api/v1/courses/89585/unknown_things",
          {}) is None)
check("WritePrevalidationFailed is an ExecutorError",
      issubclass(ex.WritePrevalidationFailed, ex.ExecutorError))
check("WriteFieldMismatch is a VerificationFailed",
      issubclass(ex.WriteFieldMismatch, ex.VerificationFailed))

# ----------------------------------------------------------------------
# B. _write_field_matches
# ----------------------------------------------------------------------
_m = ex._write_field_matches
check("exact int match", _m(3, 3))
check("int/float cross match", _m(3, 3.0))
check("string/int cross match", _m("3", 3) and _m(3, "3"))
check("bool exact match", _m(True, True))
check("bool/string match", _m(True, "true") and _m(False, "False"))
check("malformed value never matches the default",
      not _m("banana", 60))
check("None matches only None", _m(None, None) and not _m(None, 0))
check("different strings mismatch", not _m("Ask", "Assignments"))

# ----------------------------------------------------------------------
# C. _readback_target
# ----------------------------------------------------------------------
_t = ex._readback_target
check("POST collection appends the created id",
      _t("POST", BASE + "/api/v1/courses/89585/assignment_groups",
         {"id": 436900})
      == BASE + "/api/v1/courses/89585/assignment_groups/436900")
check("POST pages appends the page url",
      _t("POST", BASE + "/api/v1/courses/89585/pages", {"url": "my-page"})
      == BASE + "/api/v1/courses/89585/pages/my-page")
check("POST with no id in the response has no readback",
      _t("POST", BASE + "/api/v1/courses/89585/assignment_groups", {}) is None)
check("PUT re-reads the member URL",
      _t("PUT", BASE + "/api/v1/courses/89585/pages/my-page", {})
      == BASE + "/api/v1/courses/89585/pages/my-page")
check("PATCH re-reads the member URL",
      _t("PATCH", BASE + "/api/v1/courses/89585/assignments/42", {})
      == BASE + "/api/v1/courses/89585/assignments/42")
check("DELETE has no readback",
      _t("DELETE", BASE + "/api/v1/courses/89585/assignments/42", {}) is None)
check("unknown POST surface has no readback",
      _t("POST", BASE + "/api/v1/courses/89585/unknown_things",
         {"id": 1}) is None)
# F-11: New Quiz readback derivation.
check("POST New Quiz collection appends the created quiz id",
      _t("POST", BASE + "/api/quiz/v1/courses/89585/quizzes",
         {"id": 1234567})
      == BASE + "/api/quiz/v1/courses/89585/quizzes/1234567")
check("PATCH New Quiz member re-reads the member URL",
      _t("PATCH", BASE + "/api/quiz/v1/courses/89585/quizzes/1234567", {})
      == BASE + "/api/quiz/v1/courses/89585/quizzes/1234567")
check("PUT New Quiz member re-reads the member URL",
      _t("PUT", BASE + "/api/quiz/v1/courses/89585/quizzes/1234567", {})
      == BASE + "/api/quiz/v1/courses/89585/quizzes/1234567")
check("POST New Quiz items collection appends the created item id",
      _t("POST", BASE + "/api/quiz/v1/courses/89585/quizzes/1234567/items",
         {"id": 7654321})
      == BASE + "/api/quiz/v1/courses/89585/quizzes/1234567/items/7654321")
check("PATCH New Quiz item member re-reads the member URL",
      _t("PATCH",
         BASE + "/api/quiz/v1/courses/89585/quizzes/1234567/items/7654321",
         {})
      == BASE + "/api/quiz/v1/courses/89585/quizzes/1234567/items/7654321")
check("POST New Quiz quiz with no id has no readback",
      _t("POST", BASE + "/api/quiz/v1/courses/89585/quizzes", {}) is None)
# W3-P2-22: Item Bank readback derivation.
check("POST /api/banks appends the created bank id (nested)",
      _t("POST", BASE + "/api/banks", {"bank": {"id": 4053}})
      == BASE + "/api/banks/4053")
check("POST /api/banks appends the created bank id (flat)",
      _t("POST", BASE + "/api/banks", {"id": 4053})
      == BASE + "/api/banks/4053")
check("POST /api/banks with no id has no readback",
      _t("POST", BASE + "/api/banks", {"bank": {}}) is None)
# LANE6-1: item routes deliberately derive NO readback: the provider
# does not serve direct item GET (IB-11, provider-anomalous 404), so a
# derived readback would false-positive every item write as uncertain.
# The working item read path is the bank entry GET (IB-10).
check("POST /api/banks/{id}/items has no readback (IB-11)",
      _t("POST", BASE + "/api/banks/99/items", {"item": {"id": 777}}) is None)
check("PATCH item member has no readback (IB-11)",
      _t("PATCH", BASE + "/api/banks/99/items/777", {}) is None)
check("item create skip names IB-10 entry GET as the read path",
      "IB-10" in (ex._readback_skip_reason(
          "POST", "/api/banks/99/items") or ""))
check("item PATCH skip names the provider anomaly",
      "IB-11" in (ex._readback_skip_reason(
          "PATCH", "/api/banks/99/items/777") or ""))
check("POST /api/banks/{id}/items with no id has no readback",
      _t("POST", BASE + "/api/banks/99/items", {}) is None)
check("POST Item Bank share collection has no member readback",
      _t("POST", BASE + "/api/banks/99/shared_banks", {"id": 1}) is None)
check("PATCH bank member re-reads the member URL",
      _t("PATCH", BASE + "/api/banks/99", {})
      == BASE + "/api/banks/99")
# LANE6-1: item PATCH/PUT derive no readback (IB-11 provider anomaly).
check("PATCH item member has no readback derivation",
      _t("PATCH", BASE + "/api/banks/99/items/777", {}) is None)
check("PUT item member has no readback derivation",
      _t("PUT", BASE + "/api/banks/99/items/777", {}) is None)
check("PATCH share member has no readback derivation",
      _t("PATCH", BASE + "/api/banks/99/shared_banks/5", {}) is None)
check("DELETE bank has no readback",
      _t("DELETE", BASE + "/api/banks/99", {}) is None)
check("New Quiz accommodations route has no readback derivation",
      _t("POST", BASE + "/api/quiz/v1/courses/89585/quizzes/1234567/"
                "accommodations", {"id": 1}) is None)
check("New Quiz reports route has no readback derivation",
      _t("PUT", BASE + "/api/quiz/v1/courses/89585/quizzes/1234567/"
               "reports/session/1", {}) is None)
# F-11: skipped surfaces report a route-specific reason.
_sr = ex._readback_skip_reason
check("skip reason names the DELETE limitation",
      "no safe readback" in _sr("DELETE", BASE + "/api/v1/courses/1/"
                                           "assignments/2"))
check("skip reason names New Quiz accommodations",
      "accommodations" in _sr("POST", BASE + "/api/quiz/v1/courses/1/"
                                       "quizzes/2/accommodations"))
check("skip reason names New Quiz reports",
      "report" in _sr("PUT", BASE + "/api/quiz/v1/courses/1/quizzes/2/"
                              "reports/session/3"))
check("skip reason names Item Bank routes",
      "Item Bank" in _sr("POST", BASE + "/api/banks/99/entries"))
check("skip reason names the missing bank id",
      "no bank id" in _sr("POST", BASE + "/api/banks"))
check("skip reason names the item-route provider anomaly",
      "IB-11" in _sr("POST", BASE + "/api/banks/99/items"))
check("skip reason names uncovered Item Bank member routes",
      "no member readback derivation" in _sr(
          "PATCH", BASE + "/api/banks/99/shared_banks/5"))
check("skip reason names media uploads",
      "media upload" in _sr("POST", BASE + "/api/v1/courses/1/files"))
check("skip reason names a missing created id",
      "no member id" in _sr("POST", BASE + "/api/v1/courses/1/"
                                     "assignment_groups"))
check("skip reason falls back to the route for unknown surfaces",
      "no readback route derivable" in _sr("POST", BASE + "/api/v1/"
                                                 "unknown_things"))

# ----------------------------------------------------------------------
# D. D-009 end to end: 200 with a wrong object is a hard failed write
# ----------------------------------------------------------------------
_d009_body = {"assignment_group": {"name": "PROOF-D009-x",
                                   "position": "banana"}}
_d009_created = {"id": 436900, "name": "Assignments", "position": 60}
entry = _write_entry("wh_d009_ag_create", "POST",
                     "/api/v1/courses/89585/assignment_groups",
                     body=_d009_body)
params = {"course_id": "89585"}
plan, rec = _admit(entry, params)
sess = _session([_COURSE_89585,
                 ("ok", 200, json.dumps(_d009_created)),
                 ("ok", 200, json.dumps(_d009_created))])
try:
    _dispatch(entry, params, sess, plan, rec)
    check("D-009 mismatch raises WriteFieldMismatch", False, "no exception")
except ex.WriteFieldMismatch as exc:
    msg = str(exc)
    check("D-009 mismatch raises WriteFieldMismatch", True)
    check("D-009 diagnostic names the name field",
          "name:" in msg and "'Assignments'" in msg, msg)
    check("D-009 diagnostic names the position field",
          "position:" in msg, msg)
    check("D-009 diagnostic carries the created id for cleanup",
          "436900" in msg, msg)
except ex.VerificationFailed as exc:
    check("D-009 mismatch raises WriteFieldMismatch", False,
          "got plain VerificationFailed: %s" % exc)
except Exception as exc:  # noqa: BLE001
    check("D-009 mismatch raises WriteFieldMismatch", False,
          "wrong exception: %r" % exc)
calls = sess._transport.calls
check("D-009: target-identity course GET precedes the write",
      calls and calls[0]["method"] == "GET"
      and calls[0]["path"] == "/api/v1/courses/89585",
      repr(calls))
check("D-009: the write POST went out",
      len(calls) == 3 and calls[1]["method"] == "POST"
      and calls[1]["path"] == "/api/v1/courses/89585/assignment_groups",
      repr(calls))
check("D-009: readback GET hit the created member",
      calls[2]["method"] == "GET"
      and calls[2]["path"] == "/api/v1/courses/89585/assignment_groups/436900",
      repr(calls))
jrec = ex.find_journal_op(plan.op_id)
check("D-009: the failed write is journaled",
      jrec is not None and jrec.get("entry_name") == "wh_d009_ag_create")
check("D-009: journal verification is fail",
      jrec is not None and jrec.get("verification") == "fail",
      repr((jrec or {}).get("verification")))
check("D-009: journal marks the effect certain (uncertain=False)",
      jrec is not None and jrec.get("uncertain") is False,
      repr((jrec or {}).get("uncertain")))
check("D-009: journal detail names the mismatched fields",
      jrec is not None and "name:" in str(jrec.get("verification_detail")),
      repr((jrec or {}).get("verification_detail")))
check("D-009: journal receipt keeps the created id for cleanup",
      jrec is not None and (jrec.get("receipt") or {}).get("id") == 436900,
      repr((jrec or {}).get("receipt")))

# ----------------------------------------------------------------------
# E. D-009 control: a matching readback passes
# ----------------------------------------------------------------------
entry = _write_entry("wh_d009_control", "POST",
                     "/api/v1/courses/89585/assignment_groups",
                     body={"assignment_group": {"name": "Good", "position": 3}})
params = {"course_id": "89585"}
plan, rec = _admit(entry, params)
_good = {"id": 7, "name": "Good", "position": 3}
sess = _session([_COURSE_89585,
                 ("ok", 200, json.dumps(_good)),
                 ("ok", 200, json.dumps(_good))])
out = _dispatch(entry, params, sess, plan, rec)
check("matching readback dispatches successfully",
      out["receipt"].get("id") == 7, repr(out["receipt"]))
check("matching readback reports pass",
      out["verification"].get("status") == "pass",
      repr(out["verification"]))
check("matching readback names the compared fields",
      "name" in out["verification"].get("detail", "")
      and "position" in out["verification"].get("detail", ""),
      out["verification"].get("detail"))

# ----------------------------------------------------------------------
# F. D-010 end to end: empty discussion create refused pre-network
# ----------------------------------------------------------------------
entry = _write_entry("wh_d010_discussion_create", "POST",
                     "/api/v1/courses/89585/discussion_topics", body={})
params = {"course_id": "89585"}
plan, rec = _admit(entry, params)
sess = _session([])
try:
    _dispatch(entry, params, sess, plan, rec)
    check("D-010: empty discussion create refused", False, "no exception")
except ex.WritePrevalidationFailed as exc:
    check("D-010: empty discussion create refused", True)
    check("D-010: refusal names the title field",
          "'title'" in str(exc), str(exc))
except Exception as exc:  # noqa: BLE001
    check("D-010: empty discussion create refused", False,
          "wrong exception: %r" % exc)
check("D-010: no provider call was made",
      sess._transport.calls == [], repr(sess._transport.calls))
check("D-010: nothing journaled, op_id reusable",
      ex.find_journal_op(plan.op_id) is None)

# ----------------------------------------------------------------------
# G. D-011 end to end: page PUT to a missing URL refused pre-network
# ----------------------------------------------------------------------
entry = _write_entry("wh_d011_page_put", "PUT",
                     "/api/v1/courses/89585/pages/d011-nosuchpage-abc123",
                     body={"wiki_page": {"title": "T", "body": "B"}})
params = {"course_id": "89585"}
plan, rec = _admit(entry, params)
sess = _session([("ok", 404, '{"message": "The specified resource does not exist."}')])
try:
    _dispatch(entry, params, sess, plan, rec)
    check("D-011: page PUT to a missing URL refused", False, "no exception")
except ex.WritePrevalidationFailed as exc:
    check("D-011: page PUT to a missing URL refused", True)
    check("D-011: refusal says the page does not exist",
          "does not exist" in str(exc), str(exc))
except Exception as exc:  # noqa: BLE001
    check("D-011: page PUT to a missing URL refused", False,
          "wrong exception: %r" % exc)
calls = sess._transport.calls
check("D-011: only the pre-check GET reached the provider",
      len(calls) == 1 and calls[0]["method"] == "GET"
      and calls[0]["path"] == "/api/v1/courses/89585/pages/d011-nosuchpage-abc123",
      repr(calls))
check("D-011: nothing journaled, op_id reusable",
      ex.find_journal_op(plan.op_id) is None)

# ----------------------------------------------------------------------
# H. D-011 control: page PUT to an existing page proceeds
# ----------------------------------------------------------------------
entry = _write_entry("wh_d011_control", "PUT",
                     "/api/v1/courses/89585/pages/exists",
                     body={"wiki_page": {"title": "New"}})
params = {"course_id": "89585"}
plan, rec = _admit(entry, params)
_old = {"url": "exists", "title": "Old", "page_id": 1}
_new = {"url": "exists", "title": "New", "page_id": 1}
sess = _session([("ok", 200, json.dumps(_old)),
                 _COURSE_89585,
                 ("ok", 200, json.dumps(_new)),
                 ("ok", 200, json.dumps(_new))])
out = _dispatch(entry, params, sess, plan, rec)
check("page PUT to an existing page succeeds",
      out["verification"].get("status") == "pass",
      repr(out["verification"]))
calls = sess._transport.calls
check("existing page: pre-check GET, target course GET, PUT, readback GET in order",
      [c["method"] for c in calls] == ["GET", "GET", "PUT", "GET"]
      and calls[0]["path"] == "/api/v1/courses/89585/pages/exists"
      and calls[1]["path"] == "/api/v1/courses/89585"
      and calls[2]["path"] == "/api/v1/courses/89585/pages/exists"
      and calls[3]["path"] == "/api/v1/courses/89585/pages/exists",
      repr(calls))

# ----------------------------------------------------------------------
# I. Readback GET failure keeps the op uncertain, never failed
# ----------------------------------------------------------------------
entry = _write_entry("wh_readback_500", "POST",
                     "/api/v1/courses/89585/assignment_groups",
                     body={"assignment_group": {"name": "G"}})
params = {"course_id": "89585"}
plan, rec = _admit(entry, params)
sess = _session([_COURSE_89585,
                 ("ok", 200, json.dumps({"id": 9, "name": "G"}))]
                + [("ok", 500, "x")] * 4)
try:
    _dispatch(entry, params, sess, plan, rec)
    check("readback 500 keeps the op uncertain", False, "no exception")
except ex.WriteFieldMismatch as exc:
    check("readback 500 keeps the op uncertain", False,
          "hard failure on an unconfirmed readback: %s" % exc)
except ex.VerificationFailed as exc:
    check("readback 500 keeps the op uncertain", False,
          "reported as a failed verification, not uncertain: %s" % exc)
except ex.UncertainWrite as exc:
    check("readback 500 keeps the op uncertain", True)
    check("readback 500 is not reported as success", True)
    jrec = ex.find_journal_op(plan.op_id)
    check("readback 500 journals uncertain=True",
          jrec is not None and jrec.get("uncertain") is True,
          repr((jrec or {}).get("uncertain")))
    check("readback 500 journals verification uncertain",
          (jrec or {}).get("verification") == "uncertain",
          repr((jrec or {}).get("verification")))
    check("readback 500 detail says unconfirmed",
          "unconfirmed" in str(exc), str(exc))
except Exception as exc:  # noqa: BLE001
    check("readback 500 keeps the op uncertain", False,
          "wrong exception: %r" % exc)
check("readback 500: target GET, one POST plus retried GETs, no blind write retry",
      len(sess._transport.calls) == 6
      and sess._transport.calls[0]["method"] == "GET"
      and sess._transport.calls[0]["path"] == "/api/v1/courses/89585"
      and sess._transport.calls[1]["method"] == "POST"
      and all(c["method"] == "GET" for c in sess._transport.calls[2:]),
      repr(sess._transport.calls))

# ----------------------------------------------------------------------
# J. Page pre-check transport failure fails closed
# ----------------------------------------------------------------------
entry = _write_entry("wh_precheck_down", "PUT",
                     "/api/v1/courses/89585/pages/any-page",
                     body={"wiki_page": {"title": "T"}})
params = {"course_id": "89585"}
plan, rec = _admit(entry, params)
sess = _session([("raise", ConnectionError("reset"))] * 4)
try:
    _dispatch(entry, params, sess, plan, rec)
    check("pre-check failure fails closed", False, "no exception")
except ex.WritePrevalidationFailed as exc:
    check("pre-check failure fails closed", True)
    check("pre-check failure says failing closed",
          "failing closed" in str(exc), str(exc))
except Exception as exc:  # noqa: BLE001
    check("pre-check failure fails closed", False, "wrong exception: %r" % exc)
check("pre-check failure: no PUT attempted",
      all(c["method"] == "GET" for c in sess._transport.calls),
      repr(sess._transport.calls))

# ----------------------------------------------------------------------
# K. DELETE is verified by absence (member GET answers 404)
# ----------------------------------------------------------------------
entry = _write_entry("wh_delete", "DELETE",
                     "/api/v1/courses/89585/assignment_groups/436900")
params = {"course_id": "89585"}
plan, rec = _admit(entry, params)
sess = _session([_COURSE_89585, ("ok", 200, '{"id": 436900}'),
                 ("ok", 404, '{"errors": [{"message": "not found"}]}')])
out = _dispatch(entry, params, sess, plan, rec)
check("DELETE verified by the member GET 404",
      out["verification"].get("status") == "pass"
      and out.get("outcome") == "verified",
      repr(out))
check("DELETE: course GET, one DELETE, then the absence readback GET",
      len(sess._transport.calls) == 3
      and sess._transport.calls[0]["method"] == "GET"
      and sess._transport.calls[0]["path"] == "/api/v1/courses/89585"
      and sess._transport.calls[1]["method"] == "DELETE"
      and sess._transport.calls[2]["method"] == "GET"
      and sess._transport.calls[2]["path"]
      == "/api/v1/courses/89585/assignment_groups/436900",
      repr(sess._transport.calls))

# ----------------------------------------------------------------------
# L. run_multi_step applies prevalidation to write steps
# ----------------------------------------------------------------------
_ms_entry = {
    "manifest": ex.MANIFEST_CONSTANT,
    "name": "wh_ms_discussion",
    "provider": "canvas",
    "effects": "write",
    "auth": {"slot": "canvas_pat", "alternates": []},
    "result": {"max_bytes": 262144},
    "multi_step": [
        {"name": "create",
         "method": "POST",
         "url": BASE + "/api/v1/courses/89585/discussion_topics",
         "headers": {},
         "body": {}},
    ],
}
sess = _session([])
try:
    ex.run_multi_step(_ms_entry, sess, _pack(), {"canvas_base": BASE},
                      {"course_id": "89585"}, {})
    check("multi_step write step prevalidated", False, "no exception")
except ex.WritePrevalidationFailed:
    check("multi_step write step prevalidated", True)
except Exception as exc:  # noqa: BLE001
    check("multi_step write step prevalidated", False,
          "wrong exception: %r" % exc)
check("multi_step refusal made no provider call",
      sess._transport.calls == [], repr(sess._transport.calls))

# ----------------------------------------------------------------------
# M. A declared verify block still runs after the readback passes
# ----------------------------------------------------------------------
entry = _write_entry(
    "wh_declared_verify", "POST", "/api/v1/courses/89585/assignments",
    body={"assignment": {"name": "A"}},
    verify={"method": "GET",
            "url": "{canvas_base}/api/v1/courses/89585/assignments/42",
            "expect": {"name": "params.aname"}})
params = {"course_id": "89585", "aname": "A"}
plan, rec = _admit(entry, params)
_created = {"id": 42, "name": "A"}
sess = _session([_COURSE_89585,
                 ("ok", 200, json.dumps(_created)),
                 ("ok", 200, json.dumps(_created)),
                 ("ok", 200, json.dumps(_created))])
out = _dispatch(entry, params, sess, plan, rec)
check("declared verify block runs after the readback",
      out["verification"].get("status") == "pass"
      and "write readback" in out["verification"].get("detail", "")
      and "verify block" in out["verification"].get("detail", ""),
      repr(out["verification"]))
check("target GET, write, readback, verify block in order",
      [c["method"] for c in sess._transport.calls] == ["GET", "POST", "GET", "GET"]
      and sess._transport.calls[0]["path"] == "/api/v1/courses/89585",
      repr(sess._transport.calls))

# ----------------------------------------------------------------------
# N. run_multi_step applies the D-009 readback to write steps
# ----------------------------------------------------------------------
def _ms_write_entry(name, body):
    return {
        "manifest": ex.MANIFEST_CONSTANT,
        "name": name,
        "provider": "canvas",
        "effects": "write",
        "auth": {"slot": "canvas_pat", "alternates": []},
        "result": {"max_bytes": 262144},
        "before_state": dict(_UNSUPPORTED_BEFORE_STATE),
        "multi_step": [
            {"name": "create",
             "method": "POST",
             "url": BASE + "/api/v1/courses/89585/assignment_groups",
             "headers": {},
             "body": body},
        ],
    }


_wrong = {"id": 5, "name": "Assignments", "position": 60}
sess = _session([("ok", 200, json.dumps(_wrong)),
                 ("ok", 200, json.dumps(_wrong))])
try:
    ex.run_multi_step(
        _ms_write_entry("wh_ms_readback",
                        {"assignment_group": {"name": "X",
                                             "position": "banana"}}),
        sess, _pack(), {"canvas_base": BASE}, {"course_id": "89585"}, {})
    check("multi_step write step readback detects mismatch", False,
          "no exception")
except ex.WriteFieldMismatch as exc:
    check("multi_step write step readback detects mismatch", True)
    check("multi_step mismatch names the wrong fields",
          "name:" in str(exc) and "position:" in str(exc), str(exc))
except Exception as exc:  # noqa: BLE001
    check("multi_step write step readback detects mismatch", False,
          "wrong exception: %r" % exc)
check("multi_step mismatch: POST then readback GET, nothing else",
      [c["method"] for c in sess._transport.calls] == ["POST", "GET"]
      and sess._transport.calls[1]["path"].endswith("/assignment_groups/5"),
      repr(sess._transport.calls))

# ----------------------------------------------------------------------
# O. multi_step control: matching readback lets the step succeed
# ----------------------------------------------------------------------
_good_ms = {"id": 6, "name": "X", "position": 3}
sess = _session([("ok", 200, json.dumps(_good_ms)),
                 ("ok", 200, json.dumps(_good_ms))])
last, _tr = ex.run_multi_step(
    _ms_write_entry("wh_ms_readback_ok",
                    {"assignment_group": {"name": "X", "position": 3}}),
    sess, _pack(), {"canvas_base": BASE}, {"course_id": "89585"}, {})
check("multi_step matching readback succeeds",
      last["payload"].get("id") == 6, repr(last["payload"]))

# ----------------------------------------------------------------------
# P. dispatch_entry journals a multi_step readback mismatch as failed
# ----------------------------------------------------------------------
entry = _ms_write_entry("wh_ms_dispatch_mismatch",
                        {"assignment_group": {"name": "Y",
                                             "position": "banana"}})
params = {"course_id": "89585"}
plan, rec = _admit(entry, params)
sess = _session([_COURSE_89585,
                 ("ok", 200, json.dumps(_wrong)),
                 ("ok", 200, json.dumps(_wrong))])
try:
    _dispatch(entry, params, sess, plan, rec)
    check("multi_step dispatch mismatch journaled as failed", False,
          "no exception")
except ex.WriteFieldMismatch:
    jrec = ex.find_journal_op(plan.op_id)
    check("multi_step dispatch mismatch journaled as failed",
          jrec is not None and jrec.get("verification") == "fail"
          and jrec.get("uncertain") is False,
          repr({k: (jrec or {}).get(k)
                for k in ("verification", "uncertain")}))
except Exception as exc:  # noqa: BLE001
    check("multi_step dispatch mismatch journaled as failed", False,
          "wrong exception: %r" % exc)

# ----------------------------------------------------------------------
# N. journal archive / rotation / quarantine / audit-record integrity
# ----------------------------------------------------------------------
_saved_rotate = ex.JOURNAL_ROTATE_BYTES
ex.JOURNAL_ROTATE_BYTES = 1  # force rotation on next append

# N1: a completed op rotates into an archive; a later index rebuild must
# keep its op_id reserved (W2-P0-18: no silent reuse after rotation).
_n1_op = str(uuid.uuid4())
_n1_tok = ex.claim_op_id(_n1_op, "dispatch", "test.n1", "write", "d")
ex.journal_append(ex._journal_record(
    "test.n1", "dispatch", "write", {"a": 1}, None, _n1_op,
    "after", {"status": "verified"},
    {"receipt": {"ok": True}, "truncated": False, "bytes_received": 10}, 1))
# Force rotation of the now-large-enough live journal.
with ex._journal_locked():
    ex._maybe_rotate_locked()
_archives = os.listdir(ex._journal_archive_dir())
check("rotation archived the live journal", len(_archives) >= 1,
      repr(_archives))
# Force a full index rebuild (simulates post-repair rescan).
with ex._journal_locked():
    ex._rebuild_index_locked()
try:
    ex.claim_op_id(_n1_op, "dispatch", "test.n1", "write", "d")
    check("archived op_id stays reserved after rebuild", False,
          "claim succeeded")
except ex.DuplicateOpId:
    check("archived op_id stays reserved after rebuild", True)
check("archived outcome still queryable",
      ex.find_journal_op(_n1_op) is not None
      and ex.find_journal_op(_n1_op)["verification"] == "verified")

# N2: a pending claim rotates into an archive; the token holder can
# still release it (the claim is found via the locations map).
_n2_op = str(uuid.uuid4())
_n2_tok = ex.claim_op_id(_n2_op, "dispatch", "test.n2", "write", "d")
with ex._journal_locked():
    ex._maybe_rotate_locked()
try:
    ex.release_op_id(_n2_op, _n2_tok, "selftest release of archived claim")
    check("archived claim released by token holder", True)
except ex.DuplicateOpId as exc:
    check("archived claim released by token holder", False, str(exc)[:100])
check("released archived op_id reusable",
      ex.claim_op_id(_n2_op, "dispatch", "test.n2", "write", "d") is not None)

# N3: a pending write that rotated stays visible to reconciliation.
_n3_op = str(uuid.uuid4())
_n3_tok = ex.claim_op_id(_n3_op, "dispatch", "test.n3", "write", "d")
with ex._journal_locked():
    ex._maybe_rotate_locked()
_pend_ids = [p["op_id"] for p in ex.journal_pending_ops()]
check("rotated pending op visible to reconciliation", _n3_op in _pend_ids,
      repr(_pend_ids))
_status = ex.journal_status()
check("journal_status reports rotated pending",
      _n3_op in _status["pending_writes"])

ex.JOURNAL_ROTATE_BYTES = _saved_rotate

# N4: repeated scans of the same torn journal create exactly one
# quarantine file (content-addressed, no duplicates).
with open(ex.JOURNAL_PATH, "ab") as fh:
    fh.write(b'{"op_id": "torn-1", "wal": "pending",\n')
_q_before = [f for f in os.listdir(os.path.dirname(ex.JOURNAL_PATH))
             if ".torn." in f]
for _ in range(3):
    try:
        ex._scan_journal_file(ex.JOURNAL_PATH)
        check("torn journal raises JournalTorn", False, "no exception")
    except ex.JournalTorn:
        check("torn journal raises JournalTorn", True)
        break
_q_after = [f for f in os.listdir(os.path.dirname(ex.JOURNAL_PATH))
            if ".torn." in f]
_new_q = [f for f in _q_after if f not in _q_before]
check("one quarantine file per torn state", len(_new_q) == 1,
      repr(_new_q))
# Repair truncates to the last good line and reuses that quarantine.
_rep = ex.journal_repair()
check("repair succeeds", _rep["repaired"] is True, repr(_rep))
check("repair reuses the existing quarantine",
      _rep["quarantine"].endswith(_new_q[0]), repr(_rep["quarantine"]))
_q_final = [f for f in os.listdir(os.path.dirname(ex.JOURNAL_PATH))
            if ".torn." in f]
check("repair creates no second quarantine",
      len([f for f in _q_final if f not in _q_before]) == 1,
      repr(_q_final))
try:
    ex._scan_journal_file(ex.JOURNAL_PATH)
    check("journal valid after repair", True)
except ex.JournalTorn:
    check("journal valid after repair", False, "still torn")

# N5: an ambiguous write-failure audit record is side evidence, never
# the op's outcome: the claim stays live and the op stays reconcilable.
_n5_op = str(uuid.uuid4())
_n5_tok = ex.claim_op_id(_n5_op, "dispatch", "test.n5", "write", "d")


class _Boom(Exception):
    pass


ex._journal_write_failure_audit(
    "test.n5", "dispatch", "write", {"a": 1}, None, _n5_op, _Boom("x"),
    {"write_attempted": True}, None, None)
check("audit record is not reported as the outcome",
      ex.find_journal_op(_n5_op) is None)
check("claim stays live after audit record",
      ex.claim_is_live(_n5_op))
check("audited op stays in pending reconciliation",
      _n5_op in [p["op_id"] for p in ex.journal_pending_ops()])
try:
    ex.claim_op_id(_n5_op, "dispatch", "test.n5", "write", "d")
    check("audited op_id refused as duplicate (reserved)", False,
          "claim succeeded")
except ex.DuplicateOpId:
    check("audited op_id refused as duplicate (reserved)", True)

# N6: a post-claim, pre-provider failure releases the claim: a LOCAL
# governance procedure is refused after claiming, and the op_id stays
# reusable for a corrected retry.
_n6_entry = ex.catalog_descriptor_to_entry(
    "test.local_proc", "LOCAL", "/local/thing", "write", provider="canvas")
_n6_plan, _n6_rec = _admit(_n6_entry, {"course_id": "1"})
_n6_op = _n6_plan.op_id
try:
    ex.dispatch_entry(_n6_entry, {"course_id": "1"},
                      _session([]), _pack(), plan=_n6_plan,
                      op_id=_n6_op, approval=_n6_rec,
                      require_educator_channel=False)
    check("LOCAL procedure refused post-claim", False, "no exception")
except ex.LocalProcedureRefused:
    check("LOCAL procedure refused post-claim", True)
except Exception as exc:  # noqa: BLE001
    check("LOCAL procedure refused post-claim", False, "wrong: %r" % exc)
check("post-claim refusal journals no outcome",
      ex.find_journal_op(_n6_op) is None)
check("post-claim refusal releases the claim (op_id reusable)",
      ex.claim_op_id(_n6_op, "dispatch", "test.local_proc", "write", "d")
      is not None)

# W6-P1-D1 / W6-P2-D2: destructive confirmations.
def _t_destructive_confirm():
    import io
    from unittest import mock
    # --yes runs without prompting.
    ex._require_destructive_confirm("journal-seal", "test warning", True)
    check("w6p1d1: --yes skips the prompt", True)
    # Non-interactive stdin without --yes is REFUSED, not run blind.
    with mock.patch.object(ex.sys, "stdin") as stdin:
        stdin.isatty.return_value = False
        try:
            ex._require_destructive_confirm("journal-seal", "w", False)
            check("w6p1d1: non-tty without --yes refused", False,
                  "no ExecutorError raised")
        except ex.ExecutorError as exc:
            check("w6p1d1: non-tty without --yes refused",
                  "--yes" in str(exc), str(exc)[:80])
    # Interactive: "yes" proceeds, anything else aborts.
    with mock.patch.object(ex.sys, "stdin") as stdin, \
         mock.patch("builtins.input", return_value="yes"):
        stdin.isatty.return_value = True
        ex._require_destructive_confirm("journal-seal", "w", False)
        check("w6p1d1: interactive 'yes' proceeds", True)
    with mock.patch.object(ex.sys, "stdin") as stdin, \
         mock.patch("builtins.input", return_value="no"):
        stdin.isatty.return_value = True
        try:
            ex._require_destructive_confirm("journal-seal", "w", False)
            check("w6p1d1: interactive 'no' aborts", False,
                  "no ExecutorError raised")
        except ex.ExecutorError as exc:
            check("w6p1d1: interactive 'no' aborts",
                  "aborted" in str(exc), str(exc)[:80])
    # W6-P2-D2: claim-release needs a real reconciliation note.
    for bad in ("", "   ", "fixed it", "released the claim"):
        try:
            ex._check_operator_reason("claim-release", bad)
            check("w6p2d2: stub reason %r refused" % bad, False,
                  "no ExecutorError raised")
        except ex.ExecutorError:
            check("w6p2d2: stub reason %r refused" % bad, True)
    ex._check_operator_reason(
        "claim-release",
        "reconciled op abc123 against the provider: no such page exists")
    check("w6p2d2: genuine reconciliation note accepted", True)
_t_destructive_confirm()

# W6-P2-E2: approval-file errors carry no OSError text (no path/username).
def _t_sanitized_approval_errors():
    try:
        ex._load_approval("/nonexistent/dir/approval-<op>.json")
        check("w6p2e2: unreadable approval file refused", False,
              "no ExecutorError raised")
    except ex.ExecutorError as exc:
        msg = str(exc)
        check("w6p2e2: unreadable approval file refused",
              "nonexistent" not in msg and "approval-<op>" not in msg, msg)
    bad = os.path.join(_scratch, "notjson.json")
    with open(bad, "w") as fh:
        fh.write("{not json")
    try:
        ex._load_approval(bad)
        check("w6p2e2: malformed approval file refused", False,
              "no ExecutorError raised")
    except ex.ExecutorError as exc:
        check("w6p2e2: malformed approval file refused",
              _scratch not in str(exc) and "notjson" not in str(exc),
              str(exc)[:100])
    check("w6p2e2: missing path returns None",
          ex._load_approval(None) is None)
_t_sanitized_approval_errors()


# W6-P2-E3: torn-preview bytes are labeled untrusted in the repair result.
def _t_torn_preview_labeled():
    ex.journal_append({"op_id": str(uuid.uuid4()), "kind": "w6e3_probe"})
    with open(ex.JOURNAL_PATH, "ab") as fh:
        fh.write(b'{"op_id": "torn1", "kind": "broken", "x": \x00\x01\n')
    result = ex.journal_repair()
    check("w6p2e3: repair runs on a torn journal",
          result.get("repaired") is True, repr(result)[:100])
    preview = result.get("torn_preview", "")
    check("w6p2e3: torn preview is labeled untrusted",
          preview.startswith("[untrusted journal data follows]"),
          preview[:60])
    check("w6p2e3: quarantine path recorded",
          bool(result.get("quarantine")), repr(result.get("quarantine")))
_t_torn_preview_labeled()


# W6-P2-S1: a lost catalog-refusal journal write fails LOUD on stderr.
def _t_catalog_refusal_journal_failure_loud():
    import io
    from unittest import mock
    err = io.StringIO()
    with mock.patch.object(ex, "journal_append",
                           side_effect=OSError("disk full")), \
         mock.patch.object(ex.sys, "stderr", err):
        ex._journal_catalog_refusal("w6s1_op", "GET", "/x", {}, "refused",
                                    "test refusal")
    out = err.getvalue()
    check("w6p2s1: journal failure warns on stderr",
          "MORROW WARNING" in out and "w6s1_op" in out, out[:120])
_t_catalog_refusal_journal_failure_loud()

# W6-P1-H1: every educator-visible completion surface discloses undo.
def _t_receipt_undo_disclosure():
    with_undo = {"name": "w6h1_probe", "effects": "write",
                 "undo": {"kind": "delete", "op": "x"}}
    without = {"name": "w6h1_probe", "effects": "write"}
    for entry, expected in ((with_undo, True), (without, False)):
        out = ex._render_dry_run(entry, {}, None, {}, None,
                                 "op-w6h1", None, None, "write", "write")
        check("w6h1: dry-run receipt discloses undo_available=%r" % expected,
              out.get("undo_available") is expected, repr(out.get("undo_available")))
    # The journal record carries the same field.
    rec = ex._journal_record(
        "w6h1_probe", "dispatch", "write", {}, None, "op-w6h1", None,
        {"status": "ok", "detail": "probe"},
        {"receipt": {}, "truncated": False, "bytes_received": 0},
        1, undo_available=True)
    check("w6h1: journal record carries undo_available=True",
          rec.get("undo_available") is True)
    rec2 = ex._journal_record(
        "w6h1_probe", "dispatch", "write", {}, None, "op-w6h1b", None,
        {"status": "ok", "detail": "probe"},
        {"receipt": {}, "truncated": False, "bytes_received": 0},
        1, undo_available=False)
    check("w6h1: journal record carries undo_available=False",
          rec2.get("undo_available") is False)
_t_receipt_undo_disclosure()

# W6-P1-S2: a failed educator notification fails LOUD, never silent.
def _t_notification_failure_loud():
    import io
    from unittest import mock
    import reauth as _reauth_pkg  # noqa: E402  (parent package)
    fake = mock.MagicMock()
    fake.on_expiry_detected.return_value = None
    fake.quarantine_op.return_value = None
    fake.paused_ops.return_value = [{"op_id": "x"}]
    fake.write_notify_expired.side_effect = OSError("disk full")
    fake.write_notify_stale.side_effect = OSError("disk full")
    err = io.StringIO()
    # NB: `from reauth import state_machine` resolves via the parent
    # package's attribute when the real submodule was already
    # imported, so patch the attribute as well as sys.modules.
    with mock.patch.dict("sys.modules",
                         {"reauth.state_machine": fake}), \
         mock.patch.object(_reauth_pkg, "state_machine", fake,
                           create=True), \
         mock.patch.object(ex.sys, "stderr", err):
        ex._on_session_death("op-w6s2", "probe_entry", "probe evidence")
    out = err.getvalue()
    check("w6p1s2: failed session-death notification warns on stderr",
          "MORROW WARNING" in out and "FAILED to write" in out, out[:150])
    err2 = io.StringIO()
    with mock.patch.dict("sys.modules",
                         {"reauth.state_machine": fake}), \
         mock.patch.object(_reauth_pkg, "state_machine", fake,
                           create=True), \
         mock.patch.object(ex.sys, "stderr", err2):
        ex._on_stale_verify("op-w6s2b", "probe_entry", "probe evidence")
    out2 = err2.getvalue()
    check("w6p1s2: failed stale notification warns on stderr",
          "MORROW WARNING" in out2 and "FAILED to write" in out2,
          out2[:150])
_t_notification_failure_loud()


def _t_pat_401_expiry_honest():
    # W4-P2-4 / WORKSTREAM 4: a 401 on the express token (PAT) lane must
    # name the token cause and the mint-a-fresh-token remedy, fail fast
    # (one attempt, no retry of a rejected credential), and never be
    # reported as an uncertain write (a 401 proves rejection, not
    # ambiguity).
    calls = []

    def fake_do_request(method, url, headers, body_bytes, timeout,
                        max_bytes=None):
        calls.append((method, url))
        return 401, {}, b'{"message": "Invalid access token"}'

    real = ex._do_request
    ex._do_request = fake_do_request
    try:
        try:
            ex.request_with_retry("GET", "https://t/api/v1/users/self",
                                  {"Authorization": "Bearer <redacted>"},
                                  None, is_write=False)
        except ex.ProviderHttpError as exc:
            msg = str(exc)
            check("w4: 401 on token lane raises ProviderHttpError with "
                  "honest detail", "HTTP 401" in msg, msg[:120])
            check("w4: 401 detail names the token cause (not a generic 4xx)",
                  "personal access token" in msg, msg[:120])
            check("w4: 401 detail does not overclaim which of "
                  "revoked/expired/invalid it was",
                  "does not prove which" in msg, msg[:120])
            check("w4: 401 remedy is mint-a-fresh-token, not re-sign-in",
                  "mint a fresh token" in msg
                  and "re-signing in" in msg, msg[:120])
        else:
            check("w4: 401 on token lane raises", False)
        check("w4: 401 is fail-fast (exactly one attempt, no retry)",
              len(calls) == 1, "calls=%d" % len(calls))
        # A 401 write is a definitive rejection: it must surface as
        # ProviderHttpError, never as UncertainWrite.
        calls.clear()
        try:
            ex.request_with_retry("POST", "https://t/api/v1/x", {}, b"{}",
                                  is_write=True)
        except ex.UncertainWrite:
            check("w4: 401 write is not UncertainWrite", False)
        except ex.ProviderHttpError as exc:
            check("w4: 401 write raises ProviderHttpError, not "
                  "UncertainWrite", True)
            check("w4: 401 write error carries the token remedy",
                  "mint a fresh token" in str(exc), str(exc)[:120])
        else:
            check("w4: 401 write raises", False)
    finally:
        ex._do_request = real


_t_pat_401_expiry_honest()

# restore
ex._backoff_sleep = _ex_backoff
ex.JOURNAL_PATH, ex.MORROW_HOME = _saved_journal, _saved_home
admission_mod.APPROVALS_DIR, admission_mod.CONSUMED_PATH = _saved_adir, _saved_consumed
shutil.rmtree(_scratch, ignore_errors=True)

print("PASS: %d" % len(PASS))
for name in PASS:
    print("  ok %s" % name)
if FAIL:
    print("FAIL: %d" % len(FAIL))
    for name in FAIL:
        print("  FAIL %s" % name)
    sys.exit(1)
print("write hardening selftest: %d passed, %d failed"
      % (len(PASS), len(FAIL)))
print("all write hardening selftests passed")
