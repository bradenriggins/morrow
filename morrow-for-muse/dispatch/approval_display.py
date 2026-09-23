"""W6-P1-A1 / W6-P1-H1: educator-facing approval display renderer.

The educator must see the ACTUAL operation payload they are being asked
to approve, not just the op name the agent relays in chat. This module
renders the full approval display: op name, category, human-readable
write target, issued/expiry, the exact request that will be sent
(method, path, query, and the COMPLETE body: due dates, point values,
text content, URLs), the canonical params, the undo availability
disclosure, and the identity schedule when present. The request shown
is the one the approval's digest binds (round-4 audit H1): a record
whose shown request does not match its digest is refused, never
displayed.

Two renderings of one approval: render_educator_display is what the
educator reads (plain words, every value that will be sent), and
render_approval_display is the audit detail (method, path, JSON,
digests, category) that the agent does not relay.

Privacy boundary (W3-P2-37, still enforced): this renderer NEVER
resolves learner tokens back to display names. Params carry tokens
(lrn_...) by construction; the identity schedule's `displayed_as`
values are the educator's OWN citation words relayed by the agent, not
vault lookups. This module must not import the learner vault; a
selftest asserts zero vault references.

Usage (agent / connector UX):
    record = admission.mint_approval(entry, params, tenant_base, ttl,
                                     target_identity={...})
    # Show this to the educator BEFORE asking for authorization:
    print(approval_display.render_approval_display(
        record, params, entry=entry))
    # ... educator replies with explicit authorization ...
    signed = admission.sign_approval(record, authorization,
                                     channel="educator-chat",
                                     resolved_identities=[...],
                                     identity_authorization="...")
"""

import hashlib
import json
import os
import sys

_TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE not in sys.path:
    sys.path.insert(0, _TREE)

# W6-P1-A1: the educator sees the FULL payload. An earlier revision
# capped the display at 8,000 chars; that cap is removed. A truncated
# approval display is a consent defect: the educator must see exactly
# what will be sent, all of it. The digest below still covers the full
# canonical params as a tamper check.


def _canonical_params(params):
    return json.dumps(params or {}, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, default=str)


def params_digest(params):
    """SHA-256 of the canonical params; printed with the display so the
    educator (or an auditor) can confirm the shown payload is the whole
    payload."""
    return hashlib.sha256(
        _canonical_params(params).encode("utf-8")).hexdigest()


def undo_available(entry):
    """True when the catalog entry declares an undo block."""
    return isinstance(entry, dict) and bool(entry.get("undo"))


def _bound_request(record, params, entry):
    """The request the approval's digest binds, or raise ValueError.

    Prefers the record's own request block, and checks it against the
    record's request_digest; a legacy record without one falls back to
    the entry's request. Never shows a request the digest does not
    cover."""
    from dispatch.admission import request_digest, request_subject
    shown = record.get("request")
    if isinstance(shown, dict):
        if record.get("request_digest") != request_digest(shown):
            raise ValueError(
                "the approval record's request does not match its "
                "request_digest; it was edited after minting and cannot "
                "be shown as the payload. Mint a new approval.")
        if isinstance(entry, dict) and \
                request_digest(request_subject(entry, params)) \
                != record.get("request_digest"):
            raise ValueError(
                "the approval record was minted for a different request "
                "than this entry sends; mint a new approval.")
        return shown
    if isinstance(entry, dict):
        return request_subject(entry, params)
    return None


def _request_lines(request):
    if not isinstance(request, dict):
        return ["Request   : (not available: pass the entry to show it)"]
    lines = ["Request   : %s %s" % (request.get("method") or "(no method)",
                                    request.get("path") or "(no path)")]
    if request.get("query"):
        lines.append("Query     : %s" % json.dumps(
            request.get("query"), sort_keys=True, ensure_ascii=True,
            default=str))
    lines.append("Body (exactly what will be sent):")
    lines.append(json.dumps(request.get("body"), indent=2, sort_keys=True,
                            ensure_ascii=True, default=str))
    if request.get("multi_step"):
        lines.append("Steps (sent in order):")
        lines.append(json.dumps(request.get("multi_step"), indent=2,
                                sort_keys=True, ensure_ascii=True,
                                default=str))
    return lines


def approval_display_dict(record, params, entry=None):
    """Structured approval display (for UIs that render their own)."""
    record = record or {}
    request = _bound_request(record, params, entry)
    target = record.get("target") or {}
    schedule = record.get("resolved_identities") or []
    return {
        "op": record.get("op"),
        "category": record.get("category"),
        "target": {
            "tenant": target.get("tenant"),
            "course_id": target.get("course_id"),
            "course_name": target.get("course_name"),
            "term": target.get("term"),
        },
        "issued_at": record.get("at"),
        "expires_at": record.get("expires_at"),
        "channel": record.get("channel"),
        "request": request,
        "request_digest": record.get("request_digest"),
        "params": params or {},
        "params_digest": params_digest(params),
        "undo_available": undo_available(entry),
        "identity_schedule": [
            {"token": item.get("token"),
             "displayed_as": item.get("displayed_as")}
            for item in schedule if isinstance(item, dict)
        ],
    }


