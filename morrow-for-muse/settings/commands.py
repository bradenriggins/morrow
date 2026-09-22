#!/usr/bin/env python3
"""Conversational settings commands for Morrow for Muse (WORKSTREAM B).

Maps educator utterances to setting operations. Each parse returns a
structured op {action, key, value, needs_confirmation} plus a
plain-language sentence the agent speaks back to the educator.

The mode model is simple: the ONLY difference between plan and edit mode
is whether writes surface approval. Plan mode: writes require approval.
Edit mode: they do not. Reads are unrestricted in both modes.

Edit mode is ONE blanket grant with no time limit: it stays on until
the educator turns it off. Turning it off means plan everywhere.

Utterance mapping:
  "use edit mode" / "switch to edit mode" / "turn on edit mode" /
  "make edit mode my default"            -> default_mode = edit (the
                                           standing edit grant, no
                                           time limit)
  "use plan mode" / "switch to plan mode" / "back to plan mode" /
  "stop|end|exit edit mode" / "turn off edit mode"
                                         -> end_edit: plan everywhere
                                           (default_mode = plan, every
                                           grant and override cleared)
  "what is my default mode"              -> reports the saved default
  "switch to edit mode for this conversation" -> conversation override
                                           (any verb; "chat" also works)
  "use plan mode for this conversation"  -> conversation override = plan
  "use edit mode for this conversation"  -> conversation override = edit
  "edit for 30 minutes"                  -> explains edit is not timed
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
educator says yes. is_confirmation() recognizes that yes. Turning edit
mode off is the safe direction and applies at once.

apply_command(op, ...) carries out a parsed op and returns the sentence
to speak, built from the state AFTER the change (never assumed).

No em dashes anywhere in spoken text: commas, colons, or parentheses
only.

Stdlib only.
"""

import re
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                ".."))
from modes import state as mode_state  # noqa: E402
from settings.store import (  # noqa: E402
    SETTINGS_SCHEMA,
    effective_mode,
    get_conversation_mode,
    get_setting,
    list_settings,
    set_conversation_mode,
    set_setting,
)


def _norm(text):
    text = (text or "").strip().lower()
    text = re.sub(r"[?!.,;:]+$", "", text)
    text = re.sub(r"\s+", " ", text)
    return text


_NOT_TIMED = ("Edit mode has no time limit: it stays on until you say "
              "'turn off edit mode'.")


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


def _echo_default_mode(mode, user_id, timed_ask=False):
    lead = ""
    if timed_ask:
        lead = ("You mentioned a time limit, but edit mode is not "
                "timed. ")
    return (
        "%sMaking edit mode your default. This is a standing edit grant, "
        "and it is journaled: from now on, writes will not surface "
        "approval. %s %s Say 'yes' to confirm, or 'cancel'."
        % (lead, _NOT_TIMED, _destructive_note(user_id)))


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


def _explain_not_timed():
    return (
        "Edit mode has no time limit, so there is no session length to "
        "set. Say 'use edit mode' to turn it on; it stays on until you "
        "say 'turn off edit mode', and then every write asks for your "
        "approval again.")


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


def _edit_sources(user_id, conversation_id):
    """Plain-language list of what currently holds edit mode on."""
    why = []
    override = get_conversation_mode(user_id, conversation_id) \
        if conversation_id else None
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
    override = get_conversation_mode(user_id, conversation_id) \
        if conversation_id else None
    if mode == "plan":
        sentence = ("You are in plan mode right now: writes ask for your "
                    "approval, reads never need it.")
        if override == "plan":
            sentence += (" That comes from your plan override for this "
                         "conversation. Your saved default is %s mode."
                         % default)
        return sentence
    why = _edit_sources(user_id, conversation_id) or ["your saved default"]
    return ("You are in edit mode right now: writes do not ask for "
            "approval, reads never need it. That comes from %s, and it "
            "stays on until you turn it off. Say 'turn off edit mode' "
            "whenever you want every write to ask first."
            % " and ".join(why))


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


def _friendly_value(key, value):
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
    override = get_conversation_mode(user_id, conversation_id) \
        if conversation_id else None
    if override:
        lines.append("- this conversation: %s mode override (not saved)"
                     % override)
    lines.append("Say 'use edit mode', 'turn off edit mode', or 'use plan "
                 "mode for this conversation' to change your mode, or name "
                 "any other setting to change it.")
    return " ".join(lines)


_TIME_LIMIT = re.compile(
    r"\b\d+\s*(?:minutes?|mins?|hours?|hrs?)\b|\ban?\s+hour\b|"
    r"\bedit\s+sessions?\b|\bedit\s+grant\s+(?:default\s+)?duration\b")

