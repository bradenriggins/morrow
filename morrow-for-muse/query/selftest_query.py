#!/usr/bin/env python3
"""Self-tests for the failed-students query chain (query/).

Run: python3 query/selftest_query.py
Covers: typed argument checks, week-window/date semantics, quiz resolution
(zero/one/multiple matches, undated, unpublished), threshold math
(points, percent, grading standards, excused, missing, pass_fail,
not_graded), pagination merging, and translator routing. No live
reads: every provider call goes through FakeReader, and the
end-to-end run uses clearly-labeled synthetic fixtures.

Exit code 0 = all pass.
"""

from __future__ import annotations
import os as _home_os, sys as _home_sys  # noqa: E401
_home_sys.path.insert(0, _home_os.path.join(
    _home_os.path.dirname(_home_os.path.abspath(__file__)), '..'))
import config.selftest_home  # noqa: E402,F401  (scratch HOME/MORROW_HOME)

import os
import sys
from datetime import datetime, timezone

_TREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE_ROOT not in sys.path:
    sys.path.insert(0, _TREE_ROOT)

from query import quiz_resolve as Q
from query import thresholds as T
from query import chain as C
from query import live_read as L
from failures import translator as TR

# Neutral synthetic tenant for self-tests. The chain never hardcodes a
# real tenant (2026-09-22 first-run audit removed the CHCP hardcode), so
# the self-test pins a clearly-fake origin on the module and passes it
# explicitly to run_query. No live reads: every provider call goes
# through FakeReader or StubReader.
_TEST_TENANT = "https://school.example.edu"
L.tenant_base = lambda: _TEST_TENANT
# The fixtures' calendar is written in Chicago time; the chain itself
# takes the educator's zone (query/test_chain_timezone.py).
CHI = "America/Chicago"

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("PASS " if cond else "FAIL ") + name +
          ((" -- " + detail) if detail and not cond else ""))


# ------------------------------------------------------------- arguments
def t_arguments():
    ref, th = C._checked_arguments("last_week", None, None, False)
    check("args/default", ref == {"kind": "last_week"} and th is None)
    _, th = C._checked_arguments("last_week", 70, None, False)
    check("args/percent", th == {"kind": "percent", "value": 70.0})
    _, th = C._checked_arguments("this_week", None, 40, False)
    check("args/points", th == {"kind": "points", "value": 40.0})
    _, th = C._checked_arguments("last_week", None, None, True)
    check("args/letter-f", th == {"kind": "letter_f"})
    for bad in (("yesterday", None, None, False),
                ("last_week", 70, 40, False),
                ("last_week", 150, None, False)):
        try:
            C._checked_arguments(*bad)
            check("args/rejects-%r" % (bad,), False, "accepted")
        except C.QueryArgumentsInvalid:
            check("args/rejects-%r" % (bad,), True)


