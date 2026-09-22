#!/usr/bin/env python3
"""Persistent per-educator settings store for Morrow for Muse (WORKSTREAM B).

Location: <MORROW_HOME>/settings/<user_id>.json. This is user space, so
settings survive tree restarts, reinstalls, and upgrades; they are never
stored inside the deploy tree. The MORROW_HOME env var is honored through
config.paths.morrow_home(), resolved at use time (never import time) so
tests can point it at scratch.

THE MODE MODEL (simple, by design): the ONLY difference between plan and
edit mode is whether writes surface approval to the educator. In plan
mode, writes require approval. In edit mode, they do not. Reads are
unrestricted, with no approval, in both modes.

Setting default_mode to "edit" IS the standing edit grant: it is
journaled, educator-confirmed, and plainly documented. There is no
separate grant machinery standing between the educator and edit mode;
the educator asked for default edit mode as a first-class choice.

Layers (most recent explicit educator action wins; resolved by the
single authoritative resolver modes.state.current_mode, which this
module's effective_mode delegates to):
  1. Per-conversation override ("use plan/edit mode for this
     conversation"): lasts for that conversation only, never persisted.
     Held in memory; modes consults it via get_conversation_override.
  2. Timed edit session (explicit duration request, e.g. "edit for
     30 minutes"): a modes timed grant, sealed
     and persisted under MORROW_HOME, journaled, bound to the
     conversation when one is given. Survives restarts inside its
     granted window; expiry still bounds it. Started only with educator
     confirmation; the agent can never grant itself a session.
     (Bare "use edit mode" is NOT timed; it sets default_mode="edit",
     standing with no expiry.)
  3. default_mode: the persisted default. Setting it to "edit" IS the
     standing edit grant: journaled, educator-confirmed, plainly
     documented.

Contract (modes/state.py, the mode authority):
    from modes.state import current_mode, check_write_authority
    mode = current_mode(user_id, conversation_id)   # "edit" | "plan"
    decision, code = check_write_authority(user_id, course_id,
                                           resolution, conversation_id)
Prefer settings.effective_mode(user_id, conversation_id) in
conversational code: it is the same resolver, reached through this
module.

Journaling: every change appends one record to
<MORROW_HOME>/settings/<user_id>.changes.jsonl (append-only JSONL,
O_APPEND plus fsync, dir 0700, file 0600), following this tree's journal
idiom (discovered via dispatch/executor.py: persist_signed_record writes
approvals under a journal dir; _journal_read_paths shows the journal is
the tree's append-only record of consequential events). The settings
journal is deliberately a separate file, not the dispatch ops journal:
that journal is an op_id-keyed WAL with HMAC seals and replay
protection, and settings audit records are not dispatch ops; mixing them
would confuse the op-id machinery (used_op_ids, retired sets, archive
rotation). Records carry a hash chain (prev_hash/rec_hash) plus a change
counter in the settings file, so tampering, reordering, or truncation
(including a truncated tail, which a hash chain alone cannot see) fails
closed in verify_audit().

Conventions:
- Consequential changes (marked in SETTINGS_SCHEMA, plus conversation
  overrides and edit sessions) require educator_confirmed=True;
  otherwise SettingsTamperRefused is raised. The agent can never grant
  itself edit mode, start an edit session, or flip a consequential
  setting on its own.
- Fail closed: an unreadable or corrupt settings file raises
  SettingsCorrupt rather than silently resetting to defaults.
- Atomic writes: tmp file + fsync + os.replace, 0600. A crash
  mid-write leaves the old file intact, never a torn one.
- user_id is slugged (path-traversal proof) before it touches a path.
- No tenant concept exists in this package: settings are per educator,
  and nothing here is gated or restricted by tenant.

Stdlib only.
"""

import fcntl
import hashlib
import json
import os
import re
import sys
import threading
import uuid
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                ".."))
from config.paths import morrow_home  # noqa: E402
from modes.state import (  # noqa: E402
    current_mode as _modes_current_mode,
    edit_session_remaining as _modes_session_remaining,
    request_edit_grant as _modes_request_grant,
    revoke_edit_grant as _modes_revoke_grant,
)


class SettingsError(Exception):
    """Base class for settings failures."""


class SettingsUnknownKey(SettingsError):
    """The requested setting key is not in SETTINGS_SCHEMA."""


class SettingsValidationError(SettingsError):
    """The value failed schema validation. Nothing was changed."""


