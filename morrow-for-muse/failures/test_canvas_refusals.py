#!/usr/bin/env python3
"""Canvas's everyday refusals say what Canvas said, and that nothing
changed.

Failure modes this suite pins down (written before the fix; final sweep
2026-09-23):
  1. The most common Canvas refusals had no failure mode: 401 "user not
     authorized to perform that action" (a live session whose role
     cannot do this), 403, and 404 (a renamed page, a deleted item).
     The educator got the "unknown" message instead: it said the change
     might have applied, promised an engineering follow-up that never
     comes, asked to escalate, and dropped Canvas's reason. The executor
     itself classifies these fail-fast 4xx refusals as provably nothing
     applied.
  2. No fail-fast 4xx refusal may reach the "unknown" fallback or its
     "might have applied" wording.
  3. A 401 "unauthenticated" is an expired sign-in, not a permission
     refusal: it must never tell the educator their role is the cause.

Hermetic: fake provider session; journal, approvals, and the signing
key live in pytest's tmp_path.
"""

import http
import json

import pytest

from dispatch import executor as ex
from failures import translator
from failures.funnel import agent_error_payload
from dispatch.test_round4_write_ceremony import (  # noqa: F401
    CONV, USER, FakeSession, _canvas, _cli, _fake_store, _plan_write_argv,
    _writes, hermetic, hermetic_keys)

UNAUTHORIZED = (b'{"status":"unauthorized","errors":[{"message":'
                b'"user not authorized to perform that action"}]}')
UNAUTHENTICATED = (b'{"status":"unauthenticated","errors":[{"message":'
                   b'"user authorization required"}]}')
NOT_FOUND = (b'{"errors":[{"message":'
             b'"The specified resource does not exist."}]}')


def _refused_write(monkeypatch, status, body_bytes):
    canvas = _canvas()

    def handler(method, url, body):
        if method == "PUT":
            return status, {}, body_bytes
        return canvas(method, url, body)
    session = FakeSession(handler)
    _fake_store(monkeypatch, session)
    code, out = _cli(_plan_write_argv({"wiki_page": {"title": "Week 1"}}))
    assert code == 0, out
    argv = ["approve-write", "--op-id", json.loads(out)["op_id"],
            "--authorization", "Yes", "--backend", "https",
            "--user-id", USER, "--conversation-id", CONV]
    try:
        ex.main(argv)
    except Exception as exc:  # noqa: BLE001 - the CLI funnel's input
        return agent_error_payload(ex._funnel_operation(argv), exc), session
    raise AssertionError("the refused write raised nothing")


def _refused_read(monkeypatch, status, body_bytes):
    session = FakeSession(lambda m, u, b: (status, {}, body_bytes))
    _fake_store(monkeypatch, session)
    argv = ["catalog", "--name", "canvas_get_course_settings",
            "--method", "GET",
            "--path", "/api/v1/courses/{course_id}/settings",
            "--class", "read", "--backend", "https",
            "--params", '{"course_id": 101}']
    try:
        ex.main(argv)
    except Exception as exc:  # noqa: BLE001 - the CLI funnel's input
        return agent_error_payload(ex._funnel_operation(argv), exc)
    raise AssertionError("the refused read raised nothing")


def _plain_and_honest(payload, canvas_words):
    message = payload["message"]
    assert canvas_words in message, message
    assert "nothing changed" in message.lower(), message
    assert "might have applied" not in message
    assert "engineering" not in message.lower()
    assert "(unknown" not in message and "(no reason" not in message
    assert "\u2014" not in message
    assert payload["escalate"] is False


def test_a_role_that_cannot_change_this_is_told_so(monkeypatch):
    payload, session = _refused_write(monkeypatch, 401, UNAUTHORIZED)
    assert payload["mode_id"] == "canvas-not-permitted"
    _plain_and_honest(payload, "user not authorized to perform that action")
    assert "permission" in payload["message"]
    assert len(_writes(session)) == 1


def test_a_403_read_is_the_same_refusal(monkeypatch):
    payload = _refused_read(monkeypatch, 403, b'{"errors":[{"message":'
                            b'"This action is not allowed."}]}')
    assert payload["mode_id"] == "canvas-not-permitted"
    _plain_and_honest(payload, "This action is not allowed.")


def test_a_missing_item_is_told_so(monkeypatch):
    payload, session = _refused_write(monkeypatch, 404, NOT_FOUND)
    assert payload["mode_id"] == "canvas-not-found"
    _plain_and_honest(payload, "The specified resource does not exist.")
    assert len(_writes(session)) == 1


def test_a_missing_item_on_a_read_is_told_so(monkeypatch):
    payload = _refused_read(monkeypatch, 404, NOT_FOUND)
    assert payload["mode_id"] == "canvas-not-found"
    _plain_and_honest(payload, "The specified resource does not exist.")


def test_another_refusal_says_canvas_refused_it(monkeypatch):
    payload, _ = _refused_write(monkeypatch, 409, b'{"errors":[{"message":'
                                b'"the page is being edited"}]}')
    assert payload["mode_id"] == "canvas-refused-request"
    _plain_and_honest(payload, "the page is being edited")
    assert "409" in payload["message"]


def _fail_fast(status, body, kind):
    exc = ex.ProviderHttpError(status, "fail fast on 4xx", body=body)
    # What the executor sets on a refusal it classified as fail-fast.
    exc.provider = "canvas"
    exc.operation_kind = kind
    return exc


@pytest.mark.parametrize("kind", ["read", "write"])
@pytest.mark.parametrize("status", [s.value for s in http.HTTPStatus
                                    if 400 <= s.value < 500])
def test_no_fail_fast_refusal_reaches_the_unknown_fallback(status, kind):
    tr = translator.translate("changing a page", _fail_fast(
        status, '{"errors":[{"message":"no"}]}', kind))
    assert tr.mode_id != "unknown", (status, kind)
    assert "might have applied" not in tr.agent_message, (status, kind)


def test_an_expired_sign_in_is_never_called_a_permission_problem():
    tr = translator.translate("changing a page", _fail_fast(
        401, UNAUTHENTICATED.decode(), "write"))
    assert tr.mode_id != "canvas-not-permitted"


def test_the_csrf_422_and_the_validation_refusal_keep_their_modes():
    csrf = translator.translate("changing a page", _fail_fast(
        422, '{"errors":[{"message":"An error occurred.",'
             '"error_code":"unprocessable_content"}]}', "write"))
    assert csrf.mode_id == "canvas-422-unprocessable"
    invalid = translator.translate("changing a page", _fail_fast(
        422, '{"errors":{"title":[{"message":"is too long"}]}}', "write"))
    assert invalid.mode_id == "canvas-write-refused-invalid"


def test_a_refusal_without_the_executors_classification_is_not_guessed():
    # Without operation_kind, nothing proves the change did not apply.
    tr = translator.translate("changing a page", {
        "provider": "canvas", "http_status": 404, "body_text": "{}"})
    assert tr.mode_id not in ("canvas-not-found", "canvas-refused-request",
                              "canvas-not-permitted")


def test_the_unknown_fallback_promises_only_what_happens():
    # It promised an engineering review and "a concrete next step once
    # the cause is identified"; nothing sends the failure anywhere.
    tr = translator.translate("changing a page", RuntimeError("boom"))
    assert tr.mode_id == "unknown"
    lowered = tr.agent_message.lower()
    assert "engineering" not in lowered
    assert "once the cause is identified" not in lowered
    assert "hello@meetmorrow.app" in tr.agent_message
    payload = agent_error_payload("changing a page", RuntimeError("boom"))
    assert "engineering" not in payload["next_step"].lower()
