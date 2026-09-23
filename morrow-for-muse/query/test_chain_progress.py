#!/usr/bin/env python3
"""QOL-3 tests: opt-in progress reporting for the failed-students chain.

Safety contract under test:
- progress is purely observational: the default (None) preserves the
  exact prior behavior, byte for byte;
- a misbehaving progress callback can never break or alter the result;
- stages fire in a fixed, documented order.
"""

import os
import sys
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if TREE not in sys.path:
    sys.path.insert(0, TREE)

from query import chain as C  # noqa: E402


class FakeReader:
    def __init__(self, quizzes, assignments):
        self.quizzes = quizzes
        self.assignments = assignments

    def get_paginated(self, path):
        if "/quizzes" in path:
            return 200, self.quizzes, None
        if "/assignments" in path:
            return 200, self.assignments, None
        return 404, [], "unexpected path %s" % path


NOW = datetime(2026, 9, 22, 12, 0, tzinfo=timezone.utc)

SYNTH = [
    {"user_id": 101, "name": "Fixture Ada", "score": 22.0,
     "workflow_state": "graded", "excused": None, "missing": False,
     "late": False, "grade": None},
    {"user_id": 102, "name": "Fixture Ben", "score": 41.0,
     "workflow_state": "graded", "excused": None, "missing": False,
     "late": True, "grade": None},
]


def _reader():
    return FakeReader(
        [{"id": 1, "title": "Pop Quiz #1", "published": True,
          "assignment_id": 11}],
        [{"id": 11, "name": "n", "due_at": "2026-09-16T05:00:00Z",
          "grading_type": "points", "points_possible": 50.0,
          "published": True}])


def _run(progress):
    # Explicit test tenant: query/live_read.py no longer hardcodes a
    # production tenant (first-run audit 2026-09-22); the chain fails
    # closed without one, so synthetic tests pass their own.
    return C.run_query(
        "89585", "last_week", reader=_reader(), now_utc=NOW, synthetic_rows=SYNTH,
        tenant_base="https://school.example.edu",
        progress=progress, timezone="America/Chicago")


def test_stage_order():
    stages = []
    res = _run(lambda stage, detail="": stages.append(stage))
    assert [s for s in stages] == [
        "arguments_checked", "reader_ready", "quiz_resolved",
        "threshold_computed", "submissions_fetched", "classified", "done"]
    assert "Fixture Ada" in res.text


def test_progress_is_observational():
    plain = _run(None).text
    seen = []
    with_progress = _run(lambda s, d="": seen.append((s, d))).text
    assert with_progress == plain
    assert seen, "expected stages to fire"


def test_broken_callback_cannot_break_chain():
    def _boom(stage, detail=""):
        raise ValueError("callback exploded")

    res = _run(_boom)
    assert "Fixture Ada" in res.text
    assert res.text == _run(None).text


def test_main_progress_flag_wires_callback(monkeypatch, capsys):
    captured = {}

    def fake_run_query(course_id, quiz, tenant_base=None, progress=None,
                       **_kw):
        captured["progress"] = progress
        return SimpleNamespace(text="ok")

    monkeypatch.setattr(C, "run_query", fake_run_query)
    assert C.main(["--progress", "--course", "89585", "--quiz", "last-week"]) == 0
    assert callable(captured["progress"])
    captured["progress"]("arguments_checked", "x")
    assert "[query] arguments_checked: x" in capsys.readouterr().err


def test_main_default_no_progress(monkeypatch, capsys):
    captured = {}

    def fake_run_query(course_id, quiz, tenant_base=None, progress=None,
                       **_kw):
        captured["progress"] = progress
        return SimpleNamespace(text="ok")

    monkeypatch.setattr(C, "run_query", fake_run_query)
    assert C.main(["--course", "89585", "--quiz", "last-week"]) == 0
    assert captured["progress"] is None
    assert capsys.readouterr().err == ""