class SettingsTamperRefused(SettingsError):
    """A consequential change was attempted without educator confirmation.

    The agent must echo the change to the educator and only proceed with
    educator_confirmed=True after the educator says yes.
    """


class SettingsCorrupt(SettingsError):
    """The on-disk settings file is unreadable or invalid.

    Fail closed: refused rather than silently resetting to defaults.
    """


class SettingsTamper(SettingsCorrupt):
    """The settings file's tamper seal is missing or invalid.

    Fails closed like any corruption, but distinguished so an operator
    can tell tampering apart from a torn write. Every settings file is
    HMAC-sealed on write with the machine keyring (the same seal the
    modes grants and approval records use); a file that does not verify
    is never trusted.
    """


class SettingsAuditError(SettingsError):
    """The settings audit journal failed verification."""


# ---------------------------------------------------------------------------
# Schema: every knob is user-settable; nothing here silently restricts the
# educator beyond the privacy and safe-operations guardrails, which live in
# the dispatch layer, not in settings.
# ---------------------------------------------------------------------------

# Duration bounds for explicitly requested timed edit sessions, in
# minutes. Kept as module constants (not inline literals) so the
# schema validator and the conversational parser can never drift apart.
# (Bare "use edit mode" is standing, not timed; these bounds apply only
# when the educator explicitly asks for a timed session.)
EDIT_GRANT_DURATION_MIN = 5
EDIT_GRANT_DURATION_MAX = 480


def _enum_validator(choices):
    def check(value):
        if not isinstance(value, str) or value not in choices:
            raise SettingsValidationError(
                "must be one of %s, got %r" % (sorted(choices), value))
    return check


def _int_range_validator(lo, hi):
    def check(value):
        # bool is a subclass of int; reject it explicitly.
        if isinstance(value, bool) or not isinstance(value, int):
            raise SettingsValidationError(
                "must be an integer, got %r" % (value,))
        if value < lo or value > hi:
            raise SettingsValidationError(
                "must be between %d and %d, got %r" % (lo, hi, value))
    return check


def _bool_validator(value):
    if not isinstance(value, bool):
        raise SettingsValidationError("must be true or false, got %r"
                                      % (value,))


def _course_id_validator(value):
    if not isinstance(value, str):
        raise SettingsValidationError("must be a string, got %r" % (value,))
    if value == "":
        return  # no default course: the agent asks when it needs one
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", value):
        raise SettingsValidationError(
            "must be empty or 1-64 chars of letters, digits, underscore, "
            "dot, or dash; got %r" % (value,))


def _timezone_validator(value):
    if not isinstance(value, str):
        raise SettingsValidationError("must be a string, got %r" % (value,))
    if value == "":
        return  # unset: the agent asks or falls back to the course default
    try:
        from zoneinfo import available_timezones
        zones = available_timezones()
    except ImportError:
        raise SettingsValidationError(
            "cannot validate timezones on this Python; upgrade to 3.9+")
    if value not in zones:
        raise SettingsValidationError(
            "unknown IANA timezone %r (example: 'America/Denver')" % (value,))


