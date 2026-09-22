#!/usr/bin/env python3
"""Result presentation for the failed-students query chain.

Privacy posture (the tree's standing rule): learner PII is NEVER
agent-visible without the educator's explicit consent. Live results are
projected through privacy/executor_wire.project_learner_result before
they become agent-visible:

- no consent file -> stable "Student A<n>" labels (deterministic per
  course scope, persisted in the educator-local source vault)
- educator hand-created consent file
  <tree-state-dir>/educator_pii_reveal (0600, documented purpose >= 12
  chars) -> real names, with the reveal audited on the result

Synthetic fixtures are fake people: they render with their fixture
names under a loud SYNTHETIC banner and never touch the vault.

Stdlib only.
"""

from __future__ import annotations

import os
import sys

_TREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE_ROOT not in sys.path:
    sys.path.insert(0, _TREE_ROOT)

from privacy import executor_wire as _wire  # noqa: E402


def project_live(course_id, rows, tenant_base):
    """Project live learner rows through the privacy boundary.

    rows: list of {"user_id", "name", ...} harvested from submissions,
    in a stable order. Returns (projected_rows, reveal_audit_or_None).
    Each projected row carries "display_name": the stable "Student
    A<n>" label, or the real name when the educator's consent file
    reveals it. Correlation back to the caller's rows uses the
    non-PII "qord" key, which the boundary preserves.
    """
    entry = {
        "name": "query_failed_students",
        "provider": "canvas",
        "catalog_learner_data": True,
        "request": {
            "url": "%s/api/v1/courses/%s/assignments/submissions"
                   % (tenant_base, course_id),
        },
    }
    receipt = []
    for i, row in enumerate(rows):
        receipt.append(dict(row, qord=i))
    projected, reveal = _wire.project_learner_result(
        entry, {"receipt": receipt}, tenant_base, error_cls=RuntimeError)
    out = []
    for prow in projected.get("receipt", []):
        name = prow.get("learnerToken")
        if reveal is not None:
            # Consent reveal: the boundary returns the real identity.
            name = (prow.get("name") or prow.get("sortable_name")
                    or prow.get("short_name") or name)
        out.append({"qord": prow.get("qord"), "display_name": name})
    out.sort(key=lambda r: (r["qord"] is None, r["qord"]))
    return out, reveal


def render(report, synthetic=False):
    """Render the final educator-facing text.

    report: {"quiz_title", "quiz_id", "window", "effective_date",
             "threshold_source", "fail_below_points", "points_possible",
             "failed": [...], "passed_count", "excused_count",
             "ungraded_count", "reveal_audit", "data_provenance"}
    Each failed row: {"display_name", "score", "percent", "missing",
                      "late", "detail"}.
    """
    lines = []
    if synthetic:
        lines.append("*** SYNTHETIC FIXTURE RESULT: no real students; "
                     "names below are fake ***")
    q = report["quiz_title"]
    lines.append("Students who failed %r (quiz id %s)" % (q,
                                                          report["quiz_id"]))
    lines.append("Quiz window: %s; effective date %s (%s)" % (
        report["window"], report["effective_date"],
        report["effective_field"]))
    lines.append("Fail threshold: below %s points of %s (%s)" % (
        report["fail_below_points"], report["points_possible"],
        report["threshold_source"]))
    failed = report["failed"]
    if not failed:
        lines.append("No students failed: %d passed, %d excused, %d "
                     "ungraded/missing-grade." % (
                         report["passed_count"], report["excused_count"],
                         report["ungraded_count"]))
    else:
        lines.append("%d failed:" % len(failed))
        for row in failed:
            if row["missing"]:
                score_txt = "missing (no submission)"
            elif row["score"] is None:
                score_txt = "ungraded"
            else:
                score_txt = "%s/%s" % (row["score"],
                                       report["points_possible"])
                if row["percent"] is not None:
                    score_txt += " (%.1f%%)" % row["percent"]
            late_txt = " [late]" if row.get("late") else ""
            lines.append("  - %s: %s%s (%s)" % (
                row["display_name"], score_txt, late_txt, row["detail"]))
    if report.get("reveal_audit"):
        lines.append("Real names shown under your consent file (%s)" %
                     report["reveal_audit"].get("reason", ""))
    else:
        lines.append("Names are de-identified (Student A<n> labels); the "
                     "educator can reveal them via the consent file at %s"
                     % _wire.consent_path())
    lines.append("Data source: %s" % report["data_provenance"])
    return "\n".join(lines)
