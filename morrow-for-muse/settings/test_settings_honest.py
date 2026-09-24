#!/usr/bin/env python3
"""Every setting the educator can change does what it says.

Failure mode this suite pins down (written before the fix; final sweep
2026-09-22): three settings promised behavior no code implements.
`write_approval_style batched` said one approval could cover a listed
set of writes, but plan-write and approve-write handle one write only.
`confirm_bulk_actions` (default on) said bulk edits and "mass messages"
ask first even in edit mode: no gate read it, messages are a standing
exclusion, and edit mode never asks per write. `auto_cleanup_test_
objects` described proof pages the agent creates and deletes, which
no code does. They are gone; an old settings file that holds them
still loads, and they are ignored.

The remaining settings are either enforced by Morrow's code or are
preferences the assistant follows, and the docs say which.

Round-2 finding muse-ux-r2-default-course-accepts-non-number
(2026-09-23, written before the fix): default_course_id accepted any
1-64 character token, so "abc" was saved and confirmed ("I will use
course abc"), while its own refusal asked for "the course number from
Canvas" and every course dispatch refuses a course that is not a
number. It now takes a Canvas course number or nothing. A value an
older version saved still loads (the educator keeps their mode) and
reads as no default course.
"""

import json
import os
import sys
import uuid

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if TREE not in sys.path:
    sys.path.insert(0, TREE)

from settings import commands, store  # noqa: E402

RETIRED = ("write_approval_style", "confirm_bulk_actions",
           "auto_cleanup_test_objects")
ENFORCED = ("default_mode", "confirm_destructive_writes", "timezone")


def test_the_promises_without_code_are_gone():
    for key in RETIRED:
        assert key not in store.SETTINGS_SCHEMA, key
        out = commands.setting_set("honest-user", key, "batched")
        assert out["status"] == "error", key


def test_an_old_settings_file_with_them_still_loads():
    user = "honest-old-file"
    store.set_setting(user, "verbosity", "concise", educator_confirmed=False)
    path = store._settings_path(user)
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    doc["settings"].update({"write_approval_style": "batched",
                            "confirm_bulk_actions": False,
                            "auto_cleanup_test_objects": False})
    store._write_doc_atomic(path, doc)
    assert store.get_setting(user, "verbosity") == "concise"
    shown = store.list_settings(user)
    for key in RETIRED:
        assert key not in shown, key
        with pytest.raises(store.SettingsUnknownKey):
            store.get_setting(user, key)


def test_each_setting_is_enforced_or_a_preference_the_assistant_follows():
    for key, entry in store.SETTINGS_SCHEMA.items():
        if key in ENFORCED:
            continue
        assert "preference the assistant follows" in entry["description"], \
            key


@pytest.mark.parametrize("rel", ["SKILL.md", "settings/README.md",
                                 "modes/README.md"])
def test_the_docs_offer_only_real_settings(rel):
    with open(os.path.join(TREE, rel), encoding="utf-8") as fh:
        text = fh.read()
    for key in RETIRED:
        assert key not in text, (rel, key)
    assert "batched approvals" not in text


def test_the_deletion_setting_claims_only_deletions():
    """Only a delete asks first under confirm_destructive_writes
    (admission._is_destructive: HTTP DELETE, and no catalog row is
    marked destructive), so no text may promise that "other destructive
    writes" such as a page revert or a bulk overwrite ask too (final
    sweep 2026-09-22)."""
    description = store.SETTINGS_SCHEMA["confirm_destructive_writes"][
        "description"]
    assert "other destructive" not in description
    assert "deletes" in description
    with open(os.path.join(TREE, "settings", "README.md"),
              encoding="utf-8") as fh:
        text = " ".join(fh.read().split())
    assert "other destructive writes" not in text
    assert "deletes and destructive writes" not in text


@pytest.mark.parametrize("value", ["abc", "BIO101", "sis_course_id:BIO101",
                                   "0101", "12 345", "1" * 21, "12.5"])
def test_the_default_course_is_a_canvas_course_number(value):
    user = "course-number-%s" % uuid.uuid4().hex
    out = commands.setting_set(user, "default_course_id", value)
    assert out["status"] == "error", out
    assert "course number from Canvas" in out["message"], out
    assert store.get_setting(user, "default_course_id") == ""


def test_a_canvas_course_number_is_saved():
    out = commands.setting_set("course-number-ok", "default_course_id",
                               "89585")
    assert out["status"] == "done", out
    assert "course 89585" in out["message"]


def test_an_older_default_course_that_is_not_a_number_reads_as_none():
    user = "course-number-legacy"
    store.set_setting(user, "default_mode", "edit", educator_confirmed=True)
    path = store._settings_path(user)
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    doc["settings"]["default_course_id"] = "BIO101"
    store._write_doc_atomic(path, doc)
    assert store.get_setting(user, "default_mode") == "edit"
    assert store.get_setting(user, "default_course_id") == ""
    assert store.list_settings(user)["default_course_id"]["value"] == ""
