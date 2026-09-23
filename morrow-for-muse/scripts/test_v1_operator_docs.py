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
"""

import contextlib
import io
import os
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
