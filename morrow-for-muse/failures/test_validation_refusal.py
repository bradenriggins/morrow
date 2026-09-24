#!/usr/bin/env python3
"""A Canvas validation refusal says what Canvas said, and nothing changed.

Failure modes this suite pins down (written before the fix; final sweep
2026-09-22, probe ux1/tests/test_422_message.py):
  1. Canvas refused an approved write with HTTP 422 and an errors body
     ({"errors": {"title": [{"message": "is too long"}]}}). No catalog
     mode matched (canvas-422-unprocessable needs the CSRF marker, and
     the funnel never set provider=canvas), so the educator got the
     "unknown" message: six "(unknown)" fields, "might have applied",
     and "engineering review", with Canvas's reason dropped. The honest
     outcome is: Canvas did not accept it, nothing changed, here is why.
  2. The "unknown" fallback printed "(unknown)" for every field it could
     not fill, and next_step doubled its periods ("re-dispatch..").
  3. Canvas's words are provider data: long numbers (user ids) and
     email addresses in them never reach the agent.

Hermetic: fake provider session; journal, approvals, and the signing
key live in pytest's tmp_path.
"""

import json

from dispatch import executor as ex
from failures import translator
from failures.catalog import load_catalog
from failures.funnel import agent_error_payload
from dispatch.test_round4_write_ceremony import (  # noqa: F401
    CONV, USER, FakeSession, _canvas, _cli, _fake_store, _plan_write_argv,
    _writes, hermetic, hermetic_keys)

TOO_LONG = (b'{"errors":{"title":[{"attribute":"title","type":"too_long",'
            b'"message":"is too long"}]}}')


def _refused_write(monkeypatch, body_bytes, status=422):
    canvas = _canvas()

    def handler(method, url, body):
        if method == "PUT":
            return status, {}, body_bytes
        return canvas(method, url, body)
    session = FakeSession(handler)
    _fake_store(monkeypatch, session)
    code, out = _cli(_plan_write_argv({"wiki_page": {"title": "x" * 300}}))
    assert code == 0, out
    argv = ["approve-write", "--op-id", json.loads(out)["op_id"],
            "--authorization", "Yes", "--backend", "https",
            "--user-id", USER, "--conversation-id", CONV]
    try:
        ex.main(argv)
    except Exception as exc:  # noqa: BLE001 - the CLI funnel's input
        return agent_error_payload(ex._funnel_operation(argv), exc), session
    raise AssertionError("the refused write raised nothing")


def test_a_canvas_validation_refusal_is_plain_and_honest(monkeypatch):
    payload, session = _refused_write(monkeypatch, TOO_LONG)
    assert payload["mode_id"] == "canvas-write-refused-invalid"
    message = payload["message"]
    assert "title: is too long" in message
    assert "nothing changed" in message.lower()
    assert "(unknown)" not in message
    assert "might have applied" not in message
    assert ".." not in message and ".." not in payload["next_step"]
    assert payload["escalate"] is False
    assert len(_writes(session)) == 1


def test_a_400_with_a_message_is_the_same_refusal(monkeypatch):
    payload, _ = _refused_write(
        monkeypatch, b'{"errors":[{"message":"points must be a number"}]}',
        status=400)
    assert payload["mode_id"] == "canvas-write-refused-invalid"
    assert "points must be a number" in payload["message"]


def test_canvas_words_are_data_without_ids_or_emails(monkeypatch):
    payload, _ = _refused_write(monkeypatch, json.dumps({"errors": {
        "student_ids": [{"message": "user 8675309 (jane.doe@school.edu) "
                                    "is not enrolled"}]}}).encode())
    message = payload["message"]
    assert "8675309" not in message and "jane.doe" not in message
    assert "student ids:" in message


def test_the_csrf_422_keeps_its_own_mode():
    tr = translator.translate("write op", {
        "http_status": 422,
        "body_text": '{"status":"unprocessable_content"}'})
    assert tr.mode_id == "canvas-422-unprocessable"


def test_the_unknown_fallback_prints_only_what_it_knows():
    tr = translator.translate("executor catalog x", RuntimeError("boom"))
    assert tr.mode_id == "unknown"
    assert "(unknown" not in tr.agent_message, tr.agent_message
    assert ".." not in tr.agent_message
    tr = translator.translate("executor catalog x", {
        "error": "RuntimeError", "detail": "boom", "http_status": 418,
        "request_id": "req-1"})
    assert "418" in tr.agent_message and "req-1" in tr.agent_message
    assert "(unknown" not in tr.agent_message, tr.agent_message


def test_no_next_step_doubles_its_periods():
    for entry in load_catalog().entries:
        assert ".." not in translator.next_step_text(entry), entry["id"]
