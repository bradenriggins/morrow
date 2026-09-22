#!/usr/bin/env python3
"""Quiz resolution for the failed-students query chain.

"Last week's quiz" semantics (exact, documented, tested):

- The educator's timezone is America/Chicago. "Last week" is the ISO
  calendar week (Monday 00:00 through Sunday 23:59:59) immediately
  before the week containing "now".
- A quiz is a candidate for that week when its EFFECTIVE DATE falls
  inside the window. Effective date, with provenance, is the first
  non-null of: assignment.due_at, quiz.due_at (New Quizzes carry their
  own dates), assignment.lock_at, quiz.lock_at, assignment.unlock_at,
  quiz.unlock_at, quiz.created_at (last resort; flagged as weak).
  A quiz with none of these set is UNDATED: it cannot be "last week's
  quiz" and is excluded from matching (but reported in the no-match
  context so the educator sees it).
- Coverage is both quiz surfaces: classic /api/v1 quizzes AND New
  Quizzes /api/quiz/v1 (a New Quiz id IS its assignment id, verified
  live on course 89585). The New Quizzes surface is best-effort: if it
  401s (no LTI provisioning) the chain continues with classic quizzes
  only and says so loudly.
- Classic-quiz dates live on the linked assignment record, not on the
  quiz record (verified live on course 89585: quiz rows carry no
  due_at/unlock_at/lock_at; the assignment rows do). The resolver
  joins on the assignment id, once, from a single paginated
  assignments read.
- Unpublished quizzes are excluded from matching (an educator asking
  about "last week's quiz" means the quiz students took), and listed
  in the context so a match is never silently missed.

Failure modes (never silently pick):
- zero candidates -> QuizNotFound (lists scanned/undated/unpublished
  counts plus the nearest dated quizzes)
- more than one candidate -> QuizAmbiguous (lists every candidate
  with title, id, effective date and which field supplied it, points)
Both route through failures/translator.py via chain.py.

Stdlib only.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

# Live-read failures (HTTP errors, truncated lists) surface as
# query.live_read.LiveReadError so the chain translates them into the
# query-live-read-failed catalog mode instead of the unknown fallback.
# live_read imports nothing from this module, so there is no cycle.
from query.live_read import LiveReadError

_CHICAGO_TZ = ZoneInfo("America/Chicago")
CHICAGO = "America/Chicago"

# America/Chicago: CST is UTC-6, CDT is UTC-5. DST 2026: Mar 8 - Nov 1.
# Computed rather than hardcoded so the semantics stay exact year-round.
def chicago_ymd(dt_utc):
    """Render an aware-UTC datetime as an America/Chicago calendar date.

    Used for educator-facing window strings: the window is defined in
    Chicago time, so "2026-09-20 23:59 Chicago" must not render as
    2026-09-21 (its UTC date).
    """
    dt = dt_utc if dt_utc.tzinfo else dt_utc.replace(tzinfo=timezone.utc)
    return dt.astimezone(_CHICAGO_TZ).date().isoformat()


class QuizResolutionError(Exception):
    """Base for quiz-resolution outcomes that are not resolutions.

    str(exc) is PII-free by construction: only counts and quiz titles
    appear (quiz titles are educator-authored content, not learner
    PII). .resolution_evidence is a flat scalar map that
    failures/translator.py merges into the agent-visible evidence.
    """

    def __init__(self, message, *, query="", evidence=None):
        super().__init__(message)
        self.query = query
        self.resolution_evidence = dict(evidence or {})


class QuizNotFound(QuizResolutionError):
    """No quiz matched the reference window; carries context, not a pick."""

    def __init__(self, window_start, window_end, scanned, undated,
                 unpublished, nearest, query="last week's quiz"):
        super().__init__(
            "no quiz has an effective date inside %s..%s (%d quizzes "
            "scanned, %d undated, %d unpublished)" % (
                chicago_ymd(window_start), chicago_ymd(window_end),
                scanned, undated, unpublished),
            query=query,
            evidence={
                "query": query,
                "match_count": 0,
                "candidates_examined": scanned,
                "undated": undated,
                "unpublished": unpublished,
                "window_start": chicago_ymd(window_start),
                "window_end": chicago_ymd(window_end),
                "nearest_public": "; ".join(
                    "%s (id %s, %s via %s)" % (t, i, eff, f)
                    for t, i, eff, f in nearest) or "(no dated quizzes)",
            })
        self.window_start = window_start
        self.window_end = window_end
        self.scanned = scanned
        self.undated = undated
        self.unpublished = unpublished
        self.nearest = nearest  # [(title, id, effective_iso, field), ...]


class QuizAmbiguous(QuizResolutionError):
    """Multiple quizzes matched; the educator must pick, never the chain."""

    def __init__(self, window_start, window_end, candidates,
                 query="last week's quiz"):
        super().__init__(
            "%d quizzes have an effective date inside %s..%s; refusing "
            "to pick one silently" % (
                len(candidates), chicago_ymd(window_start),
                chicago_ymd(window_end)),
            query=query,
            evidence={
                "query": query,
                "match_count": len(candidates),
                "window_start": chicago_ymd(window_start),
                "window_end": chicago_ymd(window_end),
                "candidates_public": "; ".join(
                    "%s (id %s, effective %s via %s, %s points)" % (
                        t, i, eff, f,
                        ("%.0f" % p) if p is not None else "?")
                    for t, i, eff, f, p in candidates),
            })
        self.window_start = window_start
        self.window_end = window_end
        self.candidates = candidates  # [(title, id, effective_iso,
                                        #   field, points), ...]


class UnsupportedQuizRef(Exception):
    """The parsed quiz reference kind is not implemented yet."""

    def __init__(self, kind):
        super().__init__("quiz reference kind %r is not implemented" % kind)
        self.kind = kind


def parse_canvas_dt(value):
    """Parse a Canvas ISO-8601 timestamp; None for null/unparseable."""
    if not value or not isinstance(value, str):
        return None
    try:
        text = value.strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except ValueError:
        return None


def last_week_window(now_utc=None):
    """Return (window_start, window_end) datetimes in UTC for last week.

    Last week = the ISO Monday-Sunday week before the week containing
    now, in America/Chicago.
    """
    now_utc = now_utc or datetime.now(timezone.utc)
    if now_utc.tzinfo is None:
        now_utc = now_utc.replace(tzinfo=timezone.utc)
    # stdlib zoneinfo: exact across DST transitions (no hand-rolled
    # DST arithmetic). Midnight Chicago always exists (transitions
    # happen at 02:00), so these local midnights are unambiguous.
    local = now_utc.astimezone(_CHICAGO_TZ)
    monday_this = (local - timedelta(days=local.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0)
    start_local = monday_this - timedelta(days=7)
    end_local = monday_this - timedelta(microseconds=1)
    return (start_local.astimezone(timezone.utc),
            end_local.astimezone(timezone.utc))


def effective_date(quiz, assignment):
    """Effective date for week matching, with provenance.

    Precedence: assignment.due_at, quiz.due_at (New Quizzes carry
    their own), assignment.lock_at, quiz.lock_at, assignment.unlock_at,
    quiz.unlock_at, quiz.created_at. Returns (datetime_utc,
    field_name) or (None, None) when undated.
    """
    quiz = quiz or {}
    assignment = assignment or {}
    for field in ("due_at", "lock_at", "unlock_at"):
        dt = parse_canvas_dt(assignment.get(field))
        if dt is not None:
            return dt, "assignment." + field
        dt = parse_canvas_dt(quiz.get(field))
        if dt is not None:
            return dt, "quiz." + field
    dt = parse_canvas_dt(quiz.get("created_at"))
    if dt is not None:
        return dt, "quiz.created_at"
    return None, None


def resolve(reader, course_id, quiz_ref, now_utc=None):
    """Resolve a parsed quiz reference to one (quiz, assignment, ctx).

    reader: object with get_paginated(path) -> (status, rows, note)
            and get_json(path) -> dict.
    Returns (quiz_record, assignment_record_or_None, context_dict).
    Raises QuizNotFound, QuizAmbiguous, UnsupportedQuizRef,
    or the reader's own errors (session death, HTTP failures).
    """
    kind = quiz_ref.get("kind")
    if kind == "last_week":
        return _resolve_week(reader, course_id, "last_week", now_utc)
    if kind == "this_week":
        return _resolve_week(reader, course_id, "this_week", now_utc)
    raise UnsupportedQuizRef(kind)


def _this_week_window(now_utc):
    now_utc = now_utc or datetime.now(timezone.utc)
    if now_utc.tzinfo is None:
        now_utc = now_utc.replace(tzinfo=timezone.utc)
    local = now_utc.astimezone(_CHICAGO_TZ)
    monday = (local - timedelta(days=local.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0)
    end_local = monday + timedelta(days=7) - timedelta(microseconds=1)
    return (monday.astimezone(timezone.utc),
            end_local.astimezone(timezone.utc))


def _resolve_week(reader, course_id, which, now_utc):
    window = last_week_window(now_utc) if which == "last_week" \
        else _this_week_window(now_utc)
    start, end = window
    status, quizzes, note = reader.get_paginated(
        "/api/v1/courses/%s/quizzes?per_page=100" % course_id)
    if status != 200:
        raise LiveReadError(
            "quizzes list returned HTTP %s%s" % (
                status, (" (%s)" % note) if note else ""))
    if note:
        raise LiveReadError(
            "quizzes list was truncated (%s); refusing to resolve "
            "against a partial list" % note)

    # One paginated assignments read, joined by id: classic-quiz dates
    # live on the assignment record, not the quiz record (verified live
    # on course 89585). Orphan quiz rows (assignment_id pointing at a
    # deleted assignment) simply miss the join and resolve as undated.
    status, assignments, note = reader.get_paginated(
        "/api/v1/courses/%s/assignments?per_page=100" % course_id)
    if status != 200:
        raise LiveReadError(
            "assignments list returned HTTP %s%s" % (
                status, (" (%s)" % note) if note else ""))
    if note:
        raise LiveReadError(
            "assignments list was truncated (%s); refusing to resolve "
            "against a partial list" % note)
    by_id = {}
    for a in assignments:
        if isinstance(a, dict) and a.get("id") is not None:
            by_id[str(a["id"])] = a

    # New Quizzes (/api/quiz/v1) carry their own due dates and are NOT
    # returned by the classic /quizzes endpoint. A New Quiz id IS its
    # assignment id (verified live on 89585), so the assignment join
    # above still applies. The surface is best-effort: users without an
    # LTI-provisioned New Quizzes service get a 401 here, in which case
    # the chain continues with classic quizzes only and says so loudly.
    nq_quizzes = []
    nq_skipped = None
    try:
        # Paginated: the NQ surface caps a single page well below
        # per_page=100 (live: 50 of 148 with get_json), so pagination
        # is required for completeness. An incomplete page set raises
        # here and refuses to resolve against a partial list.
        status, nq_rows, nq_note = reader.get_paginated(
            "/api/quiz/v1/courses/%s/quizzes?per_page=100" % course_id)
        if status != 200:
            raise RuntimeError("HTTP %s from new-quizzes list" % status)
        if nq_note is not None:
            raise RuntimeError("pagination incomplete: %s" % nq_note)
        if isinstance(nq_rows, list):
            nq_quizzes = [q for q in nq_rows if isinstance(q, dict)]
        else:
            nq_skipped = "new-quizzes endpoint returned a non-list body"
    except Exception as exc:
        nq_skipped = ("new-quizzes list unreadable (%s); classic quizzes "
                      "only" % exc)

    all_quizzes = list(quizzes)
    seen_ids = {str(q.get("id")) for q in quizzes if isinstance(q, dict)}
    for q in nq_quizzes:
        qid = str(q.get("id"))
        if qid in seen_ids:
            continue  # same quiz on both surfaces; count once
        seen_ids.add(qid)
        all_quizzes.append(q)

    scanned = 0
    undated = 0
    unpublished = 0
    candidates = []
    dated_all = []  # (effective_dt, title, id, field): context for no-match
    for quiz in all_quizzes:
        if not isinstance(quiz, dict):
            continue
        scanned += 1
        if not quiz.get("published", True):
            unpublished += 1
            continue
        qid = str(quiz.get("id"))
        assignment = by_id.get(qid) or by_id.get(str(quiz.get(
            "assignment_id")))
        eff, field = effective_date(quiz, assignment)
        title = quiz.get("title") or "(untitled quiz %s)" % quiz.get("id")
        if eff is None:
            undated += 1
            continue
        dated_all.append((eff, title, quiz.get("id"), field))
        if start <= eff <= end:
            candidates.append((eff, title, quiz.get("id"), field, quiz,
                               assignment))

    if len(candidates) == 1:
        _eff, _t, _i, _f, quiz, assignment = candidates[0]
        return quiz, assignment, {"new_quizzes_skipped": nq_skipped}
    if len(candidates) == 0:
        # "Nearest" means closest by due date to the requested week,
        # not the earliest quizzes in the course: a December window
        # must not offer January quizzes as the nearest.
        mid = start + (end - start) / 2
        dated_all.sort(
            key=lambda r: abs((r[0] - mid).total_seconds()))
        nearest = [(t, i, eff.isoformat(), f)
                   for eff, t, i, f in dated_all[:5]]
        err = QuizNotFound(start, end, scanned, undated, unpublished,
                           nearest, query="%s's quiz" % which.replace(
                               "_", " "))
        err.new_quizzes_skipped = nq_skipped
        raise err
    shown = [(t, i, eff.isoformat(), f,
              (a or {}).get("points_possible"))
             for eff, t, i, f, _q, a in
             sorted(candidates, key=lambda r: r[0])]
    err = QuizAmbiguous(start, end, shown,
                        query="%s's quiz" % which.replace("_", " "))
    err.new_quizzes_skipped = nq_skipped
    raise err