# Plain words for the educator (final sweep 2026-09-22): the display
# the educator reads names the course, the change, every value that
# will be sent, and whether Morrow can undo it. The method, path, JSON,
# digests, and category are audit detail (render_approval_display).
_ACTIONS = {"POST": "Create", "PUT": "Change", "PATCH": "Change",
            "DELETE": "Delete"}
_NOUNS = {
    "pages": "page", "assignments": "assignment", "quizzes": "quiz",
    "questions": "quiz question", "modules": "module",
    "items": "module item", "discussion_topics": "discussion",
    "entries": "discussion reply", "files": "file", "folders": "folder",
    "overrides": "due date override",
    "assignment_groups": "assignment group", "rubrics": "rubric",
    "sections": "section", "enrollments": "enrollment",
    "submissions": "submission", "grading_standards": "grading scheme",
    "front_page": "front page", "groups": "group",
    "calendar_events": "calendar event", "outcome_groups":
    "outcome group", "outcomes": "outcome", "items_bank": "item bank",
    "banks": "item bank", "users": "student",
}
_FIELDS = {
    "title": "Title", "name": "Name", "body": "Content",
    "message": "Message", "description": "Description",
    "due_at": "Due date", "unlock_at": "Available from",
    "lock_at": "Available until", "points_possible": "Points",
    "published": "Published", "position": "Position",
    "student_ids": "Students", "grading_type": "Grading type",
    "posted_grade": "Grade", "comment": "Comment",
    "text_comment": "Comment", "workflow_state": "State",
    "submission_types": "Submission types",
}
_SKIP_PATH = {"api", "v1", "quiz"}
# Batch routes act on several objects at once: the last path word is an
# action, not the name of one object.
_BATCH_CHANGES = {
    ("assignments", "overrides"):
        "the due date overrides of several assignments",
    ("assignments", "bulk_update"): "the dates of several assignments",
}
# An item inside a quiz or an item bank is a question, not a module item.
_NOUNS_UNDER = {("quizzes", "items"): "quiz question",
                ("banks", "items"): "item bank question",
                ("items_bank", "items"): "item bank question"}


def _noun(segment, parent=None):
    if (parent, segment) in _NOUNS_UNDER:
        return _NOUNS_UNDER[(parent, segment)]
    if segment in _NOUNS:
        return _NOUNS[segment]
    word = segment.replace("_", " ")
    return word[:-1] if word.endswith("s") else word


def _article(noun):
    return "an" if noun[:1] in "aeiou" else "a"


def _path_segments(path):
    """[(segment, noun, identifier or None)] for a request path, the
    course segment left out: the course is named separately."""
    parts = [p for p in str(path or "").split("?", 1)[0].split("/")
             if p and p not in _SKIP_PATH]
    out = []
    i = 0
    while i < len(parts):
        if parts[i] == "courses" and i + 1 < len(parts):
            i += 2
            continue
        ident = parts[i + 1] if i + 1 < len(parts) else None
        parent = out[-1][0] if out else None
        out.append((parts[i], _noun(parts[i], parent), ident))
        i += 2
    return out


def _change_sentence(request):
    """"Change the page \"week-1\"", "Create an assignment", ..."""
    method = str((request or {}).get("method") or "").upper()
    action = _ACTIONS.get(method, "Change")
    segments = _path_segments((request or {}).get("path"))
    pairs = [(noun, ident) for _seg, noun, ident in segments]
    if not pairs:
        if method == "POST":
            return "%s something in the course" % action
        return "%s the course" % action
    batch = _BATCH_CHANGES.get((segments[-1][0], segments[-1][2]))
    if batch:
        return "%s %s" % (action, batch)
    noun, ident = pairs[-1]
    if ident is not None:
        sentence = '%s the %s "%s"' % (action, noun, ident)
    else:
        sentence = "%s %s %s" % (action, _article(noun), noun)
    if len(pairs) > 1 and pairs[-2][1] is not None:
        sentence += ' in the %s "%s"' % pairs[-2]
    return sentence


_GERUNDS = {"GET": "reading", "HEAD": "reading", "POST": "creating",
            "PUT": "changing", "PATCH": "changing", "DELETE": "deleting"}


