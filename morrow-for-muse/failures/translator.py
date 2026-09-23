#!/usr/bin/env python3
"""Error translation for the Morrow failure-mode catalog.

translate(operation, raw_error) -> TranslatedError.

raw_error may be:
  - an exception instance (ExecutorError family, ItemBankSdkError family,
    MoodleLaneError with the kind in args[0], CDPError, RuntimeError,
    OSError, admission refusals, ...), or
  - a dict of evidence (e.g. {"http_status": 422, "body_text": "...",
    "reads_ok": True}) or the CLI funnel shape
    {"error": "<ClassName>", "detail": "<text>"}.

Matching: each catalog entry's signature is a set of evidence predicates;
an entry matches when every top-level predicate matches AND (when the
entry has __any_of) at least one alternative branch matches. Most specific
match wins (predicate count); ties break deterministically by catalog
order (first entry wins). Genuinely unknown errors fall through to the
structured "unknown" fallback: attempted / checked / evidence captured
with a correlation id / concrete next step. Never a shrug.

Stdlib only.
"""

from __future__ import annotations

import json
import re
import uuid
from collections import defaultdict
from dataclasses import dataclass, field

from .catalog import load_catalog, Catalog

# Session-death exception names, mirrored from
# dispatch/executor.py _SESSION_DEAD_NAMES plus the SDK lane. Checked
# AFTER BrowserStaleCommand: a stale command is a FRESH session, never
# session death, even though BrowserStaleCommand subclasses
# BrowserSessionDead.
_SESSION_DEAD_NAMES = frozenset({
    "ChromiumSessionDead",
    "BrowserSessionDead",
    "SessionDead",
    "ItemBankSdkSessionDead",
})

# Provider values the normalizer can produce (the matching contract).
_KNOWN_PROVIDERS = ("canvas", "moodle", "item-banks", "helper")

# Write-integrity exception names that set machine-checkable flags, mirroring
# dispatch/executor.py's terminal classifications.
_UNCERTAIN_WRITE_NAMES = frozenset({"UncertainWrite"})
_WRITE_NOT_ATTEMPTED_NAMES = frozenset({"WriteNotAttempted"})

# Admission-gate / mode-system exception names (modes/ package, workstream A;
# ModeSettingsTamper comes from the settings/ package, workstream B). The
# classes do not exist in this tree yet, so match on class name: the same
# route the CLI funnel's {"error": "<ClassName>"} shape takes. Scalar
# exception attributes (grant_id, query, candidates_public, ...) are merged
# as evidence. Documented evidence shapes live in
# failures/test_error_translation.py (MODE_EVIDENCE_NOTES).
#
# The edit grant is blanket (Braden 2026-09-22): no course or category
# scopes exist, so there are no scope-disambiguation flags.
_MODE_EXCEPTION_FLAGS = {
    "ModeSelfGrantRefused": "mode_self_grant_refused",
    "PlanModeWriteWithoutApproval": "plan_mode_write_without_approval",
    "AmbiguousCourseWriteRefused": "ambiguous_course_write_refused",
    "ModeSettingsTamper": "mode_settings_tamper",
    "DestructiveConfirmationRequired": "destructive_write_confirmation_required",
}

# Scalar exception attributes merged into evidence for mode-system
# exceptions. Only scalars merge: structured payloads stay on the
# exception, provider-side.
_MODE_EXCEPTION_ATTRS = (
    "course_id", "grant_id", "plan_id", "setting_name", "mode",
    "query", "candidates_public", "match_count", "match_kind",
    "entry_name",
)

_RATE_LIMIT_NUM_RE = re.compile(r"[0-9]+(?:\.[0-9]+)?")
_PROVIDER_HINT_RES = (
    ("moodle", re.compile(r"moodle", re.IGNORECASE)),
    ("item-banks", re.compile(r"item[\s_\-]?banks?", re.IGNORECASE)),
    ("helper", re.compile(r"\bhelper\b", re.IGNORECASE)),
    ("canvas", re.compile(r"canvas", re.IGNORECASE)),
)

