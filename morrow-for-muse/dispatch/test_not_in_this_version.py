#!/usr/bin/env python3
"""What the website and the consent page call "not in this version" is
refused, even when it rides as a field on a live-proven route.

Failure modes this suite pins down (written before the fix; website and
consent audit, 2026-09-23). The website's Muse page lists "Publishing a
New Quiz. Choosing the course home page." and discussions under "Not in
this version", and the consent page says Morrow will not do anything we
have not tested, even if you ask. The catalog, live-proven, and policy
gates admitted each of these as a body field on a live-proven route, so
after an approval (or in Edit mode) the untested change ran:
  1. Making a page the course home page: wiki_page[front_page]=true on
     page update (C-334) or page create (C-323). The front-page route
     itself (C-333) failed live and is refused.
  2. Choosing the course home page: course[default_view] on course
     update (C-128), with any value.
  3. Publishing a New Quiz: published=true on New Quiz create (C-286) or
     update (C-299); quiz publish was never tested.
  4. Publishing a New Quiz through its assignment (C-43) or its module
     item (C-283). The route alone does not say it is a New Quiz, so
     Morrow reads the target first (C-44, C-281) and refuses a New
     Quiz. When the read fails, nothing is sent. Publishing an ordinary
     assignment or module item still runs.
  5. A graded discussion: submission_types holding discussion_topic on
     assignment create (C-38) or update (C-43). Discussions are not in
     this version.
Each refusal happens before approval, on every lane, and reads to the
educator as a task that is on hold in this version (evidence-hold).

Hermetic: fake Canvas session; journal, approvals, settings, grants,
and the signing key live in pytest's tmp_path.
"""

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
    FakeSession, hermetic)
from dispatch.test_edit_mode_approve_write import (  # noqa: E402,F401
    CONV, RESOLVED, USER, _cli, _who, hermetic_keys)

PAGE_UPDATE = ("canvas_update_create_page_courses", "PUT",
               "/api/v1/courses/{course_id}/pages/{url_or_id}",
               {"course_id": "101", "url_or_id": "welcome"})
PAGE_CREATE = ("canvas_create_page_courses", "POST",
               "/api/v1/courses/{course_id}/pages", {"course_id": "101"})
COURSE_UPDATE = ("canvas_update_course", "PUT", "/api/v1/courses/{id}",
                 {"id": "101"})
NQ_CREATE = ("canvas_create_new_quiz", "POST",
             "/api/quiz/v1/courses/{course_id}/quizzes",
             {"course_id": "101"})
NQ_UPDATE = ("canvas_update_single_quiz", "PATCH",
             "/api/quiz/v1/courses/{course_id}/quizzes/{assignment_id}",
             {"course_id": "101", "assignment_id": "900"})
ASSIGNMENT_CREATE = ("canvas_create_assignment", "POST",
                     "/api/v1/courses/{course_id}/assignments",
                     {"course_id": "101"})
ASSIGNMENT_UPDATE = ("canvas_edit_assignment", "PUT",
                     "/api/v1/courses/{course_id}/assignments/{id}",
                     {"course_id": "101", "id": "900"})
MODULE_ITEM_UPDATE = ("canvas_update_module_item", "PUT",
                      "/api/v1/courses/{course_id}/modules/{module_id}/"
                      "items/{id}",
                      {"course_id": "101", "module_id": "7", "id": "70"})

REFUSED = [
    ("front-page-json", PAGE_UPDATE, {"wiki_page": {"front_page": True}}),
    ("front-page-form", PAGE_UPDATE, {"wiki_page[front_page]": "1"}),
    ("front-page-create", PAGE_CREATE,
     {"wiki_page": {"title": "Welcome", "front_page": "true"}}),
    ("default-view", COURSE_UPDATE, {"course": {"default_view": "wiki"}}),
    ("default-view-any-value", COURSE_UPDATE,
     {"course[default_view]": ""}),
    ("new-quiz-create-published", NQ_CREATE,
     {"quiz": {"title": "Week 2", "published": True}}),
    ("new-quiz-publish", NQ_UPDATE, {"quiz": {"published": True}}),
    ("graded-discussion-create", ASSIGNMENT_CREATE,
     {"assignment": {"name": "Week 1 discussion",
                     "submission_types": ["discussion_topic"]}}),
    ("graded-discussion-form", ASSIGNMENT_CREATE,
     {"assignment[name]": "Week 1 discussion",
      "assignment[submission_types][]": "discussion_topic"}),
    ("graded-discussion-update", ASSIGNMENT_UPDATE,
     {"assignment": {"submission_types": ["online_text_entry",
                                          "discussion_topic"]}}),
]
ADMITTED = [
    ("page-rename", PAGE_UPDATE, {"wiki_page": {"title": "Welcome!",
                                                "front_page": False}}),
    ("course-rename", COURSE_UPDATE, {"course": {"name": "Bio 101"}}),
    ("new-quiz-rename", NQ_UPDATE, {"quiz": {"title": "Week 2 Quiz",
                                             "published": False}}),
    ("text-assignment", ASSIGNMENT_CREATE,
     {"assignment": {"name": "Essay",
                     "submission_types": ["online_text_entry"]}}),
]