SETTINGS_SCHEMA = {
    "default_mode": {
        "default": "plan",
        "validate": _enum_validator({"plan", "edit"}),
        "consequential": True,
        "description": (
            "The educator's default mode. 'plan': writes surface approval. "
            "'edit': writes do not surface approval. Setting this to "
            "'edit' IS the standing edit grant: journaled, "
            "educator-confirmed, and plainly stated as such. Reads are "
            "unrestricted in both modes."),
    },
    "edit_grant_duration_min": {
        "default": 30,
        "validate": _int_range_validator(EDIT_GRANT_DURATION_MIN,
                                         EDIT_GRANT_DURATION_MAX),
        "consequential": True,
        "description": (
            "How long, in minutes, an explicitly requested timed edit "
            "session (e.g. 'edit for 30 minutes') lasts. Bare 'use edit "
            "mode' is standing with no time limit; this setting only "
            "affects explicit timed requests. Range 5 to 480."),
    },
    "verbosity": {
        "default": "balanced",
        "validate": _enum_validator({"concise", "balanced", "detailed"}),
        "consequential": False,
        "description": (
            "How much the agent says while working: concise, balanced, "
            "or detailed."),
    },
    "confirm_destructive_writes": {
        "default": False,
        "validate": _bool_validator,
        "consequential": True,
        "description": (
            "When true, deletes and other destructive writes ask "
            "for confirmation even in edit mode. Defaults to false: "
            "edit mode does not ask per write; that is the entire "
            "difference from plan mode. Turn it on only if you want "
            "the extra guardrail."),
    },
    "write_approval_style": {
        "default": "per_write",
        "validate": _enum_validator({"per_write", "batched"}),
        "consequential": True,
        "description": (
            "'per_write': one approval ceremony per write. 'batched': a "
            "single approval ceremony may cover a listed set of writes "
            "in one validated plan; the educator still approves the "
            "whole set before anything runs."),
    },
    "failure_verbosity": {
        "default": "detailed",
        "validate": _enum_validator({"concise", "detailed"}),
        "consequential": False,
        "description": (
            "'detailed' failure reports include what was attempted, the "
            "evidence, and recovery options. 'concise' keeps to what "
            "failed and the next step."),
    },
    "proactivity": {
        "default": "reactive",
        "validate": _enum_validator({"reactive", "suggestive"}),
        "consequential": False,
        "description": (
            "'reactive': the agent only does what is asked. 'suggestive': "
            "it may suggest follow-up actions unprompted."),
    },
    "read_confirmations": {
        "default": False,
        "validate": _bool_validator,
        "consequential": False,
        "description": (
            "Verbosity preference only. Reads never need approval; when "
            "true the agent narrates what it is about to read before "
            "reading it, when false it just reads."),
    },
    "work_summary": {
        "default": "full",
        "validate": _enum_validator({"brief", "full"}),
        "consequential": False,
        "description": (
            "How the agent reports completed work. 'brief': one short "
            "line per task. 'full': every change listed. In edit mode "
            "this summary is your oversight, so 'full' is the default."),
    },
    "auto_cleanup_test_objects": {
        "default": True,
        "validate": _bool_validator,
        "consequential": False,
        "description": (
            "When true, temporary objects the agent creates to verify "
            "something works (proof pages, test items) are deleted when "
            "the check is done instead of left behind."),
    },
    "default_course_id": {
        "default": "",
        "validate": _course_id_validator,
        "consequential": True,
        "description": (
            "Your go-to course id. When you do not name a course, the "
            "agent starts here without an extra check, as long as it is "
            "unambiguous; it asks only when the target is genuinely "
            "ambiguous or conflicts. Plan/Edit mode still governs write "
            "approval as usual. Empty means no default: the agent asks. "
            "Consequential because it steers where writes land."),
    },
    "timezone": {
        "default": "",
        "validate": _timezone_validator,
        "consequential": False,
        "description": (
            "Your timezone for date math ('last week's quiz', due-date "
            "windows). An IANA name like 'America/Denver'; empty means "
            "unset, and the agent asks or falls back to the course "
            "default."),
    },
    "confirm_bulk_actions": {
        "default": True,
        "validate": _bool_validator,
        "consequential": True,
        "description": (
            "When true, actions that touch many students or items at "
            "once (mass messages, bulk edits) ask for confirmation "
            "first, even in edit mode. The educator can turn it off, "
            "but only explicitly."),
    },
}

MODES = ("plan", "edit")


def _validate(key, value):
    entry = SETTINGS_SCHEMA.get(key)
    if entry is None:
        raise SettingsUnknownKey("unknown setting %r" % (key,))
    try:
        entry["validate"](value)
    except SettingsValidationError:
        raise
    except Exception as exc:  # validators only raise SettingsValidationError
        raise SettingsValidationError("invalid value for %r: %s" % (key, exc))


def _validate_mode(mode):
    if mode not in MODES:
        raise SettingsValidationError(
            "mode must be one of %s, got %r" % (list(MODES), mode))


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

_USER_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}")


def _slug_user_id(user_id):
    if not isinstance(user_id, str):
        raise SettingsError("user_id must be a string, got %r" % (user_id,))
    if not _USER_ID_RE.fullmatch(user_id):
        raise SettingsError(
            "user_id %r is invalid: use 1-64 chars of letters, digits, "
            "underscore, dot, or dash" % (user_id,))
    return user_id