# HTTP status smuggled inside free-text error messages (e.g. BrowserOpFailed).
_HTTP_STATUS_RE = re.compile(r"\bHTTP\s+(\d{3})\b", re.IGNORECASE)

# A provider's validation words are untrusted data: long numbers (LMS
# user ids) and email addresses in them never reach the agent.
_LONG_NUMBER_RE = re.compile(r"\d{5,}")
_EMAIL_RE = re.compile(r"[\w.+\-]+@[\w\-]+(?:\.[\w\-]+)+")
_VALIDATION_LIMIT = 300


def _validation_messages(body_text):
    """"field: message" pairs from a Canvas validation error body
    ({"errors": {"title": [{"message": ...}]}}, {"errors": [{"message":
    ...}]}, or {"message": ...}), cleaned and bounded; "" when the body
    carries none."""
    try:
        doc = json.loads(body_text)
    except (TypeError, ValueError):
        return ""
    found = []
    errors = doc.get("errors") if isinstance(doc, dict) else None
    if isinstance(errors, dict):
        for field, items in errors.items():
            for item in items if isinstance(items, list) else [items]:
                text = item.get("message") if isinstance(item, dict) \
                    else item
                if isinstance(text, str) and text.strip():
                    found.append("%s: %s" % (str(field).replace("_", " "),
                                             text))
    elif isinstance(errors, list):
        for item in errors:
            text = item.get("message") if isinstance(item, dict) else item
            if isinstance(text, str) and text.strip():
                found.append(text)
    elif isinstance(doc, dict) and isinstance(doc.get("message"), str):
        found.append(doc["message"])
    text = "; ".join(" ".join(t.split()) for t in found)
    text = _EMAIL_RE.sub("[email]", _LONG_NUMBER_RE.sub("[number]", text))
    if len(text) > _VALIDATION_LIMIT:
        text = text[:_VALIDATION_LIMIT - 3] + "..."
    return text


class _SafeDict(defaultdict):
    def __missing__(self, key):
        return "(unknown)"


@dataclass
class TranslatedError:
    """One translated failure, ready for the agent surface."""
    mode_id: str
    attempted: str
    evidence: dict
    meaning: str
    next_step: str
    auto_action: str
    escalate: bool
    agent_message: str
    correlation_id: str = field(default="")


def _coerce_status(value):
    """Coerce an int or clean numeric string to an HTTP status int, else None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        match = re.fullmatch(r"\s*(\d{3})\s*", value)
        if match:
            return int(match.group(1))
    return None


def _parse_rate_limit(value):
    """Parse x-rate-limit-remaining-ish values to float, else None.

    Accepts numbers, clean numeric strings, and human notes like
    ">0 (bucket full, e.g. 700.0)" (the example number wins when the
    string claims a positive bucket with ">").
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        nums = _RATE_LIMIT_NUM_RE.findall(value)
        if not nums:
            return None
        floats = [float(n) for n in nums]
        if value.strip().startswith(">"):
            return max(floats)
        return floats[0]
    return None


def _headers_dict(evidence):
    headers = evidence.get("headers")
    return headers if isinstance(headers, dict) else {}


def _header(headers, name):
    for key, value in headers.items():
        if str(key).lower() == name:
            return value
    return None


def _guess_provider(evidence) -> str:
    """Best-effort provider from error text/class/route; 'unknown' if none."""
    text = "%s %s %s" % (evidence.get("error_class", ""),
                         evidence.get("error_text", ""),
                         evidence.get("route_path", ""))
    for provider, pattern in _PROVIDER_HINT_RES:
        if pattern.search(text):
            return provider
    return "unknown"


def _guess_route_kind(evidence) -> str:
    path = str(evidence.get("route_path") or "").lower()
    if "/api/items/" in path:
        return "literal"
    if "/api/banks/" in path or "item_bank" in path:
        return "canonical"
    return "unknown"