def describe_operation(method, path, where=None):
    """What a request does, as the phrase a failure message names:
    "changing a page", "reading the assignments in course 101". Built
    from the method and the path template only: no value the request
    carries (a page body, a student label) is repeated. where names
    the course ('the course "Biology 101"' or "course 101")."""
    verb = _GERUNDS.get(str(method or "").upper(), "changing")
    segments = _path_segments(path)
    batch = _BATCH_CHANGES.get((segments[-1][0], segments[-1][2])) \
        if segments else None
    if [s[0] for s in segments] == ["users"] and segments[0][2] == "self":
        phrase = "%s your own Canvas profile" % (
            "reading" if verb == "reading" else "changing")
    elif not segments:
        # The request acts on the course itself: name it once.
        return "%s %s" % (verb, where) if where else "%s the course" % verb
    elif batch:
        phrase = "%s %s" % (verb, batch)
    else:
        seg, noun, ident = segments[-1]
        known = seg in _NOUNS or (
            len(segments) > 1 and (segments[-2][0], seg) in _NOUNS_UNDER)
        if ident is None and not known and verb == "creating":
            # A POST to an action on its parent (".../quizzes/{id}/reorder").
            parents = [s for s in segments[:-1] if s[2] is not None]
            if parents:
                noun = parents[-1][1]
                phrase = "changing %s %s" % (_article(noun), noun)
            else:
                phrase = "changing the course"
        elif ident is not None or verb == "creating":
            phrase = "%s %s %s" % (verb, _article(noun), noun)
        else:
            phrase = "%s the %s" % (verb, seg.replace("_", " "))
    return "%s in %s" % (phrase, where) if where else phrase


def _field_name(key):
    return _FIELDS.get(key) or key.replace("_", " ").capitalize()


def _plain_value(value):
    if value is True:
        return "yes"
    if value is False:
        return "no"
    if value is None:
        return "(empty)"
    if isinstance(value, list) and all(
            not isinstance(v, (dict, list)) for v in value):
        return ", ".join(_plain_value(v) for v in value) or "(none)"
    return str(value)


def _value_lines(value, indent=""):
    """Every value in a request body as "Name: value" lines, whole."""
    lines = []
    if isinstance(value, dict):
        # A lone wrapper ({"wiki_page": {...}}) adds nothing to read.
        if len(value) == 1 and isinstance(next(iter(value.values())),
                                          dict) and not indent:
            return _value_lines(next(iter(value.values())), indent)
        for key in sorted(value):
            item = value[key]
            if isinstance(item, dict) or (
                    isinstance(item, list)
                    and any(isinstance(v, (dict, list)) for v in item)):
                lines.append("%s%s:" % (indent, _field_name(str(key))))
                lines.extend(_value_lines(item, indent + "  "))
            else:
                lines.append("%s%s: %s" % (indent, _field_name(str(key)),
                                            _plain_value(item)))
    elif isinstance(value, list):
        for n, item in enumerate(value, 1):
            lines.append("%s%d." % (indent, n))
            lines.extend(_value_lines(item, indent + "  "))
    elif value is not None:
        lines.append("%s%s" % (indent, _plain_value(value)))
    return lines


