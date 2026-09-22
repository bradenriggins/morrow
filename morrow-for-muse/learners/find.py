#!/usr/bin/env python3
"""`morrow students find`: turn the name the educator typed into a label.

The educator works by name ("extend Jane Doe's due date by two days").
This typed tool resolves the name the educator typed to the student's
course label through the roster, and never shows the model anything
the educator did not type:

* Exact or unambiguous match: one label. When the match was on the
  name and a conversation id is given, the typed name is recorded as
  educator-introduced for this conversation (privacy/name_echo), so
  later outputs in this conversation show "<typed name> (Student A3)".
* Ambiguous match, or a close spelling only (fuzzy): every candidate
  as a label, with non-identifying details the educator can confirm
  (section name, enrollment state, last activity date). Never another
  student's real name, never an auto-pick. The agent asks the
  educator, then runs this again with --choose <label>.
* No match: says so, without echoing the query.

Output is one JSON object: ok, status (resolved | confirm | not_found |
refused | error), message, and student / shown_as / candidates as they
apply. Read-only against Canvas: GET the course roster and sections.

The roster is read through the login helper (helper_fetch_factory);
tests inject a fetcher(url) -> (status, headers, body_text).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

_TREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE_ROOT not in sys.path:
    sys.path.insert(0, _TREE_ROOT)

from learners import resolve_student as rs  # noqa: E402

RUNG_NAME_PARTIAL = "name_partial"
_NAME_RUNGS = (rs.RUNG_NAME_EXACT, RUNG_NAME_PARTIAL, rs.RUNG_NAME_FUZZY)
_LADDER = (rs.RUNG_USER_ID, rs.RUNG_SIS_USER_ID, rs.RUNG_LOGIN,
           rs.RUNG_EMAIL, rs.RUNG_NAME_EXACT, RUNG_NAME_PARTIAL,
           rs.RUNG_NAME_FUZZY)
_STATE_RANK = {"active": 0, "inactive": 1, "completed": 2}
_LABEL_RE = re.compile(r"^Student A[1-9][0-9]*$")


def _tokens(text):
    return set(rs.fuzzy_key(text).split())


def _partial_hits(candidates, query):
    want = _tokens(query)
    if not want:
        return []
    return [c for c in candidates
            if any(want <= set(variant.split())
                   for variant in (rs.fuzzy_key(v)
                                   for v in rs._name_variants(c)))]


def _hits(candidates, query):
    """(rung, hits) for the first ladder rung with any candidate."""
    for rung in _LADDER:
        if rung == RUNG_NAME_PARTIAL:
            hits = _partial_hits(candidates, query)
        else:
            hits = rs._match_rung(candidates, query, rung)
        if hits:
            return rung, hits
    return None, []


def _sections(fetcher, tenant_base, course_id):
    """{section_id: name}; empty when the sections read fails."""
    url = "%s/api/v1/courses/%s/sections?per_page=100" % (
        rs.check_tenant_base(tenant_base), course_id)
    try:
        items, _pages = rs.fetch_paginated(fetcher, url)
    except Exception:
        return {}
    return {s.get("id"): s.get("name") for s in items
            if isinstance(s, dict) and isinstance(s.get("name"), str)}


def _roster_tokens(candidates):
    words = set()
    for cand in candidates:
        for variant in rs._name_variants(cand):
            words |= {w for w in rs.fuzzy_key(variant).split() if len(w) > 2}
    return words


def _section_text(cand, sections, roster_words):
    ids = sorted(rs.candidate_sections(cand), key=str)
    if not ids:
        return "no section recorded"
    shown = []
    for sid in ids:
        name = sections.get(sid)
        # A section named after a person (an independent study) would
        # show another student's name: fall back to the section id.
        if not name or (set(rs.fuzzy_key(name).split()) & roster_words):
            shown.append("section %s" % sid)
        else:
            shown.append(name)
    return ", ".join(shown)


def _describe(cand, label, sections, roster_words):
    states = sorted(rs.candidate_states(cand),
                    key=lambda s: _STATE_RANK.get(s, 9))
    dates = sorted(e["last_activity_at"][:10] for e in cand["enrollments"]
                   if e.get("last_activity_at"))
    out = {"student": label,
           "section": _section_text(cand, sections, roster_words),
           "enrollment_state": states[0] if states else "unknown",
           "last_activity": dates[-1] if dates else "none recorded"}
    if rs.candidate_is_test_student(cand):
        out["test_student"] = True
    return out


def _record_echo(tenant_base, course_id, conversation_id, label, typed):
    from privacy import name_echo
    from modes.state import journal_event
    name_echo.record_introduction(tenant_base, course_id, conversation_id,
                                  label, typed)
    journal_event("privacy.name_echo_recorded", {
        "course_id": str(course_id), "conversation_id": str(conversation_id),
        "label": label,
        "tenant": rs.check_tenant_base(tenant_base)})


def _resolved(tenant_base, course_id, conversation_id, label, typed,
              rung):
    out = {"ok": True, "status": "resolved", "course_id": str(course_id),
           "student": label, "match": rung}
    if rung in _NAME_RUNGS and conversation_id:
        _record_echo(tenant_base, course_id, conversation_id, label, typed)
        typed = " ".join(typed.split())
        out["shown_as"] = "%s (%s)" % (typed, label)
        out["message"] = (
            "Found the student the educator named: %s. In this "
            "conversation Morrow shows them as \"%s\". Use %s (or \"%s\") "
            "wherever a write needs this student in course %s."
            % (label, out["shown_as"], label, out["shown_as"], course_id))
    elif rung in _NAME_RUNGS:
        out["message"] = (
            "Found the student the educator named: %s. No conversation id "
            "was given, so outputs show the label only. Use %s wherever a "
            "write needs this student in course %s."
            % (label, label, course_id))
    else:
        out["message"] = (
            "Found one student for that identifier: %s. Use %s wherever a "
            "write needs this student in course %s."
            % (label, label, course_id))
    return out


def find_student(fetcher, tenant_base, course_id, query, *,
                 conversation_id=None, choose=None, section_id=None,
                 include_inactive=False, include_concluded=False,
                 include_test_student=False):
    """Resolve the name the educator typed to a course label (JSON dict)."""
    course_id = str(course_id)
    try:
        rs.check_tenant_base(tenant_base)
    except ValueError:
        return {"ok": False, "status": "error",
                "message": "The Canvas base is not an exact http(s) origin, "
                           "so no student can be looked up."}
    try:
        candidates, _ev = rs.fetch_course_candidates(fetcher, tenant_base,
                                                     course_id)
    except Exception as exc:
        return {"ok": False, "status": "error",
                "message": "The course roster could not be read (%s). "
                           "Nothing was looked up." % type(exc).__name__}
    try:
        label_for = rs.vault_label_for(tenant_base, course_id, candidates) \
            if candidates else (lambda uid: None)
    except Exception as exc:
        return {"ok": False, "status": "error",
                "message": "No course label could be issued (%s), so no "
                           "student is shown. Student data needs the "
                           "encrypted learner vault (the optional "
                           "'cryptography' package)." % type(exc).__name__}
    states = set(rs.ACTIVE_STATES)
    if include_inactive:
        states |= rs.INACTIVE_STATES
    if include_concluded:
        states |= rs.CONCLUDED_STATES
    kept, excluded = rs.filter_candidates(
        candidates, section_id=section_id, include_states=states,
        include_test_student=include_test_student)
    typed = rs._collapse_ws(query) if isinstance(query, str) else ""
    rung, hits = _hits(kept, typed) if typed else (None, [])
    if not hits:
        skipped = ",".join("%s=%d" % (k, excluded[k])
                           for k in sorted(excluded) if excluded[k])
        return {"ok": False, "status": "not_found", "course_id": course_id,
                "filters_skipped": skipped or "none",
                "message": "No student in course %s matches the name the "
                           "educator gave (filters skipped: %s). Ask the "
                           "educator to check the spelling, or whether to "
                           "include inactive or concluded enrollments."
                           % (course_id, skipped or "none")}
    labels = {c["user_id"]: label_for(c["user_id"]) for c in hits}
    if choose is not None:
        chosen = [c for c in hits if labels[c["user_id"]] == choose]
        if not _LABEL_RE.match(str(choose)) or len(chosen) != 1:
            return {"ok": False, "status": "refused", "course_id": course_id,
                    "message": "%s was not one of the students offered for "
                               "that name in course %s. Ask the educator "
                               "again which student they mean."
                               % (choose, course_id)}
        return _resolved(tenant_base, course_id, conversation_id, choose,
                         typed, rung)
    if len(hits) == 1 and rung != rs.RUNG_NAME_FUZZY:
        return _resolved(tenant_base, course_id, conversation_id,
                         labels[hits[0]["user_id"]], typed, rung)
    sections = _sections(fetcher, tenant_base, course_id)
    words = _roster_tokens(candidates)
    return {"ok": True, "status": "confirm", "course_id": course_id,
            "match": rung,
            "candidates": [_describe(c, labels[c["user_id"]], sections,
                                     words) for c in hits],
            "message": (
                "%s. Ask the educator which student they mean, using the "
                "details below; never pick one yourself. Then run students "
                "find again with the same name and --choose <label>."
                % ("That name is only a close spelling of one student"
                   if len(hits) == 1 else
                   "%d students could match that name" % len(hits)))}


def main(argv=None, fetcher=None):
    parser = argparse.ArgumentParser(
        prog="morrow students find",
        description="Resolve the name the educator typed to the student's "
                    "course label. Prints one JSON object. Read-only.")
    parser.add_argument("--course", required=True, help="Canvas course id")
    parser.add_argument("--canvas-base",
                        default=os.environ.get("CANVAS_BASE"),
                        help="Canvas origin (default: CANVAS_BASE)")
    parser.add_argument("--conversation-id",
                        default=os.environ.get("MORROW_CONVERSATION_ID"),
                        help="the Muse conversation id (default: "
                             "MORROW_CONVERSATION_ID); needed for the name "
                             "echo")
    parser.add_argument("--choose", default=None,
                        help="the label the educator confirmed, after a "
                             "'confirm' result")
    parser.add_argument("--section-id", default=None)
    parser.add_argument("--include-inactive", action="store_true")
    parser.add_argument("--include-concluded", action="store_true")
    parser.add_argument("name", nargs="+",
                        help="the name as the educator typed it")
    args = parser.parse_args(argv)
    if not args.canvas_base:
        print(json.dumps({"ok": False, "status": "error",
                          "message": "Set --canvas-base or CANVAS_BASE."}))
        return 2
    section_id = args.section_id
    if section_id is not None and section_id.isdigit():
        section_id = int(section_id)
    own = fetcher is None
    if own:
        try:
            fetcher = rs.helper_fetch_factory(args.canvas_base)
        except Exception as exc:
            print(json.dumps({
                "ok": False, "status": "error",
                "message": "The login helper is not ready (%s). Sign the "
                           "educator in first." % type(exc).__name__}))
            return 1
    try:
        out = find_student(fetcher, args.canvas_base, args.course,
                           " ".join(args.name),
                           conversation_id=args.conversation_id,
                           choose=args.choose, section_id=section_id,
                           include_inactive=args.include_inactive,
                           include_concluded=args.include_concluded)
    finally:
        if own:
            getattr(fetcher, "close", lambda: None)()
    print(json.dumps(out, indent=1, sort_keys=True))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