def _derive_retry_after_present(evidence, headers):
    """True/False when determinable, else None (leave the key unset)."""
    retry_after = evidence.get("retry_after")
    if retry_after is not None:
        if isinstance(retry_after, str) and \
                retry_after.strip().lower() in ("absent", "none", "", "null"):
            return False
        return bool(retry_after)
    if _header(headers, "retry-after") is not None:
        return True
    return None


def _coerce_evidence(raw_error) -> dict:
    """Normalize an exception or dict into the flat evidence map.

    Produces, at minimum: http_status (int), body_text (str), provider
    (canvas/moodle/item-banks/helper/unknown), route_kind
    (canonical/literal/unknown), reads_ok, writes_fail,
    rate_limit_remaining (float or absent), retry_after_present (bool or
    absent), session_logged_in, chromium_alive, write_halt_active,
    error_class, moodle_kind. Every derivation is defensive: missing
    evidence leaves the key unset (so predicates on it do not match)
    and never raises.
    """
    if isinstance(raw_error, dict):
        evidence = dict(raw_error)
        evidence.setdefault("error_class", raw_error.get("error") or "dict")
        evidence.setdefault("error_text", raw_error.get("detail") or "")
    elif isinstance(raw_error, BaseException):
        exc = raw_error
        class_name = type(exc).__name__
        try:
            error_text = str(exc)
        except Exception:
            # Pathological __str__ must not break normalization.
            error_text = "<unprintable %s>" % class_name
        evidence = {
            "error_class": class_name,
            "error_text": error_text,
        }
        # ProviderHttpError carries .status; UncertainWrite carries .evidence.
        status = getattr(exc, "status", None)
        if isinstance(status, int) and not isinstance(status, bool):
            evidence["http_status"] = status
        for attr in ("route_path", "provider", "operation_kind",
                     "halt_cause"):
            value = getattr(exc, attr, None)
            if value is not None:
                evidence[attr] = value
        body = getattr(exc, "body", None)
        if body is not None:
            evidence["body_text"] = body
        headers = getattr(exc, "headers", None)
        if isinstance(headers, dict):
            evidence["headers"] = headers
        # Stale commands are fresh sessions: never classify as session death.
        if class_name == "BrowserStaleCommand":
            evidence["stale_command"] = True
        elif class_name in _SESSION_DEAD_NAMES:
            evidence["session_dead_signal"] = True
        # Student-resolution outcomes (learners/resolve_student.py)
        # carry a flat scalar evidence map for the agent-visible
        # summary. Only scalars merge: structured candidate detail
        # (names, emails, logins) stays on the exception, provider-side.
        res_evidence = getattr(exc, "resolution_evidence", None)
        if isinstance(res_evidence, dict):
            for res_key, res_value in res_evidence.items():
                if res_key not in evidence and isinstance(
                        res_value, (str, int, float, bool)):
                    evidence[res_key] = res_value
        if class_name == "WriteHaltActive":
            evidence["write_halt_active"] = True
        if class_name in _UNCERTAIN_WRITE_NAMES:
            evidence["uncertain_write"] = True
        if class_name in _WRITE_NOT_ATTEMPTED_NAMES:
            evidence["write_not_attempted"] = True
        # Mode-system admission refusals (modes/ package, workstream A;
        # ModeSettingsTamper is the settings/ package, workstream B).
        # Sets a machine-checkable flag and merges scalar exception
        # attributes (grant_id, query, candidates_public, ...) so the
        # catalog's evidence works on exception inputs exactly as on
        # dict evidence.
        mode_flag = _MODE_EXCEPTION_FLAGS.get(class_name)
        if mode_flag is not None:
            evidence[mode_flag] = True
            for attr in _MODE_EXCEPTION_ATTRS:
                if attr not in evidence:
                    value = getattr(exc, attr, None)
                    if isinstance(value, (str, int, float, bool)):
                        evidence[attr] = value
        if class_name == "MoodleLaneError" and exc.args:
            kind = exc.args[0]
            evidence["provider"] = "moodle"
            evidence["moodle_kind"] = kind
            if kind == "reauth":
                evidence["session_dead_signal"] = True
            if len(exc.args) > 1 and isinstance(exc.args[1], str):
                evidence["error_text"] = exc.args[1]
        # Free-text HTTP status (BrowserOpFailed and friends).
        if "http_status" not in evidence:
            match = _HTTP_STATUS_RE.search(evidence["error_text"])
            if match:
                try:
                    evidence["http_status"] = int(match.group(1))
                except ValueError:
                    pass
    else:
        # Non-exception, non-dict input: treat as opaque error text.
        evidence = {
            "error_class": type(raw_error).__name__,
            "error_text": _safe_str(raw_error),
        }

    # ---- Derivation passes (dict and exception inputs alike). ----
    try:
        # error_text must be a string for the regex and snippet helpers.
        error_text = evidence.get("error_text")
        if not isinstance(error_text, str):
            try:
                evidence["error_text"] = str(error_text) \
                    if error_text is not None else ""
            except Exception:
                evidence["error_text"] = ""

        # http_status: coerce; junk values leave the key unset.
        if "http_status" in evidence:
            coerced = _coerce_status(evidence["http_status"])
            if coerced is None:
                evidence.pop("http_status", None)
            else:
                evidence["http_status"] = coerced
        elif "status" in evidence:
            coerced = _coerce_status(evidence["status"])
            if coerced is not None:
                evidence["http_status"] = coerced

        # body_text: explicit keys win; always a string ("" = no body evidence).
        body = evidence.get("body_text", evidence.get("body", ""))
        evidence["body_text"] = body if isinstance(body, str) else str(body or "")

        # provider: explicit valid value wins; singular "item-bank" normalized.
        provider = evidence.get("provider")
        if provider == "item-bank":
            provider = "item-banks"
            evidence["provider"] = provider
        if provider not in _KNOWN_PROVIDERS:
            evidence["provider"] = _guess_provider(evidence)

        # route_kind: explicit canonical/literal wins; else derive from path.
        if evidence.get("route_kind") not in ("canonical", "literal"):
            evidence["route_kind"] = _guess_route_kind(evidence)

        # rate_limit_remaining: float when parseable, else leave unset.
        if "rate_limit_remaining" in evidence:
            parsed = _parse_rate_limit(evidence["rate_limit_remaining"])
            if parsed is None:
                evidence.pop("rate_limit_remaining", None)
            else:
                evidence["rate_limit_remaining"] = parsed
        else:
            headers = _headers_dict(evidence)
            header_value = _header(headers, "x-rate-limit-remaining")
            parsed = _parse_rate_limit(header_value) \
                if header_value is not None else None
            if parsed is not None:
                evidence["rate_limit_remaining"] = parsed

        # retry_after_present: True/False when determinable, else unset.
        headers = _headers_dict(evidence)
        if "retry_after_present" in evidence:
            evidence["retry_after_present"] = bool(
                evidence["retry_after_present"])
        else:
            derived = _derive_retry_after_present(evidence, headers)
            if derived is not None:
                evidence["retry_after_present"] = derived

        # redirect_location: explicit, redirect_to alias, or Location header.
        if not evidence.get("redirect_location"):
            target = evidence.get("redirect_to") or \
                _header(headers, "location")
            if target:
                evidence["redirect_location"] = str(target)

        # session_logged_in: explicit wins; "logged_in" is the legacy alias.
        if "session_logged_in" not in evidence and "logged_in" in evidence:
            evidence["session_logged_in"] = bool(evidence["logged_in"])

        # request_id: explicit wins; else the x-request-context-id header.
        if "request_id" not in evidence:
            request_id = _header(headers, "x-request-context-id")
            if request_id:
                evidence["request_id"] = str(request_id)

        # validation_messages: what the provider said when it refused
        # the request (any 4xx without the CSRF marker): a refused
        # value, a permission refusal, or an item it could not find.
        status = evidence.get("http_status")
        if isinstance(status, int) and 400 <= status < 500 \
                and "unprocessable_content" not in evidence["body_text"] \
                and "validation_messages" not in evidence:
            messages = _validation_messages(evidence["body_text"])
            if messages:
                evidence["validation_messages"] = messages
    except Exception:
        # Normalization must never crash translation; partial evidence stands.
        pass
    return evidence


