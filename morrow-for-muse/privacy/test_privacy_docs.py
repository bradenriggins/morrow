#!/usr/bin/env python3
"""The privacy docs make only true claims (round-4 privacy audit, DOCS).

Failure modes this suite pins down (written before the doc fix):
  1. SKILL.md promised a "one-time learner_<uuid> token" write path that
     no code runs.
  2. The docs told the educator (and the agent) that a hand-made
     educator_pii_reveal consent file reveals names; that channel is
     retired (an agent can write a file).
  3. FERPA_POLICY.md and privacy/README.md described "Two halves" of a
     boundary, but Muse has no ingress half: names the educator types
     reach the Muse model. The docs must say so plainly.
  4. Stale counts ("69/69") and a refusal message saying the boundary
     "has not landed".
  5. SKILL.md must teach the by-name flow (`students find`).
  6. A rostered name written with a grammatical ending ("Annas" for
     Anna, "Марии" for Мария, "Łukasza" for Łukasz) reaches the model as
     written, because a name matches only as a whole word. The limits
     the agent and the educator read did not say so (final sweep
     2026-09-23).
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
if TREE not in sys.path:
    sys.path.insert(0, TREE)

from privacy import core  # noqa: E402
from privacy import course_content as cc  # noqa: E402


def _read(rel):
    with open(os.path.join(TREE, rel), encoding="utf-8") as fh:
        return fh.read()


def test_docs_do_not_make_the_false_claims():
    skill = _read("SKILL.md")
    policy = _read("privacy/FERPA_POLICY.md")
    readme = _read("privacy/README.md")
    kb = _read("knowledge/privacy-ferpa.md")
    scope = _read("SCOPE.md")
    for text in (skill, policy, readme, kb, scope):
        assert "one-time `learner_<uuid>` token" not in text
        assert "educator_pii_reveal" not in text
        assert "69/69" not in text
        assert "has not landed" not in text
    assert "Two halves" not in policy
    assert "students find" in skill
    assert "names the educator types reach" in skill
    policy_json = _read("dispatch/admission_policy.json")
    assert "has not landed" not in policy_json


def _flat(rel):
    return " ".join(_read(rel).split())


def test_docs_state_the_by_name_limits_honestly():
    """Final muse audit M5: "the agent only ever learns the names you
    type" was not true. A lookup with a guessed name confirms that a
    student with that name is enrolled. FERPA_POLICY.md said a reveal
    needs 20 characters; since the final sweep of 2026-09-22 there is
    no reveal at all, and the policy says so.

    Final sweep 2026-09-23: course content (a page body) is labeled
    through the course roster and put back with the real names, so the
    docs no longer say it reaches the model as written, and they name
    what is still not hidden."""
    skill = _flat("SKILL.md")
    consent = _flat("content/consent.md")
    policy = _flat("privacy/FERPA_POLICY.md")
    kb = _flat("knowledge/privacy-ferpa.md")
    # consent.md is the educator's page: "recorded", not "journaled".
    for text, recorded in ((skill, "every lookup is journaled"),
                           (consent, "every lookup is recorded")):
        assert "only ever learns the names you type" not in text
        assert "confirms that a student with that name is enrolled" in text
        assert recorded in text
        assert "page body" in text
    for text in (skill, consent, policy, kb):
        assert "Course content is not hidden" not in text
        assert "Course content is not de-identified" not in text
        assert "reaches the model as written" not in text
        assert "a page body can carry a person's name" not in text
    assert "puts the real names back in" in consent
    assert "nickname" in consent
    limits = skill[skill.index("Honest limitations"):]
    limits = limits[:limits.index("## Never")]
    assert "course roster" in limits
    assert "confirms that a student with that name is enrolled" in limits
    assert "keep every label and its marker exactly as you read it" in skill
    assert "at least 20 characters" not in policy
    assert "nothing turns it off" in policy


ENDING_ROSTER = [{"id": "741", "name": "Мария Иванова"},
                 {"id": "742", "name": "Łukasz Nowak"},
                 {"id": "743", "name": "Anna Schmidt"}]
ENDING_FORMS = ("Напишите Марии Ивановой.", "Sprawdź pracę Łukasza Nowaka.",
                "Bitte lies Annas Aufsatz.")


def test_a_name_with_a_grammatical_ending_is_a_stated_limit():
    scope = {"canvasOrigin": "https://canvas.example.test", "account": "1",
             "course": "1", "principal": "instructor:7",
             "profile": "private-full"}
    roster = core.LearnerRoster()
    roster.register(scope, ENDING_ROSTER)
    context = {"learnerRoster": roster, "learnerScope": scope,
               "learnerVault": core.LearnerVault(":memory:")}
    prepared = cc.prepare([(identity, "Student A%d" % n)
                           for n, identity in enumerate(ENDING_ROSTER, 1)])
    for identity in ENDING_ROSTER:
        text = "Bitte lies %s." % identity["name"]
        assert identity["name"] not in core.redact_known_learner_text(
            text, context)
        assert identity["name"] not in cc.project_text(text, prepared)
    for text in ENDING_FORMS:
        assert core.redact_known_learner_text(text, context) == text
        assert cc.project_text(text, prepared) == text
    for rel in ("SKILL.md", "privacy/FERPA_POLICY.md",
                "knowledge/privacy-ferpa.md", "content/consent.md"):
        text = _flat(rel)
        assert "grammatical ending" in text, rel
        assert "Annas" in text, rel


def test_approval_display_describes_what_the_reply_approves():
    """Final muse audit L5: approvals accept any non-empty educator
    reply, so "Anything else is not approval" was false."""
    display = _read("dispatch/approval_display.py")
    assert "Anything else is not approval" not in display
    assert "in any words" in display
