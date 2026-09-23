#!/usr/bin/env python3
"""A refusal made before anything is sent says that nothing was sent.

Failure modes this suite pins down (written before the fix; final sweep
2026-09-23, items plan-approve-input-errors-read-as-maybe-applied and
wrong-name-called-untested):
  1. plan-write with a task name that is not a catalog row (for example
     canvas_update_page for the live-proven page PUT, whose row is
     canvas_update_create_page_courses) raised a bare ExecutorError. The
     educator heard the unknown message: "the task might have made a
     change", and to email support. plan-write never sends a change.
  2. The same bare ExecutorError for a catalog read with an unknown name
     and no --class.
  3. A catalog read with an unknown name and --class read, for a method
     and path that are a live-proven row (get_settings for C-111
     canvas_get_course_settings), was refused as catalog-not-proven: the
     educator heard that Morrow has not tested the task, and the agent
     offered a substitute instead of retrying with the right name. The
     refusal must name the row. A name and a request that belong to two
     different rows are refused the same way, and a request no tested
     row makes stays catalog-not-proven.
  4. approve-write --op-id with the angle brackets from SKILL.md's
     placeholder kept (a malformed op id) raised ValueError from the
     UUID parser: the unknown message again, although nothing was
     looked up or sent. The same parser guards catalog --op-id, execute
     --op-id, undo --of-op-id, and claim-release --op-id.
  5. plan-write for a read row raised a bare ExecutorError: the unknown
     message for a refusal made before anything was read or sent.
  6. Any other failure raised before the executor claims a write (for
     plan-write, every failure) fell to the unknown message, which says
     the task might have made a change. Only a failure after a write
     claim can say that.

Hermetic: fake provider session; journal, approvals, the write halt, and
the signing key live in pytest's tmp_path.
"""

import json
import uuid

import pytest

from dispatch import executor as ex
from failures.funnel import agent_error_payload
from dispatch.test_round4_write_ceremony import (  # noqa: F401
    APPROVED_BODY, CONV, METHOD, PARAMS, PATH, USER, FakeSession, _canvas,
    _cli, _fake_store, _plan_write_argv, _writes, hermetic, hermetic_keys)

SETTINGS_PATH = "/api/v1/courses/{course_id}/settings"
MAYBE_APPLIED = "might have made a change"


def _refused(argv):
    """The CLI funnel's payload for a command that raised."""
    try:
        ex.main(argv)
    except Exception as exc:  # noqa: BLE001 - the CLI funnel's input
        return agent_error_payload(ex._funnel_operation(argv, exc), exc), exc
    raise AssertionError("the command raised nothing: %r" % (argv,))


def _nothing_sent(payload):
    message = payload["message"]
    assert payload["mode_id"] != "unknown", payload
    assert MAYBE_APPLIED not in message
    assert "nothing" in message.lower()
    assert "—" not in message
    assert "(unknown" not in message
    return message


def _store(monkeypatch, handler=None):
    session = FakeSession(handler or _settings_canvas())
    _fake_store(monkeypatch, session)
    return session


def _settings_canvas():
    canvas = _canvas()

    def handler(method, url, body):
        if method == "GET" and url.rstrip("/").endswith(
                "/courses/101/settings"):
            return 200, {}, json.dumps({"allow_student_forum_attachments":
                                        False}).encode()
        return canvas(method, url, body)
    return handler


def _catalog_argv(name, method, path, *extra):
    return ["catalog", "--name", name, "--method", method, "--path", path,
            "--params", json.dumps({"course_id": "101"}),
            "--backend", "https"] + list(extra)


def _approve_argv(op_id):
    return ["approve-write", "--op-id", op_id, "--authorization", "Yes",
            "--backend", "https", "--user-id", USER,
            "--conversation-id", CONV]


# ------------------------------------------------ 1-3: the task name --

def test_plan_write_with_a_wrong_name_names_the_tested_task(monkeypatch):
    session = _store(monkeypatch)
    argv = _plan_write_argv(APPROVED_BODY)
    argv[argv.index("--name") + 1] = "canvas_update_page"
    payload, exc = _refused(argv)
    assert isinstance(exc, ex.CatalogNotProven)
    assert payload["mode_id"] == "catalog-name-mismatch"
    message = _nothing_sent(payload)
    assert "not one of them" not in message
    assert "catalog_name=canvas_update_create_page_courses" \
        in payload["evidence"]
    # The row to use is Morrow's own check, never labeled as text from
    # Canvas.
    assert payload["engineering_detail"].startswith("[Morrow input check]")
    assert "canvas_update_create_page_courses" in \
        payload["engineering_detail"]
    assert session.calls == []
    # The agent runs it again with the name the refusal gave.
    code, out = _cli(_plan_write_argv(APPROVED_BODY))
    assert code == 0, out
    assert json.loads(out)["status"] == "awaiting_approval"
    assert _writes(session) == []


