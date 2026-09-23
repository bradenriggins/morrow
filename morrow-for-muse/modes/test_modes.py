#!/usr/bin/env python3
"""Unit tests for the modes/ package (Workstream A, revised model).

Covers: blanket grant flow, self-promotion refusal, legacy timed grants
lapsing to plan, switch-to-plan turning edit off everywhere, standing default via settings, ambiguous-course
refusal, high-confidence course write admitted in edit mode without
approval, conversation grants, supersede, tamper-evidence, the
settings fallback, and the dispatch/admission.py check_mode_authority
hook.

Synthetic only: no live writes, no browser. Test state roots live under
modes/.test-state/ (never /tmp) and are removed after the session.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import types
from datetime import datetime, timedelta, timezone

import pytest

_TREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE_ROOT not in sys.path:
    sys.path.insert(0, _TREE_ROOT)
MODES_DIR = os.path.dirname(os.path.abspath(__file__))

from modes import state as mode_state  # noqa: E402
from modes import errors as mode_errors  # noqa: E402
from dispatch import admission  # noqa: E402


def _uid(name):
    """Filesystem-safe per-test user id."""
    clean = re.sub(r"[^A-Za-z0-9_.:@-]", "_", name)[:80]
    return "test-%s" % clean


@pytest.fixture(scope="session", autouse=True)
def _morrow_home():
    root = os.path.join(MODES_DIR, ".test-state", "pid-%d" % os.getpid())
    shutil.rmtree(root, ignore_errors=True)
    os.makedirs(root, exist_ok=True)
    old = os.environ.get("MORROW_HOME")
    os.environ["MORROW_HOME"] = root
    # Hermetic signing key: dispatch.admission freezes
    # SECRETS_DIR/SIGNING_KEY_PATH at import time, so point both at this
    # test session's home (tree convention: tests override the module
    # constants directly).
    import dispatch.admission as _adm
    old_secrets = _adm.SECRETS_DIR
    old_key = _adm.SIGNING_KEY_PATH
    _adm.SECRETS_DIR = os.path.join(root, "secrets")
    _adm.SIGNING_KEY_PATH = os.path.join(root, "secrets",
                                         "approval-signing.key")
    try:
        yield
    finally:
        _adm.SECRETS_DIR = old_secrets
        _adm.SIGNING_KEY_PATH = old_key
        if old is None:
            os.environ.pop("MORROW_HOME", None)
        else:
            os.environ["MORROW_HOME"] = old
        shutil.rmtree(root, ignore_errors=True)


@pytest.fixture
def fake_settings():
    """Inject a fake settings.store through sys.modules (Agent B contract)."""
    store = {}

    def get_setting(user_id, key):
        return store.get((user_id, key))

    def set_setting(user_id, key, value, educator_confirmed=False,
                    educator=None):
        store[(user_id, key)] = value

    mod = types.ModuleType("settings.store")
    mod.get_setting = get_setting
    mod.set_setting = set_setting
    pkg = types.ModuleType("settings")
    pkg.__path__ = []
    # Save the real modules so teardown restores them: merely popping
    # would make the next "from settings.store import ..." re-import a
    # FRESH copy of the real store.py, splitting its module state (and
    # exception classes) in two for any later test in this process.
    saved = {}
    for name in ("settings", "settings.store"):
        if name in sys.modules:
            saved[name] = sys.modules[name]
    sys.modules["settings"] = pkg
    sys.modules["settings.store"] = mod
    try:
        yield store
    finally:
        sys.modules.pop("settings.store", None)
        sys.modules.pop("settings", None)
        sys.modules.update(saved)


@pytest.fixture
def no_settings():
    """Ensure no settings module is importable (fallback path)."""
    saved = {}
    for name in ("settings", "settings.store"):
        if name in sys.modules:
            saved[name] = sys.modules.pop(name)
    # Also block a real settings package on sys.path, if one ever lands.
    import builtins
    real_import = builtins.__import__

    def guarded(name, *args, **kwargs):
        if name == "settings.store" or name == "settings":
            raise ImportError("no settings module (test fallback)")
        return real_import(name, *args, **kwargs)

    builtins.__import__ = guarded
    try:
        yield
    finally:
        builtins.__import__ = real_import
        sys.modules.update(saved)


def _confirmation(utterance="please use edit mode for my courses",
                  by="educator", channel="driver"):
    conf = {"authorization": utterance, "channel": channel}
    if by is not None:
        conf["by"] = by
    return conf


def _write_entry():
    return {"name": "canvas_create_assignment", "effects": "write",
            "provider": "canvas"}


def _plant_legacy_timed_grant(user_id, expires_in_min=60):
    """Persist a timed grant the way an older install wrote it."""
    from dispatch.admission import _seal_record
    state = mode_state._load_state(user_id)
    state["revision"] = int(state.get("revision", 0)) + 1
    now = datetime.now(timezone.utc)
    grant = {
        "grant_id": "legacy-%d" % state["revision"],
        "revision": state["revision"],
        "scope_type": "timed",
        "conversation_id": None,
        "educator_identity": {"by": "educator", "channel": "driver",
                              "authorization": "edit for an hour please"},
        "source_utterance": "edit for an hour please",
        "granted_at": now.isoformat(),
        "expires_at": (now + timedelta(minutes=expires_in_min)).isoformat(),
        "duration_min": 60,
        "revoked": False, "revoked_at": None, "revoke_reason": None,
    }
    state["grants"].append(grant)
    state.pop("sig", None)
    path = mode_state._grants_path(user_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(_seal_record(state), f, indent=2, sort_keys=True)
    return grant


def _journal_events():
    """All mode.* journal events in this session's tree journal."""
    from dispatch import executor as _ex
    path = _ex.JOURNAL_PATH
    events = []
    if not os.path.exists(path):
        return events
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            if str(rec.get("event", "")).startswith("mode."):
                events.append(rec)
    return events


