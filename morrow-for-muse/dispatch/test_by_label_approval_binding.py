#!/usr/bin/env python3
"""A Plan-mode write by label is bound to the student, not the label text.

Failure modes this suite pins down (written before the fix; final muse
audit 2026-09-22, proofs final-muse/tests/test_planwrite_by_label.py):
  M1. plan-write stored the label ("Student A3") and approve-write
      re-resolved it at send time. A purge plus a new `students find`
      between plan and approve can issue the same label to another
      student, so the approved write went to that other student. The
      plan must bind each label to its vault token (learner_<uuid>, new
      on every issue) and approve must refuse when a token changed. The
      real LMS id is never stored or shown.
  M2. The typed student name ("Jane Doe (Student A3)") was stored in
      plaintext in pending_writes/<op>.json and approvals/<op>.json
      forever. Both must hold the bare label; the name lives only in
      the encrypted name-echo store. Abandoned prepared writes and old
      approval records must expire, and every purge must remove them.
  L3. relabel_learner_ids rewrote ANY number equal to a resolved
      student id (an override's own id, an html_url segment) into the
      label; and a free-text field whose whole value is a label (a page
      titled "Student A1") was sent to Canvas as the student's real id.
      Labels resolve to ids only in learner-id positions (in free text a
      label goes to Canvas as the student's name, since the final sweep
      of 2026-09-23), and relabeling touches only learner-id fields and
      URL segments after a person route word.
  F1. The leak checks searched for "Jane", "Doe", and 5-digit ids
      anywhere in the stored files. The vault ciphertext, the journal's
      HMACs and digests, the signing key, and op ids are random runs of
      base64url or hex, so about 1 run in 55 found a needle inside them
      with no leak (CI run 35798238486). A stored name or id stands as
      its own word; the checks match it that way.
"""

import glob
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
from dispatch import admission as admission_mod  # noqa: E402
from dispatch.test_by_name_e2e import (  # noqa: E402,F401
    BASE, CONV, COURSE, EXTENDED_DUE, JANE_ID, OVERRIDE, USER, BrowserFake,
    _edit_mode, _find, _journal_text, found_in, hermetic, world)
from dispatch.test_direct_lane_hardening import _pack  # noqa: E402
from learners.test_students_find import ROSTER, fake_canvas  # noqa: E402

RAW_IDS = ("98765", "55123", "70001", "70002", "70003")


def _ctx(conversation=CONV):
    return {"user_id": USER, "conversation_id": conversation}


def _plan(session, who, conversation=CONV):
    name, method, path = OVERRIDE
    return ex.prepare_plan_write(
        name, method, path, {"course_id": COURSE, "assignment_id": "3"},
        {"assignment_override": {"student_ids": [who],
                                 "due_at": EXTENDED_DUE}},
        session, _pack(), conversation_id=conversation)


def _posts(session):
    return [b for m, _u, b in session.calls if m == "POST"]


def _ids_in(text, ids=RAW_IDS):
    return found_in(text, ids)


def _files_containing(root, needles):
    hits = {}
    for path in glob.glob(str(root) + "/**/*", recursive=True):
        if not os.path.isfile(path):
            continue
        try:
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
        except (OSError, UnicodeDecodeError):
            continue
        found = found_in(text, needles)
        if found:
            hits[os.path.relpath(path, str(root))] = found
    return hits


# -- F1 ----------------------------------------------------------------------

