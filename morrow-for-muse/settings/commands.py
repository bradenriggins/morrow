#!/usr/bin/env python3
"""Conversational settings commands for Morrow for Muse (WORKSTREAM B).

Maps educator utterances to setting operations. Each parse returns a
structured op {action, key, value, needs_confirmation} plus a
plain-language sentence the agent speaks back to the educator.

The mode model is simple: the ONLY difference between plan and edit mode
is whether writes surface approval. Plan mode: writes require approval.
Edit mode: they do not. Reads are unrestricted in both modes.

Utterance mapping:
  "switch to plan mode"                  -> default_mode = plan (persisted)
  "switch to edit mode"                  -> default_mode = edit (persisted,
                                           the standing edit grant)
  "turn on edit mode" / "enable edit mode" -> default_mode = edit
  "turn off edit mode" / "disable edit mode" -> default_mode = plan
  "make edit mode my default"            -> default_mode = edit (persisted)
  "what is my default mode"              -> reports the saved default
  "use edit mode"                        -> default_mode = edit (standing,
                                           no time limit; Braden's model)
  "switch to edit mode for this conversation" -> conversation override
                                           (any verb; "chat" also works)
  "use plan mode for this conversation"  -> conversation override = plan
  "use edit mode for this conversation"  -> conversation override = edit
  "use plan mode" (bare)                 -> end session/override, back to
                                           default
  "end edit mode"                        -> end the edit session
  "set my edit sessions to 60 minutes"   -> edit_grant_duration_min = 60
  "stop asking me to confirm deletions"  -> confirm_destructive_writes = off
  "ask me before bulk actions"           -> confirm_bulk_actions = on
  "don't ask before bulk actions"        -> confirm_bulk_actions = off
  "my default course is 12345"           -> default_course_id = 12345
  "clear my default course"              -> default_course_id = ""
  "what is my default course"            -> reports the saved default
  "my timezone is Eastern"               -> timezone = America/New_York
  "set timezone to America/Denver"       -> timezone = America/Denver
  "clean up test objects when done"      -> auto_cleanup_test_objects = on
  "keep test objects"                    -> auto_cleanup_test_objects = off
  "keep work summaries brief"            -> work_summary = brief
  "give me full work summaries"          -> work_summary = full
  "be more concise"                      -> verbosity = concise
  "show me my settings"                  -> spoken settings summary
  "what mode am I in"                    -> effective mode, spoken
  "help" / "what can I change"           -> spoken list of everything

Consequential changes (anything that changes whether writes surface
approval, plus the destructive-writes guardrail) come back with
needs_confirmation=True: the agent must echo the confirmation sentence
to the educator and only proceed with educator_confirmed=True after the
educator says yes. is_confirmation() recognizes that yes.

No em dashes anywhere in spoken text: commas, colons, or parentheses
only.

Stdlib only.
"""

import re
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                ".."))
from settings.store import (  # noqa: E402
    EDIT_GRANT_DURATION_MAX,
    EDIT_GRANT_DURATION_MIN,
    SETTINGS_SCHEMA,
    edit_session_remaining,
    effective_mode,
    get_conversation_mode,
    get_setting,
    list_settings,
)


def _norm(text):
    text = (text or "").strip().lower()
    text = re.sub(r"[?!.,;:]+$", "", text)
    text = re.sub(r"\s+", " ", text)
    return text


def _minutes_sentence(minutes):
    return "1 minute" if minutes == 1 else "%d minutes" % minutes


def _session_duration_for(user_id):
    try:
        return get_setting(user_id, "edit_grant_duration_min")
    except Exception:
        return 30


def _destructive_note(user_id):
    """How destructive writes behave, for spoken echoes."""
    try:
        guard = get_setting(user_id, "confirm_destructive_writes")
    except Exception:
        guard = True
    if guard:
        return ("Deletes and other destructive writes will still ask for "
                "confirmation.")
    return ("You have turned off deletion confirmations, so destructive "
            "writes will not ask either.")


