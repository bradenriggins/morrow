#!/usr/bin/env python3
"""Mode-intent parsing: off-direction first, and never toward edit by accident.

Failure modes this suite pins down (written before the fix; re-audit
2026-09-22, probe reaudit/parse_probe.py):
  1. Negated edit phrases ("don't use edit mode", "never use edit mode",
     "do not turn on edit mode", "switch off edit mode") proposed a
     standing edit grant, the exact opposite of what the educator said.
  2. Conversation-scoped off phrases ("turn off edit mode for this
     conversation", "leave edit mode for this chat") became a
     per-conversation EDIT override.
  3. Plain plan requests ("plan mode please", "put me in plan mode",
     "switch to plan", "I want plan mode", "no more edit mode") were not
     understood at all.
  4. Negating plan mode ("turn off plan mode") proposed edit. A negated
     or ambiguous phrase must land in plan or ask, never propose edit.
  5. Off-direction intent must be decided before on-direction intent:
     any off/stop/leave/end/exit/no-more/negated phrasing about edit
     mode is plan.

Stdlib + pytest. Scratch lives under .selftest-work/ (never /tmp);
MORROW_HOME points there so the real ~/.morrow is never touched.
"""

import itertools
import os
import shutil
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
if TREE not in sys.path:
    sys.path.insert(0, TREE)

from settings import commands  # noqa: E402

USER = "intent-user"
CONV = "intent-conv"


@pytest.fixture(autouse=True)
def scratch_home():
    root = os.path.join(HERE, ".selftest-work", "intent-%d" % os.getpid())
    os.makedirs(root, exist_ok=True)
    old = os.environ.get("MORROW_HOME")
    os.environ["MORROW_HOME"] = root
    import dispatch.admission as adm
    saved = (adm.SECRETS_DIR, adm.SIGNING_KEY_PATH)
    adm.SECRETS_DIR = os.path.join(root, "secrets")
    adm.SIGNING_KEY_PATH = os.path.join(root, "secrets",
                                        "approval-signing.key")
    try:
        yield root
    finally:
        adm.SECRETS_DIR, adm.SIGNING_KEY_PATH = saved
        if old is None:
            os.environ.pop("MORROW_HOME", None)
        else:
            os.environ["MORROW_HOME"] = old
        shutil.rmtree(root, ignore_errors=True)


def _op(text):
    op, reply = commands.parse_command(text, USER, CONV)
    return op, reply


def _proposes_edit(op):
    return op.get("value") == "edit" and op.get("action") in (
        "set", "conversation")


PLAN_EVERYWHERE = [
    "stop edit mode", "turn off edit mode", "use plan mode",
    "back to plan mode", "no more edit mode", "edit mode off",
    "exit edit mode please", "plan mode please", "go back to plan mode",
    "switch back to plan", "switch to plan", "plan mode",
    "I want plan mode", "disable edit mode", "stop using edit mode",
    "don't use edit mode", "don't use edit mode anymore", "no edit mode",
    "edit mode off please", "turn edit mode off",
    "please stop editing without asking", "ask me before every write",
    "ask before writes again", "stop making changes without asking me",
    "require approval again", "plan mode from now on",
    "let's use plan mode", "cancel edit mode", "don't switch to edit mode",
    "never use edit mode", "I don't want edit mode", "turn on plan mode",
    "Use plan mode.", "USE PLAN MODE!!!", "use plan mode, thanks",
    "end the edit mode", "stop the edit mode now", "exit out of edit mode",
    "do not turn on edit mode", "switch off edit mode",
    "put me in plan mode", "change me back to plan",
    "switch from edit mode to plan mode", "I no longer want edit mode",
    "can you switch to plan mode", "get me out of edit mode",
    "dont use edit mode", "Don’t use edit mode",
    "no more edit mode please", "quit edit mode", "leave edit mode",
    "stop editing", "i want to go back to plan mode",
]

PLAN_THIS_CONVERSATION = [
    "turn off edit mode for this conversation",
    "stop edit mode for this chat",
    "leave edit mode for this conversation",
    "use plan mode for this conversation",
    "for this chat, use plan mode",
    "no edit mode in this conversation",
    "don't use edit mode for this chat",
    "plan mode for this conversation please",
    "exit edit mode for this chat",
]

EDIT_DEFAULT = [
    "use edit mode", "switch to edit mode", "turn on edit mode",
    "make edit mode my default", "use edit mode for an hour",
    "enable edit mode", "put me in edit mode", "I want edit mode",
    "switch from plan mode to edit mode", "edit mode please",
]

EDIT_THIS_CONVERSATION = [
    "use edit mode for this conversation",
    "use edit mode for this conversation only",
    "switch to edit mode for this chat",
    "for this conversation, use edit mode",
]

