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
  6. A classic question bank: a question group that draws from one
     (assessment_question_bank_id on question group create C-347 or
     update C-352). Classic question banks are not in this version.
  7. Deleting or concluding the whole course through the course update
     (C-128): course[event] delete, conclude, offer, claim, or undelete,
     and the offer flag. The docs say course delete and conclude (C-108)
     are refused on every tenant even with an approval, and only a
     rename of C-128 was tested; in Edit mode the course was deleted
     with no question, even with "always confirm deletions" on, and in
     Plan mode the educator read only "Change the course" (muse engine
     audit round 2, 2026-09-23). plan-write, catalog, and approve-write
     each refuse it and send nothing.
Each refusal happens before approval, on every lane, and reads to the
educator as a task that is on hold in this version (evidence-hold).

The consent page also lists what Morrow will not do "even if you ask"
(muse engine round 2, 2026-09-23). Two request fields did it anyway on
live-proven routes, and are refused on every route before approval with
no override, like an announcement (never-dispatch):
  7. Acting as someone else: as_user_id makes Canvas act as that person
     (masquerading). It rode on any route, a read included (a GET body
     becomes its query string), and a student label there was turned
     into the student's real id.
  8. Sending messages to people: notify_of_update makes Canvas notify
     every student in the course of the change (assignment, page, and
     classic quiz edits). Set to false, it sends nothing and still runs.

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
GROUP_CREATE = ("canvas_create_question_group", "POST",
                "/api/v1/courses/{course_id}/quizzes/{quiz_id}/groups",
                {"course_id": "101", "quiz_id": "55"})
GROUP_UPDATE = ("canvas_update_question_group", "PUT",
                "/api/v1/courses/{course_id}/quizzes/{quiz_id}/groups/{id}",
                {"course_id": "101", "quiz_id": "55", "id": "5"})
MODULE_ITEM_UPDATE = ("canvas_update_module_item", "PUT",
                      "/api/v1/courses/{course_id}/modules/{module_id}/"
                      "items/{id}",
                      {"course_id": "101", "module_id": "7", "id": "70"})
QUIZ_CREATE = ("canvas_create_quiz", "POST",
               "/api/v1/courses/{course_id}/quizzes", {"course_id": "101"})
QUIZ_UPDATE = ("canvas_edit_quiz", "PUT",
               "/api/v1/courses/{course_id}/quizzes/{id}",
               {"course_id": "101", "id": "55"})
ASSIGNMENTS_READ = ("canvas_list_assignments_assignments", "GET",
                    "/api/v1/courses/{course_id}/assignments",
                    {"course_id": "101"})
