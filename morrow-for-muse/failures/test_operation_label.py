#!/usr/bin/env python3
"""A failure message names the change in plain words, not the command line.

Failure modes this suite pins down (written before the fix; final sweep
2026-09-22, probes ux1/tests/test_halt_message.py and
test_422_message.py):
  1. The {operation} in every failure message the educator reads came
     from the executor's command line: "I held back executor
     approve-write op a6b9aaaf-808b-..." and "I tried catalog
     canvas_update_create_page_courses". The educator saw an op id and
     an internal operation name instead of the change.
  2. The write-gate messages said "I tried to {operation}", so even a
     plain label read "I tried to catalog ...".
The label is now what the request does and where: 'changing a page in
the course "Bio 101"'. It is one kind of phrase ("changing ...",
"reading ...") in every message. A prepared write that cannot be found
is "the change you approved". Op ids, command names, flags, and file
paths never reach the message.

Hermetic: fake provider session; journal, approvals, the halt, and the
signing key live in pytest's tmp_path.
"""

import json
import re
import uuid

import pytest

from dispatch import executor as ex
from failures.catalog import load_catalog
# Imported here, under the session's scratch home: a first import inside
# a test would bind the module's paths to that test's tmp_path.
from reauth import state_machine
from dispatch.test_round4_write_ceremony import (  # noqa: F401
    CONV, METHOD, NAME, PARAMS, PATH, USER, FakeSession, _canvas, _cli,
    _fake_store, _plan_write_argv, hermetic, hermetic_keys)

UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-"
                     r"[0-9a-f]{12}")
INTERNALS = ("executor", "approve-write", "plan-write", "catalog ", NAME,
             "--", ".json", "op_id")


def _message_of(argv):
    try:
        ex.main(argv)
    except Exception as exc:  # noqa: BLE001 - the CLI funnel's input
        return ex._agent_error(argv, exc)["message"]
    raise AssertionError("the command raised nothing: %s" % argv)


def _assert_plain(message):
    assert not UUID_RE.search(message), message
    for token in INTERNALS:
        assert token not in message, (token, message)


def _approve_argv(op_id):
    return ["approve-write", "--op-id", op_id, "--authorization", "Yes",
            "--backend", "https", "--user-id", USER,
            "--conversation-id", CONV]


def _prepared(monkeypatch, handler=None):
    _fake_store(monkeypatch, FakeSession(handler or _canvas()))
    code, out = _cli(_plan_write_argv({"wiki_page": {"title": "Week 2"}}))
    assert code == 0, out
    return json.loads(out)["op_id"]


@pytest.fixture
def rsm(monkeypatch, hermetic):
    for name, file_name in (("HALT_PATH", "write_halt"),
                            ("QUAR_PATH", "quarantine.jsonl"),
                            ("NOTIFY_PATH", "notify.txt"),
                            ("STATE_PATH", "reauth_state.json")):
        monkeypatch.setattr(state_machine, name, str(hermetic / file_name))
    yield state_machine
    (hermetic / "write_halt").unlink(missing_ok=True)


def test_a_paused_approved_write_names_the_change_and_the_course(
        monkeypatch, hermetic, rsm):
    op_id = _prepared(monkeypatch)
    (hermetic / "write_halt").write_text(json.dumps(
        {"halted_at": "2026-09-22T00:00:00Z", "reason": "operator pause"}))
    message = _message_of(_approve_argv(op_id))
    assert 'changing a page in the course "Bio 101"' in message, message
    assert op_id not in message
    _assert_plain(message)


def test_a_refused_approved_write_names_the_change_after_it_was_sent(
        monkeypatch):
    canvas = _canvas()

    def handler(method, url, body):
        if method == "PUT":
            return 422, {}, (b'{"errors":{"title":[{"message":'
                             b'"is too long"}]}}')
        return canvas(method, url, body)
    op_id = _prepared(monkeypatch, handler)
    message = _message_of(_approve_argv(op_id))
    assert 'changing a page in the course "Bio 101"' in message, message
    _assert_plain(message)


def test_an_edit_mode_style_write_names_the_change_and_course_id(
        monkeypatch):
    _fake_store(monkeypatch, FakeSession(_canvas()))
    message = _message_of([
        "catalog", "--name", NAME, "--method", METHOD, "--path", PATH,
        "--params", json.dumps(PARAMS),
        "--body", json.dumps({"wiki_page": {"title": "X"}}),
        "--backend", "https", "--user-id", USER, "--conversation-id", CONV])
    assert "I tried changing a page in course 101" in message, message
    _assert_plain(message)


def test_a_prepared_write_that_is_gone_is_the_change_you_approved(
        monkeypatch):
    _fake_store(monkeypatch, FakeSession(_canvas()))
    op_id = str(uuid.uuid4())
    message = _message_of(_approve_argv(op_id))
    assert "the change you approved" in message, message
    _assert_plain(message)


@pytest.mark.parametrize("method,path,params,label", [
    ("GET", "/api/v1/courses/{course_id}/assignments", {"course_id": 101},
     "reading the assignments in course 101"),
    ("GET", "/api/v1/courses/{course_id}/assignments/{id}",
     {"course_id": "101", "id": "7"}, "reading an assignment in course 101"),
    ("GET", "/api/v1/users/self", {}, "reading your own Canvas profile"),
    ("POST", "/api/v1/courses/{course_id}/assignments", {"course_id": 5},
     "creating an assignment in course 5"),
    ("DELETE", "/api/v1/courses/{course_id}/modules/{module_id}/items/{id}",
     {"course_id": 5, "module_id": 2, "id": 9},
     "deleting a module item in course 5"),
    ("PUT", "/api/v1/courses/{course_id}/settings", {"course_id": 5},
     "changing the settings in course 5"),
    ("POST", "/api/v1/courses/{course_id}/quizzes/{id}/reorder",
     {"course_id": 5, "id": 3}, "changing a quiz in course 5"),
    ("PUT", "/api/v1/courses/{course_id}/pages/{url_or_id}",
     {"course_id": "not a number", "url_or_id": "x"}, "changing a page"),
])
def test_labels_say_what_the_request_does(method, path, params, label):
    argv = ["catalog", "--name", "internal_name_here", "--method", method,
            "--path", path, "--params", json.dumps(params)]
    assert ex._funnel_operation(argv) == label


@pytest.mark.parametrize("argv", [
    ["execute", "--entry", "catalog/a11y/morrow_plan_page_image_alt_repair"
     ".json", "--params", "{}"],
    ["undo", "--entry", "x.json", "--of-op-id", str(uuid.uuid4())],
    ["journal-seal", "--yes"],
    ["claim-release", "--op-id", str(uuid.uuid4()), "--reason", "x"],
    [],
])
def test_no_command_line_token_becomes_the_label(argv):
    label = ex._funnel_operation(argv)
    assert label and label[0].islower(), label
    _assert_plain(label)
    assert "manifest" not in label and "journal" not in label, label


def test_every_message_takes_the_same_kind_of_phrase():
    # The label is a phrase like "changing a page" in every message, so
    # no message may read "to {operation}" or "run {operation}".
    for entry in load_catalog().entries:
        text = entry.get("agent_message", "")
        for bad in ("to {operation}", "run {operation}",
                    "held back {operation}", "prepared {operation}"):
            assert bad not in text, (entry["id"], bad)
