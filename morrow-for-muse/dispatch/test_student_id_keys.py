#!/usr/bin/env python3
"""Student ids that Canvas puts outside a person-named key reach the
agent and the journal as labels only.

Failure modes this suite pins down (written before the fix; muse engine
audit round 2, 2026-09-23). The learner projection labeled ids only
under person-named keys (user_id, student_ids, ...) and kept every
dict key as it was, so:
  1. The live-proven effective due dates read (C-112) keys each
     assignment's entries by student id: {"<assignment id>":
     {"<student id>": {"due_at": ...}}}. Every student's Canvas user id
     reached the agent and the ops journal unlabeled.
  2. The live-proven bulk user tags read (C-226) keys its answer by
     student id at the top level. Same leak.
  3. The live-proven assignment reads (C-48, and one student's
     assignments, C-49) with include[]=assignment_visibility answer
     "assignment_visibility": [<student ids>]. Neither the key nor its
     values were labeled, and C-48 was not even treated as learner
     data, so the raw lane (which has no projection point) sent it.
  4. The ids can be numbers or strings; both must become labels.
  5. A key where Canvas puts a student id that is not an id cannot be
     labeled: the read is refused and nothing is shown.
  6. The label in the answer is the same label `students find` gives
     the student, so the educator's name for them still works.

Hermetic: fake Canvas session; journal, vault, and settings live in
pytest's tmp_path.
"""

