"""Per-user Plan/Edit mode state for Morrow for Muse (Workstream A).

The mode system answers one question: may this write proceed without a
per-write educator approval? Everything else about the two modes is
identical: reads are unrestricted with no approval in both modes, and
every other admission gate (never-dispatch, unsupported,
evidence-holds, learner-data) runs unchanged in both modes.

Model (per Braden's correction):
  - Plan mode is the default. Writes need the existing frozen-plan +
    educator-signed v2 approval path (dispatch/admission.py), unchanged.
  - Edit mode is educator-granted only and means exactly one thing:
    the educator gives their Muse agent permission to edit Canvas on
    their behalf without approving every single change. It is NOT
    scoped: there are no course lists and no category lists on a grant.
    The agent finds the correct course itself via search and reasons
    with the user to confirm it is working in the right course;
    ambiguous course resolution must be confirmed conversationally,
    never guessed silently (enforced by the ambiguous-course refusal).

Edit mode is NOT timed. It stays on until the educator turns it off;
nothing about it expires on a clock.

Grant = {grant_id, educator identity (bound), granted_at, revoked flag,
scope_type, conversation binding, source utterance citation}. The one
grantable scope_type is "conversation" ("use edit mode for this
conversation"): no expiry, it lives until revoked (switch_mode to plan,
or the conversation ending). Standing edit mode ("use edit mode") is
not a grant record at all: the educator set default_mode to "edit" in
settings, and it stays on until they turn it off.

Older installs persisted "timed" grants. Those are never live: they
lapse to plan (a write asks for approval). They are neither honored
nor converted into a standing grant.

Effective mode resolution: a live conversation grant (or a
per-conversation override) -> "edit"; else the educator's standing
default_mode == "edit" -> "edit"; else "plan". Effective mode is "edit"
ONLY through one of those educator-controlled paths.

The agent MUST NEVER enable or broaden edit mode itself:
  - request_edit_grant without a valid educator-issued confirmation
    raises ModeSelfGrantRefused.
  - switch_mode accepts only "plan"; switching to "edit" raises
    ModeSelfGrantRefused (the educator flips default_mode in settings
    themselves for standing edit mode). switch_mode("plan") turns edit
    off everywhere: grants, per-conversation overrides, and the
    standing default.

Educator principal binding: this tree represents the educator principal
as by == "educator" plus the verbatim authorization citation (the
approval-record pattern in dispatch/admission.py). Grant records bind
the same: educator_identity = {by: "educator", authorization:
<verbatim educator utterance>, channel}. Honest trust statement (same
as sign_approval): this runs in the agent's process, so it cannot
cryptographically prove the citation came from the educator; the
citation is journaled verbatim for audit and the grant file carries a
tamper seal, so post-grant modification fails closed.

Persistence: per-user grant state lives under
<morrow_home>/modes/grants/<user_id>.json (0600, atomically written,
HMAC-sealed with the same machine keyring as approval records).
morrow_home() honors MORROW_HOME, so state survives restarts and
reinstalls and never lives inside the deploy tree.

Journaling: grant issuance, every edit-mode write admission, grant
expiry, and every revocation are appended to the tree journal via the
executor's journal_append (same lock, same HMAC-sealed JSONL journal
as every other dispatch audit record), each carrying the educator
identity binding.

Settings contract (owned by Agent B, settings/store.py):
  - get_setting(user_id, key) -> value or None when unset.
  - set_setting(user_id, key, value) persists the value.
  Key used here: "default_mode" ("plan" | "edit"). Without
  settings/store.py the import falls back to default_mode "plan".

Stdlib only.
"""

from __future__ import annotations

import fcntl
import json
import os
import sys
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone

_TREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE_ROOT not in sys.path:
    sys.path.insert(0, _TREE_ROOT)
from config.identity import USER_ID_RULE, is_valid_user_id  # noqa: E402
from config.paths import morrow_home  # noqa: E402
from modes.errors import (  # noqa: E402
    ModeSelfGrantRefused,
    ModeSettingsTamper,
)

__all__ = [
    "current_mode",
    "request_edit_grant",
    "revoke_edit_grant",
    "switch_mode",
    "check_write_authority",
    "authorize_write",
    "journal_event",
    "journal_write_admitted",
    "journal_write_refused",
    "CONFIDENCE_THRESHOLD",
]

