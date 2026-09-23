#!/usr/bin/env python3
"""A bilingual course name is not a homoglyph spoof.

Failure mode this suite pins down (written before the fix; final sweep
2026-09-22, probes final-sweep/muse-engine/p1_spoof.py and
test_p2_bilingual.py):
  spoof_characters flagged every name that held Latin letters plus any
  Cyrillic or Greek letter anywhere in the string. "Русский язык
  (Russian Language I)", "Greek 101: Ελληνικά" and "Statistics: μ and
  σ" were refused as spoofs, so every write (edit mode) and every
  plan-write (plan mode) on those courses failed with
  TargetIdentityMismatch. The spoof shape (UTS #39) is a word that mixes
  scripts, such as "Вiology" with a Cyrillic В: only a word that mixes
  Latin, Cyrillic, or Greek letters is flagged.

Hermetic: fake provider session; journal, approvals, settings, and the
signing key live in pytest's tmp_path.
"""

import json
import os
import sys

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (TREE, os.path.join(TREE, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from dispatch import executor as ex  # noqa: E402
import dispatch.admission as admission_mod  # noqa: E402
from dispatch.test_direct_lane_hardening import (  # noqa: E402,F401
    FakeSession, _pack, hermetic)

BILINGUAL = [
    "Русский язык (Russian Language I)",
    "Greek 101: Ελληνικά",
    "Statistics: μ and σ",
]
SPOOFS = [
    ("Вiology 101", "В"),          # Cyrillic capital Ve inside a Latin word
    ("Bіology 101", "і"),          # Cyrillic i
    ("Biοlogy 101", "ο"),          # Greek omicron
    ("Bio-lоgy 101", "о"),         # the mixed word after a hyphen
    ("Русский язык (Вiology)", "В"),
    ("Pусский язык", "у"),         # a Latin P inside a Russian word
]
NAME = "canvas_update_create_page_courses"
PATH = "/api/v1/courses/{course_id}/pages/{url_or_id}"
PARAMS = {"course_id": "101", "url_or_id": "week-1"}
BODY = {"wiki_page": {"title": "Week 1 Overview"}}
USER = "muse:bilingual@school.edu"
CONV = "conv-bilingual"


@pytest.fixture(autouse=True)
def hermetic_keys(hermetic, monkeypatch):
    monkeypatch.setattr(admission_mod, "SECRETS_DIR",
                        str(hermetic / "secrets"))
    monkeypatch.setattr(admission_mod, "SIGNING_KEY_PATH",
                        str(hermetic / "secrets" / "approval-signing.key"))
    monkeypatch.delenv("MORROW_APPROVAL_SIGNING_KEY", raising=False)
    yield hermetic


@pytest.mark.parametrize("name", BILINGUAL)
def test_bilingual_name_is_not_a_spoof(name):
    assert ex.spoof_characters(name) == []
    ex.assert_no_spoof_identifier(name, "provider course name")


@pytest.mark.parametrize("name,twin", SPOOFS)
def test_a_word_that_mixes_scripts_is_a_spoof(name, twin):
    assert twin in [c for c, _latin in ex.spoof_characters(name)]
    with pytest.raises(ex.TargetIdentityMismatch) as info:
        ex.assert_no_spoof_identifier(name, "provider course name")
    assert "U+%04X" % ord(twin) in str(info.value)


def test_only_the_mixed_word_is_reported():
    assert ex.spoof_characters("Русский язык (Вiology)") == [("В", "B")]


def _canvas(course_name):
    page = {"url": "week-1", "title": "Old"}

    def handler(method, url, body):
        if method == "GET" and url.rstrip("/").endswith("/courses/101"):
            return 200, {}, json.dumps(
                {"id": 101, "name": course_name}).encode()
        if "/pages/" in url and method == "GET":
            return 200, {}, json.dumps(page).encode()
        if "/pages/" in url and method == "PUT":
            page.update(json.loads(body.decode())["wiki_page"])
            return 200, {}, json.dumps(page).encode()
        return 404, {}, b"{}"
    return handler


@pytest.mark.parametrize("course_name", BILINGUAL)
def test_edit_mode_writes_to_a_bilingual_course(course_name):
    from settings import store
    store.set_setting(USER, "default_mode", "edit", educator_confirmed=True)
    session = FakeSession(_canvas(course_name))
    out = ex.dispatch_catalog_op(
        NAME, "PUT", PATH, None, PARAMS, extra={"body": BODY},
        session=session, pack=_pack(),
        mode_ctx={"user_id": USER, "conversation_id": CONV,
                  "course_resolution": {"course_id": "101",
                                        "confidence": 1.0,
                                        "user_confirmed": True}})
    assert out["outcome"] == "verified"
    assert [c[0] for c in session.calls].count("PUT") == 1


@pytest.mark.parametrize("course_name", BILINGUAL)
def test_plan_write_prepares_for_a_bilingual_course(course_name):
    out = ex.prepare_plan_write(NAME, "PUT", PATH, PARAMS, BODY,
                                FakeSession(_canvas(course_name)), _pack())
    assert out["status"] == "awaiting_approval"
    assert out["course"]["name"] == course_name


def test_edit_mode_refuses_a_spoofed_course_name():
    from settings import store
    store.set_setting(USER, "default_mode", "edit", educator_confirmed=True)
    session = FakeSession(_canvas("Вiology 101"))
    with pytest.raises(ex.TargetIdentityMismatch):
        ex.dispatch_catalog_op(
            NAME, "PUT", PATH, None, PARAMS, extra={"body": BODY},
            session=session, pack=_pack(),
            mode_ctx={"user_id": USER, "conversation_id": CONV,
                      "course_resolution": {"course_id": "101",
                                            "confidence": 1.0,
                                            "user_confirmed": True}})
    assert "PUT" not in [c[0] for c in session.calls]
