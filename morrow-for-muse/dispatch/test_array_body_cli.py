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

Failure mode added in the final sweep (2026-09-23), written before the
fix: the CLI fix above was tested on the https lane only. On the
Chromium lane, the only v1 lane, transport/chromium_session.py
_decode_body refused any body that was not a JSON object, after the
approval burned and the write was marked attempted, so the refusal was
journaled as a write that may have applied, its claim stayed pending,
and the educator heard "I will not retry anything that might have
applied". C-37 could never be sent. The lane now sends a JSON array of
objects as JSON, and a body it cannot encode is refused as
WriteNotAttempted: nothing was sent and the claim is released.

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


# ------------------------------------------------ the Chromium lane --

class PageTab:
    """ChromiumSession's transport: records every page-context call."""

    def __init__(self):
        self.calls = []

    def api(self, method, path, data=None, as_json=False, timeout=60,
            max_bytes=None):
        self.calls.append((method, path, data, as_json))
        status, _headers, raw = _canvas()(method, path, None)
        bare = path.split("?")[0]
        if bare == "/api/v1/users/self":
            status, raw = 200, json.dumps({"id": 1, "name": "Teacher"})
        elif bare.endswith(("/users", "/enrollments")):
            status, raw = 200, "[]"
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        return status, {}, raw


@pytest.fixture
def page_tab(monkeypatch):
    from reauth import state_machine as rsm
    # The lane module exactly as the executor's CLI imports it.
    cs = ex._chromium_session_mod()
    monkeypatch.setattr(rsm, "pinned_principal",
                        lambda: {"id": 1, "name": "Teacher", "base": BASE})
    tab = PageTab()

    def load(cls, base_url=None):
        sess = cs.ChromiumSession(BASE, transport=tab)
        sess._check_expiry_warning = lambda: None
        return sess
    monkeypatch.setattr(cs.ChromiumSession, "load", classmethod(load))
    return tab


def _page_puts(tab):
    return [c for c in tab.calls if c[0] == "PUT"]


def test_catalog_sends_an_array_body_on_the_chromium_lane(page_tab):
    from settings import store
    store.set_setting(USER, "default_mode", "edit", educator_confirmed=True)
    argv = _catalog_argv(json.dumps(BULK))
    argv[argv.index("https")] = "chromium"
    code, out = _run(argv)
    assert code == 0, out
    assert json.loads(out)["outcome"] == "verified"
    assert _page_puts(page_tab) == [
        ("PUT", "/api/v1/courses/101/assignments/bulk_update", BULK, True)]
    assert ex.journal_pending_ops() == []


def test_plan_write_and_approve_send_an_array_body_on_the_chromium_lane(
        page_tab):
    code, out = _run(["plan-write", "--name", NAME, "--method", "PUT",
                      "--path", PATH,
                      "--params", json.dumps({"course_id": "101"}),
                      "--body", json.dumps(BULK), "--backend", "chromium",
                      "--user-id", USER, "--conversation-id", CONV])
    assert code == 0, out
    assert _page_puts(page_tab) == []
    code, out = _run(["approve-write", "--op-id", json.loads(out)["op_id"],
                      "--authorization", "Yes", "--backend", "chromium",
                      "--user-id", USER, "--conversation-id", CONV])
    assert code == 0, out
    assert json.loads(out)["outcome"] == "verified"
    assert [c[2] for c in _page_puts(page_tab)] == [BULK]


@pytest.mark.parametrize("body", [b"[1, 2]", b'"text"', b"7", b"{not json",
                                  b"[]"])
def test_a_body_the_chromium_lane_cannot_encode_is_not_sent(page_tab, body):
    sess = ex._chromium_session_mod().ChromiumSession.load()
    with pytest.raises(ex.WriteNotAttempted) as info:
        sess.raw_request("PUT", BASE + "/api/v1/courses/101/assignments/5",
                         {"Content-Type": "application/json"}, body,
                         is_write=True)
    assert "nothing was sent" in str(info.value)
    assert _page_puts(page_tab) == []


def test_a_refused_body_releases_the_claim(page_tab, monkeypatch):
    # The executor never builds such a body from the CLI; a caller that
    # hands one to the lane must still get "nothing was sent".
    from settings import store
    cs = ex._chromium_session_mod()
    store.set_setting(USER, "default_mode", "edit", educator_confirmed=True)
    monkeypatch.setattr(ex, "prevalidate_write_request",
                        lambda *a, **k: None)
    with pytest.raises(ex.WriteNotAttempted):
        ex.dispatch_catalog_op(
            NAME, "PUT", PATH, None, {"course_id": "101"}, pack=_pack(),
            session=cs.ChromiumSession.load(), extra={"body": [1, 2]},
            mode_ctx={"user_id": USER, "conversation_id": CONV,
                      "course_resolution": json.loads(RESOLUTION)})
    assert _page_puts(page_tab) == []
    assert ex.journal_pending_ops() == []
