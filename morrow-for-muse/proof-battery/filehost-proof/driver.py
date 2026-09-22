#!/usr/bin/env python3
"""Live product proof driver: installed Morrow executor, browser lane.

Each step runs one product phase. The orchestrator (the Morrow agent) runs
the managed browser task between dispatch and complete, saving the task's
report to a file. No step touches the network directly; every Canvas call
goes through the educator's browser-owned session via the rendered brief.

Steps:
  dispatch-read        plan the product read, render the browser brief
  complete-read        ingest the browser report for the read
  dispatch-write       plan the product write (frozen plan + educator approval)
  complete-write       ingest the browser report for the write
  verify               finish a deferred verify phase
  dispatch-undo        plan the product undo (delete the temp assignment)
  complete-undo        ingest the browser report for the undo

Evidence lands in this directory, redacted. Briefs live in
~/.morrow/browser-briefs (mode 0600, no secrets by construction).
"""
import argparse
import json
import os
import sys
import uuid
from datetime import datetime, timezone

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
# The Morrow PM's 2026-09-20 tasking directed proving the bundled file://
# form-host through the actual two-phase dispatch/complete.
AUTHORIZATION = (
    "Braden's explicit directive 2026-09-20 'Yes, start the executor work' "
    "authorizing the live product proof scope (temporary unpublished "
    "assignment in course 89585, verified then deleted), plus the Morrow PM "
    "2026-09-20 tasking to prove the bundled file:// form-host through the "
    "actual two-phase dispatch/complete."
)

COURSE_ID = "89585"
COURSE_NAME = "SET-ME: the Canvas course name for course COURSE_ID (must match the provider)"
BASE = "https://chcp.instructure.com"
EVIDENCE = _HERE

READ_ENTRY = {
    "name": "proof_read_course",
    "method": "GET",
    "path": "/api/v1/courses/%s" % COURSE_ID,
    "class": "read",
    "params": {},
}

READ_VERIFY = {
    "name": "proof_read_assignment",
    "method": "GET",
    "path": "/api/v1/courses/%s/assignments/{result.id}" % COURSE_ID,
    "class": "read",
    "params": {},
}

