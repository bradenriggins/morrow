#!/usr/bin/env python3
"""Fail determination for the failed-students query chain.

Exact "failed" semantics (documented, tested):

- A submission is FAILED when its earned credit falls below the FAIL
  THRESHOLD. The threshold, in precedence order:
    1. the educator's explicit threshold ("below 70%", "under 40 points")
    2. the course grading standard's F cutoff (letter_grade/gpa_scale
       assignments, when a standard is attached and readable)
    3. the default: 60% of points_possible
  Which source was used is always reported; the chain never applies a
  threshold silently.
- percent = score / points_possible (points_possible comes from the
  ASSIGNMENT record; the submission row's points_possible is null in
  practice, verified live on course 89585). points_possible null or 0
  with a points/percent grading type -> ThresholdUndefined: a percent
  cannot be computed, and the chain says so instead of dividing.
- grading_type dispatch:
    points / percent: fail iff score < threshold_points. score null
      with workflow_state submitted/graded -> treated as 0? NO: a null
      score on a submitted quiz means ungraded; it is reported as
      UNGRADED (unknown), not failed. A null score is only a failure
      when the submission is missing.
    letter_grade / gpa_scale: map through the grading standard when
      available (fail iff the letter maps at/below the F cutoff);
      without a standard, fall back to the percent threshold on the
      numeric score when present, else UNGRADED.
    pass_fail: fail iff grade == "incomplete" (Canvas's own verdict);
      score is ignored. A pass_fail submission with no grade and no
      submission is missing -> failed (missing).
    not_graded: ThresholdUndefined, always. There is no grade, so
      "failed" is meaningless.
- missing submissions (missing=True, or workflow_state 'unsubmitted'
  with no score): counted as FAILED with flag missing=True, reported
  distinctly ("did not submit", effective 0). Excused (excused=True)
  submissions are EXCLUDED from the failed list entirely and reported
  separately; excused is never a failure.
- late=True does not change pass/fail; it is reported as context.

Stdlib only.
"""

from __future__ import annotations


class ThresholdUndefined(Exception):
    """No meaningful fail threshold exists for this assignment."""

    def __init__(self, reason):
        super().__init__("fail threshold undefined: %s" % reason)
        self.reason = reason


DEFAULT_FAIL_PERCENT = 60.0
_EPS = 1e-9

_MISSING_STATES = frozenset({"unsubmitted"})
_FAIL_GRADES = frozenset({"incomplete"})
_PASS_GRADES = frozenset({"complete"})


