#!/usr/bin/env python3
"""The model never sees a student name the educator did not type.

Failure mode this suite pins down (written before the fix; final sweep
2026-09-22): the educator "reveal" (dispatch.admission.mint_pii_reveal
plus the executor's --pii-reveal) skipped de-identification and handed
every student's real name, email, and login to the agent, and so to the
Muse model, for up to 30 minutes. SKILL.md told the agent how to mint
it, and consent.md told the educator it was the way to see names.

Product rule: the model sees course-scoped labels (Student A5), never
student names, emails, logins, SIS ids, or LMS user ids, except names
the educator typed. There is no reveal: no record, no flag, no file,
no variable.
"""

import contextlib
import io
import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
for _p in (TREE, os.path.join(TREE, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from dispatch import admission  # noqa: E402
from dispatch import executor as ex  # noqa: E402
from privacy import executor_wire as wire  # noqa: E402
from privacy.test_round4_privacy import (  # noqa: E402,F401
    BASE, JANE, USERS, _leaks, vault)


def test_no_code_mints_or_honors_a_reveal():
    for name in ("mint_pii_reveal", "check_pii_reveal",
                 "PII_REVEAL_MAX_MINUTES"):
        assert not hasattr(admission, name), name
    for name in ("pii_reveal_audit", "without_pii_reveal", "REVEALED_BY"):
        assert not hasattr(wire, name), name


@pytest.mark.parametrize("command", ["execute", "catalog", "undo",
                                     "plan-write", "approve-write"])
def test_the_executor_takes_no_reveal_flag(command):
    out = io.StringIO()
    with contextlib.redirect_stdout(out), pytest.raises(SystemExit):
        ex.main([command, "--help"])
    assert "--pii-reveal" not in out.getvalue()


def test_a_reveal_shaped_lane_context_still_de_identifies(vault):
    entry = ex.catalog_descriptor_to_entry(USERS[0], "GET", USERS[1])
    url = ex.render_template(entry["request"]["url"], {"canvas_base": BASE},
                             {"course_id": 1})
    view = ex._projection_entry(entry, url, [dict(JANE)])
    record = {"version": 1, "course_id": "1", "tenant": BASE,
              "channel": "educator-chat", "authorization": "show names"}
    out = wire.project_learner_result(
        view, {"receipt": [dict(JANE)], "truncated": False,
               "bytes_received": 0},
        BASE, lane_context={"pii_reveal": record}, error_cls=RuntimeError)
    assert isinstance(out, dict)
    assert _leaks(out) == [], out
    assert "pii_reveal" not in json.dumps(out)


def test_no_doc_offers_a_reveal():
    for rel in ("SKILL.md", "content/consent.md", "privacy/FERPA_POLICY.md",
                "privacy/README.md", "knowledge/privacy-ferpa.md",
                "knowledge/audit-checklist.md", "FIRST_RUN.md",
                "INSTALL.md", "SCOPE.md"):
        path = os.path.join(TREE, rel)
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as fh:
            text = " ".join(fh.read().split())
        assert "mint_pii_reveal" not in text, rel
        assert "--pii-reveal" not in text, rel
        assert "To see real names from a Canvas read" not in text, rel
