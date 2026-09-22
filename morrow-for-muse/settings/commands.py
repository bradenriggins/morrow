#!/usr/bin/env python3
"""Typed mode and settings commands for Morrow for Muse (WORKSTREAM B).

The Muse agent reads what the educator said, decides what they mean, and
calls one of these commands. No free text reaches this module: every
input is a typed argument (a mode name, a setting key, a value, a
conversation id). A command takes effect when it is called; there is
no confirmation round trip, because the agent calls it only when the
educator asked for the change. Every change is journaled, and the
result states the true resulting state for the agent to relay.

The mode model is simple: the ONLY difference between plan and edit mode
is whether writes surface approval. Plan mode: writes require approval.
Edit mode: they do not. Reads are unrestricted in both modes.

Edit mode is ONE blanket grant with no time limit: it stays on until the
educator turns it off. Turning it off means plan everywhere.

Commands (Python API, and the same shapes on the CLI below):
  mode_status(user_id, conversation_id)
      The effective mode right now and where it comes from.
  mode_set(user_id, "plan")
      Edit off everywhere: default_mode plan, every grant revoked, every
      per-conversation override cleared. Applies at once.
  mode_set(user_id, "plan", conversation_id, this_conversation=True)
      A plan override for this conversation only. Applies at once.
  mode_set(user_id, "edit")
      The standing edit grant (default_mode edit): writes apply without
      asking until edit mode is turned off.
  mode_set(user_id, "edit", conversation_id, this_conversation=True)
      An edit override for this conversation only. It ends when the
      educator turns edit off, when the
      conversation ends, or when Morrow sees a different conversation
      for this educator.
  settings_show(user_id, conversation_id)
  setting_get(user_id, key)
  setting_set(user_id, key, value)

Every command returns a dict:
  {"ok": bool, "status": "done" | "error", "mode": <effective mode after the command>, "message": <a
   sentence for the agent to relay, built from the state AFTER the
   change, never assumed>, ...}

CLI:
  python3 settings/commands.py mode status --user-id U [--conversation-id C]
  python3 settings/commands.py mode set plan|edit --user-id U
          [--conversation-id C] [--this-conversation]
  python3 settings/commands.py settings show --user-id U [--conversation-id C]
  python3 settings/commands.py settings get KEY --user-id U
  python3 settings/commands.py settings set KEY VALUE --user-id U
  (bin/morrow mode ... and bin/morrow settings ... run the same thing.)
  --user-id defaults to MORROW_USER_ID and --conversation-id to
  MORROW_CONVERSATION_ID. Output is one JSON object; exit 0 when ok.

No em dashes anywhere in the messages: commas, colons, or parentheses
only.

Stdlib only.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                ".."))
from modes import state as mode_state  # noqa: E402
from settings.store import (  # noqa: E402
    SETTINGS_SCHEMA,
    SettingsCorrupt,
    SettingsError,
    SettingsTamperRefused,
    SettingsValidationError,
    _audit_path,
    _settings_path,
    effective_mode,
    ended_conversation_override,
    get_conversation_mode,
    has_plan_override,
    live_conversation_overrides,
    get_setting,
    list_settings,
    observe_conversation,
    set_conversation_mode,
    set_setting,
)

_SETTING_LABELS = {
    "default_mode": "Default mode",
    "verbosity": "Verbosity",
    "confirm_destructive_writes": "Deletion confirmations",
    "write_approval_style": "Write approval style",
    "failure_verbosity": "Failure report detail",
    "proactivity": "Proactivity",
    "read_confirmations": "Read confirmations",
    "auto_cleanup_test_objects": "Auto-clean test objects",
    "confirm_bulk_actions": "Bulk action confirmations",
    "default_course_id": "Default course",
    "timezone": "Timezone",
    "work_summary": "Work summary detail",
}

_NOT_TIMED = ("Edit mode has no time limit: it stays on until you turn it "
              "off.")


def _friendly_value(key, value):
    if key == "write_approval_style":
        return {"per_write": "one per write",
                "batched": "batched"}.get(value, value)
    if isinstance(value, bool):
        return "on" if value else "off"
    if isinstance(value, str) and value == "" and key in (
            "default_course_id", "timezone"):
        return "none set"
    return value


def _safe_mode(user_id, conversation_id):
    """Effective mode, or "plan" when state cannot be read (fail closed)."""
    try:
        return effective_mode(user_id, conversation_id)
    except Exception:
        return "plan"


def _repair_hint(user_id):
    try:
        path, journal = _settings_path(user_id), _audit_path(user_id)
    except Exception:
        path, journal = "your settings file", "its journal"
    return ("Your settings file did not pass its integrity check, so Morrow "
            "does not trust it and treats you as in plan mode. To repair "
            "it, restore %s from backup, or delete it and %s together to "
            "start fresh with default settings." % (path, journal))


def _destructive_note(user_id):
    """How destructive writes behave in edit mode, stated from the setting."""
    try:
        guard = get_setting(user_id, "confirm_destructive_writes")
        changed = bool(list_settings(user_id)
                       ["confirm_destructive_writes"]["changed"])
    except Exception:
        return ("I could not read your deletion-confirmation setting, so "
                "check it with 'settings show' before relying on it.")
    if guard:
        return ("Deletion confirmations are on, so deletes and other "
                "destructive writes will still ask you first.")
    origin = "you turned them off" if changed else "that is the default"
    return ("Deletion confirmations are off (%s), so deletes and other "
            "destructive writes will not ask either. You can turn "
            "deletion confirmations on at any time." % origin)


def _edit_sources(user_id, conversation_id):
    why = []
    try:
        override = get_conversation_mode(user_id, conversation_id) \
            if conversation_id else None
    except Exception:
        override = None
    if override == "edit":
        why.append("your edit override for this conversation")
    try:
        grant = mode_state._live_grant(user_id,
                                       conversation_id=conversation_id)
    except Exception:
        grant = None
    if grant is not None:
        why.append("the edit grant you gave for this conversation")
    try:
        if get_setting(user_id, "default_mode") == "edit":
            why.append("your saved default")
    except Exception:
        pass
    return why


def _ended_override_note(user_id, conversation_id):
    """A sentence for an override that ended when the educator changed
    the saved default after setting it, or ""."""
    try:
        ended = ended_conversation_override(user_id, conversation_id) \
            if conversation_id else None
    except Exception:
        ended = None
    if not ended:
        return ""
    return (" Your older %s override for this conversation ended when you "
            "changed your saved default after it." % ended.get("mode"))


def _status_message(user_id, conversation_id, mode):
    ended = _ended_override_note(user_id, conversation_id)
    if mode == "plan":
        sentence = ("You are in plan mode right now: writes ask for your "
                    "approval, reads never need it.")
        try:
            override = get_conversation_mode(user_id, conversation_id) \
                if conversation_id else None
            default = get_setting(user_id, "default_mode")
            other_plan = (not conversation_id) and has_plan_override(user_id)
        except SettingsCorrupt:
            return sentence + " " + _repair_hint(user_id)
        except Exception:
            return sentence
        if override == "plan":
            sentence += (" That comes from your plan override for this "
                         "conversation. Your saved default is %s mode."
                         % default)
        elif other_plan:
            sentence += (" This request named no conversation, and you set "
                         "plan mode for another conversation, so I cannot "
                         "tell this is not that conversation. Your saved "
                         "default is %s mode." % default)
        else:
            sentence += " That comes from your saved default."
        return sentence + ended
    why = _edit_sources(user_id, conversation_id) or ["your saved default"]
    return ("You are in edit mode right now: writes do not ask for "
            "approval, reads never need it. That comes from %s, and it "
            "stays on until you turn it off.%s %s"
            % (" and ".join(why), ended, _destructive_note(user_id)))


def _result(status, user_id, conversation_id, message, **extra):
    out = {"ok": status != "error", "status": status,
           "mode": _safe_mode(user_id, conversation_id),
           "message": message}
    out.update(extra)
    return out


def _error(user_id, conversation_id, message, **extra):
    return _result("error", user_id, conversation_id, message, **extra)


def _observe(user_id, conversation_id):
    """End edit overrides left over from other conversations."""
    if not conversation_id:
        return
    try:
        observe_conversation(user_id, conversation_id)
    except Exception:
        # A tampered or unreadable store already resolves to plan.
        pass


# ---------------------------------------------------------------------------
# Mode commands
# ---------------------------------------------------------------------------

def mode_status(user_id, conversation_id=None):
    """The effective mode right now, and where it comes from."""
    _observe(user_id, conversation_id)
    mode = _safe_mode(user_id, conversation_id)
    try:
        default = get_setting(user_id, "default_mode")
        override = get_conversation_mode(user_id, conversation_id) \
            if conversation_id else None
        tampered = False
    except SettingsCorrupt:
        default, override, tampered = None, None, True
    except Exception:
        default, override, tampered = None, None, False
    return _result("done", user_id, conversation_id,
                   _status_message(user_id, conversation_id, mode),
                   default_mode=default, conversation_override=override,
                   settings_untrusted=tampered)


def _plan_everywhere(user_id, conversation_id, educator):
    try:
        mode_state.switch_mode(user_id, "plan",
                               conversation_id=conversation_id,
                               educator=educator)
    except SettingsCorrupt:
        # Grants were revoked before the settings file refused to load;
        # an untrusted settings file resolves to plan.
        mode = _safe_mode(user_id, conversation_id)
        if mode == "plan":
            return _result(
                "done", user_id, conversation_id,
                "Edit mode is off: you are in plan mode now, so every "
                "write will ask for your approval. " + _repair_hint(user_id),
                settings_untrusted=True)
        return _error(user_id, conversation_id,
                      "I could not turn edit mode off completely. "
                      + _repair_hint(user_id), settings_untrusted=True)
    mode = _safe_mode(user_id, conversation_id)
    if mode == "plan":
        return _result(
            "done", user_id, conversation_id,
            "Done: you are in plan mode now. Edit mode is off in every "
            "conversation and as your default, so every write will ask "
            "for your approval before it runs. Reads still never need "
            "approval.")
    why = _edit_sources(user_id, conversation_id)
    held = (" by %s" % " and ".join(why)) if why else ""
    return _error(
        user_id, conversation_id,
        "I turned off every edit grant I could, but you are still in edit "
        "mode, held on%s. Writes will not ask for approval until that is "
        "cleared." % held)


def mode_set(user_id, mode, conversation_id=None, this_conversation=False,
             educator=None):
    """Set the educator's mode. See the module docstring for the table."""
    if mode not in ("plan", "edit"):
        return _error(user_id, conversation_id,
                      "Mode must be 'plan' or 'edit'; nothing changed.")
    if this_conversation and not conversation_id:
        return _error(user_id, conversation_id,
                      "A mode for this conversation needs the conversation "
                      "id; nothing changed.")
    _observe(user_id, conversation_id)
    if mode == "plan" and not this_conversation:
        return _plan_everywhere(user_id, conversation_id, educator)
    if mode == "plan":
        try:
            set_conversation_mode(user_id, conversation_id, "plan",
                                  educator=educator)
        except SettingsCorrupt:
            return _result("done", user_id, conversation_id,
                           "You are in plan mode. " + _repair_hint(user_id),
                           settings_untrusted=True)
        return _result(
            "done", user_id, conversation_id,
            "Done: for this conversation you are in %s mode. %s"
            % (_safe_mode(user_id, conversation_id),
               _status_message(user_id, conversation_id,
                               _safe_mode(user_id, conversation_id))))
    # The agent calls this because the educator asked for edit mode.
    try:
        ended = [] if this_conversation else sorted(
            live_conversation_overrides(user_id))
    except Exception:
        ended = []
    try:
        if this_conversation:
            set_conversation_mode(user_id, conversation_id, "edit",
                                  educator_confirmed=True, educator=educator)
        else:
            set_setting(user_id, "default_mode", "edit",
                        educator_confirmed=True, educator=educator)
    except SettingsCorrupt:
        return _error(user_id, conversation_id,
                      "Edit mode was not turned on. " + _repair_hint(user_id),
                      settings_untrusted=True)
    now = _safe_mode(user_id, conversation_id)
    if now != "edit":
        return _error(user_id, conversation_id,
                      "Edit mode did not take effect: " + _status_message(
                          user_id, conversation_id, now))
    where = ("in this conversation, until you turn edit mode off, this "
             "conversation ends, or you start a different conversation"
             if this_conversation else
             "in every conversation, until you turn edit mode off%s"
             % (" (the per-conversation mode you had set in %d "
                "conversation%s has ended)"
                % (len(ended), "" if len(ended) == 1 else "s")
                if ended else ""))
    return _result(
        "done", user_id, conversation_id,
        "Done: you are in edit mode now. Writes apply without asking you "
        "first %s. %s %s Reads never need approval. This change is "
        "journaled. %s" % (where, _NOT_TIMED, _destructive_note(user_id),
                           _status_message(user_id, conversation_id, now)))


