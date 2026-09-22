#!/usr/bin/env python3
"""A11y mode runner for Morrow for Muse: audit mode and planner mode.

This module wires the catalog/a11y/ manifests into executable modes.
It is deliberately separate from dispatch/executor.py: the F-17 carve
(2026-09-21) requires the executor to carry no a11y branches, and
dispatch/integration_selftest.py enforces their absence. This runner
uses the executor's public dispatch_catalog_op() for reads only and
never performs a write itself.

Modes
-----
Audit mode (morrow_audit_course_item):
    Read-only accessibility audit of one course target. Reads the
    target's saved HTML field through the Chromium lane, runs the 18
    ported desktop signal detectors plus the Canvas-parity and augmented
    rule sets, and returns the signal report with a remediation route
    candidate. Never writes. Needs no approval (read class).

Planner mode (morrow_plan_*_image_alt_repair):
    Plan-mode repair planning. Fresh-reads the target, VALIDATEs the
    repair plan against fresh evidence via
    a11y_repair.validate_repair_plan, produces the validated plan
    artifact, and STOPS. DISPATCH is refused inside plan entries: a
    planner never applies a change. The educator approves the validated
    plan separately; the write then dispatches through
    dispatch/executor.py with a frozen plan and an educator-signed
    approval, exactly like any other write.

Target-kind wiring
------------------
Only target kinds with a live-proven catalog read are wired. Unwired
kinds (rubric, course files, Item Bank entries, Moodle, discussions,
classic quizzes, syllabus) are refused with a named reason instead of
guessed, per the desktop known_gaps and the admission policy.

Errors
------
Unknown target kinds, unwired kinds, unknown planner names, and every
runtime failure produce a clear error through failures/funnel.py, never
a raw traceback.

Stdlib only (plus the tree's own modules).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(os.path.dirname(HERE))
for _p in (TREE, os.path.join(TREE, "dispatch"), HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from failures.funnel import agent_error_payload  # noqa: E402

import a11y_repair  # noqa: E402
import a11y_signals  # noqa: E402


# ---------------------------------------------------------------------------
# Target-kind route table.
#
# Maps an audit target_kind to (catalog_op_name, method, path_template,
# html_field, id_param, path_param). Only kinds whose read is marked
# live-proven in proof-battery/OPERATION_CATALOG.md are wired. Everything
# else is refused with a named reason (see _REFUSED_KINDS).
# ---------------------------------------------------------------------------

# (op_name, method, path_template, html_field, target_id_key, path_param_key)
_WIRED_ROUTES = {
    "canvas_page": (
        "canvas_show_page_courses",
        "GET",
        "/api/v1/courses/{course_id}/pages/{url_or_id}",
        "body",
        "page_url",
        "url_or_id",
    ),
    "canvas_assignment": (
        "canvas_get_single_assignment",
        "GET",
        "/api/v1/courses/{course_id}/assignments/{id}",
        "description",
        "assignment_id",
        "id",
    ),
    "canvas_new_quiz": (
        "canvas_get_new_quiz",
        "GET",
        "/api/quiz/v1/courses/{course_id}/quizzes/{assignment_id}",
        "instructions",
        "quiz_id",
        "assignment_id",
    ),
    "canvas_new_quiz_item": (
        "canvas_get_quiz_item",
        "GET",
        "/api/quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}",
        "entry",
        "item_id",
        "item_id",
    ),
}

# kind -> (code, reason). Refused instead of guessed.
_REFUSED_KINDS = {
    "canvas_syllabus": (
        "no_live_proven_read",
        "No live-proven catalog read exists for the course syllabus body; "
        "refusing rather than guessing a route.",
    ),
    "canvas_discussion": (
        "learner_data_gated",
        "Discussion reads are learner-data flagged and gated by the "
        "admission policy; the audit does not run them.",
    ),
    "canvas_announcement": (
        "excluded",
        "Announcements are a standing exclusion; the audit does not run them.",
    ),
    "canvas_classic_quiz": (
        "no_live_proven_read",
        "No live-proven single classic-quiz GET is in the catalog; "
        "refusing rather than guessing a route.",
    ),
    "canvas_classic_quiz_question": (
        "no_live_proven_read",
        "No live-proven classic-quiz question GET is in the catalog; "
        "refusing rather than guessing a route.",
    ),
    "canvas_rubric": (
        "rubric_remediation_blocked",
        "A rubric audit reads criteria text, but the rubric update route "
        "takes the whole criteria set as one untyped indexed hash the "
        "catalog does not encode; remediation stays blocked.",
    ),
    "canvas_item_bank_entry": (
        "stimulus_entries_blocked",
        "Stimulus entries and other unsupported Item Bank entry types "
        "return blocked_current_contract; no harvested source proved a "
        "stimulus mutation contract.",
    ),
    "canvas_file": (
        "file_reads_opt_in_bounded",
        "Canvas file reads require a separate user opt-in and are bounded "
        "at 1 MiB; the audit does not pull file bytes unasked.",
    ),
}

_MOODLE_KINDS = {
    "moodle_page", "moodle_text_media", "moodle_url", "moodle_forum",
    "moodle_choice", "moodle_glossary", "moodle_wiki", "moodle_feedback",
    "moodle_database", "moodle_book_chapter", "moodle_lesson",
    "moodle_assignment", "moodle_quiz", "moodle_quiz_question",
    "moodle_scorm", "moodle_ims",
}

_PLANNER_MANIFESTS = {
    "morrow_plan_page_image_alt_repair": "morrow_plan_page_image_alt_repair.json",
    "morrow_plan_assignment_image_alt_repair": "morrow_plan_assignment_image_alt_repair.json",
    "morrow_plan_discussion_image_alt_repair": "morrow_plan_discussion_image_alt_repair.json",
    "morrow_plan_classic_quiz_description_image_alt_repair":
        "morrow_plan_classic_quiz_description_image_alt_repair.json",
    "morrow_plan_classic_quiz_question_image_alt_repair":
        "morrow_plan_classic_quiz_question_image_alt_repair.json",
    "morrow_plan_new_quiz_choice_image_alt_repair":
        "morrow_plan_new_quiz_choice_image_alt_repair.json",
    "morrow_plan_new_quiz_item_image_alt_repair":
        "morrow_plan_new_quiz_item_image_alt_repair.json",
    "morrow_plan_new_quiz_feedback_image_alt_repair":
        "morrow_plan_new_quiz_feedback_image_alt_repair.json",
    "morrow_plan_new_quiz_answer_feedback_image_alt_repair":
        "morrow_plan_new_quiz_answer_feedback_image_alt_repair.json",
    "morrow_plan_item_bank_question_image_alt_repair":
        "morrow_plan_item_bank_question_image_alt_repair.json",
}

# Planner name -> (audit target_kind, planner kind for validate_repair_plan).
_PLANNER_TARGET_KIND = {
    "morrow_plan_page_image_alt_repair": ("canvas_page", "page"),
    "morrow_plan_assignment_image_alt_repair": ("canvas_assignment", "assignment"),
    "morrow_plan_discussion_image_alt_repair": ("canvas_discussion", "discussion"),
    "morrow_plan_classic_quiz_description_image_alt_repair":
        ("canvas_classic_quiz", "classic_quiz_description"),
    "morrow_plan_classic_quiz_question_image_alt_repair":
        ("canvas_classic_quiz_question", "classic_quiz_question"),
    "morrow_plan_new_quiz_choice_image_alt_repair":
        ("canvas_new_quiz_item", "new_quiz_choice"),
    "morrow_plan_new_quiz_item_image_alt_repair":
        ("canvas_new_quiz_item", "new_quiz_item"),
    "morrow_plan_new_quiz_feedback_image_alt_repair":
        ("canvas_new_quiz_item", "new_quiz_feedback"),
    "morrow_plan_new_quiz_answer_feedback_image_alt_repair":
        ("canvas_new_quiz_item", "new_quiz_answer_feedback"),
    "morrow_plan_item_bank_question_image_alt_repair":
        ("canvas_item_bank_entry", "item_bank_question"),
}


class A11yRunnerError(Exception):
    """Named a11y runner refusal; funneled, never a traceback."""


def _utcnow():
    return datetime.now(timezone.utc).isoformat()


def _funnel(operation, exc):
    """Translate any failure through the tree's error funnel."""
    return agent_error_payload(operation, exc)


