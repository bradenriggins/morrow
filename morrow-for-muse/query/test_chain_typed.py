#!/usr/bin/env python3
"""The failed-students query takes typed arguments, never free text.

Failure mode this suite pins down (written before the fix; Braden's
rule 2026-09-22): query/intent.py parsed the educator's words with
regexes to decide which quiz and which threshold the chain used, so
code, not the agent, decided what the educator meant. The chain now
takes typed arguments (course, quiz window, one optional threshold);
the agent reads the educator's words and passes them. Bad arguments
are refused before any read, as a translated ChainFailure.

Hermetic: an in-memory reader and synthetic rows.
"""

import inspect
import os
import sys
from datetime import datetime, timezone

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if TREE not in sys.path:
    sys.path.insert(0, TREE)

from query import chain as C  # noqa: E402

NOW = datetime(2026, 9, 22, 15, 0, tzinfo=timezone.utc)
TENANT = "https://school.example.edu"
SYNTH = [
    {"user_id": 101, "name": "Fixture Ada", "score": 22.0,
     "workflow_state": "graded", "excused": None, "missing": False,
     "late": False, "grade": None},
    {"user_id": 102, "name": "Fixture Ben", "score": 41.0,
     "workflow_state": "graded", "excused": None, "missing": False,
     "late": False, "grade": None},
]


class _Reader:
    def __init__(self):
        self.paths = []

    def get_paginated(self, path):
        self.paths.append(path)
        if "/quiz/v1/" in path:
            return 200, [], None
        if "/quizzes" in path:
            return 200, [{"id": 1, "title": "Pop Quiz", "published": True,
                          "assignment_id": 11}], None
        return 200, [{"id": 11, "name": "Pop Quiz",
                      "due_at": "2026-09-16T05:00:00Z",
                      "grading_type": "points", "points_possible": 50.0,
                      "published": True}], None

    def get_json(self, path):
        self.paths.append(path)
        return {"id": 1}

    def close(self):
        pass


def _run(reader=None, **kw):
    return C.run_query("89585", reader=reader or _Reader(), now_utc=NOW,
                       synthetic_rows=SYNTH, tenant_base=TENANT, **kw)


def test_the_text_parser_is_gone():
    assert not os.path.exists(os.path.join(TREE, "query", "intent.py"))
    params = inspect.signature(C.run_query).parameters
    assert "text" not in params
    assert list(params)[:2] == ["course_id", "quiz"]


def test_default_threshold():
    res = _run(quiz="last_week")
    assert "Fixture Ada" in res.text and "Fixture Ben" not in \
        res.text.split("Names are")[0]


def test_percent_threshold_is_used():
    res = _run(quiz="last_week", below_percent=90)
    failed = res.report["failed"]
    assert {r["display_name"] for r in failed} == {"Fixture Ada",
                                                  "Fixture Ben"}


def test_points_threshold_is_used():
    res = _run(quiz="last_week", below_points=20)
    assert res.report["failed"] == []


def test_this_week_window():
    with pytest.raises(C.ChainFailure) as info:
        _run(quiz="this_week")
    assert info.value.translated.mode_id == "quiz-resolution-no-match"


@pytest.mark.parametrize("kw", [
    {"quiz": "yesterday"}, {"quiz": "last week's quiz"}, {"quiz": ""},
    {"quiz": "last_week", "below_percent": 70, "below_points": 3},
    {"quiz": "last_week", "below_percent": -1},
    {"quiz": "last_week", "below_percent": 101},
    {"quiz": "last_week", "below_points": "ten"},
    {"quiz": "last_week", "below_percent": 70, "letter_f": True},
])
def test_bad_arguments_refused_before_any_read(kw):
    reader = _Reader()
    with pytest.raises(C.ChainFailure) as info:
        _run(reader=reader, **kw)
    assert info.value.translated.mode_id == "query-arguments-invalid"
    assert reader.paths == []
    assert "—" not in info.value.translated.agent_message


def test_cli_takes_typed_flags(monkeypatch):
    captured = {}

    def fake(course_id, quiz, **kw):
        captured.update(kw, course_id=course_id, quiz=quiz)
        from types import SimpleNamespace
        return SimpleNamespace(text="ok")

    monkeypatch.setattr(C, "run_query", fake)
    assert C.main(["--course", "89585", "--quiz", "last-week",
                   "--below-percent", "70"]) == 0
    assert captured["quiz"] == "last_week"
    assert captured["below_percent"] == 70.0
    assert captured["course_id"] == "89585"
    with pytest.raises(SystemExit):
        C.main(["show me the students that failed", "--course", "1"])


class _ThisWeekReader(_Reader):
    """A quiz due inside this week (2026-09-21..2026-09-27, Chicago)."""

    def get_paginated(self, path):
        self.paths.append(path)
        if "/quiz/v1/" in path:
            return 200, [], None
        if "/quizzes" in path:
            return 200, [{"id": 1, "title": "This Week Quiz",
                          "published": True, "assignment_id": 11}], None
        return 200, [{"id": 11, "name": "This Week Quiz",
                      "due_at": "2026-09-23T05:00:00Z",
                      "grading_type": "points", "points_possible": 50.0,
                      "published": True}], None


def test_report_window_is_the_window_the_quiz_was_resolved_in():
    """Round-4 audit M3 (probe audit-muse4/q_window.py): a this_week
    query reported last week's window (2026-09-14..2026-09-20) while it
    resolved the quiz in this week's window."""
    res = _run(reader=_ThisWeekReader(), quiz="this_week")
    assert res.report["window"] == \
        "2026-09-21..2026-09-27 (America/Chicago)"
    res = _run(quiz="last_week")
    assert res.report["window"] == \
        "2026-09-14..2026-09-20 (America/Chicago)"