# ---------------------------------------------------------------------------
# Settings commands
# ---------------------------------------------------------------------------

def settings_show(user_id, conversation_id=None):
    try:
        items = list_settings(user_id)
    except SettingsCorrupt:
        return _error(user_id, conversation_id, _repair_hint(user_id),
                      settings_untrusted=True)
    mode = _safe_mode(user_id, conversation_id)
    lines = ["You are in %s mode right now. Your settings:" % mode]
    for key, info in items.items():
        marker = "" if info["changed"] else " (default)"
        lines.append("- %s: %s%s" % (_SETTING_LABELS.get(key, key),
                                      _friendly_value(key, info["value"]),
                                      marker))
    try:
        override = get_conversation_mode(user_id, conversation_id) \
            if conversation_id else None
    except Exception:
        override = None
    if override:
        lines.append("- this conversation: %s mode override" % override)
    return _result("done", user_id, conversation_id, " ".join(lines),
                   settings={k: v["value"] for k, v in items.items()},
                   conversation_override=override)


def setting_get(user_id, key):
    if key not in SETTINGS_SCHEMA:
        return _error(user_id, None, "There is no setting named %r." % key)
    try:
        value = get_setting(user_id, key)
    except SettingsCorrupt:
        return _error(user_id, None, _repair_hint(user_id),
                      settings_untrusted=True)
    return _result("done", user_id, None, "%s is %s."
                   % (_SETTING_LABELS.get(key, key),
                      _friendly_value(key, value)), key=key, value=value)


