#!/usr/bin/env python3
"""Dry-run journals nothing; undo is approved and gated as its own write.

Failure modes this suite pins down (written before the fix; re-audit
2026-09-22):
  M7. dry_run=True still journaled mode.write_admitted /
      mode.write_refused, because the mode gate ran (and journaled)
      before the dry-run return. The documented contract is that a dry
      run journals nothing.
  M6. The undo lane reused the forward write's approval digest (entry
      name + params + tenant), so the forward write's approval also
      admitted its undo; the undo target (from the caller's --result)
      was not bound to any approval; and destructiveness was checked on
      the forward request, so a DELETE undo of a POST create skipped
      confirm_destructive_writes in edit mode.

Third-pass re-audit 2026-09-22 (probe reaudit3/undo3.py), H1:
  - undos for result.id 42 and 999 showed identical approval screens:
    the DELETE URL and target id were never shown, only a hash;
  - the undo screen printed "Undo: NOT AVAILABLE";
  - the caller's --result was never checked against the journaled
    receipt of --of-op-id, so any target could be deleted under the
    name of an undo. The target must come ONLY from the journal.

Hermetic: fake provider session; journal, approvals, settings, and the
signing key live in pytest's tmp_path.
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
from dispatch.admission import mint_approval, sign_approval  # noqa: E402
from dispatch.test_direct_lane_hardening import (  # noqa: E402,F401
    BASE, FakeSession, _pack, hermetic)
from modes import errors as mode_errors  # noqa: E402

USER = "undo-educator"
CONV = "undo-conv"
AUTH = "yes, go ahead with exactly this change in this course"


@pytest.fixture(autouse=True)
def hermetic_keys(hermetic, monkeypatch):
    monkeypatch.setattr(admission_mod, "SECRETS_DIR",
                        str(hermetic / "secrets"))
    monkeypatch.setattr(admission_mod, "SIGNING_KEY_PATH",
                        str(hermetic / "secrets" / "approval-signing.key"))
    monkeypatch.delenv("MORROW_APPROVAL_SIGNING_KEY", raising=False)
    yield hermetic


def _journal_lines():
    try:
        with open(ex.JOURNAL_PATH, encoding="utf-8") as fh:
            return [json.loads(line) for line in fh if line.strip()]
    except FileNotFoundError:
        return []


def _events():
    return [r.get("event") for r in _journal_lines() if r.get("event")]


def _create_entry():
    entry = ex.catalog_descriptor_to_entry(
        "canvas_create_assignment", "POST",
        "/api/v1/courses/{course_id}/assignments",
        extra={"body": {"assignment": {"name": "A"}}})
    entry["undo"] = {"method": "DELETE",
                     "url": "{canvas_base}/api/v1/courses/{course_id}/"
                            "assignments/{result.id}"}
    return entry


def _ctx(**kw):
    ctx = {"user_id": USER, "conversation_id": CONV,
           "course_resolution": {"course_id": "7", "confidence": 1.0,
                                 "user_confirmed": True}}
    ctx.update(kw)
    return ctx


def _set(key, value):
    from settings import store
    store.set_setting(USER, key, value, educator_confirmed=True)


def _course_and(handler):
    def h(m, u, b):
        if m == "GET" and u.rstrip("/").endswith("/api/v1/courses/7"):
            return 200, {}, b'{"id": 7, "name": "Course"}'
        return handler(m, u, b)
    return h


# ---------------------------------------------------------------- M7 --

def test_dry_run_admitted_in_edit_mode_journals_nothing():
    _set("default_mode", "edit")
    out = ex.dispatch_entry(_create_entry(), {"course_id": "7"},
                            FakeSession(), _pack(), dry_run=True,
                            mode_ctx=_ctx())
    assert out["dry_run"] is True
    assert _journal_lines() == []


def test_dry_run_refused_in_plan_mode_journals_nothing():
    with pytest.raises(mode_errors.PlanModeWriteWithoutApproval):
        ex.dispatch_entry(_create_entry(), {"course_id": "7"},
                          FakeSession(), _pack(), dry_run=True,
                          mode_ctx=_ctx())
    assert _journal_lines() == []


def test_live_dispatch_still_journals_the_admission():
    _set("default_mode", "edit")
    sess = FakeSession(_course_and(
        lambda m, u, b: (200, {}, b'{"id": 42, "name": "A"}')))
    ex.dispatch_entry(_create_entry(), {"course_id": "7"}, sess, _pack(),
                      mode_ctx=_ctx())
    assert "mode.write_admitted" in _events()


# ---------------------------------------------------------------- M6 --

def _signed(entry, params):
    rec = mint_approval(entry, params, tenant_base=BASE,
                        target_identity={"course_id": "7",
                                         "course_name": "Course"})
    sign_approval(rec, AUTH, channel="driver")
    return rec


def _forward(entry, rid=42):
    """Journal a real forward create (edit mode) that returned id rid."""
    from settings import store
    before = store.get_setting(USER, "default_mode")
    _set("default_mode", "edit")
    body = json.dumps({"id": rid, "name": "A"}).encode()
    sess = FakeSession(_course_and(lambda m, u, b: (200, {}, body)))
    out = ex.dispatch_entry(entry, {"course_id": "7"}, sess, _pack(),
                            mode_ctx=_ctx())
    _set("default_mode", before)
    return out["op_id"]


def _undo(entry, result, approval=None, mode_ctx=None, dry_run=False,
          handler=None, of_op_id=None):
    if of_op_id is None:
        of_op_id = _forward(entry)
    sess = FakeSession(_course_and(
        handler or (lambda m, u, b: (200, {}, b'{"id": 42}'))))
    out = ex.dispatch_undo(entry, {"course_id": "7"}, result, of_op_id,
                           sess, _pack(), approval=approval,
                           dry_run=dry_run, require_educator_channel=False,
                           mode_ctx=mode_ctx)
    return out, sess


def test_forward_write_approval_does_not_admit_its_undo():
    entry = _create_entry()
    forward = _signed(entry, {"course_id": "7"})
    with pytest.raises(admission_mod.AdmissionRefused):
        _undo(entry, {"id": 42}, approval=forward, dry_run=True)


def test_undo_approval_is_bound_to_its_target():
    entry = _create_entry()
    of42 = _forward(entry, 42)
    of43 = _forward(entry, 43)
    u_entry, u_params = ex.undo_approval_subject(
        entry, {"course_id": "7"}, of42, {"id": 42})
    approval = _signed(u_entry, u_params)
    with pytest.raises(admission_mod.AdmissionRefused):
        _undo(entry, {}, approval=approval, dry_run=True, of_op_id=of43)


def test_undo_approval_for_its_own_target_admits_and_sends():
    entry = _create_entry()
    of42 = _forward(entry, 42)
    u_entry, u_params = ex.undo_approval_subject(
        entry, {"course_id": "7"}, of42, {"id": 42})
    approval = _signed(u_entry, u_params)
    out, sess = _undo(entry, {"id": 42}, approval=approval, of_op_id=of42)
    assert out["undo_of"] == of42
    sent = [(m, u) for m, u, _w, _b in sess.calls if m == "DELETE"]
    assert sent == [(
        "DELETE", BASE + "/api/v1/courses/7/assignments/42")]


def test_caller_result_that_disagrees_with_the_journal_is_refused():
    entry = _create_entry()
    of42 = _forward(entry, 42)
    with pytest.raises(ex.UndoTargetMismatch):
        ex.undo_approval_subject(entry, {"course_id": "7"}, of42,
                                 {"id": 999})
    _set("default_mode", "edit")
    with pytest.raises(ex.UndoTargetMismatch):
        _undo(entry, {"id": 999}, mode_ctx=_ctx(), of_op_id=of42)


def test_undo_target_comes_only_from_the_journal():
    entry = _create_entry()
    of42 = _forward(entry, 42)
    _set("default_mode", "edit")
    out, sess = _undo(entry, {}, mode_ctx=_ctx(), of_op_id=of42)
    sent = [(m, u) for m, u, _w, _b in sess.calls if m == "DELETE"]
    assert sent == [("DELETE", BASE + "/api/v1/courses/7/assignments/42")]


def test_undo_of_an_unjournaled_op_is_refused():
    entry = _create_entry()
    _forward(entry, 42)
    with pytest.raises(ex.UndoTargetMismatch):
        ex.undo_approval_subject(entry, {"course_id": "7"}, "never-ran",
                                 {"id": 42})
    _set("default_mode", "edit")
    with pytest.raises(ex.UndoTargetMismatch):
        _undo(entry, {"id": 42}, mode_ctx=_ctx(), of_op_id="never-ran")


def test_undo_of_another_entry_or_other_params_is_refused():
    entry = _create_entry()
    of42 = _forward(entry, 42)
    other = dict(entry, name="canvas_create_page")
    with pytest.raises(ex.UndoTargetMismatch):
        ex.undo_approval_subject(other, {"course_id": "7"}, of42, {})
    with pytest.raises(ex.UndoTargetMismatch):
        ex.undo_approval_subject(entry, {"course_id": "8"}, of42, {})


def test_undo_approval_screen_shows_method_url_and_target():
    from dispatch.approval_display import render_approval_display
    entry = _create_entry()
    screens = {}
    for rid in (42, 999):
        of = _forward(entry, rid)
        u_entry, u_params = ex.undo_approval_subject(
            entry, {"course_id": "7"}, of, {})
        rec = {"op": u_entry["name"], "category": "write",
               "target": {"course_id": "7"}}
        screens[rid] = render_approval_display(rec, u_params, u_entry)
    assert screens[42] != screens[999]
    for rid, text in screens.items():
        assert "DELETE" in text
        assert "/api/v1/courses/7/assignments/%d" % rid in text
        assert "NOT AVAILABLE" not in text
        assert "This approval IS an undo" in text


def test_delete_undo_needs_destructive_confirmation_in_edit_mode():
    _set("default_mode", "edit")
    _set("confirm_destructive_writes", True)
    entry = _create_entry()
    with pytest.raises(mode_errors.DestructiveConfirmationRequired):
        _undo(entry, {"id": 42}, mode_ctx=_ctx())
    out, sess = _undo(entry, {"id": 42},
                      mode_ctx=_ctx(destructive_confirmed=AUTH))
    assert any(m == "DELETE" for m, _u, _w, _b in sess.calls)


def test_undo_dry_run_journals_nothing():
    _set("default_mode", "edit")
    entry = _create_entry()
    of42 = _forward(entry, 42)
    before = _journal_lines()
    out, sess = _undo(entry, {"id": 42}, mode_ctx=_ctx(), dry_run=True,
                      of_op_id=of42)
    assert out["dry_run"] is True
    assert sess.calls == []
    assert _journal_lines() == before