def _need_chromium_session(canvas_base=None):
    """Attach to the live helper's Chromium (never launch a second one)."""
    tdir = os.path.join(TREE, "transport")
    if tdir not in sys.path:
        sys.path.insert(0, tdir)
    import chromium_session
    base = canvas_base or os.environ.get("CANVAS_BASE")
    if not base:
        raise A11yRunnerError(
            "CANVAS_BASE is not set: the audit runner needs the educator's "
            "Canvas host to attach the helper Chromium session.")
    return chromium_session.ChromiumSession.load(base_url=base)


def _validate_target_kind(target_kind):
    """Refuse unknown or unwired target kinds before any session exists."""
    if target_kind in _MOODLE_KINDS:
        raise A11yRunnerError(
            "moodle_not_in_v1: Moodle is proven in a sandbox but not "
            "packaged; audit mode does not run Moodle targets in v1.")
    if target_kind in _REFUSED_KINDS:
        code, reason = _REFUSED_KINDS[target_kind]
        raise A11yRunnerError("%s: %s" % (code, reason))
    if target_kind not in _WIRED_ROUTES:
        raise A11yRunnerError(
            "unknown_target_kind: %r is not a known audit target kind. "
            "Known kinds: %s." % (target_kind, ", ".join(sorted(
                list(_WIRED_ROUTES) + list(_REFUSED_KINDS) + list(_MOODLE_KINDS)))))


