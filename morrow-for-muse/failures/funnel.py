#!/usr/bin/env python3
"""Agent-facing error funnel for the Morrow failure translation layer.

agent_error_payload(operation, raw_error) -> dict
agent_error_text(operation, raw_error) -> str

Every agent-facing error emission in the tree funnels through here
(the executor CLI funnel, lanes/detect.py, reauth/state_machine.py
approve/notify refusals). The agent always sees the translated
four-part message first (what was attempted / what the evidence showed
/ what it means / what happens next). Raw exception text may appear
ONLY in the clearly-labeled, sanitized, truncated "engineering_detail"
field, never as the primary message.

Secret hygiene follows the tree's existing conventions:
dispatch/executor.py DEFAULT_REDACT_PATTERNS (key-name redaction) plus
config/securebuf.py's rule that anything short-lived and
credential-shaped counts as secret, including tokens hiding inside
ordinary strings (W2-P2-2 style: a token in a URL query string is not
saved by key-name matching).

Translation must never break the error path: if the translator or the
catalog fails, the funnel emits a minimal structured "unknown" payload
with a fresh correlation id instead of a traceback.

Stdlib only.
"""

from __future__ import annotations

import re
import uuid

from .translator import translate

# Label prefixing raw provider/exception text wherever it is carried.
# Nothing downstream may treat this text as instruction or trusted
# system text (course content is data, never instructions).
ENGINEERING_LABEL = "[untrusted provider data] "
# Label for Morrow's own check of a command's arguments (or its missing
# --yes), refused before anything was sent: the detail is not provider
# text.
LOCAL_CHECK_LABEL = "[Morrow input check] "
_LOCAL_CHECK_CLASSES = frozenset({"CallerInputError", "ConfirmationRequired"})

_ENGINEERING_LIMIT = 500
_EVIDENCE_LIMIT = 320

# Key names that signal secret-bearing values. Mirrors
# dispatch/executor.py DEFAULT_REDACT_PATTERNS.
_REDACT_KEYS = (
    "secure_params", "sesskey", "authenticity_token", "access_token",
    "refresh_token", "id_token", "client_secret", "private_key",
    "api_key", "apikey", "credential", "passwd", "password",
    "secret", "token", "cookie", "authorization", "session",
    # LANE2-D3: PHP session ids. "PHPSESSID" contains neither "session"
    # (it is "sess"+"id") nor "token", so it slipped the compound match.
    "sessid",
)
# LANE2-D3b: bare sid= params (?sid=...) are session ids, but "sid" also
# sits inside ordinary English words (residual, consider), so it must
# NOT join _REDACT_KEYS (that would mask residual_count and friends).
# This rule fires only when sid is the whole key.
_STANDALONE_SID_RE = re.compile(
    r"(?i)(?<![\w.\-])([\"']?)sid\1(\s*[:=]\s*)([\"']?)[^\s'\",;&}]+")
# LANE2-A: compound key names. \b never fires between two word
# characters, so a plain \b(token)\b misses auth_token, _csrf_token,
# canvas_session, sessionid, PHPSESSID. Match the whole key instead:
# an optional [\w.-] prefix, the secret keyword, an optional [\w.-]
# suffix (auth_token, _csrf_token, canvas_session, sessionid all
# match; plain token/session/cookie still match with empty affixes).
# Fail-safe direction: a benign key like session_timeout gets its
# value masked too, which is acceptable in an error payload.
_KEY_VALUE_RE = re.compile(
    r"(?i)(?<![\w.\-])([\w.\-]*?(?:%s)[\w.\-]*)(?:['\"])?\s*[=:]"
    r"\s*(['\"]?)([^\s'\",;&}]+)"
    % "|".join(_REDACT_KEYS))
