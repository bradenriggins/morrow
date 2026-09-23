#!/usr/bin/env python3
"""The approval names the change, the object, and the time the way the
educator knows them.

Failure modes this suite pins down (written before the fix; round-2
findings, 2026-09-23, probe final-sweep/muse-engine/render_all.py):

  1. The one sentence the educator approves was built by splitting the
     path into noun and id pairs, so many live-proven writes read
     wrongly or as nonsense: a revert that replaces a page's content
     read 'Create the revision "3" in the page "syllabus"', the sync
     that deletes unlisted blackout dates read "Change a blackout
     date", and the favorites routes read 'Create a 123 in the favorite
     "courses"' with a failure label of "deleting the {id}". Others:
     "Create a group categorie", "Create a bank entrie", "Change a done
     in the module item", "Create a reorder in the quiz", 'Create the
     calendar event "timetable_events"'.
  2. plan-write read only the course, so a change or a deletion named
     its object only by its Canvas number ('Delete the assignment
     "4045366".'): the educator could not check it was the one they
     meant before approving a change Morrow cannot undo.
  3. Date values were shown as raw UTC ISO strings ("Due date:
     2026-09-30T23:59:00Z", which is 7:59 PM in New York).

Hermetic: a fake Canvas; journal, approvals, settings, and the signing
key live in pytest's tmp_path.
"""

import json
import os
import re

import pytest

from dispatch import approval_display
from dispatch import executor as ex
from dispatch.admission import _render_path
from dispatch.test_round4_write_ceremony import (  # noqa: F401
    BASE, FakeSession, USER, hermetic, hermetic_keys)
from dispatch.test_direct_lane_hardening import _pack

WHERE = 'the course "Bio 101"'


def _live_proven_writes():
    rows = [d for d in ex._load_operation_catalog().values()
            if d["effect"] == "write" and d["status"] == "live-proven"]
    assert len(rows) > 80
    return sorted(rows, key=lambda d: d["id"])


def _sample_params(path):
    params = {}
    for slot in re.findall(r"\{([^}]+)\}", path):
        params[slot] = "123" if slot.endswith("id") and slot != "url_or_id" \
            else "week-1"
    params["course_id"] = "101"
    return params


def _sentence(method, path, names=None):
    request = {"method": method, "url": "{canvas_base}" + path,
               "path": _render_path(path, _sample_params(path))}
    return approval_display._change_sentence(request, names)


BAD_WORDING = [
    (re.compile(r"[{}]"), "a template slot"),
    (re.compile(r"\b(?:a|an|the) \d"), "a number used as a noun"),
    (re.compile(r"\ban (?![aeiouAEIOU])"), "'an' before a consonant"),
    (re.compile(r"\ba (?=[aeiouAEIOU])"), "'a' before a vowel"),
    (re.compile(r"entrie\b|categorie\b|_"), "a bad word"),
]


@pytest.mark.parametrize("row", _live_proven_writes(),
                         ids=lambda row: row["id"])
def test_every_live_proven_write_reads_as_a_plain_action(row):
    method, path = row["method"], row["path"]
    assert approval_display.unknown_words(method, path) == []
    sentence = _sentence(method, path)
    phrase = approval_display.describe_operation(method, path, WHERE)
    for text in (sentence, phrase):
        for pattern, what in BAD_WORDING:
            assert not pattern.search(text), (row["id"], what, text)


@pytest.mark.parametrize("method, path, sentence", [
    ("POST", "/api/v1/courses/{course_id}/pages/{url_or_id}/revisions/"
     "{revision_id}",
     'Restore the page "week-1" to its earlier version 123 (this replaces '
     "what the page says now)"),
    ("PUT", "/api/v1/courses/{course_id}/blackout_dates",
     "Replace all of the course's blackout dates with this list (a "
     "blackout date not on it is deleted)"),
    ("POST", "/api/v1/users/self/favorites/courses/{id}",
     'Add the course "123" to your favorites'),
    ("DELETE", "/api/v1/users/self/favorites/courses/{id}",
     'Remove the course "123" from your favorites'),
    ("POST", "/api/v1/courses/{course_id}/group_categories",
     "Create a group set"),
    ("POST", "/api/banks/{bank_id}/bank_entries",
     'Add an entry to the item bank "123"'),
    ("POST", "/api/v1/courses/{course_id}/assignments/{assignment_id}/"
     "duplicate", 'Copy the assignment "123"'),
    ("PUT", "/api/v1/courses/{course_id}/modules/{module_id}/items/{id}/"
     "done", 'Mark the item "123" in the module "123" as done'),
    ("POST", "/api/v1/courses/{course_id}/quizzes/{id}/reorder",
     'Reorder the questions of the quiz "123"'),
    # A list that replaces the course's own says what it deletes.
    ("POST", "/api/v1/courses/{course_id}/calendar_events/"
     "timetable_events",
     "Replace the course's timetable events with this list (a timetable "
     "event not on it is deleted)"),
    ("PUT", "/api/v1/courses/{course_id}/modules/{context_module_id}/"
     "assignment_overrides",
     'Replace the date overrides of the module "123" with this list (an '
     "override not on it is deleted)"),
])
def test_actions_read_as_what_they_do(method, path, sentence):
    assert _sentence(method, path) == sentence


def test_failure_labels_name_the_action_not_a_slot():
    assert approval_display.describe_operation(
        "DELETE", "/api/v1/users/self/favorites/courses/{id}") \
        == "removing a course from your favorites"
    assert approval_display.describe_operation(
        "POST", "/api/v1/courses/{course_id}/pages/{url_or_id}/revisions/"
        "{revision_id}", WHERE) \
        == 'restoring an earlier version of a page in %s' % WHERE