def _read_target_html(target_kind, course_id, target_ids, session):
    """Read one audit target's saved HTML field via catalog dispatch.

    Returns (html, read_evidence). The target kind is validated by
    _validate_target_kind before the session is created.
    """
    route = _WIRED_ROUTES[target_kind]
    op_name, method, path_template, html_field, id_key, path_param = route
    target_ids = target_ids or {}
    target_id = target_ids.get(id_key)
    if not target_id:
        raise A11yRunnerError(
            "missing_target_id: target_kind %r needs target_ids.%r." % (target_kind, id_key))
    params = {"course_id": str(course_id), path_param: str(target_id)}
    # canvas_new_quiz_item also needs the quiz's assignment id for the path.
    if target_kind == "canvas_new_quiz_item":
        quiz_id = target_ids.get("quiz_id")
        if not quiz_id:
            raise A11yRunnerError(
                "missing_target_id: target_kind 'canvas_new_quiz_item' needs "
                "target_ids.quiz_id (the New Quiz assignment id) as well as "
                "target_ids.item_id.")
        params["assignment_id"] = str(quiz_id)

    from dispatch import executor as ex
    result = ex.dispatch_catalog_op(
        op_name, method, path_template, effect_class="read",
        params=params, provider="canvas", session=session,
        require_educator_channel=True)
    body = result.get("receipt") or {}
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except ValueError:
            body = {}
    # The quiz-item entry nests the editable HTML under entry.body/content.
    html = body.get(html_field) if isinstance(body, dict) else None
    if target_kind == "canvas_new_quiz_item" and isinstance(html, dict):
        html = html.get("body") or html.get("content") or html.get("html")
    if not isinstance(html, str):
        raise A11yRunnerError(
            "no_html_field: the provider read for %r did not return a text "
            "HTML field %r; refusing to audit a non-field." % (target_kind, html_field))
    evidence = {
        "target_kind": target_kind,
        "course_id": str(course_id),
        "target_id": str(target_id),
        "catalog_op": op_name,
        "html_field": html_field,
        "body_sha256": hashlib.sha256(html.encode("utf-8")).hexdigest(),
        "html_chars": len(html),
        "read_at": _utcnow(),
    }
    return html, evidence


def _run_detectors(html):
    """Run the ported signal detectors over one HTML field."""
    report = a11y_signals.scan_html(html)
    try:
        import canvas_parity_rules
        parity = canvas_parity_rules.check_html(html)
    except Exception:
        parity = {"status": "unavailable"}
    try:
        import augmented_rules
        augmented = augmented_rules.check_html(html)
    except Exception:
        augmented = {"status": "unavailable"}
    report["canvas_parity_rules"] = parity
    report["augmented_rules"] = augmented
    return report


def _remediation_candidate(scan_report):
    """Name the repair planner route for the observed signals, if any."""
    missing = (scan_report.get("observed_source_signals") or {}).get(
        "image_tags_without_alt") or []
    if missing:
        return {
            "route": "planner",
            "planner_family": "morrow_plan_*_image_alt_repair",
            "reason": "%d image(s) without alt text; the *_image_alt_repair "
                      "planner for this target kind validates a one-image "
                      "repair plan." % len(missing),
        }
    return {
        "route": "manual_review",
        "reason": "No image-alt signals; remaining signals need human review "
                  "and have no automated planner.",
    }


