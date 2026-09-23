#!/usr/bin/env python3
"""Batch writes and classic quiz deletes are read back where the change is.

Failure modes this suite pins down (written before the fix; final sweep
2026-09-22, probe final-sweep/muse-engine/test_p4_readback.py):
  1. _WRITE_READBACK_MEMBER_RE took /assignments/overrides and
     /assignments/bulk_update for assignment member URLs. After a
     successful C-36 batch override update Morrow re-read the batch
     route itself (Canvas needs assignment_overrides[] parameters
     there), so every live-proven C-36 write came back as an
     unconfirmed change; C-37 re-read /assignments/bulk_update, which
     Canvas answers 404. Member routes need a numeric id (pages keep
     their slug). C-36 is read back with the batch retrieve of exactly
     the overrides it changed; C-37 with one GET per assignment,
     comparing the dates it set.
  2. A classic quiz delete (C-375) was confirmed with a direct member
     GET. Canvas may still serve a deleted classic quiz there (D-002 in
     SCOPE.md); removal from the course quiz index is the receipt. A
     successful delete was journaled as failed. The delete is now
     verified against the quiz index (all pages), and fails only when
     the quiz is still listed there.

Hermetic: fake provider session; journal, approvals, settings, and the
signing key live in pytest's tmp_path.
"""