# ---------------------------------------------------------------- dates
def t_dates():
    # Tue 2026-09-22 12:00 UTC = 07:00 CDT. Last week (Chicago):
    # Mon 2026-09-14 .. Sun 2026-09-20.
    now = datetime(2026, 9, 22, 12, 0, tzinfo=timezone.utc)
    start, end = Q.last_week_window(CHI, now)
    check("dates/last-week-window",
          (Q.local_ymd(start, CHI), Q.local_ymd(end, CHI)) ==
          ("2026-09-14", "2026-09-20"),
          "got %s..%s" % (Q.local_ymd(start, CHI), Q.local_ymd(end, CHI)))

    q = {"id": 1, "created_at": "2026-09-01T00:00:00Z"}
    a = {"id": 9, "due_at": "2026-09-16T05:00:00Z",
         "lock_at": "2026-09-17T05:00:00Z",
         "unlock_at": "2026-09-10T05:00:00Z"}
    eff, field = Q.effective_date(q, a)
    check("dates/precedence-due",
          eff.date().isoformat() == "2026-09-16"
          and field == "assignment.due_at")
    a2 = {"id": 9, "due_at": None, "lock_at": "2026-09-17T05:00:00Z",
          "unlock_at": None}
    eff, field = Q.effective_date(q, a2)
    check("dates/precedence-lock",
          eff.date().isoformat() == "2026-09-17"
          and field == "assignment.lock_at")
    # New-Quiz-style record with its own due_at and no assignment.
    nq = {"id": "55", "due_at": "2026-09-18T05:00:00Z", "created_at": None}
    eff, field = Q.effective_date(nq, None)
    check("dates/nq-own-due",
          eff.date().isoformat() == "2026-09-18" and field == "quiz.due_at")
    eff, field = Q.effective_date({"id": 2}, {})
    check("dates/undated", eff is None and field is None)
    check("dates/bad-dt", Q.parse_canvas_dt("not-a-date") is None)
    check("dates/null-dt", Q.parse_canvas_dt(None) is None)
    # DST transitions (spring forward 2026-03-08, fall back 2026-11-01):
    # last week must stay exact in Chicago terms.
    spring = datetime(2026, 3, 10, 12, 0, tzinfo=timezone.utc)  # Tue
    s, e = Q.last_week_window(CHI, spring)
    check("dates/dst-spring-window",
          (Q.local_ymd(s, CHI), Q.local_ymd(e, CHI)) == ("2026-03-02", "2026-03-08"),
          "got %s..%s" % (Q.local_ymd(s, CHI), Q.local_ymd(e, CHI)))
    check("dates/dst-spring-utc-start", s.isoformat() ==
          "2026-03-02T06:00:00+00:00", s.isoformat())  # CST (-6) before flip
    check("dates/dst-spring-utc-end",
          e.isoformat() == "2026-03-09T04:59:59.999999+00:00",
          e.isoformat())  # CDT (-5) after flip
    fall = datetime(2026, 11, 3, 12, 0, tzinfo=timezone.utc)  # Tue
    s, e = Q.last_week_window(CHI, fall)
    check("dates/dst-fall-window",
          (Q.local_ymd(s, CHI), Q.local_ymd(e, CHI)) == ("2026-10-26", "2026-11-01"),
          "got %s..%s" % (Q.local_ymd(s, CHI), Q.local_ymd(e, CHI)))
    check("dates/dst-fall-utc-start", s.isoformat() ==
          "2026-10-26T05:00:00+00:00", s.isoformat())  # CDT (-5) before flip
    check("dates/dst-fall-utc-end",
          e.isoformat() == "2026-11-02T05:59:59.999999+00:00",
          e.isoformat())  # CST (-6) after flip


# ------------------------------------------------------- resolution (mock)
class FakeReader:
    def __init__(self, quizzes, assignments, nq=None, nq_error=None):
        self.quizzes = quizzes
        self.assignments = assignments
        self.nq = nq
        self.nq_error = nq_error

    def get_paginated(self, path):
        if path.split("?", 1)[0].endswith(("/users", "/enrollments")):
            return 200, [], None  # the course roster the chain reads first
        if path.startswith("/api/quiz/v1/"):
            if self.nq_error:
                raise self.nq_error
            return 200, (self.nq if self.nq is not None else []), None
        if "/quizzes" in path:
            return 200, self.quizzes, None
        if "/assignments" in path:
            return 200, self.assignments, None
        return 404, [], "unexpected path %s" % path

    def get_json(self, path):
        raise AssertionError("get_json is unused by the chain; path %s"
                             % path)


NOW = datetime(2026, 9, 22, 12, 0, tzinfo=timezone.utc)  # Tue; last wk Sep14-20


def _quiz(qid, title, published=True, aid=None):
    return {"id": qid, "title": title, "published": published,
            "assignment_id": aid}


def _assign(aid, due=None, grading_type="points", points=50.0):
    return {"id": aid, "name": "n", "due_at": due,
            "grading_type": grading_type, "points_possible": points,
            "published": True}


