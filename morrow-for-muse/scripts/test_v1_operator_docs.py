#!/usr/bin/env python3
"""INSTALL.md and SKILL.md describe the Canvas-only v1 that ships.

Failure modes this suite pins down (written before the fix; final
sweep 2026-09-22):
  1. INSTALL.md said writes need a hand-built frozen plan (`--plan`) and
     an approval file (`--approval`), and its troubleshooting called a
     refusal without them "expected". The shipped flow is `plan-write`
     and `approve-write` in plan mode, and no approval in edit mode.
  2. INSTALL.md kept a "Moodle lane: HTTPS is mandatory" section, and
     SKILL.md's session lifecycle named a Moodle lane. v1 is Canvas
     only, and the carve leaves moodle/ out.
  3. INSTALL.md stated one developer tenant's /users/self shape ("This
     tenant's `/users/self` response carries no `login_id` field") as
     fact for every school.
  4. SKILL.md told the agent to have the educator "mint a fresh token"
     on a "PAT lane 401". v1 creates and uses no token (consent.md).
  5. SKILL.md said the legacy purge and wipe commands are "not shipped
     in the distribution"; they ship and run. The educator's deletion
     commands are privacy.executor_wire purge, purge-course, and
     purge-all.
  6. SKILL.md, the knowledge pages, and the failure catalog said New
     Quiz create (C-286) is on evidence hold and refused, so the agent
     told an educator it could not create a New Quiz. The admission
     policy admitted it on proof on 2026-09-22, and SCOPE.md ships it.
     An evidence hold on any other task was also described to the
     educator as "I tried to create a New Quiz".
"""

import contextlib
import glob
import io
import json
import os
import re
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
sys.path.insert(0, HERE)
if TREE not in sys.path:
    sys.path.insert(0, TREE)

import carve  # noqa: E402


def _flat(rel):
    with open(os.path.join(TREE, rel), encoding="utf-8") as fh:
        return " ".join(fh.read().split())


def test_install_points_writes_to_the_typed_flow():
    text = _flat("INSTALL.md")
    for stale in ("Writes need a frozen plan", "expected without `--plan`"):
        assert stale not in text, stale
    for current in ("plan-write", "approve-write", "edit mode"):
        assert current in text, current


def test_no_moodle_lane_in_the_canvas_only_docs():
    assert any(p.startswith("moodle/") for p in carve.DEV_ONLY)
    assert "Moodle lane" not in _flat("INSTALL.md")
    assert "MOODLE_BASE_ALLOW_HTTP" not in _flat("INSTALL.md")
    assert "Moodle lane" not in _flat("SKILL.md")


def test_install_states_no_one_tenants_profile_shape():
    text = _flat("INSTALL.md")
    assert "This tenant's" not in text
    assert "carries no `login_id` field" not in text


def test_skill_asks_for_no_token():
    text = _flat("SKILL.md")
    for stale in ("PAT lane", "mint a fresh token", "personal access token"):
        assert stale not in text, stale


@pytest.mark.parametrize("module", ["privacy.pseudonym",
                                    "privacy.learner_vault",
                                    "privacy.executor_wire"])
def test_the_purge_commands_skill_names_ship_and_run(module):
    assert module.replace(".", "/") + ".py" in carve.shipped_files()
    mod = __import__(module, fromlist=["_cli"])
    out = io.StringIO()
    with contextlib.redirect_stdout(out), pytest.raises(SystemExit) as exc:
        mod._cli(["--help"])
    assert exc.value.code == 0
    assert "purge" in out.getvalue()


def test_skill_names_the_educator_deletion_commands_truthfully():
    text = _flat("SKILL.md")
    assert "not shipped in the distribution" not in text
    for command in ("python3 -m privacy.executor_wire purge",
                    "purge-course", "purge-all"):
        assert command in text, command


def _sentences(rel):
    """Each table row, and each sentence of the prose, of one page."""
    with open(os.path.join(TREE, rel), encoding="utf-8") as fh:
        blocks = re.split(r"\n\s*\n", fh.read())
    out = []
    for block in blocks:
        lines = block.splitlines()
        if lines and all(line.lstrip().startswith("|") for line in lines):
            out.extend(lines)
        else:
            out.extend(re.split(r"(?<=[.;])\s", " ".join(block.split())))
    return out


_NEW_QUIZ_CREATE = re.compile(
    r"canvas_create_new_quiz|New Quiz creat|C-286", re.IGNORECASE)
_HELD = re.compile(r"\bheld\b|\bhold", re.IGNORECASE)


def test_no_agent_page_says_new_quiz_create_is_held():
    from dispatch import admission
    policy = admission.load_policy()
    assert "canvas_create_new_quiz" in policy["admitted_on_proof"]
    assert "canvas_create_new_quiz" not in \
        policy["evidence_holds"]["tool_names"]
    pages = ["SKILL.md", "FIRST_RUN.md", "INSTALL.md"] + sorted(
        os.path.relpath(p, TREE)
        for p in glob.glob(os.path.join(TREE, "knowledge", "*.md")))
    stale = [(rel, sentence[:160]) for rel in pages
             for sentence in _sentences(rel)
             if _NEW_QUIZ_CREATE.search(sentence) and _HELD.search(sentence)]
    assert stale == [], stale


def test_an_evidence_hold_is_told_as_the_task_that_was_asked():
    with open(os.path.join(TREE, "failures", "catalog.json"),
              encoding="utf-8") as fh:
        entries = json.load(fh)["entries"]
    holds = [e for e in entries
             if "EvidenceHold" in json.dumps(e.get("signature"))]
    assert [e["id"] for e in holds] == ["evidence-hold"]
    text = json.dumps(holds[0])
    assert "New Quiz" not in text and "{operation}" in text
