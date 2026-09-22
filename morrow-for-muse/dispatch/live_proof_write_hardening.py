#!/usr/bin/env python3
"""Live proof: silent-write hardening (D-009, D-010, D-011) on Canvas.

Runs against https://chcp.instructure.com, course 89585, through
transport/chromium_session.ChromiumSession (CDP page context on
127.0.0.1:19223; no shell-side HTTP client, no auth material handled
here). Reads use catalog read entries; writes go through dispatch_entry
with in-memory frozen plans and signed approvals.

Authorization basis: Braden's standing approval for live batteries on
disposable objects with full cleanup (2026-09-21).

  D-010: GET the discussion list, attempt an empty discussion POST through
         the executor (expect WritePrevalidationFailed before any network
         call), GET the list again and confirm no new "No Title".
  D-011: PUT to a unique nonexistent page URL through the executor
         (expect WritePrevalidationFailed after the pre-check GET 404s),
         GET the URL afterward to confirm it is still 404. No cleanup.
  D-009: POST an assignment group with a unique name and a malformed
         position ("banana"). Canvas is expected to 200 with wrong
         persisted fields; the executor must read back the created member
         and raise WriteFieldMismatch (hard failed write). The created
         group id is taken from the journaled receipt, DELETEed through
         the executor with its own plan and approval, and confirmed gone.

Journal + approval state are redirected under .proof-work so the real
~/.morrow is untouched. Nothing is committed.
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
from dispatch.admission import mint_approval, sign_approval  # noqa: E402
import dispatch.admission as admission_mod  # noqa: E402
import chromium_session as cs  # noqa: E402

BASE = "https://chcp.instructure.com"
COURSE = "89585"
COURSE_NAME = "SET-ME: the Canvas course name for course COURSE (must match the provider)"
REPORT = []

# Hermetic proof state (never touches the real ~/.morrow).
_proof_dir = os.path.join(REPO, "dispatch", ".proof-work",
                           "2026-09-21-write-hardening")
shutil.rmtree(_proof_dir, ignore_errors=True)
os.makedirs(os.path.join(_proof_dir, "journal"), exist_ok=True)
os.makedirs(os.path.join(_proof_dir, "approvals"), exist_ok=True)
ex.JOURNAL_PATH = os.path.join(_proof_dir, "journal", "ops.jsonl")
ex.MORROW_HOME = _proof_dir
admission_mod.APPROVALS_DIR = os.path.join(_proof_dir, "approvals")
admission_mod.CONSUMED_PATH = os.path.join(_proof_dir, "approvals",
                                           "consumed.json")

_AUTH = ("Authorization basis: Braden's standing approval for live "
         "batteries on disposable objects with full cleanup (2026-09-21); "
         "Canvas course 89585; disposable test objects only")

_PACK = {"credential_slots": {
    "canvas_pat": {"inject": {"header": "Authorization",
                              "scheme": "Bearer"}}}}


def note(line):
    REPORT.append(line)
    print(line, flush=True)


def admit(entry, params):
    plan_data = {
        "op_id": str(uuid.uuid4()),
        "entry_name": entry["name"],
        "params": params,
        "before_state_digest": ex.digest_of({"live-proof": True}),
        "frozen_readback": "D-009/D-010/D-011 live proof 2026-09-21",
    }
    plan = ex.FrozenPlan(plan_data, "live-proof-plan")
    rec = mint_approval(entry, params, tenant_base=BASE,
                        target_identity={"course_id": params.get("course_id"),
                                         "course_name": COURSE_NAME})
    sign_approval(rec, _AUTH, channel="driver")
    return plan, rec


def read_entry(name, path):
    return ex.catalog_descriptor_to_entry(name, "GET", path, "read",
                                          provider="canvas")


def read_payload(sess, name, path):
    entry = read_entry(name, path)
    plan = ex.FrozenPlan({
        "op_id": str(uuid.uuid4()), "entry_name": name,
        "params": {"course_id": COURSE},
        "before_state_digest": ex.digest_of({}),
        "frozen_readback": "live-proof read"}, "live-proof-plan")
    out = ex.dispatch_entry(entry, {"course_id": COURSE}, sess, _PACK,
                            plan=plan)
    rec = out["receipt"]
    return rec.get("_text_preview") if "_text_preview" in rec else rec


def read_json(sess, name, path):
    """Read through raw_request to get the full (unredacted) JSON body.

    Returns (status, body); a fail-fast 4xx returns its status instead of
    raising, so after-checks can assert 404 directly."""
    entry = read_entry(name, path)
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
    sess = cs.ChromiumSession(BASE)

    # Session sanity: a read-only users/self dispatch.
    status, me = read_json(sess, "proof_users_self", "/api/v1/users/self")
    note("session check: GET /api/v1/users/self -> HTTP %d (user %s)"
         % (status, me.get("name")))

    # ------------------------------------------------ D-010 ---
    note("")
    note("== D-010: empty discussion create refused pre-network ==")
    _s, topics_before = read_json(
        sess, "proof_dt_before",
        "/api/v1/courses/%s/discussion_topics" % COURSE)
    before_count = len(topics_before)
    no_title_before = sum(1 for t in topics_before
                          if (t.get("title") or "") == "No Title")
    note("before: %d discussion topics, %d titled 'No Title'"
         % (before_count, no_title_before))

    entry = ex.catalog_descriptor_to_entry(
        "proof_d010_discussion_create", "POST",
        "/api/v1/courses/%s/discussion_topics" % COURSE,
        "write", provider="canvas", extra={"body": {}})
    plan, rec = admit(entry, {"course_id": COURSE},
                   require_educator_channel=False)  # proof driver: driver-channel
    try:
        ex.dispatch_entry(entry, {"course_id": COURSE}, sess, _PACK,
                          plan=plan, approval=rec)
        note("D-010 PROOF: FAIL, empty discussion POST was not refused")
    except ex.WritePrevalidationFailed as exc:
        note("D-010 PROOF: WritePrevalidationFailed before any network call")
        note("  reason: %s" % exc)
        note("  op_id %s reusable: %s"
             % (plan.op_id, ex.find_journal_op(plan.op_id) is None))

    _s, topics_after = read_json(
        sess, "proof_dt_after",
        "/api/v1/courses/%s/discussion_topics" % COURSE)
    after_count = len(topics_after)
    no_title_after = sum(1 for t in topics_after
                         if (t.get("title") or "") == "No Title")
    note("after: %d discussion topics, %d titled 'No Title'"
         % (after_count, no_title_after))
    note("D-010 PROOF: %s (count %d -> %d, No Title %d -> %d)"
         % ("PASS" if (after_count == before_count
                       and no_title_after == no_title_before) else "FAIL",
            before_count, after_count, no_title_before, no_title_after))

    # ------------------------------------------------ D-011 ---
    note("")
    note("== D-011: page PUT to a missing URL refused pre-check ==")
    page_url = "zz-defense-proof-20260921-nopage"
    page_path = "/api/v1/courses/%s/pages/%s" % (COURSE, page_url)
    entry = ex.catalog_descriptor_to_entry(
        "proof_d011_page_put", "PUT", page_path, "write",
        provider="canvas",
        extra={"body": {"wiki_page": {"title": "Defense proof",
                                      "body": "should never persist"}}})
    plan, rec = admit(entry, {"course_id": COURSE},
                   require_educator_channel=False)  # proof driver: driver-channel
    try:
        ex.dispatch_entry(entry, {"course_id": COURSE}, sess, _PACK,
                          plan=plan, approval=rec)
        note("D-011 PROOF: FAIL, page PUT to a missing URL was not refused")
    except ex.WritePrevalidationFailed as exc:
        note("D-011 PROOF: WritePrevalidationFailed; no PUT reached Canvas")
        note("  reason: %s" % exc)
        note("  op_id %s reusable: %s"
             % (plan.op_id, ex.find_journal_op(plan.op_id) is None))

    status, _body = read_json(sess, "proof_page_after", page_path)
    note("after: GET %s -> HTTP %d" % (page_path, status))
    note("D-011 PROOF: %s (page still missing, nothing to clean up)"
         % ("PASS" if status == 404 else "FAIL"))

    # ------------------------------------------------ D-009 ---
    note("")
    note("== D-009: silent assignment-group write detected on readback ==")
    group_name = "AG-DEFENSE-PROOF-20260921"
    entry = ex.catalog_descriptor_to_entry(
        "proof_d009_ag_create", "POST",
        "/api/v1/courses/%s/assignment_groups" % COURSE,
        "write", provider="canvas",
        extra={"body": {"assignment_group": {"name": group_name,
                                             "position": "banana"}}})
    plan, rec = admit(entry, {"course_id": COURSE},
                   require_educator_channel=False)  # proof driver: driver-channel
    created_id = None
    mismatch_detail = ""
    try:
        out = ex.dispatch_entry(entry, {"course_id": COURSE}, sess, _PACK,
                                plan=plan, approval=rec)
        note("D-009 observation: no mismatch; readback passed, "
             "verification=%r" % (out["verification"],))
        created_id = (out["receipt"] or {}).get("id")
    except ex.WriteFieldMismatch as exc:
        mismatch_detail = str(exc)
        note("D-009 PROOF: WriteFieldMismatch raised on readback")
        note("  reason: %s" % mismatch_detail)
        jrec = ex.find_journal_op(plan.op_id)
        created_id = (jrec.get("receipt") or {}).get("id") if jrec else None
        note("  journal: verification=%s uncertain=%s"
             % ((jrec or {}).get("verification"),
                (jrec or {}).get("uncertain")))
    if created_id is None:
        note("D-009 PROOF: FAIL, could not recover the created group id; "
             "manual cleanup needed")
    else:
        note("created group id %s; deleting through the executor" % created_id)
        del_entry = ex.catalog_descriptor_to_entry(
            "proof_d009_ag_delete", "DELETE",
            "/api/v1/courses/%s/assignment_groups/%s" % (COURSE, created_id),
            "write", provider="canvas")
        dplan, drec = admit(del_entry, {"course_id": COURSE},
                      require_educator_channel=False)  # proof driver: driver-channel
        dout = ex.dispatch_entry(del_entry, {"course_id": COURSE}, sess,
                                 _PACK, plan=dplan, approval=drec)
        note("DELETE -> verification=%r" % (dout["verification"],))
        status, _body = read_json(
            sess, "proof_ag_gone",
            "/api/v1/courses/%s/assignment_groups/%s" % (COURSE, created_id))
        note("cleanup check: GET member -> HTTP %d" % status)
        note("D-009 cleanup: %s"
             % ("PASS (group gone)" if status == 404 else
                "FAIL (group still present)"))

    note("")
    note("proof state under: %s" % _proof_dir)
    with open(os.path.join(_proof_dir, "report.txt"), "w") as fh:
        fh.write("\n".join(REPORT) + "\n")
    note("report written to report.txt")


if __name__ == "__main__":
    main()
