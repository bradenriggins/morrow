#!/usr/bin/env python3
"""End to end: the educator works by name, the model sees labels.

Scenario: the educator says "extend Jane Doe's due date by two days".
The agent runs `students find` for the name the educator typed, gets
Jane's label, writes the override BY LABEL, and relays the result.

Failure modes this suite pins down (written before the code; privacy
audit round 4, H3c/H3d and M2, 2026-09-22):
  1. A label in a write went to Canvas unchanged ({"student_ids":
     ["Student A3"]}) and a label path parameter was refused, so no
     write could target a student by label.
  2. The executor must send Canvas the REAL id for every place a
     learner id can appear (body id arrays, path parameters), after the
     mode gate, and only for the course the label belongs to: a label
     the course never issued is refused, and an echoed label whose name
     does not match this conversation's record is refused.
  3. Nothing the agent sees (find output, dispatch result, error
     payload) and nothing in the journal carries the raw id, or any
     name, email, or login the educator did not type.
  4. The readback shows the label, echoed with the name the educator
     typed, in the conversation where the educator typed it only.
  5. Plan mode still stops the write before any label is resolved.
  6. A WriteFieldMismatch's engineering_detail carried raw readback
     values (name, email, raw ids) to the agent through the funnel.

The run writes a repeatable artifact of the flow to
.selftest-work/by-name-e2e-artifact.json (labels only).
"""