def t_resolve():
    # One match.
    r = FakeReader(
        [_quiz(1, "Pop Quiz #1", aid=11), _quiz(2, "Draft", False, 12)],
        [_assign(11, "2026-09-16T05:00:00Z"), _assign(12, "2026-09-16T05:00:00Z")])
    quiz, assignment, ctx = Q.resolve(r, "89585", {"kind": "last_week"},
                                     CHI, now_utc=NOW)
    check("resolve/one-match", quiz["id"] == 1 and assignment["id"] == 11)

    # Zero matches: nothing dated in the window.
    r = FakeReader(
        [_quiz(1, "Undated", aid=11), _quiz(2, "Draft", False, 12)],
        [_assign(11, None), _assign(12, None)])
    try:
        Q.resolve(r, "89585", {"kind": "last_week"}, CHI,
                  now_utc=NOW)
        check("resolve/zero-raises", False, "no raise")
    except Q.QuizNotFound as e:
        check("resolve/zero-raises", True)
        check("resolve/zero-counts",
              e.scanned == 2 and e.undated == 1 and e.unpublished == 1)
        check("resolve/zero-evidence",
              e.resolution_evidence["match_count"] == 0
              and e.resolution_evidence["window_start"] == "2026-09-14")

    # No-match "nearest" means closest to the requested week, not the
    # earliest quiz in the course (LANE2-A): a September window must
    # not offer an August quiz as the nearest.
    r = FakeReader(
        [_quiz(1, "Early Bird", aid=11), _quiz(2, "Just Missed", aid=12),
         _quiz(3, "Just After", aid=13), _quiz(4, "Late", aid=14)],
        [_assign(11, "2026-08-01T05:00:00Z"),
         _assign(12, "2026-09-12T05:00:00Z"),
         _assign(13, "2026-09-21T05:00:00Z"),
         _assign(14, "2026-12-01T05:00:00Z")])
    try:
        Q.resolve(r, "89585", {"kind": "last_week"}, CHI,
                  now_utc=NOW)
        check("resolve/nearest-raises", False, "no raise")
    except Q.QuizNotFound as e:
        titles = [t for t, _i, _e, _f in e.nearest]
        check("resolve/nearest-closest-first",
              titles[0] == "Just After", "got %r" % (titles,))
        check("resolve/nearest-not-earliest",
              "Early Bird" not in titles[:2], "got %r" % (titles,))

    # Multiple matches: refuse to pick.
    r = FakeReader(
        [_quiz(1, "Quiz A", aid=11), _quiz(2, "Quiz B", aid=12)],
        [_assign(11, "2026-09-15T05:00:00Z"),
         _assign(12, "2026-09-18T05:00:00Z")])
    try:
        Q.resolve(r, "89585", {"kind": "last_week"}, CHI,
                  now_utc=NOW)
        check("resolve/multi-raises", False, "no raise")
    except Q.QuizAmbiguous as e:
        check("resolve/multi-raises", True)
        check("resolve/multi-lists-both",
              len(e.candidates) == 2
              and "Quiz A" in e.resolution_evidence["candidates_public"]
              and "Quiz B" in e.resolution_evidence["candidates_public"])
        check("resolve/multi-no-silent-pick",
              "Quiz A (id 1" in e.resolution_evidence["candidates_public"])

    # Undated quiz never matches even when it is the only published quiz.
    r = FakeReader([_quiz(1, "Undated", aid=11)],
                   [_assign(11, None)])
    try:
        Q.resolve(r, "89585", {"kind": "last_week"}, CHI,
                  now_utc=NOW)
        check("resolve/undated-excluded", False, "matched an undated quiz")
    except Q.QuizNotFound:
        check("resolve/undated-excluded", True)

    # New-Quiz surface included: NQ due last week resolves.
    r = FakeReader(
        [],
        [_assign("55", "2026-09-17T05:00:00Z", grading_type="pass_fail",
                 points=100.0)],
        nq=[{"id": "55", "title": "NQ Quiz",
             "due_at": "2026-09-17T05:00:00Z", "published": True,
             "grading_type": "pass_fail", "points_possible": 100.0}])
    quiz, assignment, ctx = Q.resolve(r, "89585", {"kind": "last_week"},
                                     CHI, now_utc=NOW)
    check("resolve/nq-included", str(quiz["id"]) == "55"
          and str(assignment["id"]) == "55")

    # NQ surface 401 (no LTI provisioning): classic-only, said loudly.
    class Boom(Exception):
        pass
    r = FakeReader([_quiz(1, "Classic", aid=11)],
                   [_assign(11, "2026-09-16T05:00:00Z")],
                   nq_error=Boom("HTTP 401"))
    quiz, assignment, ctx = Q.resolve(r, "89585", {"kind": "last_week"},
                                     CHI, now_utc=NOW)
    check("resolve/nq-401-degrades",
          quiz["id"] == 1 and ctx["new_quizzes_skipped"] is not None
          and "401" in ctx["new_quizzes_skipped"])

    # Unsupported reference kinds raise instead of guessing.
    try:
        Q.resolve(FakeReader([], []), "89585", {"kind": "unspecified"},
                  CHI)
        check("resolve/unsupported-raises", False, "no raise")
    except Q.UnsupportedQuizRef:
        check("resolve/unsupported-raises", True)


