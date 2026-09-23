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
  7. FIRST_RUN.md, the agent's first-hour checklist for a real
     educator, began with test-run steps: a clean MORROW_HOME, no live
     profile, and helper and browser ports that must not be the live
     8901/19223. An agent that followed them on an educator's Muse
     computer would split the helper from the state and ports SKILL.md
     uses. Those steps belong to the dev-only install test.
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


def test_first_run_is_for_the_educator_not_a_test_run():
    text = _flat("FIRST_RUN.md")
    for stale in ("Pre-flight", "MORROW_HOME", "no live profile",
                  "Nonproduction", "must not collide", "may collide"):
        assert stale not in text, stale
    with open(os.path.join(TREE, "scripts", "install-e2e.sh"),
              encoding="utf-8") as fh:
        e2e = fh.read()
    assert "8901" in e2e and "19223" in e2e
    assert "scripts/install-e2e.sh" in carve.DEV_ONLY


# Final sweep 2026-09-23 (written before the fix, item
# morrow-command-not-on-path): SKILL.md told the agent to run `morrow mode
# ...`, `morrow settings ...`, `morrow students find ...`, and `morrow
# query ...`, and refusals told it to run `morrow students find`. No
# install step puts `morrow` on PATH, so each failed with "command not
# found" (exit 127). The command is `bin/morrow`, run from the tree root.
_BARE_MORROW = re.compile(r"(?<![\w/.-])morrow (mode|settings|students|"
                          r"query|start|disconnect|doctor|version|failure|"
                          r"audit|plan|dispatch)\b")


def _agent_pages():
    return ["SKILL.md", "SCOPE.md", "FIRST_RUN.md", "INSTALL.md",
            "privacy/FERPA_POLICY.md"] + sorted(
        os.path.relpath(p, TREE)
        for p in glob.glob(os.path.join(TREE, "knowledge", "*.md")))


def test_every_morrow_command_an_agent_reads_is_bin_morrow():
    bare = []
    for rel in _agent_pages():
        for span in re.findall(r"`([^`]+)`", _flat(rel)):
            if _BARE_MORROW.search(span):
                bare.append((rel, span))
    with open(os.path.join(TREE, "failures", "catalog.json"),
              encoding="utf-8") as fh:
        for entry in json.load(fh)["entries"]:
            for field in ("agent_message", "auto_action"):
                for span in re.findall(r"`([^`]+)`", entry.get(field, "")):
                    if _BARE_MORROW.search(span):
                        bare.append((entry["id"], span))
    assert bare == []
    assert "`bin/morrow mode status --conversation-id C`" in \
        _flat("SKILL.md")


def test_a_label_refusal_names_the_command_that_runs(tmp_path,
                                                      monkeypatch):
    from privacy import executor_wire
    monkeypatch.setenv("MORROW_SOURCE_VAULT_PATH",
                       str(tmp_path / "no-vault.json"))
    pytest.importorskip("cryptography")

    class Refused(Exception):
        pass
    with pytest.raises(Refused) as caught:
        executor_wire.resolve_learner_labels(
            {"user_id": "Student A1"}, "https://school.instructure.com",
            "101", "conv-1", error_cls=Refused)
    assert "`bin/morrow students find`" in str(caught.value)
    assert not _BARE_MORROW.search(str(caught.value).replace(
        "bin/morrow", ""))


def test_the_documented_mode_command_runs_from_the_tree_root(tmp_path):
    import subprocess
    env = dict(os.environ, HOME=str(tmp_path),
               MORROW_HOME=str(tmp_path / ".morrow"),
               MORROW_HELPER_ENV_FILE=str(tmp_path / "helper-env"),
               PYTHONDONTWRITEBYTECODE="1")
    env.pop("MORROW_TREE_STATE_DIR", None)
    proc = subprocess.run(
        [sys.executable, "bin/morrow", "mode", "status",
         "--conversation-id", "conv-1"],
        cwd=TREE, env=env, capture_output=True, text=True, timeout=120)
    # Before sign-in no account is pinned, so the command refuses (exit
    # 2) with its JSON message; it is found and it runs.
    assert proc.returncode != 127, proc.stderr
    assert json.loads(proc.stdout)["message"]