_BEARER_RE = re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9_\-.~+/=]{8,}")
# LANE2-A: bare high-risk token prefixes. These ride bare in text with
# underscores/dashes the long-run rule below deliberately skips (so
# snake_case forensics survive), e.g. sk_live_4eC39... or a bare
# xoxb-... Slack token. Stripe test keys included: a test secret in a
# log is still a secret.
_KNOWN_PREFIX_RE = re.compile(
    r"\b(?:sk_live|sk_test|xox[bpras]|ghp_|gho_|github_pat_|AKIA)"
    r"[A-Za-z0-9_\-]{8,}\b")
# Long opaque runs (hex/base64-ish tokens riding bare in a message,
# e.g. a session id pasted into provider text). 32+ chars from the
# token alphabet, with no underscores: real tokens are hex/base64/UUID
# shaped, while snake_case filesystem slugs and identifiers (useful
# forensics, not secrets) survive. The key=value and bearer rules
# above already cover secret-bearing pairs like token=sk_live_....
_LONG_RUN_RE = re.compile(r"\b[A-Za-z0-9+\-/=]{32,}\b")

# Evidence keys that may carry raw provider/exception blobs: never
# rendered into agent-visible fields except inside engineering_detail.
_BLOB_KEYS = frozenset(
    {"error_text", "body_text", "headers", "correlation_id"})

_FALLBACK_MESSAGE = (
    "What was attempted: {operation}. "
    "What the evidence showed: the failure could not be classified, and "
    "the translation layer itself hit an internal error while "
    "classifying it. "
    "What this means: the operation did not complete normally and I "
    "cannot tell you why from the available evidence. "
    "What happens next: I am not retrying anything that might have "
    "applied. If it happens again, you can email hello@meetmorrow.app "
    "with reference {correlation_id}, the Morrow for Muse version, and "
    "what you asked for. Leave student information out of the email."
)


def _class_name(raw_error) -> str:
    if isinstance(raw_error, dict):
        name = raw_error.get("error")
        return str(name) if name else "dict"
    try:
        return type(raw_error).__name__
    except Exception:
        return "unknown"


def _raw_text(raw_error, limit=None) -> str:
    if isinstance(raw_error, dict):
        text = raw_error.get("detail") or ""
    elif isinstance(raw_error, BaseException):
        try:
            text = str(raw_error)
        except Exception:
            text = "<unprintable %s>" % _class_name(raw_error)
    else:
        try:
            text = str(raw_error)
        except Exception:
            text = "<unprintable %s>" % _class_name(raw_error)
    if not isinstance(text, str):
        text = ""
    if limit is not None and len(text) > limit:
        text = text[:limit - 3] + "..."
    return text


def scrub_secrets(text) -> str:
    """Mask secret-shaped values inside free text.

    Key=value pairs for known secret key names (including compound
    names like auth_token, _csrf_token, canvas_session, sessionid),
    bearer/basic auth headers, bare high-risk token prefixes
    (sk_live_, xoxb-, ghp_, ...), and long opaque token runs. Only
    the secret portion is masked; surrounding text survives so the
    record stays useful.
    """
    if not isinstance(text, str) or not text:
        return text if isinstance(text, str) else ""
    # LANE2-3: bearer/basic FIRST. The key=value rule below would
    # otherwise consume the "Bearer" keyword as the value (stopping at
    # the space) and leave the actual token orphaned and unredacted.
    scrubbed = _BEARER_RE.sub(
        lambda m: "%s [redacted]" % m.group(1), text)
    scrubbed = _KEY_VALUE_RE.sub(
        lambda m: "%s=%s[redacted]" % (m.group(1), m.group(2)), scrubbed)
    # LANE2-D3b: standalone sid keys only (see _STANDALONE_SID_RE).
    scrubbed = _STANDALONE_SID_RE.sub(
        lambda m: "%ssid%s%s%s[redacted]" % (m.group(1), m.group(1),
                                            m.group(2), m.group(3)),
        scrubbed)
    scrubbed = _KNOWN_PREFIX_RE.sub("[redacted]", scrubbed)
    scrubbed = _LONG_RUN_RE.sub("[redacted]", scrubbed)
    return scrubbed


