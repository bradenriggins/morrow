#!/usr/bin/env python3
"""Live proof: Plan/Edit modes end to end on Canvas.

Runs against https://chcp.instructure.com, course 89585, through
transport/chromium_session.ChromiumSession (CDP page context on
127.0.0.1:19223; no shell-side HTTP client, no auth material handled
here). All writes go through dispatch_entry with mode_ctx; there are no
frozen plans and no per-write approvals anywhere in this battery.

Authorization basis: Braden's standing approval for live batteries on
disposable objects with full cleanup (2026-09-21). The edit grant is
issued by this proof driver with channel="driver" and the standing
approval cited verbatim, the same convention the write-hardening proof
uses for driver-channel approvals.

Battery:
  M-1: helper health (logged_in, chromium_alive) before and after.
  M-2: educator-issued timed edit grant (proof driver, channel=driver).
  M-3: create a disposable wiki page with NO per-write approval and NO
       frozen plan -> must succeed (edit mode admits).
  M-4: read it back (GET) and verify the title.
  M-5: delete it with destructive_confirmed (confirm_destructive_writes
       defaults on) -> must succeed.
  M-6: read it back -> expect 404.
  M-7: switch the conversation to plan mode.
  M-8: attempt the same write class without approval -> expect
       PlanModeWriteWithoutApproval.
  M-9: translate the refusal -> expect mode id
       plan_mode_write_without_approval.
  M-10: ambiguous course resolution (confidence 0.5, unconfirmed) in
        edit mode -> expect AmbiguousCourseWriteRefused before any
        provider call (no network for this step).
  M-11: zero leftovers (list pages; no proof title remains).
  M-12: revoke grants, end the conversation, helper health again.

Journal + approval + mode state are redirected under .proof-work so the
real ~/.morrow is untouched. Nothing is committed.
"""