def _predicate_matches(spec, value) -> bool:
    """Evaluate one predicate spec against one evidence value.

    Missing evidence (value None) never matches, except for an explicit
    {"exists": False} absence check. This is the fail-closed rule: a
    predicate must see its evidence, never infer from its absence.
    """
    if isinstance(spec, dict):
        if len(spec) != 1:
            return False
        op, operand = next(iter(spec.items()))
        if value is None:
            return op == "exists" and not operand
        if op == "eq":
            return value == operand
        if op == "neq":
            return value != operand
        if op == "contains":
            return isinstance(value, str) and operand in value
        if op == "not_contains":
            return not (isinstance(value, str) and operand in value)
        if op == "startswith":
            return isinstance(value, str) and value.startswith(operand)
        if op == "lte":
            return isinstance(value, (int, float)) and value <= operand
        if op == "gte":
            return isinstance(value, (int, float)) and value >= operand
        if op == "in":
            return value in operand
        if op == "not_in":
            return value not in operand
        if op == "exists":
            return (value is not None) == bool(operand)
        if op == "truthy":
            return bool(value)
        if op == "falsy":
            return not bool(value)
        return False
    # Literal: equality.
    return value == spec


def _branch_matches(branch: dict, evidence: dict) -> bool:
    return all(_predicate_matches(spec, evidence.get(key))
               for key, spec in branch.items())