WRITE_ENTRY = {
    "name": "proof_create_assignment",
    "method": "POST",
    "path": "/api/v1/courses/%s/assignments" % COURSE_ID,
    "class": "write",
    "params": {"course_id": COURSE_ID},
    "extra": {
        "body": {"assignment": {"name": "Morrow Product Proof (temp)",
                                "published": False}},
        "verify": {
            "method": "GET",
            "url": "{canvas_base}/api/v1/courses/%s/assignments/{result.id}" % COURSE_ID,
        },
        "undo": {
            "method": "DELETE",
            "url": "{canvas_base}/api/v1/courses/%s/assignments/{result.id}" % COURSE_ID,
        },
    },
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


def _entry(spec):
    return ex.catalog_descriptor_to_entry(
        spec["name"], spec["method"], spec["path"], spec["class"],
        provider="canvas", extra=spec.get("extra"))


def _frozen_plan(entry_name, params):
    op_id = str(uuid.uuid4())
    plan = {
        "op_id": op_id,
        "entry_name": entry_name,
        "params": params,
        "before_state_digest": ex.digest_of({"course_id": COURSE_ID, "proof": True}),
        "frozen_readback": "live product proof run, course %s" % COURSE_ID,
    }
    path = os.path.join(EVIDENCE, "frozen-plan-%s.json" % op_id[:8])
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(plan, fh, indent=2, sort_keys=True)
    return ex.load_frozen_plan(path, entry_name)


def _approval(entry, params, suffix=""):
    # v2 approval: digest-bound to this exact (entry, params, tenant),
    # time-boxed (1h TTL), category-scoped, single-use. The educator's
    # explicit authorization is cited verbatim; nothing is inferred.
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
    entry = _entry(READ_ENTRY)
    env = bb.dispatch_browser_entry(entry, READ_ENTRY["params"],
                                    lane, pack=None)
    _save("envelope-read.json", env)
    print("BRIEF: " + env["brief_file"])
    print("OP_ID: " + env["op_id"])


def cmd_complete_read(args):
    lane = _lane()
    entry = _entry(READ_ENTRY)
    env = json.load(open(os.path.join(EVIDENCE, "envelope-read.json")))
    report = open(args.report_file, encoding="utf-8").read()
    receipt = bb.complete_browser_request(
        env["op_id"], entry, READ_ENTRY["params"], plan=None,
        report_text=report, lane_state=lane, pack=None, kind="dispatch")
    _save("receipt-read.json", receipt)


def cmd_dispatch_write(_args):
    lane = _lane()
    entry = _entry(WRITE_ENTRY)
    params = WRITE_ENTRY["params"]
    plan = _frozen_plan(entry["name"], params)
    approval = _approval(entry, params)
    env = bb.dispatch_browser_entry(entry, params, lane, pack=None,
                                    plan=plan, approval=approval)
    _save("envelope-write.json", env)
    print("BRIEF: " + env["brief_file"])
    print("OP_ID: " + env["op_id"])


def cmd_complete_write(args):
    lane = _lane()
    entry = _entry(WRITE_ENTRY)
    env = json.load(open(os.path.join(EVIDENCE, "envelope-write.json")))
    plan_files = sorted(f for f in os.listdir(EVIDENCE)
                        if f.startswith("frozen-plan-"))
    if not plan_files:
        raise SystemExit("no frozen plan file in evidence dir")
    plan = ex.load_frozen_plan(os.path.join(EVIDENCE, plan_files[0]),
                               entry["name"])
    report = open(args.report_file, encoding="utf-8").read()
    out = bb.complete_browser_request(
        env["op_id"], entry, WRITE_ENTRY["params"], plan=plan,
        report_text=report, lane_state=lane, pack=None, kind="dispatch")
    if out.get("status") == "awaiting_browser_task":
        _save("envelope-verify.json", out)
        print("VERIFY BRIEF: " + out["brief_file"])
    else:
        _save("receipt-write.json", out)


def cmd_dispatch_verify(args):
    lane = _lane()
    result = json.load(open(os.path.join(EVIDENCE, "receipt-write.json")))["receipt"]
    # Resolve the result ref the way the executor's result-payload block does.
    spec = dict(READ_VERIFY, path=READ_VERIFY["path"].replace(
        "{result.id}", str(result["id"])))
    entry = _entry(spec)
    op_id = str(uuid.uuid4())
    env = bb.dispatch_browser_entry(
        entry, READ_VERIFY["params"], lane, pack=None, plan=None, op_id=op_id,
        kind="verify")
    with open(os.path.join(EVIDENCE, "envelope-verify.json"), "w",
              encoding="utf-8") as fh:
        json.dump(env, fh, indent=2)
    brief = bb._brief_path(None, op_id, "request")
    print(os.path.join(EVIDENCE, "envelope-verify.json"))
    print("BRIEF: " + brief)
    print("OP_ID: " + op_id)


def cmd_verify(args):
    lane = _lane()
    env = json.load(open(os.path.join(EVIDENCE, "envelope-verify.json")))
    result = json.load(open(os.path.join(EVIDENCE, "receipt-write.json")))["receipt"]
    spec = dict(READ_VERIFY, path=READ_VERIFY["path"].replace(
        "{result.id}", str(result["id"])))
    entry = _entry(spec)
    text = open(args.report_file, encoding="utf-8").read()
    out = bb.complete_browser_request(
        env["op_id"], entry, READ_VERIFY["params"], plan=None,
        lane_state=lane, pack=None, report_text=text, kind="verify")
    _save("receipt-verify.json", out)


def cmd_dispatch_undo(args):
    lane = _lane()
    entry = _entry(WRITE_ENTRY)
    result_file = json.load(open(args.result_file))
    # Undo resolves {result.id} against the parsed result receipt.
    result_payload = result_file.get("receipt", result_file)
    of_op_id = args.of_op_id
    # The undo is approved as its own write: bound to the undo action
    # and its target, never the forward write's approval.
    u_entry, u_params = ex.undo_approval_subject(
        entry, WRITE_ENTRY["params"], of_op_id, result_payload)
    approval = _approval(u_entry, u_params, suffix="-undo")
    env = bb.dispatch_browser_undo(entry, WRITE_ENTRY["params"],
                                   result_payload, of_op_id, lane,
                                   pack=None, approval=approval)
    _save("envelope-undo.json", env)
    print("BRIEF: " + env["brief_file"])
    print("OP_ID: " + env["op_id"])


def cmd_complete_undo(args):
    lane = _lane()
    entry = _entry(WRITE_ENTRY)
    env = json.load(open(os.path.join(EVIDENCE, "envelope-undo.json")))
    report = open(args.report_file, encoding="utf-8").read()
    out = bb.complete_browser_request(
        env["op_id"], entry, WRITE_ENTRY["params"], plan=None,
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
    p = sub.add_parser("dispatch-verify")
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
     "dispatch-verify": cmd_dispatch_verify,
     "verify": cmd_verify,
     "dispatch-undo": cmd_dispatch_undo,
     "complete-undo": cmd_complete_undo}[args.cmd](args)


if __name__ == "__main__":
    main()
