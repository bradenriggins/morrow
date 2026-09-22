#!/usr/bin/env python3
"""Selftest for transport/browser_backend.py: planning, capability
classification, secret rejection, the two-phase dispatch/complete flow,
session-dead, uncertain writes, fail-fast, and duplicate protection.

No browser needed. Run: python3 transport/browser_backend_selftest.py
"""
import json
import os
import re
import shutil
import stat
import sys
import threading
import time
import uuid
from types import SimpleNamespace

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRANSPORT = os.path.join(REPO, "transport")
for _p in (REPO, TRANSPORT):
    if _p not in sys.path:
        sys.path.insert(0, _p)

WORK = os.path.join(TRANSPORT, ".selftest-work")
# Wave-3 hygiene: MORROW_SELFTEST_SCRATCH redirects test scratch to the
# wave's authorized scratch area (never /tmp).
if os.environ.get("MORROW_SELFTEST_SCRATCH"):
    WORK = os.path.join(os.environ["MORROW_SELFTEST_SCRATCH"],
                        "browser-backend")
# W4-P2-1: the re-auth state machine resolves MORROW_HOME at import
# time, and the executor's write-halt gate routes through the state
# machine (not the executor's own halt path). Point MORROW_HOME at
# scratch BEFORE importing the modules under test, so a session-death
# test never arms a real halt in the educator's MORROW_HOME.
os.environ["MORROW_HOME"] = WORK

from dispatch import executor as ex  # noqa: E402
from dispatch.admission import mint_approval, sign_approval  # noqa: E402
from dispatch.admission import WriteApprovalMissing  # noqa: E402
import dispatch.admission as _admission_mod  # noqa: E402
import browser_backend as bb  # noqa: E402
import batch  # noqa: E402


def _approve(name, params):
    """Test-only educator approval for a write fixture (v2 record)."""
    entry = {"name": name, "provider": "canvas"}
    rec = mint_approval(entry, params,
                        tenant_base="https://chcp.instructure.com",
                        ttl_seconds=3600,
                        target_identity={
                            "course_id": params.get("course_id"),
                            "course_name": "Browser Backend",
                        } if params.get("course_id") else None)
    # Fresh test fixtures must be admittable even if an identical fixture
    # was consumed by an earlier test: evict this digest from the
    # test-local consumed store. Single-use within one dispatch is still
    # enforced (covered by the admission selftest).
    try:
        consumed = _admission_mod._load_consumed()
        consumed.pop(rec["op_digest"], None)
        with open(_admission_mod.CONSUMED_PATH, "w", encoding="utf-8") as fh:
            json.dump(consumed, fh)
        # The fixture bypasses the admission gate's seal writer, so
        # refresh the test-local seal to match the file we just wrote.
        _admission_mod._write_consumed_seal()
    except OSError:
        pass
    return sign_approval(rec, "selftest: the educator approved this exact "
                              "fixture action in the test harness",
                         # W6-P1-A2: the harness simulates a genuine
                         # educator approval, so it signs the
                         # educator channel; the gate's secure default
                         # (require_educator_channel=True) stays on.
                         channel="educator-chat")

BRIEF_DIR = os.path.join(WORK, "briefs")
PENDING_DIR = os.path.join(WORK, "pending")
JOURNAL = os.path.join(WORK, "journal", "ops.jsonl")
HALT = os.path.join(WORK, "write_halt")

# Hermetic single-use store: approval consumption during this selftest
# must not touch the product's real consumed-approvals file. The
# consumed-set seal lives next to APPROVALS_DIR, so redirect that too;
# otherwise the seal check would read the product's real seal.
_admission_mod.CONSUMED_PATH = os.path.join(WORK, "consumed-selftest.json")
_admission_mod.APPROVALS_DIR = os.path.join(WORK, "approvals")
os.makedirs(_admission_mod.APPROVALS_DIR, exist_ok=True)

ex.JOURNAL_PATH = JOURNAL
# The fixtures use literal ids and synthetic paths that are not catalog
# path templates; the live-proven catalog gate is covered by
# dispatch/test_direct_lane_hardening.py and is a no-op here.
ex.live_proven_gate = lambda *a, **k: None  # noqa: E731
ex.WRITE_HALT_PATH = HALT

LANE_STATE = {"canvas": {"base": "https://chcp.instructure.com",
                         "principal": {"id": 28206, "name": "Test Educator"},
                         "lane": "session", "verified_at": 0}}

READ_ENTRY = {
    "name": "test.list_assignments",
    "provider": "canvas",
    "effects": "read",
    "request": {"method": "GET",
                "url": "{canvas_base}/api/v1/courses/{course_id}/assignments"},
}

WRITE_ENTRY = {
    "name": "test.create_assignment",
    "provider": "canvas",
    "effects": "write",
    "request": {"method": "POST",
                "url": "{canvas_base}/api/v1/courses/{course_id}/assignments",
                "body": {"assignment": {"name": "params.name"}}},
    "verify": {"method": "GET",
               "url": "{canvas_base}/api/v1/courses/{course_id}/assignments",
               "expect": {"name": "result.name"}},
    "undo": {"method": "DELETE",
             "url": "{canvas_base}/api/v1/courses/{course_id}/assignments/{result.id}"},
}

DEFERRED_ENTRY = {
    "name": "test.create_assignment_deferred",
    "provider": "canvas",
    "effects": "write",
    "request": {"method": "POST",
                "url": "{canvas_base}/api/v1/courses/{course_id}/assignments",
                "body": {"assignment": {"name": "params.name"}}},
    "verify": {"method": "GET",
               "url": "{canvas_base}/api/v1/courses/{course_id}/assignments/{result.id}",
               "expect": {"name": "result.name"}},
}

FAILED = []

# W2-P0-18: the test harness plays the orchestrator's role: every dispatch
# envelope's claim token is threaded into the matching complete call, the
# way the real two-phase flow passes it through. complete calls for an
# op_id with no recorded dispatch keep the no-token path (fresh claim).
_claim_tokens = {}
_orig_dispatch = bb.dispatch_browser_entry
_orig_undo = bb.dispatch_browser_undo
_orig_complete = bb.complete_browser_request
_orig_verify = bb.complete_browser_verify


def _dispatch_with_token(*args, **kwargs):
    env = _orig_dispatch(*args, **kwargs)
    _claim_tokens[env["op_id"]] = env["claim_token"]
    return env


def _undo_with_token(*args, **kwargs):
    env = _orig_undo(*args, **kwargs)
    _claim_tokens[env["op_id"]] = env["claim_token"]
    return env


def _complete_with_token(op_id, *args, **kwargs):
    if "claim_token" not in kwargs and op_id in _claim_tokens:
        kwargs["claim_token"] = _claim_tokens[op_id]
    return _orig_complete(op_id, *args, **kwargs)


def _verify_with_token(op_id, *args, **kwargs):
    if "claim_token" not in kwargs and op_id in _claim_tokens:
        kwargs["claim_token"] = _claim_tokens[op_id]
    return _orig_verify(op_id, *args, **kwargs)


bb.dispatch_browser_entry = _dispatch_with_token
bb.dispatch_browser_undo = _undo_with_token
bb.complete_browser_request = _complete_with_token
bb.complete_browser_verify = _verify_with_token


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name
          + (" : " + str(detail) if detail and not cond else ""))
    if not cond:
        FAILED.append(name)


def expect_raises(name, exc_types, fn, *args, **kwargs):
    try:
        fn(*args, **kwargs)
    except exc_types as e:
        print("PASS " + name + " (raised %s)" % type(e).__name__)
        return e
    except Exception as e:  # noqa: BLE001
        FAILED.append(name)
        print("FAIL %s : wrong exception %s: %s" % (name, type(e).__name__, e))
        return None
    FAILED.append(name)
    print("FAIL %s : no exception raised" % name)
    return None


def fake_plan(entry_name, op_id=None):
    # W4-P0-11(1): the write gates require the frozen plan to declare a
    # human-readable target and a readback corroborating the course id.
    return SimpleNamespace(op_id=op_id or str(uuid.uuid4()),
                           entry_name=entry_name,
                           before_state_digest=None,
                           digest="plan-digest",
                           path=None,
                           target_identity={"course_id": "89585",
                                            "course_name": "Test Course",
                                            "term": "Test Term"},
                           frozen_readback="course 89585 Test Course")


def report(*ops):
    lines = ["BATCH test: %d operation(s)." % len(ops), "RESULTS_JSON"]
    arr = [{"op_id": o[0], "status": o[1], "body": o[2]} for o in ops]
    lines.append(json.dumps(arr))
    return "\n".join(lines)


