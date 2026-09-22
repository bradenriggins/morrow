#!/usr/bin/env python3
"""The failed-students query chain: typed arguments -> genuine results.

The agent reads the educator's words and passes typed arguments (the
course, the quiz window, and at most one threshold). No code here reads
the educator's text.

Links:
  1. argument check: the course is a Canvas course number, the quiz
     window is "last_week" or "this_week", and the threshold is one of
     below_percent (0-100), below_points (>= 0), or letter_f.
  2. quiz_resolve.resolve: the quiz window -> exactly one quiz, with
     exact week/effective-date semantics; zero or multiple matches
     raise instead of silently picking.
  3. submissions fetch: paginated GET
     /api/v1/courses/{id}/assignments/{aid}/submissions with
     include[]=user, following Link rel="next" (never a silent
     partial collection).
  4. thresholds.classify: per-submission failed/passed/excused/
     ungraded with a named threshold source.
  5. present: de-identified educator result through the privacy
     boundary (labels; a student the educator named in this
     conversation is echoed by that name, see privacy/name_echo).

Every chain failure routes through failures/translator.py so the
agent-visible message is the catalog's, never a raw traceback.

Stdlib only.
"""

from __future__ import annotations

import os
import re
import sys

_TREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE_ROOT not in sys.path:
    sys.path.insert(0, _TREE_ROOT)

from query import live_read as _live_read
from query import present as _present
from query import quiz_resolve as _qr
from query import thresholds as _th
from failures import translator as _translator


class ChainResult:
    def __init__(self, text, report, provenance):
        self.text = text
        self.report = report
        self.provenance = provenance


class ChainFailure(Exception):
    """A chain step failed and was translated for the agent surface.

    Carries the failures/translator.py TranslatedError (a dataclass,
    not raisable) in .translated. The caller renders
    .translated.agent_message; nothing raw or PII-bearing escapes.
    """

    def __init__(self, translated):
        super().__init__(translated.mode_id)
        self.translated = translated


class SessionMissing(Exception):
    """No Canvas tenant is configured for this chain run.

    Named to match the failures catalog's setup-tenant-not-configured
    signature (error_class SessionMissing + "needs a Canvas base URL"),
    so the missing-tenant case gets the warm first-run message instead
    of the unknown fallback. (2026-09-22 first-run audit.)
    """


def _translate_helper_failure(exc):
    """Map a helper/Chromium/session LiveReadError to catalog evidence.

    Health-check failures used to fall through to the unknown fallback.
    They are translated as normalized evidence dicts (the translator's
    documented dict input contract) matching the same catalog entries
    the executor's admission checks use: helper-down for an unreachable
    helper, and the session-dead family (canvas-session-dead) for a dead
    Chromium or a signed-out session, exactly as the executor classifies
    ChromiumSessionDead. Only evidence the chain actually observed is
    claimed: when /status answered, the helper is reachable.
    (2026-09-22 first-run audit.)
    """
    msg = str(exc)
    low = msg.lower()
    base = {"provider": "helper", "detail": msg}
    if "not alive" in low:
        # /status answered, so the helper is up; its browser is dead.
        evidence = dict(base, error="ChromiumSessionDead",
                        helper_reachable=True, chromium_alive=False,
                        session_dead_signal=True)
    elif ("not logged in" in low or "signed in" in low
            or "signed-in" in low):
        evidence = dict(base, error="SessionDead",
                        session_dead_signal=True)
    elif ("helper" in low
            and ("/status failed" in low or "refused" in low
                 or "timed out" in low or "unreachable" in low)):
        evidence = dict(base, error="ExecutorError",
                        detail="login helper endpoint is down: " + msg)
    else:
        return _translate("helper health check", exc)
    return _translate("helper health check", evidence)


_SUBMISSIONS_READ = {
    "method": "GET",
    "url": "{canvas_base}/api/v1/courses/{course_id}/assignments/"
           "{assignment_id}/submissions"}


def _require_live_proven(block):
    """Refuse unless the block is a live-proven row of
    proof-battery/OPERATION_CATALOG.md (same gate as the executor)."""
    from dispatch import executor as _ex
    _ex.live_proven_gate({"name": "query.failed_students",
                          "request": block}, journal=False)


class QueryArgumentsInvalid(ValueError):
    """The typed arguments to the failed-students query are not valid."""


QUIZ_WINDOWS = ("last_week", "this_week")


