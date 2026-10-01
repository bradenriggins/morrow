import hashlib
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from moodle import session as module


@pytest.fixture
def roots(tmp_path, monkeypatch):
    home = tmp_path / "state"
    package = tmp_path / "package"
    (package / "moodle").mkdir(parents=True)
    monkeypatch.setenv("MORROW_HOME", str(home))
    monkeypatch.setattr(module, "__file__", str(package / "moodle" / "session.py"))
    return home, package


class Provider:
    def post(self, *args, **kwargs):
        raise AssertionError("no provider request is permitted")


def open_session(**kwargs):
    return module.MoodleSession("https://lms.example.edu", Provider(), "dummy-key", **kwargs)


def test_default_journal_uses_morrow_home_and_leaves_package_clean(roots):
    home, package = roots
    sess = open_session()
    assert Path(sess.journal_dir) == home / "journal" / "moodle"
    sess.journal("synthetic_read", {}, {"id": 1}, op_id="read-1")
    assert (home / "journal" / "moodle" / "moodle.jsonl").exists()
    assert not (package / "journal").exists()


def test_explicit_journal_directory_is_retained(roots, tmp_path):
    explicit = tmp_path / "explicit"
    sess = open_session(journal_dir=str(explicit))
    assert Path(sess.journal_dir) == explicit


def test_legacy_journal_is_preserved_and_blocks_replay(roots):
    home, package = roots
    legacy = package / "journal" / "moodle"
    legacy.mkdir(parents=True)
    record = legacy / "moodle.jsonl"
    contents = json.dumps({"op_id": "old-write", "receipt": {"id": 1}}) + "\n"
    record.write_text(contents)
    sess = open_session()
    assert Path(sess.journal_dir) == home / "journal" / "moodle"
    with pytest.raises(module.MoodleLaneError, match="already used"):
        sess.write({"op_id": "old-write", "tool": "synthetic_create"})
    assert record.read_text() == contents


def test_legacy_ambiguous_reservation_blocks_replay(roots):
    home, package = roots
    legacy = package / "journal" / "moodle" / "reservations"
    legacy.mkdir(parents=True)
    name = hashlib.sha256(b"old-write").hexdigest()
    record = legacy / name
    record.write_text("{truncated")
    sess = open_session()
    assert Path(sess.journal_dir) == home / "journal" / "moodle"
    with pytest.raises(module.MoodleLaneError, match="already used"):
        sess.write({"op_id": "old-write", "tool": "synthetic_create"})
    assert record.read_text() == "{truncated"


def test_corrupt_legacy_journal_refuses_new_writes(roots):
    home, package = roots
    legacy = package / "journal" / "moodle"
    legacy.mkdir(parents=True)
    (legacy / "moodle.jsonl").write_text("{truncated")
    with pytest.raises(module.MoodleLaneError, match="journal is corrupt"):
        open_session().write({"op_id": "new-write", "tool": "synthetic_create"})