# --------------------------------------------------------------- thresholds
def t_thresholds():
    A = {"id": 11, "grading_type": "points", "points_possible": 50.0}
    fb, src = T.threshold_points(A, None)
    check("th/default-60", abs(fb - 30.0) < 1e-9 and "default" in src, src)
    fb, src = T.threshold_points(A, {"kind": "percent", "value": 70.0})
    check("th/explicit-pct", abs(fb - 35.0) < 1e-9
          and "educator-specified" in src, src)
    fb, src = T.threshold_points(A, {"kind": "points", "value": 40.0})
    check("th/explicit-points", abs(fb - 40.0) < 1e-9)
    std = {"grading_scheme": [{"name": "A", "value": 0.9},
                             {"name": "D", "value": 0.6},
                             {"name": "F", "value": 0.0}]}
    fb, src = T.threshold_points(A, None, std)
    check("th/no-standard-default-kept", abs(fb - 30.0) < 1e-9,
          "points grading ignores standard, uses default")
    AL = {"id": 12, "grading_type": "letter_grade", "points_possible": 100.0}
    fb, src = T.threshold_points(AL, None, std)
    check("th/letter-standard-cutoff", abs(fb - 60.0) < 1e-9, src)
    # The F row (0.0) is not the cutoff; the lowest passing row is.
    check("th/standard-f-row-not-cutoff",
          abs(fb - 60.0) < 1e-9 and "60.0%" in src, src)
    pct_std = {"grading_scheme": [{"name": "A", "value": 90},
                                 {"name": "F", "value": 0}]}
    fb, src = T.threshold_points(AL, None, pct_std)
    check("th/standard-percent-normalization", abs(fb - 90.0) < 1e-9, src)
    allzero = {"grading_scheme": [{"name": "F", "value": 0}]}
    fb, src = T.threshold_points(AL, None, allzero)
    check("th/standard-degenerate-falls-back", abs(fb - 60.0) < 1e-9
          and "default" in src, src)

    def sub(**kw):
        d = {"user_id": 1, "score": None, "grade": None, "excused": None,
             "missing": False, "workflow_state": "graded", "late": False}
        d.update(kw)
        return d

    check("th/fail", T.classify(sub(score=25.0), A, 30.0, "s")["verdict"]
          == "failed")
    check("th/pass", T.classify(sub(score=35.0), A, 30.0, "s")["verdict"]
          == "passed")
    check("th/boundary-not-failed",
          T.classify(sub(score=30.0), A, 30.0, "s")["verdict"] == "passed")
    c = T.classify(sub(score=25.0, excused=True), A, 30.0, "s")
    check("th/excused", c["verdict"] == "excused")
    c = T.classify(sub(missing=True), A, 30.0, "s")
    check("th/missing-failed",
          c["verdict"] == "failed" and c["missing"] is True)
    c = T.classify(sub(workflow_state="unsubmitted"), A, 30.0, "s")
    check("th/unsubmitted-failed", c["verdict"] == "failed"
          and c["missing"] is True)
    c = T.classify(sub(workflow_state="submitted"), A, 30.0, "s")
    check("th/submitted-ungraded", c["verdict"] == "ungraded",
          "null score + submitted is ungraded, not failed")
    c = T.classify(sub(score=25.0, late=True), A, 30.0, "s")
    check("th/late-context", c["verdict"] == "failed"
          and c["late"] is True)

    APF = {"id": 13, "grading_type": "pass_fail", "points_possible": 0.0}
    fb, src = T.threshold_points(APF, None)
    check("th/passfail-no-points-needed", fb is None)
    check("th/passfail-incomplete",
          T.classify(sub(grade="incomplete"), APF, None, src)["verdict"]
          == "failed")
    check("th/passfail-complete",
          T.classify(sub(grade="complete"), APF, None, src)["verdict"]
          == "passed")
    check("th/passfail-missing",
          T.classify(sub(workflow_state="unsubmitted"), APF, None, src)
          ["verdict"] == "failed")

    ANG = {"id": 14, "grading_type": "not_graded", "points_possible": None}
    try:
        T.threshold_points(ANG, None)
        check("th/notgraded-raises", False, "no raise")
    except T.ThresholdUndefined:
        check("th/notgraded-raises", True)
    AZ = {"id": 15, "grading_type": "points", "points_possible": 0.0}
    try:
        T.threshold_points(AZ, None)
        check("th/zero-points-raises", False, "no raise")
    except T.ThresholdUndefined:
        check("th/zero-points-raises", True)