def _num(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def threshold_points(assignment, explicit, grading_standard=None):
    """Return (fail_below_points, source_description).

    Raises ThresholdUndefined when no threshold can be computed.
    """
    grading_type = (assignment or {}).get("grading_type") or "points"
    if grading_type == "not_graded":
        raise ThresholdUndefined(
            "assignment %r is not_graded: there is no grade, so "
            "'failed' is meaningless" % (assignment or {}).get("id"))
    points_possible = _num((assignment or {}).get("points_possible"))

    if explicit is not None and explicit.get("kind") == "points":
        return float(explicit["value"]), "educator-specified %s points" % (
            explicit["value"])

    if points_possible is None or points_possible <= 0:
        if grading_type == "pass_fail":
            # pass/fail needs no points; Canvas's grade is the verdict.
            return None, "pass_fail: Canvas grade is the verdict"
        raise ThresholdUndefined(
            "points_possible is %r on assignment %r: a percent "
            "threshold cannot be computed" % (
                (assignment or {}).get("points_possible"),
                (assignment or {}).get("id")))

    if explicit is not None and explicit.get("kind") == "percent":
        pct = float(explicit["value"])
        return points_possible * pct / 100.0, \
            "educator-specified %s%% of %s points" % (explicit["value"],
                                                      points_possible)

    if explicit is not None and explicit.get("kind") == "letter_f" \
            and grading_standard:
        cutoff = _f_cutoff(grading_standard)
        if cutoff is not None:
            return points_possible * cutoff / 100.0, \
                "grading standard F cutoff (%s%%)" % cutoff

    if grading_type in ("letter_grade", "gpa_scale") and grading_standard:
        cutoff = _f_cutoff(grading_standard)
        if cutoff is not None:
            return points_possible * cutoff / 100.0, \
                "grading standard F cutoff (%s%%)" % cutoff

    return points_possible * DEFAULT_FAIL_PERCENT / 100.0, \
        "default %s%% of %s points" % (DEFAULT_FAIL_PERCENT, points_possible)


def _f_cutoff(grading_standard):
    """Fail-threshold percent from a grading standard.

    Canvas scheme rows are [{"name": "A", "value": 0.94}, ...] with
    value as a fraction of 1 (older custom schemes may use percents).
    The fail threshold is the lowest PASSING boundary: the minimum
    value over rows with value > 0 (the boundary that still earns a
    non-F grade, e.g. the D row), normalized to a percent. Using the
    scheme minimum (usually the F row at 0) would wrongly make
    everything "passed". Returns None when no usable boundary exists.
    """
    try:
        scheme = grading_standard.get("grading_scheme") or []
        vals = [float(row.get("value")) for row in scheme
                if isinstance(row, dict) and row.get("value") is not None]
    except (TypeError, ValueError):
        return None
    passing = [v for v in vals if v > 0]
    if not passing:
        return None
    fractional = max(vals) <= 1.0
    return min(passing) * (100.0 if fractional else 1.0)


def classify(submission, assignment, fail_below_points, threshold_source):
    """Classify one submission.

    Returns a dict: {"verdict": "failed"|"passed"|"excused"|"ungraded",
                     "missing": bool, "score": float|None,
                     "percent": float|None, "detail": str}.
    """
    sub = submission or {}
    grading_type = (assignment or {}).get("grading_type") or "points"
    points_possible = _num((assignment or {}).get("points_possible"))
    score = _num(sub.get("score"))
    grade = sub.get("grade")
    excused = bool(sub.get("excused"))
    missing = bool(sub.get("missing"))
    state = (sub.get("workflow_state") or "").lower()
    late = bool(sub.get("late"))

    if excused:
        return {"verdict": "excused", "missing": False, "score": score,
                "percent": None, "late": late,
                "detail": "excused: excluded from the failed list"}

    if grading_type == "pass_fail":
        if isinstance(grade, str) and grade.lower() in _FAIL_GRADES:
            return {"verdict": "failed", "missing": False, "score": score,
                    "percent": None, "late": late,
                    "detail": "pass_fail grade 'incomplete'"}
        if isinstance(grade, str) and grade.lower() in _PASS_GRADES:
            return {"verdict": "passed", "missing": False, "score": score,
                    "percent": None, "late": late,
                    "detail": "pass_fail grade 'complete'"}
        if score is None or missing or state in _MISSING_STATES:
            return {"verdict": "failed", "missing": True, "score": None,
                    "percent": None, "late": late,
                    "detail": "no submission and no pass_fail grade"}
        return {"verdict": "ungraded", "missing": False, "score": score,
                "percent": None, "late": late,
                "detail": "pass_fail with no grade yet; cannot call it "
                          "failed"}

    is_missing = missing or (score is None and state in _MISSING_STATES)
    if is_missing:
        return {"verdict": "failed", "missing": True, "score": None,
                "percent": 0.0, "late": late,
                "detail": "missing submission (effective 0)"}

    if score is None:
        return {"verdict": "ungraded", "missing": False, "score": None,
                "percent": None, "late": late,
                "detail": "submitted but not yet graded; a null score is "
                          "not a failure"}

    percent = (score / points_possible * 100.0) \
        if points_possible else None

    if grading_type in ("letter_grade", "gpa_scale") and grade:
        # The letter is Canvas's verdict; still cross-check the number.
        detail = "letter grade %r" % grade
    else:
        detail = "%s of %s (%s)" % (
            score, points_possible,
            ("%.1f%%" % percent) if percent is not None else "no percent")

    failed = fail_below_points is not None and \
        score < fail_below_points - _EPS
    return {"verdict": "failed" if failed else "passed",
            "missing": False, "score": score, "percent": percent,
            "late": late,
            "detail": "%s vs threshold %s (%s)" % (
                detail,
                ("%.2f" % fail_below_points)
                if fail_below_points is not None else "n/a",
                threshold_source)}


def fetch_grading_standard(reader, course_id):
    """Best-effort fetch of the course grading standard.

    Returns the standard record dict, or None when the course has no
    standard attached or it cannot be read. Never raises: the threshold
    logic falls back to the default and says so.
    """
    try:
        course = reader.get_json(
            "/api/v1/courses/%s?include[]=grading_standard" % course_id)
    except Exception:
        return None
    gsid = (course or {}).get("grading_standard_id")
    if not gsid:
        return None
    try:
        return reader.get_json(
            "/api/v1/courses/%s/grading_standards/%s" % (course_id, gsid))
    except Exception:
        return None
