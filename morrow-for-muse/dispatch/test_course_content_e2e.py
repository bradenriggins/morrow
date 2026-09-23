#!/usr/bin/env python3
"""End to end: course content reaches the model with labels, and edits
of it reach Canvas with the real text.

Scenario (final sweep 2026-09-23, finding
muse/privacy/course-content-names-reach-model): a course page says
"Great work, Jane Doe (jane.doe@school.edu, login jdoe)". The educator
asks Muse to review the page, then to fix one word on it.

Failure modes this suite pins down (written before the code):
  1. The page body reached the model with Jane's name, email, and login:
     only [LEARNER-DATA] rows were projected, and only through the
     receipt's own records and what the vault already knew.
  2. The executor must read the course's whole student roster (every
     enrollment state, and students whose enrollment was deleted) before
     it reads or changes anything in the course, so a student the vault
     never saw is labeled too. Only students named in what the agent
     sees get a label in the vault.
  3. When that roster cannot be read, nothing in the course is read or
     changed (fail closed), and the educator hears why in plain words.
  4. Without the encrypted vault ('cryptography') there are no labels:
     the names are hidden one way ("[hidden: student name]"), and a
     write that still carries a hidden name is refused before anything
     is sent. Other reads and writes work.
  5. Saving an edited page back must put back exactly what the page
     said: "Jane" stays "Jane", the email stays the email, text that
     reads like a label stays as written. A label the course never
     issued is refused before anything is sent.
  6. In plan mode the prepared write stores labels, never the typed
     name, and approve sends the real name.
  7. A page write whose readback does not match reaches the agent and
     the journal with labels only.
  8. The roster read is now the first Canvas call of a course dispatch,
     so a sign-in that died there must arm the re-sign-in flow (write
     halt, quarantine, notice) exactly as a death on the first call
     did before, and a write refused by an active write halt must still
     reach Canvas not at all.
  9. --dry-run rendered the write after its labels were put back into
     the students' real text, so the dry-run report handed the agent
     every name, email, and login on the page. The report shows the
     request as the agent wrote it, with labels, and says the real text
     goes back only when the change is sent. (Added in the final sweep,
     2026-09-23, written before the fix.)
 10. A course given by its SIS code (course_id "sis_course_id:BIO101",
     which the path check accepts) skipped the roster read, because the
     roster read and the projection knew a course only by its number:
     the page reached the agent and the journal with every name, email,
     and login. Such a course is now refused before any Canvas call, and
     the projection refuses content from a course it cannot identify
     instead of passing it through. (Round-2 finding, 2026-09-23,
     written before the fix.)
 11. plan-write now names the object a change names by its title (the
     page "Week 1", not "week-1"). A title can name a student, so the
     title reaches the agent with labels, and the prepared write on
     disk keeps no name. (Round-2 finding, 2026-09-23, written before
     the fix.)

The run writes a repeatable artifact of the flow to
.selftest-work/course-content-e2e-artifact.json (labels only).
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

pytest.importorskip("cryptography")

from dispatch import executor as ex  # noqa: E402
from dispatch import admission as admission_mod  # noqa: E402
from dispatch.test_by_name_e2e import (  # noqa: E402,F401
    BASE, CONV, COURSE, OTHER_CONV, USER, _ctx, _edit_mode, _find,
    _journal_text, found_in, hermetic, world)
from dispatch.test_direct_lane_hardening import _pack  # noqa: E402
from learners.test_students_find import ROSTER  # noqa: E402

ARTIFACT = os.path.join(TREE, ".selftest-work",
                        "course-content-e2e-artifact.json")
SHOW = ("canvas_show_page_courses", "GET",
        "/api/v1/courses/{course_id}/pages/{url_or_id}")
UPDATE = ("canvas_update_create_page_courses", "PUT",
          "/api/v1/courses/{course_id}/pages/{url_or_id}")
PAGE_PARAMS = {"course_id": COURSE, "url_or_id": "week-1"}
DELETED = [{"id": 900, "course_id": 1, "type": "StudentEnrollment",
            "enrollment_state": "deleted", "user_id": 40001,
            "sis_user_id": "S-9001",
            "user": {"id": 40001, "name": "Priya Patel",
                     "sortable_name": "Patel, Priya",
                     "short_name": "Priya Patel", "login_id": "ppatel"}}]
BODY = ("<p>Great work this week, Jane Doe (jane.doe@school.edu, login "
        "jdoe). Mia Chen will lead Friday, and Priya Patel sends notes. "
        "Ask Robert or Ms. Smith. Student A7 is the rubric's example "
        "name.</p>")
# Everything no output may carry: every roster name part, email, login,
# SIS id, and Canvas user id.
SECRETS = ("Jane", "Doe", "jane.doe@", "jdoe", "Mia", "Chen", "Priya",
           "Patel", "ppatel", "S-9001", "40001", "Robert", "Smith", "98765",
           "70003", "@school.edu")


class Canvas:
    """Chromium-lane stand-in: browser-owned auth, one course with a
    roster, a deleted enrollment, and one page."""

    browser_owned_auth = True

    def __init__(self, roster_status=200, page_title="Week 1"):
        self.calls = []
        self.roster_status = roster_status
        self.page = {"url": "week-1", "page_id": 7, "title": page_title,
                     "body": BODY}
        self.readback_title = None

    def base_for(self, provider):
        return BASE

    def slot_secret(self, slot):
        raise AssertionError("the browser lane injects no credentials")

    def raw_request(self, method, url, headers, body, is_write=False,
                    max_bytes=None):
        data = json.loads(body) if body else None
        self.calls.append((method, url, data))
        parts = urllib.parse.urlsplit(url)
        path, query = parts.path, urllib.parse.parse_qs(parts.query)
        if method == "GET" and path == "/api/v1/courses":
            return self._ok([{"id": 1, "name": "Biology 101"}])
        if method == "GET" and path == "/api/v1/courses/1":
            return self._ok({"id": 1, "name": "Biology 101"})
        if method == "GET" and path == "/api/v1/courses/1/users":
            if self.roster_status != 200:
                raise ex.ProviderHttpError(self.roster_status, "fake",
                                           body=b'{"errors": []}')
            assert query.get("enrollment_type[]") == ["student"], query
            assert sorted(query.get("enrollment_state[]") or []) == [
                "active", "completed", "inactive", "invited",
                "rejected"], query
            return self._ok(ROSTER)
        if method == "GET" and path == "/api/v1/courses/1/enrollments":
            assert query.get("state[]") == ["deleted"], query
            assert query.get("type[]") == ["StudentEnrollment"], query
            return self._ok(DELETED)
        if path == "/api/v1/courses/1/pages/week-1":
            if method == "PUT":
                page = dict(self.page)
                page.update(data["wiki_page"])
                self.page = page
                if self.readback_title is not None:
                    self.page = dict(page, title=self.readback_title)
                return self._ok(self.page)
            return self._ok(self.page)
        raise ex.ProviderHttpError(404, "fake", body=b'{"errors": []}')

    @staticmethod
    def _ok(payload, status=200):
        return (status, {"Content-Type": "application/json"},
                json.dumps(payload).encode("utf-8"), 1)

    def paths(self):
        return [(m, urllib.parse.urlsplit(u).path) for m, u, _ in self.calls]


def _show(session):
    name, method, path = SHOW
    return ex.dispatch_catalog_op(name, method, path, "read",
                                  dict(PAGE_PARAMS), pack=_pack(),
                                  session=session)


def _update(session, wiki_page, conversation=CONV):
    name, method, path = UPDATE
    return ex.dispatch_catalog_op(
        name, method, path, "write", dict(PAGE_PARAMS), pack=_pack(),
        session=session, mode_ctx=_ctx(conversation),
        extra={"body": {"wiki_page": wiki_page}})


def _leaks(value):
    text = value if isinstance(value, str) else json.dumps(value)
    return found_in(text, SECRETS)


# -- 1 and 2 ------------------------------------------------------------------

def test_a_page_read_shows_labels_for_every_student_on_the_roster():
    session = Canvas()
    out = _show(session)
    body = out["receipt"]["body"] if "body" in out["receipt"] else \
        json.dumps(out["receipt"])
    assert _leaks(out) == [], json.dumps(out)[:2000]
    assert "Student A" in body
    assert "(email)" in body and "(login)" in body
    assert "Student A7 (as written)" in body
    assert _leaks(_journal_text()) == [], _journal_text()[-2000:]
    order = session.paths()
    page_read = order.index(("GET", "/api/v1/courses/1/pages/week-1"))
    assert order.index(("GET", "/api/v1/courses/1/users")) < page_read
    assert order.index(("GET", "/api/v1/courses/1/enrollments")) < page_read


def test_only_the_students_named_are_labeled_in_the_vault():
    from privacy import executor_wire as wire
    from privacy import core
    _show(Canvas())
    vault = core.LearnerVault(wire._source_vault_path())
    try:
        known = {i["id"] for i in vault.identities_for_scope(
            wire.learner_scope(BASE, COURSE))}
    finally:
        vault.close()
    # Jane, Mia, Robert, and Priya (deleted enrollment) are named on the
    # page; the two Casey Riveras are not, so they have no label.
    assert known == {"98765", "70003", "55123", "40001"}, known


# -- 3 ------------------------------------------------------------------------

def test_when_the_roster_cannot_be_read_nothing_in_the_course_is_read():
    session = Canvas(roster_status=403)
    with pytest.raises(ex.CourseRosterUnavailable) as info:
        _show(session)
    assert ("GET", "/api/v1/courses/1/pages/week-1") not in session.paths()
    message = str(info.value)
    assert "student list" in message and "Nothing was" in message
    from failures.translator import translate
    tr = translate("reading the page Week 1", info.value)
    assert tr.mode_id == "course-roster-unavailable", tr.mode_id


# -- 4 ------------------------------------------------------------------------

def test_without_the_vault_names_are_hidden_and_never_saved_back(
        monkeypatch):
    from privacy import core
    monkeypatch.setattr(core, "AESGCM", None)
    _edit_mode()
    session = Canvas()
    shown = _show(session)["receipt"]["body"]
    assert _leaks(shown) == [], shown
    assert "[hidden: student name]" in shown
    assert ("GET", "/api/v1/courses/1/users") in session.paths()
    with pytest.raises(ex.LearnerLabelUnresolved) as info:
        _update(session, {"body": shown.replace("Friday", "Monday")})
    assert not [c for c in session.calls if c[0] == "PUT"]
    assert "Nothing was sent" in str(info.value)
    _update(session, {"title": "Week 2"})
    puts = [b for m, _u, b in session.calls if m == "PUT"]
    assert puts == [{"wiki_page": {"title": "Week 2"}}]
    listed = ex.dispatch_catalog_op(
        "canvas_list_courses", "GET", "/api/v1/courses", "read", {},
        pack=_pack(), session=session)
    assert "Biology 101" in json.dumps(listed)


# -- 5 ------------------------------------------------------------------------

def test_an_edited_page_goes_back_with_the_real_text():
    _edit_mode()
    session = Canvas()
    shown = _show(session)["receipt"]["body"]
    edited = shown.replace("Friday", "Monday")
    out = _update(session, {"body": edited})
    puts = [b for m, _u, b in session.calls if m == "PUT"]
    assert puts[0]["wiki_page"]["body"] == BODY.replace("Friday", "Monday")
    assert _leaks(out) == [], json.dumps(out)[:2000]
    assert _leaks(_journal_text()) == [], _journal_text()[-2000:]
    _artifact({"read": shown, "edited": edited,
               "result": out.get("receipt")})


def test_a_page_shown_with_a_typed_name_goes_back_exact():
    # The educator named Jane in this conversation, so the page shows
    # her as "Jane Doe (Student An)"; saving it back must not double her
    # name or lose a form.
    _edit_mode()
    label = _find("Jane Doe")["student"]
    session = Canvas()
    name, method, path = SHOW
    shown = ex.dispatch_catalog_op(
        name, method, path, "read", dict(PAGE_PARAMS), pack=_pack(),
        session=session, mode_ctx=_ctx())["receipt"]["body"]
    assert "Jane Doe (%s)" % label in shown
    _update(session, {"body": shown.replace("Friday", "Monday")})
    puts = [b for m, _u, b in session.calls if m == "PUT"]
    assert puts[0]["wiki_page"]["body"] == BODY.replace("Friday", "Monday")


def test_a_label_the_model_writes_reaches_canvas_as_the_name():
    _edit_mode()
    session = Canvas()
    label = _find("Jane Doe")["student"]
    _update(session, {"body": "<p>Congratulations, %s!</p>" % label})
    puts = [b for m, _u, b in session.calls if m == "PUT"]
    assert puts[0]["wiki_page"]["body"] == "<p>Congratulations, Jane Doe!</p>"


def test_a_label_the_course_never_issued_is_refused_before_sending():
    _edit_mode()
    session = Canvas()
    _show(session)
    with pytest.raises(ex.LearnerLabelUnresolved) as info:
        _update(session, {"body": "<p>Thanks, Student A99!</p>"})
    assert not [c for c in session.calls if c[0] == "PUT"]
    assert "Student A99" in str(info.value)
    assert "Nothing was sent" in str(info.value)


# -- 6 ------------------------------------------------------------------------

def test_plan_mode_stores_labels_and_approve_sends_the_name():
    shown = _find("Jane Doe")["shown_as"]
    session = Canvas()
    name, method, path = UPDATE
    prepared = ex.prepare_plan_write(
        name, method, path, dict(PAGE_PARAMS),
        {"wiki_page": {"body": "<p>Well done, %s!</p>" % shown}},
        session, _pack(), conversation_id=CONV)
    with open(ex.pending_write_path(prepared["op_id"]),
              encoding="utf-8") as fh:
        pending = fh.read()
    assert found_in(pending, ("Jane", "Doe")) == [], pending
    assert shown in prepared["approval_display"]
    ex.approve_plan_write(prepared["op_id"], "yes", session, _pack(),
                          mode_ctx={"user_id": USER,
                                    "conversation_id": CONV})
    puts = [b for m, _u, b in session.calls if m == "PUT"]
    assert puts[0]["wiki_page"]["body"] == "<p>Well done, Jane Doe!</p>"


# -- 7 ------------------------------------------------------------------------

def test_a_page_readback_mismatch_reaches_the_agent_with_labels():
    _edit_mode()
    session = Canvas()
    session.readback_title = "Week 1 by Jane Doe (jane.doe@school.edu)"
    from failures.funnel import agent_error_payload
    with pytest.raises(ex.WriteFieldMismatch) as info:
        _update(session, {"title": "Week 1"})
    payload = agent_error_payload("renaming the page Week 1", info.value)
    assert _leaks(payload) == [], json.dumps(payload)
    assert _leaks(_journal_text()) == [], _journal_text()[-2000:]


# -- 8 ------------------------------------------------------------------------

class ChromiumSessionDead(ex.ExecutorError):
    """Stands for the lane's attach-time session death (matched by name,
    as dispatch/executor.py _is_session_dead does)."""


def test_a_sign_in_that_died_at_the_roster_read_arms_the_resign_in_flow(
        monkeypatch):
    armed = []
    monkeypatch.setattr(ex, "_on_session_death",
                        lambda op_id, name, evidence: armed.append(name))

    class Dead(Canvas):
        def raw_request(self, method, url, headers, body, is_write=False,
                        max_bytes=None):
            self.calls.append((method, url, None))
            raise ChromiumSessionDead("Canvas session died")
    session = Dead()
    with pytest.raises(ChromiumSessionDead):
        _show(session)
    assert armed == ["canvas_show_page_courses"]
    assert ("GET", "/api/v1/courses/1/pages/week-1") not in session.paths()


def test_a_halted_write_reaches_canvas_not_at_all(monkeypatch):
    from reauth import state_machine as rsm
    monkeypatch.setattr(rsm, "check_write_allowed",
                        lambda: (False, "write halt active: sign in again"))
    _edit_mode()
    session = Canvas()
    with pytest.raises(ex.WriteHaltActive):
        _update(session, {"title": "Week 2"})
    assert session.calls == []


# -- 9 ------------------------------------------------------------------------

def test_a_dry_run_of_an_edited_page_shows_labels_never_the_names():
    _edit_mode()
    session = Canvas()
    shown = _show(session)["receipt"]["body"]
    edited = shown.replace("Friday", "Monday")
    before = _journal_text()
    name, method, path = UPDATE
    out = ex.dispatch_catalog_op(
        name, method, path, "write", dict(PAGE_PARAMS), pack=_pack(),
        session=session, mode_ctx=_ctx(), dry_run=True,
        extra={"body": {"wiki_page": {"body": edited}}})
    assert out["dry_run"] is True
    assert _leaks(out) == [], json.dumps(out)[:2000]
    assert out["requests"][0]["body"] == {"wiki_page": {"body": edited}}
    assert "real text" in out["note"]
    assert not [c for c in session.calls if c[0] == "PUT"]
    assert _journal_text() == before
    # The same edit, sent, still reaches Canvas with the real text.
    _update(session, {"body": edited})
    puts = [b for m, _u, b in session.calls if m == "PUT"]
    assert puts[0]["wiki_page"]["body"] == BODY.replace("Friday", "Monday")


def test_a_dry_run_of_a_label_the_model_wrote_shows_the_label():
    # Another conversation: no typed name is echoed next to the label.
    _edit_mode()
    session = Canvas()
    label = _find("Jane Doe")["student"]
    name, method, path = UPDATE
    out = ex.dispatch_catalog_op(
        name, method, path, "write", dict(PAGE_PARAMS), pack=_pack(),
        session=session, mode_ctx=_ctx(OTHER_CONV), dry_run=True,
        extra={"body": {"wiki_page": {
            "body": "<p>Congratulations, %s!</p>" % label}}})
    text = json.dumps(out)
    assert _leaks(text) == [], text[:2000]
    assert label in text


# -- 10 -----------------------------------------------------------------------

SIS = "sis_course_id:BIO101"


class SisCanvas(Canvas):
    """Canvas answers a course's SIS form as the course itself."""

    def raw_request(self, method, url, headers, body, is_write=False,
                    max_bytes=None):
        return super().raw_request(
            method, url.replace("/courses/" + SIS, "/courses/1"), headers,
            body, is_write, max_bytes)