# ---------------------------------------------------------------------------
# Grant flow
# ---------------------------------------------------------------------------

def test_blanket_grant_flow(no_settings):
    uid = _uid("blanket")
    assert mode_state.current_mode(uid) == "plan"
    grant = mode_state.request_edit_grant(
        uid, educator_confirmation=_confirmation(
            "use edit mode for my biology course"))
    assert grant["grant_id"]
    assert grant["scope_type"] == "conversation"
    assert grant["expires_at"] is None
    assert grant["revoked"] is False
    assert grant["educator_identity"]["by"] == "educator"
    assert "courses" not in grant and "categories" not in grant
    assert mode_state.current_mode(uid) == "edit"
    decision, code = mode_state.check_write_authority(uid, course_id="123")
    assert (decision, code) == ("allow", "ok")


def test_self_promotion_refused_missing_confirmation(no_settings):
    uid = _uid("selfpromo-missing")
    with pytest.raises(mode_errors.ModeSelfGrantRefused):
        mode_state.request_edit_grant(uid, educator_confirmation=None)
    with pytest.raises(mode_errors.ModeSelfGrantRefused):
        mode_state.request_edit_grant(uid, educator_confirmation={})
    assert mode_state.current_mode(uid) == "plan"


def test_self_promotion_refused_non_educator(no_settings):
    uid = _uid("selfpromo-agent")
    with pytest.raises(mode_errors.ModeSelfGrantRefused):
        mode_state.request_edit_grant(
            uid, educator_confirmation=_confirmation(by="agent"))
    # Round-4 M1: an empty citation is refused; any non-empty verbatim
    # reply ("yes") is a valid educator citation.
    with pytest.raises(mode_errors.ModeSelfGrantRefused):
        mode_state.request_edit_grant(
            uid, educator_confirmation=_confirmation("   "))
    assert mode_state.current_mode(uid) == "plan"


def test_switch_to_edit_is_self_promotion(no_settings):
    uid = _uid("switch-edit")
    with pytest.raises(mode_errors.ModeSelfGrantRefused):
        mode_state.switch_mode(uid, "edit")
    with pytest.raises(mode_errors.ModeSelfGrantRefused):
        mode_state.switch_mode(uid, "banana")


def test_invalid_scope_type_and_user_id(no_settings):
    uid = _uid("bad-scope")
    for scope in ("standing", "timed"):
        with pytest.raises(ValueError):
            mode_state.request_edit_grant(
                uid, scope_type=scope,
                educator_confirmation=_confirmation())
    with pytest.raises(ValueError):
        mode_state.request_edit_grant(
            "../../evil", educator_confirmation=_confirmation())
    with pytest.raises(ValueError):
        mode_state.current_mode("")


# ---------------------------------------------------------------------------
# Expiry and revocation
# ---------------------------------------------------------------------------

