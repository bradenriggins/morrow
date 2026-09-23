#!/usr/bin/env python3
"""Morrow for Muse never posts an announcement, and holds discussion writes.

Failure modes this suite pins down (written before the fix; final sweep
2026-09-23):
  1. content/consent.md promises that Morrow will not post announcements
     "even if you ask", and the catalog excludes the announcement
     variants. The admission gate had no rule for them: in Edit mode a
     discussion POST whose body set is_announcement passed every gate
     and went to Canvas, which notifies every student in the course.
  2. The flag can ride in the body or the query, as true, "true", "1",
     "on", a params reference, a form-encoded body, or a bracketed form
     key, and on the topic update route (a PUT can turn a topic into an
     announcement). Every form is refused on every route and lane,
     before any approval, and no override reaches it. A flag set to
     false is not an announcement.
  3. An announcement external feed (C-25) posts each item of an RSS feed
     as an announcement. Creating one is refused the same way.
  4. Discussion create, update, and delete (C-139, C-167, C-141) were
     proven only through the retired form lane, and SCOPE.md withholds
     discussion writes, with the date change (C-238), from v1. They are
     held on every lane, even where student data is de-identified.
  5. The refusals reach the agent in plain words: a never-dispatch
     refusal matched no failure mode (the unknown fallback), and every
     evidence hold was described as "I tried to create a New Quiz".
"""

