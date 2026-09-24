#!/usr/bin/env python3
""""Last week" is the educator's week, not the developer's.

Failure mode this suite pins down (written before the fix; final sweep
2026-09-22, proof tzverify): query/quiz_resolve.py computed "last week"
and "this week" in America/Chicago for every educator and ignored the
`timezone` setting, which settings/README.md says drives "last week's
quiz". A quiz due Sunday 2026-09-20 at 23:00 in Los Angeles (Monday
06:00 UTC) fell into Chicago's "this week", so on Tuesday "who failed
last week's quiz" found no quiz or another one, and the window said
"(America/Chicago)".

The zone comes from, in order: the --timezone argument, the educator's
`timezone` setting, the course's time zone in Canvas, the educator's
Canvas profile. Never a hardcoded zone: with none of them the query
asks for the educator's time zone.

Hermetic: an in-memory reader, synthetic rows, a scratch settings home.
"""

import os
import sys
from datetime import datetime, timezone

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if TREE not in sys.path:
    sys.path.insert(0, TREE)

from query import chain as C  # noqa: E402
from query import quiz_resolve as Q  # noqa: E402

LA = "America/Los_Angeles"
# Tuesday 2026-09-22 10:00 in Los Angeles.
NOW = datetime(2026, 9, 22, 17, 0, tzinfo=timezone.utc)
# Sunday 2026-09-20 23:00 in Los Angeles (Monday 06:00 UTC, which is
# Monday 01:00 in Chicago).
DUE = "2026-09-21T06:00:00Z"
TENANT = "https://school.example.edu"
SYNTH = [{"user_id": 101, "name": "Fixture Ada", "score": 22.0,
          "workflow_state": "graded", "excused": None, "missing": False,
          "late": False, "grade": None}]


class _Reader:
    def __init__(self, course_zone=None, profile_zone=None):
        self.course_zone = course_zone
        self.profile_zone = profile_zone
        self.paths = []

    def get_paginated(self, path):
        self.paths.append(path)
        if path.split("?", 1)[0].endswith(("/users", "/enrollments")):
            return 200, [], None  # the course roster the chain reads first
        if "/quiz/v1/" in path:
            return 200, [], None
        if "/quizzes" in path:
            return 200, [{"id": 1, "title": "Sunday Quiz", "published": True,
                          "assignment_id": 11}], None
        return 200, [{"id": 11, "name": "Sunday Quiz", "due_at": DUE,
                      "grading_type": "points", "points_possible": 50.0,
                      "published": True}], None

    def get_json(self, path):
        self.paths.append(path)
        if path.startswith("/api/v1/users/self"):
            return {"id": 5, "time_zone": self.profile_zone}
        return {"id": 89585, "time_zone": self.course_zone}

    def close(self):
        pass


def _run(reader, **kw):
    return C.run_query("89585", "last_week", reader=reader, now_utc=NOW,
                       synthetic_rows=SYNTH, tenant_base=TENANT, **kw)


def test_the_window_is_the_week_in_the_given_zone():
    start, end = Q.last_week_window(LA, NOW)
    assert start.isoformat() == "2026-09-14T07:00:00+00:00"
    assert end.isoformat() == "2026-09-21T06:59:59.999999+00:00"
    assert start <= Q.parse_canvas_dt(DUE) <= end
    assert (Q.local_ymd(start, LA), Q.local_ymd(end, LA)) == \
        ("2026-09-14", "2026-09-20")


def test_no_zone_is_hardcoded():
    for name in ("CHICAGO", "_CHICAGO_TZ", "chicago_ymd"):
        assert not hasattr(Q, name), name
    with open(os.path.join(TREE, "query", "chain.py"),
              encoding="utf-8") as fh:
        assert "America/Chicago" not in fh.read()


def test_the_timezone_setting_decides_last_week():
    from settings import store
    store.set_setting("tz-educator", "timezone", LA,
                      educator_confirmed=False)
    res = _run(_Reader(course_zone="America/Chicago"),
               user_id="tz-educator")
    assert res.report["quiz_title"] == "Sunday Quiz"
    assert "(%s)" % LA in res.report["window"]
    assert "2026-09-14..2026-09-20" in res.report["window"]


def test_the_course_time_zone_is_the_fallback():
    reader = _Reader(course_zone=LA)
    res = _run(reader)
    assert res.report["quiz_title"] == "Sunday Quiz"
    assert "(%s)" % LA in res.report["window"]


def test_the_canvas_profile_is_the_last_fallback():
    res = _run(_Reader(profile_zone=LA))
    assert "(%s)" % LA in res.report["window"]


def test_the_argument_wins():
    res = _run(_Reader(course_zone="America/Chicago"), timezone=LA)
    assert res.report["quiz_title"] == "Sunday Quiz"


def test_without_any_zone_the_query_asks():
    with pytest.raises(C.ChainFailure) as exc:
        _run(_Reader())
    translated = exc.value.translated
    assert translated.mode_id == "query-timezone-unknown"
    assert "time zone" in translated.agent_message


def test_an_unknown_zone_name_is_refused_before_any_read():
    reader = _Reader(course_zone=LA)
    with pytest.raises(C.ChainFailure) as exc:
        _run(reader, timezone="Mars/Olympus_Mons")
    assert exc.value.translated.mode_id == "query-arguments-invalid"
    assert reader.paths == []


def test_the_cli_takes_timezone(monkeypatch):
    seen = {}

    def fake_run_query(course_id, quiz, **kw):
        seen.update(kw)
        raise SystemExit(0)
    monkeypatch.setattr(C, "run_query", fake_run_query)
    with pytest.raises(SystemExit):
        C.main(["--course", "89585", "--quiz", "last-week",
                "--timezone", LA, "--user-id", "u1"])
    assert seen["timezone"] == LA and seen["user_id"] == "u1"
