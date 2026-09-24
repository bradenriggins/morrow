#!/usr/bin/env python3
"""A course named for its student shows the student's label everywhere.

Failure modes this suite pins down (written before the fix; muse engine
round 2, 2026-09-23). An independent study is often named for its
student ("Independent Study: Jane Doe"). A course read (C-114) labeled
the name, but three other paths gave the raw name to the assistant or
the journal:
  1. plan-write: the approval display the assistant must show word for
     word ('... in the course "Independent Study: Jane Doe"'), the
     returned course.name, the operation label used in approve-write
     failure messages, and the approval record journaled with the write.
  2. Every write's journal record: target.course_name, in Plan mode and
     in Edit mode.
  3. The course list (C-437, "Show me my courses"): it spans courses and
     had no roster at all, so even a student the vault had already
     labeled in that course showed by name.
The name is labeled with the course's roster exactly as a course read
labels it. The check that the course was not renamed between the
approval and the send still compares the name Canvas has, not only its
label: a rename to the labeled text is still a rename. On the course
list, a course whose student list cannot be read, or past the number
of courses whose lists one read checks, is listed by its number with
its name withheld: Morrow never returns a name it could not check.

Hermetic: a scripted Chromium-lane Canvas; journal, vault, approvals,
and settings live in pytest's tmp_path.
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
from dispatch.test_by_name_e2e import (  # noqa: E402,F401
    BASE, CONV, COURSE, USER, BrowserFake, _ctx, _edit_mode, _find,
    _journal_text, hermetic, world)
from dispatch.test_direct_lane_hardening import FakeSession, _pack  # noqa: E402
from learners.test_students_find import found_in  # noqa: E402

NAME = "Independent Study: Jane Doe"
SHOW = ("canvas_get_single_course_courses", "GET", "/api/v1/courses/{id}")
UPDATE = ("canvas_update_course", "PUT", "/api/v1/courses/{id}")
LIST = ("canvas_list_courses", "GET", "/api/v1/courses")
NOT_TYPED = ("Jane", "Doe", "jane.doe@", "jdoe", "98765", "Robert",
             "Smith", "Mia", "Chen")


class NamedCourses(BrowserFake):
    """Canvas with course 1 named for Jane Doe, course 2 an ordinary
    course, and course 3 whose student list cannot be read."""

    def __init__(self, names=None, unreadable=()):
        super().__init__()
        self.names = dict(names or {"1": NAME, "2": "Biology 101",
                                    "3": "Chemistry: Jane Doe"})
        self.unreadable = set(unreadable)
        self.code = "IS-101"

    def raw_request(self, method, url, headers, body, is_write=False,
                    max_bytes=None):
        path = url.split("?", 1)[0][len(BASE):]
        parts = path.strip("/").split("/")
        if path == "/api/v1/courses" and method == "GET":
            self.calls.append((method, url, None))
            return self._ok([{"id": int(cid), "name": name,
                              "course_code": "C-%s" % cid}
                             for cid, name in sorted(self.names.items())])
        if len(parts) >= 4 and parts[:3] == ["api", "v1", "courses"] \
                and parts[3] in self.unreadable and len(parts) == 5 \
                and parts[4] in ("users", "enrollments"):
            self.calls.append((method, url, None))
            raise ex.ProviderHttpError(403, "fake", body=b"{}")
        if len(parts) == 4 and parts[:3] == ["api", "v1", "courses"] \
                and parts[3] in self.names:
            data = json.loads(body) if body else None
            self.calls.append((method, url, data))
            if method == "PUT":
                self.code = data["course"]["course_code"]
            return self._ok({"id": int(parts[3]),
                             "name": self.names[parts[3]],
                             "course_code": self.code,
                             "term": {"name": "Fall 2026"}})
        return super().raw_request(method, url, headers, body, is_write,
                                   max_bytes)


def _leaks(value):
    text = value if isinstance(value, str) else json.dumps(value)
    return found_in(text, NOT_TYPED)


def _read_course(session, course="1"):
    name, method, path = SHOW
    return ex.dispatch_catalog_op(name, method, path, "read", {"id": course},
                                  pack=_pack(), session=session,
                                  mode_ctx=_ctx())["receipt"]


def _plan(session, code="IS-102"):
    name, method, path = UPDATE
    return ex.prepare_plan_write(
        name, method, path, {"id": COURSE}, {"course": {"course_code": code}},
        session, _pack(), conversation_id=CONV, user_id=USER)


def _pending(op_id):
    with open(ex.pending_write_path(op_id), encoding="utf-8") as fh:
        return fh.read()


# -- 1 ------------------------------------------------------------------------

def test_plan_write_names_the_course_by_its_label():
    session = NamedCourses()
    shown = _read_course(session)["name"]
    assert shown.startswith("Independent Study: Student A") and \
        _leaks(shown) == [], shown
    prepared = _plan(session)
    assert prepared["course"]["name"] == shown
    assert ('in the course "%s"' % shown) in prepared["approval_display"]
    assert _leaks(prepared) == []
    assert _leaks(_pending(prepared["op_id"])) == []


def test_the_approved_write_journals_the_label_never_the_name():
    session = NamedCourses()
    prepared = _plan(session)
    out = ex.approve_plan_write(prepared["op_id"], "yes", session, _pack(),
                                mode_ctx={"user_id": USER,
                                          "conversation_id": CONV})
    assert [c[0] for c in session.calls
            if c[0] == "PUT"] == ["PUT"], session.calls
    assert _leaks(out) == []
    journal = _journal_text()
    assert _leaks(journal) == [], journal
    record = [json.loads(line) for line in journal.splitlines()
              if json.loads(line).get("op_id") == prepared["op_id"]
              and json.loads(line).get("wal") == "complete"][-1]
    assert record["target"]["course_name"] == prepared["course"]["name"]


def test_a_rename_between_approval_and_send_is_refused():
    session = NamedCourses()
    prepared = _plan(session)
    session.names["1"] = prepared["course"]["name"]
    with pytest.raises(ex.TargetIdentityMismatch) as info:
        ex.approve_plan_write(prepared["op_id"], "yes", session, _pack(),
                              mode_ctx={"user_id": USER,
                                        "conversation_id": CONV})
    assert not [c for c in session.calls if c[0] == "PUT"]
    assert _leaks(str(info.value)) == []


def test_an_approval_failure_names_the_course_by_its_label():
    session = NamedCourses()
    prepared = _plan(session)
    session.names["1"] = "Independent Study: Robert Smith"
    with pytest.raises(ex.TargetIdentityMismatch) as info:
        ex.approve_plan_write(prepared["op_id"], "yes", session, _pack(),
                              mode_ctx={"user_id": USER,
                                        "conversation_id": CONV})
    label = getattr(info.value, ex.OPERATION_LABEL_ATTR)
    assert prepared["course"]["name"] in label
    assert _leaks(label) == [] and _leaks(str(info.value)) == []


# -- 2 ------------------------------------------------------------------------

def test_an_edit_mode_write_journals_the_label_never_the_name():
    _edit_mode()
    session = NamedCourses()
    name, method, path = UPDATE
    out = ex.dispatch_catalog_op(
        name, method, path, "write", {"id": COURSE}, pack=_pack(),
        session=session, mode_ctx=_ctx(),
        extra={"body": {"course": {"course_code": "IS-102"}}})
    assert out["outcome"] in ("verified", "unverified"), out
    assert _leaks(out) == []
    journal = _journal_text()
    assert _leaks(journal) == [], journal
    assert "Independent Study: Student A" in journal


# -- 3 ------------------------------------------------------------------------

def _list(session):
    name, method, path = LIST
    return ex.dispatch_catalog_op(name, method, path, "read", {},
                                  pack=_pack(), session=session,
                                  mode_ctx=_ctx())


def test_the_course_list_labels_each_course_with_its_own_students():
    session = NamedCourses(unreadable=())
    listed = {str(c["id"]): c for c in _list(session)["receipt"]}
    assert listed["2"]["name"] == "Biology 101"
    assert listed["1"]["name"].startswith("Independent Study: Student A")
    assert listed["3"]["name"].startswith("Chemistry: Student A")
    assert _leaks(listed) == []
    assert _leaks(_journal_text()) == []
    # The same label a course read shows.
    assert listed["1"]["name"] == _read_course(session)["name"]


def test_the_list_shows_a_label_the_vault_already_issued():
    session = NamedCourses(unreadable=())
    shown = _read_course(session)["name"]
    listed = {str(c["id"]): c for c in _list(session)["receipt"]}
    assert listed["1"]["name"] == shown


def test_a_course_whose_students_cannot_be_read_is_listed_without_its_name():
    session = NamedCourses(unreadable=("3",))
    listed = {str(c["id"]): c for c in _list(session)["receipt"]}
    assert listed["3"] == {"id": 3, "name": ex.COURSE_NAME_WITHHELD}
    assert listed["2"]["name"] == "Biology 101"
    assert _leaks(listed) == []


def test_courses_past_the_bound_are_listed_without_their_names(monkeypatch):
    monkeypatch.setattr(ex, "COURSE_LIST_ROSTER_MAX", 2)
    session = NamedCourses(unreadable=())
    listed = {str(c["id"]): c for c in _list(session)["receipt"]}
    assert listed["3"] == {"id": 3, "name": ex.COURSE_NAME_WITHHELD}
    assert listed["2"]["name"] == "Biology 101"
    rosters = {c[1].split("?")[0] for c in session.calls
               if c[1].split("?")[0].endswith("/users")}
    assert rosters == {BASE + "/api/v1/courses/1/users",
                       BASE + "/api/v1/courses/2/users"}


def test_a_course_list_morrow_cannot_read_as_courses_is_refused():
    class Garbled(NamedCourses):
        def raw_request(self, method, url, headers, body, is_write=False,
                        max_bytes=None):
            if url.split("?", 1)[0] == BASE + "/api/v1/courses":
                return self._ok([{"name": NAME}])
            return super().raw_request(method, url, headers, body,
                                       is_write, max_bytes)
    with pytest.raises(ex.ExecutorError) as info:
        _list(Garbled())
    assert _leaks(str(info.value)) == []


def test_the_raw_lane_list_shows_the_labels_the_vault_issued():
    shown = _read_course(NamedCourses())["name"]

    def handler(method, url, body):
        return 200, {}, json.dumps([{"id": 1, "name": NAME}]).encode()
    listed = _list(FakeSession(handler))["receipt"]
    assert listed == [{"id": 1, "name": shown}]