def test_a_named_object_replaces_its_number():
    path = "/api/v1/courses/{course_id}/assignments/{id}"
    assert _sentence("DELETE", path, {"id": "Week 3 Quiz"}) \
        == 'Delete the assignment "Week 3 Quiz"'
    path = "/api/v1/courses/{course_id}/pages/{url_or_id}/revisions/" \
        "{revision_id}"
    assert _sentence("POST", path, {"url_or_id": "Course Syllabus"}) \
        .startswith('Restore the page "Course Syllabus" to its earlier '
                    'version 123')


# ------------------------------------------------ plan-write reads --

ASSIGNMENT = {"id": 4045366, "name": "Week 3 Quiz", "points_possible": 10,
              "due_at": "2026-09-24T23:59:00Z"}


def _canvas(state, time_zone=None):
    def handler(method, url, body):
        path = url.split("?")[0]
        if method == "GET" and path.endswith("/api/v1/courses/101"):
            course = {"id": 101, "name": "Bio 101"}
            if time_zone:
                course["time_zone"] = time_zone
            return 200, {}, json.dumps(course).encode()
        if path.endswith("/assignments/4045366"):
            if state.get("assignment") is None:
                return 404, {}, b'{"errors": [{"message": "not found"}]}'
            if method == "GET":
                return 200, {}, json.dumps(state["assignment"]).encode()
            if method == "DELETE":
                deleted = dict(state["assignment"])
                state["assignment"] = None
                return 200, {}, json.dumps(deleted).encode()
            if method == "PUT":
                sent = json.loads(body.decode())["assignment"]
                state["assignment"] = dict(state["assignment"], **sent)
                return 200, {}, json.dumps(state["assignment"]).encode()
        return 404, {}, b"{}"
    return handler


DELETE = ("canvas_delete_assignment", "DELETE",
          "/api/v1/courses/{course_id}/assignments/{id}")
EDIT = ("canvas_edit_assignment", "PUT",
        "/api/v1/courses/{course_id}/assignments/{id}")
PARAMS = {"course_id": "101", "id": "4045366"}


def _prepare(op, session, body=None, user_id=None):
    name, method, path = op
    return ex.prepare_plan_write(name, method, path, dict(PARAMS), body,
                                 session, _pack(), user_id=user_id)


def test_a_deletion_names_the_assignment_by_its_title():
    session = FakeSession(_canvas({"assignment": dict(ASSIGNMENT)}))
    prepared = _prepare(DELETE, session)
    text = prepared["approval_display"]
    assert 'Delete the assignment "Week 3 Quiz".' in text, text
    assert "4045366" not in text
    assert [c[0] for c in session.calls] == ["GET", "GET"]
    out = ex.approve_plan_write(prepared["op_id"], "Yes", session, _pack())
    assert out["outcome"] == "verified"


def test_an_object_that_cannot_be_read_is_not_prepared():
    session = FakeSession(_canvas({"assignment": None}))
    with pytest.raises(ex.TargetIdentityMismatch) as info:
        _prepare(DELETE, session)
    assert "Nothing was prepared" in str(info.value)
    assert not [c for c in session.calls if c[0] == "DELETE"]


def test_approve_refuses_when_the_object_changed_after_it_was_shown():
    state = {"assignment": dict(ASSIGNMENT)}
    session = FakeSession(_canvas(state))
    prepared = _prepare(DELETE, session)
    state["assignment"]["name"] = "Final Exam"
    with pytest.raises(ex.TargetIdentityMismatch) as info:
        ex.approve_plan_write(prepared["op_id"], "Yes", session, _pack())
    assert "Nothing was sent" in str(info.value)
    assert not [c for c in session.calls if c[0] == "DELETE"]
    pending = ex.pending_write_path(prepared["op_id"])
    assert not os.path.exists(pending[:-len(".json")] + ".plan.json")


BODY = {"assignment": {"due_at": "2026-09-30T23:59:00Z",
                       "points_possible": 20}}


def test_dates_are_shown_in_the_educators_time_zone():
    from settings import store
    store.set_setting(USER, "timezone", "America/New_York",
                      educator_confirmed=True)
    session = FakeSession(_canvas({"assignment": dict(ASSIGNMENT)},
                                  time_zone="America/Chicago"))
    prepared = _prepare(EDIT, session, BODY, user_id=USER)
    text = prepared["approval_display"]
    assert 'Change the assignment "Week 3 Quiz".' in text, text
    assert "Due date: Wednesday, September 30, 2026 at 7:59 PM " \
        "(America/New_York)" in text, text
    assert "2026-09-30T23:59:00Z" not in text
    assert "Points: 20" in text
    assert "2026-09-30T23:59:00Z" in prepared["audit_detail"]


def test_dates_fall_back_to_the_course_time_zone_then_utc():
    session = FakeSession(_canvas({"assignment": dict(ASSIGNMENT)},
                                  time_zone="America/Chicago"))
    text = _prepare(EDIT, session, BODY, user_id=USER)["approval_display"]
    assert "Due date: Wednesday, September 30, 2026 at 6:59 PM " \
        "(America/Chicago)" in text, text
    session = FakeSession(_canvas({"assignment": dict(ASSIGNMENT)}))
    text = _prepare(EDIT, session, BODY, user_id=USER)["approval_display"]
    assert "Due date: Wednesday, September 30, 2026 at 11:59 PM (UTC)" \
        in text, text
