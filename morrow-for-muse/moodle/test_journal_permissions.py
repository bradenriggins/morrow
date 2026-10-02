#!/usr/bin/env python3
"""The Moodle journal keeps codebase permission discipline.

Failure mode pinned down (written before the fix): the journal
(principal names, receipts) was appended with umask-default perms in
a umask-default dir, while the rest of the codebase keeps dir 0700 /
file 0600 (dispatch/executor ensure_journal_dir, 0600-at-open W6-P2-2).
"""

import os
import stat
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from moodle.session import MoodleSession


class _Provider:
    def post(self, url, **kwargs):
        raise AssertionError("no HTTP in a permissions test")


def _mode(path):
    return stat.S_IMODE(os.stat(path).st_mode)


def test_journal_dir_and_file_are_created_private(tmp_path):
    journal_dir = str(tmp_path / "journal")
    sess = MoodleSession("https://lms.example.edu", _Provider(),
                         "sesskey-marker", journal_dir=journal_dir)
    assert _mode(journal_dir) == 0o700
    op_id = sess.journal("tool", {"a": 1}, {"ok": True})
    assert op_id
    assert _mode(sess.journal_path) == 0o600


def test_preexisting_loose_journal_is_tightened(tmp_path):
    journal_dir = tmp_path / "journal"
    journal_dir.mkdir(mode=0o755)
    journal_path = journal_dir / "moodle.jsonl"
    journal_path.write_text('{"op_id": "seed-op"}\n')
    os.chmod(journal_path, 0o644)
    sess = MoodleSession("https://lms.example.edu", _Provider(),
                         "sesskey-marker", journal_dir=str(journal_dir))
    assert _mode(str(journal_dir)) == 0o700
    assert _mode(str(journal_path)) == 0o600
    sess.journal("tool", {"a": 1}, {"ok": True})
    assert _mode(str(journal_path)) == 0o600
