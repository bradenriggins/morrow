#!/usr/bin/env python3
"""plan-write and approve-write work in Edit mode, and a deletion the
educator approved runs with "always confirm deletions" on.

Failure modes this suite pins down (written before the fix; final sweep
2026-09-23):
  0. In Edit mode, approve-write refused every write with DuplicateOpId
     ("op id ... was already journaled"). The mode gate journals its
     decision (mode.write_admitted or mode.write_refused) before the
     executor claims the op id, and it keyed that record by "op_id",
     so the journal index counted the op as dispatched. A refusal
     burned the op id the same way, so the educator's second yes could
     never run the prepared write. SKILL.md says both commands work in
     Edit mode.
  1. With Edit on and "always confirm deletions" on, the agent showed
     the deletion with plan-write and the educator replied "Yes, delete
     it". approve-write still refused (DestructiveConfirmationRequired):
     it never passed the educator's reply as the deletion's
     confirmation, and a second yes changed nothing.
  2. SKILL.md never named --destructive-confirmed, the one flag the
     refusal asks for, so the agent had no documented way to run a
     deletion the educator confirmed.
  3. The confirmation must stay: a deletion with no educator reply is
     still refused.

Hermetic: fake Canvas session; journal, approvals, settings, grants,
and the signing key live in pytest's tmp_path.
"""

