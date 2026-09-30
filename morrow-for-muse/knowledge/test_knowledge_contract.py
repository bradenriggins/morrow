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
import ast
import json
import re
from pathlib import Path

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
    source = ast.parse(_read("transport/chromium_session.py"))
    limit = next(ast.literal_eval(node.value) for node in ast.walk(source)
                 if isinstance(node, ast.Assign)
                 and any(isinstance(target, ast.Name)
                         and target.id == "CHROMIUM_MAX_PAGES"
                         for target in node.targets))
    assert f"{limit} pages" in text
    assert "x-morrow-pagination-partial" in text
    assert "x-morrow-next-page" in text


def test_packaged_knowledge_has_a_complete_local_index_and_doctrine():
    root = Path(TREE)
    index = root / "knowledge/README.md"
    doctrine = root / "knowledge/DOCTRINE.md"
    assert index.is_file() and doctrine.is_file()
    text = index.read_text()
    topics = set(p.name for p in (root / "knowledge").glob("*.md"))
    topics.discard("README.md")
    targets = set(re.findall(r"\]\(([^)#]+)(?:#[^)]*)?\)", text))
    assert topics <= targets
    for target in targets:
        resolved = (index.parent / target).resolve()
        assert resolved.is_relative_to(root) and resolved.is_file(), target
    skill = _read("SKILL.md")
    assert "knowledge/DOCTRINE.md" in skill
    assert "knowledge/README.md" in skill


def test_current_transport_docs_do_not_instruct_managed_browser_execution():
    text = _read("transport/README.md")
    assert "private CDP pipe" in text
    assert "protected loopback forwarder" in text
    assert "The Morrow agent spawns one browser task per batch" not in text
    assert "The Muse product executes Canvas REST calls inside the managed browser" not in text


def test_troubleshooting_distinguishes_network_failure_from_sign_out():
    text = _read("knowledge/troubleshooting-playbook.md")
    assert "ERR_EMPTY_RESPONSE" in text
    assert "config.tree_config" in text
    assert "logged_in=false alone does not prove session expiry" in text
    assert "private CDP pipe" in text
    assert "a launcher that finds 19223" not in text


def test_product_metadata_never_requests_agent_visible_credentials():
    pack = json.loads(_read("pack/pack.json"))
    assert pack["credential_slots"] == {}
    rules = " ".join(pack["governance"]["rules"]).lower()
    assert "plan mode" in rules and "edit mode" in rules
    assert "every write dispatches under a frozen plan digest" not in rules


def test_learner_knowledge_names_the_supported_encryption_floor():
    text = _read("knowledge/privacy-ferpa.md")
    source = ast.parse(_read("privacy/core.py"))
    minimum = next(ast.literal_eval(node.value) for node in ast.walk(source)
                   if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name)
                           and target.id == "_CRYPTOGRAPHY_MIN_VERSION"
                           for target in node.targets))
    assert ".".join(map(str, minimum)) in text
    assert "The raw provider payload stays in a 0600 pending envelope" not in text


def test_educator_knowledge_covers_design_workflows_and_provider_limits():
    required = {
        "instructional-design.md": ["alignment", "retrieval", "rubric", "UDL"],
        "course-visual-design.md": ["saved", "mobile", "heading", "contrast"],
        "teacher-workflows.md": ["time zone", "rollover", "feedback", "accommodations"],
        "lms-administration.md": ["least privilege", "Blueprint", "Moodle", "completion"],
        "accessibility-and-compliance.md": ["FERPA", "WCAG", "jurisdiction", "institution"],
        "canvas-and-moodle.md": ["Classic", "New Quizzes", "sesskey", "capability"],
        "first-use-and-conversation.md": ["course ID", "many courses", "Plan", "Edit"],
    }
    for name, concepts in required.items():
        text = _read("knowledge/" + name)
        for concept in concepts:
            assert concept.lower() in text.lower(), (name, concept)
    doctrine = _read("knowledge/DOCTRINE.md")
    assert "no course-count limit" in doctrine
    assert "knowledge is not dispatch permission" in doctrine.lower()
    assert "Moodle" in doctrine and "production" in doctrine