# Grant file layout version.
GRANT_FILE_VERSION = 1
# Course-resolution confidence below this (without explicit user
# confirmation) refuses the write as ambiguous.
CONFIDENCE_THRESHOLD = 0.9
# The authorization citation is the educator's verbatim reply; any
# non-empty reply counts, mirroring the approval record's
# APPROVAL_AUTH_MIN_LEN.
AUTH_MIN_LEN = 1
# Grantable scope types. "standing" is deliberately absent: standing
# edit mode is the educator's default_mode setting, never a grant.
# "timed" is absent too: edit mode is not timed, and legacy timed
# grants on disk are never live (see _is_live).
_SCOPE_TYPES = ("conversation",)


# ---------------------------------------------------------------------------
# Settings (Agent B contract, with fallback)
# ---------------------------------------------------------------------------

def _settings_fns():
    """(get_setting, set_setting) from settings/store.py, or (None, None).

    Resolved at use time (not import time) so tests can inject a fake
    settings module through sys.modules, and so the modes package keeps
    working before Agent B's settings/store.py exists.
    """
    try:
        from settings.store import get_setting, set_setting
    except Exception:
        return None, None
    return get_setting, set_setting


def _standing_edit_default(user_id):
    """True when the educator's stored default_mode is "edit"."""
    get_setting, _ = _settings_fns()
    if get_setting is None:
        return False
    try:
        value = get_setting(user_id, "default_mode")
    except Exception:
        # Backend failure fails closed to plan; an invalid stored value
        # below is tamper and raises.
        return False
    if value is None:
        return False
    if value == "edit":
        return True
    if value == "plan":
        return False
    raise ModeSettingsTamper(
        "default_mode has invalid value %r; expected 'plan' or 'edit'"
        % (value,),
        setting_name="default_mode")


# ---------------------------------------------------------------------------
# Time helpers (UTC everywhere)
# ---------------------------------------------------------------------------

def _utcnow():
    return datetime.now(timezone.utc)


def _iso(dt):
    return dt.astimezone(timezone.utc).isoformat()


def _parse_time(value):
    """Parse an ISO-8601 timestamp to an aware UTC datetime.

    Raises ModeSettingsTamper on garbage: a grant whose times do not
    parse is not a grant we can reason about, so it fails closed.
    """
    if not isinstance(value, str) or not value.strip():
        raise ModeSettingsTamper(
            "grant carries an empty timestamp; refusing")
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        raise ModeSettingsTamper(
            "grant carries an unparsable timestamp %r; refusing" % (value,))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


# ---------------------------------------------------------------------------
# Grant file persistence (per user, under morrow_home, sealed)
# ---------------------------------------------------------------------------

def _validate_user_id(user_id):
    if not is_valid_user_id(user_id):
        raise ValueError(
            "user_id %r is invalid: use %s" % (user_id, USER_ID_RULE))


def _grants_path(user_id):
    _validate_user_id(user_id)
    return os.path.join(morrow_home(), "modes", "grants", user_id + ".json")


def _seal(payload):
    try:
        from dispatch.admission import _seal_record
    except ImportError:  # run with dispatch/ itself on sys.path
        from admission import _seal_record
    return _seal_record(payload)


def _verify(payload):
    try:
        from dispatch.admission import _verify_seal
    except ImportError:
        from admission import _verify_seal
    try:
        _verify_seal(payload)
    except Exception as exc:
        raise ModeSettingsTamper(
            "mode grant state failed tamper-seal verification; the "
            "grant file was modified outside the mode system (%s); "
            "refusing" % (exc,))


def _load_state(user_id):
    """Read and seal-verify the user's grant file.

    Missing file -> empty state. Anything else unreadable or
    seal-invalid -> ModeSettingsTamper (fail closed).
    """
    path = _grants_path(user_id)
    try:
        with open(path, "r", encoding="utf-8") as f:
            state = json.load(f)
    except FileNotFoundError:
        return {"version": GRANT_FILE_VERSION, "revision": 0, "grants": []}
    except (OSError, ValueError) as exc:
        raise ModeSettingsTamper(
            "mode grant state for %r is unreadable (%s); refusing"
            % (user_id, exc))
    if (not isinstance(state, dict)
            or state.get("version") != GRANT_FILE_VERSION
            or not isinstance(state.get("grants"), list)):
        raise ModeSettingsTamper(
            "mode grant state for %r has an unexpected layout; refusing"
            % (user_id,))
    _verify(state)
    return state