def _settings_dir():
    path = os.path.join(morrow_home(), "settings")
    os.makedirs(path, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass
    return path


def _settings_path(user_id):
    return os.path.join(_settings_dir(), _slug_user_id(user_id) + ".json")


def _audit_path(user_id):
    return os.path.join(_settings_dir(),
                        _slug_user_id(user_id) + ".changes.jsonl")


def _lock_path(user_id):
    return os.path.join(_settings_dir(),
                        _slug_user_id(user_id) + ".lock")


def utc_now():
    return datetime.now(timezone.utc)


def utc_now_iso():
    return utc_now().isoformat()



# ---------------------------------------------------------------------------
# Load / save (persisted settings)
# ---------------------------------------------------------------------------

def _default_doc():
    # change_count is the audit sidecar: verify_audit() reconciles the
    # journal's record count against it, so a truncated tail (which a
    # hash chain alone cannot see) fails closed.
    return {"version": 1, "settings": {}, "change_count": 0}


def _read_doc_locked(user_id):
    """Read and parse the settings file. Fail closed on corruption.

    Preserves the change_count sidecar: dropping it here once silently
    broke truncation detection, so it is carried through explicitly.
    """
    path = _settings_path(user_id)
    if not os.path.exists(path):
        return _default_doc()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError) as exc:
        raise SettingsCorrupt(
            "settings file %s is unreadable (%s); refusing to guess. "
            "Restore it from backup, or delete the settings file and its "
            "journal together to start fully fresh." % (path, exc))
    if not isinstance(doc, dict) or not isinstance(doc.get("settings"), dict):
        raise SettingsCorrupt(
            "settings file %s has an invalid structure; refusing to guess."
            % path)
    # The seal is checked before any value is trusted: a file whose
    # seal is missing or invalid is never read, even if its values
    # would validate.
    _verify_doc_seal(doc, path)
    stored = doc["settings"]
    # Forward-compat: unknown stored keys are preserved, not rejected.
    # Known keys must validate, or the file is corrupt.
    for key, value in stored.items():
        if key in SETTINGS_SCHEMA:
            try:
                SETTINGS_SCHEMA[key]["validate"](value)
            except SettingsValidationError as exc:
                raise SettingsCorrupt(
                    "settings file %s holds invalid value for %r (%s); "
                    "refusing to guess." % (path, key, exc))
    return {"version": doc.get("version", 1),
            "settings": dict(stored),
            "change_count": doc.get("change_count")}


def _seal_doc(doc):
    """HMAC-seal a settings doc with the machine keyring.

    Same seal the modes grants and approval records use (lazy import,
    mirroring modes/state.py, so this module never imports dispatch at
    module scope).
    """
    try:
        from dispatch.admission import _seal_record
    except ImportError:  # pragma: no cover - tree layout fallback
        from admission import _seal_record
    return _seal_record(dict(doc))


def _verify_doc_seal(doc, path):
    """Refuse a settings doc whose tamper seal is missing or invalid."""
    if not isinstance(doc.get("sig"), str):
        raise SettingsTamper(
            "settings file %s carries no tamper seal; refusing to trust "
            "it. Restore it from backup." % path)
    try:
        from dispatch.admission import _verify_seal, ApprovalMismatch
    except ImportError:  # pragma: no cover - tree layout fallback
        from admission import _verify_seal, ApprovalMismatch
    try:
        _verify_seal(doc)
    except ApprovalMismatch as exc:
        raise SettingsTamper(
            "settings file %s failed tamper-seal verification (%s); "
            "refusing to trust it. Restore it from backup." % (path, exc))