@pytest.mark.parametrize("extra", [["--class", "read"], []])
def test_a_read_with_a_wrong_name_names_the_tested_task(monkeypatch,
                                                        extra):
    session = _store(monkeypatch)
    payload, exc = _refused(_catalog_argv("get_settings", "GET",
                                          SETTINGS_PATH, *extra))
    assert isinstance(exc, ex.CatalogNotProven)
    assert payload["mode_id"] == "catalog-name-mismatch"
    message = _nothing_sent(payload)
    assert "not one of them" not in message
    assert "catalog_name=canvas_get_course_settings" in payload["evidence"]
    assert session.calls == []
    code, out = _cli(_catalog_argv("canvas_get_course_settings", "GET",
                                   SETTINGS_PATH))
    assert code == 0, out
    assert [c[0] for c in session.calls] == ["GET"] * len(session.calls)


def test_a_name_paired_with_another_tested_request_names_that_task(
        monkeypatch):
    session = _store(monkeypatch)
    payload, exc = _refused(_catalog_argv(
        "canvas_get_course_settings", "GET",
        "/api/v1/courses/{course_id}/tabs"))
    assert payload["mode_id"] == "catalog-name-mismatch"
    _nothing_sent(payload)
    assert ("catalog_name=canvas_list_available_tabs_for_course_or_group"
            "_courses") in payload["evidence"]
    # The operator detail still says why a proven name is refused.
    assert "arbitrary CLI arguments" in str(exc)
    assert session.calls == []


def test_a_tested_name_with_an_untested_path_names_its_own_request(
        monkeypatch):
    session = _store(monkeypatch)
    payload, _exc = _refused(_catalog_argv(
        "canvas_get_course_settings", "GET",
        "/api/v1/courses/{course_id}/nope"))
    assert payload["mode_id"] == "catalog-name-mismatch"
    _nothing_sent(payload)
    assert "catalog_name=canvas_get_course_settings" in payload["evidence"]
    assert "catalog_path=%s" % SETTINGS_PATH in payload["evidence"]
    assert session.calls == []


@pytest.mark.parametrize("name", ["get_nope", "canvas_no_such_operation"])
def test_a_request_no_tested_task_makes_stays_not_proven(monkeypatch,
                                                          name):
    session = _store(monkeypatch)
    payload, exc = _refused(_catalog_argv(
        name, "GET", "/api/v1/courses/{course_id}/nope", "--class", "read"))
    assert type(exc) is ex.CatalogNotProven
    assert payload["mode_id"] == "catalog-not-proven"
    assert session.calls == []


def test_an_untested_row_under_its_own_name_stays_not_proven(monkeypatch):
    desc = ex.catalog_descriptor_for(
        "canvas_list_assignments_assignment_groups")
    assert desc["status"] != "live-proven"
    session = _store(monkeypatch)
    payload, exc = _refused(["catalog", "--name",
                             "canvas_list_assignments_assignment_groups",
                             "--method", desc["method"], "--path",
                             desc["path"], "--params", json.dumps(
                                 {"course_id": "101",
                                  "assignment_group_id": "7"}),
                             "--backend", "https"])
    assert type(exc) is ex.CatalogNotProven
    assert payload["mode_id"] == "catalog-not-proven"
    assert session.calls == []


# ------------------------------------------------------ 4: op ids --

@pytest.mark.parametrize("wrapped", ["<%s>", "'%s'", "op id %s", "%s,"])
def test_approve_write_with_a_malformed_op_id_sends_nothing(monkeypatch,
                                                            wrapped):
    session = _store(monkeypatch, _canvas())
    code, out = _cli(_plan_write_argv(APPROVED_BODY))
    assert code == 0, out
    op_id = json.loads(out)["op_id"]
    payload, exc = _refused(_approve_argv(wrapped % op_id))
    assert isinstance(exc, ex.CallerInputError)
    assert payload["mode_id"] == "caller-input-refused"
    _nothing_sent(payload)
    assert "--op-id" in payload["engineering_detail"]
    assert _writes(session) == []
    # Nothing was used up: the educator's reply goes with the right id.
    code, out = _cli(_approve_argv(op_id))
    assert code == 0, out
    assert json.loads(out)["outcome"] == "verified"
    assert len(_writes(session)) == 1