def _signature_match_detail(signature: dict, evidence: dict):
    """(matched, specificity) for one signature against evidence.

    Specificity counts only the predicates that actually matched: the
    top-level predicate count plus the size of the __any_of branch that
    matched (not the largest branch overall, which would over-score
    multi-branch entries and break most-specific-wins ordering).
    """
    top = 0
    for key, spec in signature.items():
        if key == "__any_of":
            continue
        if not _predicate_matches(spec, evidence.get(key)):
            return False, 0
        top += 1
    branches = signature.get("__any_of")
    if branches:
        best = 0
        for branch in branches:
            if _branch_matches(branch, evidence):
                best = max(best, len(branch))
        if best == 0:
            return False, 0
        return True, top + best
    return True, top


def _signature_matches(signature: dict, evidence: dict) -> bool:
    matched, _ = _signature_match_detail(signature, evidence)
    return matched


def _signature_specificity(signature: dict) -> int:
    """Predicate count, kept for backward compatibility.

    Prefer _signature_match_detail: this counts the largest __any_of
    branch whether or not it matched, which is only a rough proxy.
    """
    count = sum(1 for key in signature if key != "__any_of")
    branches = signature.get("__any_of") or []
    if branches:
        count += max(len(branch) for branch in branches)
    return count


def _safe_str(value, default=""):
    try:
        return str(value)
    except Exception:
        return default


def _evidence_summary(evidence: dict, limit=320) -> str:
    """Compact sorted key=value view of scalar evidence (no blobs)."""
    parts = []
    skip = {"error_text"}
    for key in sorted(evidence):
        if key in skip:
            continue
        value = evidence[key]
        if value is None or value == "" or value == [] or value == {}:
            continue
        if isinstance(value, (dict, list)):
            continue
        parts.append("%s=%s" % (key, _safe_str(value, "?")))
    summary = ", ".join(parts)
    if len(summary) > limit:
        summary = summary[:limit - 3] + "..."
    return summary or "(no structured evidence)"