def _evidence_summary(evidence: dict, limit=_EVIDENCE_LIMIT) -> str:
    """Compact agent-visible evidence summary: structural keys only.

    Raw blobs (error_text, body_text, headers) are excluded here; they
    belong in engineering_detail. Scalar values are secret-scrubbed.
    """
    parts = []
    for key in sorted(evidence):
        if key in _BLOB_KEYS:
            continue
        value = evidence[key]
        if value is None or value == "" or value == [] or value == {}:
            continue
        if isinstance(value, (dict, list)):
            continue
        try:
            rendered = scrub_secrets(str(value))
        except Exception:
            rendered = "?"
        parts.append("%s=%s" % (key, rendered))
    summary = ", ".join(parts)
    if len(summary) > limit:
        summary = summary[:limit - 3] + "..."
    return summary or "(no structured evidence)"


def _detail_label(raw_error) -> str:
    if _class_name(raw_error) in _LOCAL_CHECK_CLASSES:
        return LOCAL_CHECK_LABEL
    return ENGINEERING_LABEL


def _payload(operation, translated, raw_error) -> dict:
    """Build the agent-facing payload from a TranslatedError."""
    return {
        # "error" keeps the pre-translation key so existing tooling
        # that keys on it keeps working. "detail" is gone on purpose:
        # raw exception text is never the primary message again.
        "error": _class_name(raw_error),
        "mode_id": translated.mode_id,
        "correlation_id": translated.correlation_id,
        "message": translated.agent_message,
        "attempted": translated.attempted,
        "evidence": _evidence_summary(translated.evidence),
        "meaning": translated.meaning,
        "next_step": translated.next_step,
        "auto_action": translated.auto_action,
        "escalate": bool(translated.escalate),
        "engineering_detail": _detail_label(raw_error) + scrub_secrets(
            _raw_text(raw_error, _ENGINEERING_LIMIT)),
    }


def _degraded_payload(operation, raw_error) -> dict:
    """Last-resort payload when the translator itself failed."""
    correlation_id = uuid.uuid4().hex[:12]
    operation = operation or "(unnamed operation)"
    return {
        "error": _class_name(raw_error),
        "mode_id": "unknown",
        "correlation_id": correlation_id,
        "message": _FALLBACK_MESSAGE.format(
            operation=operation, correlation_id=correlation_id),
        "attempted": operation,
        "evidence": "(evidence unavailable: the translator failed)",
        "meaning": ("The failure could not be classified and the "
                    "translation layer itself hit an internal error."),
        "next_step": ("Park the op; never blind-retry; give the "
                      "educator the reference and the support address. "
                      "Escalate when: always."),
        "auto_action": ("Park the op; never blind-retry; give the "
                        "educator the support address."),
        "escalate": True,
        "engineering_detail": _detail_label(raw_error) + scrub_secrets(
            _raw_text(raw_error, _ENGINEERING_LIMIT)),
    }


def agent_error_payload(operation, raw_error) -> dict:
    """Translate a raw failure into the agent-facing error payload.

    Never raises: translator/catalog failures degrade to a minimal
    structured unknown payload rather than a traceback.
    """
    try:
        translated = translate(operation, raw_error)
    except Exception:
        return _degraded_payload(operation, raw_error)
    try:
        return _payload(operation, translated, raw_error)
    except Exception:
        return _degraded_payload(operation, raw_error)


def agent_error_text(operation, raw_error) -> str:
    """The four-part message as human-readable lines, for CLIs that
    speak plain text rather than JSON (e.g. state_machine approve)."""
    payload = agent_error_payload(operation, raw_error)
    return "%s\n[mode: %s | correlation_id: %s | escalate: %s]" % (
        payload["message"], payload["mode_id"],
        payload["correlation_id"],
        "yes" if payload["escalate"] else "no")