# Phrases that mean "edit off". Every one of them lands in plan mode
# everywhere; none of them may leave a standing edit default behind.
_PLAN_DIRECTION = [
    re.compile(r"\buse\s+plan\s+mode\b"),
    re.compile(r"\b(end|stop|exit|leave|quit|cancel)\b.{0,12}\bedit\s+"
               r"(mode|session)s?\b"),
    re.compile(r"\bedit\s+(mode|session)s?\b.{0,12}\b(end|over|stop|off)\b"),
    re.compile(r"\bback\s+to\s+plan\b"),
    re.compile(r"\b(stop|quit)\s+editing\b"),
    re.compile(r"\b(turn\s+off|disable|deactivate)\b.{0,24}\bedit\s+mode\b"),
    re.compile(r"\b(switch|change|go|move|set|make|turn\s+on|enable|"
               r"activate)\b.{0,24}\bplan\s+mode\b"),
]


def _is_plan_direction(t):
    return any(p.search(t) for p in _PLAN_DIRECTION)


def _help_sentence():
    return (
        "Here is what you can ask me to change: 'use edit mode', 'turn "
        "off edit mode', 'use plan mode for this conversation', "
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
    persisted setting), "conversation" (per-conversation override),
    "end_edit" (edit off: plan everywhere), "show", "status",
    "invalid", "unknown". Carry out "set", "conversation", and
    "end_edit" with apply_command, and speak the sentence it returns.

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

    # --- edit off: plan everywhere ---------------------------------------
    if _is_plan_direction(t):
        op = {"action": "end_edit", "key": "default_mode", "value": "plan",
              "needs_confirmation": False}
        return op, ("Turning edit mode off everywhere. I will tell you "
                    "the result as soon as it is done.")

    timed_ask = bool(re.search(r"\bedit", t) and _TIME_LIMIT.search(t))

    # --- standing edit grant: bare "use edit mode" ----------------------
    # Braden's model: no time handcuffs. "use edit mode" grants the
    # standing edit mode (default_mode="edit"), with no time limit.
    if re.search(r"\buse\s+edit\s+mode\b", t):
        op = {"action": "set", "key": "default_mode", "value": "edit",
              "needs_confirmation": True}
        return op, _echo_default_mode("edit", user_id, timed_ask)

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

    # --- persisted default mode: edit on ----------------------------------
    # Plan-direction phrasings were handled above, so what reaches here
    # names edit mode (or negates plan mode, "disable plan mode").
    m = re.search(r"\b(switch|change|make|set|default|turn\s+on|turn\s+off|"
                  r"enable|disable|activate|deactivate)\b.{0,24}\b"
                  r"(plan|edit)\s+mode\b", t)
    if m and re.search(r"\bmode\b", t):
        verb = re.sub(r"\s+", " ", m.group(1))
        mode = m.group(2)
        if verb in ("turn off", "disable", "deactivate"):
            mode = "plan" if mode == "edit" else "edit"
        if mode == "edit":
            op = {"action": "set", "key": "default_mode", "value": "edit",
                  "needs_confirmation": True}
            return op, _echo_default_mode("edit", user_id, timed_ask)

    # --- a time limit on edit mode: explain, never pretend -----------------
    if timed_ask:
        op = {"action": "invalid", "key": "default_mode", "value": None,
              "needs_confirmation": False}
        return op, _explain_not_timed()

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


def _plan_result_sentence(result, user_id, conversation_id):
    if result.get("mode") == "plan":
        return ("Done: you are in plan mode now. Edit mode is off in "
                "every conversation and as your default, so every write "
                "will ask for your approval before it runs. Reads still "
                "never need approval. Say 'use edit mode' to turn it back "
                "on.")
    why = _edit_sources(user_id, conversation_id)
    held = (" by %s" % " and ".join(why)) if why else ""
    return ("I turned off every edit grant I could, but you are still in "
            "edit mode, held on%s. Writes will not ask for approval until "
            "that is cleared. Say 'show me my settings' and I will show "
            "you exactly what is set." % held)


def apply_command(op, user_id, conversation_id=None,
                  educator_confirmed=False, educator=None):
    """Carry out a parsed op and return the sentence to speak.

    The sentence is built from the state after the change, so it never
    claims a mode that is not in force. "set" and "conversation" ops
    with needs_confirmation=True need educator_confirmed=True (the
    educator's yes), or the store raises SettingsTamperRefused.
    "end_edit" is the safe direction and applies at once. Ops with
    nothing to apply (show, status, invalid, unknown) return None:
    speak the parse reply.
    """
    action = op.get("action")
    if action == "end_edit":
        result = mode_state.switch_mode(user_id, "plan",
                                        conversation_id=conversation_id,
                                        educator=educator)
        return _plan_result_sentence(result, user_id, conversation_id)
    if action == "conversation":
        set_conversation_mode(user_id, conversation_id, op["value"],
                              educator_confirmed=educator_confirmed,
                              educator=educator)
        mode = effective_mode(user_id, conversation_id)
        return ("Done: for this conversation you are in %s mode. %s"
                % (mode, _status_sentence(user_id, conversation_id)))
    if action == "set":
        key, value = op["key"], op["value"]
        set_setting(user_id, key, value,
                    educator_confirmed=educator_confirmed,
                    educator=educator)
        if key == "default_mode":
            return "Done. " + _status_sentence(user_id, conversation_id)
        return ("Done: %s is now %s."
                % (_SETTING_LABELS.get(key, key),
                   _friendly_value(key, get_setting(user_id, key))))
    return None


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