def _open_minutes(record):
    from datetime import datetime
    try:
        start = datetime.fromisoformat(str(record.get("at")).replace(
            "Z", "+00:00"))
        end = datetime.fromisoformat(str(record.get("expires_at")).replace(
            "Z", "+00:00"))
    except ValueError:
        return None
    minutes = int((end - start).total_seconds() // 60)
    return minutes if minutes > 0 else None


def render_educator_display(record, params, entry=None):
    """What the educator reads before approving, in plain words: the
    course, the change, every value that will be sent (whole, never
    shortened), whether Morrow can undo it, and how to approve. The
    request shown is the one the approval binds (_bound_request)."""
    record = record or {}
    request = _bound_request(record, params, entry)
    target = record.get("target") or {}
    lines = []
    where = []
    if target.get("course_name"):
        where.append('the course "%s"' % target.get("course_name"))
    elif target.get("course_id") is not None:
        where.append("course %s" % target.get("course_id"))
    if target.get("term"):
        where.append("(%s)" % target.get("term"))
    if target.get("tenant"):
        where.append("on %s" % str(target.get("tenant")).split("://")[-1])
    lines.append("Morrow wants to make this change%s:"
                 % ((" in " + " ".join(where)) if where else ""))
    lines.append(_change_sentence(request) + ".")
    shown = _value_lines((request or {}).get("body"))
    if (request or {}).get("query"):
        shown.extend(_value_lines((request or {}).get("query")))
    if shown:
        lines.append("")
        lines.append("What it sends:")
        lines.extend("  " + line for line in shown)
    if (request or {}).get("multi_step"):
        lines.append("")
        lines.append("It takes %d steps, sent in order."
                     % len(request.get("multi_step")))
    schedule = [item.get("displayed_as") for item in
                (record.get("resolved_identities") or [])
                if isinstance(item, dict) and item.get("displayed_as")]
    if schedule:
        lines.append("")
        lines.append("Students you named: %s" % ", ".join(schedule))
    lines.append("")
    undo_request = (params or {}).get("_undo_request") \
        if isinstance(params, dict) else None
    if isinstance(undo_request, dict) or \
            str((entry or {}).get("name") or "").endswith("#undo"):
        lines.append("This change undoes an earlier change. Morrow cannot "
                     "undo it in turn.")
    elif undo_available(entry):
        lines.append("You can undo this change later.")
    else:
        lines.append("Morrow cannot undo this change automatically.")
    minutes = _open_minutes(record)
    if minutes:
        lines.append("This request stays open for %d minutes." % minutes)
    lines.append("")
    lines.append("To approve this change, reply in any words (\"Yes\" is "
                 "enough). Your reply is kept word for word with the "
                 "approval. If you do not want it, say so, and nothing "
                 "changes.")
    return "\n".join(lines)


def render_approval_display(record, params, entry=None):
    """The audit detail of an approval: op name, category, target,
    issue and expiry times, the exact request (method, path, query, and
    body), the FULL canonical params, integrity digests, and the undo
    disclosure. For the journal and reviewers; the educator reads
    render_educator_display."""
    record = record or {}
    request = _bound_request(record, params, entry)
    target = record.get("target") or {}
    lines = []
    lines.append("MORROW APPROVAL REQUEST")
    lines.append("=======================")
    lines.append("Operation : %s" % (record.get("op"),))
    lines.append("Category  : %s" % (record.get("category"),))
    tgt_bits = []
    if target.get("tenant"):
        tgt_bits.append("Canvas site %s" % (target.get("tenant"),))
    if target.get("course_id") is not None:
        tgt_bits.append("course %s" % (target.get("course_id"),))
    if target.get("course_name"):
        tgt_bits.append("\"%s\"" % (target.get("course_name"),))
    if target.get("term"):
        tgt_bits.append("(%s)" % (target.get("term"),))
    lines.append("Target    : %s" % ("; ".join(tgt_bits) if tgt_bits else
                                    "(not course-scoped)"))
    lines.append("Issued    : %s" % (record.get("at"),))
    lines.append("Expires   : %s" % (record.get("expires_at"),))
    lines.append("")
    lines.append("FULL OPERATION PAYLOAD (exactly what will be sent):")
    # W6-P1-A1: NO truncation. The full request and params are
    # displayed, always.
    lines.extend(_request_lines(request))
    lines.append("Params:")
    pretty = json.dumps(params or {}, indent=2, sort_keys=True,
                        ensure_ascii=True, default=str)
    lines.append(pretty)
    lines.append("Integrity codes (sha256; they prove the request and "
                 "params above are complete and unaltered): request %s, "
                 "params %s" % (record.get("request_digest")
                                or "(legacy record: none)",
                                params_digest(params)))
    lines.append("")
    undo_request = (params or {}).get("_undo_request") \
        if isinstance(params, dict) else None
    if isinstance(undo_request, dict) or \
            str((entry or {}).get("name") or "").endswith("#undo"):
        req = undo_request if isinstance(undo_request, dict) else {}
        lines.append("Undo      : This approval IS an undo. It reverses "
                     "operation %s by sending %s %s (target %s). The undo "
                     "itself cannot be automatically reversed."
                     % ((params or {}).get("_undo_of"),
                        req.get("method") or "(unknown method)",
                        req.get("path") or "(unknown path)",
                        json.dumps((params or {}).get("_undo_target"),
                                   sort_keys=True, default=str)))
    elif undo_available(entry):
        lines.append("Undo      : AVAILABLE. This operation declares an "
                     "undo block; the change can be reversed.")
    else:
        lines.append("Undo      : NOT AVAILABLE. This operation declares "
                     "no undo block: the change cannot be automatically "
                     "reversed. Approve only if you accept that.")
    schedule = record.get("resolved_identities") or []
    if schedule:
        lines.append("")
        lines.append("Identity schedule (%d identities you named):"
                     % len(schedule))
        for item in schedule:
            if isinstance(item, dict):
                lines.append("  - %s cited as \"%s\""
                             % (item.get("token"),
                                item.get("displayed_as")))
    lines.append("")
    lines.append("To approve THIS exact action, reply in any words you "
                 "like (\"Yes\" is enough); your reply is recorded word for "
                 "word with the approval. If you do not want it, say so, "
                 "and nothing is sent.")
    return "\n".join(lines)
