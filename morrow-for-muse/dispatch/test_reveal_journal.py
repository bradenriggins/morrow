#!/usr/bin/env python3
"""A catalog roster read is de-identified for the agent and the journal.

Failure modes this suite pins down (written before the fix; final muse
audit 2026-09-22, H1, proof final-muse/tests/test_reveal_journal.py;
final sweep 2026-09-22):
  1. A PII reveal read journaled the REVEALED receipt: real names,
     emails, SIS ids, and Canvas ids went into the sealed, append-only
     journal, which purge cannot rewrite.
  2. The reveal also handed those names to the agent, and so to the
     model. The reveal is gone: every roster read reaches the agent and
     the journal as labels, and the journal records no reveal.
  3. The checks searched the journal and the result for 5-digit ids and
     short names as substrings, so an HMAC, digest, or op id that
     happened to contain one failed the suite with no leak. A stored
     name or id stands as its own word (found_in).
"""

import json
import os
import sys

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (TREE, os.path.join(TREE, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

pytest.importorskip("cryptography")

from dispatch import executor as ex  # noqa: E402
from dispatch.test_by_name_e2e import (  # noqa: E402,F401
    BASE, CONV, USER, BrowserFake, _journal_text, found_in, hermetic, world)
from dispatch.test_direct_lane_hardening import _pack  # noqa: E402
from learners.test_students_find import ROSTER  # noqa: E402

USERS_PATH = "/api/v1/courses/{course_id}/users"
IDENTIFIERS = ("Jane", "Doe", "98765", "jane.doe@", "20231234", "jdoe",
               "Robert", "55123", "rsmith@", "S-4411")


def _users_op():
    cat = ex._load_operation_catalog()
    names = [n for n, r in cat.items() if r.get("status") == "live-proven"
             and r.get("method") == "GET" and r.get("path") == USERS_PATH]
    assert names, "no live-proven list-users row in the catalog"
    return names[0]


class RosterCanvas(BrowserFake):
    def raw_request(self, method, url, headers, body, is_write=False,
                    max_bytes=None):
        self.calls.append((method, url, None))
        if url.split("?", 1)[0].endswith("/enrollments"):
            return self._ok([])
        return self._ok(ROSTER)


def _read(course):
    return ex.dispatch_catalog_op(
        _users_op(), "GET", USERS_PATH, "read", {"course_id": course},
        pack=_pack(), session=RosterCanvas(),
        mode_ctx={"user_id": USER, "conversation_id": CONV})


def _journal_records():
    return [json.loads(line) for line in _journal_text().splitlines()
            if line.strip()]


def test_roster_read_is_de_identified_for_the_agent_and_the_journal():
    before = _journal_text()
    out = _read("1")
    assert found_in(json.dumps(out), IDENTIFIERS) == []
    added = _journal_text()[len(before):]
    assert added.strip(), "the read journaled nothing"
    assert found_in(added, IDENTIFIERS) == []
    reads = [r for r in _journal_records() if r.get("entry_name")
             == _users_op() and r.get("wal") == "complete"]
    assert reads and "pii_reveal" not in reads[-1]
    # The de-identified receipt is journaled (one record per student),
    # not dropped.
    assert len(reads[-1]["receipt"]) == len(ROSTER)


def test_every_course_read_stays_de_identified():
    for course in ("1", "2"):
        assert "Jane" not in json.dumps(_read(course))
    op_text = "\n".join(json.dumps(r) for r in _journal_records()
                        if r.get("entry_name") == _users_op())
    assert found_in(op_text, IDENTIFIERS) == []