# -------------------------------------------------------------- pagination
def t_pagination():
    check("page/next-link",
          L._next_link(
              '<https://x/api/v1/a?page=2>; rel="next", '
              '<https://x/api/v1/a?page=5>; rel="last"')
          == "https://x/api/v1/a?page=2")
    check("page/no-next", L._next_link(
        '<https://x/api/v1/a?page=1>; rel="current"') is None)
    check("page/empty", L._next_link("") is None)

    class StubReader(L.LiveReader):
        def __init__(self, pages):
            self._pages = pages  # {url: (status, payload, headers)}
            self._tab_id = "stub"
            self._tenant = _TEST_TENANT

        def _fetch(self, url):
            return self._pages[url]

    T = _TEST_TENANT
    p1 = (200, [{"id": 1}], {"link": '<%s/p2>; rel="next"' % T})
    p2 = (200, [{"id": 2}], {})
    st, rows, note = StubReader({"/a": p1, T + "/p2": p2}).get_paginated("/a")
    check("page/merge", st == 200 and rows == [{"id": 1}, {"id": 2}]
          and note is None, "got %r %r %r" % (st, rows, note))

    # Off-origin next link: refuse, loudly.
    p1x = (200, [{"id": 1}],
           {"link": '<https://evil.example/p2>; rel="next"'})
    st, rows, note = StubReader({"/a": p1x}).get_paginated("/a")
    check("page/off-origin-refused", note is not None and "origin" in note
          and rows == [{"id": 1}], note)

    # Non-array page: refuse to merge.
    p1b = (200, {"not": "a list"}, {})
    st, rows, note = StubReader({"/a": p1b}).get_paginated("/a")
    check("page/non-array-refused", note is not None and "JSON array"
          in note, note)

    # HTTP failure mid-way: loud, partial rows returned for evidence.
    p1f = (200, [{"id": 1}], {"link": '<%s/p2>; rel="next"' % T})
    p2f = (500, None, {})
    st, rows, note = StubReader(
        {"/a": p1f, T + "/p2": p2f}).get_paginated("/a")
    check("page/http-failure-loud", st == 500 and note is not None
          and rows == [{"id": 1}], note)

    # Page bound: never silently partial.
    many = {}
    prev = "/a"
    for i in range(L.MAX_PAGES + 2):
        nxt = "%s/p%d" % (T, i + 1)
        many[prev] = (200, [{"id": i}],
                      {"link": '<%s>; rel="next"' % nxt})
        prev = nxt
    many[prev] = (200, [{"id": 999}], {})
    st, rows, note = StubReader(many).get_paginated("/a")
    check("page/bound-refused", note is not None and "PARTIAL" in note,
          note)