PAGE_READ = ("canvas_show_page_courses", "GET",
             "/api/v1/courses/{course_id}/pages/{url_or_id}",
             {"course_id": "101", "url_or_id": "welcome"})

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
    ("question-bank-group", GROUP_CREATE,
     {"quiz_groups": [{"name": "Pool", "pick_count": 2,
                       "assessment_question_bank_id": 12}]}),
    ("question-bank-group-form", GROUP_UPDATE,
     {"quiz_groups[][assessment_question_bank_id]": "12"}),
    ("course-delete", COURSE_UPDATE, {"course": {"event": "delete"}}),
    ("course-conclude", COURSE_UPDATE, {"course": {"event": "conclude"}}),
    ("course-claim", COURSE_UPDATE, {"course": {"event": "claim"}}),
    ("course-offer", COURSE_UPDATE, {"course": {"event": "offer"}}),
    ("course-undelete", COURSE_UPDATE, {"course": {"event": "undelete"}}),
    ("course-event-form", COURSE_UPDATE,
     {"course[name]": "Bio 101", "course[event]": "delete"}),
    ("course-event-top-level", COURSE_UPDATE, {"event": "conclude"}),
    ("course-offer-flag", COURSE_UPDATE,
     {"course": {"name": "Bio 101"}, "offer": True}),
]
ADMITTED = [
    ("page-rename", PAGE_UPDATE, {"wiki_page": {"title": "Welcome!",
                                                "front_page": False}}),
    ("course-rename", COURSE_UPDATE, {"course": {"name": "Bio 101"}}),
    ("course-rename-offer-false", COURSE_UPDATE,
     {"course": {"name": "Bio 101"}, "offer": False}),
    ("new-quiz-rename", NQ_UPDATE, {"quiz": {"title": "Week 2 Quiz",
                                             "published": False}}),
    ("text-assignment", ASSIGNMENT_CREATE,
     {"assignment": {"name": "Essay",
                     "submission_types": ["online_text_entry"]}}),
    ("question-group", GROUP_CREATE,
     {"quiz_groups": [{"name": "Pool", "pick_count": 2}]}),
    ("assignment-edit-quietly", ASSIGNMENT_UPDATE,
     {"assignment": {"name": "Essay", "notify_of_update": False}}),
    ("page-edit-quietly", PAGE_UPDATE,
     {"wiki_page[title]": "Week 1", "wiki_page[notify_of_update]": "0"}),
    ("quiz-edit-quietly", QUIZ_UPDATE,
     {"quiz": {"title": "Q", "notify_of_update": "false"}}),
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


# -- acting as someone else, and notifying students ---------------------------

NEVER = [
    ("act-as-student-page-edit", PAGE_UPDATE,
     {"body": {"as_user_id": "Student A1",
               "wiki_page": {"title": "Week 1"}}}),
    ("act-as-by-id", PAGE_UPDATE,
     {"body": {"as_user_id": 98765, "wiki_page": {"title": "Week 1"}}}),
    ("act-as-by-sis-id", ASSIGNMENT_UPDATE,
     {"body": {"as_user_id": "sis_user_id:20231234",
               "assignment": {"name": "Essay"}}}),
    ("act-as-form-body", PAGE_UPDATE,
     {"body": "as_user_id=98765&wiki_page%5Btitle%5D=Week+1"}),
    ("act-as-read-query", ASSIGNMENTS_READ,
     {"query": {"as_user_id": "98765"}}),
    ("act-as-read-body", PAGE_READ, {"body": {"as_user_id": "98765"}}),
    ("notify-assignment-edit", ASSIGNMENT_UPDATE,
     {"body": {"assignment": {"name": "Essay",
                              "notify_of_update": True}}}),
    ("notify-assignment-create", ASSIGNMENT_CREATE,
     {"body": {"assignment": {"name": "Essay",
                              "notify_of_update": "true"}}}),
    ("notify-page-edit", PAGE_UPDATE,
     {"body": {"wiki_page": {"title": "Week 1",
                             "notify_of_update": True}}}),
    ("notify-page-form", PAGE_UPDATE,
     {"body": {"wiki_page[notify_of_update]": "1"}}),
    ("notify-quiz-edit", QUIZ_UPDATE,
     {"body": {"quiz": {"title": "Q", "notify_of_update": 1}}}),
    ("notify-quiz-create", QUIZ_CREATE,
     {"body": {"quiz": {"title": "Q", "notify_of_update": "on"}}}),
]


def _op_entry(op, extra):
    name, method, path, _params = op
    return ex.catalog_descriptor_to_entry(name, method, path, None,
                                          "canvas", None, extra)


@pytest.mark.parametrize("case, op, extra", NEVER, ids=[c[0] for c in NEVER])
def test_what_morrow_never_does_is_refused_before_anything_is_sent(
        hermetic, case, op, extra):
    from failures.translator import translate
    name, method, path, params = op
    session = FakeSession()
    with pytest.raises(admission_mod.NeverDispatch) as info:
        ex.dispatch_catalog_op(name, method, path, None, dict(params),
                               extra=dict(extra), session=session,
                               dry_run=True)
    assert session.calls == []
    assert "Nothing was sent" in str(info.value)
    kind = "never-dispatch-read" if method == "GET" else "never-dispatch"
    assert translate("changing the course", info.value).mode_id == kind
    with pytest.raises(admission_mod.NeverDispatch):
        admission_mod.check_policy_gates(_op_entry(op, extra),
                                         vault_ready=True)


def test_acting_as_someone_else_in_a_url_query_is_refused():
    entry = _op_entry(PAGE_READ, None)
    entry["request"]["url"] += "?as_user_id=98765"
    with pytest.raises(admission_mod.NeverDispatch):
        admission_mod.check_never_dispatch(entry, admission_mod.load_policy())


def test_each_refusal_says_what_morrow_never_does():
    policy = admission_mod.load_policy()
    for body, words in (
            ({"as_user_id": "98765"}, "anyone other than you"),
            ({"wiki_page": {"notify_of_update": True}},
             "never sends messages")):
        with pytest.raises(admission_mod.NeverDispatch) as info:
            admission_mod.check_never_dispatch(
                _op_entry(PAGE_UPDATE, {"body": body}), policy)
        assert words in str(info.value), str(info.value)


def test_plan_write_refuses_acting_as_someone_else_before_the_educator_is_asked(
        edit_mode):
    session = edit_mode(_canvas(assignment=ESSAY))
    name, method, path, params = ASSIGNMENT_UPDATE
    code, out = _cli(["plan-write", "--name", name, "--method", method,
                      "--path", path, "--params", json.dumps(params),
                      "--body", json.dumps({"as_user_id": "98765",
                                            "assignment": {
                                                "name": "Essay"}})]
                     + _who())
    assert code != 0, out
    assert "NeverDispatch" in out, out
    assert session.calls == []
    pending = os.path.join(ex.MORROW_HOME, ex.PENDING_WRITES_DIRNAME)
    assert not os.path.isdir(pending) or os.listdir(pending) == []


def test_edit_mode_refuses_a_notice_to_every_student(edit_mode):
    session = edit_mode(_canvas(assignment=ESSAY))
    code, out = _publish(ASSIGNMENT_UPDATE,
                         {"assignment": {"name": "Essay",
                                         "notify_of_update": True}})
    assert code != 0, out
    assert "NeverDispatch" in out, out
    assert session.calls == []


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


# -- deleting or concluding the course through the course update ---------------

def _course_canvas():
    """Course 101, Bio 101, which a sent course[event] would change."""
    state = {"workflow_state": "available"}

    def handler(method, url, body):
        path = url.split("?")[0].rstrip("/")
        if path.endswith("/courses/101"):
            if method == "PUT":
                state["workflow_state"] = "deleted"
            return 200, {}, json.dumps({"id": 101, "name": "Bio 101",
                                        **state}).encode()
        return 404, {}, b'{"errors": [{"message": "not found"}]}'
    return handler, state


@pytest.mark.parametrize("event", ["delete", "conclude"])
def test_a_course_event_is_refused_by_every_command(edit_mode, monkeypatch,
                                                    event):
    from settings import store
    store.set_setting(USER, "confirm_destructive_writes", True,
                      educator_confirmed=True)
    handler, state = _course_canvas()
    session = edit_mode(handler)
    name, method, path, params = COURSE_UPDATE
    body = {"course": {"event": event}}
    code, out = _publish(COURSE_UPDATE, body)
    assert code != 0 and "EvidenceHold" in out, out
    code, out = _cli(["plan-write", "--name", name, "--method", method,
                      "--path", path, "--params", json.dumps(params),
                      "--body", json.dumps(body)] + _who())
    assert code != 0 and "EvidenceHold" in out, out
    pending = os.path.join(ex.MORROW_HOME, ex.PENDING_WRITES_DIRNAME)
    assert not os.path.isdir(pending) or os.listdir(pending) == []
    # A write prepared before this version held the field (the hold
    # lifted while plan-write ran) is refused when approved.
    import copy
    held = admission_mod.load_policy()
    lifted = copy.deepcopy(held)
    lifted["evidence_holds"]["request_fields"]["rules"] = [
        r for r in lifted["evidence_holds"]["request_fields"]["rules"]
        if r["field"] != "event"]
    monkeypatch.setattr(admission_mod, "_policy_cache", lifted)
    code, out = _cli(["plan-write", "--name", name, "--method", method,
                      "--path", path, "--params", json.dumps(params),
                      "--body", json.dumps(body)] + _who())
    assert code == 0, out
    op_id = json.loads(out)["op_id"]
    monkeypatch.setattr(admission_mod, "_policy_cache", held)
    code, out = _cli(["approve-write", "--op-id", op_id,
                      "--authorization", "Yes, do it"] + _who())
    assert code != 0 and "EvidenceHold" in out, out
    assert _writes(session) == []
    assert state["workflow_state"] == "available"


def test_the_failed_students_query_is_documented_as_not_in_this_version():
    # muse/query/chain.py failed-students (final sweep 2026-09-23,
    # written before the fix): C-419 (the submissions read) is pending
    # [LEARNER-DATA], so the query can never run live, while SKILL.md,
    # INSTALL.md, install.sh, and CHANGELOG 0.4.1 presented it as a
    # working capability. The query refuses before it reads anything,
    # and the docs must say so, not offer it.
    def read(*parts):
        with open(os.path.join(TREE, *parts), encoding="utf-8") as fh:
            return " ".join(fh.read().split())

    skill = read("SKILL.md")
    assert "who failed last week's quiz" in skill
    assert "not in this version" in skill
    assert "bin/morrow query --course" not in skill, (
        "SKILL.md offers the failed-students query as a working "
        "capability while C-419 is not live-proven")
    # The lists of what cryptography enables name only the capabilities
    # that work: no failed-students question, no grades, no submissions.
    for doc in ("INSTALL.md", "install.sh"):
        text = read(doc)
        assert "the failed-students question" not in text, doc
        assert "rosters, grades" not in text, doc
        assert "and submissions" not in text, doc
    changelog = read("CHANGELOG.md")
    release_041 = changelog.split("## 0.4.1", 1)[1] \
        .split("## 0.4.0", 1)[0]
    assert "who failed last week's quiz" not in release_041, (
        "CHANGELOG 0.4.1 still claims the failed-students answer")
    morrow = read("bin", "morrow")
    assert "not available in this version" in morrow
