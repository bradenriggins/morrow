#!/usr/bin/env python3
"""Fetch-lane live product proof driver: installed Morrow executor, browser lane.

Proves the connector-contained no-PAT transport end to end: every Canvas call
runs as page-context fetch() inside the educator's browser-owned session. No
form host, no helper page, no hosted dependency. Each step runs one product
phase; the orchestrator runs the managed browser task between dispatch and
complete, saving the task's report to a file. No step touches the network
directly.

Phases:
  dispatch-read / complete-read      GET the course (fetch lane)
  dispatch-write / complete-write    POST a temp unpublished assignment (fetch lane)
  verify                             GET the created assignment (fetch lane)
  dispatch-undo / complete-undo      DELETE the temp assignment (fetch lane)

Evidence lands in this directory, redacted.
"""
import argparse
import json
import os
import sys
import uuid

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(os.path.dirname(_HERE))
for _p in (_REPO, os.path.join(_REPO, "dispatch"), os.path.join(_REPO, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from dispatch import executor as ex
from transport import browser_backend as bb
from transport import state as lane_state
from dispatch.admission import mint_approval, sign_approval

# Explicit educator authorization basis for this proof's writes, cited
# verbatim in every v2 approval record. Braden's directive 2026-09-20
# ("Yes, start the executor work") authorized the live product proof scope:
# temporary unpublished objects in course 89585, verified then deleted.
# This driver re-proves that same scope through the final connector-contained
# fetch transport (no form host, no hosted helper).
AUTHORIZATION = (
    "Braden's explicit directive 2026-09-20 'Yes, start the executor work' "
    "authorizing the live product proof scope (temporary unpublished "
    "assignment in course 89585, verified then deleted), re-proven here "
    "through the connector-contained page-context fetch transport."
)

COURSE_ID = "89585"
COURSE_NAME = "SET-ME: the Canvas course name for course COURSE_ID (must match the provider)"
BASE = "https://chcp.instructure.com"
EVIDENCE = _HERE

JSON_HEADERS = {"Content-Type": "application/json", "Accept": "application/json"}
ACCEPT_JSON = {"Accept": "application/json"}

READ_ENTRY = {
    "name": "fetch_proof_read_course",
    "provider": "canvas",
    "effects": "read",
    "params": {"type": "object", "additionalProperties": True},
    "request": {
        "method": "GET",
        "url": "{canvas_base}/api/v1/courses/%s" % COURSE_ID,
        "headers": dict(ACCEPT_JSON),
        "fetch": True,
    },
    "result": {"receipt": ["id", "name"], "redact": [], "truncate": "tail",
               "max_bytes": 262144},
}

WRITE_ENTRY = {
    "name": "fetch_proof_create_assignment",
    "provider": "canvas",
    "effects": "write",
    "params": {"type": "object", "additionalProperties": True},
    "request": {
        "method": "POST",
        "url": "{canvas_base}/api/v1/courses/%s/assignments" % COURSE_ID,
        "headers": dict(JSON_HEADERS),
        "body": {"assignment": {"name": "Morrow Fetch Proof (temp)",
                                "published": False}},
        "fetch": True,
    },
    "verify": {
        "method": "GET",
        "url": "{canvas_base}/api/v1/courses/%s/assignments/{result.id}" % COURSE_ID,
        "headers": dict(ACCEPT_JSON),
        "fetch": True,
    },
    "undo": {
        "method": "DELETE",
        "url": "{canvas_base}/api/v1/courses/%s/assignments/{result.id}" % COURSE_ID,
        "headers": dict(ACCEPT_JSON),
        "fetch": True,
    },
    "result": {"receipt": ["id", "name", "published"], "redact": [],
               "truncate": "tail", "max_bytes": 262144},
}


def _save(name, obj):
    path = os.path.join(EVIDENCE, name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, indent=2, sort_keys=True, default=str)
    print(path)
    return path


def _lane():
    lane = lane_state.load()
    if not lane or not lane.get("canvas", {}).get("base"):
        raise SystemExit("no browser lane state; onboard first")
    return lane


def _frozen_plan(entry_name, params):
    op_id = str(uuid.uuid4())
    plan = {
        "op_id": op_id,
        "entry_name": entry_name,
        "params": params,
        "before_state_digest": ex.digest_of({"course_id": COURSE_ID, "proof": True}),
        "frozen_readback": "fetch-lane live product proof, course %s" % COURSE_ID,
    }
    path = os.path.join(EVIDENCE, "frozen-plan-%s.json" % op_id[:8])
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(plan, fh, indent=2, sort_keys=True)
    return ex.load_frozen_plan(path, entry_name)


def _approval(entry, params, suffix=""):
    rec = mint_approval(entry, params, tenant_base=BASE, ttl_seconds=3600,
                        target_identity={"course_id": params.get("course_id"),
                                         "course_name": COURSE_NAME})
    sign_approval(rec, AUTHORIZATION, channel="driver")
    path = os.path.join(EVIDENCE, "approval-%s%s.json" % (entry["name"], suffix))
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(rec, fh, indent=2, sort_keys=True)
    return rec


def cmd_dispatch_read(_args):
    lane = _lane()
    env = bb.dispatch_browser_entry(READ_ENTRY, {}, lane, pack=None)
    _save("envelope-read.json", env)
    print("BRIEF: " + env["brief_file"])
    print("OP_ID: " + env["op_id"])


def cmd_complete_read(args):
    lane = _lane()
    env = json.load(open(os.path.join(EVIDENCE, "envelope-read.json")))
    report = open(args.report_file, encoding="utf-8").read()
    receipt = bb.complete_browser_request(
        env["op_id"], READ_ENTRY, {}, plan=None,
        report_text=report, lane_state=lane, pack=None, kind="dispatch")
    _save("receipt-read.json", receipt)


def cmd_dispatch_write(_args):
    lane = _lane()
    params = {}
    plan = _frozen_plan(WRITE_ENTRY["name"], params)
    approval = _approval(WRITE_ENTRY, params)
    env = bb.dispatch_browser_entry(WRITE_ENTRY, params, lane, pack=None,
                                    plan=plan, approval=approval)
    _save("envelope-write.json", env)
    print("BRIEF: " + env["brief_file"])
    print("OP_ID: " + env["op_id"])


def cmd_complete_write(args):
    lane = _lane()
    env = json.load(open(os.path.join(EVIDENCE, "envelope-write.json")))
    plan_files = sorted(f for f in os.listdir(EVIDENCE)
                        if f.startswith("frozen-plan-"))
    if not plan_files:
        raise SystemExit("no frozen plan file in evidence dir")
    plan = ex.load_frozen_plan(os.path.join(EVIDENCE, plan_files[0]),
                               WRITE_ENTRY["name"])
    report = open(args.report_file, encoding="utf-8").read()
    out = bb.complete_browser_request(
        env["op_id"], WRITE_ENTRY, {}, plan=plan,
        report_text=report, lane_state=lane, pack=None, kind="dispatch")
    if out.get("status") == "awaiting_browser_task":
        _save("envelope-verify.json", out)
        print("VERIFY BRIEF: " + out["brief_file"])
    else:
        _save("receipt-write.json", out)


def cmd_verify(args):
    lane = _lane()
    env = json.load(open(os.path.join(EVIDENCE, "envelope-verify.json")))
    text = open(args.report_file, encoding="utf-8").read()
    out = bb.complete_browser_request(
        env["op_id"], WRITE_ENTRY, {}, plan=None,
        lane_state=lane, pack=None, report_text=text, kind="verify")
    _save("receipt-verify.json", out)


def cmd_dispatch_undo(args):
    lane = _lane()
    result_file = json.load(open(args.result_file))
    result_payload = result_file.get("receipt", result_file)
    # The undo is approved as its own write: bound to the undo action
    # and its target, never the forward write's approval.
    u_entry, u_params = ex.undo_approval_subject(
        WRITE_ENTRY, {}, args.of_op_id, result_payload)
    approval = _approval(u_entry, u_params, suffix="-undo")
    env = bb.dispatch_browser_undo(WRITE_ENTRY, {}, result_payload,
                                   args.of_op_id, lane,
                                   pack=None, approval=approval)
    _save("envelope-undo.json", env)
    print("BRIEF: " + env["brief_file"])
    print("OP_ID: " + env["op_id"])


def cmd_complete_undo(args):
    lane = _lane()
    env = json.load(open(os.path.join(EVIDENCE, "envelope-undo.json")))
    report = open(args.report_file, encoding="utf-8").read()
    out = bb.complete_browser_request(
        env["op_id"], WRITE_ENTRY, {}, plan=None,
        report_text=report, lane_state=lane, pack=None, kind="undo",
        of_op_id=env["undo_of"], undo_params=env.get("undo_params"))
    _save("receipt-undo.json", out)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("dispatch-read")
    p = sub.add_parser("complete-read")
    p.add_argument("--report-file", required=True)
    sub.add_parser("dispatch-write")
    p = sub.add_parser("complete-write")
    p.add_argument("--report-file", required=True)
    p = sub.add_parser("verify")
    p.add_argument("--report-file", required=True)
    p = sub.add_parser("dispatch-undo")
    p.add_argument("--of-op-id", required=True)
    p.add_argument("--result-file", required=True)
    p = sub.add_parser("complete-undo")
    p.add_argument("--report-file", required=True)
    args = ap.parse_args()
    {"dispatch-read": cmd_dispatch_read,
     "complete-read": cmd_complete_read,
     "dispatch-write": cmd_dispatch_write,
     "complete-write": cmd_complete_write,
     "verify": cmd_verify,
     "dispatch-undo": cmd_dispatch_undo,
     "complete-undo": cmd_complete_undo}[args.cmd](args)


if __name__ == "__main__":
    main()