def setting_set(user_id, key, value, educator=None, conversation_id=None):
    """Set one setting. default_mode goes through mode_set."""
    if key not in SETTINGS_SCHEMA:
        return _error(user_id, conversation_id,
                      "There is no setting named %r; nothing changed." % key)
    if key == "default_mode":
        return mode_set(user_id, value, conversation_id, educator=educator)
    label = _SETTING_LABELS.get(key, key)
    try:
        SETTINGS_SCHEMA[key]["validate"](value)
    except SettingsValidationError as exc:
        return _error(user_id, conversation_id,
                      "%s was not changed: %s." % (label, exc))
    try:
        # The agent calls this because the educator asked for the change.
        set_setting(user_id, key, value, educator_confirmed=True,
                    educator=educator)
        now = get_setting(user_id, key)
    except SettingsCorrupt:
        return _error(user_id, conversation_id,
                      "%s was not changed. %s" % (label,
                                                  _repair_hint(user_id)),
                      settings_untrusted=True)
    except (SettingsTamperRefused, SettingsError) as exc:
        return _error(user_id, conversation_id,
                      "%s was not changed: %s" % (label, exc))
    return _result("done", user_id, conversation_id,
                   "Done: %s is now %s. %s" % (
                       label, _friendly_value(key, now),
                       SETTINGS_SCHEMA[key]["description"]),
                   key=key, value=now)