import json
import os
import sys

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (TREE, os.path.join(TREE, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

pytest.importorskip("cryptography")

from dispatch import executor as ex  # noqa: E402
import dispatch.admission as admission_mod  # noqa: E402
from dispatch.test_by_name_e2e import (  # noqa: E402,F401
    BASE, COURSE, BrowserFake, _ctx, _find, _journal_text, hermetic,
    world)
from dispatch.test_direct_lane_hardening import (  # noqa: E402
    FakeSession, _pack)
from learners.test_students_find import ROSTER, found_in  # noqa: E402

ROSTER_IDS = tuple(str(u["id"]) for u in ROSTER)
EFFECTIVE_DUE_DATES = ("canvas_get_effective_due_dates", "GET",
                       "/api/v1/courses/{course_id}/effective_due_dates")
BULK_USER_TAGS = ("canvas_bulk_fetch_user_tags_for_multiple_users_in_course",
                  "GET", "/api/v1/courses/{course_id}/bulk_user_tags")
ASSIGNMENTS = ("canvas_list_assignments_assignments", "GET",
               "/api/v1/courses/{course_id}/assignments")
FOR_USER = ("canvas_list_assignments_for_user", "GET",
            "/api/v1/users/{user_id}/courses/{course_id}/assignments")
VISIBILITY = {"include[]": ["assignment_visibility"]}


def _dates(due):
    return {"due_at": due, "grading_period_id": None,
            "in_closed_grading_period": False}


class Canvas(BrowserFake):
    """The Chromium lane with one scripted answer per route."""

    def __init__(self, answers):
        super().__init__()
        self.answers = answers

    def raw_request(self, method, url, headers, body, is_write=False,
                    max_bytes=None):
        path = url.split("?", 1)[0][len(BASE):]
        if method == "GET" and path in self.answers:
            self.calls.append((method, url, body))
            return self._ok(self.answers[path])
        return super().raw_request(method, url, headers, body, is_write,
                                   max_bytes)


def _read(op, params, answers, extra=None):
    name, method, path = op
    return ex.dispatch_catalog_op(name, method, path, "read", params,
                                  pack=_pack(), session=Canvas(answers),
                                  mode_ctx=_ctx(), extra=extra)


def _no_ids(value):
    text = value if isinstance(value, str) else json.dumps(value)
    return found_in(text, ROSTER_IDS) == []


def test_effective_due_dates_label_the_student_keys():
    out = _read(EFFECTIVE_DUE_DATES, {"course_id": COURSE}, {
        "/api/v1/courses/1/effective_due_dates": {
            "3636219": {"98765": _dates("2026-10-01T23:59:00Z"),
                        "55123": _dates("2026-10-03T23:59:00Z")},
            "3636220": {"98765": _dates("2026-10-08T23:59:00Z")}}})
    receipt = out["receipt"]
    assert _no_ids(out), receipt
    assert _no_ids(_journal_text())
    assert sorted(receipt) == ["3636219", "3636220"], receipt
    jane = _find("Jane Doe")["student"]
    assert receipt["3636219"][jane]["due_at"] == "2026-10-01T23:59:00Z"
    assert receipt["3636220"][jane]["due_at"] == "2026-10-08T23:59:00Z"
    assert len(receipt["3636219"]) == 2
    assert all(key.startswith("Student A") for key in receipt["3636219"])


def test_bulk_user_tags_label_the_student_keys():
    out = _read(BULK_USER_TAGS, {"course_id": COURSE}, {
        "/api/v1/courses/1/bulk_user_tags": {
            "98765": [{"id": 4, "name": "Extra time"}],
            "70003": []}})
    receipt = out["receipt"]
    assert _no_ids(out), receipt
    assert _no_ids(_journal_text())
    jane = _find("Jane Doe")["student"]
    assert receipt[jane] == [{"id": 4, "name": "Extra time"}]
    assert len(receipt) == 2 and all(k.startswith("Student A")
                                     for k in receipt), receipt


def test_bulk_user_tags_asked_by_label_answer_by_label():
    jane = _find("Jane Doe")["student"]
    name, method, path = BULK_USER_TAGS
    session = Canvas({"/api/v1/courses/1/bulk_user_tags": {
        "98765": [{"id": 4, "name": "Extra time"}]}})
    out = ex.dispatch_catalog_op(name, method, path, "read",
                                 {"course_id": COURSE}, pack=_pack(),
                                 session=session, mode_ctx=_ctx(),
                                 extra={"body": {"user_ids[]": [jane]}})
    sent = [(url, body) for m, url, body in session.calls
            if "/bulk_user_tags" in url]
    assert sent and "98765" in str(sent[0]), sent
    assert jane not in str(sent[0]), sent
    assert _no_ids(out), out["receipt"]
    assert _no_ids(_journal_text())
    assert list(out["receipt"]) == [jane], out["receipt"]


@pytest.mark.parametrize("ids", [[98765, 55123], ["98765", "55123"]],
                         ids=["numbers", "strings"])
def test_assignment_visibility_is_labeled(ids):
    out = _read(ASSIGNMENTS, {"course_id": COURSE}, {
        "/api/v1/courses/1/assignments": [
            {"id": 3, "name": "Essay", "assignment_visibility": ids}]},
        extra={"body": VISIBILITY})
    receipt = out["receipt"]
    assert _no_ids(out), receipt
    assert _no_ids(_journal_text())
    jane = _find("Jane Doe")["student"]
    visible = receipt[0]["assignment_visibility"]
    assert jane in visible and len(visible) == 2, receipt
    assert receipt[0]["name"] == "Essay" and receipt[0]["id"] == 3


def test_one_students_assignment_visibility_is_labeled():
    jane = _find("Jane Doe")["student"]
    out = _read(FOR_USER, {"user_id": jane, "course_id": COURSE}, {
        "/api/v1/users/98765/courses/1/assignments": [
            {"id": 3, "name": "Essay",
             "assignment_visibility": [98765, 70003]}]},
        extra={"body": VISIBILITY})
    assert _no_ids(out), out["receipt"]
    assert _no_ids(_journal_text())
    # The educator typed Jane's name in this conversation, so her label
    # is echoed with it.
    assert "Jane Doe (%s)" % jane in out["receipt"][0][
        "assignment_visibility"]


def test_asking_for_visibility_is_student_data_on_every_lane(hermetic):
    name, method, path = ASSIGNMENTS
    entry = ex.catalog_descriptor_to_entry(name, method, path, None,
                                           "canvas", None,
                                           {"body": VISIBILITY})
    assert admission_mod.touches_learner_data(entry)
    session = FakeSession(lambda m, u, b: (200, {}, json.dumps(
        [{"id": 3, "assignment_visibility": [98765]}]).encode()))
    with pytest.raises(admission_mod.LearnerDataGated):
        ex.dispatch_catalog_op(name, method, path, "read",
                               {"course_id": COURSE}, pack=_pack(),
                               session=session, extra={"body": VISIBILITY})
    assert session.calls == []
    plain = ex.catalog_descriptor_to_entry(name, method, path, None,
                                           "canvas", None, None)
    assert not admission_mod.touches_learner_data(plain)


@pytest.mark.parametrize("op, answer", [
    (EFFECTIVE_DUE_DATES,
     {"3636219": {"98765": _dates(None), "Jane Doe": _dates(None)}}),
    (BULK_USER_TAGS, {"98765": [], "jane.doe@school.edu": []}),
], ids=["due-dates", "user-tags"])
def test_a_student_key_that_is_not_an_id_refuses_the_read(op, answer):
    route = op[2].replace("{course_id}", COURSE)
    before = _journal_text()
    with pytest.raises(ex.ExecutorError) as info:
        _read(op, {"course_id": COURSE}, {route: answer})
    assert "Jane" not in str(info.value)
    assert "jane.doe@" not in str(info.value)
    assert _no_ids(str(info.value))
    journal = _journal_text()[len(before):]
    assert "Jane" not in journal and _no_ids(journal)