import json
import os
import sys
import uuid
from types import SimpleNamespace

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (TREE, os.path.join(TREE, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from dispatch import admission  # noqa: E402
from dispatch import executor as ex  # noqa: E402
from dispatch.test_direct_lane_hardening import _pack, hermetic  # noqa: E402,F401

BASE = "https://school.instructure.com"
CREATE = ("canvas_create_new_discussion_topic_courses", "POST",
          "/api/v1/courses/{course_id}/discussion_topics")
UPDATE = ("canvas_update_topic_courses", "PUT",
          "/api/v1/courses/{course_id}/discussion_topics/{topic_id}")
DELETE = ("canvas_delete_topic_courses", "DELETE",
          "/api/v1/courses/{course_id}/discussion_topics/{topic_id}")
DATES = ("canvas_update_learning_object_s_date_information_discussion_topics",
         "PUT", "/api/v1/courses/{course_id}/discussion_topics/"
                "{discussion_topic_id}/date_details")
FEED = ("canvas_create_external_feed_courses", "POST",
        "/api/v1/courses/{course_id}/external_feeds")
BODY = {"title": "Class cancelled", "message": "No class Friday",
        "is_announcement": True}


def _entry(op, extra=None):
    name, method, path = op
    return ex.catalog_descriptor_to_entry(name, method, path, "write",
                                          extra=extra)


class _Session:
    """A Chromium-lane session with the vault's projection point that
    fails the test if anything reaches Canvas."""

    browser_owned_auth = True

    def __init__(self):
        self.calls = []

    def base_for(self, provider):
        return BASE

    def raw_request(self, method, url, headers, body, is_write=False,
                    max_bytes=None):
        self.calls.append((method, url, body))
        raise AssertionError("nothing may reach Canvas: %s %s" % (method, url))


# -- 1 ------------------------------------------------------------------------

def test_edit_mode_announcement_is_refused_before_anything_is_sent():
    from settings import store
    store.set_setting("announce-educator", "default_mode", "edit",
                      educator_confirmed=True)
    session = _Session()
    name, method, path = CREATE
    with pytest.raises(admission.NeverDispatch) as info:
        ex.dispatch_catalog_op(
            name, method, path, "write", {"course_id": "101"}, pack=_pack(),
            session=session, extra={"body": dict(BODY)},
            mode_ctx={"user_id": "announce-educator",
                      "conversation_id": "announce-conv",
                      "course_resolution": {"course_id": "101",
                                            "confidence": 1.0,
                                            "user_confirmed": True}})
    assert session.calls == []
    assert "announcement" in str(info.value)
    assert "Nothing was sent" in str(info.value)


def test_a_dry_run_of_the_approved_announcement_is_refused():
    name, method, path = CREATE
    params = {"course_id": "101"}
    entry = _entry(CREATE, {"body": dict(BODY)})
    op_id = str(uuid.uuid4())
    subject = admission.request_subject(entry, params)
    target = {"course_id": "101", "course_name": "Bio 101"}
    plan = ex.FrozenPlan({
        "op_id": op_id, "entry_name": name, "params": params,
        "before_state_digest": "none", "frozen_readback": "course 101",
        "target_identity": target, "request": subject,
        "request_digest": admission.request_digest(subject)}, "test-plan")
    record = admission.mint_approval(entry, params, tenant_base=BASE,
                                     target_identity=target)
    signed = admission.sign_approval(record, "yes", channel="educator-chat")
    with pytest.raises(admission.NeverDispatch):
        ex.dispatch_catalog_op(
            name, method, path, "write", params=params,
            extra={"body": dict(BODY)}, approval=signed, session=_Session(),
            plan=plan, op_id=op_id, dry_run=True)


# -- 2 ------------------------------------------------------------------------

@pytest.mark.parametrize("op,extra", [
    (CREATE, {"body": {"title": "x", "is_announcement": True}}),
    (CREATE, {"body": {"title": "x", "is_announcement": "true"}}),
    (CREATE, {"body": {"title": "x", "is_announcement": "1"}}),
    (CREATE, {"body": {"title": "x", "is_announcement": 1}}),
    (CREATE, {"body": {"title": "x", "is_announcement": "on"}}),
    (CREATE, {"body": {"title": "x", "is_announcement": "params.flag"}}),
    (CREATE, {"body": {"discussion_topic": {"is_announcement": True}}}),
    (CREATE, {"body": {"discussion_topic[is_announcement]": "1"}}),
    (CREATE, {"body": "title=x&is_announcement=1"}),
    (CREATE, {"body": '{"title": "x", "is_announcement": true}'}),
    (CREATE, {"query": {"is_announcement": "true"}}),
    (CREATE, {"query": "is_announcement=yes"}),
    (UPDATE, {"body": {"is_announcement": True}}),
])
def test_every_form_of_the_announcement_flag_is_refused(op, extra):
    entry = _entry(op, extra)
    with pytest.raises(admission.NeverDispatch):
        admission.check_policy_gates(entry, vault_ready=True)


def test_the_flag_in_a_manifest_url_or_a_multi_step_block_is_refused():
    entry = _entry(CREATE)
    entry["request"]["url"] += "?is_announcement=1"
    with pytest.raises(admission.NeverDispatch):
        admission.check_never_dispatch(entry, admission.load_policy())
    entry = _entry(CREATE)
    entry["multi_step"] = [{"method": "PUT", "url": entry["request"]["url"],
                            "body": {"is_announcement": True}}]
    with pytest.raises(admission.NeverDispatch):
        admission.check_never_dispatch(entry, admission.load_policy())


@pytest.mark.parametrize("value", [False, "false", 0, "0", None, "", "off"])
def test_a_flag_set_to_false_is_not_an_announcement(value):
    entry = _entry(CREATE, {"body": {"title": "x",
                                     "is_announcement": value}})
    admission.check_never_dispatch(entry, admission.load_policy())


def test_announcement_text_inside_content_is_not_a_flag():
    entry = _entry(("canvas_update_create_page_courses", "PUT",
                    "/api/v1/courses/{course_id}/pages/{url_or_id}"),
                   {"body": {"wiki_page": {
                       "body": "<p>Set is_announcement=true to post one.</p>"}}})
    admission.check_never_dispatch(entry, admission.load_policy())


# -- 3 ------------------------------------------------------------------------

def test_an_announcement_feed_is_refused():
    with pytest.raises(admission.NeverDispatch):
        admission.check_policy_gates(
            _entry(FEED, {"body": {"url": "https://example.edu/rss"}}),
            vault_ready=True)


def test_deleting_a_feed_is_not_refused_as_an_announcement():
    entry = ex.catalog_descriptor_to_entry(
        "canvas_delete_external_feed_courses", "DELETE",
        "/api/v1/courses/{course_id}/external_feeds/{external_feed_id}",
        "write")
    admission.check_never_dispatch(entry, admission.load_policy())


# -- 4 ------------------------------------------------------------------------

@pytest.mark.parametrize("op", [CREATE, UPDATE, DELETE, DATES])
def test_discussion_writes_are_held_even_where_student_data_works(op):
    body = {"body": {"title": "Week 1"}} if op[1] != "DELETE" else None
    with pytest.raises(admission.EvidenceHold):
        admission.check_policy_gates(_entry(op, body), vault_ready=True)
    name, method, path = op
    with pytest.raises(admission.EvidenceHold):
        ex._catalog_provenance_gate(
            _entry(op, body), name, method, path, {"course_id": "101"},
            "canvas", None, False,
            SimpleNamespace(browser_owned_auth=True))


def test_the_policy_says_why_each_discussion_write_is_held():
    holds = admission.load_policy()["evidence_holds"]
    for name in (CREATE[0], UPDATE[0], DELETE[0], DATES[0]):
        assert name in holds["tool_names"], name
        assert "Chromium" in holds["reasons"][name], name


# -- 5 ------------------------------------------------------------------------

def _translated(operation, exc):
    from failures.translator import translate
    return translate(operation, exc)


def test_an_announcement_refusal_is_explained_in_plain_words():
    entry = _entry(CREATE, {"body": dict(BODY)})
    with pytest.raises(admission.NeverDispatch) as info:
        admission.check_never_dispatch(entry, admission.load_policy())
    tr = _translated("post an announcement to course 101", info.value)
    assert tr.mode_id == "never-dispatch", tr.mode_id
    text = tr.agent_message
    assert "post an announcement to course 101" in text
    assert "nothing was sent" in text.lower()
    assert "New Quiz" not in text


def test_a_discussion_hold_is_not_described_as_a_new_quiz():
    with pytest.raises(admission.EvidenceHold) as info:
        admission.check_policy_gates(
            _entry(UPDATE, {"body": {"title": "Week 1"}}), vault_ready=True)
    tr = _translated("rename a discussion in course 101", info.value)
    assert tr.mode_id == "evidence-hold", tr.mode_id
    assert "New Quiz" not in tr.agent_message
    assert "rename a discussion in course 101" in tr.agent_message
    assert json.dumps(tr.agent_message).count("\\u2014") == 0
