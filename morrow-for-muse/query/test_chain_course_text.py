#!/usr/bin/env python3
"""The failed-students answer shows quiz titles with course labels.

Failure modes this suite pins down (written before the fix; final sweep
2026-09-23, finding muse/privacy/course-content-names-reach-model):
  1. The chain read the course outside the executor and showed each
     quiz's title as Canvas has it. A make-up quiz titled "Make-up quiz
     for Jane Doe" put Jane's name in the answer, in the progress line,
     and in the "which quiz did you mean" list.
  2. Like the executor, the chain reads the course's student roster
     first and labels every student a quiz title names; when the roster
     cannot be read, it stops before any quiz is shown.
  3. A synthetic run never touches the learner vault: a name in a
     title is hidden one way instead.

Hermetic: an in-memory reader; nothing reaches a network.
"""

import json
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
TITLE = "Make-up quiz for Jane Doe"
ROSTER = [{"id": 98765, "name": "Jane Doe", "sortable_name": "Doe, Jane",
           "login_id": "jdoe"},
          {"id": 55123, "name": "Robert Smith", "login_id": "rsmith"}]
SYNTHETIC = [{"user_id": 1, "score": 2, "name": "Fixture One"}]


class _Reader:
    def __init__(self, quizzes=None, roster_status=200):
        self.paths = []
        self.roster_status = roster_status
        self.quizzes = quizzes or [
            {"id": 7, "title": TITLE, "assignment_id": 70,
             "due_at": "2026-09-16T15:00:00Z", "points_possible": 10}]

    def get_paginated(self, path):
        self.paths.append(path)
        bare = path.split("?", 1)[0]
        if bare.endswith("/users") or bare.endswith("/enrollments"):
            if self.roster_status != 200:
                return self.roster_status, [], None
            return 200, (ROSTER if bare.endswith("/users") else []), None
        if "/quiz/v1/" in path:
            return 200, [], None
        if "/quizzes" in path:
            return 200, self.quizzes, None
        if "/assignments" in path and "/submissions" not in path:
            return 200, [{"id": q["assignment_id"], "name": q["title"],
                          "due_at": q["due_at"], "points_possible": 10,
                          "grading_type": "points"}
                         for q in self.quizzes], None
        return 200, [], None

    def get_json(self, path):
        self.paths.append(path)
        return {"id": 1}

    def close(self):
        pass


def _run(reader, **kw):
    progress = []
    kw.setdefault("synthetic_rows", SYNTHETIC)
    result = C.run_query("89585", "last_week", reader=reader, now_utc=NOW,
                         tenant_base=TENANT, timezone="America/Chicago",
                         progress=lambda s, d: progress.append((s, d)),
                         **kw)
    return result, progress


@pytest.fixture
def vault(tmp_path, monkeypatch):
    pytest.importorskip("cryptography")
    from privacy import executor_wire as wire
    path = tmp_path / "vault.json"
    monkeypatch.setenv(wire.SOURCE_VAULT_ENV_VAR, str(path))
    return path


def test_a_name_in_a_quiz_title_is_labeled_in_every_output(vault,
                                                            monkeypatch):
    # A live run: the submissions read is the only live read replaced.
    monkeypatch.setattr(C, "_require_live_proven", lambda *a: None)
    reader = _Reader()
    result, progress = _run(reader, synthetic_rows=None)
    shown = json.dumps([result.text, result.report, progress])
    assert "Jane" not in shown and "Doe" not in shown, shown
    assert "Make-up quiz for Student A" in result.report["quiz_title"]
    users = [p for p in reader.paths if p.split("?")[0].endswith("/users")]
    quizzes = [p for p in reader.paths if "/quizzes" in p]
    assert users and reader.paths.index(users[0]) < \
        reader.paths.index(quizzes[0])


def test_the_which_quiz_list_carries_labels(vault):
    quizzes = [
        {"id": 7, "title": TITLE, "assignment_id": 70,
         "due_at": "2026-09-16T15:00:00Z", "points_possible": 10},
        {"id": 8, "title": "Quiz 2 (Robert Smith reviews)",
         "assignment_id": 80, "due_at": "2026-09-17T15:00:00Z",
         "points_possible": 10}]
    with pytest.raises(C.ChainFailure) as info:
        _run(_Reader(quizzes=quizzes))
    text = json.dumps([info.value.translated.agent_message,
                       info.value.translated.evidence])
    for secret in ("Jane", "Doe", "Robert", "Smith"):
        assert secret not in text, text


def test_an_unreadable_roster_stops_before_any_quiz_is_read():
    reader = _Reader(roster_status=403)
    with pytest.raises(C.ChainFailure) as info:
        _run(reader)
    assert not [p for p in reader.paths if "/quizzes" in p]
    assert "Jane" not in info.value.translated.agent_message


def test_a_synthetic_run_hides_the_name_without_the_vault(tmp_path,
                                                          monkeypatch):
    from privacy import executor_wire as wire
    path = tmp_path / "never.json"
    monkeypatch.setenv(wire.SOURCE_VAULT_ENV_VAR, str(path))
    result, progress = _run(_Reader())
    shown = json.dumps([result.text, result.report, progress])
    assert "Jane" not in shown and "Doe" not in shown, shown
    assert "[hidden: student name]" in result.report["quiz_title"]
    assert not path.exists()
