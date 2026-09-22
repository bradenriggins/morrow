#!/usr/bin/env python3
"""The failed-students query chain: NL text -> genuine results.

Links:
  1. intent.parse: recognize the "students that failed <quiz>" family.
  2. quiz_resolve.resolve: "last week's quiz" -> exactly one quiz, with
     exact week/effective-date semantics; zero or multiple matches
     raise instead of silently picking.
  3. submissions fetch: paginated GET
     /api/v1/courses/{id}/assignments/{aid}/submissions with
     include[]=user, following Link rel="next" (never a silent
     partial collection).
  4. thresholds.classify: per-submission failed/passed/excused/
     ungraded with a named threshold source.
  5. present: de-identified educator result through the privacy
     boundary (names only with the educator's explicit consent file).

Every chain failure routes through failures/translator.py so the
agent-visible message is the catalog's, never a raw traceback.

Stdlib only.
"""

from __future__ import annotations

import os
import sys

_TREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE_ROOT not in sys.path:
    sys.path.insert(0, _TREE_ROOT)

from query import intent as _intent
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


def _translate(operation, exc):
    """Route a chain failure through failures/translator.py.

    Returns a ChainFailure wrapping the TranslatedError, because
    TranslatedError is a dataclass and cannot be raised.
    """
    return ChainFailure(_translator.translate(operation, exc))


def run_query(text, course_id, reader=None, tenant_base=None,
              now_utc=None, synthetic_rows=None, progress=None):
    """Run the full chain.

    text: educator's natural-language query.
    course_id: Canvas course id.
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

    operation = "find students who failed the quiz (%r)" % text
    own_reader = False
    try:
        try:
            parsed = _intent.parse(text)
        except _intent.IntentNotRecognized as exc:
            raise _translate(operation, exc)
        _prog("intent_parsed", str(parsed.get("quiz_ref", "")))

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
        description="Failed-students query chain")
    ap.add_argument("text", help="educator query, e.g. "
                    "\"show me all the students that failed last week's quiz\"")
    ap.add_argument("--course", default="89585")
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
        result = run_query(args.text, args.course,
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
