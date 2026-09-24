#!/usr/bin/env python3
"""The failed-students chain may only read what the catalog proves.

The live submissions read (C-419, pending [LEARNER-DATA]) is not
live-proven, so the chain refuses it before the read, with a translated
message; the educator must name the course (no built-in default).
"""

import os
import sys
from datetime import datetime, timezone

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if TREE not in sys.path:
    sys.path.insert(0, TREE)

from query import chain as C  # noqa: E402

NOW = datetime(2026, 9, 22, 15, 0, tzinfo=timezone.utc)


class _Reader:
    def __init__(self):
        self.paths = []

    def get_paginated(self, path):
        self.paths.append(path)
        if "/submissions" in path:
            return 200, [{"user_id": 1, "score": 0,
                          "user": {"name": "Jane Realstudent"}}], None
        if "/quizzes" in path and "quiz/v1" not in path:
            return 200, [{"id": 7, "title": "Quiz 1", "assignment_id": 70,
                          "due_at": "2026-09-16T15:00:00Z",
                          "points_possible": 10}], None
        if "/assignments" in path:
            return 200, [{"id": 70, "name": "Quiz 1",
                          "due_at": "2026-09-16T15:00:00Z",
                          "points_possible": 10,
                          "grading_type": "points"}], None
        return 200, [], None

    def get_json(self, path):
        self.paths.append(path)
        return {}

    def close(self):
        pass


def test_live_submissions_read_refused_until_live_proven():
    reader = _Reader()
    with pytest.raises(C.ChainFailure):
        C.run_query("89585", "last_week", reader=reader, now_utc=NOW,
                    tenant_base="https://school.example.edu",
                    timezone="America/Chicago")
    assert not any("/submissions" in p for p in reader.paths)


def test_the_refusal_comes_before_any_canvas_read():
    # The chain documents the failed-students question as a working
    # capability while C-419 is pending [LEARNER-DATA]. The refusal must
    # come before the reader, the time zone, and the roster, quizzes,
    # assignments, and course reads, or Morrow reads six endpoints and
    # then tells the educator the task is not tested (final sweep
    # 2026-09-23, written before the fix).
    reader = _Reader()
    with pytest.raises(C.ChainFailure):
        C.run_query("89585", "last_week", reader=reader, now_utc=NOW,
                    tenant_base="https://school.example.edu",
                    timezone="America/Chicago")
    assert reader.paths == [], reader.paths


def test_cli_requires_course():
    with pytest.raises(SystemExit):
        C.main(["show me all the students that failed last week's quiz"])