import json
import os
import shutil
import sys
import uuid

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (REPO, os.path.join(REPO, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from dispatch import executor as ex  # noqa: E402
import dispatch.admission as admission_mod  # noqa: E402
from failures import translate  # noqa: E402
from modes import errors as mode_errors  # noqa: E402
from modes import state as mode_state  # noqa: E402
from settings import store as settings  # noqa: E402
import chromium_session as cs  # noqa: E402

BASE = "https://chcp.instructure.com"
COURSE = "89585"
REPORT = []
FAILURES = []

_AUTH = ("Braden's standing approval for live batteries on disposable "
         "objects with full cleanup (2026-09-21)")

# Hermetic proof state (never touches the real ~/.morrow).
_proof_dir = os.path.join(REPO, "dispatch", ".proof-work",
                           "2026-09-22-modes")
shutil.rmtree(_proof_dir, ignore_errors=True)
os.makedirs(os.path.join(_proof_dir, "journal"), exist_ok=True)
os.makedirs(os.path.join(_proof_dir, "approvals"), exist_ok=True)
os.makedirs(os.path.join(_proof_dir, "settings"), exist_ok=True)
os.environ["MORROW_HOME"] = _proof_dir
# Ride the login helper's live Chromium (its profile holds the
# educator's authenticated Canvas session); the tree default profile
# would fail the launcher's holder verification.
os.environ["LOGIN_HELPER_PROFILE_DIR"] = \
    "/home/hatch/workspace/canvas-login-helper/profile"
# The helper's CDP proxy is token-authenticated; read the token from
# the live helper's own state dir (no credential copies).
os.environ["MORROW_TREE_STATE_DIR"] = os.path.expanduser(
    "~/.morrow/canvas-login-helper")
ex.JOURNAL_PATH = os.path.join(_proof_dir, "journal", "ops.jsonl")
admission_mod.APPROVALS_DIR = os.path.join(_proof_dir, "approvals")
admission_mod.CONSUMED_PATH = os.path.join(_proof_dir, "approvals",
                                           "consumed.json")
admission_mod.SECRETS_DIR = os.path.join(_proof_dir, "secrets")
admission_mod.SIGNING_KEY_PATH = os.path.join(_proof_dir, "secrets",
                                              "approval-signing.key")

_PACK = {"credential_slots": {
    "canvas_pat": {"inject": {"header": "Authorization",
                              "scheme": "Bearer"}}}}

USER = "live-proof-educator"
CONV = "live-proof-conv-%s" % uuid.uuid4().hex[:8]
TAG = "morrow-modes-proof-%s" % uuid.uuid4().hex[:8]


def note(line):
    REPORT.append(line)
    print(line, flush=True)


def check(name, cond, detail=""):
    note("%s: %s%s" % ("PASS" if cond else "FAIL", name,
                        (" (%s)" % detail) if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


def helper_health():
    import urllib.request
    try:
        with urllib.request.urlopen("http://127.0.0.1:8901/status",
                                    timeout=10) as resp:
            status = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        return False, "status probe failed: %s" % exc
    ok = bool(status.get("logged_in")) and bool(status.get("chromium_alive"))
    return ok, "logged_in=%s chromium_alive=%s" % (
        status.get("logged_in"), status.get("chromium_alive"))


def read_json(sess, name, path):
    """GET through the executor; fail-fast 4xx returns its status."""
    entry = ex.catalog_descriptor_to_entry(name, "GET", path, "read",
                                          provider="canvas")
    block = entry["request"]
    method, url, headers, body = ex.build_request(
        entry, block, {"course_id": COURSE}, sess, _PACK,
        {"canvas_base": BASE}, {})
    try:
        status, _rh, raw, _attempts = sess.raw_request(
            method, url, headers, body, is_write=False)
    except ex.ProviderHttpError as exc:
        return exc.status, {"_http_error": exc.status}
    return status, json.loads(raw.decode("utf-8"))


def main():
    # ------------------------------------------------ M-1: health ---
    ok, detail = helper_health()
    note("M-1 helper health before: %s" % detail)
    check("M-1 helper healthy before battery", ok, detail)
    if not ok:
        note("helper down; aborting live battery")
        return 1

    sess = cs.ChromiumSession(BASE)
    status, me = read_json(sess, "proof_modes_self", "/api/v1/users/self")
    note("session check: GET /api/v1/users/self -> HTTP %d" % status)
    check("session live", status == 200, "status=%r" % status)

    mode_ctx = {"user_id": USER, "conversation_id": CONV}

    # ------------------------------------------------ M-2: grant ---
    grant = mode_state.request_edit_grant(
        USER, duration_min=30, conversation_id=CONV,
        educator_confirmation={"by": "educator",
                               "authorization": _AUTH,
                               "channel": "driver"})
    note("M-2 edit grant issued: %s (scope=%s)"
         % (grant["grant_id"], grant["scope_type"]))
    check("M-2 grant issued", grant["grant_id"] is not None)
    check("M-2 effective mode is edit",
          settings.effective_mode(USER, CONV) == "edit")

    # ------------------------------------------------ M-3: create ---
    title = "Modes proof page %s" % TAG
    entry = ex.catalog_descriptor_to_entry(
        "proof_modes_page_create", "POST",
        "/api/v1/courses/%s/pages" % COURSE,
        "write", provider="canvas",
        extra={"body": {"wiki_page": {"title": title,
                                      "body": "Disposable page for the "
                                              "Plan/Edit modes live proof. "
                                              "Safe to delete."}}})
    out = ex.dispatch_entry(entry, {"course_id": COURSE}, sess, _PACK,
                            plan=None, approval=None, mode_ctx=mode_ctx,
                            require_educator_channel=False)
    receipt = out.get("receipt") or {}
    page_url = receipt.get("url")
    note("M-3 created page url=%r (no plan, no approval)" % page_url)
    check("M-3 edit-mode write dispatched with no plan and no approval",
          bool(page_url), "receipt=%r" % (receipt,))

    # ------------------------------------------------ M-4: read back ---
    status, page = read_json(sess, "proof_modes_page_get",
                             "/api/v1/courses/%s/pages/%s" % (COURSE, page_url))
    note("M-4 GET page -> HTTP %d title=%r" % (status, page.get("title")))
    check("M-4 page reads back with the proof title",
          status == 200 and page.get("title") == title,
          "status=%r title=%r" % (status, page.get("title")))

    # ------------------------------------------------ M-5: delete ---
    entry = ex.catalog_descriptor_to_entry(
        "proof_modes_page_delete", "DELETE",
        "/api/v1/courses/%s/pages/%s" % (COURSE, page_url),
        "write", provider="canvas")
    del_ctx = dict(mode_ctx, destructive_confirmed=(
        "yes, delete the modes proof page"))
    out = ex.dispatch_entry(entry, {"course_id": COURSE}, sess, _PACK,
                            plan=None, approval=None, mode_ctx=del_ctx,
                            require_educator_channel=False)
    note("M-5 DELETE dispatched with destructive_confirmed")
    check("M-5 destructive write admitted with educator confirmation",
          out is not None)

    # Also prove the destructive gate fires without the confirmation.
    entry2 = ex.catalog_descriptor_to_entry(
        "proof_modes_page_delete2", "DELETE",
        "/api/v1/courses/%s/pages/%s" % (COURSE, page_url),
        "write", provider="canvas")
    try:
        ex.dispatch_entry(entry2, {"course_id": COURSE}, sess, _PACK,
                          plan=None, approval=None, mode_ctx=mode_ctx,
                          require_educator_channel=False)
        check("M-5b destructive write without confirmation refused", False,
              "no exception raised")
    except mode_errors.DestructiveConfirmationRequired:
        check("M-5b destructive write without confirmation refused", True)

    # ------------------------------------------------ M-6: 404 ---
    status, _body = read_json(sess, "proof_modes_page_gone",
                              "/api/v1/courses/%s/pages/%s" % (COURSE, page_url))
    note("M-6 GET deleted page -> HTTP %d" % status)
    check("M-6 deleted page is gone (404)", status == 404,
          "status=%r" % status)

    # ------------------------------------------------ M-7/M-8: plan ---
    settings.set_conversation_mode(USER, CONV, "plan",
                                   educator_confirmed=True)
    check("M-7 conversation switched to plan",
          settings.effective_mode(USER, CONV) == "plan")
    entry = ex.catalog_descriptor_to_entry(
        "proof_modes_page_create_plan", "POST",
        "/api/v1/courses/%s/pages" % COURSE,
        "write", provider="canvas",
        extra={"body": {"wiki_page": {"title": "should never persist",
                                      "body": "x"}}})
    try:
        ex.dispatch_entry(entry, {"course_id": COURSE}, sess, _PACK,
                          plan=None, approval=None, mode_ctx=mode_ctx,
                          require_educator_channel=False)
        check("M-8 plan-mode write without approval refused", False,
              "no exception raised")
        refusal = None
    except mode_errors.PlanModeWriteWithoutApproval as exc:
        refusal = exc
        check("M-8 plan-mode write without approval refused", True)

    # ------------------------------------------------ M-9: translate ---
    if refusal is not None:
        tr = translate("create a wiki page", refusal)
        note("M-9 translated mode id: %s" % tr.mode_id)
        check("M-9 refusal translates to plan_mode_write_without_approval",
              tr.mode_id == "plan_mode_write_without_approval",
              "mode_id=%r" % tr.mode_id)
    else:
        check("M-9 refusal translates to plan_mode_write_without_approval",
              False, "no refusal captured")

    # ------------------------------------------------ M-10: ambiguous ---
    # Back to edit for this step: the ambiguous-course refusal lives on
    # the edit path (plan mode protects the target via its approval
    # ceremony instead). No provider call happens either way: the gate
    # refuses before dispatch.
    mode_state.request_edit_grant(
        USER, duration_min=30, conversation_id=CONV,
        educator_confirmation={"by": "educator",
                               "authorization": _AUTH,
                               "channel": "driver"})
    ambiguous = {"course_id": None, "confidence": 0.5,
                 "user_confirmed": False, "query": "Biology 101",
                 "candidates_public": "Biology 101 (Fall), "
                                      "Biology 101 (Spring)"}
    amb_ctx = dict(mode_ctx, course_resolution=ambiguous)
    entry = ex.catalog_descriptor_to_entry(
        "proof_modes_page_create_amb", "POST",
        "/api/v1/courses/%s/pages" % COURSE,
        "write", provider="canvas",
        extra={"body": {"wiki_page": {"title": "should never persist",
                                      "body": "x"}}})
    try:
        ex.dispatch_entry(entry, {"course_id": COURSE}, sess, _PACK,
                          plan=None, approval=None, mode_ctx=amb_ctx,
                          require_educator_channel=False)
        check("M-10 ambiguous course refused before dispatch", False,
              "no exception raised")
    except mode_errors.AmbiguousCourseWriteRefused as exc:
        note("M-10 AmbiguousCourseWriteRefused: %s" % exc)
        check("M-10 ambiguous course refused before dispatch", True)

    # ------------------------------------------------ M-11: leftovers ---
    status, pages = read_json(sess, "proof_modes_pages",
                              "/api/v1/courses/%s/pages" % COURSE)
    leftovers = [p.get("title") for p in (pages or [])
                 if TAG in (p.get("title") or "")]
    note("M-11 pages list -> HTTP %d, proof leftovers: %r"
         % (status, leftovers))
    check("M-11 zero leftovers", status == 200 and not leftovers,
          "leftovers=%r" % (leftovers,))

    # ------------------------------------------------ M-12: cleanup ---
    settings.end_conversation(USER, CONV)
    mode_state.revoke_edit_grant(USER, reason="live proof complete")
    check("M-12 grants revoked, conversation ended",
          settings.effective_mode(USER) == "plan")
    ok, detail = helper_health()
    note("M-12 helper health after: %s" % detail)
    check("M-12 helper healthy after battery", ok, detail)

    note("")
    if FAILURES:
        note("LIVE PROOF: %d FAILURES: %s" % (len(FAILURES), FAILURES))
        return 1
    note("LIVE PROOF: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