# ------------------------------------------------- translator routing
def t_translator():
    te = TR.translate("op", Q.QuizNotFound(
        datetime(2026, 9, 14, 5, 0, tzinfo=timezone.utc),   # 00:00 CDT
        datetime(2026, 9, 21, 4, 59, 59, tzinfo=timezone.utc),  # 23:59 CDT
        5, 3, 1, [], CHI))
    check("tr/no-match", te.mode_id == "quiz-resolution-no-match"
          and "no published quiz" in te.agent_message, te.mode_id)
    check("tr/no-match-placeholders",
          "2026-09-14..2026-09-20" in te.agent_message
          and "(unknown)" not in te.agent_message, te.agent_message[:200])
    te = TR.translate("op", Q.QuizAmbiguous(
        datetime(2026, 9, 14), datetime(2026, 9, 20),
        [("Quiz A", 1, "2026-09-15T05:00:00+00:00", "assignment.due_at",
          50.0)], CHI))
    check("tr/ambiguous", te.mode_id == "quiz-resolution-ambiguous"
          and "Quiz A" in te.agent_message, te.mode_id)
    te = TR.translate("op", C.QueryArgumentsInvalid("blah"))
    check("tr/arguments", te.mode_id == "query-arguments-invalid",
          te.mode_id)
    te = TR.translate("op", T.ThresholdUndefined("no points"))
    check("tr/threshold", te.mode_id == "query-threshold-undefined",
          te.mode_id)
    # LANE2-A: UnsupportedQuizRef and LiveReadError classify instead of
    # falling through to the unknown fallback.
    te = TR.translate("op", Q.UnsupportedQuizRef("yesterday"))
    check("tr/unsupported-ref",
          te.mode_id == "quiz-reference-unsupported", te.mode_id)
    check("tr/unsupported-ref-anchors",
          all(a in te.agent_message.lower() for a in
              ("what was attempted", "what the evidence showed",
               "what this means", "what happens next")),
          te.agent_message[:120])
    te = TR.translate("op", L.LiveReadError("helper Chromium is not alive"))
    check("tr/live-read", te.mode_id == "query-live-read-failed",
          te.mode_id)
    # ChainFailure is raisable and carries the translation.
    try:
        C.run_query("89585", "yesterday", reader=FakeReader([], []),
                    tenant_base=_TEST_TENANT)
        check("tr/chainfailure-raisable", False, "no raise")
    except C.ChainFailure as e:
        check("tr/chainfailure-raisable", True)
        check("tr/chainfailure-mode",
              e.translated.mode_id == "query-arguments-invalid",
              e.translated.mode_id)
        check("tr/chainfailure-message",
              "arguments were not valid" in e.translated.agent_message)
    try:
        C.run_query("89585", "last_week", reader=FakeReader([], []), now_utc=NOW,
                    tenant_base=_TEST_TENANT, timezone=CHI)
        check("tr/chainfailure-no-match", False, "no raise")
    except C.ChainFailure as e:
        check("tr/chainfailure-no-match",
              e.translated.mode_id == "quiz-resolution-no-match",
              e.translated.mode_id)
    # A reader-side LiveReadError must arrive as a translated
    # ChainFailure (query-live-read-failed), never a raw traceback.
    class _BoomReader(FakeReader):
        def get_paginated(self, path):
            raise L.LiveReadError("helper Chromium is not alive")

    try:
        C.run_query("89585", "last_week", reader=_BoomReader([], []), now_utc=NOW,
                    tenant_base=_TEST_TENANT, timezone=CHI)
        check("tr/chainfailure-read-error", False, "no raise")
    except C.ChainFailure as e:
        check("tr/chainfailure-read-error",
              e.translated.mode_id == "query-live-read-failed",
              e.translated.mode_id)
    except Exception as e:  # noqa: BLE001 - must not leak raw
        check("tr/chainfailure-read-error", False,
              "raw %s escaped" % type(e).__name__)
    # main()'s except clause catches ChainFailure: the old clause
    # caught TranslatedError (a dataclass, not an exception) and
    # raised TypeError whenever an error was in flight. Exercise the
    # real CLI: no helper token file here, so the read fails closed,
    # the CLI must print the translated message and exit 2.
    import subprocess as _sp
    _proc = _sp.run(
        [sys.executable, os.path.join(_TREE_ROOT, "query", "chain.py"),
         "--course", "89585", "--quiz", "last-week",
         "--canvas-base", _TEST_TENANT],
        cwd=_TREE_ROOT, capture_output=True, text=True, timeout=120)
    check("tr/cli-exit-2", _proc.returncode == 2,
          "exit %s: %s" % (_proc.returncode, _proc.stderr[-200:]))
    check("tr/cli-mode", "query-live-read-failed" in _proc.stdout,
          _proc.stdout[-200:])


