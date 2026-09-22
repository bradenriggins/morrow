#!/usr/bin/env python3
"""Edit mode is proposed ONLY from an explicit allowlist of commands.

Failure modes this suite pins down (written before the fix; third-pass
re-audit 2026-09-22, probe reaudit3/parse3.py):
  1. Word-list parsing kept leaking: off phrasings with an off-word it
     did not know ("pause/suspend/remove/avoid/skip/undo edit mode
     please", "edit mode needs to go away", "I want edit mode gone")
     proposed a standing edit grant.
  2. Negated contractions ("I didn't want edit mode", "We shouldn't use
     edit mode", "I wouldn't like edit mode") proposed edit, and "I
     didn't want edit mode for this conversation" proposed a
     conversation edit override.
  3. "without" / "instead of" phrasings ("let's work without edit mode",
     "instead of edit mode please") proposed edit.
  4. Questions and hedges ("should I use edit mode", "hmm, edit mode
     please?") proposed edit.
  5. Hyphen and run-together spellings ("turn off edit-mode", "stop
     edit-mode", "no edit-mode", "edit-mode off") were not understood.
  6. The oracle: any utterance that is not one of the allowlisted
     affirmative commands must never yield Edit. An off or negative
     signal yields Plan; anything else asks a clarifying question.

The allowlist below is written out by hand, independent of the parser's
grammar, so the parser can never widen it silently.

Stdlib + pytest. MORROW_HOME points at scratch under .selftest-work/.
"""

import itertools
import os
import re
import shutil
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
if TREE not in sys.path:
    sys.path.insert(0, TREE)

from settings import commands  # noqa: E402

USER = "allowlist-user"
CONV = "allowlist-conv"


@pytest.fixture(autouse=True)
def scratch_home():
    root = os.path.join(HERE, ".selftest-work", "allow-%d" % os.getpid())
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
    op, _reply = commands.parse_command(text, USER, CONV)
    return op


def _proposes_edit(op):
    return op.get("value") == "edit" and op.get("action") in (
        "set", "conversation")


def _is_plan(op):
    return op.get("value") == "plan" and op.get("action") in (
        "end_edit", "conversation")


# --- the hand-written allowlist ------------------------------------------

EDIT_CORES = [
    "use edit mode", "switch to edit mode", "turn on edit mode",
    "turn edit mode on", "edit mode on", "enable edit mode",
    "activate edit mode", "put me in edit mode", "go to edit mode",
    "go into edit mode", "change to edit mode", "i want edit mode",
    "make edit mode my default", "edit mode please",
    "switch from plan mode to edit mode", "switch to edit",
]
CONVERSATION_SUFFIXES = [" for this conversation",
                         " for this conversation only", " for this chat"]
POLITE_PRE = ["", "please "]
POLITE_POST = ["", " please", ", please", " thanks", ".", "!"]


def _canon(text):
    t = text.replace("’", "'").lower().strip()
    t = re.sub(r"\bedit[-_ ]?mode\b", "edit mode", t)
    t = re.sub(r"\s+", " ", t)
    return t


def _allowed():
    out = {}
    for core in EDIT_CORES:
        for pre, post in itertools.product(POLITE_PRE, POLITE_POST):
            if core == "edit mode please" and post in (" please",
                                                      ", please"):
                continue
            out[_canon(pre + core + post)] = "default"
            if core in ("make edit mode my default", "edit mode please",
                        "edit mode on", "switch to edit"):
                continue
            for suf in CONVERSATION_SUFFIXES:
                out[_canon(pre + core + suf + post)] = "conversation"
    for suf in ("for this conversation, ", "for this chat, "):
        for core in ("use edit mode", "switch to edit mode"):
            out[_canon(suf + core)] = "conversation"
    return out


ALLOWED = _allowed()


def _is_allowlisted(text):
    return _canon(text) in ALLOWED


# --- phrases from the re-audits ------------------------------------------