import contextlib
import io
import json
import os
import re
import sys

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (TREE, os.path.join(TREE, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from dispatch import executor as ex  # noqa: E402
import dispatch.admission as admission_mod  # noqa: E402
from dispatch.test_direct_lane_hardening import (  # noqa: E402,F401
    FakeSession, hermetic)

NAME = "canvas_delete_assignment"                 # C-40, live-proven
METHOD = "DELETE"
PATH = "/api/v1/courses/{course_id}/assignments/{id}"
PARAMS = {"course_id": "101", "id": "555"}
USER = "muse:t@school.edu"
CONV = "conv-delete"


@pytest.fixture(autouse=True)
def hermetic_keys(hermetic, monkeypatch):
    monkeypatch.setattr(admission_mod, "SECRETS_DIR",
                        str(hermetic / "secrets"))
    monkeypatch.setattr(admission_mod, "SIGNING_KEY_PATH",
                        str(hermetic / "secrets" / "approval-signing.key"))
    for name in ("MORROW_APPROVAL_SIGNING_KEY", "MORROW_USER_ID",
                 "MORROW_CONVERSATION_ID"):
        monkeypatch.delenv(name, raising=False)
    yield hermetic


def _canvas():
    """Course 101 is Bio 101 with assignment 555 until it is deleted."""
    state = {"exists": True}

    def handler(method, url, body):
        if method == "GET" and url.split("?")[0].rstrip("/") \
                .endswith("/courses/101"):
            return 200, {}, json.dumps({"id": 101,
                                        "name": "Bio 101"}).encode()
        if "/assignments/555" in url:
            if method == "DELETE" and state["exists"]:
                state["exists"] = False
                return 200, {}, json.dumps(
                    {"id": 555, "name": "Quiz 1",
                     "workflow_state": "deleted"}).encode()
            if method == "GET" and state["exists"]:
                return 200, {}, json.dumps({"id": 555,
                                            "name": "Quiz 1"}).encode()
        return 404, {}, b'{"errors": [{"message": "The specified resource does not exist."}]}'
    return handler


def _cli(argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        try:
            code = ex.main(argv)
        except SystemExit as exc:
            code = exc.code
        except Exception as exc:  # noqa: BLE001 - the CLI exits 2
            return 2, "%s: %s" % (type(exc).__name__, exc)
    return code, out.getvalue()


def _deletes(session):
    return [c for c in session.calls if c[0] == "DELETE"]


@pytest.fixture
def edit_with_confirmations(monkeypatch):
    from modes import state as modes
    from settings import store
    modes.request_edit_grant(USER, educator_confirmation={
        "by": "educator", "authorization": "use edit mode here",
        "channel": "educator-chat"}, conversation_id=CONV)
    store.set_setting(USER, "confirm_destructive_writes", True,
                      educator_confirmed=True)
    assert modes.current_mode(USER, CONV) == "edit"
    session = FakeSession(_canvas())
    monkeypatch.setattr(ex.SessionStore, "load",
                        classmethod(lambda cls, path=None: session))
    return session


def _who():
    return ["--backend", "https", "--user-id", USER,
            "--conversation-id", CONV]


# SKILL.md: an edit-mode write through `catalog` names the course the
# educator gave.
RESOLVED = ["--course-resolution", json.dumps(
    {"course_id": "101", "confidence": 1.0, "user_confirmed": True})]


def test_an_edit_mode_rename_runs_through_approve_write(monkeypatch):
    from dispatch.test_round4_write_ceremony import _canvas as page_canvas
    from modes import state as modes
    modes.request_edit_grant(USER, educator_confirmation={
        "by": "educator", "authorization": "use edit mode here",
        "channel": "educator-chat"}, conversation_id=CONV)
    session = FakeSession(page_canvas())
    monkeypatch.setattr(ex.SessionStore, "load",
                        classmethod(lambda cls, path=None: session))
    code, out = _cli([
        "plan-write", "--name", "canvas_update_create_page_courses",
        "--method", "PUT",
        "--path", "/api/v1/courses/{course_id}/pages/{url_or_id}",
        "--params", json.dumps({"course_id": "101", "url_or_id": "week-1"}),
        "--body", json.dumps({"wiki_page": {"title": "Week 1 Overview"}})]
        + _who())
    assert code == 0, out
    code, out = _cli(["approve-write", "--op-id", json.loads(out)["op_id"],
                      "--authorization", "Yes"] + _who())
    assert code == 0, out
    assert json.loads(out)["outcome"] == "verified"
    assert [c[0] for c in session.calls].count("PUT") == 1


def test_a_mode_decision_does_not_use_up_the_op_id():
    from modes import state as modes
    op_id = "00000000-0000-4000-8000-00000000abcd"
    modes.journal_write_refused(USER, NAME, "101", op_id,
                                "destructive_confirmation_required",
                                "needs a yes")
    assert op_id not in ex.used_op_ids()
    token = ex.claim_op_id(op_id, kind="dispatch", entry_name=NAME,
                           effects="write", params_digest="x")
    assert token
    with pytest.raises(ex.DuplicateOpId):
        ex.claim_op_id(op_id, kind="dispatch", entry_name=NAME,
                       effects="write", params_digest="x")


def test_an_approved_deletion_runs(edit_with_confirmations):
    session = edit_with_confirmations
    code, out = _cli(["plan-write", "--name", NAME, "--method", METHOD,
                      "--path", PATH, "--params", json.dumps(PARAMS)]
                     + _who())
    assert code == 0, out
    prepared = json.loads(out)
    assert _deletes(session) == []
    code, out = _cli(["approve-write", "--op-id", prepared["op_id"],
                      "--authorization", "Yes, delete it"] + _who())
    assert code == 0, out
    assert len(_deletes(session)) == 1
    assert json.loads(out)["outcome"] in ("verified", "unconfirmed"), out


def test_a_deletion_without_a_reply_is_still_refused(
        edit_with_confirmations):
    session = edit_with_confirmations
    code, out = _cli(["catalog", "--name", NAME, "--method", METHOD,
                      "--path", PATH, "--params", json.dumps(PARAMS),
                      "--class", "write"] + RESOLVED + _who())
    assert code != 0
    assert "DestructiveConfirmation" in out or "destroy" in out, out
    assert _deletes(session) == []


def test_a_catalog_deletion_with_the_educators_yes_runs(
        edit_with_confirmations):
    session = edit_with_confirmations
    code, out = _cli(["catalog", "--name", NAME, "--method", METHOD,
                      "--path", PATH, "--params", json.dumps(PARAMS),
                      "--class", "write", "--destructive-confirmed",
                      "Yes, delete it"] + RESOLVED + _who())
    assert code == 0, out
    assert len(_deletes(session)) == 1


def test_skill_md_documents_the_deletion_confirmation():
    with open(os.path.join(TREE, "SKILL.md"), encoding="utf-8") as fh:
        text = fh.read()
    assert "--destructive-confirmed" in text
    section = text.split("## Modes and settings", 1)[1] \
        .split("\n## ", 1)[0]
    assert re.search(r"--destructive-confirmed", section), \
        "the Modes section does not say how a confirmed deletion runs"
