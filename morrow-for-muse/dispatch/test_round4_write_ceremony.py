#!/usr/bin/env python3
"""The Plan approval covers exactly what is sent, and the Plan write
path works from the typed interface alone.

Failure modes this suite pins down (written before the fix; round-4
audit 2026-09-22, probes audit-muse4/body_bind.py, body_bind2.py,
minlen.py):
  H1. op_digest_of bound the op name, params, tenant, and category, but
      not the request body. An approval the educator gave for body A
      admitted (and sent) body B. The approval display said "exactly
      what will be sent" and never showed the body. reverify_approval
      at the complete phase could not see a changed body either.
  M1. A 20-character minimum refused "Yes" as an approval citation
      (sign_approval, the identity citation, the gate, the reauth
      re-approval, the edit grant). A non-empty verbatim educator
      reply bound to the digest is enough.
  M4. The Plan write path could not be done from SKILL.md alone:
      --course-resolution and the frozen-plan fields were undocumented
      and the executor raised CourseResolutionRequired. The typed
      interface must build the frozen plan and the course resolution
      itself: plan-write shows the educator the exact write (course
      name read from Canvas), approve-write signs their reply and
      sends it in one call.
  L2. A proven declared-verify mismatch raised a plain
      VerificationFailed that no catalog entry matched ("unknown").
  L5. The destructive-confirmation copy asked the educator to say what
      will be destroyed; the agent states it and asks for a yes.

Hermetic: fake provider session; journal, approvals, settings, and the
signing key live in pytest's tmp_path.
"""