import json
import os
import sys
import urllib.parse

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (TREE, os.path.join(TREE, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from dispatch import executor as ex  # noqa: E402
import dispatch.admission as admission_mod  # noqa: E402
from dispatch.test_direct_lane_hardening import (  # noqa: E402,F401
    BASE, FakeSession, _pack, hermetic)

USER = "muse:readback@school.edu"
CONV = "conv-readback"
CTX = {"user_id": USER, "conversation_id": CONV,
       "course_resolution": {"course_id": "101", "confidence": 1.0,
                             "user_confirmed": True}}
COURSE = json.dumps({"id": 101, "name": "Bio 101"}).encode()
DUE = "2026-10-01T23:59:00Z"


@pytest.fixture(autouse=True)
def edit_mode(hermetic, monkeypatch):
    monkeypatch.setattr(admission_mod, "SECRETS_DIR",
                        str(hermetic / "secrets"))
    monkeypatch.setattr(admission_mod, "SIGNING_KEY_PATH",
                        str(hermetic / "secrets" / "approval-signing.key"))
    monkeypatch.delenv("MORROW_APPROVAL_SIGNING_KEY", raising=False)
    from settings import store
    store.set_setting(USER, "default_mode", "edit", educator_confirmed=True)
    store.set_setting(USER, "confirm_destructive_writes", False,
                      educator_confirmed=True)
    from privacy import executor_wire as wire
    monkeypatch.setenv(wire.SOURCE_VAULT_ENV_VAR,
                       str(hermetic / "vault.json"))
    yield hermetic


class ChromiumFake(FakeSession):
    """Chromium-lane stand-in: overrides can name students, so C-36 runs
    only where receipts are de-identified. It serves the empty course
    roster the executor reads before it touches the course."""

    browser_owned_auth = True

    def __init__(self, handler):
        def with_roster(method, url, body):
            path = _path(url)
            if method == "GET" and path.startswith("/api/v1/courses/") \
                    and path.endswith(("/users", "/enrollments")):
                return 200, {}, b"[]"
            return handler(method, url, body)
        super().__init__(with_roster)


def _path(url):
    return urllib.parse.urlsplit(url).path.rstrip("/")


def _query(url):
    return urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query)


def _is_course(method, url):
    return method == "GET" and _path(url).endswith("/api/v1/courses/101")


def _calls(session):
    return [(c[0], c[1].replace(BASE, "")) for c in session.calls]


# ------------------------------------------------ member readback shape --

@pytest.mark.parametrize("route", [
    "/api/v1/courses/101/assignments/overrides",
    "/api/v1/courses/101/assignments/bulk_update",
])
def test_a_batch_route_is_not_an_assignment_member(route):
    assert ex._readback_target("PUT", BASE + route, None) is None


@pytest.mark.parametrize("route", [
    "/api/v1/courses/101/assignments/42",
    "/api/v1/courses/101/assignment_groups/7",
    "/api/v1/courses/101/discussion_topics/9",
    "/api/v1/courses/101/modules/3",
    "/api/v1/courses/101/quizzes/338345",
    "/api/v1/courses/101/pages/week-1",
])
def test_member_routes_still_read_back(route):
    assert ex._readback_target("PUT", BASE + route, None) == BASE + route


# ------------------------------------------- C-36 batch override update --

OVERRIDES = [{"id": 82766, "assignment_id": 5, "due_at": DUE},
             {"id": 82767, "assignment_id": 6, "due_at": DUE}]


def _override_canvas(stored_due=DUE, missing=()):
    def handler(method, url, body):
        if _is_course(method, url):
            return 200, {}, COURSE
        if _path(url).endswith("/assignments/overrides"):
            if method == "PUT":
                return 200, {}, json.dumps(OVERRIDES).encode()
            if method == "GET":
                pairs = _query(url)
                ids = [v for k, v in pairs
                       if k == "assignment_overrides[][id]"]
                aids = [v for k, v in pairs
                        if k == "assignment_overrides[][assignment_id]"]
                if not ids or len(ids) != len(aids):
                    return 400, {}, b'{"errors": [{"message": "missing"}]}'
                out = [None if int(i) in missing else
                       {"id": int(i), "assignment_id": int(a),
                        "due_at": stored_due, "title": "Section 1"}
                       for i, a in zip(ids, aids)]
                return 200, {}, json.dumps(out).encode()
        return 404, {}, b"{}"
    return handler


def _update_overrides(session):
    pytest.importorskip("cryptography")
    return ex.dispatch_catalog_op(
        "canvas_batch_update_overrides_in_course", "PUT",
        "/api/v1/courses/{course_id}/assignments/overrides", None,
        {"course_id": "101"},
        extra={"body": {"assignment_overrides": OVERRIDES}},
        session=session, pack=_pack(), mode_ctx=CTX)


def test_batch_override_update_reads_back_the_overrides_it_changed():
    session = ChromiumFake(_override_canvas())
    out = _update_overrides(session)
    assert out["outcome"] == "verified", out["verification"]
    reads = [c for c in session.calls if c[0] == "GET"
             and _path(c[1]).endswith("/assignments/overrides")]
    assert len(reads) == 1
    assert _query(reads[0][1]) == [
        ("assignment_overrides[][id]", "82766"),
        ("assignment_overrides[][assignment_id]", "5"),
        ("assignment_overrides[][id]", "82767"),
        ("assignment_overrides[][assignment_id]", "6")]


def test_batch_override_update_that_did_not_land_is_failed():
    session = ChromiumFake(
        _override_canvas(stored_due="2026-12-01T23:59:00Z"))
    with pytest.raises(ex.WriteFieldMismatch):
        _update_overrides(session)


def test_batch_override_update_with_an_override_not_found_is_unverified():
    session = ChromiumFake(_override_canvas(missing=(82767,)))
    out = _update_overrides(session)
    assert out["outcome"] == "unverified"
    assert "82767" in out["verification"]["detail"]


# ------------------------------------------- C-37 bulk assignment dates --

BULK = [{"id": 5, "all_dates": [{"base": True, "due_at": DUE}]},
        {"id": 6, "all_dates": [{"id": 900, "due_at": DUE,
                                 "lock_at": DUE}]}]


def _bulk_canvas(applied=True):
    def handler(method, url, body):
        if _is_course(method, url):
            return 200, {}, COURSE
        path = _path(url)
        if method == "PUT" and path.endswith("/assignments/bulk_update"):
            return 200, {}, json.dumps(
                {"id": 1, "workflow_state": "queued"}).encode()
        if method == "GET" and path.endswith("/assignments/5"):
            return 200, {}, json.dumps(
                {"id": 5, "due_at": DUE if applied else None,
                 "overrides": []}).encode()
        if method == "GET" and path.endswith("/assignments/6"):
            return 200, {}, json.dumps(
                {"id": 6, "due_at": None,
                 "overrides": [{"id": 900, "due_at": DUE,
                                "lock_at": DUE}]}).encode()
        return 404, {}, b"{}"
    return handler


def _bulk_update(session):
    return ex.dispatch_catalog_op(
        "canvas_bulk_update_assignment_dates", "PUT",
        "/api/v1/courses/{course_id}/assignments/bulk_update", None,
        {"course_id": "101"}, extra={"body": BULK},
        session=session, pack=_pack(), mode_ctx=CTX)


def test_bulk_date_update_reads_back_each_assignment():
    session = FakeSession(_bulk_canvas())
    out = _bulk_update(session)
    assert out["outcome"] == "verified", out["verification"]
    reads = [(m, u) for m, u in _calls(session) if m == "GET"
             and "/assignments/" in u]
    assert [_path(u) for _m, u in reads] == [
        "/api/v1/courses/101/assignments/5",
        "/api/v1/courses/101/assignments/6"]
    assert ("include[]", "overrides") in _query(reads[0][1])


def test_bulk_date_update_not_applied_yet_is_unverified_not_failed():
    """Canvas applies a bulk date update in the background (the PUT
    answers with a progress record), so a date that has not changed
    yet is not proof of a failure."""
    session = FakeSession(_bulk_canvas(applied=False))
    out = _bulk_update(session)
    assert out["outcome"] == "unverified"
    assert "background" in out["verification"]["detail"]


# ---------------------------------------------- C-375 classic quiz delete --

def _quiz_canvas(index_pages, index_headers=None):
    """Canvas that still serves the deleted quiz on its member GET
    (D-002) and lists the course quiz index in index_pages."""
    def handler(method, url, body):
        if _is_course(method, url):
            return 200, {}, COURSE
        path = _path(url)
        if method == "DELETE" and path.endswith("/quizzes/338345"):
            return 200, {}, json.dumps({"id": 338345}).encode()
        if method == "GET" and path.endswith("/quizzes/338345"):
            return 200, {}, json.dumps(
                {"id": 338345, "title": "Quiz 1"}).encode()
        if method == "GET" and path.endswith("/courses/101/quizzes"):
            page = int(dict(_query(url)).get("page", "1"))
            headers = dict(index_headers or {})
            if page < len(index_pages):
                headers["Link"] = ('<%s/api/v1/courses/101/quizzes?page=%d'
                                   '&per_page=100>; rel="next"'
                                   % (BASE, page + 1))
            return 200, headers, json.dumps(index_pages[page - 1]).encode()
        return 404, {}, b"{}"
    return handler


def _delete_quiz(session):
    return ex.dispatch_catalog_op(
        "canvas_delete_quiz", "DELETE",
        "/api/v1/courses/{course_id}/quizzes/{id}", None,
        {"course_id": "101", "id": "338345"},
        session=session, pack=_pack(), mode_ctx=CTX)


def test_classic_quiz_delete_is_verified_by_the_quiz_index():
    session = FakeSession(_quiz_canvas([[{"id": 1}], [{"id": 2}]]))
    out = _delete_quiz(session)
    assert out["outcome"] == "verified", out["verification"]
    index_reads = [u for m, u in _calls(session) if m == "GET"
                   and _path(u).endswith("/courses/101/quizzes")]
    assert len(index_reads) == 2


def test_classic_quiz_still_in_the_index_is_a_failed_delete():
    session = FakeSession(_quiz_canvas([[{"id": 1}],
                                        [{"id": 338345, "title": "Quiz 1"}]]))
    with pytest.raises(ex.WriteFieldMismatch):
        _delete_quiz(session)


def test_a_cut_off_quiz_index_is_not_proof_of_a_delete():
    """A quiz index read that was cut at the byte bound cannot prove the
    quiz is gone: the quiz may sit in the part that was not read."""
    session = FakeSession(_quiz_canvas(
        [[{"id": 1}]], {"x-morrow-truncated": "body truncated"}))
    out = _delete_quiz(session)
    assert out["outcome"] == "unverified"


class _BoundRecorder(FakeSession):
    def __init__(self, handler):
        super().__init__(handler)
        self.bounds = []

    def raw_request(self, method, url, headers, body, is_write=False,
                    max_bytes=None):
        self.bounds.append((method, _path(url), max_bytes))
        return super().raw_request(method, url, headers, body,
                                   is_write=is_write, max_bytes=max_bytes)


def test_the_quiz_index_is_read_with_room_for_a_large_course():
    """A course with many quizzes has an index larger than one
    operation's 256 KB receipt bound; the index read gets its own."""
    session = _BoundRecorder(_quiz_canvas([[{"id": 1}]]))
    _delete_quiz(session)
    bounds = [b for m, p, b in session.bounds
              if m == "GET" and p.endswith("/courses/101/quizzes")]
    assert bounds and all(b >= 4 * 1024 * 1024 for b in bounds)