@pytest.mark.parametrize("argv", [
    _catalog_argv("canvas_get_course_settings", "GET", SETTINGS_PATH,
                  "--op-id", "<not-an-id>"),
    ["undo", "--entry", "pack/entries/none.json", "--of-op-id",
     "<not-an-id>", "--backend", "https"],
    ["claim-release", "--op-id", "<not-an-id>", "--reason",
     "reconciled the op against Canvas by hand", "--yes"],
])
def test_every_op_id_argument_is_checked_before_use(monkeypatch, argv):
    session = _store(monkeypatch)
    payload, exc = _refused(argv)
    assert isinstance(exc, ex.CallerInputError), exc
    assert payload["mode_id"] == "caller-input-refused"
    _nothing_sent(payload)
    assert session.calls == []


# ------------------------------------------- 5: the wrong command --

def test_plan_write_for_a_read_says_nothing_was_sent(monkeypatch):
    session = _store(monkeypatch)
    payload, exc = _refused([
        "plan-write", "--name", "canvas_get_course_settings",
        "--method", "GET", "--path", SETTINGS_PATH,
        "--params", json.dumps({"course_id": "101"}), "--backend", "https",
        "--user-id", USER, "--conversation-id", CONV])
    assert isinstance(exc, ex.CallerInputError)
    assert payload["mode_id"] == "caller-input-refused"
    _nothing_sent(payload)
    assert "catalog command" in payload["engineering_detail"]
    assert session.calls == []


# ------------------------------ 6: a failure nothing names, by stage --

def test_an_unrecognized_plan_write_failure_says_nothing_was_sent(
        monkeypatch):
    session = _store(monkeypatch, _canvas())

    def boom(*args, **kwargs):
        raise RuntimeError("the course read broke in a new way")
    monkeypatch.setattr(ex, "_read_course_identity", boom)
    payload, _exc = _refused(_plan_write_argv(APPROVED_BODY))
    assert payload["mode_id"] == "unknown-nothing-sent"
    message = _nothing_sent(payload)
    assert "hello@meetmorrow.app" in message
    assert "did not send any change" in message
    assert _writes(session) == []


def test_an_unrecognized_failure_before_the_write_claim_sent_nothing(
        monkeypatch):
    session = _store(monkeypatch, _canvas())
    code, out = _cli(_plan_write_argv(APPROVED_BODY))
    assert code == 0, out
    op_id = json.loads(out)["op_id"]

    def boom(*args, **kwargs):
        raise RuntimeError("the named-object check broke in a new way")
    monkeypatch.setattr(ex, "_recheck_named_object", boom)
    payload, _exc = _refused(_approve_argv(op_id))
    assert payload["mode_id"] == "unknown-nothing-sent"
    _nothing_sent(payload)
    assert _writes(session) == []


def test_an_unrecognized_failure_after_the_write_claim_may_have_applied(
        monkeypatch):
    session = _store(monkeypatch, _canvas())
    code, out = _cli(_plan_write_argv(APPROVED_BODY))
    assert code == 0, out
    op_id = json.loads(out)["op_id"]
    real_claim = ex.claim_op_id

    def claim_then_fail(op_id, kind, entry_name, effects, params_digest):
        token = real_claim(op_id, kind, entry_name, effects, params_digest)
        if effects == "write":
            raise RuntimeError("broke right after the write claim")
        return token
    monkeypatch.setattr(ex, "claim_op_id", claim_then_fail)
    payload, _exc = _refused(_approve_argv(op_id))
    assert payload["mode_id"] == "unknown"
    assert MAYBE_APPLIED in payload["message"]


def test_the_cli_process_reports_nothing_sent_the_same_way(tmp_path):
    """End to end through `python3 dispatch/executor.py`: the funnel the
    agent reads, with a scratch MORROW_HOME."""
    import os
    import subprocess
    import sys
    tree = os.path.dirname(os.path.dirname(os.path.abspath(ex.__file__)))
    env = dict(os.environ, HOME=str(tmp_path), MORROW_HOME=str(
        tmp_path / ".morrow"), PYTHONDONTWRITEBYTECODE="1")
    env.pop("MORROW_TREE_STATE_DIR", None)
    op_id = str(uuid.uuid4())
    proc = subprocess.run(
        [sys.executable, os.path.join(tree, "dispatch", "executor.py"),
         "approve-write", "--op-id", "<%s>" % op_id, "--authorization",
         "Yes", "--backend", "https"],
        cwd=str(tmp_path), env=env, capture_output=True, text=True,
        timeout=120)
    assert proc.returncode == 2, proc.stderr
    payload = json.loads(proc.stderr.strip().splitlines()[-1])
    assert payload["mode_id"] == "caller-input-refused", payload
    assert MAYBE_APPLIED not in payload["message"]
