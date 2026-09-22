#!/usr/bin/env python3
"""Selftest for catalog/a11y/runner.py: audit mode and planner mode.

Runs synthetic (no provider, no browser). Uses a fake session and a
fake dispatch_catalog_op to prove:

- Audit mode reads the target, runs the detectors, returns the report,
  and never writes.
- Planner mode fresh-reads, validates the plan, produces the artifact,
  and refuses dispatch.
- Unknown target kinds, unwired kinds, and unknown planners produce
  funneled errors, not tracebacks.
- No tenant string alters mode availability (PARITY LAW).

Stdlib only. Exit 0 on pass, 1 on failure.
"""
import os as _home_os, sys as _home_sys  # noqa: E401
_home_sys.path.insert(0, _home_os.path.join(
    _home_os.path.dirname(_home_os.path.abspath(__file__)), '../..'))
import config.selftest_home  # noqa: E402,F401  (scratch HOME/MORROW_HOME)

import io
import json
import os
import sys
from contextlib import redirect_stderr

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(os.path.dirname(HERE))
for _p in (TREE, os.path.join(TREE, "dispatch"), HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import runner

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("PASS" if cond else "FAIL") + ": " + name + (" | " + detail if detail and not cond else ""))


FAKE_HTML = (
    "<h1>Title</h1>"
    "<p>Body with an image <img src=\"https://example.invalid/a.png\"></p>"
)

DISPATCH_CALLS = []


class FakeSession:
    def __init__(self):
        self.closed = False
    def close(self):
        self.closed = True


def _fake_dispatch(op_name, method, path_template, effect_class=None,
                   params=None, provider=None, session=None,
                   require_educator_channel=None):
    DISPATCH_CALLS.append({
        "op_name": op_name, "method": method, "path_template": path_template,
        "effect_class": effect_class, "params": params, "provider": provider,
    })
    if op_name == "canvas_show_page_courses":
        return {"receipt": {"title": "Fake", "body": FAKE_HTML}}
    if op_name == "canvas_get_single_assignment":
        return {"receipt": {"name": "Fake", "description": FAKE_HTML}}
    raise AssertionError("unexpected op " + op_name)


def _install_fake_dispatch():
    from dispatch import executor as ex
    real = ex.dispatch_catalog_op
    ex.dispatch_catalog_op = _fake_dispatch
    return real


def _restore_dispatch(real):
    from dispatch import executor as ex
    ex.dispatch_catalog_op = real


def _run_main(argv):
    err = io.StringIO()
    with redirect_stderr(err):
        code = runner.main(argv)
    return code, err.getvalue()


