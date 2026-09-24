#!/usr/bin/env python3
"""The failed-students chain may only read what the catalog proves.

The live submissions read (C-419, pending [LEARNER-DATA]) is not
live-proven, so the chain refuses it with a translated message; the
educator must name the course (no built-in default).

Failure modes pinned down (written before the fix; muse UX audit 3):
  1. The refusal came only after the chain read the roster, the quizzes,
     and the assignments, and after it could ask the educator for a time
     zone and save the answer: all for a question it then refused.
  2. bin/morrow query reached the helper first, so with no helper running
     the agent was told to relaunch it, for a task Morrow refuses anyway.
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
    assert reader.paths == []


class _NoReader:
    def __init__(self, *a, **k):
        raise AssertionError("no reader may start for a refused query")


def test_a_live_query_is_refused_before_any_read_or_time_zone_question(
        monkeypatch):
    def no_zone(*a, **k):
        raise AssertionError("no time zone question for a refused query")
    monkeypatch.setattr(C._live_read, "LiveReader", _NoReader)
    monkeypatch.setattr(C, "educator_zone", no_zone)
    with pytest.raises(C.ChainFailure) as info:
        C.run_query("89585", "last_week",
                    tenant_base="https://school.example.edu")
    translated = info.value.translated
    assert translated.mode_id == "catalog-not-proven"
    assert "this task is not one of them yet" in translated.agent_message


def test_the_cli_refuses_before_the_helper_is_reached(monkeypatch, capsys):
    monkeypatch.setattr(C._live_read, "LiveReader", _NoReader)
    rc = C.main(["--course", "89585", "--quiz", "last-week",
                 "--canvas-base", "https://school.example.edu"])
    out = capsys.readouterr().out
    assert rc == 2
    assert "(mode catalog-not-proven, ref " in out
    assert "helper" not in out.lower()


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


def _submissions_row_live_proven():
    try:
        C._require_live_proven(C._SUBMISSIONS_READ)
    except Exception:
        return False
    return True


def _read(rel):
    with open(os.path.join(TREE, rel), encoding="utf-8") as fh:
        return fh.read()


def _release_notes(version):
    notes = _read("CHANGELOG.md").split("\n## %s " % version, 1)[1]
    return notes.split("\n## ", 1)[0]


# What the docs said while the query refused on every live Canvas: the
# question offered as a task, and student data Morrow cannot read listed
# as covered.
AVAILABLE_CLAIMS = (
    "bin/morrow query --course",
    "the failed-students question, rosters",
    "rosters, grades",
    "rosters, submissions",
    "submissions, and grades",
    "the answer to \"who failed last week's quiz\"",
)
DOCS = ("SKILL.md", "INSTALL.md", "SCOPE.md", "content/consent.md",
        "content/setup-guide.md", "install.sh", "privacy/core.py")


def test_no_doc_offers_the_question_while_it_is_refused(capsys):
    if _submissions_row_live_proven():
        return
    shown = {rel: _read(rel) for rel in DOCS}
    shown["CHANGELOG.md 0.4.1"] = _release_notes("0.4.1")
    import importlib.machinery
    import importlib.util
    loader = importlib.machinery.SourceFileLoader(
        "morrow_cli_help", os.path.join(TREE, "bin", "morrow"))
    cli = importlib.util.module_from_spec(
        importlib.util.spec_from_loader("morrow_cli_help", loader))
    loader.exec_module(cli)
    cli.main(["--help"])
    shown["bin/morrow --help"] = capsys.readouterr().out
    found = [(where, claim) for where, text in shown.items()
             for claim in AVAILABLE_CLAIMS
             if claim.lower() in " ".join(text.split()).lower()]
    assert found == []
    assert "not in this version" in shown["bin/morrow --help"]
    skill = " ".join(shown["SKILL.md"].split())
    assert 'students scored under 70%"): not in this version' in skill