def test_leak_search_ignores_random_runs_but_finds_a_stored_name_or_id(
        hermetic):
    (hermetic / "vault.json").write_text(json.dumps({
        "iv": "hCn1HQlmx07kDoew", "tag": "ae270001adbe55123b9e",
        "ciphertext": "hCn1HQlmx07kDoewV4X-Jane_q7XGMnGXJI0Og"}))
    (hermetic / "ops.jsonl").write_text(
        '{"rec_hmac":"hmac-sha256:ae270001adbe","query_digest":'
        '"501655123b9e","op_id":"bb5b725f-f353-4cf8-7000-155123d2dfda",'
        '"ts":"2026-09-23T07:44:44.551230+00:00"}\n')
    assert _files_containing(hermetic, ("Jane", "Doe") + RAW_IDS) == {}
    assert _ids_in(json.dumps({"sig": "a6170002367e98765"}), RAW_IDS) == []
    (hermetic / "leak.json").write_text(json.dumps({
        "shown": "Jane Doe (Student A2)", "student_ids": [55123],
        "url": "https://s.example/api/v1/users/70001?as_user_id=70002"}))
    assert _files_containing(hermetic, ("Jane", "Doe") + RAW_IDS) == {
        "leak.json": ["Jane", "Doe", "55123", "70001", "70002"]}


# -- M1 ----------------------------------------------------------------------

def test_plan_binds_each_label_to_its_vault_token_never_the_real_id():
    label = _find("Jane Doe")["student"]
    prepared = _plan(BrowserFake(), label)
    with open(ex.pending_write_path(prepared["op_id"]),
              encoding="utf-8") as fh:
        doc = json.load(fh)
    tokens = doc["plan"]["request"]["learner_tokens"]
    assert list(tokens) == [label]
    assert tokens[label].startswith("learner_")
    assert _ids_in(json.dumps(doc)) == []


def test_same_student_at_approve_sends_the_real_id():
    shown = _find("Jane Doe")["shown_as"]
    session = BrowserFake()
    prepared = _plan(session, shown)
    assert shown in prepared["approval_display"]
    assert _ids_in(prepared["approval_display"]) == []
    out = ex.approve_plan_write(prepared["op_id"], "yes", session, _pack(),
                                mode_ctx=_ctx())
    assert _posts(session)[0]["assignment_override"]["student_ids"] == \
        [JANE_ID]
    assert _ids_in(json.dumps(out)) == []
    assert _ids_in(_journal_text()) == []


def test_label_reissued_to_another_student_between_plan_and_approve_is_refused():
    from privacy import executor_wire as wire
    from learners import find
    label = _find("Jane Doe")["student"]
    session = BrowserFake()
    prepared = _plan(session, label)
    # Clear only the vault's course records: every purge command also
    # removes prepared writes now, so this stands for any other way the
    # labels can be issued again under a prepared write (a purge from an
    # older build, a vault restored from backup).
    from privacy import core
    vault = core.LearnerVault(wire._source_vault_path())
    try:
        vault.purge_course(BASE, COURSE)
    finally:
        vault.close()
    # Labels re-issued: the roster is first seen without Robert, then in
    # full, so the approved label can now name another student.
    others = [r for r in ROSTER if r["id"] != 55123]
    find.find_student(fake_canvas(roster=others), BASE, COURSE, "Mia Chen",
                      conversation_id="other")
    find.find_student(fake_canvas(), BASE, COURSE, "Jane Doe",
                      conversation_id="other")
    with pytest.raises(ex.ExecutorError) as info:
        ex.approve_plan_write(prepared["op_id"], "yes", session, _pack(),
                              mode_ctx=_ctx())
    assert _posts(session) == []
    message = str(info.value)
    assert label in message and "Nothing was sent" in message
    assert _ids_in(message) == []


def test_tampered_token_in_the_pending_plan_is_refused():
    label = _find("Jane Doe")["student"]
    session = BrowserFake()
    prepared = _plan(session, label)
    path = ex.pending_write_path(prepared["op_id"])
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    doc["plan"]["request"]["learner_tokens"][label] = \
        "learner_00000000-0000-4000-8000-000000000000"
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh)
    with pytest.raises(ex.ExecutorError):
        ex.approve_plan_write(prepared["op_id"], "yes", session, _pack(),
                              mode_ctx=_ctx())
    assert _posts(session) == []


# -- M2 ----------------------------------------------------------------------