def test_edit_mode_is_not_timed(no_settings):
    for name in ("edit_session_remaining", "DEFAULT_GRANT_DURATION_MIN",
                 "MAX_GRANT_DURATION_MIN"):
        assert not hasattr(mode_state, name), name
    assert "duration_min" not in __import__("inspect").signature(
        mode_state.request_edit_grant).parameters


def test_legacy_timed_grant_lapses_to_plan(no_settings):
    # A timed grant persisted by an older install, still inside its
    # window, must not hold edit on: it lapses to plan, where a write
    # asks for approval (never a refusal, never a standing grant).
    uid = _uid("legacy-timed")
    _plant_legacy_timed_grant(uid)
    assert mode_state.current_mode(uid) == "plan"
    decision, code = mode_state.check_write_authority(uid, course_id="1")
    assert (decision, code) == ("defer", "plan_mode_approval_required")
    with pytest.raises(mode_errors.PlanModeWriteWithoutApproval):
        admission.check_mode_authority(
            _write_entry(), {"course_id": "1"}, None, {"user_id": uid})


def test_legacy_timed_grant_does_not_become_standing(fake_settings):
    uid = _uid("legacy-timed-standing")
    fake_settings[(uid, "default_mode")] = "plan"
    _plant_legacy_timed_grant(uid)
    assert mode_state.current_mode(uid) == "plan"
    assert fake_settings[(uid, "default_mode")] == "plan"


def test_revocation_on_switch_to_plan_asks_for_approval(no_settings):
    # After a grant ends, a write is a normal plan-mode write: it asks
    # for approval (and a signed approval can land). It is never
    # refused as grant_revoked.
    uid = _uid("switch-plan")
    mode_state.request_edit_grant(
        uid, educator_confirmation=_confirmation("use edit mode please"))
    assert mode_state.current_mode(uid) == "edit"
    result = mode_state.switch_mode(uid, "plan")
    assert result["revoked_grants"] == 1
    assert result["mode"] == "plan"
    assert mode_state.current_mode(uid) == "plan"
    decision, code = mode_state.check_write_authority(uid, course_id="1")
    assert (decision, code) == ("defer", "plan_mode_approval_required")
    with pytest.raises(mode_errors.PlanModeWriteWithoutApproval):
        admission.check_mode_authority(
            _write_entry(), {"course_id": "1"}, None, {"user_id": uid})


def test_revoke_is_idempotent(no_settings):
    uid = _uid("revoke-idem")
    assert mode_state.revoke_edit_grant(uid, reason="nothing live") == 0
    mode_state.request_edit_grant(
        uid, educator_confirmation=_confirmation("use edit mode please"))
    assert mode_state.revoke_edit_grant(uid, reason="done") == 1
    assert mode_state.revoke_edit_grant(uid, reason="done") == 0


def test_conversation_grant_has_no_time_expiry(no_settings):
    uid = _uid("conversation")
    grant = mode_state.request_edit_grant(
        uid, scope_type="conversation",
        educator_confirmation=_confirmation("use edit mode for this conversation"))
    assert grant["expires_at"] is None
    assert mode_state.current_mode(uid) == "edit"
    decision, code = mode_state.check_write_authority(uid)
    assert (decision, code) == ("allow", "ok")
    assert mode_state.revoke_edit_grant(uid, reason="session ended") == 1
    assert mode_state.current_mode(uid) == "plan"


def test_new_grant_supersedes_live_one(no_settings):
    uid = _uid("supersede")
    first = mode_state.request_edit_grant(
        uid, educator_confirmation=_confirmation("use edit mode please"))
    second = mode_state.request_edit_grant(
        uid, educator_confirmation=_confirmation("use edit mode again please"))
    assert second["revision"] == first["revision"] + 1
    assert mode_state.current_mode(uid) == "edit"
    revocations = [e for e in _journal_events()
                   if e["event"] == "mode.grant_revoked"
                   and e.get("grant_id") == first["grant_id"]]
    assert revocations and "superseded" in revocations[0]["reason"]


# ---------------------------------------------------------------------------
# Standing default via settings
# ---------------------------------------------------------------------------

def test_standing_default_edit(fake_settings):
    uid = _uid("standing")
    fake_settings[(uid, "default_mode")] = "edit"
    assert mode_state.current_mode(uid) == "edit"
    decision, code = mode_state.check_write_authority(uid, course_id="9")
    assert (decision, code) == ("allow", "ok")
    audit, record = admission.check_mode_authority(
        _write_entry(), {"course_id": "9"}, None, {"user_id": uid})
    assert record is None
    assert audit["mode"] == "edit"
    assert audit["scope_type"] == "standing"


