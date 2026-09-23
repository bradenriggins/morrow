#!/usr/bin/env python3
"""The agent's commands accept the bulk date update's array body.

Failure mode this suite pins down (written before the fix; final sweep
2026-09-22):
  catalog --body and plan-write --body accepted only a JSON object.
  Live-proven C-37 canvas_bulk_update_assignment_dates takes a bare
  JSON array (the object wrapper 400s, OPERATION_CATALOG.md), and
  knowledge/api-patterns-and-errors.md teaches the agent to send one,
  so the only interface the agent has could never run it. The refusal
  of the agent's own argument then reached the educator as
  "[untrusted provider data]" and "failed in a way I do not have a
  classified pattern for", although nothing was sent to Canvas.

  --body takes a JSON object or a JSON array of objects. A local input
  refusal (--body, --params, --course-resolution) is its own failure
  mode: Morrow checked the request before sending anything, nothing
  changed, and the detail is labeled as Morrow's own check.

Hermetic: fake provider session; journal, approvals, settings, and the
signing key live in pytest's tmp_path.
"""

import contextlib
import io
import json
import os
import sys

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (TREE, os.path.join(TREE, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from dispatch import executor as ex  # noqa: E402
import dispatch.admission as admission_mod  # noqa: E402
from dispatch.test_direct_lane_hardening import (  # noqa: E402,F401
    BASE, FakeSession, _pack, hermetic)
from failures.funnel import ENGINEERING_LABEL, agent_error_payload  # noqa: E402

USER = "muse:bulk@school.edu"
CONV = "conv-bulk"
NAME = "canvas_bulk_update_assignment_dates"
PATH = "/api/v1/courses/{course_id}/assignments/bulk_update"
DUE = "2026-10-01T23:59:00Z"
BULK = [{"id": 5, "all_dates": [{"base": True, "due_at": DUE}]}]
RESOLUTION = json.dumps({"course_id": "101", "confidence": 1.0,
                         "user_confirmed": True})


@pytest.fixture(autouse=True)
def hermetic_keys(hermetic, monkeypatch):
    monkeypatch.setattr(admission_mod, "SECRETS_DIR",
                        str(hermetic / "secrets"))
    monkeypatch.setattr(admission_mod, "SIGNING_KEY_PATH",
                        str(hermetic / "secrets" / "approval-signing.key"))
    monkeypatch.delenv("MORROW_APPROVAL_SIGNING_KEY", raising=False)
    monkeypatch.delenv("MORROW_USER_ID", raising=False)
    monkeypatch.delenv("MORROW_CONVERSATION_ID", raising=False)
    yield hermetic


def _canvas():
    def handler(method, url, body):
        path = url.split("?")[0].rstrip("/")
        if method == "GET" and path.endswith("/api/v1/courses/101"):
            return 200, {}, json.dumps({"id": 101, "name": "Bio 101"}).encode()
        if method == "PUT" and path.endswith("/assignments/bulk_update"):
            return 200, {}, json.dumps(
                {"id": 1, "workflow_state": "queued"}).encode()
        if method == "GET" and path.endswith("/assignments/5"):
            return 200, {}, json.dumps(
                {"id": 5, "due_at": DUE, "overrides": []}).encode()
        return 404, {}, b"{}"
    return handler


@pytest.fixture
def session(monkeypatch):
    fake = FakeSession(_canvas())
    monkeypatch.setattr(ex.SessionStore, "load",
                        classmethod(lambda cls, path=None: fake))
    return fake


def _run(argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = ex.main(argv)
    return code, out.getvalue()


def _catalog_argv(body_text):
    return ["catalog", "--name", NAME, "--method", "PUT", "--path", PATH,
            "--params", json.dumps({"course_id": "101"}),
            "--body", body_text, "--backend", "https",
            "--user-id", USER, "--conversation-id", CONV,
            "--course-resolution", RESOLUTION]


def _puts(fake):
    return [c for c in fake.calls if c[0] == "PUT"]


def test_catalog_sends_an_array_body_in_edit_mode(session):
    from settings import store
    store.set_setting(USER, "default_mode", "edit", educator_confirmed=True)
    code, out = _run(_catalog_argv(json.dumps(BULK)))
    assert code == 0, out
    assert json.loads(out)["outcome"] == "verified"
    puts = _puts(session)
    assert len(puts) == 1
    assert json.loads(puts[0][3].decode()) == BULK


def test_plan_write_prepares_an_array_body_and_approve_sends_it(session):
    code, out = _run(["plan-write", "--name", NAME, "--method", "PUT",
                      "--path", PATH,
                      "--params", json.dumps({"course_id": "101"}),
                      "--body", json.dumps(BULK), "--backend", "https",
                      "--user-id", USER, "--conversation-id", CONV])
    assert code == 0, out
    prepared = json.loads(out)
    assert prepared["course"]["name"] == "Bio 101"
    assert _puts(session) == []
    code, out = _run(["approve-write", "--op-id", prepared["op_id"],
                      "--authorization", "Yes", "--backend", "https",
                      "--user-id", USER, "--conversation-id", CONV])
    assert code == 0, out
    assert json.loads(out)["outcome"] == "verified"
    assert json.loads(_puts(session)[0][3].decode()) == BULK


@pytest.mark.parametrize("body_text", ["[1, 2]", '"text"', "[]", "7",
                                       "{not json"])
def test_catalog_refuses_a_body_that_is_not_objects(session, body_text):
    with pytest.raises(ex.CallerInputError):
        _run(_catalog_argv(body_text))
    assert session.calls == []


def test_a_local_input_refusal_is_not_reported_as_provider_data(session):
    argv = _catalog_argv("[1, 2]")
    with pytest.raises(ex.CallerInputError) as info:
        _run(argv)
    payload = agent_error_payload(ex._funnel_operation(argv), info.value)
    assert payload["mode_id"] == "caller-input-refused"
    assert not payload["engineering_detail"].startswith(ENGINEERING_LABEL)
    assert "--body" in payload["engineering_detail"]
    message = payload["message"].lower()
    assert "nothing was sent" in message
    assert "provider" not in message
    assert "classified pattern" not in message
    assert "—" not in payload["message"]
    assert payload["escalate"] is False


@pytest.mark.parametrize("flag,value", [
    ("--params", "[1]"),
    ("--course-resolution", "[1]"),
])
def test_other_json_arguments_are_local_input_refusals(session, flag, value):
    argv = _catalog_argv(json.dumps(BULK))
    argv[argv.index(flag) + 1] = value
    with pytest.raises(ex.CallerInputError):
        _run(argv)
    assert session.calls == []
