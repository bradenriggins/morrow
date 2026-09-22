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
     conversation"): lasts for that conversation only. Persisted in the
     educator's sealed settings file (keyed by conversation id) and
     journaled, because every dispatch is a new process: an override
     held in one process's memory never reaches the write gate. modes
     consults it via get_conversation_override. A plan override
     survives restarts until the conversation ends. An edit override
     ends when the conversation ends (end_conversation) or when the
     educator turns edit mode off anywhere (switch_mode("plan")); a
     tampered or unreadable override store resolves to plan. A modes
     conversation grant plays the same role.
  2. default_mode: the persisted default. Setting it to "edit" IS the
     standing edit grant: journaled, educator-confirmed, plainly
     documented. It is NOT timed: it stays on until the educator turns
     edit mode off (modes.state.switch_mode("plan"), which also clears
     every grant and override).

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
  overrides) require educator_confirmed=True; otherwise
  SettingsTamperRefused is raised. The agent can never grant itself
  edit mode or flip a consequential setting on its own.
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
import uuid
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                ".."))
from config.identity import USER_ID_RULE, is_valid_user_id  # noqa: E402
from config.paths import morrow_home  # noqa: E402
from modes.state import (  # noqa: E402
    current_mode as _modes_current_mode,
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

def _enum_validator(choices):
    def check(value):
        if not isinstance(value, str) or value not in choices:
            raise SettingsValidationError(
                "must be one of %s, got %r" % (sorted(choices), value))
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
            "educator-confirmed, and plainly stated as such. Edit mode "
            "has no time limit: it stays on until the educator turns it "
            "off. Reads are unrestricted in both modes."),
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

def _slug_user_id(user_id):
    if not isinstance(user_id, str):
        raise SettingsError("user_id must be a string, got %r" % (user_id,))
    if not is_valid_user_id(user_id):
        raise SettingsError(
            "user_id %r is invalid: use %s" % (user_id, USER_ID_RULE))
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
    return {"version": 1, "settings": {}, "change_count": 0,
            "conversation_overrides": {}}


def _validate_overrides(overrides, path):
    if not isinstance(overrides, dict):
        raise SettingsCorrupt(
            "settings file %s holds invalid conversation overrides; "
            "refusing to guess." % path)
    for conv, entry in overrides.items():
        if not isinstance(conv, str) or not conv \
                or not isinstance(entry, dict) \
                or entry.get("mode") not in MODES \
                or not isinstance(entry.get("set_at"), str):
            raise SettingsCorrupt(
                "settings file %s holds an invalid conversation override "
                "for %r; refusing to guess." % (path, conv))


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
    overrides = doc.get("conversation_overrides", {})
    _validate_overrides(overrides, path)
    return {"version": doc.get("version", 1),
            "settings": dict(stored),
            "change_count": doc.get("change_count"),
            "conversation_overrides": {k: dict(v)
                                       for k, v in overrides.items()}}


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
# Per-conversation overrides.
#
# Mode authority lives in modes/state.py; this module keeps NO grant
# store of its own. Per-conversation overrides are persisted in the
# educator's sealed settings file (conversation_overrides, keyed by
# conversation id) through _transact, so every change is journaled and
# every later process (each dispatch is one) sees it. modes.current_mode
# consults them via get_conversation_override, most-recent-wins against
# grants.
# ---------------------------------------------------------------------------

_CONVERSATION_ID_MAX = 256


def _conversation_key(conversation_id):
    if conversation_id is None or str(conversation_id) == "":
        raise SettingsError("conversation_id is required for a "
                            "per-conversation override")
    key = str(conversation_id)
    if len(key) > _CONVERSATION_ID_MAX:
        raise SettingsError("conversation_id is longer than %d characters"
                            % _CONVERSATION_ID_MAX)
    return key


def set_conversation_mode(user_id, conversation_id, mode,
                          educator_confirmed=False, educator=None):
    """Set a per-conversation mode override.

    Lasts for that conversation only (see the module docstring for the
    restart rules). Persisted and journaled like any other
    consequential change. "edit" requires educator_confirmed=True;
    "plan" is the safe direction and applies at once, like turning
    edit mode off. The override is consulted by the single
    authoritative resolver (modes.current_mode), most-recent-wins
    against grants.
    """
    _slug_user_id(user_id)
    _validate_mode(mode)
    key = _conversation_key(conversation_id)
    if mode == "edit" and not educator_confirmed:
        raise SettingsTamperRefused(
            "a per-conversation edit override changes whether writes "
            "surface approval; the educator must be told and confirm it "
            "first (educator_confirmed=True)")
    old_mode = effective_mode(user_id, key)

    def mutate(doc):
        doc.setdefault("conversation_overrides", {})[key] = {
            "mode": mode, "set_at": utc_now_iso()}
        return old_mode, mode

    _transact(user_id, mutate, "settings.conversation_mode",
              "conversation_mode", educator,
              extra={"conversation_id": key})
    return mode