import json
import os
import re
import shutil
import sys

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (TREE, os.path.join(TREE, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

pytest.importorskip("cryptography")

from dispatch import executor as ex  # noqa: E402
import dispatch.admission as admission_mod  # noqa: E402
from dispatch.test_direct_lane_hardening import (  # noqa: E402,F401
    BASE, _pack, hermetic)
from learners.test_students_find import ROSTER, fake_canvas  # noqa: E402
from modes import errors as mode_errors  # noqa: E402

USER = "byname-educator"
CONV = "byname-conv"
OTHER_CONV = "byname-other-conv"
COURSE = "1"
JANE_ID = 98765
ORIGINAL_DUE = "2026-10-01T23:59:00Z"
EXTENDED_DUE = "2026-10-03T23:59:00Z"
OVERRIDE = ("canvas_create_assignment_override", "POST",
            "/api/v1/courses/{course_id}/assignments/{assignment_id}/"
            "overrides")
FOR_USER = ("canvas_list_assignments_for_user", "GET",
            "/api/v1/users/{user_id}/courses/{course_id}/assignments")
# Everything the educator did NOT type, plus Jane's non-name identifiers.
NOT_INTRODUCED = ("98765", "55123", "70001", "70002", "70003", "jdoe",
                  "jane.doe@", "20231234", "Robert", "Smith", "rsmith",
                  "Casey", "Rivera", "Mia", "Chen", "@school.edu")
ARTIFACT = os.path.join(TREE, ".selftest-work", "by-name-e2e-artifact.json")


class BrowserFake:
    """Chromium-lane stand-in: browser-owned auth, scripted Canvas."""

    browser_owned_auth = True

    def __init__(self):
        self.calls = []
        self.overrides = {}

    def base_for(self, provider):
        return BASE

    def slot_secret(self, slot):
        raise AssertionError("the browser lane injects no credentials")

    def raw_request(self, method, url, headers, body, is_write=False,
                    max_bytes=None):
        data = json.loads(body) if body else None
        self.calls.append((method, url, data))
        path = url.split("?", 1)[0][len(BASE):]
        if method == "GET" and path == "/api/v1/courses/1":
            return self._ok({"id": 1, "name": "Biology 101"})
        # The course roster the executor reads before it touches a
        # course (every course here has the same students).
        if method == "GET" and path.startswith("/api/v1/courses/") \
                and path.endswith("/users"):
            return self._ok(ROSTER)
        if method == "GET" and path.startswith("/api/v1/courses/") \
                and path.endswith("/enrollments"):
            return self._ok([])
        if method == "POST" and path.endswith("/assignments/3/overrides"):
            body = data["assignment_override"]
            rec = {"id": 5, "assignment_id": 3,
                   "student_ids": list(body["student_ids"]),
                   "due_at": body["due_at"], "title": "1 student"}
            self.overrides[5] = rec
            return self._ok(rec, 201)
        if method == "GET" and path.endswith("/assignments/3/overrides/5"):
            return self._ok(self.overrides[5])
        if path == "/api/v1/courses/1/discussion_topics/7":
            topic = {"id": 7, "title": "Week 1 by Jane Doe "
                                       "(jane.doe@school.edu)",
                     "user_name": "Jane Doe",
                     "author": {"id": 98765, "display_name": "Jane Doe"}}
            return self._ok(topic)
        if path == "/api/v1/courses/1/pages/week-1":
            page = {"url": "week-1", "page_id": 7,
                    "title": "Week 1 by Jane Doe (jane.doe@school.edu)",
                    "body": "<p>Jane Doe will lead Friday.</p>"}
            return self._ok(page)
        if method == "GET" and path == "/api/v1/users/98765/courses/1/" \
                                       "assignments":
            return self._ok([{"id": 3, "name": "Essay",
                              "due_at": ORIGINAL_DUE,
                              "html_url": BASE + "/courses/1/assignments/3"}])
        return 404, {}, b'{"errors": [{"message": "not found"}]}', 1

    @staticmethod
    def _ok(payload, status=200):
        return (status, {"Content-Type": "application/json"},
                json.dumps(payload).encode("utf-8"), 1)


@pytest.fixture(autouse=True)
def world(hermetic, monkeypatch):
    monkeypatch.setattr(admission_mod, "SECRETS_DIR",
                        str(hermetic / "secrets"))
    monkeypatch.setattr(admission_mod, "SIGNING_KEY_PATH",
                        str(hermetic / "secrets" / "approval-signing.key"))
    monkeypatch.delenv("MORROW_APPROVAL_SIGNING_KEY", raising=False)
    from privacy import executor_wire as wire
    monkeypatch.setenv(wire.SOURCE_VAULT_ENV_VAR,
                       str(hermetic / "vault.json"))
    yield hermetic


def _ctx(conversation=CONV):
    return {"user_id": USER, "conversation_id": conversation,
            "course_resolution": {"course_id": COURSE, "confidence": 1.0,
                                  "user_confirmed": True}}


def _edit_mode():
    from settings import store
    store.set_setting(USER, "default_mode", "edit", educator_confirmed=True)


def _journal_text():
    try:
        with open(ex.JOURNAL_PATH, encoding="utf-8") as fh:
            return fh.read()
    except FileNotFoundError:
        return ""


_WORD_RE = re.compile(r"[A-Za-z0-9_-]+")


def found_in(text, needles):
    """The needles that occur in text.

    A needle made only of letters, digits, "_" and "-" counts only as a
    whole word. Ciphertext, HMACs, digests, keys, and op ids are long
    random runs of exactly those characters, so a short name or id can
    sit inside one by chance with no leak. A needle with any other
    character ("jane.doe@", "Doe, Jane") cannot occur inside such a run
    and counts anywhere."""
    words = set(_WORD_RE.findall(text))
    return [n for n in needles
            if (n in words if _WORD_RE.fullmatch(n) else n in text)]


def _leaks(value, introduced=("Jane Doe",)):
    text = value if isinstance(value, str) else json.dumps(value)
    for name in introduced:
        text = text.replace(name, "")
    return found_in(text, NOT_INTRODUCED + ("Jane", "Doe"))


def _find(query, conversation=CONV, **kw):
    from learners import find
    return find.find_student(fake_canvas(), BASE, COURSE, query,
                             conversation_id=conversation, **kw)


def _override(session, who, conversation=CONV):
    name, method, path = OVERRIDE
    return ex.dispatch_catalog_op(
        name, method, path, "write",
        {"course_id": COURSE, "assignment_id": "3"},
        pack=_pack(), session=session, mode_ctx=_ctx(conversation),
        extra={"body": {"assignment_override": {
            "student_ids": [who], "due_at": EXTENDED_DUE}}})


def test_extend_jane_does_due_date_by_name():
    _edit_mode()
    transcript = []
    # 1. The educator typed "Jane Doe"; the agent resolves it.
    found = _find("Jane Doe")
    transcript.append({"step": "students find", "output": found})
    assert found["status"] == "resolved", found
    label = found["student"]
    shown = found["shown_as"]
    assert shown == "Jane Doe (%s)" % label

    session = BrowserFake()
    # 2. The agent reads her assignments by label (path parameter).
    name, method, path = FOR_USER
    read = ex.dispatch_catalog_op(
        name, method, path, "read",
        {"user_id": label, "course_id": COURSE}, pack=_pack(),
        session=session, mode_ctx=_ctx())
    transcript.append({"step": "read by label", "output": read})
    assert read["receipt"][0]["due_at"] == ORIGINAL_DUE
    assert any(url.startswith(BASE + "/api/v1/users/98765/")
               for _m, url, _b in session.calls)

    # 3. The agent writes the override by label (the echoed form).
    out = _override(session, shown)
    transcript.append({"step": "write by label", "output": out})
    posts = [b for m, _u, b in session.calls if m == "POST"]
    assert posts == [{"assignment_override": {
        "student_ids": [JANE_ID], "due_at": EXTENDED_DUE}}], posts
    # No live-proven single-override GET exists yet (C-45 is pending),
    # so the write is honestly "unverified"; the receipt still says who.
    assert out["outcome"] in ("verified", "unverified"), out
    assert out["receipt"]["student_ids"] == [shown], out["receipt"]

    # 4. Nothing un-introduced reaches the agent or the journal.
    for step in transcript:
        assert _leaks(step["output"]) == [], step
    journal = _journal_text()
    assert _leaks(journal, introduced=()) == [], journal[-2000:]
    assert label in journal

    os.makedirs(os.path.dirname(ARTIFACT), exist_ok=True)
    with open(ARTIFACT, "w", encoding="utf-8") as fh:
        json.dump({"scenario": "extend Jane Doe's due date by two days",
                   "educator_typed": "Jane Doe",
                   "label": label,
                   "canvas_received_the_real_id": posts[0][
                       "assignment_override"]["student_ids"] == [JANE_ID],
                   "transcript": transcript}, fh, indent=1, sort_keys=True)


def test_bare_label_write_and_other_conversation_sees_label_only():
    _edit_mode()
    label = _find("Jane Doe")["student"]
    session = BrowserFake()
    out = _override(session, label, conversation=OTHER_CONV)
    assert out["receipt"]["student_ids"] == [label]
    assert "Jane" not in json.dumps(out)
    assert [b for m, _u, b in session.calls if m == "POST"][0][
        "assignment_override"]["student_ids"] == [JANE_ID]


def test_dry_run_by_label_shows_the_label_never_the_id():
    _edit_mode()
    label = _find("Jane Doe")["student"]
    before = _journal_text()
    name, method, path = OVERRIDE
    out = ex.dispatch_catalog_op(
        name, method, path, "write",
        {"course_id": COURSE, "assignment_id": "3"}, pack=_pack(),
        session=BrowserFake(), mode_ctx=_ctx(OTHER_CONV), dry_run=True,
        extra={"body": {"assignment_override": {
            "student_ids": [label], "due_at": EXTENDED_DUE}}})
    assert out["dry_run"] is True
    assert "98765" not in json.dumps(out), out
    assert label in json.dumps(out)
    assert _journal_text() == before


def test_label_never_issued_in_this_course_is_refused():
    _edit_mode()
    _find("Jane Doe")
    session = BrowserFake()
    with pytest.raises(ex.ExecutorError) as info:
        _override(session, "Student A99")
    assert not [c for c in session.calls if c[0] == "POST"]
    assert "Student A99" in str(info.value)


def test_echo_name_that_does_not_match_the_record_is_refused():
    _edit_mode()
    label = _find("Jane Doe")["student"]
    session = BrowserFake()
    with pytest.raises(ex.ExecutorError):
        _override(session, "Mia Chen (%s)" % label)
    assert not [c for c in session.calls if c[0] == "POST"]


def test_label_from_another_course_is_refused():
    _edit_mode()
    from learners import find
    # Course 2 knows exactly one student (its only label is Student A1);
    # course 1 issued Student A1..A5 for its five students.
    find.find_student(fake_canvas(roster=[ROSTER[1]]), BASE, "2",
                      "Robert Smith", conversation_id=CONV)
    shown = _find("Jane Doe")["shown_as"]
    ctx = _ctx()
    ctx["course_resolution"] = {"course_id": "2", "confidence": 1.0,
                                "user_confirmed": True}
    name, method, path = OVERRIDE
    for who in ("Student A5", shown):
        session = BrowserFake()
        with pytest.raises(ex.LearnerLabelUnresolved):
            ex.dispatch_catalog_op(
                name, method, path, "write",
                {"course_id": "2", "assignment_id": "3"}, pack=_pack(),
                session=session, mode_ctx=ctx,
                extra={"body": {"assignment_override": {
                    "student_ids": [who], "due_at": EXTENDED_DUE}}})
        assert not [c for c in session.calls if c[0] == "POST"], who


def test_plan_mode_refuses_before_any_label_is_resolved(monkeypatch):
    label = _find("Jane Doe")["student"]
    from privacy import executor_wire as wire
    called = []
    monkeypatch.setattr(wire, "resolve_learner_labels",
                        lambda *a, **k: called.append(a))
    with pytest.raises(mode_errors.PlanModeWriteWithoutApproval):
        _override(BrowserFake(), label)
    assert called == []


def _lift_hold(monkeypatch, name):
    """Admit one held operation for this test only (the policy file is
    unchanged)."""
    import copy
    policy = copy.deepcopy(admission_mod.load_policy())
    policy["evidence_holds"]["tool_names"].remove(name)
    monkeypatch.setattr(admission_mod, "_policy_cache", policy)


def test_mismatch_detail_reaches_the_agent_projected(monkeypatch):
    # Discussion writes are held until a Chromium-lane battery proves
    # them, and the discussion update is the one learner-data write
    # with a readback. The projection pinned here runs the same way on
    # any such write, so the hold is lifted for this test only.
    _lift_hold(monkeypatch, "canvas_update_topic_courses")
    _edit_mode()
    _find("Jane Doe")
    session = BrowserFake()
    from failures.funnel import agent_error_payload
    with pytest.raises(ex.WriteFieldMismatch) as info:
        ex.dispatch_catalog_op(
            "canvas_update_topic_courses", "PUT",
            "/api/v1/courses/{course_id}/discussion_topics/{topic_id}",
            "write", {"course_id": COURSE, "topic_id": "7"}, pack=_pack(),
            session=session, mode_ctx=_ctx(OTHER_CONV),
            extra={"body": {"title": "Week 1"}})
    assert "readback mismatch" in str(info.value)
    payload = agent_error_payload("extend a due date", info.value)
    text = json.dumps(payload)
    assert _leaks(text, introduced=()) == [], text
    journal = _journal_text()
    assert _leaks(journal, introduced=()) == [], journal[-2000:]