@pytest.mark.parametrize("op, params", [
    (SHOW, {"course_id": SIS, "url_or_id": "week-1"}),
    (("canvas_get_single_course_courses", "GET", "/api/v1/courses/{id}"),
     {"id": SIS}),
    # A leading zero reaches course 1 in Canvas but scopes labels apart
    # from "1", as students find does not accept it.
    (SHOW, {"course_id": "01", "url_or_id": "week-1"}),
])
def test_a_course_given_by_its_sis_code_is_refused_before_any_call(op,
                                                                   params):
    from failures.translator import translate
    session = SisCanvas()
    name, method, path = op
    with pytest.raises(ex.InvalidCourseId) as info:
        ex.dispatch_catalog_op(name, method, path, "read", dict(params),
                               pack=_pack(), session=session)
    assert session.calls == []
    assert _leaks(_journal_text()) == [], _journal_text()[-2000:]
    assert "Nothing was sent" in str(info.value)
    tr = translate("reading a page", info.value)
    assert tr.mode_id == "query-course-id-invalid", tr.mode_id


def test_a_change_to_a_course_given_by_its_sis_code_is_refused():
    _edit_mode()
    session = SisCanvas()
    name, method, path = UPDATE
    with pytest.raises(ex.ExecutorError):
        ex.dispatch_catalog_op(
            name, method, path, "write",
            {"course_id": SIS, "url_or_id": "week-1"}, pack=_pack(),
            session=session, mode_ctx=_ctx(),
            extra={"body": {"wiki_page": {"title": "Week 2"}}})
    assert session.calls == []
    assert ex.journal_pending_ops() == []