def test_typed_name_is_never_stored_in_pending_or_approval_files(hermetic):
    shown = _find("Jane Doe")["shown_as"]
    session = BrowserFake()
    prepared = _plan(session, shown)
    hits = _files_containing(hermetic, ("Jane", "Doe"))
    assert hits == {}, hits
    ex.approve_plan_write(prepared["op_id"], "yes", session, _pack(),
                          mode_ctx=_ctx())
    hits = _files_containing(hermetic, ("Jane", "Doe") + RAW_IDS)
    assert hits == {}, hits
    approvals = glob.glob(os.path.join(admission_mod.APPROVALS_DIR,
                                       "*-*-*-*-*.json"))
    assert approvals, "approve-write persists the signed approval record"


def test_echo_that_does_not_match_this_conversation_is_refused_at_plan():
    label = _find("Jane Doe")["student"]
    with pytest.raises(ex.ExecutorError):
        _plan(BrowserFake(), "Mia Chen (%s)" % label)


def test_abandoned_prepared_writes_and_old_approval_records_expire():
    import datetime
    label = _find("Jane Doe")["student"]
    session = BrowserFake()
    abandoned = _plan(session, label)
    sent = _plan(session, label)
    ex.approve_plan_write(sent["op_id"], "yes", session, _pack(),
                          mode_ctx=_ctx())
    record = os.path.join(admission_mod.APPROVALS_DIR,
                          sent["op_id"] + ".json")
    assert os.path.exists(ex.pending_write_path(abandoned["op_id"]))
    assert os.path.exists(record)
    later = datetime.datetime.now(datetime.timezone.utc) + \
        datetime.timedelta(days=3)
    report = ex.expire_write_ceremony_files(now=later)
    assert not os.path.exists(ex.pending_write_path(abandoned["op_id"]))
    assert not os.path.exists(record)
    assert report["pending_writes_removed"] == 1
    assert report["approval_records_removed"] == 1
    # consumed.json (single-use replay guard) is never touched.
    assert os.path.exists(admission_mod.CONSUMED_PATH)


def test_an_unexpired_prepared_write_survives_the_sweep():
    label = _find("Jane Doe")["student"]
    prepared = _plan(BrowserFake(), label)
    ex.expire_write_ceremony_files()
    assert os.path.exists(ex.pending_write_path(prepared["op_id"]))


@pytest.mark.parametrize("purge", ["tenant", "course"])
def test_purge_removes_prepared_writes_and_approval_records(purge):
    from privacy import executor_wire as wire
    label = _find("Jane Doe")["student"]
    session = BrowserFake()
    pending = _plan(session, label)
    sent = _plan(session, label)
    ex.approve_plan_write(sent["op_id"], "yes", session, _pack(),
                          mode_ctx=_ctx())
    record = os.path.join(admission_mod.APPROVALS_DIR,
                          sent["op_id"] + ".json")
    assert os.path.exists(record)
    if purge == "tenant":
        report = wire.purge_tenant(BASE)
    else:
        report = wire.purge_course(BASE, COURSE)
    assert not os.path.exists(ex.pending_write_path(pending["op_id"]))
    assert not os.path.exists(record)
    assert report["pending_writes_removed"] == 1
    assert report["approval_records_removed"] == 1


def test_purge_of_another_tenant_keeps_this_tenants_files():
    from privacy import executor_wire as wire
    label = _find("Jane Doe")["student"]
    pending = _plan(BrowserFake(), label)
    wire.purge_tenant("https://example.instructure.com")
    assert os.path.exists(ex.pending_write_path(pending["op_id"]))


def test_purge_all_removes_prepared_writes_and_approval_records(monkeypatch):
    from privacy import executor_wire as wire
    from transport import browser_backend as bb
    monkeypatch.setattr(bb, "purge_browser_profile", lambda full=False: {})
    label = _find("Jane Doe")["student"]
    pending = _plan(BrowserFake(), label)
    report = wire.purge_all()
    assert not os.path.exists(ex.pending_write_path(pending["op_id"]))
    assert report["pending_writes_removed"] == 1


# -- L3 ----------------------------------------------------------------------