def _checked_number(name, value, low, high=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise QueryArgumentsInvalid(
            "%s must be a number, got %r" % (name, value))
    if value < low or (high is not None and value > high):
        raise QueryArgumentsInvalid(
            "%s must be between %s and %s, got %r"
            % (name, low, high if high is not None else "any", value))
    return float(value)


def _checked_arguments(quiz, below_percent, below_points, letter_f):
    """(quiz_ref, threshold) for thresholds.threshold_points, or raise."""
    if quiz not in QUIZ_WINDOWS:
        raise QueryArgumentsInvalid(
            "quiz must be one of %s, got %r" % (", ".join(QUIZ_WINDOWS),
                                                quiz))
    given = [n for n, v in (("below_percent", below_percent),
                            ("below_points", below_points),
                            ("letter_f", letter_f or None)) if v is not None]
    if len(given) > 1:
        raise QueryArgumentsInvalid(
            "give at most one threshold, got %s" % ", ".join(given))
    threshold = None
    if below_percent is not None:
        threshold = {"kind": "percent", "value": _checked_number(
            "below_percent", below_percent, 0, 100)}
    elif below_points is not None:
        threshold = {"kind": "points", "value": _checked_number(
            "below_points", below_points, 0)}
    elif letter_f:
        threshold = {"kind": "letter_f"}
    return {"kind": quiz}, threshold


class InvalidCourseId(ValueError):
    """The course the chain was given is not a Canvas course number."""


# The course id is interpolated into request paths, so only a plain
# Canvas course number is accepted.
_COURSE_ID_RE = re.compile(r"[1-9][0-9]{0,15}")
_ID_SEGMENT_RE = re.compile(r"/\d+(?=/|$)")


def _checked_course_id(course_id):
    if isinstance(course_id, int) and not isinstance(course_id, bool):
        course_id = str(course_id)
    if not isinstance(course_id, str) \
            or not _COURSE_ID_RE.fullmatch(course_id):
        raise InvalidCourseId(
            "course id %r is not a Canvas course number; nothing was read"
            % (course_id,))
    return course_id


class _GatedReader:
    """Every read the chain makes passes the live-proven catalog gate
    first, matched by its path template (numeric ids as slots)."""

    def __init__(self, reader):
        self._reader = reader

    @staticmethod
    def _gate(path):
        template = _ID_SEGMENT_RE.sub("/{id}", str(path).split("?", 1)[0])
        _require_live_proven({"method": "GET",
                              "url": "{canvas_base}" + template})

    def get_paginated(self, path):
        self._gate(path)
        return self._reader.get_paginated(path)

    def get_json(self, path):
        self._gate(path)
        return self._reader.get_json(path)

    def __getattr__(self, name):
        return getattr(self._reader, name)


def _translate(operation, exc):
    """Route a chain failure through failures/translator.py.

    Returns a ChainFailure wrapping the TranslatedError, because
    TranslatedError is a dataclass and cannot be raised.
    """
    return ChainFailure(_translator.translate(operation, exc))


def run_query(course_id, quiz, below_percent=None, below_points=None,
              letter_f=False, reader=None, tenant_base=None,
              now_utc=None, synthetic_rows=None, progress=None):
    """Run the full chain.

    course_id: Canvas course id.
    quiz: the quiz window, "last_week" or "this_week".
    below_percent / below_points / letter_f: at most one explicit fail
        threshold; none means the assignment's own default.
    reader: a LiveReader (default: create and health-check one).
    tenant_base: tenant origin for the privacy binding.
    synthetic_rows: when set, a list of synthetic (fixture) submission
        dicts used INSTEAD of live submissions; the result is loudly
        labeled synthetic and never touches the learner vault.
    progress: QOL-3 (2026-09-22): optional callable(stage, detail)
        invoked as the chain advances (stderr reporting in main()). It
        is purely observational: calls are guarded so a misbehaving
        callback can never break or alter the query result. None
        (default) preserves the exact prior behavior.

    Returns ChainResult. Raises ChainFailure for chain failures
    (the caller renders .translated.agent_message).
    """
    def _prog(stage, detail=""):
        if progress is None:
            return
        try:
            progress(stage, detail)
        except Exception:
            pass

    operation = "find students who failed %s's quiz" % (
        str(quiz).replace("_", " "))
    own_reader = False
    try:
        try:
            course_id = _checked_course_id(course_id)
        except InvalidCourseId as exc:
            raise _translate(operation, exc)
        try:
            quiz_ref, threshold = _checked_arguments(
                quiz, below_percent, below_points, letter_f)
        except QueryArgumentsInvalid as exc:
            raise _translate(operation, exc)
        parsed = {"quiz_ref": quiz_ref, "threshold": threshold}
        _prog("arguments_checked", str(quiz_ref))

        if reader is None:
            tenant_base = tenant_base or _live_read.TENANT_BASE
            if not tenant_base:
                # Fail closed BEFORE the browser lane initializes: the
                # privacy binding needs a real tenant origin, and a fresh
                # install should get the setup-tenant-not-configured
                # message, not a helper/Chromium failure or the unknown
                # fallback. (2026-09-22 first-run audit.)
                raise _translate(
                    operation,
                    SessionMissing("query chain needs a Canvas base URL: set "
                                   "CANVAS_BASE or pass tenant_base"))
            reader = _live_read.LiveReader()
            own_reader = True
            try:
                reader.health_check()
            except _live_read.LiveReadError as exc:
                raise _translate_helper_failure(exc)
        else:
            tenant_base = tenant_base or _live_read.TENANT_BASE
        _prog("reader_ready")
        reader = _GatedReader(reader)
        if not tenant_base:
            # Defensive: an injected reader with no configured tenant.
            raise _translate(
                operation,
                SessionMissing("query chain needs a Canvas base URL: set "
                               "CANVAS_BASE or pass tenant_base"))

        try:
            quiz, assignment, ctx = _qr.resolve(
                reader, course_id, parsed["quiz_ref"], now_utc=now_utc)
        except (_qr.QuizNotFound, _qr.QuizAmbiguous,
                _qr.UnsupportedQuizRef) as exc:
            raise _translate(operation, exc)
        _prog("quiz_resolved", str(quiz.get("title", "")))

        assignment = assignment or {}
        # New Quizzes carry grading metadata on the quiz record itself.
        aid = assignment.get("id") or quiz.get("id")
        grading_type = assignment.get("grading_type") or \
            quiz.get("grading_type") or "points"
        points_possible = assignment.get("points_possible")
        if points_possible is None:
            points_possible = quiz.get("points_possible")
        assignment = dict(assignment)
        assignment.setdefault("id", aid)
        assignment["grading_type"] = grading_type
        assignment["points_possible"] = points_possible

        grading_standard = _th.fetch_grading_standard(reader, course_id)
        try:
            fail_below, threshold_source = _th.threshold_points(
                assignment, parsed["threshold"], grading_standard)
        except _th.ThresholdUndefined as exc:
            raise _translate(operation, exc)
        _prog("threshold_computed", str(threshold_source))

        if synthetic_rows is not None:
            submissions = list(synthetic_rows)
            provenance = "SYNTHETIC fixtures (clearly labeled; no live " \
                "learner data read)"
        else:
            # Only live-proven catalog operations may run: the
            # submissions list (a learner-data row) must be proven
            # through the catalog before this chain reads it live.
            try:
                _require_live_proven(_SUBMISSIONS_READ)
            except Exception as exc:  # CatalogNotProven or unreadable catalog
                raise _translate(operation, exc)
            status, submissions, note = reader.get_paginated(
                "/api/v1/courses/%s/assignments/%s/submissions"
                "?per_page=100&include[]=user" % (course_id, aid))
            if status != 200:
                raise _translate(
                    operation,
                    _live_read.LiveReadError(
                        "submissions list returned HTTP %s%s" % (
                            status, (" (%s)" % note) if note else "")))
            if note:
                raise _translate(
                    operation,
                    _live_read.LiveReadError(
                        "submissions list was truncated (%s); refusing to "
                        "report a partial class" % note))
            provenance = "LIVE Canvas reads (quizzes, assignments, " \
                "submissions) through the helper's authenticated browser"
        _prog("submissions_fetched", "%d rows (%s)" % (
            len(submissions),
            "synthetic" if synthetic_rows is not None else "live"))

        classified = [_th.classify(s, assignment, fail_below,
                                   threshold_source)
                      for s in submissions if isinstance(s, dict)]

        failed_rows, passed_n, excused_n, ungraded_n = [], 0, 0, 0
        for sub, cls in zip(
                [s for s in submissions if isinstance(s, dict)],
                classified):
            verdict = cls["verdict"]
            if verdict == "failed":
                failed_rows.append((sub, cls))
            elif verdict == "passed":
                passed_n += 1
            elif verdict == "excused":
                excused_n += 1
            else:
                ungraded_n += 1
        _prog("classified", "%d failed, %d passed, %d excused, %d ungraded"
              % (len(failed_rows), passed_n, excused_n, ungraded_n))

        if synthetic_rows is not None:
            display_rows = []
            for sub, cls in failed_rows:
                display_rows.append({
                    "display_name": str(sub.get("name") or
                                        "Fixture %s" % sub.get("user_id")),
                    "score": cls["score"], "percent": cls["percent"],
                    "missing": cls["missing"], "late": cls["late"],
                    "detail": cls["detail"]})
            reveal_audit = None
        else:
            learner_rows = []
            for sub, _cls in failed_rows:
                user = sub.get("user") or {}
                learner_rows.append({
                    "user_id": sub.get("user_id"),
                    "name": user.get("name"),
                    "sortable_name": user.get("sortable_name"),
                    "short_name": user.get("short_name"),
                })
            projected, reveal_audit = _present.project_live(
                str(course_id), learner_rows, tenant_base)
            label_by_qord = {p["qord"]: p["display_name"] for p in projected}
            display_rows = []
            for i, (sub, cls) in enumerate(failed_rows):
                display_rows.append({
                    "display_name": label_by_qord.get(i, "Student ?"),
                    "score": cls["score"], "percent": cls["percent"],
                    "missing": cls["missing"], "late": cls["late"],
                    "detail": cls["detail"]})

        eff, eff_field = _qr.effective_date(quiz, assignment)
        win_start, win_end = _qr.last_week_window(now_utc)
        report = {
            "quiz_title": quiz.get("title"),
            "quiz_id": quiz.get("id"),
            "window": "%s..%s (America/Chicago)" % (
                _qr.chicago_ymd(win_start), _qr.chicago_ymd(win_end)),
            "effective_date": eff.isoformat() if eff else "unknown",
            "effective_field": eff_field or "none",
            "threshold_source": threshold_source,
            "fail_below_points":
                ("%.2f" % fail_below) if fail_below is not None
                else "n/a (pass_fail)",
            "points_possible": points_possible,
            "failed": display_rows,
            "passed_count": passed_n,
            "excused_count": excused_n,
            "ungraded_count": ungraded_n,
            "reveal_audit": reveal_audit,
            "data_provenance": provenance,
        }
        text_out = _present.render(
            report, synthetic=synthetic_rows is not None)
        _prog("done", "%d failed of %d submissions" % (
            len(failed_rows), len(submissions)))
        return ChainResult(text_out, report, provenance)
    except ChainFailure:
        # Already translated for the agent surface; pass through.
        raise
    except Exception as exc:
        # Every chain failure routes through failures/translator.py:
        # an unexpected error (reader failure, resolver HTTP error,
        # programming bug) becomes a translated ChainFailure, never a
        # raw traceback on the agent surface.
        raise _translate(operation, exc)
    finally:
        if own_reader and reader is not None:
            try:
                reader.close()
            except Exception:
                pass


def main(argv):
    import argparse
    ap = argparse.ArgumentParser(
        description="Failed-students query chain. The agent reads what the "
                    "educator asked and passes these typed arguments.")
    ap.add_argument("--course", required=True,
                    help="Canvas course id the query is about")
    ap.add_argument("--quiz", required=True,
                    choices=("last-week", "this-week"),
                    help="which quiz: the one due last week or this week")
    group = ap.add_mutually_exclusive_group()
    group.add_argument("--below-percent", type=float, default=None,
                       help="failed means below this percent (0-100)")
    group.add_argument("--below-points", type=float, default=None,
                       help="failed means below this many points")
    group.add_argument("--letter-f", action="store_true",
                       help="failed means a letter grade of F")
    ap.add_argument("--tenant", default=_live_read.TENANT_BASE)
    ap.add_argument("--progress", action="store_true",
                    help="QOL-3: print chain progress lines to stderr as "
                         "each stage completes (stdout stays clean for "
                         "piping).")
    args = ap.parse_args(argv)
    progress = None
    if args.progress:
        def progress(stage, detail=""):
            line = "[query] %s" % stage
            if detail:
                line += ": %s" % detail
            print(line, file=sys.stderr)
    try:
        result = run_query(args.course, args.quiz.replace("-", "_"),
                           below_percent=args.below_percent,
                           below_points=args.below_points,
                           letter_f=args.letter_f,
                           tenant_base=args.tenant, progress=progress)
    except ChainFailure as exc:
        # TranslatedError is a dataclass, not an exception: the
        # raisable carrier is ChainFailure, which wraps the
        # translation in .translated.
        te = exc.translated
        print(te.agent_message)
        print("(mode %s, ref %s)" % (te.mode_id, te.correlation_id))
        return 2
    print(result.text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