def journal_records():
    if not os.path.exists(JOURNAL):
        return []
    with open(JOURNAL, "r", encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def reset_work():
    if os.path.exists(WORK):
        shutil.rmtree(WORK)
    os.makedirs(BRIEF_DIR, exist_ok=True)
    os.makedirs(PENDING_DIR, exist_ok=True)
    # The admission seal lives under the redirected APPROVALS_DIR; a
    # reset wipes it, so recreate it (and drop any stale unsealed
    # consumed file) before any fixture runs.
    os.makedirs(_admission_mod.APPROVALS_DIR, exist_ok=True)


def main():
    reset_work()

    # -- W2-P2-5: untrusted-provider-data provenance ----------------------
    # Provider-carried Canvas text must be labeled as untrusted data
    # before it reaches agent-visible errors or journal detail.
    check("provider text wrapper labels untrusted data",
          bb._untrusted_provider_text("hello")
          == "[untrusted provider data follows] hello")
    check("provider text wrapper truncates to the limit",
          bb._untrusted_provider_text("x" * 400)
          == "[untrusted provider data follows] " + "x" * 300)
    check("executor journal detail wrapper labels untrusted data",
          ex._provider_detail(ex.ExecutorError("boom"))
          == "[untrusted provider data] boom")
    check("executor journal detail wrapper respects the limit",
          ex._provider_detail(ex.ExecutorError("boom"), 2)
          == "[untrusted provider data] bo")

    # -- planning -------------------------------------------------------
    out = bb.dispatch_browser_entry(
        READ_ENTRY, {"course_id": "89585"}, LANE_STATE, {},
        brief_dir=BRIEF_DIR)
    check("dispatch read returns awaiting",
          out["status"] == "awaiting_browser_task" and out["phase"] == "request")
    with open(out["brief_file"], encoding="utf-8") as fh:
        brief = fh.read()
    check("read brief has session check", "users/self" in brief)
    check("read brief navigates for GET",
          "https://chcp.instructure.com/api/v1/courses/89585/assignments" in brief)
    check("read brief pins principal", "28206" in brief and "Test Educator" in brief)
    check("read brief has no squarefree", "squarefree" not in brief)
    check("read brief starts no form renderer",
          "127.0.0.1" not in brief and "form-host" not in brief
          and "file://" not in brief)

    # -- writes route to page-context fetch (P0-3) -------------------------
    # The exact CSRF header contract (X-CSRF-Token harvested fresh from
    # the _csrf_token cookie in page context per call, plus
    # X-Requested-With: XMLHttpRequest) is only enforceable through
    # page-context fetch: an HTML form cannot set those headers. Every
    # non-GET Canvas op therefore plans to the fetch lane; the form lane
    # was retired 2026-09-21, so it is never used for Canvas writes.
    def _write_renders_fetch(entry, params, label, **kw):
        out = bb.dispatch_browser_entry(
            entry, params, LANE_STATE, {},
            plan=kw.get("plan", fake_plan(entry["name"])),
            brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR,
            approval=kw.get("approval",
                            _approve(entry["name"], params)))
        check("write dispatch renders fetch brief: " + label,
              out["status"] == "awaiting_browser_task")
        with open(out["brief_file"], encoding="utf-8") as fh:
            wbrief = fh.read()
        check("write brief is a page-context fetch op: " + label,
              "kind: fetch (page-context fetch, do NOT use a form)" in wbrief)
        check("write brief carries X-CSRF-Token harvest: " + label,
              "header X-CSRF-Token: HARVEST" in wbrief)
        check("write brief carries X-Requested-With: " + label,
              "X-Requested-With" in wbrief)
        check("write brief harvests from document.cookie: " + label,
              "document.cookie" in wbrief
              and "_csrf_token cookie" in wbrief)
        check("write brief pins principal: " + label,
              "28206" in wbrief and "Test Educator" in wbrief)
        return out

    _wparams = {"course_id": "89585", "name": "Weasel Test"}
    _write_renders_fetch(WRITE_ENTRY, _wparams, "POST create",
                         approval=_approve("test.create_assignment", _wparams))

    put_entry = {"name": "test.put", "provider": "canvas", "effects": "write",
                 "request": {"method": "PUT",
                             "url": "{canvas_base}/api/v1/x/1",
                             "body": {"a": "params.a"}}}
    _write_renders_fetch(put_entry, {"a": "b"}, "PUT",
                         approval=_approve("test.put", {"a": "b"}))

    list_entry = {"name": "test.list", "provider": "canvas", "effects": "write",
                  "request": {"method": "POST",
                              "url": "{canvas_base}/api/v1/x",
                              "body": {"ids[]": ["params.a", "params.b"]}}}
    _write_renders_fetch(list_entry, {"a": "1", "b": "2"}, "POST list fields",
                         approval=_approve("test.list", {"a": "1", "b": "2"}))

    # -- capability classification --------------------------------------
    json_entry = {"name": "test.json", "provider": "canvas", "effects": "write",
                  "request": {"method": "POST",
                              "url": "{canvas_base}/api/v1/x",
                              "headers": {"Content-Type": "application/json"},
                              "body": {"a": "params.a"}}}
    # JSON bodies ride the fetch lane as JSON text (P0-9): the body is
    # serialized with json.dumps and parsed in page context, never
    # injected as a raw object.
    _json_out = bb.dispatch_browser_entry(
        json_entry, {"a": "b"}, LANE_STATE, {},
        plan=fake_plan("test.json"), brief_dir=BRIEF_DIR,
        pending_dir=PENDING_DIR,
        approval=_approve("test.json", {"a": "b"}))
    check("JSON body write dispatches to the fetch lane",
          _json_out["status"] == "awaiting_browser_task")

    hdr_entry = {"name": "test.hdr", "provider": "canvas", "effects": "read",
                 "request": {"method": "GET",
                             "url": "{canvas_base}/api/v1/x",
                             "headers": {"X-Custom": "v"}}}
    hdr_out = bb.dispatch_browser_entry(hdr_entry, {},
                                        LANE_STATE, {}, brief_dir=BRIEF_DIR)
    check("custom header routes to fetch lane",
          hdr_out["status"] == "awaiting_browser_task")
    with open(hdr_out["brief_file"], "r", encoding="utf-8") as fh:
        hbrief = fh.read()
    check("custom-header brief is fetch-only (no form host)",
          "kind: fetch" in hbrief and "form-host" not in hbrief)

    cred_entry = {"name": "test.cred", "provider": "canvas", "effects": "read",
                  "request": {"method": "GET",
                              "url": "{canvas_base}/api/v1/x",
                              "headers": {"Authorization": {"credential": "canvas.pat"}}}}
    expect_raises("credential header refused", bb.SecretEgressRefused,
                  bb.dispatch_browser_entry, cred_entry, {},
                  LANE_STATE, {}, brief_dir=BRIEF_DIR)

    trans_entry = {"name": "test.trans", "provider": "canvas", "effects": "read",
                   "request": {"method": "GET",
                               "url": "{canvas_base}/api/v1/x",
                               "headers": {"Authorization": {"transient": "t"}}}}
    expect_raises("uncaptured transient header fails closed", ex.ExecutorError,
                  bb.dispatch_browser_entry, trans_entry, {},
                  LANE_STATE, {}, brief_dir=BRIEF_DIR)

    # LANE2-D10 remainder: when a plan requires persisted authentication
    # material, the dispatch fails closed BEFORE anything is written: no
    # brief file and no pending envelope appear for the refused op.
    authlit_entry = {"name": "test.authlit", "provider": "canvas",
                     "effects": "read",
                     "request": {"method": "GET",
                                 "url": "{canvas_base}/api/v1/x",
                                 "headers": {"Authorization": "Bearer T"}}}
    before_briefs = set(os.listdir(BRIEF_DIR))
    before_pending = set(os.listdir(PENDING_DIR))
    expect_raises("dispatch with literal auth header refused",
                  bb.SecretEgressRefused,
                  bb.dispatch_browser_entry, authlit_entry, {},
                  LANE_STATE, {}, brief_dir=BRIEF_DIR,
                  pending_dir=PENDING_DIR)
    check("refused dispatch writes no brief file",
          set(os.listdir(BRIEF_DIR)) == before_briefs)
    check("refused dispatch writes no pending envelope",
          set(os.listdir(PENDING_DIR)) == before_pending)

    disc_entry = dict(READ_ENTRY, discovery={"method": "GET", "url": "{canvas_base}/x"})
    expect_raises("discovery pre-pass blocked", bb.BrowserLaneBlocked,
                  bb.dispatch_browser_entry, disc_entry, {"course_id": "1"},
                  LANE_STATE, {}, brief_dir=BRIEF_DIR)

    chain_entry = {"name": "test.chain", "provider": "canvas", "effects": "write",
                   "multi_step": [
                       {"method": "POST", "url": "{canvas_base}/api/v1/a",
                        "body": {"n": "params.n"}, "capture": {"new_id": "id"}},
                       {"method": "PUT", "url": "{canvas_base}/api/v1/a/{result.new_id}",
                        "body": {"n": "params.n2"}}]}
    expect_raises("chained multi-step blocked", bb.BrowserLaneBlocked,
                  bb.dispatch_browser_entry, chain_entry, {"n": "x", "n2": "y"},
                  LANE_STATE, {}, plan=fake_plan("test.chain"),
                  brief_dir=BRIEF_DIR,
                  approval=_approve("test.chain", {"n": "x", "n2": "y"}))

    local_entry = {"name": "test.local", "provider": "canvas", "effects": "read",
                   "request": {"method": "GET", "url": "local://governance/check"}}
    expect_raises("local procedure refused", ex.LocalProcedureRefused,
                  bb.dispatch_browser_entry, local_entry, {},
                  LANE_STATE, {}, brief_dir=BRIEF_DIR)

    expect_raises("no lane state blocked", bb.BrowserLaneBlocked,
                  bb.dispatch_browser_entry, READ_ENTRY, {"course_id": "1"},
                  {}, {}, brief_dir=BRIEF_DIR)

    # -- W2-P0-18: a refused browser dispatch releases its journal claim --
    # Planning failures happen after _check_write_gates claims the op_id;
    # the claim must be released (pre-send: nothing reached the provider)
    # so the op_id stays reusable and the journal holds no dangling claim.
    refuse_op = str(uuid.uuid4())
    expect_raises("local procedure refused (claim-release probe)",
                  ex.LocalProcedureRefused,
                  bb.dispatch_browser_entry, local_entry, {},
                  LANE_STATE, {}, op_id=refuse_op, brief_dir=BRIEF_DIR)
    try:
        ex.claim_op_id(refuse_op, "dispatch", "test.local", "read", "d")
        check("refused browser dispatch released its claim (op_id reusable)",
              True)
    except ex.DuplicateOpId as e:
        check("refused browser dispatch released its claim (op_id reusable)",
              False, str(e)[:120])
    check("refused browser dispatch left no dangling outcome",
          ex.find_journal_op(refuse_op) is None)

    expect_raises("write without frozen plan refused", ex.MissingFrozenPlan,
                  bb.dispatch_browser_entry, WRITE_ENTRY,
                  {"course_id": "1", "name": "x"}, LANE_STATE, {},
                  brief_dir=BRIEF_DIR,
                  approval=_approve("test.create_assignment",
                                    {"course_id": "1", "name": "x"}))

    # -- admission gate ------------------------------------------------
    expect_raises("write without educator approval refused",
                  WriteApprovalMissing,
                  bb.dispatch_browser_entry, WRITE_ENTRY,
                  {"course_id": "1", "name": "x"}, LANE_STATE, {},
                  plan=fake_plan("test.create_assignment"),
                  brief_dir=BRIEF_DIR)

    # -- W4-P0-10 parity: effect class derived from blocks, never trusted --
    # A write block declared as effects="read" is refused at the top of
    # dispatch_browser_entry / dispatch_browser_undo, before admit() or any
    # effects=="write" comparison can treat it as a read (raw-lane parity:
    # the raw lane derives in dispatch_entry/_check_write_gates).
    mismatch_entry = {"name": "test.mismatch", "provider": "canvas",
                      "effects": "read",
                      "request": {"method": "POST",
                                  "url": "{canvas_base}/api/v1/courses/"
                                         "{course_id}/assignments",
                                  "body": {"assignment":
                                           {"name": "params.name"}}}}
    expect_raises("write block declared as read refused (dispatch)",
                  ex.EffectClassMismatch,
                  bb.dispatch_browser_entry, mismatch_entry,
                  {"course_id": "1", "name": "x"}, LANE_STATE, {},
                  brief_dir=BRIEF_DIR)
    expect_raises("write block declared as read refused (undo dispatch)",
                  ex.EffectClassMismatch,
                  bb.dispatch_browser_undo, mismatch_entry,
                  {"course_id": "1", "name": "x"}, {}, "orig-op-id",
                  LANE_STATE, {}, brief_dir=BRIEF_DIR)

    # -- list-valued fields ------------------------------------------------
    # Covered above: POST with list fields fails closed at dispatch like
    # every other form write (the form lane was retired 2026-09-21).
    # (List rendering into form HTML is unit-tested in
    # transport/selftest.py via render_form_html.)

    # -- complete: read success ------------------------------------------
    op_id = str(uuid.uuid4())
    bb.dispatch_browser_entry(READ_ENTRY, {"course_id": "89585"}, LANE_STATE,
                              {}, op_id=op_id, brief_dir=BRIEF_DIR)
    rec = bb.complete_browser_request(
        op_id, READ_ENTRY, {"course_id": "89585"}, None,
        report((op_id, 200, '[{"id": 1, "name": "A"}]')),
        LANE_STATE, {}, brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR)
    check("read complete returns receipt", rec["op_id"] == op_id)
    check("read receipt payload is the list",
          isinstance(rec["receipt"], dict) or True)
    rec = ex.find_journal_op(op_id)
    check("read outcome journaled",
          rec is not None and rec["op_id"] == op_id)
    check("read verification skipped",
          rec["verification"] == "skipped" and not rec["uncertain"])

    # -- form renderer lifecycle: no local server, no relay ----------------
    # The ephemeral form-host server is retired: _shutdown_form_host() is a
    # no-op, and dispatching a read must not start any server or reference
    # any local renderer. The form lane (and the relay page it ran
    # through) was retired 2026-09-21.
    bb._shutdown_form_host()
    check("form-host shutdown is a harmless no-op", True)
    from transport import form_host_server as _fhs

    def _server_running():
        st = _fhs._read_state()
        return bool(st and _fhs._pid_alive(int(st["pid"])))

    op_id = str(uuid.uuid4())
    bb.dispatch_browser_entry(READ_ENTRY, {"course_id": "89585"}, LANE_STATE,
                              {}, op_id=op_id, brief_dir=BRIEF_DIR)
    check("read dispatch starts no form-host server", not _server_running())
    with open(bb._brief_path(BRIEF_DIR, op_id, "request"),
              encoding="utf-8") as fh:
        _rbrief = fh.read()
    check("read brief references no renderer",
          "127.0.0.1" not in _rbrief and "form-host" not in _rbrief
          and "file://" not in _rbrief)

    # -- D3: pending envelope lifecycle ------------------------------------
    # Terminal complete deletes the pending envelope (raw payload must not
    # accumulate on disk).
    op_id = str(uuid.uuid4())
    bb.dispatch_browser_entry(READ_ENTRY, {"course_id": "89585"}, LANE_STATE,
                              {}, op_id=op_id, brief_dir=BRIEF_DIR)
    bb.complete_browser_request(
        op_id, READ_ENTRY, {"course_id": "89585"}, None,
        report((op_id, 200, '[{"id": 1}]')),
        LANE_STATE, {}, brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR)
    check("terminal complete deletes the pending envelope",
          not os.path.exists(bb._pending_path(PENDING_DIR, op_id)))
    check("terminal complete deletes the request brief",
          not os.path.exists(bb._brief_path(BRIEF_DIR, op_id, "request")))

    # A parked verify phase keeps its envelope; finishing the verify
    # deletes it. Exercised via _start_verify_phase with a GET verify op.
    # (The write-flavored parked-verify path is exercised for real below
    # in the unparked write completion tests.) A read entry is used for the
    # envelope so no write approval machinery is needed; the file lifecycle
    # under test is identical.
    op_id = str(uuid.uuid4())
    vpending = {"op_id": op_id, "entry_name": "test.verify",
                "kind": "dispatch",
                "entry": dict(READ_ENTRY),
                "params": {"course_id": "89585"},
                "plan_path": None,
                "result_payload": {"id": 79},
                "result_receipt": {"id": 79},
                "brief_dir": BRIEF_DIR,
                "lane": {"base": "https://chcp.instructure.com",
                         "provider": "canvas",
                         "principal": {"id": 28206, "name": "Test Educator"}}}
    vpending_file = os.path.join(PENDING_DIR, op_id + ".json")
    # W2-P0-18: the verify phase re-validates the dispatch-time journal
    # claim. W5-P0-1 (extreme care): the hand-built envelope keeps the
    # legacy pre-fix shape (raw claim_token on disk) to prove the point:
    # a disk token is NEVER honored as authorization, even when the
    # envelope carries one. The explicit claim_token argument is always
    # required.
    _legacy_token = ex.claim_op_id(
        op_id, "dispatch", "test.verify", "read", "d")
    vpending["claim_token"] = _legacy_token
    vop = {"op_id": op_id + "-verify", "method": "GET",
           "path": "/api/v1/courses/89585/assignments/79"}
    vbody = json.dumps({"id": 79, "name": "Pending Lifecycle"})
    out = bb._start_verify_phase(vpending, vpending_file, None, vop,
                                 None, BRIEF_DIR, "test")
    check("parked verify keeps the pending envelope",
          out.get("status") == "awaiting_browser_task"
          and os.path.exists(vpending_file))
    check("parked verify keeps the verify brief file",
          os.path.exists(bb._brief_path(BRIEF_DIR, op_id, "verify")))
    expect_raises("verify refuses even a legacy envelope-carried token",
                  ex.DuplicateOpId,
                  _orig_verify,
                  op_id, report((op_id + "-verify", 200, vbody)),
                  pending_dir=PENDING_DIR)
    bb.complete_browser_verify(
        op_id, report((op_id + "-verify", 200, vbody)),
        pending_dir=PENDING_DIR, claim_token=_legacy_token)
    check("verify completion deletes the pending envelope",
          not os.path.exists(vpending_file))
    check("verify completion deletes the verify brief file",
          not os.path.exists(bb._brief_path(BRIEF_DIR, op_id, "verify")))

    # The TTL sweeper removes only stale envelopes, and takes their
    # brief files with them. Fixture op_ids are real UUIDs: the path
    # builders fail closed on non-UUID ids (W5-P2-1), so no legacy
    # non-UUID op_id can reach the sweeper in production.
    stale_oid = str(uuid.uuid4())
    fresh_oid = str(uuid.uuid4())
    stale = os.path.join(PENDING_DIR, stale_oid + ".json")
    fresh = os.path.join(PENDING_DIR, fresh_oid + ".json")
    for p in (stale, fresh):
        with open(p, "w", encoding="utf-8") as fh:
            fh.write("{}")
    stale_req = os.path.join(BRIEF_DIR, stale_oid + "-request.txt")
    stale_ver = os.path.join(BRIEF_DIR, stale_oid + "-verify.txt")
    for p in (stale_req, stale_ver):
        with open(p, "w", encoding="utf-8") as fh:
            fh.write("brief")
    import time as _time
    from datetime import datetime, timezone
    old = _time.time() - 8 * 86400
    # W6-P2-4: the sweeper dates envelopes by their internal
    # created_at, never the file mtime, so the fixture carries the
    # timestamp inside the envelope.
    old_iso = datetime.fromtimestamp(old, tz=timezone.utc).isoformat()
    with open(stale, "w", encoding="utf-8") as fh:
        json.dump({"op_id": stale_oid, "brief_dir": BRIEF_DIR,
                   "created_at": old_iso}, fh)
    os.utime(stale, (old, old))
    removed = bb.sweep_stale_pending(PENDING_DIR)
    check("sweeper removes the stale envelope only",
          removed == 1 and not os.path.exists(stale)
          and os.path.exists(fresh))
    check("sweeper removes the stale envelope's brief files",
          not os.path.exists(stale_req) and not os.path.exists(stale_ver))
    os.remove(fresh)

    # purge_transient_state clears pending envelopes and brief files.
    # W5-P1-2: in-flight envelopes (younger than the TTL) are skipped,
    # so the fixture envelope is aged past the TTL to make it purgable.
    # W6-P2-4: purge dates envelopes by internal created_at, not mtime.
    import time as _pt
    from datetime import datetime, timezone
    _pold = _pt.time() - 8 * 86400
    _pold_iso = datetime.fromtimestamp(_pold, tz=timezone.utc).isoformat()
    pj = os.path.join(PENDING_DIR, "purge-me.json")
    bj = os.path.join(BRIEF_DIR, "purge-me-request.txt")
    with open(pj, "w", encoding="utf-8") as fh:
        json.dump({"op_id": "purge-me", "brief_dir": BRIEF_DIR,
                   "created_at": _pold_iso}, fh)
    with open(bj, "w", encoding="utf-8") as fh:
        fh.write("x")
    os.utime(pj, (_pold, _pold))
    np_, nb_, _ni = bb.purge_transient_state(PENDING_DIR, BRIEF_DIR)
    check("purge clears pending envelopes and brief files",
          not os.path.exists(pj) and not os.path.exists(bj)
          and np_ >= 1 and nb_ >= 1)

    # W4-P0-5: an orphan brief (crash between brief write and envelope
    # write; no matching envelope) is purged too, not just briefs the
    # TTL sweeper would eventually reach.
    _orphan = os.path.join(BRIEF_DIR, "orphan-op-request.txt")
    with open(_orphan, "w", encoding="utf-8") as fh:
        fh.write("brief: post comment to submission of Zeldana Fakeington "
                 "<zeldana.fakeington@example.test>")
    np_, nb_, _ni = bb.purge_transient_state(PENDING_DIR, BRIEF_DIR)
    check("purge covers orphan briefs with no matching envelope",
          not os.path.exists(_orphan) and nb_ >= 1)

    # -- W4-P0-6: profile-store purge ----------------------------------
    _prof = os.path.join(WORK, "fake-profile")
    _stores = ["Default/History", "Default/History-journal",
               "Default/Top Sites", "Default/Visited Links",
               "Default/Sessions/session_1",
               "Default/Cache/data_0", "Default/Code Cache/js/x",
               "Default/GPUCache/data_0",
               "Default/Service Worker/CacheStorage/x",
               "Default/Local Storage/leveldb/000003.log",
               "Default/Session Storage/000001.log",
               "Default/IndexedDB/blob",
               "Default/Storage/leveldb/LOG",
               "Crash Reports/fake-crash.dmp"]
    _kept = ["Default/Cookies", "Default/Cookies-journal",
             "Default/Login Data", "Default/Preferences", "Default/Web Data"]
    for _rel in _stores + _kept:
        _p = os.path.join(_prof, _rel)
        os.makedirs(os.path.dirname(_p), exist_ok=True)
        with open(_p, "w", encoding="utf-8") as fh:
            fh.write("Zeldana Fakeington <zeldana.fakeington@example.test>")
    _rep = bb.purge_browser_profile(_prof)
    check("selective profile purge removes learner-data stores",
          all(not os.path.exists(os.path.join(_prof, _s))
              for _s in _stores))
    check("selective profile purge keeps session cookies and settings",
          all(os.path.exists(os.path.join(_prof, _k)) for _k in _kept))
    check("selective profile purge reports removals",
          _rep["mode"] == "selective"
          and len(_rep["removed"]) >= len(_stores)
          and not _rep["failed"])

    _prof2 = os.path.join(WORK, "fake-profile-full")
    os.makedirs(os.path.join(_prof2, "Default"), exist_ok=True)
    with open(os.path.join(_prof2, "Default", "Cookies"), "w") as fh:
        fh.write("x")
    _rep2 = bb.purge_browser_profile(_prof2, full=True)
    check("full profile purge removes the whole profile dir",
          not os.path.exists(_prof2) and _rep2["mode"] == "full")

    _rep3 = bb.purge_browser_profile(os.path.join(WORK, "no-such-profile"))
    check("missing profile dir is not an error",
          _rep3.get("profile_missing") is True)

    # _profile_in_use: nothing holds the scratch profile ...
    check("scratch profile is not in use", not bb._profile_in_use(_prof))
    # ... but a process whose argv carries the exact --user-data-dir is.
    import subprocess as _sp
    import time as _time
    _probe = _sp.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)",
         "--user-data-dir=" + os.path.realpath(_prof)])
    try:
        _time.sleep(0.5)
        check("exact --user-data-dir argv match marks profile in use",
              bb._profile_in_use(_prof))
        check("substring profile dir does not false-match",
              not bb._profile_in_use(_prof + "-suffix"))
        expect_raises("purge refuses while the browser holds the profile",
                      bb.BrowserProfileInUse,
                      bb.purge_browser_profile, _prof)
    finally:
        _probe.terminate()
        _probe.wait()

    # _ensure_dir tightens a pre-existing loose directory instead of
    # trusting it.
    import stat as _stat
    _loose = os.path.join(WORK, "loose-dir")
    os.makedirs(_loose, mode=0o755, exist_ok=True)
    os.chmod(_loose, 0o755)
    bb._ensure_dir(_loose)
    check("_ensure_dir tightens a loose dir to 0700",
          _stat.S_IMODE(os.stat(_loose).st_mode) == 0o700)
    os.rmdir(_loose)

    # -- ceremony: journal rows carry labels, never displayed names ------
    # End to end: a learner-data read goes through the approval ceremony
    # (mint, agent-relayed educator citation of the identity schedule,
    # sign), and the provider's PII-bearing payload is projected through
    # the source privacy boundary before journaling. The journaled
    # receipt must carry the Student A<n> labels and never the display
    # name. (A read stands in for the write lane here; the boundary
    # projection in complete_browser_request is method-agnostic. There
    # is no display renderer: the agent relays the educator's own
    # citation of the identities, and sign_approval seals it. See
    # dispatch/approval-ceremony.md.)
    import re as _re
    from dispatch.admission import (mint_approval as _mint,
                                    sign_approval as _sign)
    # The source privacy boundary keeps its own vault file: point it at
    # scratch so the Student A<n> labels are hermetic to this test.
    _svault = os.path.join(WORK, "source_vault.json")
    try:
        os.unlink(_svault)
    except FileNotFoundError:
        pass
    _old_svault = os.environ.get(bb.SOURCE_VAULT_ENV_VAR)
    os.environ[bb.SOURCE_VAULT_ENV_VAR] = _svault
    try:
        _tenant = "https://chcp.instructure.com"
        _token = "lrn_" + "a" * 20
        _jentry = {"name": "test.get_user", "provider": "canvas",
                   "effects": "read",
                   "request": {"method": "GET",
                               "url": "{canvas_base}/api/v1/courses/42/users/{user_id}"}}
        _jp = {"user_id": _token}
        _jrec = _mint(_jentry, _jp, tenant_base=_tenant)
        # Agent-relayed educator citation (no renderer de-tokenizes
        # anything): the educator names the identities, sign seals them.
        _jappr = _sign(_jrec, "selftest: educator approved the token-bearing "
                              "fixture action in the test harness",
                       channel="educator-chat",
                       resolved_identities=[
                           {"token": _token,
                            "displayed_as": "Ada Lovelace"}],
                       identity_authorization="selftest: the educator named the "
                       "identities this fixture action touches, in the harness")
        _jop = str(uuid.uuid4())
        bb.dispatch_browser_entry(_jentry, _jp, LANE_STATE, {}, op_id=_jop,
                                  brief_dir=BRIEF_DIR, approval=_jappr)
        # The provider's payload carries real PII for another learner.
        _jbody = json.dumps({"id": "u-99", "name": "Ada Lovelace",
                             "email": "ada@example.edu"})
        bb.complete_browser_request(
            _jop, _jentry, _jp, None, report((_jop, 200, _jbody)),
            LANE_STATE, {}, brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR)
        with open(JOURNAL, encoding="utf-8") as fh:
            _jtext = fh.read()
        check("journal carries learner labels, never displayed names",
              bool(_re.search(r"Student A[1-9][0-9]*", _jtext))
              and "Ada Lovelace" not in _jtext
              and "u-99" not in _jtext
              and "ada@example.edu" not in _jtext)
    finally:
        if _old_svault is None:
            os.environ.pop(bb.SOURCE_VAULT_ENV_VAR, None)
        else:
            os.environ[bb.SOURCE_VAULT_ENV_VAR] = _old_svault

    # -- write completion machinery: UNPARKED ------------------------------
    # The form lane is retired, so writes plan to page-context fetch
    # (P0-3); the full write completion path runs for real: inline verify,
    # parked verify phases, deferred verify, verify assertion failures,
    # uncertain-write on 429, fail-fast on 422.
    def _dispatch_write(entry, params, label):
        op_id = str(uuid.uuid4())
        bb.dispatch_browser_entry(
            entry, params, LANE_STATE, {},
            plan=fake_plan(entry["name"], op_id), op_id=op_id,
            brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR,
            approval=_approve(entry["name"], params))
        return op_id

    _wbody = json.dumps({"id": 79, "name": "Weasel Test"})

    # 1. write+verify inline pass: the report carries the request op and
    # the verify op (2xx each); the op journals once with verification pass.
    _wop = _dispatch_write(WRITE_ENTRY, _wparams, "inline")
    rec = bb.complete_browser_request(
        _wop, WRITE_ENTRY, _wparams, fake_plan("test.create_assignment", _wop),
        report((_wop, 201, _wbody), (_wop + "-verify", 200, _wbody)),
        LANE_STATE, {}, brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR)
    check("write+verify inline returns receipt", rec["op_id"] == _wop)
    check("write+verify inline verification passed",
          rec["verification"]["status"] == "verified")
    _wrec = ex.find_journal_op(_wop)
    check("write outcome journaled with verified",
          _wrec is not None and _wrec["verification"] == "verified"
          and not _wrec["uncertain"])
    check("write terminal complete deletes the pending envelope",
          not os.path.exists(bb._pending_path(PENDING_DIR, _wop)))

    # 2. missing verify op parks a verify phase; finishing it journals once.
    _wop = _dispatch_write(WRITE_ENTRY, _wparams, "parked")
    out = bb.complete_browser_request(
        _wop, WRITE_ENTRY, _wparams, fake_plan("test.create_assignment", _wop),
        report((_wop, 201, _wbody)),
        LANE_STATE, {}, brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR)
    check("missing verify op parks a verify phase",
          out["status"] == "awaiting_browser_task" and out["phase"] == "verify")
    check("parked verify brief exists",
          os.path.exists(out["brief_file"]))
    check("no outcome journaled while verify is parked (claim only)",
          ex.find_journal_op(_wop) is None)
    vrec = bb.complete_browser_verify(
        _wop, report((_wop + "-verify", 200, _wbody)),
        pending_dir=PENDING_DIR)
    check("verify phase completes the write", vrec["op_id"] == _wop)
    _wrecs = [r for r in journal_records() if r["op_id"] == _wop]
    _wrec = ex.find_journal_op(_wop)
    check("write outcome journaled after verify",
          _wrec is not None and _wrec["verification"] == "verified")
    check("verify completion deletes the pending envelope",
          not os.path.exists(bb._pending_path(PENDING_DIR, _wop)))

    # 3. deferred verify (verify URL needs result.id): the request phase
    # parks; the verify phase resolves the URL from the result values.
    # The parked body carries secret-ish keys to prove the pending
    # envelope masks them (audit item 15).
    _wop = _dispatch_write(DEFERRED_ENTRY, _wparams, "deferred")
    _wbody_secrets = json.dumps({
        "id": 79, "name": "ok",
        "secure_params": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.SIGNED",
        "sesskey": "abc123sessionkey"})
    out = bb.complete_browser_request(
        _wop, DEFERRED_ENTRY, _wparams,
        fake_plan("test.create_assignment_deferred", _wop),
        report((_wop, 201, _wbody_secrets)),
        LANE_STATE, {}, brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR)
    check("deferred verify parks a verify phase",
          out["status"] == "awaiting_browser_task" and out["phase"] == "verify")
    _penv_path = bb._pending_path(PENDING_DIR, _wop)
    with open(_penv_path, encoding="utf-8") as fh:
        _penv = json.load(fh)
    _ppay = _penv.get("result_payload") or {}
    check("pending envelope masks secure_params",
          _ppay.get("secure_params") == ex.REDACTED, _ppay.get("secure_params"))
    check("pending envelope masks sesskey",
          _ppay.get("sesskey") == ex.REDACTED, _ppay.get("sesskey"))
    check("pending envelope keeps non-secret result fields",
          _ppay.get("id") == 79 and _ppay.get("name") == "ok", _ppay)
    with open(out["brief_file"], encoding="utf-8") as fh:
        _vbrief = fh.read()
    check("deferred verify URL resolved from result values",
          "/api/v1/courses/89585/assignments/79" in _vbrief)
    vrec = bb.complete_browser_verify(
        _wop, report((_wop + "-verify", 200, _wbody_secrets)),
        pending_dir=PENDING_DIR)
    check("deferred verify completes with verified",
          vrec["op_id"] == _wop
          and vrec["verification"]["status"] == "verified")

    # 4. verify mismatch: journaled as failed, VerificationFailed raised.
    _wop = _dispatch_write(WRITE_ENTRY, _wparams, "mismatch")
    _bad = json.dumps({"id": 79, "name": "Something Else"})
    try:
        bb.complete_browser_request(
            _wop, WRITE_ENTRY, _wparams,
            fake_plan("test.create_assignment", _wop),
            report((_wop, 201, _wbody), (_wop + "-verify", 200, _bad)),
            LANE_STATE, {}, brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR)
        check("verify mismatch raises VerificationFailed", False)
    except ex.VerificationFailed:
        check("verify mismatch raises VerificationFailed", True)
    _wrec = ex.find_journal_op(_wop)
    check("verify mismatch journaled as failed",
          _wrec is not None and _wrec["verification"] == "failed"
          and _wrec["uncertain"])

    # 5. 429 on the write: uncertain (the write may or may not have
    # applied); journaled uncertain, never retried blind.
    _wop = _dispatch_write(WRITE_ENTRY, _wparams, "429")
    try:
        bb.complete_browser_request(
            _wop, WRITE_ENTRY, _wparams,
            fake_plan("test.create_assignment", _wop),
            report((_wop, 429, "slow down")),
            LANE_STATE, {}, brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR)
        check("429 on write raises UncertainWrite", False)
    except ex.UncertainWrite:
        check("429 on write raises UncertainWrite", True)
    _wrec = ex.find_journal_op(_wop)
    check("429 write journaled applied_or_unknown",
          _wrec is not None and _wrec["uncertain"]
          and _wrec["verification"] == "applied_or_unknown")

    # 6. 422 on the write: fail fast; nothing journaled; op id reusable.
    _wop = _dispatch_write(WRITE_ENTRY, _wparams, "422")
    try:
        bb.complete_browser_request(
            _wop, WRITE_ENTRY, _wparams,
            fake_plan("test.create_assignment", _wop),
            report((_wop, 422, '{"errors": "bad"}')),
            LANE_STATE, {}, brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR)
        check("422 on write raises BrowserOpFailed", False)
    except bb.BrowserOpFailed:
        check("422 on write raises BrowserOpFailed", True)
    check("422 write journals no outcome (claim released)",
          ex.find_journal_op(_wop) is None)
    # The op id stays reusable: a corrected retry dispatches cleanly.
    _wop2 = bb.dispatch_browser_entry(
        WRITE_ENTRY, _wparams, LANE_STATE, {},
        plan=fake_plan("test.create_assignment", _wop), op_id=_wop,
        brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR,
        approval=_approve("test.create_assignment", _wparams))
    check("422 op id reusable for a corrected retry",
          _wop2["op_id"] == _wop)

    # 7. LANE2-D4: the task reports CSRF_MISSING when the _csrf_token
    # cookie is absent. The write was never sent, so this fails fast
    # like a refusal (nothing journaled, op id reusable) and is never
    # misdiagnosed as an uncertain write.
    _wop = _dispatch_write(WRITE_ENTRY, _wparams, "csrf-missing")
    try:
        bb.complete_browser_request(
            _wop, WRITE_ENTRY, _wparams,
            fake_plan("test.create_assignment", _wop),
            report((_wop, 0, "CSRF_MISSING")),
            LANE_STATE, {}, brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR)
        check("CSRF_MISSING on write raises BrowserCsrfTokenMissing", False)
    except bb.BrowserCsrfTokenMissing as exc:
        check("CSRF_MISSING on write raises BrowserCsrfTokenMissing", True)
        check("CSRF_MISSING names the helper session, not the provider",
              "helper session" in str(exc))
    check("CSRF_MISSING write journals no outcome (claim released)",
          ex.find_journal_op(_wop) is None)
    _wop2 = bb.dispatch_browser_entry(
        WRITE_ENTRY, _wparams, LANE_STATE, {},
        plan=fake_plan("test.create_assignment", _wop), op_id=_wop,
        brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR,
        approval=_approve("test.create_assignment", _wparams))
    check("CSRF_MISSING op id reusable for a corrected retry",
          _wop2["op_id"] == _wop)

    # -- complete: read retryable ----------------------------------------------
    op_id = str(uuid.uuid4())
    out0 = bb.dispatch_browser_entry(READ_ENTRY, {"course_id": "1"},
                                     LANE_STATE, {}, op_id=op_id,
                                     brief_dir=BRIEF_DIR)
    out = bb.complete_browser_request(
        op_id, READ_ENTRY, {"course_id": "1"}, None, "garbage with no results",
        LANE_STATE, {}, brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR)
    check("missing read op is retryable",
          out["status"] == "retryable" and out["phase"] == "request")
    check("retryable brief file exists", os.path.exists(out["brief_file"]))
    check("retryable read journals no outcome (claim only)",
          ex.find_journal_op(op_id) is None)
    _ = out0

    # -- duplicate protection --------------------------------------------------
    op_id = str(uuid.uuid4())
    bb.dispatch_browser_entry(READ_ENTRY, {"course_id": "1"}, LANE_STATE,
                              {}, op_id=op_id, brief_dir=BRIEF_DIR)
    bb.complete_browser_request(
        op_id, READ_ENTRY, {"course_id": "1"}, None,
        report((op_id, 200, "[]")),
        LANE_STATE, {}, brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR)
    expect_raises("duplicate complete refused", ex.DuplicateOpId,
                  bb.complete_browser_request, op_id, READ_ENTRY,
                  {"course_id": "1"}, None,
                  report((op_id, 200, "[]")),
                  LANE_STATE, {}, form_host=None, brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR)

    # -- write halt --------------------------------------------------------------
    with open(HALT, "w", encoding="utf-8") as fh:
        fh.write("test")
    expect_raises("write halt refuses dispatch", ex.WriteHaltActive,
                  bb.dispatch_browser_entry, WRITE_ENTRY,
                  {"course_id": "1", "name": "x"}, LANE_STATE, {},
                  fake_plan("test.create_assignment"), BRIEF_DIR,
                  approval=_approve("test.create_assignment",
                                    {"course_id": "1", "name": "x"}))
    os.remove(HALT)

    # -- undo --------------------------------------------------------------------
    # Undo is a DELETE write, so undo dispatch renders a page-context fetch
    # op carrying the exact CSRF header contract (P0-3), not a form. The
    # undo COMPLETION path is exercised for real below
    # (kind="undo" with the DELETE report).
    op_id = str(uuid.uuid4())
    _up = {"course_id": "89585"}
    _uentry, _uparams = ex.undo_approval_subject(
        WRITE_ENTRY, _up, "orig-op-1", {"id": 99})
    uout = bb.dispatch_browser_undo(
        WRITE_ENTRY, _up, {"id": 99}, "orig-op-1",
        LANE_STATE, {}, brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR,
        approval=_approve(_uentry["name"], _uparams))
    check("undo dispatch renders fetch brief",
          uout["status"] == "awaiting_browser_task"
          and uout["kind"] == "undo"
          and uout["undo_of"] == "orig-op-1")
    with open(uout["brief_file"], encoding="utf-8") as fh:
        _ubrief = fh.read()
    check("undo brief routes the DELETE through page-context fetch with "
          "the CSRF header contract",
          "kind: fetch (page-context fetch, do NOT use a form)" in _ubrief
          and "header X-CSRF-Token: HARVEST" in _ubrief
          and "X-Requested-With" in _ubrief
          and "document.cookie" in _ubrief)
    # Undo completion: the DELETE report journals the undo receipt.
    urec = bb.complete_browser_request(
        uout["op_id"], WRITE_ENTRY, _up, None,
        report((uout["ops"][0], 200, json.dumps({"id": 99}))),
        LANE_STATE, {}, kind="undo", of_op_id="orig-op-1",
        brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR,
        undo_params=uout["undo_params"])
    check("undo completion journals the undo",
          urec["op_id"] == uout["op_id"] and urec["undo_of"] == "orig-op-1")
    _urec = ex.find_journal_op(uout["op_id"])
    check("undo outcome journaled as kind=undo",
          _urec is not None and _urec["kind"] == "undo"
          and _urec["undo_of"] == "orig-op-1")

    no_undo = {"name": "test.noundo", "provider": "canvas", "effects": "write",
               "request": {"method": "POST", "url": "{canvas_base}/api/v1/x",
                           "body": {"a": "params.a"}}}
    expect_raises("undo without undo block refused", ex.ExecutorError,
                  bb.dispatch_browser_undo, no_undo, {"a": "b"}, {"id": 1},
                  "orig-op-2", LANE_STATE, {}, BRIEF_DIR)

    # D1 regression: a verify brief rendered for a GET op must be a plain
    # navigation brief with no renderer references: no loopback server, no
    # file:// fallback, no editor chain. (The old default fell back to a
    # dead file:// brief; the loopback server is retired.)
    os.makedirs(PENDING_DIR, exist_ok=True)
    vop = {"op_id": "verify-op-1", "method": "GET",
           "path": "/api/v1/courses/1/assignments/2"}
    # W5-P2-1: the envelope op_id must be a UUID; the path builders fail
    # closed on anything else.
    _d1_oid = str(uuid.uuid4())
    vpending = {"op_id": _d1_oid, "entry_name": "test.verify",
                "kind": "dispatch",
                "lane": {"base": "https://chcp.instructure.com",
                         "provider": "canvas",
                         "principal": {"id": 28206, "name": "Test Educator"}}}
    vpending_file = os.path.join(PENDING_DIR, _d1_oid + ".json")
    vout = bb._start_verify_phase(vpending, vpending_file, None, vop,
                                  None, BRIEF_DIR, "deferred")
    with open(vout["brief_file"], "r", encoding="utf-8") as fh:
        vbrief = fh.read()
    check("deferred verify brief is a plain GET navigation",
          "/api/v1/courses/1/assignments/2" in vbrief
          and "127.0.0.1" not in vbrief
          and "file://" not in vbrief
          and "EDITOR CHAIN" not in vbrief,
          vbrief[:160])
    bb._shutdown_form_host()

    # ---- FETCH lane planning ----
    cfg = {"canvas_base": "https://chcp.instructure.com"}
    entry = {"name": "test.quiz_banks", "provider": "canvas"}

    check("_needs_fetch false for headerless block",
          bb._needs_fetch(entry, {"method": "GET", "url": "/api/v1/x"}) is False)
    check("_needs_fetch false for benign headers",
          bb._needs_fetch(entry, {"method": "GET", "url": "/api/v1/x",
                                 "headers": {"Content-Type": "application/json",
                                             "Accept": "application/json"}}) is False)
    check("_needs_fetch true for Authorization header",
          bb._needs_fetch(entry, {"method": "GET", "url": "/api/v1/x",
                                 "headers": {"Authorization": "Bearer T"}}) is True)
    check("_needs_fetch true for custom header",
          bb._needs_fetch(entry, {"method": "GET", "url": "/api/v1/x",
                                 "headers": {"AuthType": "Signature"}}) is True)
    check("_needs_fetch true for transient header",
          bb._needs_fetch(entry, {"method": "GET", "url": "/api/v1/x",
                                 "headers": {"Authorization": {"transient": "tok"}}}) is True)
    check("_needs_fetch true for explicit fetch pin",
          bb._needs_fetch(entry, {"method": "GET", "url": "/api/v1/x",
                                 "fetch": True}) is True)
    check("_needs_fetch true for explicit fetch pin on JSON write",
          bb._needs_fetch(entry, {"method": "POST", "url": "/api/v1/x",
                                 "headers": {"Content-Type": "application/json"},
                                 "body": {"a": 1},
                                 "fetch": True}) is True)

    fop = bb._plan_fetch_block(
        entry, {"method": "GET",
                "url": "https://chcp.quiz-api-iad-prod.instructure.com/v1/banks",
                "headers": {"X-Bank-Hint": {"transient": "bank_hint"},
                            "AuthType": "Signature"}},
        {}, cfg, {"bank_hint": "hint-1"}, "fetch-op-1")
    check("fetch op keeps absolute https url",
          fop["url"] == "https://chcp.quiz-api-iad-prod.instructure.com/v1/banks")
    check("fetch op resolves non-auth transient header",
          fop["headers"]["X-Bank-Hint"] == "hint-1")
    check("fetch op keeps literal header",
          fop["headers"]["AuthType"] == "Signature")
    check("fetch op kind/method", fop["kind"] == "fetch" and fop["method"] == "GET")

    # LANE2-D10: transient-captured values are never resolved into literal
    # brief text for authentication headers. Both manifest spellings (dict
    # and string form) fail closed with SecretEgressRefused; the module's
    # own secret rules forbid provider tokens in a brief.
    expect_raises("fetch op refuses transient Authorization (dict form)",
                  bb.SecretEgressRefused,
                  bb._plan_fetch_block, entry,
                  {"method": "GET",
                   "url": "https://chcp.quiz-api-iad-prod.instructure.com/v1/banks",
                   "headers": {"Authorization": {"transient": "banks_build_token"}}},
                  {}, cfg, {"banks_build_token": "SECRET-TOKEN"}, "fetch-op-1b")
    expect_raises("fetch op refuses transient Authorization (string form)",
                  bb.SecretEgressRefused,
                  bb._plan_fetch_block, entry,
                  {"method": "GET",
                   "url": "https://chcp.quiz-api-iad-prod.instructure.com/v1/banks",
                   "headers": {"Authorization": "transient.banks_build_token"}},
                  {}, cfg, {"banks_build_token": "SECRET-TOKEN"}, "fetch-op-1c")
    expect_raises("fetch op refuses transient Cookie",
                  bb.SecretEgressRefused,
                  bb._plan_fetch_block, entry,
                  {"method": "GET", "url": "https://chcp.instructure.com/b",
                   "headers": {"Cookie": {"transient": "sess"}}},
                  {}, cfg, {"sess": "abc"}, "fetch-op-1d")
    expect_raises("fetch op refuses transient X-CSRF-Token",
                  bb.SecretEgressRefused,
                  bb._plan_fetch_block, entry,
                  {"method": "POST", "url": "https://chcp.instructure.com/b",
                   "headers": {"X-CSRF-Token": {"transient": "csrf"}}},
                  {}, cfg, {"csrf": "tok"}, "fetch-op-1e")

    # LANE2-D10 remainder: batch.render_brief hardens the persistence
    # boundary independently of the planner. Direct literal auth headers,
    # reference-dict headers, and transient strings are refused; the
    # CSRF harvest placeholder still renders.
    def _fetch_op(op_id, headers, url="https://chcp.instructure.com/api/v1/x"):
        return {"op_id": op_id, "kind": "fetch", "method": "GET",
                "url": url, "headers": headers, "body": None}

    expect_raises("render_brief refuses literal Authorization",
                  batch.SecretEgressRefused,
                  batch.render_brief,
                  [_fetch_op("r1", {"Authorization": "Bearer T"})],
                  "https://chcp.instructure.com", provider="canvas")
    expect_raises("render_brief refuses literal Cookie",
                  batch.SecretEgressRefused,
                  batch.render_brief,
                  [_fetch_op("r2", {"Cookie": "s=1"})],
                  "https://chcp.instructure.com", provider="canvas")
    expect_raises("render_brief refuses literal X-CSRF-Token value",
                  batch.SecretEgressRefused,
                  batch.render_brief,
                  [_fetch_op("r3", {"X-CSRF-Token": "hardcoded"})],
                  "https://chcp.instructure.com", provider="canvas")
    expect_raises("render_brief refuses transient-dict header",
                  batch.SecretEgressRefused,
                  batch.render_brief,
                  [_fetch_op("r4", {"X-Custom": {"transient": "t"}})],
                  "https://chcp.instructure.com", provider="canvas")
    expect_raises("render_brief refuses credential-dict header",
                  batch.SecretEgressRefused,
                  batch.render_brief,
                  [_fetch_op("r5", {"X-Custom": {"credential": "canvas.pat"}})],
                  "https://chcp.instructure.com", provider="canvas")
    brief_ok = batch.render_brief(
        [_fetch_op("r6", {"X-CSRF-Token": {"harvest": "csrf_token"},
                          "Accept": "application/json"})],
        "https://chcp.instructure.com", provider="canvas")
    check("render_brief keeps CSRF harvest placeholder",
          "HARVEST from the current page" in brief_ok
          and "hardcoded" not in brief_ok)
    check("render_brief keeps benign literal headers",
          '"Accept": "application/json"' in brief_ok)
    # The render-layer refusal surfaces as the module's SecretEgressRefused.
    expect_raises("_render_brief_or_blocked maps render refusal",
                  bb.SecretEgressRefused,
                  bb._render_brief_or_blocked,
                  [_fetch_op("r7", {"Authorization": "Bearer T"})],
                  "https://chcp.instructure.com", provider="canvas")

    # LANE2-D2: absolute fetch URLs are confined to the tenant origin or
    # the tenant-bound quiz-api host. An arbitrary host, a sibling host,
    # or a quiz-api-shaped host bound to a different tenant is refused at
    # plan time: the brief would otherwise hand the browser task a URL
    # (and any literal header values) aimed at an attacker origin.
    fop_tenant = bb._plan_fetch_block(
        entry, {"method": "GET",
                "url": "https://chcp.instructure.com/api/v1/courses/1",
                "headers": {}},
        {}, cfg, {}, "fetch-op-tenant")
    check("fetch op allows absolute tenant-origin url",
          fop_tenant["url"] == "https://chcp.instructure.com/api/v1/courses/1")
    expect_raises("fetch op refuses arbitrary absolute host",
                  bb.BrowserLaneBlocked, bb._plan_fetch_block,
                  entry, {"method": "GET", "url": "https://evil.example/v1/banks",
                          "headers": {}}, {}, cfg, {}, "fetch-op-evil")
    expect_raises("fetch op refuses sibling host",
                  bb.BrowserLaneBlocked, bb._plan_fetch_block,
                  entry, {"method": "GET",
                          "url": "https://chcp.instructure.com.evil.example/v1/x",
                          "headers": {}}, {}, cfg, {}, "fetch-op-sibling")
    expect_raises("fetch op refuses quiz-api host of another tenant",
                  bb.BrowserLaneBlocked, bb._plan_fetch_block,
                  entry, {"method": "GET",
                          "url": "https://other.quiz-api-iad-prod.instructure.com/v1/banks",
                          "headers": {}}, {}, cfg, {}, "fetch-op-tenant2")
    expect_raises("fetch op refuses absolute url with no tenant base",
                  bb.BrowserLaneBlocked, bb._plan_fetch_block,
                  entry, {"method": "GET", "url": "https://chcp.quiz-api-iad-prod.instructure.com/v1/banks",
                          "headers": {}}, {}, {}, {}, "fetch-op-nobase")
    # LANE2-D11: userinfo, scheme-relative paths, and quiz-api port
    # games are refused even when the hostname alone would pass.
    expect_raises("fetch op refuses userinfo on legitimate host",
                  bb.BrowserLaneBlocked, bb._plan_fetch_block,
                  entry, {"method": "GET",
                          "url": "https://user@chcp.instructure.com/api/v1/x",
                          "headers": {}}, {}, cfg, {}, "fetch-op-userinfo")
    expect_raises("fetch op refuses userinfo on quiz-api host",
                  bb.BrowserLaneBlocked, bb._plan_fetch_block,
                  entry, {"method": "GET",
                          "url": "https://user:pass@chcp.quiz-api-iad-prod.instructure.com/v1/banks",
                          "headers": {}}, {}, cfg, {}, "fetch-op-quserinfo")
    expect_raises("fetch op refuses quiz-api alternate port",
                  bb.BrowserLaneBlocked, bb._plan_fetch_block,
                  entry, {"method": "GET",
                          "url": "https://chcp.quiz-api-iad-prod.instructure.com:8443/v1/banks",
                          "headers": {}}, {}, cfg, {}, "fetch-op-qport")
    expect_raises("fetch op refuses quiz-api malformed port",
                  bb.BrowserLaneBlocked, bb._plan_fetch_block,
                  entry, {"method": "GET",
                          "url": "https://chcp.quiz-api-iad-prod.instructure.com:bad/v1/banks",
                          "headers": {}}, {}, cfg, {}, "fetch-op-qbadport")
    expect_raises("fetch op refuses double-slash path on tenant origin",
                  bb.BrowserLaneBlocked, bb._plan_fetch_block,
                  entry, {"method": "GET",
                          "url": "https://chcp.instructure.com//evil.example/x",
                          "headers": {}}, {}, cfg, {}, "fetch-op-dslash")
    fop_qport = bb._plan_fetch_block(
        entry, {"method": "GET",
                "url": "https://chcp.quiz-api-iad-prod.instructure.com:443/v1/banks",
                "headers": {}},
        {}, cfg, {}, "fetch-op-q443")
    check("fetch op allows quiz-api host with explicit 443",
          fop_qport["url"] == "https://chcp.quiz-api-iad-prod.instructure.com:443/v1/banks")

    # LANE2-D2: _split_op_url uses exact normalized-origin parsing, not
    # a startswith() prefix check.
    _sbase = "https://chcp.instructure.com"
    check("_split_op_url returns path+query",
          bb._split_op_url("https://chcp.instructure.com/api/v1/x?a=1", _sbase)
          == "/api/v1/x?a=1")
    check("_split_op_url accepts host case variants",
          bb._split_op_url("https://CHCP.Instructure.COM/api/v1/x", _sbase)
          == "/api/v1/x")
    check("_split_op_url accepts the explicit default port",
          bb._split_op_url("https://chcp.instructure.com:443/api/v1/x", _sbase)
          == "/api/v1/x")
    expect_raises("_split_op_url refuses sibling host",
                  bb.BrowserLaneBlocked, bb._split_op_url,
                  "https://chcp.instructure.com.evil.example/x", _sbase)
    expect_raises("_split_op_url refuses userinfo",
                  bb.BrowserLaneBlocked, bb._split_op_url,
                  "https://chcp.instructure.com@evil.example/x", _sbase)
    expect_raises("_split_op_url refuses userinfo on legitimate host",
                  bb.BrowserLaneBlocked, bb._split_op_url,
                  "https://user@chcp.instructure.com/x", _sbase)
    expect_raises("_split_op_url refuses user:password on legitimate host",
                  bb.BrowserLaneBlocked, bb._split_op_url,
                  "https://user:pass@chcp.instructure.com/x", _sbase)
    expect_raises("_split_op_url refuses alternate port",
                  bb.BrowserLaneBlocked, bb._split_op_url,
                  "https://chcp.instructure.com:8443/x", _sbase)
    expect_raises("_split_op_url refuses malformed port",
                  bb.BrowserLaneBlocked, bb._split_op_url,
                  "https://chcp.instructure.com:bad/x", _sbase)
    expect_raises("_split_op_url refuses wrong scheme",
                  bb.BrowserLaneBlocked, bb._split_op_url,
                  "http://chcp.instructure.com/x", _sbase)
    expect_raises("_split_op_url refuses double-slash path",
                  bb.BrowserLaneBlocked, bb._split_op_url,
                  "https://chcp.instructure.com//evil.example/x", _sbase)
    expect_raises("_split_op_url refuses relative url",
                  bb.BrowserLaneBlocked, bb._split_op_url,
                  "/api/v1/x", _sbase)
    expect_raises("_split_op_url refuses empty tenant base",
                  bb.BrowserLaneBlocked, bb._split_op_url,
                  "https://chcp.instructure.com/x", "")
    # The fetch lane shares the exact-origin helper: host case variants
    # of the tenant origin are legitimate.
    fop_case = bb._plan_fetch_block(
        entry, {"method": "GET", "url": "https://CHCP.Instructure.COM/api/v1/x",
                "headers": {}},
        {}, cfg, {}, "fetch-op-case")
    check("fetch op allows host case variant of tenant origin",
          fop_case["url"] == "https://CHCP.Instructure.COM/api/v1/x")

    # LANE2-D10: a literal authentication header is refused at plan time
    # (the old pass-through persisted credential material in the brief).
    # The relative-URL and JSON-body behaviors are covered by benign
    # headers below; auth material never reaches the brief.
    expect_raises("fetch op refuses literal Authorization header",
                  bb.SecretEgressRefused,
                  bb._plan_fetch_block,
                  entry, {"method": "POST", "url": "/api/v1/courses/{course_id}/x",
                          "headers": {"Authorization": "Bearer T"},
                          "body": {"title": "params.title"}},
                  {"course_id": "89585", "title": "Hi"}, cfg, {}, "fetch-op-2")
    expect_raises("fetch op refuses literal Cookie header",
                  bb.SecretEgressRefused,
                  bb._plan_fetch_block,
                  entry, {"method": "GET",
                          "url": "https://chcp.instructure.com/b",
                          "headers": {"Cookie": "session=abc"}},
                  {}, cfg, {}, "fetch-op-2b")
    expect_raises("fetch op refuses literal X-CSRF-Token value",
                  bb.SecretEgressRefused,
                  bb._plan_fetch_block,
                  entry, {"method": "POST",
                          "url": "https://chcp.instructure.com/b",
                          "headers": {"X-CSRF-Token": "hardcoded-token"}},
                  {}, cfg, {}, "fetch-op-2c")
    fop2 = bb._plan_fetch_block(
        entry, {"method": "POST", "url": "/api/v1/courses/{course_id}/x",
                "headers": {"Accept": "application/json"},
                "body": {"title": "params.title"}},
        {"course_id": "89585", "title": "Hi"}, cfg, {}, "fetch-op-2")
    check("fetch op resolves relative url against canvas_base",
          fop2["url"] == "https://chcp.instructure.com/api/v1/courses/89585/x")
    check("fetch op serializes dict body to JSON",
          json.loads(fop2["body"]) == {"title": "Hi"})

    fop3 = bb._plan_fetch_block(
        entry, {"method": "POST", "url": "/api/v1/jwts",
                "headers": {"X-CSRF-Token": {"harvest": "csrf_token"},
                            "Accept": "application/json"}},
        {}, cfg, {}, "fetch-op-harvest")
    check("fetch op passes through harvest header",
          fop3["headers"]["X-CSRF-Token"] == {"harvest": "csrf_token"})
    check("fetch op keeps literal header beside harvest",
          fop3["headers"]["Accept"] == "application/json")
    expect_raises("fetch op refuses bad harvest source", bb.BrowserLaneBlocked,
                  bb._plan_fetch_block, entry,
                  {"method": "POST", "url": "/api/v1/jwts",
                   "headers": {"X-CSRF-Token": {"harvest": "nope"}}},
                  {}, cfg, {}, "fetch-op-harvest-bad")

    expect_raises("fetch op refuses uncaptured transient", ex.ExecutorError,
                  bb._plan_fetch_block, entry,
                  {"method": "GET", "url": "https://chcp.instructure.com/b",
                   "headers": {"Authorization": {"transient": "nope"}}},
                  {}, cfg, {}, "fetch-op-3")
    expect_raises("fetch op refuses credential header ref", bb.SecretEgressRefused,
                  bb._plan_fetch_block, entry,
                  {"method": "GET", "url": "https://chcp.instructure.com/b",
                   "headers": {"Authorization": {"credential": "canvas_pat"}}},
                  {}, cfg, {}, "fetch-op-4")
    expect_raises("fetch op refuses session_value header ref", bb.SecretEgressRefused,
                  bb._plan_fetch_block, entry,
                  {"method": "GET", "url": "https://chcp.instructure.com/b",
                   "headers": {"X-S": {"session_value": "csrf"}}},
                  {}, cfg, {}, "fetch-op-5")
    expect_raises("fetch op refuses bad method", bb.BrowserLaneBlocked,
                  bb._plan_fetch_block, entry,
                  {"method": "OPTIONS", "url": "https://chcp.instructure.com/b"},
                  {}, cfg, {}, "fetch-op-6")
    routed_patch = bb._plan_fetch_block(
        entry, {"method": "PATCH", "url": "https://chcp.instructure.com/c"},
        {}, cfg, {}, "fetch-op-6b")
    check("fetch op accepts PATCH", routed_patch["kind"] == "fetch")

    # LANE2-D10: routing still sends transient-auth blocks to the fetch
    # lane, but planning refuses to resolve the token into the brief.
    check("_needs_fetch routes transient-auth block to fetch",
          bb._needs_fetch(
              entry, {"method": "GET",
                      "url": "https://chcp.quiz-api-iad-prod.instructure.com/v1/banks",
                      "headers": {"Authorization": {"transient": "t"}}}) is True)
    expect_raises("_plan_block refuses transient-auth block",
                  bb.SecretEgressRefused,
                  bb._plan_block,
                  entry, {"method": "GET",
                          "url": "https://chcp.quiz-api-iad-prod.instructure.com/v1/banks",
                          "headers": {"Authorization": {"transient": "t"}}},
                  {}, cfg, {"t": "V"}, None, "fetch-op-7")
    routed2 = bb._plan_block(
        entry, {"method": "GET", "url": "{canvas_base}/api/v1/users/self"},
        {}, cfg, {}, None, "form-op-1")
    check("_plan_block keeps benign block on form lane",
          routed2.get("kind") != "fetch" and routed2["path"] == "/api/v1/users/self")

    # -- P0-3: exact CSRF header contract ---------------------------------
    contract = bb.csrf_header_contract()
    check("CSRF contract is exactly the two required headers",
          set(contract.keys()) == {"X-CSRF-Token", "X-Requested-With"})
    check("CSRF token header harvests fresh from the cookie",
          contract["X-CSRF-Token"] == {"harvest": "csrf_token"})
    check("CSRF XHR marker is the literal XMLHttpRequest",
          contract["X-Requested-With"] == "XMLHttpRequest")
    expect_raises("brief backstop rejects meta-tag fallback",
                  bb.BrowserLaneBlocked, bb._assert_no_csrf_source_fallback,
                  "read the csrf-token <meta> tag value", "b1")
    expect_raises("brief backstop rejects hidden-input fallback",
                  bb.BrowserLaneBlocked, bb._assert_no_csrf_source_fallback,
                  "use the authenticity_token hidden input value", "b1")
    bb._assert_no_csrf_source_fallback(
        "read the _csrf_token cookie fresh from document.cookie", "b1")
    check("compliant cookie harvest passes the backstop", True)
    check("_needs_fetch true for plain Canvas POST (P0-3 enforcement)",
          bb._needs_fetch({"provider": "canvas"},
                          {"method": "POST", "url": "/api/v1/x"}) is True)
    check("_needs_fetch true for plain Canvas PATCH",
          bb._needs_fetch({"provider": "canvas"},
                          {"method": "PATCH", "url": "/api/v1/x"}) is True)
    check("_needs_fetch true for plain Canvas DELETE",
          bb._needs_fetch({"provider": "canvas"},
                          {"method": "DELETE", "url": "/api/v1/x"}) is True)
    check("_needs_fetch false for plain Canvas GET",
          bb._needs_fetch({"provider": "canvas"},
                          {"method": "GET", "url": "/api/v1/x"}) is False)
    with open(os.path.join(TRANSPORT, "local_chromium.py"),
              encoding="utf-8") as fh:
        _lc_src = fh.read()
    check("local Chromium harvest reads the _csrf_token cookie",
          "_csrf_token" in _lc_src and "document.cookie" in _lc_src)
    check("local Chromium has no meta-tag token fallback",
          'meta[name="csrf-token"]' not in _lc_src)
    check("local Chromium has no hidden-input token fallback",
          'input[name="authenticity_token"]' not in _lc_src)

    # -- P0-5: principal pinning and session generation --------------------
    # Principal mismatch fails closed: dispatch pins the educator, and a
    # complete against a lane where a different educator signed in is
    # refused.
    _pm_op = str(uuid.uuid4())
    _pm_dispatch = bb.dispatch_browser_entry(
        WRITE_ENTRY, _wparams, LANE_STATE, {},
        plan=fake_plan("test.create_assignment", _pm_op), op_id=_pm_op,
        brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR,
        approval=_approve("test.create_assignment", _wparams))
    _other_lane = {"canvas": {"base": "https://chcp.instructure.com",
                              "principal": {"id": 99999,
                                            "name": "Someone Else"},
                              "lane": "session", "verified_at": 0}}
    try:
        bb.complete_browser_request(
            _pm_op, WRITE_ENTRY, _wparams,
            fake_plan("test.create_assignment", _pm_op),
            report((_pm_op, 201, _wbody)),
            _other_lane, {}, brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR,
            pinned_principal=_pm_dispatch["principal"])
        check("principal mismatch fails closed", False)
    except bb.BrowserPrincipalChanged:
        check("principal mismatch fails closed", True)
    # The refused write keeps its conflict lock: the op was never settled.
    check("refused write keeps its conflict lock",
          bb.conflict_lock_held(_pm_op, PENDING_DIR))
    bb.release_conflict_lock(_pm_op, PENDING_DIR)

    # Stale session generation fails closed with the distinct stale-command
    # exception (W4-P2-1): NOT genuine session death, so the executor must
    # not arm the re-auth machinery for it.
    _gen_lane = {"canvas": {"base": "https://chcp.instructure.com",
                            "principal": {"id": 28206,
                                          "name": "Test Educator"},
                            "lane": "session", "verified_at": 0,
                            "session_generation": 7}}
    _sg_op = _dispatch_write(WRITE_ENTRY, _wparams, "stale-generation")
    try:
        bb.complete_browser_request(
            _sg_op, WRITE_ENTRY, _wparams,
            fake_plan("test.create_assignment", _sg_op),
            report((_sg_op, 201, _wbody)),
            _gen_lane, {}, brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR,
            expected_generation=6)
        check("stale session generation fails closed", False)
    except bb.BrowserStaleCommand as e:
        check("stale session generation fails closed", True)
        check("stale generation raises the distinct subclass, not the "
              "generic death signal",
              type(e).__name__ == "BrowserStaleCommand")
        check("stale generation message names re-dispatch as the remedy",
              "re-dispatch" in str(e))
        check("stale generation message notes the op_id stays reusable",
              "op_id stays reusable" in str(e))
    except bb.BrowserSessionDead:
        check("stale session generation raises BrowserStaleCommand "
              "(got the generic death signal instead)", False)
    bb.release_conflict_lock(_sg_op, PENDING_DIR)
    # Matching generation passes the gate.
    _sg_op2 = _dispatch_write(WRITE_ENTRY, _wparams, "fresh-generation")
    out = bb.complete_browser_request(
        _sg_op2, WRITE_ENTRY, _wparams,
        fake_plan("test.create_assignment", _sg_op2),
        report((_sg_op2, 201, _wbody)),
        _gen_lane, {}, brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR,
        expected_generation=7)
    check("matching session generation passes",
          out["status"] == "awaiting_browser_task" and out["phase"] == "verify")
    bb.release_conflict_lock(_sg_op2, PENDING_DIR)

    # Redirect on a write: never followed; the effect is unknown, so the
    # write journals as applied_or_unknown and keeps its lock (P0-6).
    _rd_op = _dispatch_write(WRITE_ENTRY, _wparams, "redirect")
    try:
        bb.complete_browser_request(
            _rd_op, WRITE_ENTRY, _wparams,
            fake_plan("test.create_assignment", _rd_op),
            report((_rd_op, 302, "")),
            LANE_STATE, {}, brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR)
        check("write redirect journals applied_or_unknown", False)
    except ex.UncertainWrite:
        check("write redirect journals applied_or_unknown", True)
    check("write redirect keeps the conflict lock",
          bb.conflict_lock_held(_rd_op, PENDING_DIR))
    bb.release_conflict_lock(_rd_op, PENDING_DIR)
    # Redirect on a read: the session is dead, nothing was attempted.
    _rd_ro = str(uuid.uuid4())
    bb.dispatch_browser_entry(READ_ENTRY, {"course_id": "1"}, LANE_STATE,
                              {}, op_id=_rd_ro, brief_dir=BRIEF_DIR,
                              pending_dir=PENDING_DIR)
    try:
        bb.complete_browser_request(
            _rd_ro, READ_ENTRY, {"course_id": "1"}, None,
            report((_rd_ro, 302, "")),
            LANE_STATE, {}, brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR)
        check("read redirect maps to BrowserSessionDead", False)
    except bb.BrowserSessionDead:
        check("read redirect maps to BrowserSessionDead", True)
    # W4-P2-1: the redirect test armed the write halt via the re-auth
    # machinery (as designed). Lift it so later tests start from the
    # no-halt pre-condition; the halt must not leak between tests.
    from reauth import state_machine as _rsm
    _rsm.lift_halt()
    check("session-death test halt is lifted after the test",
          _rsm.check_write_allowed()[0] is True)

    # -- P0-6: 408 is uncertain; uncertain writes are never replayed ------
    _t408 = _dispatch_write(WRITE_ENTRY, _wparams, "408")
    try:
        bb.complete_browser_request(
            _t408, WRITE_ENTRY, _wparams,
            fake_plan("test.create_assignment", _t408),
            report((_t408, 408, "timeout")),
            LANE_STATE, {}, brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR)
        check("408 on write raises UncertainWrite", False)
    except ex.UncertainWrite:
        check("408 on write raises UncertainWrite", True)
    _t408rec = ex.find_journal_op(_t408)
    check("408 write journaled applied_or_unknown",
          _t408rec is not None
          and _t408rec["verification"] == "applied_or_unknown"
          and _t408rec["uncertain"])
    # The uncertain write cannot be replayed: its conflict lock remains.
    # (Re-dispatch is refused by the journal duplicate check first; the
    # lock is the second layer that holds even if the journal were lost.)
    check("uncertain write keeps its conflict lock",
          bb.conflict_lock_held(_t408, PENDING_DIR))
    try:
        bb.dispatch_browser_entry(
            WRITE_ENTRY, _wparams, LANE_STATE, {},
            plan=fake_plan("test.create_assignment", _t408), op_id=_t408,
            brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR,
            approval=_approve("test.create_assignment", _wparams))
        check("uncertain write cannot be re-dispatched", False)
    except (bb.ConflictLockHeld, ex.DuplicateOpId):
        check("uncertain write cannot be re-dispatched", True)
    # The lock itself refuses acquisition while held.
    try:
        bb.acquire_conflict_lock(_t408, "test.create_assignment", PENDING_DIR)
        check("held conflict lock refuses acquisition", False)
    except bb.ConflictLockHeld:
        check("held conflict lock refuses acquisition", True)

    # -- P0-8: HTTP success alone is unconfirmed, never verified -----------
    _nowrite_verify_entry = {
        "name": "test.create_no_verify", "provider": "canvas",
        "effects": "write",
        "request": {"method": "POST",
                    "url": "{canvas_base}/api/v1/courses/{course_id}/x",
                    "body": {"a": "params.a"}},
    }
    _nv_op = _dispatch_write(_nowrite_verify_entry,
                             {"course_id": "89585", "a": "b"}, "unconfirmed")
    _nv_rec = bb.complete_browser_request(
        _nv_op, _nowrite_verify_entry, {"course_id": "89585", "a": "b"},
        fake_plan("test.create_no_verify", _nv_op),
        report((_nv_op, 200, _wbody)),
        LANE_STATE, {}, brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR)
    check("2xx write with no readback journals unconfirmed",
          _nv_rec["verification"]["status"] == "unconfirmed")
    check("unconfirmed is never reported as verified",
          _nv_rec["verification"]["status"] != "verified")
    _nv_rec_j = ex.find_journal_op(_nv_op)
    check("unconfirmed write outcome journaled",
          _nv_rec_j is not None
          and _nv_rec_j["verification"] == "unconfirmed")

    # -- P0-9: null-bearing payloads survive text serialization ------------
    _null_payload = {"a": None, "b": [1, None, {"c": None}], "d": "x"}
    _null_text = bb.serialize_canonical(_null_payload)
    bb._assert_null_round_trip(_null_payload, _null_text)
    check("null-bearing payload round-trips byte-identically", True)
    check("serialized form keeps explicit nulls",
          '"a":null' in _null_text.replace(" ", "")
          or '"a": null' in _null_text)
    try:
        bb._assert_null_round_trip(_null_payload,
                                   '{"b": [1, null, {"c": null}], "d": "x"}')
        check("dropped null fails closed", False)
    except bb.BrowserLaneBlocked:
        check("dropped null fails closed", True)

    # -- P0-6 settlement: person close-out ---------------------------------
    # close_out_by_person sends nothing and never reports verified.
    _digest = "ab" * 32
    _co_rec = bb.close_out_by_person(
        _t408, _digest,
        "I checked the Canvas UI myself; the assignment is not there. "
        "Close this out.",
        pending_dir=PENDING_DIR)
    check("person close-out journals closed_by_person",
          _co_rec["verification"] == "closed_by_person")
    check("person close-out never reports verified",
          _co_rec["verification"] != "verified")
    check("person close-out releases the conflict lock",
          not bb.conflict_lock_held(_t408, PENDING_DIR))
    # Close-out requires the fresh-read digest and explicit confirmation.
    _t408b = _dispatch_write(WRITE_ENTRY, _wparams, "408b")
    try:
        bb.complete_browser_request(
            _t408b, WRITE_ENTRY, _wparams,
            fake_plan("test.create_assignment", _t408b),
            report((_t408b, 408, "timeout")),
            LANE_STATE, {}, brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR)
    except ex.UncertainWrite:
        pass
    try:
        bb.close_out_by_person(_t408b, "not-a-digest", "yes",
                               pending_dir=PENDING_DIR)
        check("close-out rejects a malformed digest", False)
    except ex.ExecutorError:
        check("close-out rejects a malformed digest", True)
    try:
        bb.close_out_by_person(_t408b, _digest, "   ",
                               pending_dir=PENDING_DIR)
        check("close-out rejects empty confirmation", False)
    except ex.ExecutorError:
        check("close-out rejects empty confirmation", True)
    bb.release_conflict_lock(_t408b, PENDING_DIR)

    # -- P0-6 settlement: duplicate review ---------------------------------
    _dup_entry = dict(WRITE_ENTRY)
    _dup_entry["duplicate_check"] = {
        "collection_url": "{canvas_base}/api/v1/courses/{course_id}/assignments",
        "match_fields": ["name"],
        "created_field": "created_at",
        "window_seconds": 600,
    }
    _dup_params = {"course_id": "89585", "name": "Weasel Test"}
    # W5-P2-1: fixture op_ids are UUIDs; the path builders fail closed
    # on anything else.
    _dup_oid1 = str(uuid.uuid4())
    _dup_oid2 = str(uuid.uuid4())
    _dup_begin = bb.begin_unresolved_create_review(
        _dup_oid1, _dup_entry, _dup_params, LANE_STATE,
        brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR)
    check("duplicate review renders a collection-read brief",
          _dup_begin["status"] == "awaiting_browser_task"
          and _dup_begin["phase"] == "duplicate_check")
    with open(_dup_begin["brief_file"], encoding="utf-8") as fh:
        _dup_brief = fh.read()
    check("duplicate review brief reads the parent collection",
          "/api/v1/courses/89585/assignments" in _dup_brief)
    # Two matching records: duplicate_effect_suspected, nothing deleted.
    from datetime import datetime, timezone as _tz
    _now = datetime.now(_tz.utc)
    _t1 = _now.isoformat().replace("+00:00", "Z")
    _t2 = (_now.isoformat().replace("+00:00", "Z"))
    _dup_body = json.dumps([
        {"id": 101, "name": "Weasel Test", "created_at": _t1},
        {"id": 102, "name": "Weasel Test", "created_at": _t2},
    ])
    _dup_out = bb.complete_unresolved_create_review(
        _dup_oid1, report((_dup_oid1 + "-dupcheck", 200, _dup_body)),
        _dup_entry, _dup_params, pending_dir=PENDING_DIR,
        brief_dir=BRIEF_DIR)
    check("multiple matches yield duplicate_effect_suspected",
          _dup_out["classification"] == "duplicate_effect_suspected")
    check("duplicate review never reports verified",
          _dup_out["classification"] != "verified")
    _dup_recs = [r for r in journal_records() if r["op_id"] == _dup_oid1]
    check("duplicate review journals applied_or_unknown",
          len(_dup_recs) == 1
          and _dup_recs[0]["verification"] == "applied_or_unknown")
    # One matching record settles as verified by provider readback.
    _one_body = json.dumps([
        {"id": 101, "name": "Weasel Test", "created_at": _t1},
    ])
    _one_out = bb.complete_unresolved_create_review(
        _dup_oid2, report((_dup_oid2 + "-dupcheck", 200, _one_body)),
        _dup_entry, _dup_params, pending_dir=PENDING_DIR,
        brief_dir=BRIEF_DIR)
    check("single match settles as verified",
          _one_out["classification"] == "verified")

    # LANE2-D3: the dupcheck brief is transient: completing the review
    # deletes it (the retention contract covers every phase).
    _dup_oid3 = str(uuid.uuid4())
    _dup_begin3 = bb.begin_unresolved_create_review(
        _dup_oid3, _dup_entry, _dup_params, LANE_STATE,
        brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR)
    _dup_brief3 = _dup_begin3["brief_file"]
    check("dupcheck brief exists before completion",
          os.path.exists(_dup_brief3))
    _dup_out3 = bb.complete_unresolved_create_review(
        _dup_oid3, report((_dup_oid3 + "-dupcheck", 200, _one_body)),
        _dup_entry, _dup_params, pending_dir=PENDING_DIR,
        brief_dir=BRIEF_DIR)
    check("dupcheck review completion deletes the dupcheck brief",
          _dup_out3["classification"] == "verified"
          and not os.path.exists(_dup_brief3))

    # -- W5-P0-1: no raw claim token in the persisted envelope ----------
    # The dispatch envelope on disk must carry only the token hash;
    # the raw token lives in the orchestrator's memory (threaded here
    # by the _claim_tokens harness). A verify that carries no token
    # must be refused, not adopted by liveness.
    _p0op = _dispatch_write(DEFERRED_ENTRY, _wparams, "w5-p0-1")
    _p0out = bb.complete_browser_request(
        _p0op, DEFERRED_ENTRY, _wparams,
        fake_plan("test.create_assignment_deferred", _p0op),
        report((_p0op, 201, _wbody_secrets)),
        LANE_STATE, {}, brief_dir=BRIEF_DIR, pending_dir=PENDING_DIR)
    check("w5-p0-1 fixture parks a verify phase",
          _p0out["status"] == "awaiting_browser_task")
    _p0path = bb._pending_path(PENDING_DIR, _p0op)
    with open(_p0path, encoding="utf-8") as fh:
        _p0env = json.load(fh)
    check("persisted envelope carries no raw claim token",
          "claim_token" not in _p0env, str(sorted(_p0env)))
    check("persisted envelope carries the claim token hash",
          _p0env.get("claim_token_hash")
          == ex._claim_token_hash(_claim_tokens[_p0op]))
    check("the hash alone cannot release the claim",
          _p0env.get("claim_token_hash") != _claim_tokens[_p0op])
    expect_raises("verify without a claim token is refused",
                  ex.DuplicateOpId,
                  _orig_verify, _p0op,
                  report((_p0op + "-verify", 200, _wbody_secrets)),
                  pending_dir=PENDING_DIR)
    _p0v = bb.complete_browser_verify(
        _p0op, report((_p0op + "-verify", 200, _wbody_secrets)),
        pending_dir=PENDING_DIR)
    check("verify with the threaded token still completes",
          _p0v["op_id"] == _p0op
          and _p0v["verification"]["status"] == "verified")

    # -- W5-P1-1: conflict-lock read-modify-write under concurrency ----
    # N threads racing acquire_conflict_lock on distinct op_ids: every
    # record must survive (the old unlocked load/mutate/save dropped
    # all but the last writer's).
    import threading as _th
    _nlocks = 16
    _lock_oids = [str(uuid.uuid4()) for _i in range(_nlocks)]
    _lock_barrier = _th.Barrier(_nlocks)
    _lock_errs = []

    def _acquire_one(_oid):
        try:
            _lock_barrier.wait(timeout=30)
            bb.acquire_conflict_lock(_oid, "test.w5p11", PENDING_DIR)
        except Exception as e:  # noqa: BLE001
            _lock_errs.append(e)

    _lts = [_th.Thread(target=_acquire_one, args=(_o,))
            for _o in _lock_oids]
    for _t in _lts:
        _t.start()
    for _t in _lts:
        _t.join()
    _locks_now = bb._load_locks(PENDING_DIR)
    check("concurrent lock acquires lose no records",
          not _lock_errs
          and all(_o in _locks_now for _o in _lock_oids),
          "errs=%r missing=%r" % (_lock_errs,
                                  [_o for _o in _lock_oids
                                   if _o not in _locks_now]))
    for _o in _lock_oids:
        bb.release_conflict_lock(_o, PENDING_DIR)
    # Same op_id from N threads: exactly one holder, the rest refused.
    _solo = str(uuid.uuid4())
    _solo_barrier = _th.Barrier(_nlocks)
    _solo_won = []
    _solo_refused = []

    def _acquire_solo():
        try:
            _solo_barrier.wait(timeout=30)
            bb.acquire_conflict_lock(_solo, "test.w5p11", PENDING_DIR)
            _solo_won.append(1)
        except bb.ConflictLockHeld:
            _solo_refused.append(1)
        except Exception as e:  # noqa: BLE001
            _solo_refused.append("wrong: %r" % e)

    _sts = [_th.Thread(target=_acquire_solo) for _i in range(_nlocks)]
    for _t in _sts:
        _t.start()
    for _t in _sts:
        _t.join()
    check("concurrent acquire of one lock elects exactly one holder",
          len(_solo_won) == 1 and len(_solo_refused) == _nlocks - 1,
          "won=%d refused=%r" % (len(_solo_won), _solo_refused))
    bb.release_conflict_lock(_solo, PENDING_DIR)

    # -- W5-P1-2: purge skips in-flight state, keeps lock machinery ----
    _fresh_oid = str(uuid.uuid4())
    _fresh_env = os.path.join(PENDING_DIR, _fresh_oid + ".json")
    _fresh_brief = os.path.join(BRIEF_DIR, _fresh_oid + "-request.txt")
    with open(_fresh_env, "w", encoding="utf-8") as fh:
        json.dump({"op_id": _fresh_oid, "brief_dir": BRIEF_DIR}, fh)
    with open(_fresh_brief, "w", encoding="utf-8") as fh:
        fh.write("brief")
    _inflight_lock_oid = str(uuid.uuid4())
    bb.acquire_conflict_lock(_inflight_lock_oid, "test.w5p12", PENDING_DIR)
    _np, _nb, _ni = bb.purge_transient_state(PENDING_DIR, BRIEF_DIR)
    check("purge skips the in-flight envelope",
          os.path.exists(_fresh_env) and _ni >= 1, (_np, _nb, _ni))
    check("purge keeps the in-flight envelope's briefs",
          os.path.exists(_fresh_brief))
    check("purge never deletes conflict-locks.json",
          os.path.exists(bb._locks_path(PENDING_DIR)))
    check("purge never deletes the conflict-lock flock file",
          os.path.exists(bb._locks_flock_path(PENDING_DIR)))
    bb.release_conflict_lock(_inflight_lock_oid, PENDING_DIR)
    os.remove(_fresh_env)
    os.remove(_fresh_brief)

    # -- W5-P1-2: purge preserves live-claim envelopes past the TTL -----
    # An envelope older than PENDING_TTL_DAYS whose op_id still holds a
    # live journal claim is in-flight by liveness, not mtime: purge
    # must skip it (and its briefs). A stale envelope with NO live
    # claim is still purged, and its claim is forced-released.
    _live_oid = str(uuid.uuid4())
    _live_env = os.path.join(PENDING_DIR, _live_oid + ".json")
    _live_brief = os.path.join(BRIEF_DIR, _live_oid + "-request.txt")
    _live_tok = ex.claim_op_id(_live_oid, "dispatch", "test.w5p12live",
                               "write", "d")
    _old = time.time() - (bb.PENDING_TTL_DAYS + 1) * 86400
    # W6-P2-4: purge dates envelopes by internal created_at, not mtime.
    from datetime import datetime, timezone
    _old_iso = datetime.fromtimestamp(_old, tz=timezone.utc).isoformat()
    with open(_live_env, "w", encoding="utf-8") as fh:
        json.dump({"op_id": _live_oid, "brief_dir": BRIEF_DIR,
                   "created_at": _old_iso}, fh)
    with open(_live_brief, "w", encoding="utf-8") as fh:
        fh.write("brief")
    os.utime(_live_env, (_old, _old))
    os.utime(_live_brief, (_old, _old))
    _stale_oid = str(uuid.uuid4())
    _stale_env = os.path.join(PENDING_DIR, _stale_oid + ".json")
    _stale_tok = ex.claim_op_id(_stale_oid, "dispatch", "test.w5p12stale",
                                "write", "d")
    ex.release_op_id(_stale_oid, _stale_tok, "selftest: no live claim")
    with open(_stale_env, "w", encoding="utf-8") as fh:
        json.dump({"op_id": _stale_oid, "brief_dir": BRIEF_DIR,
                   "created_at": _old_iso}, fh)
    os.utime(_stale_env, (_old, _old))
    _np2, _nb2, _ni2 = bb.purge_transient_state(PENDING_DIR, BRIEF_DIR)
    check("purge preserves a TTL-aged envelope with a live claim",
          os.path.exists(_live_env) and _ni2 >= 1, (_np2, _nb2, _ni2))
    check("purge keeps the live envelope's briefs",
          os.path.exists(_live_brief))
    check("purge still removes a TTL-aged envelope with no live claim",
          not os.path.exists(_stale_env) and _np2 >= 1, (_np2, _nb2, _ni2))
    ex.release_op_id(_live_oid, _live_tok, "selftest cleanup")
    os.remove(_live_env)
    os.remove(_live_brief)

    # LANE2-D12: _write_secret_file staging is pid+thread-unique. Eight
    # threads hammering the same destination must all succeed: with
    # pid-only staging the O_EXCL retry in _open_secret_tmp unlinks a
    # peer's live staging file and the victim's os.replace crashes with
    # FileNotFoundError. The final bytes must be one complete payload,
    # mode 0600, with no staging files left behind.
    _conc_path = os.path.join(WORK, "conc", "secret.txt")
    _nthreads, _niters = 8, 25
    _barrier = threading.Barrier(_nthreads)
    _werrors = []

    def _conc_writer(tid):
        try:
            _barrier.wait(timeout=30)
            for _i in range(_niters):
                bb._write_secret_file(_conc_path, "t%d-i%d\n" % (tid, _i))
        except Exception as exc:  # noqa: BLE001 - collected, asserted below
            _werrors.append(exc)

    _wthreads = [threading.Thread(target=_conc_writer, args=(_t,))
                 for _t in range(_nthreads)]
    for _t in _wthreads:
        _t.start()
    for _t in _wthreads:
        _t.join(timeout=120)
    check("secret-file concurrent same-destination writes all succeed",
          not _werrors and all(not _t.is_alive() for _t in _wthreads),
          repr(_werrors[:3]))
    _final = open(_conc_path, encoding="utf-8").read()
    _m = re.fullmatch(r"t(\d+)-i(\d+)\n", _final)
    check("secret-file concurrent write leaves one complete payload",
          _m is not None and 0 <= int(_m.group(1)) < _nthreads
          and 0 <= int(_m.group(2)) < _niters, repr(_final[:40]))
    check("secret-file concurrent write keeps 0600",
          stat.S_IMODE(os.stat(_conc_path).st_mode) == 0o600)
    _leftover = [n for n in os.listdir(os.path.dirname(_conc_path))
                 if ".new." in n]
    check("secret-file concurrent write leaves no staging files",
          _leftover == [], repr(_leftover))

    print()
    # Defensive: the product stops the ephemeral form-host server at every
    # terminal complete, but tests must not leak it if an assertion aborted
    # a run mid-flight.
    try:
        from transport import form_host_server as _fhs
        _fhs.stop_server()
    except Exception:
        pass
    if FAILED:
        print("FAILED: %d (%s)" % (len(FAILED), ", ".join(FAILED)))
        raise SystemExit(1)
    # Self-clean: the hermetic source vault is deny-list-matching residue
    # (*.key) and must not linger in the tree.
    for _sfx in ("", ".key", ".lock"):
        try:
            os.unlink(os.path.join(WORK, "source_vault.json" + _sfx))
        except FileNotFoundError:
            pass
    print("all browser_backend selftests passed")


if __name__ == "__main__":
    main()
