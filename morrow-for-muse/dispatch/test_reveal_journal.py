#!/usr/bin/env python3
"""A sealed educator reveal shows real names to the agent, never to the journal.

Failure modes this suite pins down (written before the fix; final muse
audit 2026-09-22, H1, proof final-muse/tests/test_reveal_journal.py):
  1. A PII reveal read journaled the REVEALED receipt: real names,
     emails, SIS ids, and Canvas ids went into the sealed, append-only
     journal, which purge cannot rewrite. The journal must always get
     the de-identified projection (labels), while the agent gets the
     revealed result it asked for.
  2. The journal record still says a reveal happened (the audit), so a
     reviewer can see who revealed what course and when.
  3. A reveal for one course never reveals another course's read.
  4. A read with no reveal stays de-identified everywhere (unchanged).
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
from dispatch import admission as ad  # noqa: E402
from dispatch.test_by_name_e2e import (  # noqa: E402,F401
    BASE, CONV, USER, BrowserFake, _journal_text, hermetic, world)
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
        return self._ok(ROSTER)


def _read(course, reveal=None):
    return ex.dispatch_catalog_op(
        _users_op(), "GET", USERS_PATH, "read", {"course_id": course},
        pack=_pack(), session=RosterCanvas(),
        mode_ctx={"user_id": USER, "conversation_id": CONV},
        pii_reveal=reveal)


def _journal_records():
    return [json.loads(line) for line in _journal_text().splitlines()
            if line.strip()]


def test_revealed_read_journals_the_de_identified_projection():
    reveal = ad.mint_pii_reveal(BASE, "1", "show me real names",
                                channel="educator-chat")
    before = _journal_text()
    out = _read("1", reveal)
    # The agent gets what the educator asked for.
    assert "Jane Doe" in json.dumps(out)
    # The journal never holds identity: only the op records written by
    # this read are checked (the reveal mint record itself is journaled
    # separately and carries no roster data).
    added = _journal_text()[len(before):]
    assert added.strip(), "the read journaled nothing"
    leaked = [s for s in IDENTIFIERS if s in added]
    assert leaked == [], leaked
    reads = [r for r in _journal_records() if r.get("entry_name")
             == _users_op() and r.get("wal") == "complete"]
    assert reads and reads[-1].get("pii_reveal"), \
        "the journal must still record that a reveal happened"
    # The de-identified receipt is journaled (one record per student),
    # not dropped.
    assert len(reads[-1]["receipt"]) == len(ROSTER)


def test_reveal_is_course_scoped_and_no_reveal_stays_de_identified():
    reveal = ad.mint_pii_reveal(BASE, "1", "show me real names",
                                channel="educator-chat")
    other = _read("2", reveal)
    assert "Jane" not in json.dumps(other)
    plain = _read("1")
    assert "Jane" not in json.dumps(plain)
    op_text = "\n".join(json.dumps(r) for r in _journal_records()
                        if r.get("entry_name") == _users_op())
    assert [s for s in IDENTIFIERS if s in op_text] == []