def test_content_from_a_course_the_projection_cannot_identify_is_refused():
    from privacy import executor_wire as wire
    entry = {"name": "canvas_show_page_courses", "provider": "canvas",
             "request": {"method": "GET", "url": BASE
                         + "/api/v1/courses/%s/pages/week-1" % SIS}}
    with pytest.raises(ex.ExecutorError):
        wire._project_course_content(
            entry, {"receipt": {"body": BODY}}, BASE, {},
            error_cls=ex.ExecutorError)


# -- 11 -----------------------------------------------------------------------

def test_an_object_title_that_names_a_student_is_shown_with_a_label():
    session = Canvas(page_title="Make-up plan for Jane Doe")
    name, method, path = UPDATE
    prepared = ex.prepare_plan_write(
        name, method, path, dict(PAGE_PARAMS),
        {"wiki_page": {"published": True}}, session, _pack())
    text = prepared["approval_display"]
    assert _leaks(text) == [], text
    assert 'Change the page "Make-up plan for Student A' in text, text
    with open(ex.pending_write_path(prepared["op_id"]),
              encoding="utf-8") as fh:
        assert _leaks(fh.read()) == []
    order = session.paths()
    assert order.index(("GET", "/api/v1/courses/1/users")) \
        < order.index(("GET", "/api/v1/courses/1/pages/week-1"))


def _artifact(record):
    os.makedirs(os.path.dirname(ARTIFACT), exist_ok=True)
    text = json.dumps(record, indent=2, sort_keys=True)
    assert _leaks(text) == [], text
    with open(ARTIFACT, "w", encoding="utf-8") as fh:
        fh.write(text + "\n")