def _entry(op, body):
    name, method, path, _params = op
    return ex.catalog_descriptor_to_entry(name, method, path, None,
                                          "canvas", None, {"body": body})


@pytest.mark.parametrize("case, op, body", REFUSED,
                         ids=[c[0] for c in REFUSED])
def test_an_untested_field_is_refused_before_approval(hermetic, case, op,
                                                      body):
    from failures.translator import translate
    name, method, path, params = op
    session = FakeSession()
    with pytest.raises(admission_mod.EvidenceHold) as info:
        ex.dispatch_catalog_op(name, method, path, None, dict(params),
                               extra={"body": body}, session=session,
                               dry_run=True)
    assert session.calls == []
    assert "Nothing was sent" in str(info.value)
    assert translate("changing the course", info.value).mode_id \
        == "evidence-hold"
    with pytest.raises(admission_mod.EvidenceHold):
        admission_mod.check_policy_gates(_entry(op, body), vault_ready=True)


@pytest.mark.parametrize("case, op, body", ADMITTED,
                         ids=[c[0] for c in ADMITTED])
def test_the_tested_part_of_the_route_still_runs(case, op, body):
    admission_mod.check_policy_gates(_entry(op, body), vault_ready=True)


# -- publishing through the assignment or the module item ---------------------

def _canvas(assignment=None, module_item=None, reads_fail=False):
    """Course 101 with assignment 900 and module item 70 as given."""
    def handler(method, url, body):
        path = url.split("?")[0].rstrip("/")
        if method == "GET" and path.endswith("/courses/101"):
            return 200, {}, json.dumps({"id": 101,
                                        "name": "Bio 101"}).encode()
        if reads_fail and method == "GET":
            return 404, {}, b'{"errors": [{"message": "not found"}]}'
        if path.endswith("/assignments/900") and assignment is not None:
            doc = dict(assignment, id=900)
            if method == "PUT":
                doc["published"] = True
            return 200, {}, json.dumps(doc).encode()
        if path.endswith("/items/70") and module_item is not None:
            doc = dict(module_item, id=70, module_id=7)
            if method == "PUT":
                doc["published"] = True
            return 200, {}, json.dumps(doc).encode()
        return 404, {}, b'{"errors": [{"message": "not found"}]}'
    return handler


NEW_QUIZ = {"name": "Week 2 Quiz", "published": False,
            "submission_types": ["external_tool"],
            "is_quiz_lti_assignment": True}
NEW_QUIZ_NO_FLAG = {"name": "Week 2 Quiz", "published": False,
                    "submission_types": ["external_tool"],
                    "external_tool_tag_attributes": {
                        "url": "https://school.quiz-lti-iad-prod."
                               "instructure.com/lti/launch"}}
ESSAY = {"name": "Essay", "published": False,
         "submission_types": ["online_text_entry"],
         "is_quiz_lti_assignment": False}


@pytest.fixture
def edit_mode(monkeypatch):
    from modes import state as modes
    modes.request_edit_grant(USER, educator_confirmation={
        "by": "educator", "authorization": "use edit mode here",
        "channel": "educator-chat"}, conversation_id=CONV)

    def install(handler):
        session = FakeSession(handler)
        monkeypatch.setattr(ex.SessionStore, "load",
                            classmethod(lambda cls, path=None: session))
        return session
    return install


def _publish(op, body):
    name, method, path, params = op
    return _cli(["catalog", "--name", name, "--method", method,
                 "--path", path, "--params", json.dumps(params),
                 "--body", json.dumps(body), "--class", "write"]
                + RESOLVED + _who())