def main():
    # -- Audit mode: wired kind -------------------------------------------
    real = _install_fake_dispatch()
    try:
        DISPATCH_CALLS.clear()
        report = runner.run_audit(
            "canvas_page", "89585", {"page_url": "fake-page"},
            session=FakeSession())
    finally:
        _restore_dispatch(real)
    check("audit mode returns report", isinstance(report, dict) and report.get("mode") == "audit")
    check("audit names the manifest", report.get("audit") == "morrow_audit_course_item")
    sigs = (report.get("signals") or {}).get("observed_source_signals") or {}
    missing = sigs.get("image_tags_without_alt") or []
    check("audit finds the missing-alt image", len(missing) == 1, "got %d" % len(missing))
    check("audit names a planner route", (report.get("remediation_candidate") or {}).get("route") == "planner")
    check("audit used read effect class only",
          all(c.get("effect_class") == "read" and c.get("method") == "GET" for c in DISPATCH_CALLS),
          str(DISPATCH_CALLS))
    check("audit dispatched exactly one read", len(DISPATCH_CALLS) == 1, str(len(DISPATCH_CALLS)))

    # -- Audit mode: assignment -------------------------------------------
    real = _install_fake_dispatch()
    try:
        DISPATCH_CALLS.clear()
        report = runner.run_audit(
            "canvas_assignment", "89585", {"assignment_id": "123"},
            session=FakeSession())
    finally:
        _restore_dispatch(real)
    check("audit assignment wired", report.get("mode") == "audit"
          and report["evidence"]["catalog_op"] == "canvas_get_single_assignment")

    # -- Audit mode: unwired kinds refused ---------------------------------
    for kind in ("canvas_rubric", "canvas_file", "canvas_syllabus",
                 "canvas_discussion", "moodle_page"):
        code, err = _run_main(["audit", "--target-kind", kind, "--course-id", "89585",
                               "--target-ids", "{}", "--canvas-base", "https://x.invalid"])
        payload = None
        try:
            payload = json.loads(err.strip().splitlines()[-1] if err.strip() else "{}")
        except ValueError:
            payload = None
        check("audit refuses %s via funnel" % kind,
              code == 2 and isinstance(payload, dict) and "error" in payload,
              "code=%r err=%r" % (code, err[:120]))

    # -- Audit mode: unknown kind ------------------------------------------
    code, err = _run_main(["audit", "--target-kind", "canvas_nope", "--course-id", "89585",
                           "--target-ids", "{}", "--canvas-base", "https://x.invalid"])
    check("audit unknown kind funnels (no traceback)", code == 2 and "Traceback" not in err,
          "code=%r" % (code,))

    # -- Planner mode: validates and stops ----------------------------------
    real = _install_fake_dispatch()
    try:
        DISPATCH_CALLS.clear()
        # First audit to learn the image digest.
        audit = runner.run_audit("canvas_page", "89585", {"page_url": "fake-page"},
                                 session=FakeSession())
        missing = ((audit["signals"]["observed_source_signals"] or {})
                   .get("image_tags_without_alt") or [])[0]
        plan = runner.run_planner(
            "morrow_plan_page_image_alt_repair",
            {"course_id": "89585", "page_url": "fake-page",
             "image_index": 1,
             "image_src_sha256": missing["image_src_sha256"],
             "alt_text": "A test image description.",
             "expected_body_sha256": audit["evidence"]["body_sha256"]},
            session=FakeSession())
    finally:
        _restore_dispatch(real)
    check("planner returns plan artifact", plan.get("mode") == "plan")
    check("planner refuses dispatch", plan.get("dispatch") == "refused_in_plan_mode")
    check("planner produced a validated plan", isinstance(plan.get("validated_plan"), dict))
    check("planner made only GET reads",
          all(c.get("method") == "GET" for c in DISPATCH_CALLS), str(DISPATCH_CALLS))
    check("planner never dispatched a write",
          not any(c.get("method") in ("POST", "PUT", "DELETE", "PATCH") for c in DISPATCH_CALLS))

    # -- Planner mode: unknown planner --------------------------------------
    code, err = _run_main(["plan", "--planner", "morrow_plan_nope",
                           "--params", "{}", "--canvas-base", "https://x.invalid"])
    check("unknown planner funnels (no traceback)", code == 2 and "Traceback" not in err)

    # -- Planner mode: unwired target kind refused ---------------------------
    code, err = _run_main(["plan", "--planner", "morrow_plan_discussion_image_alt_repair",
                           "--params", json.dumps({"course_id": "89585", "discussion_id": "1"}),
                           "--canvas-base", "https://x.invalid"])
    payload = None
    try:
        payload = json.loads(err.strip().splitlines()[-1] if err.strip() else "{}")
    except ValueError:
        payload = None
    check("planner with unwired target funnels", code == 2 and isinstance(payload, dict)
          and "error" in payload, "code=%r" % (code,))

    # -- list commands --------------------------------------------------------
    code, err = _run_main(["list-targets"])
    check("list-targets works", code == 0)
    code, err = _run_main(["list-planners"])
    check("list-planners works", code == 0)

    # -- PARITY LAW: tenant strings do not alter mode availability ------------
    real = _install_fake_dispatch()
    try:
        DISPATCH_CALLS.clear()
        r1 = runner.run_audit("canvas_page", "89585", {"page_url": "fake-page"},
                              session=FakeSession())
    finally:
        _restore_dispatch(real)
    check("mode availability is tenant-independent",
          r1.get("mode") == "audit" and not DISPATCH_CALLS[0].get("params", {}).get("tenant"),
          "no tenant gating in dispatch params")

    print("\n%d passed, %d failed" % (len(PASS), len(FAIL)))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
