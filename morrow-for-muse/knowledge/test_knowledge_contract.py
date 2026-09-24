#!/usr/bin/env python3
"""The knowledge docs state the shipped dispatch contract.

Failure modes this suite pins down (written before the fix; muse UX
audit 3, finding muse-ux3/knowledge-docs-contradict-executor). SKILL.md
tells the agent to read the knowledge docs before dispatching, and
they contradicted the shipped executor:
  1. operations-runbook.md said learner-data reads are refused "on
     every tenant regardless" and called the refusal an "absolute
     refusal". With the cryptography package the roster read dispatches
     de-identified on the Chromium lane (dispatch/admission.py
     check_learner_data returns early when vault_ready is true); it is
     refused only without it.
  2. It said a body can be sent only programmatically, but the CLI
     takes --body (there is no --query flag).
  3. Its approval rule said the educator "states the exact action in
     their own words" and the agent must "hand them the record to
     sign"; the product rule is that any non-empty educator reply
     approves, and the agent must never restate or gate on wording.
  4. audit-checklist.md's hard line and item-banks-sdk.md said every
     write needs a frozen plan plus a signed approval, which denies
     edit mode (writes need no approval in edit mode, except deletions
     while confirm_destructive_writes is on).
  5. api-patterns-and-errors.md said lists are partial unless the
     agent pages them by hand; the Chromium lane follows Link rel=next
     up to 20 pages and flags the partial case itself.

Read-only: no provider, no browser, no dispatch.
"""

import os
import sys

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(rel):
    with open(os.path.join(TREE, rel), encoding="utf-8") as fh:
        return fh.read()


RUNBOOK = "knowledge/operations-runbook.md"
CHECKLIST = "knowledge/audit-checklist.md"
SDK = "knowledge/item-banks-sdk.md"
API = "knowledge/api-patterns-and-errors.md"


def test_the_runbook_never_says_learner_data_is_refused_everywhere():
    text = " ".join(_read(RUNBOOK).split())
    assert "on every tenant regardless" not in text
    assert "learner-data reads, which the admission gate refuses" not in text
    # The true contract: admitted with cryptography, refused without it.
    assert "de-identified" in text
    # The absolute-refusals passage no longer lists learner-data as
    # unconditional: it names the contingent refusal.
    abs_start = text.index("absolute refusals")
    abs_text = text[abs_start:text.index("Important caveat", abs_start)]
    assert "learner-data" not in abs_text.split("Learner-data")[0] \
        or "contingent refusal" in text


def test_other_knowledge_docs_state_the_same_learner_contract():
    api = " ".join(_read(API).split())
    assert ("dispatch only on the Chromium lane with the encrypted "
            "learner vault") in api
    guide = " ".join(
        _read("knowledge/api-catalog-guide.md").split())
    # The grades/submissions passage no longer describes the
    # learner-data gate as unconditional.
    assert ("refuses them on every tenant, and nothing overrides that"
            not in guide)


def test_the_runbook_names_the_cli_body_flag():
    text = _read(RUNBOOK)
    assert "--body" in text
    assert "To send a body or query block," not in text
    # Programmatic dispatch remains documented, but only for query
    # paging; the body flag is the CLI way.
    assert "There is no `--query` flag" in text


def test_the_runbook_approval_rule_matches_the_product():
    text = " ".join(_read(RUNBOOK).split())
    # The old rule made the agent gate on the educator's wording and
    # hand over a record; the product approves on any non-empty reply.
    assert "states the exact action in their own words" not in text
    assert "hand them the record to sign" not in text


def test_the_hard_lines_do_not_ignore_edit_mode():
    text = " ".join(_read(CHECKLIST).split())
    # The hard line names plan mode (plan-write/approve-write), not a
    # rule that would make every edit-mode write a ceremony violation.
    assert ("Never dispatch a write without the educator-signed approval"
            not in text)
    assert "plan mode" in text
    assert "edit mode" in text
    sdk = " ".join(_read(SDK).split())
    assert "The admission ceremony applies in full" not in sdk


def test_the_lists_partial_passage_names_the_lanes_pagination():
    text = " ".join(_read(API).split())
    assert "Treat any list receipt as partial unless you paged through it" \
        not in text
    assert "20 pages" in text
    assert "x-morrow-pagination-partial" in text