def run_audit(target_kind, course_id, target_ids, provider="canvas",
              canvas_base=None, session=None):
    """Audit mode: read-only accessibility audit of one course target.

    Returns the audit report dict. Never writes. Raises A11yRunnerError
    (funneled by callers) for unknown or unwired target kinds.
    """
    if provider != "canvas":
        raise A11yRunnerError(
            "unsupported_provider: audit mode supports provider 'canvas' "
            "only; got %r." % (provider,))
    # Validate the target kind before touching any session: refusals must
    # not need a browser.
    _validate_target_kind(target_kind)
    own_session = False
    if session is None:
        session = _need_chromium_session(canvas_base)
        own_session = True
    try:
        html, evidence = _read_target_html(target_kind, course_id, target_ids, session)
        scan = _run_detectors(html)
        return {
            "mode": "audit",
            "audit": "morrow_audit_course_item",
            "evidence": evidence,
            "signals": scan,
            "remediation_candidate": _remediation_candidate(scan),
            "honesty": (
                "Signal lists are signals needing human review, never "
                "violations; no signal set establishes WCAG conformance."),
            "completed_at": _utcnow(),
        }
    finally:
        if own_session:
            close = getattr(session, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass


def run_planner(planner_name, params, canvas_base=None, session=None):
    """Planner mode: validate a repair plan, then STOP in plan mode.

    Steps: fresh read of the target, VALIDATE the plan against fresh
    evidence via a11y_repair.validate_repair_plan, produce the validated
    plan artifact. DISPATCH is refused: a planner never applies a change.

    Returns the validated plan dict. Raises A11yRunnerError (funneled by
    callers) for unknown planners, unwired target kinds, or guard
    failures.
    """
    manifest_file = _PLANNER_MANIFESTS.get(planner_name)
    if manifest_file is None:
        raise A11yRunnerError(
            "unknown_planner: %r is not a known repair planner. Known "
            "planners: %s." % (planner_name, ", ".join(sorted(_PLANNER_MANIFESTS))))
    manifest = json.load(open(os.path.join(HERE, manifest_file), encoding="utf-8"))
    if manifest.get("effects") != "plan":
        raise A11yRunnerError(
            "not_plan_effect: planner %r declares effects=%r; refusing: "
            "planners must be plan-class." % (planner_name, manifest.get("effects")))

    target_kind, planner_kind = _PLANNER_TARGET_KIND[planner_name]
    params = dict(params or {})
    course_id = str(params.get("course_id", ""))
    if not course_id:
        raise A11yRunnerError("missing_course_id: planner params need course_id.")
    # Validate before touching any session: refusals must not need a browser.
    _validate_target_kind(target_kind)

    own_session = False
    if session is None:
        session = _need_chromium_session(canvas_base)
        own_session = True
    try:
        # Step 1: fresh read of the target (plan mode reads are allowed).
        html, evidence = _read_target_html(
            target_kind, course_id, _planner_target_ids(planner_name, params), session)
        # Step 2: VALIDATE the plan against fresh evidence.
        scan = a11y_signals.scan_html(html)
        validate_evidence = {
            "body_sha256": evidence["body_sha256"],
            "missing_alt": (scan.get("observed_source_signals") or {}).get(
                "image_tags_without_alt") or [],
        }
        # The educator may pass expected_body_sha256 from a prior audit.
        # If they did not, the plan is validated against the fresh read this
        # runner just performed (read and validate are atomic here), which
        # still enforces every other guard. An explicitly stale digest is
        # still refused.
        validate_params = dict(params)
        if not validate_params.get("expected_body_sha256"):
            validate_params["expected_body_sha256"] = evidence["body_sha256"]
        try:
            validated = a11y_repair.validate_repair_plan(
                planner_kind, validate_params, validate_evidence)
        except a11y_repair.RepairPlanRefused as exc:
            raise A11yRunnerError("plan_refused: %s" % exc)
        # Step 3: APPROVE stops here. DISPATCH is refused inside plan
        # entries: the validated plan is the artifact; the educator
        # approves it separately and the write dispatches through
        # dispatch/executor.py with a frozen plan.
        plan_artifact = {
            "mode": "plan",
            "planner": planner_name,
            "manifest": manifest_file,
            "target": {
                "target_kind": target_kind,
                "course_id": course_id,
                "body_sha256": evidence["body_sha256"],
            },
            "validated_plan": validated,
            "dispatch": "refused_in_plan_mode",
            "dispatch_note": (
                "Plan mode produces the validated plan artifact without "
                "executing. To apply it, the educator approves this exact "
                "plan and it dispatches through dispatch/executor.py as a "
                "write with a frozen plan and an educator-signed approval."),
            "validated_at": _utcnow(),
        }
        return plan_artifact
    finally:
        if own_session:
            close = getattr(session, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass


def _planner_target_ids(planner_name, params):
    """Map planner params to the audit target_ids for the fresh read."""
    target_kind, _ = _PLANNER_TARGET_KIND[planner_name]
    route = _WIRED_ROUTES[target_kind]  # validated before the session exists
    _, _, _, _, id_key, _ = route
    ids = {}
    # The planner params carry the target id under the manifest's own key.
    for key in ("page_url", "assignment_id", "discussion_id", "quiz_id",
                "question_id", "item_id", "bank_id", "bank_entry_id"):
        if params.get(key) is not None:
            ids[key] = params[key]
    # Normalize to the route's id key.
    if id_key not in ids:
        # e.g. new_quiz planners carry quiz_id for the assignment id.
        fallback = {"url_or_id": "page_url", "id": "assignment_id",
                    "assignment_id": "quiz_id", "item_id": "item_id"}.get(id_key)
        if fallback and params.get(fallback) is not None:
            ids[id_key] = params[fallback]
    return ids


def _parse_params(text):
    try:
        params = json.loads(text or "{}")
    except ValueError as exc:
        raise A11yRunnerError("bad_params_json: %s" % exc)
    if not isinstance(params, dict):
        raise A11yRunnerError("bad_params_json: params must be a JSON object.")
    return params


def _summarize_entry(entry, limit=120):
    """One-line summary of a signal/finding entry (defensive)."""
    if not isinstance(entry, dict):
        return ("entry: %s" % entry)[:limit]
    parts = []
    for key in sorted(entry):
        if key in ("why", "detail"):
            continue
        val = entry[key]
        if isinstance(val, str) and len(val) > 48:
            val = val[:45] + "..."
        parts.append("%s=%s" % (key, val))
    return (", ".join(parts))[:limit]


def render_human(report):
    """Render an audit report as human-readable text.

    QOL-1 (2026-09-22): the default JSON output is unchanged; this is an
    opt-in presentation layer for operators and educators. It reads the
    report dict only and never touches the provider. No em dashes.
    """
    lines = []
    evidence = report.get("evidence") or {}
    lines.append("Accessibility audit: %s in course %s (target %s)" % (
        evidence.get("target_kind", "?"),
        evidence.get("course_id", "?"),
        evidence.get("target_id", "?")))
    lines.append("HTML read: %s chars (sha256 %s...)" % (
        evidence.get("html_chars", "?"),
        str(evidence.get("body_sha256", ""))[:12]))
    lines.append("Completed: %s" % report.get("completed_at", "?"))
    lines.append("")

    signals = report.get("signals") or {}
    observed = signals.get("observed_source_signals") or {}
    found = [(name, entries) for name, entries in observed.items() if entries]
    clear = sum(1 for entries in observed.values() if not entries)
    lines.append("SOURCE SIGNALS (%d found, %d clear)" % (len(found), clear))
    if not found:
        lines.append("  none: no source signals observed")
    for name, entries in sorted(found):
        pretty = name.replace("_", " ")
        lines.append("  [%s] %d occurrence(s)" % (pretty, len(entries)))
        for entry in entries[:3]:
            lines.append("    - %s" % _summarize_entry(entry))
        if len(entries) > 3:
            lines.append("    - ... and %d more" % (len(entries) - 3))
    lines.append("")

    parity = signals.get("canvas_parity_rules") or {}
    pfind = parity.get("findings") if isinstance(parity, dict) else None
    if not isinstance(pfind, list):
        lines.append("CANVAS PARITY RULES: unavailable (%s)" %
                     (parity.get("status", "?") if isinstance(parity, dict)
                      else "unexpected shape"))
    else:
        lines.append("CANVAS PARITY RULES (%d findings)" % len(pfind))
        if not pfind:
            lines.append("  none")
        for finding in pfind:
            rule = finding.get("rule_id", "?")
            msg = finding.get("message", "")
            loc = finding.get("locator")
            line = "  [%s] %s" % (rule, msg)
            if loc:
                line += " (%s)" % loc
            if finding.get("approximate"):
                line += " [approximate]"
            lines.append(line)
    lines.append("")

    augmented = signals.get("augmented_rules") or {}
    afind = augmented.get("findings") if isinstance(augmented, dict) else None
    if not isinstance(afind, list):
        lines.append("MORROW AUGMENTED RULES: unavailable (%s)" %
                     (augmented.get("status", "?") if isinstance(augmented, dict)
                      else "unexpected shape"))
    else:
        lines.append("MORROW AUGMENTED RULES (%d findings)" % len(afind))
        if not afind:
            lines.append("  none")
        for finding in afind:
            rule = finding.get("rule_id", "?")
            msg = finding.get("message", "")
            lines.append("  [%s] %s" % (rule, msg))
    lines.append("")

    cand = report.get("remediation_candidate") or {}
    lines.append("REMEDIATION")
    lines.append("  route: %s" % cand.get("route", "?"))
    if cand.get("planner_family"):
        lines.append("  planner: %s" % cand.get("planner_family"))
    lines.append("  reason: %s" % cand.get("reason", ""))
    lines.append("")
    lines.append("Note: %s" % report.get("honesty", ""))
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Morrow for Muse a11y mode runner: audit mode and "
                    "planner mode (plan-class, never dispatches writes).")
    parser.add_argument("--canvas-base", default=os.environ.get("CANVAS_BASE"),
                        help="Canvas host (or CANVAS_BASE env).")
    sub = parser.add_subparsers(dest="command", required=True)

    p_audit = sub.add_parser("audit", help="Run audit mode on one target.")
    p_audit.add_argument("--canvas-base", default=os.environ.get("CANVAS_BASE"))
    p_audit.add_argument("--target-kind", required=True)
    p_audit.add_argument("--course-id", required=True)
    p_audit.add_argument("--target-ids", default="{}",
                         help="JSON object of target-kind-specific ids.")
    p_audit.add_argument("--provider", default="canvas")
    p_audit.add_argument("--format", default="json", choices=("json", "human"),
                         help="QOL-1: output format. json (default) prints "
                              "the machine-readable report; human prints a "
                              "readable summary of the same report.")

    p_plan = sub.add_parser("plan", help="Run planner mode (validates, never writes).")
    p_plan.add_argument("--canvas-base", default=os.environ.get("CANVAS_BASE"))
    p_plan.add_argument("--planner", required=True,
                        help="Planner name, e.g. morrow_plan_page_image_alt_repair.")
    p_plan.add_argument("--params", default="{}",
                        help="Planner params as a JSON object.")

    sub.add_parser("list-targets", help="List wired and refused target kinds.")
    sub.add_parser("list-planners", help="List known planner names.")

    args = parser.parse_args(argv)

    try:
        if args.command == "list-targets":
            print(json.dumps({
                "wired": sorted(_WIRED_ROUTES),
                "refused": {k: v[0] for k, v in _REFUSED_KINDS.items()},
                "moodle_refused_in_v1": sorted(_MOODLE_KINDS),
            }, indent=2))
            return 0
        if args.command == "list-planners":
            print(json.dumps({"planners": sorted(_PLANNER_MANIFESTS)}, indent=2))
            return 0
        if args.command == "audit":
            report = run_audit(
                args.target_kind, args.course_id,
                _parse_params(args.target_ids), provider=args.provider,
                canvas_base=args.canvas_base)
            if args.format == "human":
                print(render_human(report))
            else:
                print(json.dumps(report, indent=2))
            return 0
        if args.command == "plan":
            plan = run_planner(
                args.planner, _parse_params(args.params),
                canvas_base=args.canvas_base)
            print(json.dumps(plan, indent=2))
            return 0
    except Exception as exc:
        payload = _funnel("a11y %s" % (args.command or "runner"), exc)
        print(json.dumps(payload), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