def parse_setting_value(key, raw):
    """A CLI string as the typed value the schema wants for key.

    Booleans accept exactly "true"/"false"; every other setting is a
    string validated by the schema itself.
    """
    if key in SETTINGS_SCHEMA and isinstance(
            SETTINGS_SCHEMA[key]["default"], bool):
        if raw == "true":
            return True
        if raw == "false":
            return False
        raise SettingsValidationError(
            "%s takes true or false, got %r" % (key, raw))
    return raw


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _parser():
    p = argparse.ArgumentParser(
        prog="morrow",
        description="Typed Plan/Edit mode and settings commands. The agent "
                    "decides what the educator means and calls these.")
    sub = p.add_subparsers(dest="group", required=True)

    def ids(sp):
        sp.add_argument("--user-id", default=os.environ.get("MORROW_USER_ID"))
        sp.add_argument("--conversation-id",
                        default=os.environ.get("MORROW_CONVERSATION_ID"))

    mode = sub.add_parser("mode", help="show or set Plan/Edit mode")
    msub = mode.add_subparsers(dest="action", required=True)
    ids(msub.add_parser("status", help="the effective mode right now"))
    mset = msub.add_parser("set", help="set plan or edit")
    mset.add_argument("mode", choices=("plan", "edit"))
    mset.add_argument("--this-conversation", action="store_true",
                      help="only this conversation (needs --conversation-id)")
    ids(mset)

    st = sub.add_parser("settings", help="show, get, or set a setting")
    ssub = st.add_subparsers(dest="action", required=True)
    ids(ssub.add_parser("show", help="every setting and the mode"))
    sget = ssub.add_parser("get", help="one setting")
    sget.add_argument("key")
    ids(sget)
    sset = ssub.add_parser("set", help="change one setting")
    sset.add_argument("key")
    sset.add_argument("value")
    ids(sset)
    return p


def main(argv=None):
    args = _parser().parse_args(argv)
    if not args.user_id:
        print(json.dumps({"ok": False, "status": "error", "mode": "plan",
                          "message": "No user id: pass --user-id or set "
                                     "MORROW_USER_ID."}))
        return 2
    try:
        if args.group == "mode" and args.action == "status":
            out = mode_status(args.user_id, args.conversation_id)
        elif args.group == "mode":
            out = mode_set(args.user_id, args.mode, args.conversation_id,
                           this_conversation=args.this_conversation)
        elif args.action == "show":
            out = settings_show(args.user_id, args.conversation_id)
        elif args.action == "get":
            out = setting_get(args.user_id, args.key)
        else:
            try:
                value = parse_setting_value(args.key, args.value)
            except SettingsValidationError as exc:
                out = _error(args.user_id, args.conversation_id,
                             "Nothing changed: %s." % exc)
            else:
                out = setting_set(args.user_id, args.key, value,
                                  conversation_id=args.conversation_id)
    except SettingsError as exc:
        out = _error(args.user_id, args.conversation_id,
                     "Nothing changed: %s" % exc)
    print(json.dumps(out, sort_keys=True))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