def _body_snippet(evidence: dict, limit=240) -> str:
    text = evidence.get("body_text") or evidence.get("error_text") or ""
    text = " ".join(_safe_str(text).split())
    if len(text) > limit:
        text = text[:limit - 3] + "..."
    return text or "(no error text captured)"


def _yes_no(value):
    return "yes" if value else "no"


def _known_facts(evidence: dict) -> str:
    """The facts the evidence carries, for the structured fallback. A
    fact the evidence does not carry is left out, never printed as
    unknown."""
    facts = []
    if evidence.get("http_status") is not None:
        facts.append("the provider answered with status %s"
                     % evidence["http_status"])
    request_id = evidence.get("request_id") \
        or evidence.get("x_request_context_id")
    if request_id:
        facts.append("request id %s" % request_id)
    for key, label in (("session_logged_in", "signed in"),
                       ("chromium_alive", "browser running"),
                       ("write_halt_active", "changes paused")):
        if evidence.get(key) is not None:
            facts.append("%s: %s" % (label, _yes_no(evidence[key])))
    if evidence.get("attempt_count") is not None:
        facts.append("%s attempts" % evidence["attempt_count"])
    if evidence.get("op_id"):
        facts.append("journal operation %s" % evidence["op_id"])
    facts.append("error type %s" % (evidence.get("error_class")
                                    or "not captured"))
    return "; ".join(facts)


def _sentence(text):
    return str(text or "").strip().rstrip(".").strip()


def next_step_text(entry) -> str:
    """The entry's auto action and escalation rule as one next step,
    each ending in exactly one period."""
    return "%s. Escalate when: %s." % (
        _sentence(entry.get("auto_action", "")),
        _sentence(entry.get("escalate_when", "engineering asks")))


def match_catalog(catalog: Catalog, evidence: dict):
    """Best matching catalog entry for evidence, or None.

    Most specific match wins (predicate count); deterministic tiebreak
    by catalog order. The fallback entry is never returned.
    """
    best = None
    best_score = -1
    for entry in catalog.matchable():
        signature = entry.get("signature", {})
        matched, score = _signature_match_detail(signature, evidence)
        if matched and score > best_score:
            best = entry
            best_score = score
    return best