def get_conversation_mode(user_id, conversation_id):
    """The conversation override, or None when unset."""
    entry = get_conversation_override(user_id, conversation_id)
    return entry["mode"] if entry else None


def get_conversation_override(user_id, conversation_id):
    """The full conversation override entry {"mode", "set_at"}, or None.

    Used by modes.current_mode for most-recent-wins resolution against
    grants. Raises SettingsCorrupt (including SettingsTamper) when the
    settings file cannot be trusted; the resolver treats that as plan.
    """
    _slug_user_id(user_id)
    if conversation_id is None or str(conversation_id) == "":
        return None
    doc = _read_doc_locked(user_id)
    entry = doc["conversation_overrides"].get(str(conversation_id))
    return dict(entry) if entry else None


def clear_conversation_overrides(user_id, educator=None):
    """Drop every per-conversation override for user_id.

    Part of turning edit mode off everywhere (modes.switch_mode("plan")).
    Journaled when anything was cleared. Returns the number removed.
    """
    _slug_user_id(user_id)
    if not _read_doc_locked(user_id)["conversation_overrides"]:
        return 0
    removed = []

    def mutate(doc):
        old = dict(doc.get("conversation_overrides") or {})
        removed.extend(old)
        doc["conversation_overrides"] = {}
        return old, {}

    _transact(user_id, mutate, "settings.conversation_overrides_cleared",
              "conversation_mode", educator)
    return len(removed)


def end_conversation(user_id, conversation_id):
    """Tear down conversation-scoped state.

    Removes the persisted override (journaled), revokes every live
    grant bound to the conversation (journaled in the modes audit), and
    ends the name echo of every student the educator named in it.
    This is the harness's explicit duty when a Muse conversation ends:
    without it, a conversation-bound override or grant could outlive
    the conversation it was granted for.
    """
    _slug_user_id(user_id)
    if conversation_id is None or str(conversation_id) == "":
        return
    key = str(conversation_id)
    if key in _read_doc_locked(user_id)["conversation_overrides"]:
        def mutate(doc):
            old = (doc.get("conversation_overrides") or {}).pop(key, None)
            return old, None

        _transact(user_id, mutate, "settings.conversation_ended",
                  "conversation_mode", None,
                  extra={"conversation_id": key})
    _modes_revoke_grant(user_id, reason="conversation ended",
                        conversation_id=key)
    # Names the educator introduced in this conversation stop echoing
    # (privacy/name_echo): the echo lives exactly as long as the
    # conversation the educator typed the name in.
    from privacy import name_echo as _name_echo
    _name_echo.end_conversation(key)


def observe_conversation(user_id, conversation_id):
    """Morrow saw conversation_id for user_id: end other conversations' edit.

    An edit override (and an edit grant bound to one conversation) lives
    only as long as its conversation. The harness may never call
    end_conversation, so the lifetime cannot depend on it: when any
    command or write gate sees a conversation id for this educator, every
    EDIT override and conversation-bound edit grant for a DIFFERENT
    conversation ends (journaled). Plan overrides are the safe direction
    and are left alone. Returns the number of edit overrides ended.
    """
    _slug_user_id(user_id)
    if conversation_id is None or str(conversation_id) == "":
        return 0
    key = str(conversation_id)
    stale = [conv for conv, entry in
             _read_doc_locked(user_id)["conversation_overrides"].items()
             if conv != key and entry.get("mode") == "edit"]
    if stale:
        def mutate(doc):
            overrides = doc.get("conversation_overrides") or {}
            old = {conv: overrides.pop(conv) for conv in stale
                   if conv in overrides}
            return old, None

        _transact(user_id, mutate, "settings.conversation_superseded",
                  "conversation_mode", None,
                  extra={"conversation_id": key})
    _modes_revoke_grant(user_id, reason="conversation superseded",
                        except_conversation_id=key)
    return len(stale)


def has_plan_override(user_id):
    """True when any conversation carries a plan override for user_id.

    The write gate uses this when no conversation id is supplied: a plan
    override the educator set cannot be matched to the write, so the
    write is treated as plan. An unreadable store counts as True.
    """
    _slug_user_id(user_id)
    try:
        overrides = _read_doc_locked(user_id)["conversation_overrides"]
    except SettingsCorrupt:
        return True
    return any(entry.get("mode") == "plan" for entry in overrides.values())


def effective_mode(user_id, conversation_id=None):
    """The mode in force right now: "edit" or "plan".

    Delegates to the single authoritative resolver
    modes.state.current_mode: the most recent explicit educator action
    among the conversation override and live conversation grants wins; otherwise the persisted default_mode
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
