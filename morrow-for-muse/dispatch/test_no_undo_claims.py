#!/usr/bin/env python3
"""The docs promise no undo that the release cannot run.

Failure mode this suite pins down (written before the fix; final sweep
2026-09-22): SKILL.md told the agent to run `execute --entry` and
`undo --entry ... --of-op-id ...`, SCOPE.md listed "undo entries for
undoable writes", the operations runbook and audit checklist called
undo covered, and the 0.4.0 changelog said "Undo is its own approved
write". The pack pins no entry (pack/pack.json "entries" is empty), so
the executor refuses every `execute --entry` and every `undo`
(ManifestPinMismatch). An educator who asked to undo a change got the
"unknown" failure. Every catalog write's approval display already says
"Morrow cannot undo this change automatically."

While the pack pins no entry, the agent-facing docs describe no
execute or undo command and say plainly that this release has no
automatic undo.
"""

import glob
import json
import os

import pytest

from dispatch import executor as ex

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = (["SKILL.md", "SCOPE.md", "FIRST_RUN.md", "INSTALL.md",
         "dispatch/approval-ceremony.md", "CHANGELOG.md"]
        + sorted(os.path.relpath(p, TREE) for p in
                 glob.glob(os.path.join(TREE, "knowledge", "*.md"))
                 + glob.glob(os.path.join(TREE, "content", "*.md"))))
PROMISES = ("execute --entry", "`undo` runs", "undo --entry",
            "undo entries for undoable writes",
            "Undo is its own approved write",
            "Runs as a new, separately journaled operation with its own "
            "educator approval bound to the undo action")


def _pack():
    with open(os.path.join(TREE, "pack", "pack.json"),
              encoding="utf-8") as fh:
        return json.load(fh)


def _flat(rel):
    with open(os.path.join(TREE, rel), encoding="utf-8") as fh:
        return " ".join(fh.read().split())


def test_the_pack_pins_no_entry_so_execute_and_undo_refuse():
    pack = _pack()
    assert pack["entries"] == []
    entry = os.path.join(TREE, "catalog", "a11y",
                         "morrow_plan_page_image_alt_repair.json")
    with pytest.raises(ex.ManifestPinMismatch):
        ex.load_manifest_entry(entry, pack)


@pytest.mark.parametrize("rel", DOCS)
def test_no_doc_offers_an_undo_the_release_cannot_run(rel):
    if _pack()["entries"]:
        pytest.skip("the pack pins entries; undo docs are checked live")
    text = _flat(rel)
    for promise in PROMISES:
        assert promise not in text, (rel, promise)


def test_skill_says_there_is_no_automatic_undo():
    text = _flat("SKILL.md")
    assert "no automatic undo" in text
    assert "cannot undo this change automatically" in text
