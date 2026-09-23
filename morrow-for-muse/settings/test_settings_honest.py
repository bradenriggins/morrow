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
"""

import json
import os
import sys

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