# ------------------------------------------------------- end to end (synthetic)
_SYNTH = [
    {"user_id": 101, "name": "Fixture Ada", "score": 22.0,
     "workflow_state": "graded", "excused": None, "missing": False,
     "late": False, "grade": None},
    {"user_id": 102, "name": "Fixture Ben", "score": 41.0,
     "workflow_state": "graded", "excused": None, "missing": False,
     "late": True, "grade": None},
    {"user_id": 103, "name": "Fixture Cy", "score": 10.0,
     "workflow_state": "graded", "excused": True, "missing": False,
     "late": False, "grade": None},
    {"user_id": 104, "name": "Fixture Dee", "score": None,
     "workflow_state": "unsubmitted", "excused": None, "missing": False,
     "late": False, "grade": None},
    {"user_id": 105, "name": "Fixture Eli", "score": None,
     "workflow_state": "submitted", "excused": None, "missing": False,
     "late": False, "grade": None},
]


def t_end_to_end():
    r = FakeReader(
        [_quiz(1, "Pop Quiz #1", aid=11)],
        [_assign(11, "2026-09-16T05:00:00Z")])
    res = C.run_query(
        "89585", "last_week", reader=r, now_utc=NOW, synthetic_rows=_SYNTH,
        tenant_base=_TEST_TENANT, timezone=CHI)
    txt = res.text
    check("e2e/synthetic-banner", txt.startswith("*** SYNTHETIC"),
          txt[:60])
    check("e2e/ada-failed", "Fixture Ada" in txt and "22.0/50.0" in txt)
    check("e2e/ben-passed-late-not-listed",
          "Fixture Ben" not in txt.split("failed:")[1].split("Names are")[0]
          if "failed:" in txt else False)
    check("e2e/cy-excused-not-failed",
          "Fixture Cy" not in txt.split("Names are")[0])
    check("e2e/dee-missing-failed", "Fixture Dee" in txt
          and "missing (no submission)" in txt)
    check("e2e/threshold-named", "default 60.0%" in txt, txt.splitlines()[3])
    check("e2e/window", "2026-09-14..2026-09-20" in txt)


def main():
    t_arguments()
    t_dates()
    t_resolve()
    t_thresholds()
    t_pagination()
    t_translator()
    t_end_to_end()
    print("\n%d passed, %d failed" % (len(PASS), len(FAIL)))
    if FAIL:
        print("FAILED:", FAIL)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
