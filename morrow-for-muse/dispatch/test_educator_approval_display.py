#!/usr/bin/env python3
"""The approval the educator reads is plain words.

Failure mode this suite pins down (written before the fix; final sweep
2026-09-22, probe ux1/tests/test_receipt.py): SKILL.md told the agent
to show `approval_display` exactly as printed, and plan-write printed
raw developer output: the REST method and path, the operation id, a
category key, the JSON body and params, sha256 integrity codes,
microsecond ISO timestamps, and "declares no undo block". That is the
main Plan-mode approval surface.

The educator part now says, in plain words, which course, what
changes (every value that will be sent), whether Morrow can undo it,
and how to approve. The method, path, JSON, digests, and category move
to `audit_detail`, which the agent does not relay.

Hermetic: fake provider session; journal, approvals, and the signing
key live in pytest's tmp_path.
"""

import json
import os
import re

from dispatch import approval_display
from dispatch import executor as ex
from dispatch.admission import mint_approval
from dispatch.test_round4_write_ceremony import (  # noqa: F401
    BASE, FakeSession, NAME, PARAMS, TARGET, _canvas, _cli, _entry,
    _fake_store, _plan_write_argv, hermetic, hermetic_keys)

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JARGON = ("canvas_update_create_page_courses", "PUT", "/api/v1",
          "sha256", "Integrity", "Category", "canvas.", "undo block",
          "Operation", "PAYLOAD", "{", "}", "wiki_page", "Params")
MICROSECONDS = re.compile(r"\d{2}:\d{2}:\d{2}\.\d+")


def _prepared(monkeypatch, body):
    _fake_store(monkeypatch, FakeSession(_canvas()))
    code, out = _cli(_plan_write_argv(body))
    assert code == 0, out
    return json.loads(out)


def test_plan_write_shows_the_educator_plain_words(monkeypatch):
    prepared = _prepared(monkeypatch, {"wiki_page": {
        "title": "Week 1 Overview", "published": False}})
    text = prepared["approval_display"]
    for word in JARGON:
        assert word not in text, (word, text)
    assert not MICROSECONDS.search(text), text
    assert '"Bio 101"' in text
    assert "Change the page" in text
    assert "Title: Week 1 Overview" in text
    assert "Published: no" in text
    assert "Morrow cannot undo this change automatically." in text
    assert "reply in any words" in text
    assert "\u2014" not in text


def test_the_audit_detail_keeps_the_exact_request(monkeypatch):
    prepared = _prepared(monkeypatch, {"wiki_page": {
        "title": "Week 1 Overview"}})
    audit = prepared["audit_detail"]
    assert "PUT /api/v1/courses/101/pages/week-1" in audit
    assert '"title": "Week 1 Overview"' in audit
    assert "sha256" in audit
    assert "audit_detail" in prepared["message"]
    assert "do not" in prepared["message"].lower()


def test_every_sent_value_is_shown_whole():
    long_text = "<p>" + "x" * 9000 + "TAIL-MARKER</p>"
    body = {"wiki_page": {"title": "Week 2", "body": long_text}}
    record = mint_approval(_entry(body), PARAMS, BASE,
                           target_identity=TARGET)
    text = approval_display.render_educator_display(record, PARAMS,
                                                    entry=_entry(body))
    assert "TAIL-MARKER" in text
    assert "Content: " + long_text in text


def test_create_and_delete_read_as_plain_actions():
    post = ex.catalog_descriptor_to_entry(
        "canvas_create_assignment", "POST",
        "/api/v1/courses/{course_id}/assignments", "write",
        extra={"body": {"assignment": {"name": "Essay 1",
                                       "points_possible": 10,
                                       "due_at": "2026-10-01T23:59:00Z"}}})
    record = mint_approval(post, {"course_id": "101"}, BASE,
                           target_identity=TARGET)
    text = approval_display.render_educator_display(
        record, {"course_id": "101"}, entry=post)
    assert "Create an assignment" in text
    assert "Name: Essay 1" in text and "Points: 10" in text
    assert "Due date: 2026-10-01T23:59:00Z" in text
    delete = ex.catalog_descriptor_to_entry(
        "canvas_delete_assignment", "DELETE",
        "/api/v1/courses/{course_id}/assignments/{id}", "write")
    params = {"course_id": "101", "id": "55"}
    record = mint_approval(delete, params, BASE, target_identity=TARGET)
    text = approval_display.render_educator_display(record, params,
                                                    entry=delete)
    assert 'Delete the assignment "55"' in text


def test_skill_md_shows_the_plain_display_and_never_the_audit_detail():
    with open(os.path.join(TREE, "SKILL.md"), encoding="utf-8") as fh:
        text = " ".join(fh.read().split())
    assert "audit_detail" in text
    assert "never relay `audit_detail`" in text.lower()