def _save_state(user_id, state):
    """Atomically persist the grant file (0600, sealed)."""
    path = _grants_path(user_id)
    parent = os.path.dirname(path)
    os.makedirs(parent, exist_ok=True)
    try:
        os.chmod(parent, 0o700)
    except OSError:
        pass
    tmp = "%s.new.%d" % (path, os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        sealed = _seal(dict(state))
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(sealed, f, indent=2, sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


@contextmanager
def _locked(user_id):
    """Exclusive lock around grant-file read-modify-write cycles."""
    path = _grants_path(user_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".lock", "a", encoding="utf-8") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


# ---------------------------------------------------------------------------
# Grant liveness
# ---------------------------------------------------------------------------

def _is_live(grant, now=None):
    # Only conversation grants can be live. A "timed" grant written by
    # an older install lapses to plan here, whatever its expires_at
    # says: honoring it would keep edit on by a clock, and promoting it
    # would turn a bounded grant into a permanent one.
    return (grant.get("scope_type") in _SCOPE_TYPES
            and not grant.get("revoked"))


def _grant_in_conversation(grant, conversation_id):
    """True when the grant applies to the queried conversation.

    A grant bound to a conversation_id applies only inside that
    conversation. Unbound grants apply everywhere.
    """
    bound = grant.get("conversation_id")
    if bound is None:
        return True
    return conversation_id is not None and str(bound) == str(conversation_id)


def _live_grant(user_id, now=None, conversation_id=None):
    """The newest live grant applying to this conversation, or None.

    Raises ModeSettingsTamper when the grant file is tampered with.
    """
    state = _load_state(user_id)
    now = now or _utcnow()
    live = [g for g in state["grants"]
            if isinstance(g, dict) and _is_live(g, now)
            and _grant_in_conversation(g, conversation_id)]
    live.sort(key=lambda g: g.get("revision", 0))
    return live[-1] if live else None




# ---------------------------------------------------------------------------
# Educator confirmation (the anti-self-grant gate)
# ---------------------------------------------------------------------------

def _require_educator_confirmation(educator_confirmation):
    """Validate the educator-issued confirmation record.

    Mirrors the approval-record pattern: by == "educator" plus a
    verbatim authorization citation (the educator's own utterance).
    Anything else is agent self-promotion and raises
    ModeSelfGrantRefused.
    """
    conf = educator_confirmation or {}
    if not isinstance(conf, dict) or conf.get("by") != "educator":
        raise ModeSelfGrantRefused(
            "edit mode requires an educator-issued confirmation "
            "(by='educator' with a verbatim authorization citation); "
            "the agent cannot grant itself edit mode")
    auth = conf.get("authorization")
    if not isinstance(auth, str) or len(auth.strip()) < AUTH_MIN_LEN:
        raise ModeSelfGrantRefused(
            "edit mode requires the educator's verbatim reply (any "
            "non-empty reply); inferred or standing approvals are not "
            "accepted")
    channel = conf.get("channel", "driver")
    if channel not in ("educator-chat", "driver"):
        raise ModeSelfGrantRefused(
            "educator confirmation channel must be 'educator-chat' or "
            "'driver'; got %r" % (channel,))
    return {
        "by": "educator",
        "authorization": auth.strip(),
        "channel": channel,
    }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def _conversation_override(user_id, conversation_id):
    """(mode, set_at_iso) for the settings conversation override, or
    (None, None). Lazy import: settings/store.py imports this module at
    top level, so settings must only ever be imported here at use time.

    An override store that exists but cannot be read or trusted
    (corrupt, tampered) resolves to a plan override stamped now: it may
    hold a plan override the educator set, and guessing edit there
    would admit writes the educator asked to approve.
    """
    if not conversation_id:
        return None, None
    try:
        from settings.store import get_conversation_override as _get_override
    except Exception:
        _get_override = None
    entry = None
    if _get_override is not None:
        try:
            entry = _get_override(user_id, conversation_id)
        except Exception:
            return "plan", None
    if not isinstance(entry, dict):
        return None, None
    mode = entry.get("mode")
    if mode not in ("plan", "edit"):
        return None, None
    return mode, entry.get("set_at")


def _any_plan_override(user_id):
    """True when the educator holds a plan override in any conversation.

    Lazy import, like _conversation_override. Any failure counts as
    True: an override store that cannot be read may hold a plan
    override.
    """
    try:
        from settings.store import has_plan_override as _has
    except Exception:
        return False
    try:
        return bool(_has(user_id))
    except Exception:
        return True


def _observe_conversation(user_id, conversation_id):
    """End edit state left over from other conversations (see
    settings.store.observe_conversation). Never raises: an unreadable
    store already resolves to plan."""
    if not conversation_id:
        return
    try:
        from settings.store import observe_conversation as _observe
        _observe(user_id, conversation_id)
    except Exception:
        pass


def _newest_authority(user_id, conversation_id, now):
    """Most-recent-wins authority among the educator's explicit
    actions for this conversation: the settings conversation override
    vs the live conversation grant.

    Returns (winner_kind, winner_mode, grant, override_mode):
      - winner_kind "override": the override is newer (or the only
        action); winner_mode is the override's mode, grant is the live
        grant or None.
      - winner_kind "grant": the live grant is newer; winner_mode is
        "edit", grant is the live grant dict.
      - (None, None, None, override_mode): neither action applies;
        override_mode is still reported for callers that care.

    current_mode and authorize_write MUST both use this: they are the
    same decision, and any divergence is a safety defect (a write
    admitted under an older action the resolver says is superseded).
    """
    candidates = []  # (stamp, specificity, kind)
    if not conversation_id and _any_plan_override(user_id):
        # A plan override exists but this caller named no conversation,
        # so it cannot be matched: fail safe to plan.
        return ("override", "plan", None, "plan")
    override_mode, override_at = _conversation_override(
        user_id, conversation_id)
    if override_mode is not None:
        try:
            stamp = _parse_time(override_at) if override_at else now
        except ModeSettingsTamper:
            stamp = now
        # Specificity 1 beats a grant's 0 on equal timestamps: the
        # explicit per-conversation override is the safe direction when
        # it says "plan".
        candidates.append((stamp, 1, "override"))
    grant = _live_grant(user_id, now, conversation_id)
    if grant is not None:
        try:
            stamp = _parse_time(grant.get("granted_at")) \
                if grant.get("granted_at") else now
        except ModeSettingsTamper:
            stamp = now
        # (stamp, specificity, kind): on equal timestamps the explicit
        # per-conversation override wins, which is the safe direction
        # when it says "plan".
        candidates.append((stamp, 0, "grant"))
    if not candidates:
        return (None, None, None, override_mode)
    candidates.sort(key=lambda c: (c[0], c[1]))
    winner = candidates[-1][2]
    if winner == "override":
        return ("override", override_mode, grant, override_mode)
    return ("grant", "edit", grant, override_mode)


def current_mode(user_id, conversation_id=None):
    """Effective mode for user_id: "edit" or "plan".

    THE authoritative resolver (settings.effective_mode delegates
    here). Most-recent-wins among the educator's explicit actions:
      1. a settings conversation override for this conversation,
      2. a live conversation grant applying to this conversation,
    then the educator's standing default_mode setting ("edit" only
    when the educator set it), else "plan".

    Raises ModeSettingsTamper when the grant file or a stored setting
    value fails validation (fail closed).
    """
    _validate_user_id(user_id)
    now = _utcnow()
    winner_kind, winner_mode, grant, _override_mode = _newest_authority(
        user_id, conversation_id, now)
    if winner_kind is not None:
        return winner_mode
    if _standing_edit_default(user_id):
        return "edit"
    return "plan"


def request_edit_grant(user_id, scope_type="conversation",
                       educator_confirmation=None, conversation_id=None):
    """Create an educator-granted edit-mode grant for user_id.

    scope_type: "conversation" ("use edit mode for this conversation")
    is the only grantable scope. It has no expiry and lives until
    revoked. conversation_id binds the grant to one conversation; an
    unbound grant applies everywhere. Bare "use edit mode" is not a
    grant: it sets default_mode="edit" in settings.

    educator_confirmation is required: {"by": "educator",
    "authorization": "<verbatim educator utterance, non-empty>",
    "channel": "educator-chat" | "driver"}. Without it (or with a
    non-educator confirmation) this raises ModeSelfGrantRefused: the
    agent must never promote itself to edit mode.

    A new grant supersedes live ones (they are revoked with reason
    "superseded", journaled). Returns the grant record.
    """
    _validate_user_id(user_id)
    if scope_type not in _SCOPE_TYPES:
        raise ValueError(
            "scope_type must be 'conversation' (edit mode is not timed, "
            "and standing edit mode comes from the educator's "
            "default_mode setting, not a grant); got %r" % (scope_type,))
    educator = _require_educator_confirmation(educator_confirmation)
    now = _utcnow()
    grant_id = uuid.uuid4().hex
    if conversation_id is not None:
        conversation_id = str(conversation_id)
    with _locked(user_id):
        state = _load_state(user_id)
        revision = int(state.get("revision", 0)) + 1
        superseded = []
        for g in state["grants"]:
            if isinstance(g, dict) and _is_live(g, now):
                g["revoked"] = True
                g["revoked_at"] = _iso(now)
                g["revoke_reason"] = "superseded by grant %s" % grant_id
                superseded.append(dict(g))
        grant = {
            "grant_id": grant_id,
            "revision": revision,
            "scope_type": scope_type,
            "conversation_id": conversation_id,
            "educator_identity": educator,
            "source_utterance": educator["authorization"],
            "granted_at": _iso(now),
            "expires_at": None,
            "revoked": False,
            "revoked_at": None,
            "revoke_reason": None,
        }
        state["revision"] = revision
        state["grants"].append(grant)
        _save_state(user_id, state)
    try:
        journal_event("mode.grant_issued", {
            "user_id": user_id,
            "grant_id": grant_id,
            "grant_revision": revision,
            "scope_type": scope_type,
            "conversation_id": conversation_id,
            "educator_identity": educator,
            "granted_at": grant["granted_at"],
            "source_utterance": educator["authorization"],
        })
        for old in superseded:
            journal_event("mode.grant_revoked", {
                "user_id": user_id,
                "grant_id": old.get("grant_id"),
                "grant_revision": old.get("revision"),
                "scope_type": old.get("scope_type"),
                "educator_identity": old.get("educator_identity"),
                "reason": "superseded by grant %s" % grant_id,
            })
    except Exception:
        # A grant that is not journaled must not stay live: roll it
        # back before surfacing the journal failure.
        with _locked(user_id):
            state = _load_state(user_id)
            for g in state["grants"]:
                if (isinstance(g, dict)
                        and g.get("grant_id") == grant_id):
                    g["revoked"] = True
                    g["revoked_at"] = _iso(_utcnow())
                    g["revoke_reason"] = "journal_failed"
            _save_state(user_id, state)
        raise
    return dict(grant)


def revoke_edit_grant(user_id, reason="revoked", grant_id=None,
                      conversation_id=None, scope_type=None,
                      unbound_only=False, except_conversation_id=None):
    """Revoke live grants for user_id.

    Filters combine: grant_id names one grant; conversation_id keeps
    only grants bound to that conversation; except_conversation_id keeps
    only grants bound to a DIFFERENT conversation; scope_type keeps only
    grants of that scope; unbound_only
    keeps only grants with no conversation binding. With no filters,
    every live grant is revoked. Idempotent: revoking when nothing is
    live returns 0 and journals nothing. Returns the number revoked.
    """
    _validate_user_id(user_id)
    now = _utcnow()
    revoked = []
    with _locked(user_id):
        state = _load_state(user_id)
        for g in state["grants"]:
            if not isinstance(g, dict):
                continue
            if grant_id is not None and g.get("grant_id") != grant_id:
                continue
            if scope_type is not None and g.get("scope_type") != scope_type:
                continue
            bound = g.get("conversation_id")
            if conversation_id is not None:
                if not (bound is not None
                        and str(bound) == str(conversation_id)):
                    continue
            elif unbound_only and bound is not None:
                continue
            if except_conversation_id is not None and (
                    bound is None
                    or str(bound) == str(except_conversation_id)):
                continue
            if _is_live(g, now):
                g["revoked"] = True
                g["revoked_at"] = _iso(now)
                g["revoke_reason"] = str(reason)
                revoked.append(dict(g))
        if revoked:
            _save_state(user_id, state)
    for g in revoked:
        journal_event("mode.grant_revoked", {
            "user_id": user_id,
            "grant_id": g.get("grant_id"),
            "grant_revision": g.get("revision"),
            "scope_type": g.get("scope_type"),
            "educator_identity": g.get("educator_identity"),
            "reason": str(reason),
        })
    return len(revoked)


def switch_mode(user_id, mode, conversation_id=None, educator=None):
    """Switch the user to plan mode. Only "plan" is accepted.

    Plan means plan everywhere: every live grant is revoked, every
    per-conversation override for the user is cleared, and a standing
    default_mode of "edit" is set back to "plan" (journaled in the
    settings audit). Turning edit off is the safe direction, so it
    needs no confirmation round trip. Switching to "edit" raises
    ModeSelfGrantRefused: the agent cannot promote itself to edit
    mode.

    Returns {"mode": <effective mode after the switch>,
    "revoked_grants": n, "overrides_cleared": n,
    "default_mode_changed": bool}. "mode" is re-resolved, never
    assumed, so a caller reports what is actually in force.
    """
    _validate_user_id(user_id)
    if mode != "plan":
        raise ModeSelfGrantRefused(
            "the agent cannot switch a user to edit mode; edit mode is "
            "educator-granted only (request_edit_grant with an "
            "educator-issued confirmation, or the educator's standing "
            "default_mode in settings)")
    count = revoke_edit_grant(user_id, reason="switch_mode:plan")
    try:
        from settings.store import (
            clear_conversation_overrides as _clear_overrides)
    except Exception:
        _clear_overrides = None
    cleared = _clear_overrides(user_id, educator=educator) \
        if _clear_overrides else 0
    default_changed = False
    if _standing_edit_default(user_id):
        _, set_setting = _settings_fns()
        set_setting(user_id, "default_mode", "plan",
                    educator_confirmed=True, educator=educator)
        default_changed = True
    journal_event("mode.switched_to_plan", {
        "user_id": user_id,
        "revoked_grants": count,
        "overrides_cleared": cleared,
        "default_mode_changed": default_changed,
        "conversation_id": conversation_id,
    })
    return {"mode": current_mode(user_id, conversation_id),
            "revoked_grants": count,
            "overrides_cleared": cleared,
            "default_mode_changed": default_changed}


def _resolution_signals(resolution):
    """(confidence, user_confirmed) from a course-resolution dict."""
    if not isinstance(resolution, dict):
        return 0.0, False
    try:
        confidence = float(resolution.get("confidence", 0.0))
    except (TypeError, ValueError):
        confidence = 0.0
    return confidence, bool(resolution.get("user_confirmed", False))


def authorize_write(user_id, course_id=None, resolution=None,
                  conversation_id=None, observe=True):
    """Decide write authority and return the auth context.

    Returns (decision, reason_code, auth_ctx):
      ("allow", "ok", ctx)   edit mode (live grant or standing) and the
                             course target is unambiguous.
      ("refuse", "ambiguous_course", ctx) resolution confidence below
                             0.9 without user confirmation: never write
                             on a guessed course.
      ("defer", "plan_mode_approval_required", None) plan mode: the
                             caller must run the frozen-plan +
                             educator-signed v2 approval path. A
                             grant that ended (revoked, or a legacy
                             timed grant) is simply plan mode here.

    conversation_id scopes conversation grants: a grant bound to a
    different conversation does not authorize writes here.

    observe=False (a dry run) decides the same way but changes nothing:
    other conversations' edit state is not ended and nothing is
    journaled. Ending another conversation's edit state never changes
    this conversation's decision, so the answer is identical.

    check_write_authority is the 2-tuple wrapper; the admission hook
    uses this form for the audit block and usage journaling.
    """
    _validate_user_id(user_id)
    if observe:
        _observe_conversation(user_id, conversation_id)
    now = _utcnow()
    # THE critical invariant: admission uses the same most-recent-wins
    # authority as current_mode, via _newest_authority. A newer
    # conversation override defeats an older live grant (and vice
    # versa); admission never consults the grant alone.
    winner_kind, winner_mode, grant, _override_mode = _newest_authority(
        user_id, conversation_id, now)
    if winner_kind == "override" and winner_mode == "edit":
        # The educator's newer per-conversation edit override: explicit
        # educator-confirmed authority with no grant record. Admit with
        # override-sourced auth context.
        auth = {
            "scope_type": "conversation_override",
            "grant_id": None,
            "grant_revision": None,
            "educator_identity": {
                "by": "educator",
                "authorization": "educator-confirmed per-conversation "
                               "edit override",
                "channel": "educator-chat",
            },
            "conversation_id": conversation_id,
        }
    elif winner_kind == "grant":
        auth = {
            "scope_type": grant["scope_type"],
            "grant_id": grant["grant_id"],
            "grant_revision": grant.get("revision"),
            "educator_identity": grant["educator_identity"],
            "conversation_id": grant.get("conversation_id"),
        }
    elif winner_kind is None and _standing_edit_default(user_id):
        auth = {
            "scope_type": "standing",
            "grant_id": None,
            "grant_revision": None,
            "educator_identity": {
                "by": "educator",
                "authorization": None,
                "channel": "settings",
                "note": "standing default_mode='edit' set by the "
                        "educator in settings",
            },
            "conversation_id": None,
        }
    else:
        return ("defer", "plan_mode_approval_required", None)
    if resolution is not None:
        confidence, user_confirmed = _resolution_signals(resolution)
        if not user_confirmed and confidence < CONFIDENCE_THRESHOLD:
            return ("refuse", "ambiguous_course", auth)
    return ("allow", "ok", auth)


def check_write_authority(user_id, course_id=None, resolution=None,
                          conversation_id=None):
    """Decide write authority for one write: (decision, reason_code).

    See authorize_write for the decision table. resolution is an
    optional dict {course_id, confidence (0..1), user_confirmed (bool),
    query, candidates_public}: when provided with confidence below 0.9
    and without user confirmation, the write is refused as ambiguous
    rather than written to a guessed course. The dispatcher should
    supply the resolution whenever it has one. conversation_id scopes
    conversation grants.
    """
    decision, code, _ = authorize_write(user_id, course_id, resolution,
                                        conversation_id)
    return decision, code


# ---------------------------------------------------------------------------
# Journaling (tree journal via the executor's journal_append)
# ---------------------------------------------------------------------------

def journal_event(event, payload):
    """Append a mode audit event to the tree journal.

    Uses the executor's journal_append: same lock, same HMAC-sealed
    JSONL journal as every other dispatch audit record. Every event
    carries the educator identity binding where one exists.
    """
    record = {"wal": "audit", "event": event}
    record.update(payload or {})
    try:
        from dispatch.executor import journal_append
    except ImportError:  # run with dispatch/ itself on sys.path
        from executor import journal_append
    journal_append(record)


def journal_write_admitted(auth, entry_name, course_id, op_id, user_id,
                           resolution=None):
    """Journal one edit-mode write admitted under a grant (or standing)."""
    payload = {
        "user_id": user_id,
        "entry": entry_name,
        "course_id": course_id,
        "op_id": op_id,
        "scope_type": auth.get("scope_type"),
        "grant_id": auth.get("grant_id"),
        "grant_revision": auth.get("grant_revision"),
        "educator_identity": auth.get("educator_identity"),
    }
    if resolution is not None:
        confidence, confirmed = _resolution_signals(resolution)
        payload["course_confidence"] = confidence
        payload["course_user_confirmed"] = confirmed
    journal_event("mode.write_admitted", payload)


def journal_write_refused(user_id, entry_name, course_id, op_id, code,
                          detail, auth=None, resolution=None):
    """Journal one write the mode gate refused."""
    payload = {
        "user_id": user_id,
        "entry": entry_name,
        "course_id": course_id,
        "op_id": op_id,
        "reason_code": code,
        "detail": detail,
    }
    if auth:
        payload["scope_type"] = auth.get("scope_type")
        payload["grant_id"] = auth.get("grant_id")
        payload["grant_revision"] = auth.get("grant_revision")
        payload["educator_identity"] = auth.get("educator_identity")
    if resolution is not None:
        confidence, confirmed = _resolution_signals(resolution)
        payload["course_confidence"] = confidence
        payload["course_user_confirmed"] = confirmed
        if isinstance(resolution, dict):
            payload["course_query"] = resolution.get("query")
    journal_event("mode.write_refused", payload)