def test_standing_default_plan(fake_settings):
    uid = _uid("standing-plan")
    fake_settings[(uid, "default_mode")] = "plan"
    assert mode_state.current_mode(uid) == "plan"
    decision, code = mode_state.check_write_authority(uid)
    assert (decision, code) == ("defer", "plan_mode_approval_required")


def test_switch_to_plan_turns_edit_off_including_default(fake_settings):
    # "Switch to plan" must leave the educator in plan mode: it revokes
    # live grants AND turns the standing edit default off. Leaving the
    # default on edit while reporting plan was the defect.
    uid = _uid("switch-default")
    fake_settings[(uid, "default_mode")] = "edit"
    mode_state.request_edit_grant(
        uid, educator_confirmation=_confirmation("use edit mode please"))
    assert mode_state.current_mode(uid) == "edit"
    result = mode_state.switch_mode(uid, "plan")
    assert result["mode"] == "plan"
    assert result["revoked_grants"] == 1
    assert result["default_mode_changed"] is True
    assert fake_settings[(uid, "default_mode")] == "plan"
    assert mode_state.current_mode(uid) == "plan"
    decision, code = mode_state.check_write_authority(uid)
    assert (decision, code) == ("defer", "plan_mode_approval_required")


def test_invalid_default_mode_is_tamper(fake_settings):
    uid = _uid("bad-default")
    fake_settings[(uid, "default_mode")] = "superedit"
    with pytest.raises(mode_errors.ModeSettingsTamper) as excinfo:
        mode_state.current_mode(uid)
    assert excinfo.value.setting_name == "default_mode"


def test_no_settings_falls_back_safely(no_settings):
    uid = _uid("no-settings")
    assert mode_state.current_mode(uid) == "plan"
    mode_state.request_edit_grant(
        uid, educator_confirmation=_confirmation("use edit mode please"))
    result = mode_state.switch_mode(uid, "plan")
    assert result["mode"] == "plan"


# ---------------------------------------------------------------------------
# Ambiguous course
# ---------------------------------------------------------------------------

def _ambiguous_resolution():
    return {"course_id": "c1", "confidence": 0.42, "user_confirmed": False,
            "query": "Bio 101",
            "candidates_public": "Biology 101 (Fall), Biology 101 (Spring)"}


def test_ambiguous_course_refused_in_edit_mode(no_settings):
    uid = _uid("ambiguous")
    mode_state.request_edit_grant(
        uid, educator_confirmation=_confirmation("use edit mode please"))
    decision, code = mode_state.check_write_authority(
        uid, course_id="c1", resolution=_ambiguous_resolution())
    assert (decision, code) == ("refuse", "ambiguous_course")
    with pytest.raises(mode_errors.AmbiguousCourseWriteRefused) as excinfo:
        admission.check_mode_authority(
            _write_entry(), {"course_id": "c1"}, None,
            {"user_id": uid, "course_resolution": _ambiguous_resolution()})
    assert excinfo.value.query == "Bio 101"
    assert "Fall" in excinfo.value.candidates_public


def test_high_confidence_course_write_admitted_without_approval(no_settings):
    uid = _uid("highconf")
    grant = mode_state.request_edit_grant(
        uid, educator_confirmation=_confirmation("use edit mode please"))
    resolution = {"course_id": "c1", "confidence": 0.95,
                  "user_confirmed": False, "query": "Biology 101 section A"}
    decision, code = mode_state.check_write_authority(
        uid, course_id="c1", resolution=resolution)
    assert (decision, code) == ("allow", "ok")
    audit, record = admission.check_mode_authority(
        _write_entry(), {"course_id": "c1"}, None,
        {"user_id": uid, "course_resolution": resolution})
    assert record is None
    assert audit["mode"] == "edit"
    assert audit["grant_id"] == grant["grant_id"]


def test_user_confirmed_low_confidence_admitted(no_settings):
    uid = _uid("confirmed")
    mode_state.request_edit_grant(
        uid, educator_confirmation=_confirmation("use edit mode please"))
    resolution = {"course_id": "c1", "confidence": 0.2,
                  "user_confirmed": True}
    decision, code = mode_state.check_write_authority(
        uid, course_id="c1", resolution=resolution)
    assert (decision, code) == ("allow", "ok")


