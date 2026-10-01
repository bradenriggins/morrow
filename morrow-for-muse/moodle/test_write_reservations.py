import json
import os
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from moodle.session import MoodleSession, MoodleLaneError


class Response:
    status_code = 200
    url = "https://lms.example.edu/lib/ajax/service.php"
    headers = {}

    def json(self):
        return [{"error": False, "data": {"id": 1}}]


class Provider:
    def __init__(self, failure=None):
        self.writes = 0
        self.failure = failure

    def post(self, url, **kwargs):
        method = json.loads(kwargs["data"])[0]["methodname"]
        if method == "synthetic_verify":
            raise RuntimeError("verification unavailable")
        self.writes += 1
        if self.failure:
            raise self.failure
        return Response()


def session(tmp_path, provider):
    return MoodleSession("https://lms.example.edu", provider, "secret-marker",
                         journal_dir=str(tmp_path))


PLAN = {"op_id": "synthetic-write", "tool": "synthetic_create", "args": {}}


@pytest.mark.parametrize("failure", [RuntimeError("lost response"),
                                      SystemExit("simulated process exit")])
def test_ambiguous_write_stays_reserved_after_restart(tmp_path, failure):
    provider = Provider(failure)
    with pytest.raises(type(failure)):
        session(tmp_path, provider).write(PLAN)
    with pytest.raises(MoodleLaneError, match="already used"):
        session(tmp_path, provider).write(PLAN)
    assert provider.writes == 1


def test_failed_verification_cannot_replay_after_restart(tmp_path):
    provider = Provider()
    plan = dict(PLAN, verify={"method": "synthetic_verify",
                             "match": {"field": "id", "value": 1}})
    with pytest.raises(RuntimeError):
        session(tmp_path, provider).write(plan)
    with pytest.raises(MoodleLaneError, match="already used"):
        session(tmp_path, provider).write(plan)
    assert provider.writes == 1


def test_two_preloaded_sessions_cannot_dispatch_same_id(tmp_path):
    provider = Provider()
    first, second = session(tmp_path, provider), session(tmp_path, provider)
    first.write(PLAN)
    with pytest.raises(MoodleLaneError, match="already used"):
        second.write(PLAN)
    assert provider.writes == 1


def test_storage_failure_stops_before_provider(tmp_path, monkeypatch):
    provider = Provider()
    first = session(tmp_path, provider)
    def unavailable(fd):
        raise OSError("synthetic storage failure")
    monkeypatch.setattr(os, "fsync", unavailable)
    with pytest.raises((OSError, MoodleLaneError)):
        first.write(PLAN)
    assert provider.writes == 0


@pytest.mark.parametrize("contents", ["{truncated", '["wrong shape"]\n'])
def test_corrupt_journal_cannot_enable_writes(tmp_path, contents):
    (tmp_path / "moodle.jsonl").write_text(contents)
    provider = Provider()
    with pytest.raises(MoodleLaneError):
        session(tmp_path, provider).write(PLAN)
    assert provider.writes == 0


def test_reservation_contains_no_credentials_or_raw_arguments(tmp_path):
    provider = Provider(RuntimeError("lost response"))
    with pytest.raises(RuntimeError):
        session(tmp_path, provider).write(dict(PLAN, args={"body":"private-marker"}))
    files = list(tmp_path.rglob("*"))
    assert any(p.is_file() for p in files)
    for path in files:
        if path.is_file():
            text = path.read_text()
            assert "secret-marker" not in text
            assert "private-marker" not in text