REAUDIT3_OFF = [
    "edit mode needs to go away", "pause edit mode please",
    "suspend edit mode please", "remove edit mode please",
    "get rid of edit mode please", "I want edit mode gone",
    "I wouldn't like edit mode", "I didn't want edit mode",
    "I'd prefer you didn't use edit mode", "We shouldn't use edit mode",
    "we can't have edit mode on", "let's work without edit mode",
    "keep working without edit mode", "instead of edit mode please",
    "edit mode won't be needed, thanks", "I'm not sure about edit mode",
    "I'd rather avoid edit mode", "avoid edit mode please",
    "skip edit mode please", "turn edit mode down please",
    "I regret turning on edit mode", "I regret using edit mode",
    "undo edit mode please", "edit mode is too risky, switch to plan",
    "hate edit mode, use it less", "can you please stop using edit mode",
    "Please exit edit mode", "edit mode: off", "edit-mode off",
    "edit mode -> off", "no edit-mode", "turn off edit-mode",
    "stop edit-mode", "turn edit mode back off", "edit mode, no thanks",
    "edit mode? no thanks", "edit mode is not what I want",
    "use edit mode? absolutely not", "turn off editmode",
    "stop Edit_Mode", "EDIT-MODE OFF", "switch edit mode off",
]

REAUDIT3_CONVERSATION_OFF = [
    "I didn't want edit mode for this conversation",
    "no edit-mode for this chat",
    "turn off edit-mode for this conversation",
]

QUESTIONS_AND_HEDGES = [
    "maybe edit mode?", "hmm, edit mode please?", "is it safe to use edit mode",
    "should I use edit mode", "use edit mode?", "edit mode?",
    "could edit mode help here", "maybe use edit mode",
    "I think I want edit mode", "perhaps edit mode", "edit mode might be ok",
    "edit mode I guess", "I suppose edit mode", "edit mode or plan mode",
    "yeah right, use edit mode", "oh great, edit mode, just what I needed",
    "sure, use edit mode, what could go wrong", "wow edit mode, amazing",
    "what does edit mode do", "tell me about edit mode", "what is edit mode",
    "can you use edit mode", "would edit mode be faster",
    "use edit mode if you think so", "edit mode",
]

OTHER_PLAN_PHRASES = [
    "I want to use edit mode instead of plan mode",
    "use edit mode instead of plan mode",
    "switch from plan mode into edit mode",
    "ditch plan mode, use edit mode",
    "without plan mode please",
]

OFF_TAILS = [
    " less", " gone", " away", " no more", " not", " never", " off",
    ", no thanks", " is a mistake", " is too risky", ", nope",
    " is the wrong choice",
]
OFF_HEADS = [
    "don't ", "do not ", "didn't ", "I didn't want to ", "we shouldn't ",
    "we can't ", "I won't ", "I wouldn't ", "never ", "not ", "no ",
    "without ", "instead of ", "less ", "pause ", "suspend ", "remove ",
    "avoid ", "skip ", "undo ", "stop ", "quit ", "exit ", "leave ",
    "cancel ", "disable ", "get rid of ", "I regret ", "I hate ",
    "I'd rather not ", "I'd prefer not to ", "please don't ",
    "we can do without ", "let's not ", "no longer ",
]
HEDGE_HEADS = [
    "maybe ", "perhaps ", "should I ", "should we ", "is it ok to ",
    "do you think I should ", "hmm, ", "I guess ", "might ",
    "yeah right, ", "oh sure, ", "what if we ", "can we ", "could you ",
    "why would I ",
]


def _generated():
    bases = ["use edit mode", "switch to edit mode", "turn on edit mode",
             "edit mode", "edit-mode", "editmode", "enable edit mode",
             "use edit mode for this conversation", "edit mode on"]
    off, hedge = [], []
    for base in bases:
        for head in OFF_HEADS:
            off.append(head + base)
        for tail in OFF_TAILS:
            off.append(base + tail)
        for head in HEDGE_HEADS:
            hedge.append(head + base)
        hedge.append(base + "?")
        hedge.append(base + " maybe")
    return off, hedge


GENERATED_OFF, GENERATED_HEDGE = _generated()

