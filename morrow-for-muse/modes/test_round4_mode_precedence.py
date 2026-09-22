#!/usr/bin/env python3
"""A saved-default change takes effect everywhere, status tells the
truth per conversation, and a dry run changes and journals nothing.

Failure modes this suite pins down (written before the fix; round-4
audit 2026-09-22, probes audit-muse4/mode1.py and dry_obs.py):
  M2. "Most recent wins" between a conversation plan override and the
      saved default was false. After "plan for this conversation" in
      c1, "edit everywhere" set default_mode=edit but c1 stayed plan
      and the command reported an error, and a write with no
      conversation id stayed plan while any plan override existed.
      "Edit everywhere" must truly apply everywhere, and every status
      must report the true state for the conversation asked about.
      Old plan overrides (set before the newer default) end when the
      newer default is set, and status says why.
  L1. A dry-run write gate (journal=False) still observed the
      conversation: it ended another conversation's edit override and
      journaled the change. A dry run changes nothing and journals
      nothing.

Hermetic: MORROW_HOME and the tree state dir live in pytest's tmp_path.
"""

import glob
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
if TREE not in sys.path:
    sys.path.insert(0, TREE)

USER = "muse:t@school.edu"


@pytest.fixture(autouse=True)
def scratch_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("MORROW_HOME", str(home))
    monkeypatch.setenv("MORROW_TREE_STATE_DIR", str(home / "tree"))
    from dispatch import admission as admission_mod
    monkeypatch.setattr(admission_mod, "SECRETS_DIR", str(home / "secrets"))
    monkeypatch.setattr(admission_mod, "SIGNING_KEY_PATH",
                        str(home / "secrets" / "approval-signing.key"))
    monkeypatch.delenv("MORROW_APPROVAL_SIGNING_KEY", raising=False)
    yield home


def _cmd():
    from settings import commands
    return commands


def _mode(conv=None):
    from modes import state as ms
    return ms.current_mode(USER, conv)


def test_edit_everywhere_after_a_plan_override_applies_everywhere():
    C = _cmd()
    assert C.mode_set(USER, "plan", "c1", this_conversation=True)["mode"] \
        == "plan"
    out = C.mode_set(USER, "edit", "c1")
    assert out["ok"] is True, out["message"]
    assert out["mode"] == "edit"
    assert "every conversation" in out["message"]
    assert (_mode("c1"), _mode("c2"), _mode()) == ("edit", "edit", "edit")
    from modes import state as ms
    assert ms.authorize_write(USER)[0] == "allow"
    assert ms.authorize_write(USER, conversation_id="c1")[0] == "allow"


def test_edit_everywhere_with_no_conversation_id_applies_everywhere():
    C = _cmd()
    C.mode_set(USER, "plan", "c1", this_conversation=True)
    out = C.mode_set(USER, "edit")
    assert out["ok"] is True, out["message"]
    assert (_mode("c1"), _mode()) == ("edit", "edit")


def test_a_newer_conversation_override_wins_in_its_conversation_only():
    C = _cmd()
    C.mode_set(USER, "edit")
    out = C.mode_set(USER, "plan", "c1", this_conversation=True)
    assert out["mode"] == "plan"
    assert (_mode("c1"), _mode("c2")) == ("plan", "edit")
    s1 = C.mode_status(USER, "c1")
    assert s1["mode"] == "plan"
    assert "plan override for this conversation" in s1["message"]
    s2 = C.mode_status(USER, "c2")
    assert s2["mode"] == "edit"
    assert "saved default" in s2["message"]


def test_status_without_a_conversation_names_the_reason():
    C = _cmd()
    C.mode_set(USER, "edit")
    C.mode_set(USER, "plan", "c1", this_conversation=True)
    s = C.mode_status(USER)
    assert s["mode"] == "plan"
    assert "another conversation" in s["message"]
    assert "no conversation" in s["message"]


def test_plan_everywhere_still_clears_every_override():
    C = _cmd()
    C.mode_set(USER, "edit")
    C.mode_set(USER, "edit", "c1", this_conversation=True)
    out = C.mode_set(USER, "plan")
    assert out["ok"] is True
    assert (_mode("c1"), _mode("c2"), _mode()) == ("plan", "plan", "plan")


def test_an_old_plan_override_ends_when_a_newer_default_is_set():
    """A plan override stored before the newer saved default (for
    example by an older install) no longer applies: it ended when the
    educator set the newer default. Status says so."""
    from settings import store
    C = _cmd()
    C.mode_set(USER, "edit")

    def mutate(doc):
        doc.setdefault("conversation_overrides", {})["c9"] = {
            "mode": "plan", "set_at": "2020-01-01T00:00:00+00:00"}
        return None, "plan"
    store._transact(USER, mutate, "settings.conversation_mode",
                    "conversation_mode", None,
                    extra={"conversation_id": "c9"})
    assert _mode("c9") == "edit"
    assert _mode() == "edit"
    assert store.has_plan_override(USER) is False
    s = C.mode_status(USER, "c9")
    assert s["mode"] == "edit"
    assert "ended" in s["message"]


def test_docs_state_the_true_rule():
    for rel in ("SKILL.md", "settings/README.md"):
        with open(os.path.join(TREE, rel), encoding="utf-8") as fh:
            text = fh.read()
        assert "Changing the saved default ends every per-conversation " \
            "override" in text, rel
        assert "Most recent explicit action wins" not in text, rel
        assert "the last thing you said wins" not in text, rel


# ---------------------------------------------------------------- L1 --

def _journal_and_audit_counts(home):
    journal = sum(sum(1 for _ in open(p))
                  for p in glob.glob(str(home) + "/**/ops.jsonl",
                                     recursive=True))
    audit = sum(sum(1 for _ in open(p))
                for p in glob.glob(str(home) + "/settings/*.changes.jsonl"))
    return journal, audit


def test_dry_run_gate_changes_and_journals_nothing(scratch_home):
    from modes import state as ms
    from modes import errors as me
    from dispatch import admission as A
    C = _cmd()
    C.mode_set(USER, "edit", "c1", this_conversation=True)
    assert _mode("c1") == "edit"
    before = _journal_and_audit_counts(scratch_home)
    entry = {"name": "canvas_update_page", "effects": "write",
             "request": {"method": "PUT",
                         "url": "{canvas_base}/api/v1/courses/"
                                "{course_id}/pages/x"}}
    with pytest.raises(me.PlanModeWriteWithoutApproval):
        A.check_mode_authority(entry, {"course_id": "1"}, None,
                               {"user_id": USER, "conversation_id": "c2"},
                               journal=False)
    assert _journal_and_audit_counts(scratch_home) == before
    assert ms.current_mode(USER, "c1") == "edit"
