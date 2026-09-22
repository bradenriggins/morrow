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
"""

import os

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)


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