# The round-2 negation table (17 x 6 x 6 = 612 phrases), re-run with the
# hyphen spellings folded in.
NEGATORS = ["don't", "do not", "never", "no more", "stop", "turn off",
            "switch off", "exit", "leave", "end", "quit", "cancel",
            "disable", "no longer", "I don't want", "get out of", "not"]
VERBS = ["", "use ", "turn on ", "switch to ", "enable ", "go into "]
SCOPES = ["", " for this conversation", " for this chat", " please",
          " anymore", " now"]
SPELLINGS = ["edit mode", "edit-mode", "editmode"]


def _round2():
    out = []
    for neg, verb, scope, spell in itertools.product(NEGATORS, VERBS, SCOPES,
                                                     SPELLINGS):
        out.append("%s %s%s%s" % (neg, verb, spell, scope))
    return out


ROUND2 = _round2()

ALL_ADVERSARIAL = (REAUDIT3_OFF + REAUDIT3_CONVERSATION_OFF
                   + QUESTIONS_AND_HEDGES + OTHER_PLAN_PHRASES
                   + GENERATED_OFF + GENERATED_HEDGE + ROUND2)


def test_adversarial_table_is_large():
    assert len(set(ALL_ADVERSARIAL)) > 2000


def test_no_non_allowlisted_phrase_ever_yields_edit():
    bad = []
    for text in ALL_ADVERSARIAL:
        if _is_allowlisted(text):
            continue
        op = _op(text)
        if _proposes_edit(op):
            bad.append((text, op["action"], op["value"]))
    assert not bad, "%d leaks, first: %r" % (len(bad), bad[:15])


@pytest.mark.parametrize("text", sorted(ALLOWED))
def test_allowlisted_commands_propose_edit(text):
    op = _op(text)
    assert _proposes_edit(op), (text, op)
    assert op["needs_confirmation"] is True
    want = "conversation" if ALLOWED[text] == "conversation" else "set"
    assert op["action"] == want, (text, op)


@pytest.mark.parametrize("text", ["Use Edit Mode", "USE EDIT-MODE!!!",
                                  "Please switch to Edit-Mode.",
                                  "use editmode thanks",
                                  "Use edit mode for this Chat"])
def test_allowlist_tolerates_case_hyphen_politeness(text):
    assert _proposes_edit(_op(text)), text


@pytest.mark.parametrize("text", REAUDIT3_OFF + GENERATED_OFF)
def test_off_signals_are_plan(text):
    op = _op(text)
    assert _is_plan(op), (text, op)


@pytest.mark.parametrize("text", REAUDIT3_CONVERSATION_OFF)
def test_conversation_off_signals_are_conversation_plan(text):
    op = _op(text)
    assert (op["action"], op["value"]) == ("conversation", "plan"), (text, op)
    assert op["needs_confirmation"] is False


@pytest.mark.parametrize("text", QUESTIONS_AND_HEDGES + GENERATED_HEDGE)
def test_questions_and_hedges_ask_and_never_change_mode(text):
    op = _op(text)
    assert not _proposes_edit(op), (text, op)
    # Asking is the only safe reading of an unclear mention: Plan is
    # allowed too, a change toward edit never is.
    assert op["action"] in ("invalid", "status", "end_edit",
                            "conversation"), (text, op)
    if op["action"] == "conversation":
        assert op["value"] == "plan"


@pytest.mark.parametrize("text", ["hmm, edit mode please?",
                                  "should I use edit mode", "maybe edit mode?",
                                  "is it safe to use edit mode"])
def test_unclear_mentions_get_a_clarifying_question(text):
    op, reply = commands.parse_command(text, USER, CONV)
    assert op["action"] == "invalid", (text, op)
    assert "use plan mode" in reply and "use edit mode" in reply
    assert "—" not in reply


@pytest.mark.parametrize("text", OTHER_PLAN_PHRASES)
def test_mixed_plan_and_edit_mentions_never_edit(text):
    op = _op(text)
    assert not _proposes_edit(op), (text, op)


@pytest.mark.parametrize("text", ["without plan mode please",
                                  "instead of plan mode please"])
def test_negated_plan_without_edit_mention_asks(text):
    op = _op(text)
    assert op["action"] == "invalid", (text, op)
