#!/usr/bin/env python3
"""The failed-students chain validates the course and gates every read.

Failure modes this suite pins down (written before the fix; re-audit
2026-09-22):
  1. --course went into request paths unvalidated
     (quiz_resolve.py and thresholds.py build "/api/v1/courses/%s/..."),
     so "1/../../users/self" or "1?x=y" re-routed the reads.
  2. Only the submissions read went through live_proven_gate; the
     quizzes, assignments, New Quizzes, course, and grading-standard
     reads ran whether or not the catalog proves them.

Hermetic: an in-memory reader; nothing reaches a network.
"""

import os
import sys
from datetime import datetime, timezone

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if TREE not in sys.path:
    sys.path.insert(0, TREE)

from dispatch import executor as ex  # noqa: E402
from query import chain as C  # noqa: E402

NOW = datetime(2026, 9, 22, 15, 0, tzinfo=timezone.utc)
QUIZ = "last_week"
TENANT = "https://school.example.edu"
SYNTHETIC = [{"user_id": 1, "score": 2, "name": "Fixture One"}]


class _Reader:
    def __init__(self):
        self.paths = []

    def get_paginated(self, path):
        self.paths.append(path)
        if "/quiz/v1/" in path:
            return 200, [], None
        if "/quizzes" in path:
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
        if "/grading_standards/" in path:
            return {"grading_scheme": [{"name": "F", "value": 0}]}
        return {"id": 1, "grading_standard_id": 5}

    def close(self):
        pass


@pytest.mark.parametrize("course", [
    "1/../../users/self", "1?per_page=1", "1#x", "../1", "abc", "", " 1",
    "1 ", "0", "-1", "1.0", "sis_course_id:x/y", None, "9" * 30])
def test_bad_course_id_refused_before_any_read(course):
    reader = _Reader()
    with pytest.raises(C.ChainFailure) as info:
        C.run_query(course, QUIZ, reader=reader, now_utc=NOW,
                    tenant_base=TENANT, synthetic_rows=SYNTHETIC)
    assert reader.paths == []
    assert info.value.translated.mode_id == "query-course-id-invalid"
    assert "—" not in info.value.translated.agent_message


def test_cli_refuses_bad_course_before_any_read(monkeypatch, capsys):
    def boom(*a, **k):
        raise AssertionError("no reader may start for a bad course id")
    monkeypatch.setattr(C._live_read, "LiveReader", boom)
    assert C.main(["--quiz", "last-week", "--course", "1/../2",
                   "--tenant", TENANT]) == 2
    assert "course" in capsys.readouterr().out.lower()


def test_good_course_runs_the_chain():
    reader = _Reader()
    result = C.run_query("89585", QUIZ, reader=reader, now_utc=NOW,
                         tenant_base=TENANT, synthetic_rows=SYNTHETIC)
    assert "Quiz 1" in result.text
    assert any("/courses/89585/quizzes" in p for p in reader.paths)


READ_TEMPLATES = [
    ("/api/v1/courses/{}/quizzes", True),
    ("/api/v1/courses/{}/assignments", True),
    ("/api/quiz/v1/courses/{}/quizzes", False),
    ("/api/v1/courses/{}", False),
    ("/api/v1/courses/{}/grading_standards/{}", False),
]


def _template_of(path):
    import re
    path = path.split("?", 1)[0]
    return re.sub(r"/\d+(?=/|$)", "/{}", path)


@pytest.mark.parametrize("template,required", READ_TEMPLATES)
def test_every_chain_read_is_gated(monkeypatch, template, required):
    real = ex._catalog_rows_by_key

    def without_row():
        index = dict(real())
        index.pop(("GET", template), None)
        return index

    monkeypatch.setattr(ex, "_catalog_rows_by_key", without_row)
    reader = _Reader()
    try:
        C.run_query("89585", QUIZ, reader=reader, now_utc=NOW,
                    tenant_base=TENANT, synthetic_rows=SYNTHETIC)
        refused = False
    except C.ChainFailure:
        refused = True
    assert template not in {_template_of(p) for p in reader.paths}
    if required:
        assert refused