def _echo_default_mode(mode, user_id):
    if mode == "plan":
        return (
            "Switching your default mode to plan. Writes will surface "
            "approval again. Say 'yes' to confirm, or 'cancel'.")
    return (
        "Making edit mode your default. This is a standing edit grant, "
        "and it is journaled: from now on, writes will not surface "
        "approval. %s Say 'yes' to confirm, or 'cancel'."
        % _destructive_note(user_id))


def _echo_session(user_id):
    minutes = _session_duration_for(user_id)
    return (
        "Starting an edit session for the next %s: writes will not "
        "surface approval until it ends. %s Say 'yes' to confirm, or "
        "'cancel'." % (_minutes_sentence(minutes),
                       _destructive_note(user_id)))


def _echo_conversation(mode, user_id):
    try:
        default = get_setting(user_id, "default_mode")
    except Exception:
        default = "plan"
    if mode == "edit":
        return (
            "For this conversation only, switching to edit mode: writes "
            "will not surface approval here. Your saved default stays "
            "%s, and this ends when the conversation ends. Say 'yes' to "
            "confirm, or 'cancel'." % default)
    return (
        "For this conversation only, switching to plan mode: writes will "
        "surface approval here. Your saved default stays %s. Say 'yes' "
        "to confirm, or 'cancel'." % default)


def _echo_duration(user_id, minutes):
    return (
        "Setting your timed edit sessions to %s. This only affects "
        "explicitly requested timed sessions (e.g. 'edit for 30 "
        "minutes'); saying 'use edit mode' gives you the standing edit "
        "mode with no time limit. Say 'yes' to confirm, or "
        "'cancel'." % _minutes_sentence(minutes))


def _echo_destructive_off():
    return (
        "Turning off deletion confirmations. I will no longer ask before "
        "deletes or other destructive changes, even in edit mode. Say "
        "'yes' to confirm, or 'cancel'.")


def _echo_destructive_on():
    return (
        "Turning on deletion confirmations. Deletes and other destructive "
        "writes will ask for confirmation even in edit mode. Say 'yes' "
        "to confirm, or 'cancel'.")


def _echo_default_course(course_id):
    if course_id:
        return (
            "Setting your default course to %s. When you do not name a "
            "course, I will start here without an extra check, as long as "
            "it is unambiguous. Say 'yes' to confirm, or 'cancel'."
            % course_id)
    return (
        "Clearing your default course. When you do not name a course, I "
        "will ask which one you mean. Say 'yes' to confirm, or 'cancel'.")


def _echo_bulk_off():
    return (
        "Turning off bulk-action confirmations. Mass messages and bulk "
        "edits will no longer ask first, even in edit mode. Say 'yes' "
        "to confirm, or 'cancel'.")


def _echo_bulk_on():
    return (
        "Turning on bulk-action confirmations. Actions that touch many "
        "students or items at once will ask for confirmation first, "
        "even in edit mode. Say 'yes' to confirm, or 'cancel'.")


_COMMON_TIMEZONES = {
    "eastern": "America/New_York", "et": "America/New_York",
    "central": "America/Chicago", "ct": "America/Chicago",
    "mountain": "America/Denver", "mt": "America/Denver",
    "pacific": "America/Los_Angeles", "pt": "America/Los_Angeles",
    "alaska": "America/Anchorage", "ak": "America/Anchorage",
    "hawaii": "Pacific/Honolulu", "ht": "Pacific/Honolulu",
    "utc": "UTC", "gmt": "UTC",
}


def _canonical_timezone(raw):
    """Map a human timezone phrase to an IANA name, or None.

    Accepts common US names ("Eastern") and IANA names in any case
    ("america/denver" -> "America/Denver"). The store validator then
    enforces the IANA name strictly.
    """
    cand = (raw or "").strip().strip("'\"")
    if not cand:
        return None
    low = cand.lower()
    if low in _COMMON_TIMEZONES:
        return _COMMON_TIMEZONES[low]
    try:
        from zoneinfo import available_timezones
        zones = available_timezones()
    except ImportError:
        return None
    if cand in zones:
        return cand
    return {z.lower(): z for z in zones}.get(low)


def _extract_timezone(text):
    """Pull the timezone phrase out of the educator's raw utterance."""
    if not text:
        return None
    m = re.search(r"time\s*zones?\s*(?:is|:|to|as)?\s*"
                  r"([A-Za-z_][A-Za-z0-9_/\-+']*)",
                  text, re.IGNORECASE)
    if not m:
        return None
    return _canonical_timezone(m.group(1))