# Negations of plan mode read like "edit, please", but a negation is
# never an edit request: ask, do not propose edit.
ASK_NEVER_EDIT = [
    "turn off plan mode", "disable plan mode", "stop plan mode",
    "don't use plan mode", "no more plan mode", "never ask me before writes",
    "stop asking me before every write", "don't ask before writes",
    "exit plan mode",
]


@pytest.mark.parametrize("text", PLAN_EVERYWHERE)
def test_plan_everywhere(text):
    op, reply = _op(text)
    assert (op["action"], op["key"], op["value"]) == \
        ("end_edit", "default_mode", "plan"), (text, op)
    assert op["needs_confirmation"] is False
    assert "—" not in reply


@pytest.mark.parametrize("text", PLAN_THIS_CONVERSATION)
def test_plan_this_conversation(text):
    op, reply = _op(text)
    assert (op["action"], op["value"]) == ("conversation", "plan"), (text, op)
    # Plan is the safe direction: it applies at once.
    assert op["needs_confirmation"] is False
    assert "—" not in reply


@pytest.mark.parametrize("text", EDIT_DEFAULT)
def test_edit_default_needs_confirmation(text):
    op, _reply = _op(text)
    assert (op["action"], op["key"], op["value"]) == \
        ("set", "default_mode", "edit"), (text, op)
    assert op["needs_confirmation"] is True


@pytest.mark.parametrize("text", EDIT_THIS_CONVERSATION)
def test_edit_this_conversation_needs_confirmation(text):
    op, _reply = _op(text)
    assert (op["action"], op["value"]) == ("conversation", "edit"), (text, op)
    assert op["needs_confirmation"] is True


@pytest.mark.parametrize("text", ASK_NEVER_EDIT)
def test_negated_plan_asks_and_never_proposes_edit(text):
    op, reply = _op(text)
    assert not _proposes_edit(op), (text, op)
    assert op["action"] == "invalid", (text, op)
    assert "use edit mode" in reply and "use plan mode" in reply
    assert "—" not in reply


NEGATORS = ["don't", "do not", "never", "no more", "stop", "turn off",
            "switch off", "exit", "leave", "end", "quit", "cancel",
            "disable", "no longer", "I don't want", "get out of", "not"]
VERBS = ["", "use ", "turn on ", "switch to ", "enable ", "go into "]
SCOPES = ["", " for this conversation", " for this chat", " please",
          " anymore", " now"]


def test_no_negated_or_off_edit_phrase_ever_proposes_edit():
    bad = []
    for neg, verb, scope in itertools.product(NEGATORS, VERBS, SCOPES):
        text = "%s %sedit mode%s" % (neg, verb, scope)
        op, _ = _op(text)
        if _proposes_edit(op):
            bad.append((text, op))
    assert not bad, bad[:10]


def test_edit_mode_off_suffix_phrases_are_plan():
    for tail in ("off", "is off now", "stops here", "ends now", "over"):
        op, _ = _op("edit mode %s" % tail)
        assert not _proposes_edit(op), (tail, op)
        assert op["value"] == "plan", (tail, op)


def test_time_limit_is_explained_not_granted():
    op, reply = _op("edit mode for 30 minutes")
    assert op["action"] == "invalid"
    assert "no time limit" in reply


@pytest.mark.parametrize("text,action", [
    ("what mode am I in", "status"),
    ("am I in edit mode", "status"),
    ("show me my settings", "show"),
    ("what is my default mode", "status"),
])
def test_questions_are_not_mode_changes(text, action):
    op, _ = _op(text)
    assert op["action"] == action, (text, op)


@pytest.mark.parametrize("text", [
    "what is edit mode", "edit the syllabus page", "how does plan mode work",
    "help me plan the unit", "I want to plan my week",
])
def test_non_commands_never_change_mode(text):
    op, _ = _op(text)
    assert op["action"] not in ("set", "conversation", "end_edit"), (text, op)


@pytest.mark.parametrize("text,key,value", [
    ("stop asking me to confirm deletions", "confirm_destructive_writes",
     False),
    ("ask me before bulk actions", "confirm_bulk_actions", True),
    ("don't ask before bulk actions", "confirm_bulk_actions", False),
])
def test_other_guardrail_phrases_unchanged(text, key, value):
    op, _ = _op(text)
    assert (op["action"], op["key"], op["value"]) == ("set", key, value)


def test_conversation_plan_applies_without_extra_confirmation():
    from settings import store
    store.set_setting(USER, "default_mode", "edit", educator_confirmed=True)
    op, _ = _op("turn off edit mode for this conversation")
    reply = commands.apply_command(op, USER, CONV)
    assert store.effective_mode(USER, CONV) == "plan"
    assert "plan mode" in reply
    # Other conversations keep the saved default the educator chose.
    assert store.effective_mode(USER, "another-conv") == "edit"