def _writes(session):
    return [c for c in session.calls if c[2]]


@pytest.mark.parametrize("assignment", [NEW_QUIZ, NEW_QUIZ_NO_FLAG],
                         ids=["flagged", "tool-url"])
def test_publishing_a_new_quiz_through_its_assignment_is_refused(
        edit_mode, assignment):
    session = edit_mode(_canvas(assignment=assignment))
    code, out = _publish(ASSIGNMENT_UPDATE,
                         {"assignment": {"published": True}})
    assert code != 0, out
    assert "EvidenceHold" in out and "New Quiz" in out, out
    assert _writes(session) == []


def test_publishing_a_new_quiz_through_its_module_item_is_refused(
        edit_mode):
    session = edit_mode(_canvas(module_item={
        "title": "Week 2 Quiz", "type": "Assignment", "content_id": 900,
        "quiz_lti": True, "published": False}))
    code, out = _publish(MODULE_ITEM_UPDATE,
                         {"module_item": {"published": True}})
    assert code != 0, out
    assert "EvidenceHold" in out and "New Quiz" in out, out
    assert _writes(session) == []


def test_a_module_item_without_the_flag_is_checked_by_its_assignment(
        edit_mode):
    session = edit_mode(_canvas(assignment=NEW_QUIZ, module_item={
        "title": "Week 2 Quiz", "type": "Assignment", "content_id": 900,
        "published": False}))
    code, out = _publish(MODULE_ITEM_UPDATE,
                         {"module_item": {"published": True}})
    assert code != 0, out
    assert "EvidenceHold" in out, out
    assert _writes(session) == []


def test_a_target_morrow_cannot_read_is_not_published(edit_mode):
    session = edit_mode(_canvas(assignment=ESSAY, reads_fail=True))
    code, out = _publish(ASSIGNMENT_UPDATE,
                         {"assignment": {"published": True}})
    assert code != 0, out
    assert "Nothing was sent" in out, out
    assert _writes(session) == []


def test_publishing_an_ordinary_assignment_still_runs(edit_mode):
    session = edit_mode(_canvas(assignment=ESSAY))
    code, out = _publish(ASSIGNMENT_UPDATE,
                         {"assignment": {"published": True}})
    assert [c[0] for c in _writes(session)] == ["PUT"], out


def test_publishing_an_ordinary_module_item_still_runs(edit_mode):
    session = edit_mode(_canvas(module_item={
        "title": "Syllabus", "type": "Page", "quiz_lti": False,
        "published": False}))
    code, out = _publish(MODULE_ITEM_UPDATE,
                         {"module_item": {"published": True}})
    assert [c[0] for c in _writes(session)] == ["PUT"], out


def test_plan_write_refuses_before_the_educator_is_asked(edit_mode):
    session = edit_mode(_canvas(assignment=NEW_QUIZ))
    name, method, path, params = ASSIGNMENT_UPDATE
    code, out = _cli(["plan-write", "--name", name, "--method", method,
                      "--path", path, "--params", json.dumps(params),
                      "--body", json.dumps({"assignment": {
                          "published": True}})] + _who())
    assert code != 0, out
    assert "EvidenceHold" in out, out
    assert _writes(session) == []
    pending = os.path.join(ex.MORROW_HOME, ex.PENDING_WRITES_DIRNAME)
    assert not os.path.isdir(pending) or os.listdir(pending) == []


def test_a_dry_run_says_the_new_quiz_check_waits_for_the_send(hermetic):
    name, method, path, params = ASSIGNMENT_UPDATE
    session = FakeSession(_canvas(assignment=NEW_QUIZ))
    ctx = {"user_id": USER, "conversation_id": CONV,
           "course_resolution": {"course_id": "101", "confidence": 1.0,
                                 "user_confirmed": True}}
    from modes import state as modes
    modes.request_edit_grant(USER, educator_confirmation={
        "by": "educator", "authorization": "use edit mode here",
        "channel": "educator-chat"}, conversation_id=CONV)
    report = ex.dispatch_catalog_op(
        name, method, path, None, dict(params),
        extra={"body": {"assignment": {"published": True}}},
        session=session, dry_run=True, mode_ctx=ctx)
    assert session.calls == []
    gates = {g["gate"]: g for g in report["gates"]}
    assert gates["new_quiz_publish_check"]["result"] == "skipped"
