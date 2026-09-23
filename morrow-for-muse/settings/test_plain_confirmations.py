#!/usr/bin/env python3
"""What the agent relays after a mode or setting change is said once, plainly.

Failure modes this suite pins down (written before the fix; final muse
audit 2026-09-22):
  1. `mode set edit` said edit mode stays on "until you turn it off"
     three times and gave the deletion-confirmation note twice: the
     change message was followed by the whole status message.
  2. A setting change relayed the schema description written for
     developers: "When true, ...", "'reactive': ...", "An IANA name",
     "Consequential because it steers where writes land".
  3. A refused value relayed the validator's text ("must be one of
     ['balanced', ...], got 'loud'", "unknown IANA timezone").
Each change now answers in one short message the educator can read:
what changed and what it means for them, each fact once.

Hermetic: MORROW_HOME is a tmp dir (conftest isolates HOME).
"""

import re

import pytest

SCHEMA_WORDS = ("When true", "when true", "when false", "IANA",
                "Consequential", "per_write", "preference the assistant",
                "must be one of", "got '", "_", "True", "False", "'")


@pytest.fixture
def cmd(tmp_path, monkeypatch):
    monkeypatch.setenv("MORROW_HOME", str(tmp_path / "home"))
    from settings import commands
    return commands


def _count(text, phrase):
    return len(re.findall(re.escape(phrase), text))


def test_edit_everywhere_says_each_fact_once(cmd):
    out = cmd.mode_set("u1", "edit", "c1")
    message = out["message"]
    assert out["mode"] == "edit", message
    assert "every conversation" in message
    assert "apply without asking" in message
    assert "no time limit" in message
    assert _count(message, "until you turn") == 1, message
    assert _count(message, "eletion confirmations") == 1, message
    assert _count(message, "Reads never need approval") == 1, message
    assert "journaled" not in message
    assert "destructive" not in message


def test_edit_for_this_conversation_says_each_fact_once(cmd):
    out = cmd.mode_set("u1", "edit", "c1", this_conversation=True)
    message = out["message"]
    assert out["mode"] == "edit", message
    assert "this conversation" in message
    assert "edit override for this conversation" in message
    assert _count(message, "until you turn") == 1, message
    assert _count(message, "eletion confirmations") == 1, message
    assert "journaled" not in message


@pytest.mark.parametrize("key,value,words", [
    ("verbosity", "concise", "short"),
    ("verbosity", "balanced", "updates"),
    ("verbosity", "detailed", "detailed"),
    ("confirm_destructive_writes", True, "still ask you first"),
    ("confirm_destructive_writes", False, "will not ask you first"),
    ("failure_verbosity", "concise", "what failed and the next step"),
    ("failure_verbosity", "detailed", "your options"),
    ("proactivity", "reactive", "only what you ask"),
    ("proactivity", "suggestive", "suggest"),
    ("read_confirmations", True, "before I read it"),
    ("read_confirmations", False, "without telling you first"),
    ("work_summary", "brief", "one short line"),
    ("work_summary", "full", "every change"),
    ("default_course_id", "12345", "course 12345"),
    ("default_course_id", "", "ask which"),
    ("timezone", "America/Denver", "America/Denver"),
    ("timezone", "", "course's time zone"),
])
def test_every_setting_change_is_one_plain_message(cmd, key, value, words):
    from settings.store import SETTINGS_SCHEMA
    out = cmd.setting_set("u1", key, value)
    message = out["message"]
    assert out["status"] == "done", message
    assert message.startswith("Done: "), message
    assert words in message, message
    assert SETTINGS_SCHEMA[key]["description"] not in message
    for word in SCHEMA_WORDS:
        if word == "_" and key == "timezone":
            continue
        if word == "'" and key == "timezone" and value == "":
            continue
        assert word not in message, (word, message)


@pytest.mark.parametrize("key,value,words", [
    ("verbosity", "loud", "short, normal, or detailed"),
    ("timezone", "Mars/Olympus", "America/Denver"),
    ("default_course_id", "12 345", "course number"),
])
def test_a_refused_value_is_explained_plainly(cmd, key, value, words):
    out = cmd.setting_set("u1", key, value)
    message = out["message"]
    assert out["status"] == "error", message
    assert "Nothing changed" in message or "not changed" in message
    assert words in message, message
    for word in ("IANA", "must be one of", "got '", "chars of"):
        assert word not in message, (word, message)