def translate(operation, raw_error, catalog=None, catalog_path=None) -> TranslatedError:
    """Translate a raw failure into a specific, actionable message.

    operation: what was attempted, as a phrase in the educator's words
    that every message template reads correctly ("creating an
    assignment in Biology 101", "reading the assignments in course
    101"), never an op id or an internal name. catalog: a loaded
    Catalog, or catalog_path for the
    loader. Returns a TranslatedError carrying the mode id, the four
    message parts as fields, and the fully rendered agent_message.

    Input contract: raw_error is an exception OR a dict in the
    NORMALIZED evidence namespace that failures/funnel.py produces:
    http_status (int), body_text (str), provider
    (canvas/moodle/item-banks/helper), route_path, route_kind, plus the
    classification flags writes_fail, reads_ok, rate_limit_remaining,
    retry_after_present, session_logged_in, chromium_alive,
    write_halt_active, and any scalar evidence fields. Raw probe keys
    (status, body) are NOT in the contract: a dict carrying only them
    matches no signatured mode and falls back to the structured
    "unknown" message rather than guessing. See InputContractTests.
    """
    if catalog is None:
        catalog = load_catalog(catalog_path)
    evidence = _coerce_evidence(raw_error)
    correlation_id = uuid.uuid4().hex[:12]
    evidence["correlation_id"] = correlation_id
    entry = match_catalog(catalog, evidence)
    if entry is None:
        entry = catalog.fallback()
    context = _SafeDict()
    context.update({
        "operation": operation or "(unnamed operation)",
        "provider": evidence.get("provider") or "(unknown provider)",
        "status": evidence.get("http_status", "(unknown status)"),
        "body_snippet": _body_snippet(evidence),
        "evidence_summary": _evidence_summary(evidence),
        "route_path": evidence.get("route_path") or "(unknown route)",
        "correlation_id": correlation_id,
        "rate_limit_remaining": evidence.get("rate_limit_remaining",
                                             "(not reported)"),
        "retry_after": evidence.get("retry_after", "(not reported)"),
        # Placeholders used by the inventory-derived agent messages.
        "tenant": evidence.get("tenant") or evidence.get("tenant_base")
        or "(unknown tenant)",
        "status_code": evidence.get("http_status", "(unknown status)"),
        "logged_in": evidence.get("session_logged_in", "(unknown)"),
        "chromium_alive": evidence.get("chromium_alive", "(unknown)"),
        "write_halt_active": evidence.get("write_halt_active", "(unknown)"),
        "request_id": evidence.get("request_id")
        or evidence.get("x_request_context_id") or "(unknown)",
        "attempt_count": evidence.get("attempt_count", "(unknown)"),
        "op_id": evidence.get("op_id", "(unknown)"),
        "object": evidence.get("object") or "(unnamed object)",
        "collection": evidence.get("collection") or "(unnamed collection)",
        "course_id": evidence.get("course_id") or "(unknown course)",
        # Student-resolution placeholders (learners/resolve_student.py).
        "query": evidence.get("query") or "(unknown)",
        "candidates_public": evidence.get("candidates_public")
        or "(none listed)",
        "match_count": evidence.get("match_count", "(unknown)"),
        "match_kind": evidence.get("match_kind") or "(unknown)",
        "excluded_summary": evidence.get("excluded_summary") or "(none)",
        # Edit/plan-mode placeholders (modes/ package workstream A,
        # settings/ package workstream B). Scalar only; missing values
        # render as explicit unknowns, never as a crash.
        "grant_id": evidence.get("grant_id") or "(unknown grant)",
        "setting_name": evidence.get("setting_name") or "(unknown setting)",
        "plan_id": evidence.get("plan_id") or "(no plan id)",
        "mode": evidence.get("mode") or "(unknown mode)",
        # Quiz-resolution placeholders (query/quiz_resolve.py).
        "window_start": evidence.get("window_start") or "(unknown)",
        "window_end": evidence.get("window_end") or "(unknown)",
        "candidates_examined": evidence.get("candidates_examined",
                                            "(unknown)"),
        "undated": evidence.get("undated", "(unknown)"),
        "unpublished": evidence.get("unpublished", "(unknown)"),
        "nearest_public": evidence.get("nearest_public") or "(none listed)",
        # Provider validation refusals (a 400/422 with an errors body).
        "validation_messages": evidence.get("validation_messages")
        or "(no reason given)",
        # The structured fallback: only the facts the evidence carries.
        "known_evidence": _known_facts(evidence),
        "where": (" on %s" % (evidence.get("tenant")
                              or evidence.get("tenant_base"))
                  if evidence.get("tenant") or evidence.get("tenant_base")
                  else ""),
    })
    auto_action = entry.get("auto_action", "")
    context["auto_action"] = auto_action
    agent_message = entry["agent_message"].format_map(context)
    is_not = entry.get("is_not")
    meaning = entry.get("root_cause", "")
    if is_not:
        meaning = "%s %s" % (meaning, is_not)
    next_step = next_step_text(entry)
    severity = entry.get("severity_hint", "medium")
    escalate = (
        entry.get("fallback") is True
        or severity == "critical"
        or evidence.get("escalate") is True
    )
    return TranslatedError(
        mode_id=entry["id"],
        attempted=context["operation"],
        evidence=dict(evidence),
        meaning=meaning,
        next_step=next_step,
        auto_action=auto_action,
        escalate=escalate,
        agent_message=agent_message,
        correlation_id=correlation_id,
    )