import contextlib
import io
import json
import os
import sys
import uuid

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (TREE, os.path.join(TREE, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from dispatch import executor as ex  # noqa: E402
import dispatch.admission as admission_mod  # noqa: E402
from dispatch.admission import (  # noqa: E402
    ApprovalMismatch, mint_approval, sign_approval)
from dispatch import approval_display  # noqa: E402
from dispatch.test_direct_lane_hardening import (  # noqa: E402,F401
    BASE, FakeSession, _pack, hermetic)

NAME = "canvas_update_create_page_courses"
METHOD = "PUT"
PATH = "/api/v1/courses/{course_id}/pages/{url_or_id}"
PARAMS = {"course_id": "101", "url_or_id": "week-1"}
APPROVED_BODY = {"wiki_page": {"title": "Week 1 Overview"}}
CHANGED_BODY = {"wiki_page": {"title": "Week 1 Overview",
                              "body": "<p>Injected content</p>",
                              "published": False}}
TARGET = {"course_id": "101", "course_name": "Bio 101"}
USER = "muse:t@school.edu"
CONV = "conv-r4"


@pytest.fixture(autouse=True)
def hermetic_keys(hermetic, monkeypatch):
    monkeypatch.setattr(admission_mod, "SECRETS_DIR",
                        str(hermetic / "secrets"))
    monkeypatch.setattr(admission_mod, "SIGNING_KEY_PATH",
                        str(hermetic / "secrets" / "approval-signing.key"))
    monkeypatch.delenv("MORROW_APPROVAL_SIGNING_KEY", raising=False)
    monkeypatch.delenv("MORROW_USER_ID", raising=False)
    monkeypatch.delenv("MORROW_CONVERSATION_ID", raising=False)
    yield hermetic


def _entry(body):
    return ex.catalog_descriptor_to_entry(NAME, METHOD, PATH, "write",
                                          extra={"body": body})


def _signed(body, words="Yes, rename the Week 1 page title."):
    rec = mint_approval(_entry(body), PARAMS, BASE, target_identity=TARGET)
    return sign_approval(rec, words, channel="educator-chat")


def _plan(hermetic, op_id):
    path = hermetic / ("plan-%s.json" % op_id)
    path.write_text(json.dumps({
        "op_id": op_id, "entry_name": NAME, "params": PARAMS,
        "before_state_digest": "",
        "frozen_readback": {"course_id": 101, "name": "Bio 101"},
        "target_identity": TARGET}))
    return ex.load_frozen_plan(str(path), NAME)


def _canvas(stored_body=None):
    """Fake Canvas: course 101 is Bio 101; the page reads back whatever
    the last PUT stored."""
    state = {"page": {"url": "week-1", "title": "Old title",
                      "published": True}}

    def handler(method, url, body):
        if method == "GET" and url.rstrip("/").endswith("/courses/101"):
            return 200, {}, json.dumps(
                {"id": 101, "name": "Bio 101"}).encode()
        if "/pages/" in url and method == "GET":
            return 200, {}, json.dumps(state["page"]).encode()
        if "/pages/" in url and method == "PUT":
            sent = json.loads(body.decode()) if body else {}
            state["page"].update(sent.get("wiki_page") or {})
            return 200, {}, json.dumps(state["page"]).encode()
        return 404, {}, b"{}"
    return handler


def _writes(session):
    return [c for c in session.calls if c[0] in ("PUT", "POST", "DELETE")]


# ---------------------------------------------------------------- H1 --

def test_approved_body_is_admitted_and_sent(hermetic):
    op_id = str(uuid.uuid4())
    session = FakeSession(_canvas())
    out = ex.dispatch_catalog_op(
        NAME, METHOD, PATH, "write", PARAMS, plan=_plan(hermetic, op_id),
        op_id=op_id, extra={"body": APPROVED_BODY},
        approval=_signed(APPROVED_BODY), session=session, pack=_pack())
    assert out["outcome"] == "verified"
    assert len(_writes(session)) == 1


def test_changed_body_after_approval_is_refused(hermetic):
    op_id = str(uuid.uuid4())
    session = FakeSession(_canvas())
    with pytest.raises(ApprovalMismatch):
        ex.dispatch_catalog_op(
            NAME, METHOD, PATH, "write", PARAMS,
            plan=_plan(hermetic, op_id), op_id=op_id,
            extra={"body": CHANGED_BODY},
            approval=_signed(APPROVED_BODY), session=session, pack=_pack())
    assert _writes(session) == []


def test_changed_body_refused_in_dry_run(hermetic):
    op_id = str(uuid.uuid4())
    with pytest.raises(ApprovalMismatch):
        ex.dispatch_catalog_op(
            NAME, METHOD, PATH, "write", PARAMS,
            plan=_plan(hermetic, op_id), op_id=op_id,
            extra={"body": CHANGED_BODY},
            approval=_signed(APPROVED_BODY), session=FakeSession(),
            pack=_pack(), dry_run=True)


def test_digest_binds_method_path_query_and_body():
    base = mint_approval(_entry(APPROVED_BODY), PARAMS, BASE)
    changed_body = mint_approval(_entry(CHANGED_BODY), PARAMS, BASE)
    assert base["op_digest"] != changed_body["op_digest"]
    with_query = ex.catalog_descriptor_to_entry(
        NAME, METHOD, PATH, "write",
        extra={"body": APPROVED_BODY, "query": {"x": "1"}})
    assert mint_approval(with_query, PARAMS, BASE)["op_digest"] \
        != base["op_digest"]
    subject = base["request"]
    assert subject["method"] == "PUT"
    assert subject["path"] == "/api/v1/courses/101/pages/week-1"
    assert subject["body"] == APPROVED_BODY
    assert base["request_digest"] == admission_mod.request_digest(subject)


def test_body_param_references_are_shown_resolved():
    entry = _entry({"wiki_page": {"title": "params.title"}})
    params = dict(PARAMS, title="From params")
    rec = mint_approval(entry, params, BASE)
    assert rec["request"]["body"] == {"wiki_page": {"title": "From params"}}


def test_display_shows_the_exact_body_method_and_path():
    entry = _entry(CHANGED_BODY)
    rec = mint_approval(entry, PARAMS, BASE, target_identity=TARGET)
    text = approval_display.render_approval_display(rec, PARAMS,
                                                    entry=entry)
    assert "Injected content" in text
    assert "PUT /api/v1/courses/101/pages/week-1" in text
    assert "Bio 101" in text
    shown = approval_display.approval_display_dict(rec, PARAMS, entry=entry)
    assert shown["request"]["body"] == CHANGED_BODY


def test_display_of_a_record_whose_request_was_edited_is_refused():
    """The display must show what the digest binds: a record whose
    request block no longer matches its request_digest is not shown as
    if it were the payload."""
    rec = mint_approval(_entry(APPROVED_BODY), PARAMS, BASE)
    rec["request"]["body"] = CHANGED_BODY
    with pytest.raises(ValueError):
        approval_display.render_approval_display(rec, PARAMS)


def test_reverify_refuses_a_changed_body(hermetic):
    op_id = str(uuid.uuid4())
    ex.dispatch_catalog_op(
        NAME, METHOD, PATH, "write", PARAMS, plan=_plan(hermetic, op_id),
        op_id=op_id, extra={"body": APPROVED_BODY},
        approval=_signed(APPROVED_BODY), session=FakeSession(_canvas()),
        pack=_pack())
    ok = admission_mod.reverify_approval(_entry(APPROVED_BODY), PARAMS,
                                         BASE, op_id)
    assert ok["op_digest"]
    with pytest.raises(ApprovalMismatch):
        admission_mod.reverify_approval(_entry(CHANGED_BODY), PARAMS,
                                        BASE, op_id)


def test_frozen_plan_bound_to_another_request_is_refused(hermetic):
    """A new-style frozen plan records the request it was built for; a
    dispatch of a different request under that plan is refused even
    when the approval matches the dispatch."""
    op_id = str(uuid.uuid4())
    path = hermetic / "plan-bound.json"
    subject = admission_mod.request_subject(_entry(APPROVED_BODY), PARAMS)
    path.write_text(json.dumps({
        "op_id": op_id, "entry_name": NAME, "params": PARAMS,
        "before_state_digest": "",
        "frozen_readback": {"course_id": 101, "name": "Bio 101"},
        "target_identity": TARGET,
        "request": subject,
        "request_digest": admission_mod.request_digest(subject)}))
    plan = ex.load_frozen_plan(str(path), NAME)
    session = FakeSession(_canvas())
    with pytest.raises(ex.MissingFrozenPlan):
        ex.dispatch_catalog_op(
            NAME, METHOD, PATH, "write", PARAMS, plan=plan, op_id=op_id,
            extra={"body": CHANGED_BODY}, approval=_signed(CHANGED_BODY),
            session=session, pack=_pack())
    assert _writes(session) == []


# ---------------------------------------------------------------- M1 --

@pytest.mark.parametrize("words", ["Yes", "ok", "Yes, go ahead."])
def test_short_educator_reply_signs_and_admits(hermetic, words):
    op_id = str(uuid.uuid4())
    session = FakeSession(_canvas())
    out = ex.dispatch_catalog_op(
        NAME, METHOD, PATH, "write", PARAMS, plan=_plan(hermetic, op_id),
        op_id=op_id, extra={"body": APPROVED_BODY},
        approval=_signed(APPROVED_BODY, words), session=session,
        pack=_pack())
    assert out["outcome"] == "verified"


@pytest.mark.parametrize("words", ["", "   ", None])
def test_empty_citation_is_refused(words):
    rec = mint_approval(_entry(APPROVED_BODY), PARAMS, BASE)
    with pytest.raises(ValueError):
        sign_approval(rec, words, channel="educator-chat")


def test_short_identity_citation_is_enough():
    entry = _entry(APPROVED_BODY)
    params = dict(PARAMS, student="lrn_" + "a" * 20)
    rec = mint_approval(entry, params, BASE, target_identity=TARGET)
    signed = sign_approval(
        rec, "Yes", channel="educator-chat",
        resolved_identities=[{"token": "lrn_" + "a" * 20,
                              "displayed_as": "Ada"}],
        identity_authorization="Ada")
    assert signed["identity_authorization"] == "Ada"
    rec2 = mint_approval(entry, params, BASE, target_identity=TARGET)
    with pytest.raises(ValueError):
        sign_approval(rec2, "Yes", channel="educator-chat",
                      resolved_identities=[{"token": "lrn_" + "a" * 20,
                                            "displayed_as": "Ada"}],
                      identity_authorization="  ")


def test_reauth_reapproval_accepts_a_short_reply():
    from reauth import state_machine as sm
    # No such op awaiting approval: the call returns False instead of
    # refusing the educator's words for being short.
    assert sm.approve_op(str(uuid.uuid4()), "yes please") is False
    with pytest.raises(ValueError):
        sm.approve_op(str(uuid.uuid4()), "  ")


def test_edit_grant_accepts_a_short_reply():
    from modes import state as ms
    grant = ms.request_edit_grant(
        USER, "conversation",
        {"by": "educator", "authorization": "Yes",
         "channel": "educator-chat"}, conversation_id=CONV)
    assert grant["educator_identity"]["authorization"] == "Yes"


def test_ceremony_doc_matches_the_code():
    with open(os.path.join(TREE, "dispatch", "approval-ceremony.md"),
              encoding="utf-8") as fh:
        doc = fh.read()
    assert ">= 20" not in doc and "20 char" not in doc
    assert "citation length" not in doc
    assert "One signature covers the action AND the identity schedule" \
        not in doc
    assert "identity_authorization" in doc
    for path in ("SKILL.md", "modes/README.md"):
        with open(os.path.join(TREE, path), encoding="utf-8") as fh:
            text = fh.read()
        assert "at least 20" not in text and ">= 20 chars" not in text, path


# ---------------------------------------------------------------- M4 --

def _cli(argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        try:
            code = ex.main(argv)
        except SystemExit as exc:
            code = exc.code
        except Exception as exc:  # noqa: BLE001 - the CLI exits 2
            return 2, "%s: %s" % (type(exc).__name__, exc)
    return code, out.getvalue()


def _fake_store(monkeypatch, session):
    monkeypatch.setattr(ex.SessionStore, "load",
                        classmethod(lambda cls, path=None: session))


def _plan_write_argv(body):
    return ["plan-write", "--name", NAME, "--method", METHOD,
            "--path", PATH, "--params", json.dumps(PARAMS),
            "--body", json.dumps(body), "--backend", "https",
            "--user-id", USER, "--conversation-id", CONV]


def test_documented_plan_write_flow_end_to_end(monkeypatch):
    """SKILL.md's Plan write flow, exactly as documented: plan-write
    shows the write (course name read from Canvas), the educator
    replies, approve-write signs that reply and sends the write."""
    session = FakeSession(_canvas())
    _fake_store(monkeypatch, session)
    code, out = _cli(_plan_write_argv(APPROVED_BODY))
    assert code == 0, out
    prepared = json.loads(out)
    assert prepared["course"]["name"] == "Bio 101"
    assert "Bio 101" in prepared["approval_display"]
    assert "Week 1 Overview" in prepared["approval_display"]
    assert _writes(session) == []
    code, out = _cli(["approve-write", "--op-id", prepared["op_id"],
                      "--authorization", "Yes", "--backend", "https",
                      "--user-id", USER, "--conversation-id", CONV])
    assert code == 0, out
    result = json.loads(out)
    assert result["outcome"] == "verified"
    writes = _writes(session)
    assert len(writes) == 1
    assert json.loads(writes[0][3].decode()) == APPROVED_BODY
    # Single use: the same prepared write cannot be sent twice.
    code, out = _cli(["approve-write", "--op-id", prepared["op_id"],
                      "--authorization", "Yes", "--backend", "https",
                      "--user-id", USER, "--conversation-id", CONV])
    assert code != 0
    assert len(_writes(session)) == 1


def test_prepared_write_edited_after_display_is_refused(monkeypatch,
                                                         hermetic):
    session = FakeSession(_canvas())
    _fake_store(monkeypatch, session)
    code, out = _cli(_plan_write_argv(APPROVED_BODY))
    assert code == 0, out
    op_id = json.loads(out)["op_id"]
    pending = ex.pending_write_path(op_id)
    doc = json.loads(open(pending, encoding="utf-8").read())
    doc["descriptor"]["body"] = CHANGED_BODY
    with open(pending, "w", encoding="utf-8") as fh:
        json.dump(doc, fh)
    code, out = _cli(["approve-write", "--op-id", op_id,
                      "--authorization", "Yes", "--backend", "https",
                      "--user-id", USER, "--conversation-id", CONV])
    assert code != 0
    assert _writes(session) == []


def test_plan_write_on_a_missing_course_prepares_nothing(monkeypatch):
    session = FakeSession(lambda m, u, b: (404, {}, b"{}"))
    _fake_store(monkeypatch, session)
    code, out = _cli(_plan_write_argv(APPROVED_BODY))
    assert code != 0
    assert _writes(session) == []


def test_skill_md_documents_the_plan_write_flow():
    with open(os.path.join(TREE, "SKILL.md"), encoding="utf-8") as fh:
        text = fh.read()
    for needle in ("executor.py plan-write", "executor.py approve-write",
                   "--authorization", "approval_display"):
        assert needle in text, needle


# ---------------------------------------------------------- L2 / L5 --

def test_proven_verify_mismatch_has_a_catalog_entry():
    from failures import translate
    exc = ex.VerificationFailed(
        "verify block failed for op x: readback title is 'A', "
        "expected 'B' (journaled as failed)")
    translated = translate("update a page", exc)
    assert translated.mode_id == "write-readback-mismatch"
    assert "did not" in translated.agent_message
    assert "—" not in translated.agent_message


def test_destructive_copy_has_the_agent_state_what_is_destroyed():
    from failures import load_catalog
    entry = load_catalog().get("destructive_write_confirmation_required")
    msg = entry["agent_message"]
    assert "tell me plainly what will be destroyed" not in msg
    assert "I will tell you exactly what will be destroyed" in msg
    assert "—" not in msg