def _status_sentence(user_id, conversation_id):
    try:
        mode = effective_mode(user_id, conversation_id)
    except Exception:
        return ("I could not read your settings just now. Say 'show me my "
                "settings' and I will try again.")
    try:
        default = get_setting(user_id, "default_mode")
    except Exception:
        default = "plan"
    left = edit_session_remaining(user_id, conversation_id)
    override = get_conversation_mode(user_id, conversation_id) \
        if conversation_id else None
    if mode == "plan":
        base = ("You are in plan mode right now: writes surface approval, "
                "reads never need it.")
    else:
        base = ("You are in edit mode right now: writes do not surface "
                "approval, reads never need it.")
    why = []
    if left > 0:
        mins = max(1, int(round(left / 60.0)))
        why.append("a timed edit session with about %s left"
                   % _minutes_sentence(mins))
    if override:
        why.append("your per-conversation override")
    if not why:
        why.append("your saved default")
    sentence = "%s That comes from %s." % (base, " and ".join(why))
    if mode != default or left > 0 or override:
        sentence += " Your saved default is %s mode." % default
    return sentence


_SETTING_LABELS = {
    "default_mode": "Default mode",
    "edit_grant_duration_min": "Edit session length",
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


def _friendly_value(key, value):
    if key == "edit_grant_duration_min":
        return _minutes_sentence(value) if isinstance(value, int) else value
    if key == "write_approval_style":
        return {"per_write": "one per write",
                "batched": "batched"}.get(value, value)
    if isinstance(value, bool):
        return "on" if value else "off"
    if isinstance(value, list):
        return ", ".join(value) if value else "none set"
    if isinstance(value, str) and value == "" and key in (
            "default_course_id", "timezone"):
        return "none set"
    return value


def _show_sentence(user_id, conversation_id):
    if not user_id:
        return ("I need to know whose settings to show before I can list "
                "them.")
    try:
        items = list_settings(user_id)
        mode = effective_mode(user_id, conversation_id)
    except Exception:
        return ("I could not read your settings just now. Try again in a "
                "moment.")
    lines = ["You are in %s mode right now. Your settings:" % mode]
    for key, info in items.items():
        marker = "" if info["changed"] else " (default)"
        label = _SETTING_LABELS.get(key, key)
        value = _friendly_value(key, info["value"])
        lines.append("- %s: %s%s" % (label, value, marker))
    left = edit_session_remaining(user_id, conversation_id)
    if left > 0:
        lines.append("- edit session: active, about %s left (not a saved "
                     "setting)" % _minutes_sentence(max(1, int(round(left / 60.0)))))
    override = get_conversation_mode(user_id, conversation_id) \
        if conversation_id else None
    if override:
        lines.append("- this conversation: %s mode override (not saved)"
                     % override)
    lines.append("Say 'use edit mode', 'switch to plan mode', or 'set my "
                 "edit sessions to 60 minutes' to change anything.")
    return " ".join(lines)


_DURATION_PATTERNS = [
    # "set my edit sessions to 60 minutes"
    re.compile(r"edit\s+sessions?.*?(\d+)\s*(?:minutes?|mins?)\b"),
    # "set my edit grant duration to 45 minutes" (legacy phrasing)
    re.compile(r"edit\s+grant\s+(?:default\s+)?duration.*?(\d+)\s*"
               r"(?:minutes?|mins?)\b"),
]

# Bounds come from the store schema constants so the two can never drift.
_DURATION_MIN = EDIT_GRANT_DURATION_MIN
_DURATION_MAX = EDIT_GRANT_DURATION_MAX


def _parse_duration(text):
    for pat in _DURATION_PATTERNS:
        m = pat.search(text)
        if m:
            return int(m.group(1))
    return None


def _help_sentence():
    return (
        "Here is what you can ask me to change: 'use edit mode', 'make "
        "edit mode my default', 'switch to plan mode', 'use plan mode "
        "for this conversation', 'set my edit sessions to 60 minutes', "
        "'stop asking me to confirm deletions', 'my default course is "
        "12345', 'my timezone is Eastern', 'ask me before bulk actions', "
        "'clean up test objects when done', 'keep work summaries brief', "
        "'show me my settings', 'what mode am I in', or 'be more "
        "concise'. Just say it in your own words.")


def parse_command(text, user_id=None, conversation_id=None):
    """Parse an educator utterance.

    Returns (op, reply) where op is
    {"action", "key", "value", "needs_confirmation"} and reply is the
    plain-language sentence the agent speaks back. Actions: "set" (a
    persisted setting), "session" (start a timed edit session),
    "conversation" (per-conversation override), "end_session" (back to
    default), "show", "status", "invalid", "unknown".

    needs_confirmation for "set" actions always comes from the schema's
    consequential flag, so the parser can never drift from it.
    """
    op, reply = _parse_command_inner(text, user_id, conversation_id)
    if op["action"] == "set" and op["key"] in SETTINGS_SCHEMA:
        op["needs_confirmation"] = bool(
            SETTINGS_SCHEMA[op["key"]]["consequential"])
    return op, reply


def _conversation_override_mode(t):
    """A (plan|edit) mode the educator scoped to this conversation.

    Accepts verb-first ("switch to edit mode for this conversation")
    and scope-first ("for this conversation, use plan mode") orders,
    and "chat" as well as "conversation".
    """
    m = re.search(r"\b(plan|edit)\s+mode\b.{0,40}\bfor\s+this\s+"
                  r"(conversation|chat)\b", t)
    if m:
        return m.group(1)
    m = re.search(r"\bfor\s+this\s+(conversation|chat)\b.{0,40}\b"
                  r"(plan|edit)\s+mode\b", t)
    if m:
        return m.group(2)
    return None


def _parse_command_inner(text, user_id=None, conversation_id=None):
    t = _norm(text)

    # --- per-conversation override (before bare "use edit mode") --------
    # Guard, not just the "use X mode for this conversation" phrasing:
    # "switch to edit mode for this conversation" must never fall
    # through to the persisted default (that would over-grant a standing
    # edit grant the educator did not ask for).
    conv_mode = _conversation_override_mode(t)
    if conv_mode:
        op = {"action": "conversation", "key": "conversation_mode",
              "value": conv_mode, "needs_confirmation": True}
        return op, _echo_conversation(conv_mode, user_id)

    # --- standing edit grant: bare "use edit mode" ----------------------
    # Braden's model: no time handcuffs. "use edit mode" grants the
    # standing edit mode (default_mode="edit"), not a timed session.
    # Timed sessions remain available via explicit duration settings.
    if re.search(r"\buse\s+edit\s+mode\b", t):
        op = {"action": "set", "key": "default_mode", "value": "edit",
              "needs_confirmation": True}
        return op, _echo_default_mode("edit", user_id)

    # --- back to default: "use plan mode" bare / "end edit mode" ---------
    if re.search(r"\buse\s+plan\s+mode\b", t) or \
            re.search(r"\b(end|stop|exit|leave)\b.{0,12}\bedit\s+"
                      r"(mode|session)\b", t) or \
            re.search(r"\bedit\s+session\b.{0,12}\b(end|over|stop)\b", t) or \
            re.search(r"\bback\s+to\s+plan\s+mode\b", t):
        op = {"action": "end_session", "key": "edit_session",
              "value": None, "needs_confirmation": False}
        reply = ("Done: any edit session or conversation override is "
                 "ended. You are back on your saved default.")
        return op, reply

    # --- "what is my default mode" --------------------------------------
    if re.search(r"\bdefault\s+mode\b", t) and \
            re.search(r"\b(what|which|show|tell)\b", t):
        try:
            default = get_setting(user_id, "default_mode") \
                if user_id else "plan"
        except Exception:
            default = "plan"
        op = {"action": "status", "key": "default_mode", "value": None,
              "needs_confirmation": False}
        return op, ("Your saved default mode is %s." % default)

    # --- persisted default mode ------------------------------------------
    m = re.search(r"\b(switch|change|make|set|default|turn\s+on|turn\s+off|"
                  r"enable|disable|activate|deactivate)\b.{0,24}\b"
                  r"(plan|edit)\s+mode\b", t)
    if m and re.search(r"\bmode\b", t):
        verb = re.sub(r"\s+", " ", m.group(1))
        mode = m.group(2)
        # Negating verbs flip the named mode: "turn off edit mode"
        # means plan, "disable plan mode" means edit.
        if verb in ("turn off", "disable", "deactivate"):
            mode = "plan" if mode == "edit" else "edit"
        op = {"action": "set", "key": "default_mode", "value": mode,
              "needs_confirmation": True}
        return op, _echo_default_mode(mode, user_id)

    # --- edit session duration --------------------------------------------
    minutes = _parse_duration(t)
    if minutes is not None:
        if minutes < _DURATION_MIN or minutes > _DURATION_MAX:
            op = {"action": "invalid",
                  "key": "edit_grant_duration_min",
                  "value": minutes, "needs_confirmation": False}
            reply = (
                "I cannot set that: edit sessions must last between 5 "
                "and 480 minutes. You asked for %s."
                % _minutes_sentence(minutes))
            return op, reply
        op = {"action": "set", "key": "edit_grant_duration_min",
              "value": minutes, "needs_confirmation": True}
        return op, _echo_duration(user_id, minutes)

    # --- destructive-writes guardrail --------------------------------------
    if re.search(r"\bdelet", t) or re.search(r"\bdestructive", t):
        if re.search(r"\b(stop|don't|do not|turn off|disable|no more|"
                     r"quit)\b", t) and re.search(r"\bconfirm", t):
            op = {"action": "set", "key": "confirm_destructive_writes",
                  "value": False, "needs_confirmation": True}
            return op, _echo_destructive_off()
        if re.search(r"\b(always|ask me before|keep|turn on|enable)\b", t) \
                and re.search(r"\bconfirm", t):
            op = {"action": "set", "key": "confirm_destructive_writes",
                  "value": True, "needs_confirmation": True}
            return op, _echo_destructive_on()

    # --- bulk-action guardrail ---------------------------------------------
    if re.search(r"\bbulk\b", t):
        if re.search(r"\b(don't|do not|stop|disable|turn off|never)\b", t) \
                and re.search(r"\b(ask|confirm)\b", t):
            op = {"action": "set", "key": "confirm_bulk_actions",
                  "value": False, "needs_confirmation": True}
            return op, _echo_bulk_off()
        if re.search(r"\b(ask|confirm|always|keep)\b", t):
            op = {"action": "set", "key": "confirm_bulk_actions",
                  "value": True, "needs_confirmation": True}
            return op, _echo_bulk_on()

    # --- default course ------------------------------------------------------
    if re.search(r"\bdefault\s+course\b", t):
        if re.search(r"\b(clear|remove|unset|delete)\b.{0,20}\b"
                     r"default\s+course\b", t) or \
                re.search(r"\bno\s+default\s+course\b", t):
            op = {"action": "set", "key": "default_course_id",
                  "value": "", "needs_confirmation": True}
            return op, _echo_default_course("")
        m = re.search(r"\bdefault\s+course\s+(?:is\s+|to\s+|:\s*)?"
                      r"([A-Za-z0-9_.-]{1,64})\b", t)
        if m and not re.search(r"\b(what|which|show|tell)\b", t):
            course_id = m.group(1)
            op = {"action": "set", "key": "default_course_id",
                  "value": course_id, "needs_confirmation": True}
            return op, _echo_default_course(course_id)
        if re.search(r"\b(what|which|show|tell)\b", t):
            try:
                current = get_setting(user_id, "default_course_id") \
                    if user_id else ""
            except Exception:
                current = ""
            op = {"action": "status", "key": "default_course_id",
                  "value": None, "needs_confirmation": False}
            if current:
                return op, ("Your default course is %s." % current)
            return op, ("You have no default course set. When you do not "
                        "name a course, I will ask which one you mean.")

    # --- timezone ---------------------------------------------------------------
    if re.search(r"\btime\s*zones?\b", t):
        tz = _extract_timezone(text)
        if tz is not None:
            op = {"action": "set", "key": "timezone", "value": tz,
                  "needs_confirmation": False}
            reply = ("Done: your timezone is %s. I will use it for date "
                     "math like 'last week's quiz'." % tz)
            return op, reply
        try:
            current = get_setting(user_id, "timezone") if user_id else ""
        except Exception:
            current = ""
        op = {"action": "status", "key": "timezone", "value": None,
              "needs_confirmation": False}
        if current:
            return op, ("Your timezone is set to %s." % current)
        if re.search(r"\b(what|which|show|tell)\b", t):
            return op, ("You don't have a timezone set. Say 'my timezone "
                        "is Eastern' to set one.")
        op = {"action": "invalid", "key": "timezone", "value": None,
              "needs_confirmation": False}
        return op, ("I did not catch a timezone in that. Try 'my "
                    "timezone is Eastern' or 'set timezone to "
                    "America/Denver'.")

    # --- test-object auto-cleanup ----------------------------------------------------
    if re.search(r"\b(test|proof)\s+objects?\b", t):
        if re.search(r"\b(don't|do not|stop|disable|keep|never)\b", t):
            op = {"action": "set", "key": "auto_cleanup_test_objects",
                  "value": False, "needs_confirmation": False}
            return op, ("Done: I will leave test objects in place after "
                        "checks instead of cleaning them up.")
        if re.search(r"\b(clean|delete|remove|auto)\b", t):
            op = {"action": "set", "key": "auto_cleanup_test_objects",
                  "value": True, "needs_confirmation": False}
            return op, ("Done: I will clean up test objects when checks "
                        "are done.")

    # --- work summary style -------------------------------------------------------------
    if re.search(r"\bsummar", t):
        if re.search(r"\bbrief\b", t):
            op = {"action": "set", "key": "work_summary",
                  "value": "brief", "needs_confirmation": False}
            return op, ("Done: I will keep work summaries brief, one short "
                        "line per task.")
        if re.search(r"\bfull\b", t):
            op = {"action": "set", "key": "work_summary",
                  "value": "full", "needs_confirmation": False}
            return op, ("Done: work summaries will list every change.")

    # --- write approval style ----------------------------------------------
    if re.search(r"\bbatch(ed)?\s+approval", t):
        op = {"action": "set", "key": "write_approval_style",
              "value": "batched", "needs_confirmation": True}
        reply = (
            "Switching your write approvals to batched. One approval "
            "ceremony may then cover a listed set of writes in a single "
            "validated plan, and you still approve the whole set before "
            "anything runs. Say 'yes' to confirm, or 'cancel'.")
        return op, reply
    if re.search(r"\b(per[ -]?write|approve\s+each\s+write|each\s+write\s+"
                 r"separately)\b", t):
        op = {"action": "set", "key": "write_approval_style",
              "value": "per_write", "needs_confirmation": True}
        reply = (
            "Switching your write approvals to per write. Every write "
            "gets its own approval ceremony. Say 'yes' to confirm, or "
            "'cancel'.")
        return op, reply

    # --- verbosity ----------------------------------------------------------
    if re.search(r"\bconcise\b", t) and not re.search(r"\bfailure\b", t):
        op = {"action": "set", "key": "verbosity", "value": "concise",
              "needs_confirmation": False}
        return op, "Done: I will keep things concise."
    if re.search(r"\b(more\s+detailed|detailed|verbose|elaborate)\b", t) \
            and not re.search(r"\bfailure\b", t):
        op = {"action": "set", "key": "verbosity", "value": "detailed",
              "needs_confirmation": False}
        return op, "Done: I will be more detailed."
    if re.search(r"\bbalanced\b", t):
        op = {"action": "set", "key": "verbosity", "value": "balanced",
              "needs_confirmation": False}
        return op, "Done: balanced verbosity it is."

    # --- failure verbosity ---------------------------------------------------
    if re.search(r"\bfailure\b", t):
        if re.search(r"\b(short|concise|brief)\b", t):
            op = {"action": "set", "key": "failure_verbosity",
                  "value": "concise", "needs_confirmation": False}
            return op, ("Done: failure reports will be concise, just what "
                        "failed and the next step.")
        if re.search(r"\bdetailed\b", t):
            op = {"action": "set", "key": "failure_verbosity",
                  "value": "detailed", "needs_confirmation": False}
            return op, ("Done: failure reports will stay detailed, with "
                        "what was attempted, the evidence, and recovery "
                        "options.")

    # --- proactivity ----------------------------------------------------------
    if re.search(r"\b(suggest|proactive|follow.?ups?)\b", t):
        if re.search(r"\b(stop|don't|do not|only what i ask|quit)\b", t):
            op = {"action": "set", "key": "proactivity",
                  "value": "reactive", "needs_confirmation": False}
            return op, ("Done: I will only do what you ask, no unprompted "
                        "suggestions.")
        op = {"action": "set", "key": "proactivity", "value": "suggestive",
              "needs_confirmation": False}
        return op, ("Done: I may suggest follow-up actions unprompted.")

    # --- read confirmations ----------------------------------------------------
    if re.search(r"\bread", t) and re.search(
            r"\b(confirm|narrate|announce)\b", t):
        if re.search(r"\b(don't|do not|stop|no)\b", t):
            op = {"action": "set", "key": "read_confirmations",
                  "value": False, "needs_confirmation": False}
            return op, "Done: I will read without narrating first."
        op = {"action": "set", "key": "read_confirmations",
              "value": True, "needs_confirmation": False}
        return op, ("Done: I will narrate what I am about to read before "
                    "reading it. Reads never needed approval anyway; this "
                    "is just verbosity.")

    # --- status -----------------------------------------------------------------
    if re.search(r"\bwhat\s+mode\b", t) or re.search(r"\bwhich\s+mode\b", t) \
            or re.search(r"\bam\s+i\s+in\b", t) \
            or re.search(r"\bplan\s+or\s+edit\b", t):
        op = {"action": "status", "key": "default_mode", "value": None,
              "needs_confirmation": False}
        return op, _status_sentence(user_id, conversation_id)

    # --- show --------------------------------------------------------------------
    if re.search(r"\b(show|list|display|see|view)\b.*\bsettings?\b", t) or \
            re.search(r"\bmy\s+settings?\b", t):
        op = {"action": "show", "key": None, "value": None,
              "needs_confirmation": False}
        return op, _show_sentence(user_id, conversation_id)

    # --- help / discoverability ---------------------------------------------
    if re.search(r"\bhelp\b", t) or \
            re.search(r"\bwhat\s+can\s+(you|i)\s+(do|ask|change|control)\b", t):
        op = {"action": "unknown", "key": None, "value": None,
              "needs_confirmation": False}
        return op, _help_sentence()

    # --- fallback ------------------------------------------------------------------
    op = {"action": "unknown", "key": None, "value": None,
          "needs_confirmation": False}
    reply = (
        "I did not catch a settings change in that. " + _help_sentence())
    return op, reply


YES_PATTERNS = re.compile(
    r"^(yes(\s+please)?|yeah|yep|yup|sure|ok|okay|absolutely|definitely|"
    r"correct|confirm|confirmed|do\s+it|go\s+ahead|please\s+do|"
    r"sounds?\s+good|that'?s?\s+(right|fine|good)|make\s+it\s+so|"
    r"approved)\b")
NO_PATTERNS = re.compile(
    r"^(no|nope|nah|cancel|never\s*mind|not\s+now|stop|don'?t|do\s+not|"
    r"not\s+yet)\b")
# A confirmation opener followed by one of these is a deferral, not a
# yes ("okay, but first a question"). Fail safe: neither confirm nor
# cancel, so the harness reprompts instead of acting.
_HEDGE_CUES = re.compile(
    r"\b(but|first|wait|hold\s+on|not\s+yet|instead|however|unless|"
    r"before|actually)\b")


def _opener_matches(pattern, t):
    m = pattern.match(t)
    return m is not None and not _HEDGE_CUES.search(t[m.end():])


def is_confirmation(text):
    """True when the educator's reply confirms a pending change."""
    t = _norm(text)
    if _opener_matches(NO_PATTERNS, t):
        return False
    return _opener_matches(YES_PATTERNS, t)


def is_cancellation(text):
    """True when the educator's reply cancels a pending change."""
    return _opener_matches(NO_PATTERNS, _norm(text))
