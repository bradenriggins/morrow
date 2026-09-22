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


def render_approval_display(record, params, entry=None):
    """Render the human-readable approval display the educator reviews
    before authorizing. Includes the FULL canonical params."""
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