def _write_doc_atomic(path, doc):
    sealed = _seal_doc(doc)
    tmp = "%s.tmp.%d" % (path, os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(sealed, fh, indent=2, sort_keys=True)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, path)
    # fsync the directory so the rename is durable.
    try:
        dfd = os.open(os.path.dirname(path), os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Audit journal (append-only JSONL, hash-chained)
# ---------------------------------------------------------------------------

def _append_audit_record(record):
    """Append one audit record: append-only JSONL, O_APPEND plus fsync.

    Mirrors the tree's journal idiom (dispatch/executor.py
    _append_record_locked): the append is the durability boundary, and
    every change is recorded with old value, new value, and educator
    identity.
    """
    path = _audit_path(record["user_id"])
    line = (json.dumps(record, sort_keys=True) + "\n").encode("utf-8")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        view = memoryview(line)
        while view:
            n = os.write(fd, view)
            view = view[n:]
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _audit_prev_hash(user_id):
    """Hash of the last audit record, or GENESIS for a fresh journal.

    A torn or unreadable tail fails closed here: chaining a new record
    onto a broken journal would only bury the damage, so appending is
    refused until the journal is repaired. (Journal appends are small
    single write() calls, so a torn tail means external interference,
    not a mid-write crash.)
    """
    path = _audit_path(user_id)
    if not os.path.exists(path):
        return "GENESIS"
    prev = "GENESIS"
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                rec = json.loads(raw)
                if isinstance(rec, dict) and rec.get("rec_hash"):
                    prev = rec["rec_hash"]
    except (OSError, ValueError) as exc:
        raise SettingsAuditError(
            "audit journal %s has a torn or unreadable tail (%s); "
            "refusing to append until it is repaired" % (path, exc))
    return prev


def _hash_record(record, prev_hash):
    body = json.dumps(record, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256((prev_hash + "\n" + body).encode("utf-8")
                          ).hexdigest()


def _journal_change(user_id, kind, key, old_value, new_value, educator,
                    extra=None):
    prev = _audit_prev_hash(user_id)
    record = {
        "kind": kind,
        "change_id": uuid.uuid4().hex,
        "at": utc_now_iso(),
        "user_id": user_id,
        "key": key,
        "old_value": old_value,
        "new_value": new_value,
        "educator": educator,
    }
    if extra:
        for extra_key, extra_value in extra.items():
            # Reserved audit fields always win: a caller-supplied extra
            # can never overwrite kind, identity, values, or the hash
            # chain links.
            if extra_key not in record:
                record[extra_key] = extra_value
    record["prev_hash"] = prev
    record["rec_hash"] = _hash_record(record, prev)
    _append_audit_record(record)
    return record


def _transact(user_id, doc_mutator, kind, key, educator, extra=None):
    """Lock, journal the change, then write the settings doc.

    The single choke point for every journaled change, so the change
    counter and the journal can never drift apart. doc_mutator(doc)
    performs the mutation and returns (old_value, new_value), all
    inside the lock, so the journaled old value is never stale.

    JOURNAL-FIRST ordering: the journal append is the first durable
    effect. If the settings-doc write then fails, the journal line is
    truncated back off (compensating action) under the same lock, so
    no orphan journal record survives a failed transaction. This is
    the safe direction: with write-first ordering, a crash between
    the doc write and the journal append would leave a persisted
    change with no audit record, and get_setting() would trust it
    silently. With journal-first ordering, the only crash residue is
    an orphan journal record whose change never landed, and
    verify_audit() fails closed on it (journal count ahead of the
    doc's change counter) instead of trusting an unjournaled change.
    """
    slug = _slug_user_id(user_id)
    educator_id = educator if educator is not None else slug
    lock_path = _lock_path(user_id)
    with open(lock_path, "a", encoding="utf-8") as lock_fh:
        fcntl.flock(lock_fh.fileno(), fcntl.LOCK_EX)
        try:
            doc = _read_doc_locked(user_id)
            old_value, new_value = doc_mutator(doc)
            journal_path = _audit_path(slug)
            try:
                journal_size_before = os.path.getsize(journal_path)
            except OSError:
                journal_size_before = 0
            record = _journal_change(slug, kind, key, old_value, new_value,
                                     educator_id, extra=extra)
            try:
                doc["change_count"] = int(doc.get("change_count") or 0) + 1
                _write_doc_atomic(_settings_path(user_id), doc)
            except BaseException:
                # The doc write failed after the journal append: roll
                # the journal line back off so the journal and the doc
                # agree again. Safe under the lock: no other settings
                # writer could have appended in between.
                try:
                    fd = os.open(journal_path, os.O_WRONLY)
                    try:
                        os.ftruncate(fd, journal_size_before)
                        os.fsync(fd)
                    finally:
                        os.close(fd)
                except OSError:
                    pass
                raise
            return record
        finally:
            fcntl.flock(lock_fh.fileno(), fcntl.LOCK_UN)


# ---------------------------------------------------------------------------
# Session-scoped state.
#
# Mode authority lives in modes/state.py; this module keeps NO grant or
# session store of its own. Timed edit sessions ARE modes timed grants:
# sealed, persisted under MORROW_HOME, journaled, and visible to the
# admission gate through the single resolver modes.current_mode (which
# settings.effective_mode delegates to). A session started with a
# conversation_id is bound to that conversation: it authorizes writes
# only there, and end_conversation revokes it.
#
# Per-conversation overrides stay in-memory here (never persisted) and
# are consulted by modes.current_mode via get_conversation_override,
# most-recent-wins against grants.
# ---------------------------------------------------------------------------

_SESSION_LOCK = threading.Lock()
# (user_id, conversation_id) -> {"mode", "set_at"}
_CONVERSATION_MODES = {}


def _modes_educator_confirmation(educator_confirmed, educator, utterance,
                                 action_desc):
    """Build the educator-confirmation record modes.request_edit_grant
    requires. educator_confirmed must be True (the educator said yes in
    the conversation); utterance should be their verbatim words when the
    harness has them, else a synthesized attestation naming the
    educator and the UTC time. Raises SettingsTamperRefused without
    educator confirmation: the agent can never start a session alone."""
    if not educator_confirmed:
        raise SettingsTamperRefused(
            "an edit session changes whether writes surface approval; the "
            "educator must be told and confirm it first "
            "(educator_confirmed=True)")
    if isinstance(educator, dict):
        who = educator.get("id") or educator.get("name") or "educator"
    elif educator:
        who = str(educator)
    else:
        who = "educator"
    authz = None
    if isinstance(utterance, str) and len(utterance.strip()) >= 20:
        authz = utterance.strip()
    if authz is None:
        authz = ("educator %s confirmed: %s (%s UTC)"
                 % (who, action_desc, utc_now().isoformat()))
    return {"by": "educator", "authorization": authz,
            "channel": "educator-chat"}


def start_edit_session(user_id, conversation_id=None,
                       educator_confirmed=False, educator=None,
                       duration_min=None, utterance=None):
    """Start an explicitly requested timed edit session.

    (Bare "use edit mode" is NOT timed; it sets default_mode="edit",
    standing with no expiry. This starts a timed session only when the
    educator explicitly asks for one, e.g. "edit for 30 minutes".)

    Delegates to modes.request_edit_grant: the session is a sealed,
    persisted, journaled timed grant, visible to the admission gate
    through the same resolver the conversational layer reports. While
    active, effective_mode() resolves to "edit": writes do not surface
    approval. Requires educator_confirmed=True; the agent can never
    start a session on its own. duration_min defaults to the
    educator's edit_grant_duration_min setting; an explicit value must
    be within 5-480 like the setting. utterance should be the
    educator's verbatim confirming words when the harness has them.

    The grant is minted first (it carries its own modes-journal
    record), then the settings audit is journaled with the grant's
    actual expiry; a settings-journal failure rolls the grant back, so
    a grant never goes live with no settings audit record. Returns
    {"mode": "edit", "expires_at", "duration_min", "grant_id"}.
    """
    _slug_user_id(user_id)
    if duration_min is None:
        duration_min = get_setting(user_id, "edit_grant_duration_min")
    SETTINGS_SCHEMA["edit_grant_duration_min"]["validate"](duration_min)
    confirmation = _modes_educator_confirmation(
        educator_confirmed, educator, utterance, "start edit session")
    old_mode = effective_mode(user_id, conversation_id)
    grant = _modes_request_grant(
        user_id, scope_type="timed", duration_min=duration_min,
        educator_confirmation=confirmation, conversation_id=conversation_id)
    try:
        # The grant mints its own modes-journal record; the settings
        # audit follows with the grant's actual expiry. On journal
        # failure the grant is rolled back rather than left active with
        # no settings audit record.
        _transact(user_id, lambda doc: (old_mode, "edit"),
                  "settings.edit_session", "edit_session", educator,
                  extra={"expires_at": grant["expires_at"],
                         "duration_min": grant["duration_min"],
                         "conversation_id": conversation_id,
                         "grant_id": grant["grant_id"]})
    except BaseException:
        _modes_revoke_grant(
            user_id, reason="settings audit journal failed; rolling back",
            grant_id=grant["grant_id"])
        raise
    return {"mode": "edit", "expires_at": grant["expires_at"],
            "duration_min": grant["duration_min"],
            "grant_id": grant["grant_id"]}


def end_edit_session(user_id, conversation_id=None, educator=None):
    """End the edit session covering this conversation scope, if live.

    Revokes the timed grant(s) bound to the conversation (or the
    unbound user-global timed grant when conversation_id is None).
    Safe direction (edit -> plan), so no confirmation is required.
    Returns True when a grant was actually revoked. Journaled.
    """
    _slug_user_id(user_id)
    if conversation_id is not None:
        revoked = _modes_revoke_grant(
            user_id, reason="settings.end_edit_session",
            conversation_id=conversation_id, scope_type="timed")
    else:
        revoked = _modes_revoke_grant(
            user_id, reason="settings.end_edit_session",
            scope_type="timed", unbound_only=True)
    if not revoked:
        return False
    new_mode = effective_mode(user_id, conversation_id)
    _transact(user_id, lambda doc: ("edit", new_mode),
               "settings.edit_session", "edit_session", educator,
               extra={"conversation_id": conversation_id,
                      "ended_early": True,
                      "revoked_grants": revoked})
    return True


def edit_session_active(user_id, conversation_id=None):
    """True when an unexpired timed edit grant covers this scope."""
    return edit_session_remaining(user_id, conversation_id) > 0


def edit_session_remaining(user_id, conversation_id=None):
    """Seconds left on the covering timed edit grant, or 0."""
    _slug_user_id(user_id)
    remaining = _modes_session_remaining(user_id, conversation_id)
    if remaining is None:
        return 0
    return max(0, int(remaining))


def set_conversation_mode(user_id, conversation_id, mode,
                          educator_confirmed=False, educator=None):
    """Set a per-conversation mode override.

    Lasts for that conversation only; never persisted. Requires
    educator_confirmed=True and is journaled like any other
    consequential change. The override is consulted by the single
    authoritative resolver (modes.current_mode), most-recent-wins
    against grants.
    """
    _slug_user_id(user_id)
    _validate_mode(mode)
    if not conversation_id:
        raise SettingsError("conversation_id is required for a "
                            "per-conversation override")
    if not educator_confirmed:
        raise SettingsTamperRefused(
            "a per-conversation mode override changes whether writes "
            "surface approval; the educator must be told and confirm it "
            "first (educator_confirmed=True)")
    old_mode = effective_mode(user_id, conversation_id)
    # Journal BEFORE activating, as in start_edit_session.
    _transact(user_id, lambda doc: (old_mode, mode),
              "settings.conversation_mode", "conversation_mode", educator,
              extra={"conversation_id": conversation_id})
    with _SESSION_LOCK:
        _CONVERSATION_MODES[(user_id, conversation_id)] = {
            "mode": mode, "set_at": utc_now_iso()}
    return mode


def get_conversation_mode(user_id, conversation_id):
    """The conversation override, or None when unset."""
    entry = get_conversation_override(user_id, conversation_id)
    return entry["mode"] if entry else None


def get_conversation_override(user_id, conversation_id):
    """The full conversation override entry {"mode", "set_at"}, or None.

    Used by modes.current_mode for most-recent-wins resolution against
    grants. In-memory only; never persisted.
    """
    _slug_user_id(user_id)
    if not conversation_id:
        return None
    with _SESSION_LOCK:
        entry = _CONVERSATION_MODES.get((user_id, conversation_id))
        return dict(entry) if entry else None


def end_conversation(user_id, conversation_id):
    """Tear down conversation-scoped state.

    Pops the in-memory override and revokes every live grant bound to
    the conversation (timed sessions and conversation grants). This is
    the harness's explicit duty when a Muse conversation ends: without
    it, a conversation-bound grant could outlive the conversation it
    was granted for. Session teardown, not an educator choice: not
    journaled in the settings audit (grant revocations are journaled
    in the modes audit).
    """
    _slug_user_id(user_id)
    if not conversation_id:
        return
    with _SESSION_LOCK:
        _CONVERSATION_MODES.pop((user_id, conversation_id), None)
    _modes_revoke_grant(user_id, reason="conversation ended",
                        conversation_id=conversation_id)


def effective_mode(user_id, conversation_id=None):
    """The mode in force right now: "edit" or "plan".

    Delegates to the single authoritative resolver
    modes.state.current_mode: the most recent explicit educator action
    among the conversation override, live timed grants, and live
    conversation grants wins; otherwise the persisted default_mode
    ("edit" only when the educator set it as their standing default).
    The admission gate uses the same resolver, so the conversational
    layer and the write gate can never disagree.
    """
    _slug_user_id(user_id)
    return _modes_current_mode(user_id, conversation_id)


# ---------------------------------------------------------------------------
# Public API: persisted settings
# ---------------------------------------------------------------------------

def get_setting(user_id, key):
    """Return the educator's value for key, or its schema default.

    Agent B contract: settings.store.get_setting(user_id, key) with this
    exact signature. Raises SettingsUnknownKey for unknown keys and
    SettingsCorrupt for an unreadable settings file.
    """
    entry = SETTINGS_SCHEMA.get(key)
    if entry is None:
        raise SettingsUnknownKey("unknown setting %r" % (key,))
    doc = _read_doc_locked(user_id)
    stored = doc["settings"]
    if key in stored:
        return stored[key]
    return entry["default"]


def list_settings(user_id):
    """Return every setting with value, default, changed flag, and docs."""
    doc = _read_doc_locked(user_id)
    stored = doc["settings"]
    out = {}
    for key in sorted(SETTINGS_SCHEMA):
        entry = SETTINGS_SCHEMA[key]
        value = stored.get(key, entry["default"])
        out[key] = {
            "value": value,
            "default": entry["default"],
            "changed": key in stored,
            "consequential": bool(entry["consequential"]),
            "description": entry["description"],
        }
    return out


def set_setting(user_id, key, value, educator_confirmed, educator=None):
    """Set one persisted setting, journaling the change with old/new values.

    educator_confirmed must be True for consequential settings (per
    SETTINGS_SCHEMA); without it SettingsTamperRefused is raised. The
    educator identity written to the audit record defaults to the
    user_id; pass an explicit educator name or id when the confirmer is
    known. Returns the new value.
    """
    entry = SETTINGS_SCHEMA.get(key)
    if entry is None:
        raise SettingsUnknownKey("unknown setting %r" % (key,))
    _validate(key, value)
    if entry["consequential"] and not educator_confirmed:
        raise SettingsTamperRefused(
            "setting %r is consequential; the educator must be told the "
            "exact change and confirm it before it is applied "
            "(educator_confirmed=True)" % (key,))

    def mutate(doc):
        old_value = doc["settings"].get(key, entry["default"])
        doc["settings"][key] = value
        return old_value, value

    _transact(user_id, mutate, "settings.change", key, educator)
    return value


def destructive_confirmation_required(user_id):
    """Convenience for the modes layer: honor confirm_destructive_writes."""
    return bool(get_setting(user_id, "confirm_destructive_writes"))


# ---------------------------------------------------------------------------
# Audit journal reads
# ---------------------------------------------------------------------------

def read_audit(user_id):
    """Return the audit journal records for user_id, oldest first.

    Does not verify the hash chain; use verify_audit() for that.
    """
    _slug_user_id(user_id)
    path = _audit_path(user_id)
    if not os.path.exists(path):
        return []
    records = []
    with open(path, "r", encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, 1):
            raw = raw.strip()
            if not raw:
                continue
            try:
                rec = json.loads(raw)
            except ValueError as exc:
                raise SettingsAuditError(
                    "audit journal %s line %d is torn (%s)" % (path, lineno, exc))
            if not isinstance(rec, dict):
                raise SettingsAuditError(
                    "audit journal %s line %d is not a record" % (path, lineno))
            records.append(rec)
    return records


def verify_audit(user_id):
    """Verify the audit hash chain for user_id.

    Returns the record count. Raises SettingsAuditError on any break:
    a tampered, reordered, or truncated journal fails closed here. The
    record count is reconciled against the change counter kept in the
    settings file, so even a truncated tail (invisible to a hash chain
    alone) is detected.
    """
    prev = "GENESIS"
    count = 0
    for rec in read_audit(user_id):
        for field in ("kind", "change_id", "at", "key", "old_value",
                      "new_value", "educator", "prev_hash", "rec_hash"):
            if field not in rec:
                raise SettingsAuditError(
                    "audit record for %r is missing field %r" % (user_id, field))
        if rec.get("prev_hash") != prev:
            raise SettingsAuditError(
                "audit chain broken for %r at change %r: expected prev %s"
                % (user_id, rec.get("change_id"), prev[:12]))
        body = dict(rec)
        claimed = body.pop("rec_hash")
        if _hash_record(body, prev) != claimed:
            raise SettingsAuditError(
                "audit record %r for %r was tampered with"
                % (rec.get("change_id"), user_id))
        prev = claimed
        count += 1
    try:
        doc = _read_doc_locked(user_id)
    except SettingsCorrupt as exc:
        raise SettingsAuditError(
            "cannot reconcile audit count: %s" % exc)
    expected = doc.get("change_count")
    if expected is not None and count != int(expected):
        raise SettingsAuditError(
            "audit journal for %r holds %d records but the settings file "
            "counts %d changes: the journal was truncated or extended "
            "outside the settings API" % (user_id, count, int(expected)))
    return count