# ---------------------------------------------------------------------------
# Admission hook behavior
# ---------------------------------------------------------------------------

def test_plan_mode_wraps_approval_refusal_mode_aware(no_settings):
    # Plan mode defers to the legacy approval path; when it finds no
    # approval, the educator gets the mode-aware
    # PlanModeWriteWithoutApproval (which the failure funnel translates
    # to plan_mode_write_without_approval), with the legacy
    # WriteApprovalMissing kept as the cause.
    uid = _uid("plan-hook")
    with pytest.raises(mode_errors.PlanModeWriteWithoutApproval) as excinfo:
        admission.check_mode_authority(
            _write_entry(), {"course_id": "1"}, None, {"user_id": uid})
    assert isinstance(excinfo.value.__cause__, admission.WriteApprovalMissing)


def test_reads_untouched_by_mode_hook(no_settings):
    uid = _uid("reads")
    entry = {"name": "canvas_list_assignments", "effects": "read",
             "provider": "canvas"}
    assert admission.check_mode_authority(
        entry, {}, None, {"user_id": uid}) == (None, None)


def test_no_user_id_falls_back_to_approval_path(no_settings):
    with pytest.raises(admission.WriteApprovalMissing):
        admission.check_mode_authority(
            _write_entry(), {"course_id": "1"}, None, {})
    with pytest.raises(admission.WriteApprovalMissing):
        admission.check_mode_authority(
            _write_entry(), {"course_id": "1"}, None, None)


def test_admit_with_mode_ctx_routes_through_hook(no_settings):
    uid = _uid("admit-ctx")
    grant = mode_state.request_edit_grant(
        uid, educator_confirmation=_confirmation("use edit mode please"))
    audit, record = admission.admit(
        _write_entry(), {"course_id": "7"}, approval=None,
        mode_ctx={"user_id": uid})
    assert record is None
    assert audit["grant_id"] == grant["grant_id"]
    # Without mode_ctx the gate behaves exactly as before.
    with pytest.raises(admission.WriteApprovalMissing):
        admission.admit(_write_entry(), {"course_id": "7"}, approval=None)


def test_edit_write_usage_journaled(no_settings):
    uid = _uid("usage-journal")
    grant = mode_state.request_edit_grant(
        uid, educator_confirmation=_confirmation("use edit mode please"))
    admission.check_mode_authority(
        _write_entry(), {"course_id": "42"}, None,
        {"user_id": uid}, op_id="op-42")
    uses = [e for e in _journal_events()
            if e["event"] == "mode.write_admitted"
            and e.get("grant_id") == grant["grant_id"]]
    assert len(uses) == 1
    assert uses[0]["course_id"] == "42"
    # The gate decides before the executor claims the op id, so the
    # record names the op without reserving it (final sweep 2026-09-23).
    assert uses[0]["for_op_id"] == "op-42"
    assert "op_id" not in uses[0]
    assert uses[0]["educator_identity"]["by"] == "educator"
    assert "use edit mode please" in uses[0]["educator_identity"]["authorization"]


def test_grant_issued_journaled_with_educator_binding(no_settings):
    uid = _uid("issued-journal")
    grant = mode_state.request_edit_grant(
        uid, educator_confirmation=_confirmation("use edit mode for biology"))
    issued = [e for e in _journal_events()
              if e["event"] == "mode.grant_issued"
              and e.get("grant_id") == grant["grant_id"]]
    assert len(issued) == 1
    assert issued[0]["source_utterance"] == "use edit mode for biology"
    assert issued[0]["educator_identity"]["by"] == "educator"


# ---------------------------------------------------------------------------
# Tamper evidence
# ---------------------------------------------------------------------------

def test_tampered_grant_file_fails_closed(no_settings):
    uid = _uid("tamper")
    mode_state.request_edit_grant(
        uid, educator_confirmation=_confirmation("use edit mode please"))
    path = mode_state._grants_path(uid)
    with open(path, "r", encoding="utf-8") as f:
        state = json.load(f)
    state["grants"][0]["expires_at"] = "2999-01-01T00:00:00+00:00"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(state, f)
    with pytest.raises(mode_errors.ModeSettingsTamper):
        mode_state.current_mode(uid)
    with pytest.raises(mode_errors.ModeSettingsTamper):
        mode_state.check_write_authority(uid)
