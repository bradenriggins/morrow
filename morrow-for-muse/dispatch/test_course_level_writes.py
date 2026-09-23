#!/usr/bin/env python3
"""Course-level writes get every course check, whatever the path slot.

Failure mode this suite pins down (written before the fix; final sweep
2026-09-22, probe final-sweep/muse-engine/test_p12_course_id.py):
  The write's course came only from params.course_id or from literal
  digits in the unrendered URL template. A course-level route whose
  slot is {id} (C-128 PUT /api/v1/courses/{id}, C-230 PATCH
  /api/v1/courses/{id}/late_policy) counted as "not course-scoped":
    - edit mode skipped the course-resolution guard and the provider
      course identity GET, and ran no readback (always "unverified");
    - plan-write returned course: null, and the approval display named
      only the Canvas site, so the educator approved a course-wide
      change without seeing the course name.
  The course is the /courses/<id> segment of the rendered request
  path, for every check (resolution guard, identity GET, approval
  target, mode journal), and a course update is read back with GET
  /api/v1/courses/{id}.

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
from dispatch.admission import mint_approval  # noqa: E402
from dispatch.test_direct_lane_hardening import (  # noqa: E402,F401
    BASE, FakeSession, _pack, hermetic)

UPDATE = ("canvas_update_course", "PUT", "/api/v1/courses/{id}")
LATE = ("canvas_patch_late_policy", "PATCH",
        "/api/v1/courses/{id}/late_policy")
RENAME = {"course": {"name": "Bio 101 (Fall)"}}
LATE_BODY = {"late_policy": {"late_submission_deduction": 10}}
USER = "muse:course-level@school.edu"
CONV = "conv-course-level"


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
    """Fake Canvas: course 101 is Bio 101; a course PUT renames it and
    the course GET reads back the stored name."""
    state = {"name": "Bio 101"}

    def handler(method, url, body):
        path = url.split("?")[0].rstrip("/")
        if path.endswith("/api/v1/courses/101"):
            if method == "PUT":
                state["name"] = json.loads(body.decode())["course"]["name"]
            return 200, {}, json.dumps(
                {"id": 101, "name": state["name"]}).encode()
        if path.endswith("/api/v1/courses/101/late_policy") \
                and method == "PATCH":
            return 204, {}, b""
        return 404, {}, b"{}"
    return handler


def _ctx(course_id="101", **kw):
    ctx = {"user_id": USER, "conversation_id": CONV}
    if course_id is not None:
        ctx["course_resolution"] = {"course_id": course_id,
                                    "confidence": 1.0,
                                    "user_confirmed": True}
    ctx.update(kw)
    return ctx


def _edit_mode():
    from settings import store
    store.set_setting(USER, "default_mode", "edit", educator_confirmed=True)


def _paths(session):
    return [(c[0], c[1].replace(BASE, "").split("?")[0])
            for c in session.calls]


def _journaled_target(op_id):
    with open(ex.JOURNAL_PATH, encoding="utf-8") as fh:
        for line in fh:
            rec = json.loads(line)
            if rec.get("op_id") == op_id and rec.get("wal") == "complete":
                return rec.get("target")
    return None


def _dispatch(op, body, session, ctx):
    name, method, path = op
    return ex.dispatch_catalog_op(name, method, path, None, {"id": "101"},
                                  extra={"body": body}, session=session,
                                  pack=_pack(), mode_ctx=ctx)


# ------------------------------------------------ the course of a write --

@pytest.mark.parametrize("op", [UPDATE, LATE])
def test_course_level_route_names_its_course(op):
    name, method, path = op
    entry = ex.catalog_descriptor_to_entry(name, method, path)
    assert ex._write_target_course_id(entry, {"id": "101"}) == "101"
    assert admission_mod.write_target_course_id(entry, {"id": "101"}) \
        == "101"


def test_course_id_routes_are_unchanged():
    entry = ex.catalog_descriptor_to_entry(
        "canvas_update_create_page_courses", "PUT",
        "/api/v1/courses/{course_id}/pages/{url_or_id}")
    assert ex._write_target_course_id(
        entry, {"course_id": "101", "url_or_id": "week-1"}) == "101"


def test_the_path_not_a_stray_param_names_the_course():
    """The write hits the course in its path; a course_id param the
    request never uses cannot point the checks at another course."""
    entry = ex.catalog_descriptor_to_entry(*UPDATE)
    assert ex._write_target_course_id(
        entry, {"id": "202", "course_id": "101"}) == "202"


def test_a_user_level_favorites_route_is_not_a_course_write():
    entry = ex.catalog_descriptor_to_entry(
        "canvas_add_course_to_favorites", "POST",
        "/api/v1/users/self/favorites/courses/{id}")
    assert ex._write_target_course_id(entry, {"id": "101"}) is None


# ---------------------------------------------------------- edit mode --

@pytest.mark.parametrize("op,body", [(UPDATE, RENAME), (LATE, LATE_BODY)])
def test_edit_mode_course_level_write_needs_the_course_resolution(op, body):
    _edit_mode()
    session = FakeSession(_canvas())
    with pytest.raises(ex.CourseResolutionRequired):
        _dispatch(op, body, session, _ctx(course_id=None))
    assert session.calls == []


def test_edit_mode_course_level_write_refuses_a_resolution_for_another_course():
    _edit_mode()
    session = FakeSession(_canvas())
    with pytest.raises(ex.CourseResolutionRequired):
        _dispatch(UPDATE, RENAME, session, _ctx(course_id="202"))
    assert session.calls == []


def test_edit_mode_course_rename_reads_the_course_first_and_reads_it_back():
    _edit_mode()
    session = FakeSession(_canvas())
    out = _dispatch(UPDATE, RENAME, session, _ctx())
    assert _paths(session) == [("GET", "/api/v1/courses/101"),
                               ("PUT", "/api/v1/courses/101"),
                               ("GET", "/api/v1/courses/101")]
    assert out["outcome"] == "verified", out["verification"]
    assert _journaled_target(out["op_id"])["course_name"] == "Bio 101"


def test_edit_mode_late_policy_reads_the_course_first():
    _edit_mode()
    session = FakeSession(_canvas())
    out = _dispatch(LATE, LATE_BODY, session, _ctx())
    assert _paths(session)[:2] == [("GET", "/api/v1/courses/101"),
                                   ("PATCH", "/api/v1/courses/101/late_policy")]
    assert _journaled_target(out["op_id"])["course_name"] == "Bio 101"


def test_edit_mode_journals_the_course_of_a_course_level_write():
    _edit_mode()
    _dispatch(UPDATE, RENAME, FakeSession(_canvas()), _ctx())
    with open(ex.JOURNAL_PATH, encoding="utf-8") as fh:
        admitted = [json.loads(line) for line in fh
                    if '"mode.write_admitted"' in line]
    assert admitted and str(admitted[-1].get("course_id")) == "101"


# ---------------------------------------------------------- plan mode --

def test_approval_names_the_course_of_a_course_level_write():
    entry = ex.catalog_descriptor_to_entry(*UPDATE, extra={"body": RENAME})
    record = mint_approval(entry, {"id": "101"}, BASE)
    assert record["target"]["course_id"] == "101"


def _cli(argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        try:
            code = ex.main(argv)
        except SystemExit as exc:
            code = exc.code
    return code, out.getvalue()


@pytest.mark.parametrize("op,body", [(UPDATE, RENAME), (LATE, LATE_BODY)])
def test_plan_write_shows_the_course_name(monkeypatch, op, body):
    session = FakeSession(_canvas())
    monkeypatch.setattr(ex.SessionStore, "load",
                        classmethod(lambda cls, path=None: session))
    name, method, path = op
    code, out = _cli(["plan-write", "--name", name, "--method", method,
                      "--path", path, "--params", json.dumps({"id": "101"}),
                      "--body", json.dumps(body), "--backend", "https",
                      "--user-id", USER, "--conversation-id", CONV])
    assert code == 0, out
    prepared = json.loads(out)
    assert prepared["course"]["id"] == "101"
    assert prepared["course"]["name"] == "Bio 101"
    assert "Bio 101" in prepared["approval_display"]


def test_plan_mode_course_rename_end_to_end(monkeypatch):
    session = FakeSession(_canvas())
    monkeypatch.setattr(ex.SessionStore, "load",
                        classmethod(lambda cls, path=None: session))
    name, method, path = UPDATE
    code, out = _cli(["plan-write", "--name", name, "--method", method,
                      "--path", path, "--params", json.dumps({"id": "101"}),
                      "--body", json.dumps(RENAME), "--backend", "https",
                      "--user-id", USER, "--conversation-id", CONV])
    assert code == 0, out
    op_id = json.loads(out)["op_id"]
    session.calls.clear()
    code, out = _cli(["approve-write", "--op-id", op_id,
                      "--authorization", "Yes", "--backend", "https",
                      "--user-id", USER, "--conversation-id", CONV])
    assert code == 0, out
    assert json.loads(out)["outcome"] == "verified"
    assert _paths(session) == [("GET", "/api/v1/courses/101"),
                               ("PUT", "/api/v1/courses/101"),
                               ("GET", "/api/v1/courses/101")]