def _override_write(session, who):
    name, method, path = OVERRIDE
    return ex.dispatch_catalog_op(
        name, method, path, "write",
        {"course_id": COURSE, "assignment_id": "3"}, pack=_pack(),
        session=session,
        mode_ctx=dict(_ctx(), course_resolution={
            "course_id": COURSE, "confidence": 1.0, "user_confirmed": True}),
        extra={"body": {"assignment_override": {
            "student_ids": [who], "due_at": EXTENDED_DUE}}})


def test_a_provider_error_relabels_the_student_but_not_other_objects():
    # A learner receipt goes through the privacy boundary, which labels
    # every value equal to a roster id (the safe direction). An error
    # does not: only relabel_learner_ids runs on it, so it must relabel
    # the student and leave an object id that equals her id alone.
    _edit_mode()
    shown = _find("Jane Doe")["shown_as"]

    class Refusing(BrowserFake):
        def raw_request(self, method, url, headers, body, is_write=False,
                        max_bytes=None):
            if method == "POST":
                self.calls.append((method, url, json.loads(body)))
                raise ex.ProviderHttpError(422, "fake", body=(
                    "assignment %d is locked; user %d is not enrolled"
                    % (JANE_ID, JANE_ID)).encode())
            return super().raw_request(method, url, headers, body,
                                       is_write, max_bytes)
    session = Refusing()
    with pytest.raises(ex.ProviderHttpError) as info:
        _override_write(session, shown)
    body = info.value.body.decode() if isinstance(info.value.body, bytes) \
        else str(info.value.body)
    label = shown.split("(")[1].rstrip(")")
    assert body == ("assignment %d is locked; user %s is not enrolled"
                    % (JANE_ID, label)), body


def test_relabel_rules_by_position():
    from privacy import executor_wire as wire
    mapping = {"98765": "Student A3"}
    out = wire.relabel_learner_ids({
        "id": 98765,
        "user_id": 98765,
        "student_ids": [98765, 12],
        "user": {"id": 98765},
        "points": 98765,
        "html_url": "https://s.example/courses/1/assignments/98765",
        "profile": "https://s.example/courses/1/users/98765/grades",
        "message": "user 98765 is not enrolled; assignment 98765 exists",
    }, mapping)
    assert out["id"] == 98765
    assert out["user_id"] == "Student A3"
    assert out["student_ids"] == ["Student A3", 12]
    assert out["user"]["id"] == "Student A3"
    assert out["points"] == 98765
    assert out["html_url"].endswith("/assignments/98765")
    assert "/users/Student%20A3/grades" in out["profile"]
    assert out["message"] == ("user Student A3 is not enrolled; "
                              "assignment 98765 exists")


def test_a_label_in_free_text_is_sent_as_the_name_not_as_an_id():
    # Free text is never a learner-id position: a label there goes to
    # Canvas as the student's name (privacy/course_content.py), never
    # as the Canvas id.
    _edit_mode()
    label = _find("Jane Doe")["student"]
    session = BrowserFake()
    with pytest.raises(Exception):
        # The fake answers the readback with a different title, so the
        # write fails verification; only the request sent matters here.
        ex.dispatch_catalog_op(
            "canvas_update_create_page_courses", "PUT",
            "/api/v1/courses/{course_id}/pages/{url_or_id}",
            "write", {"course_id": COURSE, "url_or_id": "week-1"},
            pack=_pack(), session=session,
            mode_ctx=dict(_ctx(), course_resolution={
                "course_id": COURSE, "confidence": 1.0,
                "user_confirmed": True}),
            extra={"body": {"wiki_page": {"title": label, "body": label}}})
    puts = [b for m, _u, b in session.calls if m == "PUT"]
    assert puts, "the write was not sent"
    assert puts[0]["wiki_page"]["title"] == "Jane Doe"
    assert puts[0]["wiki_page"]["body"] == "Jane Doe"
    assert _ids_in(json.dumps(puts)) == []


def test_a_label_in_a_learner_id_position_still_resolves():
    _edit_mode()
    label = _find("Jane Doe")["student"]
    session = BrowserFake()
    _override_write(session, label)
    assert _posts(session)[0]["assignment_override"]["student_ids"] == \
        [JANE_ID]
