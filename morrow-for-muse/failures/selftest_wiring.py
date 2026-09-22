#!/usr/bin/env python3
"""Wiring selftest: the agent-facing error funnel.

Proves, standalone (exit 0 on success, loud non-zero on failure):

1. A synthetic 422-CSRF raw error fed through the agent-facing error
   path (failures.funnel.agent_error_payload, the exact function the
   executor CLI funnel calls) comes out with the four anchors and the
   correct mode_id (canvas-csrf-422-writes-only).
2. A synthetic unknown error comes out structured with a correlation id
   and escalate=true.
3. Raw exception text is never the primary message: it may appear only
   in the clearly-labeled engineering_detail field, sanitized.
4. Secrets are scrubbed from every agent-visible field.
5. The REAL executor CLI funnel (dispatch/executor.py __main__) wires
   through the translator: a failing CLI run exits 2 with the
   structured JSON on stderr (mode_id, correlation_id, four anchors,
   escalate, labeled engineering detail).

Synthetic evidence only: no provider calls, no live writes.
"""

import json
import os
import re
import subprocess
import sys

_TREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE_ROOT not in sys.path:
    sys.path.insert(0, _TREE_ROOT)

from failures import agent_error_payload, agent_error_text  # noqa: E402
from failures.funnel import ENGINEERING_LABEL  # noqa: E402

ANCHORS = ("What was attempted", "What the evidence showed",
           "What this means", "What happens next")


def _check(cond, reason):
    if not cond:
        print("WIRING FAIL: %s" % reason, file=sys.stderr)
        sys.exit(1)


def _csrf_raw_error():
    """Synthetic 422-CSRF evidence: writes fail, reads fine, full
    rate-limit bucket, no Retry-After, session healthy."""
    return {
        "provider": "canvas",
        "http_status": 422,
        "body_text": ('{"errors":[{"message":"An error occurred.",'
                      '"error_code":"unprocessable_content"}]}'),
        "reads_ok": True,
        "writes_fail": True,
        "rate_limit_remaining": 700.0,
        "retry_after_present": False,
        "session_logged_in": True,
    }


def main():
    # ---- 1. 422-CSRF through the agent-facing error path. ----
    payload = agent_error_payload(
        "create assignment in Biology 101", _csrf_raw_error())
    _check(payload["mode_id"] == "canvas-csrf-422-writes-only",
           "expected canvas-csrf-422-writes-only, got %r"
           % payload["mode_id"])
    for anchor in ANCHORS:
        _check(anchor in payload["message"],
               "message missing anchor %r" % anchor)
    _check(payload["attempted"] == "create assignment in Biology 101",
           "attempted field wrong: %r" % payload["attempted"])
    _check(isinstance(payload["escalate"], bool),
           "escalate must be a bool")
    _check(re.fullmatch(r"[0-9a-f]{12}", payload["correlation_id"] or ""),
           "correlation_id must be 12 hex chars, got %r"
           % payload["correlation_id"])
    # The raw provider body is evidence, not the message: the message
    # must not BE the raw detail.
    _check(payload["message"] != _csrf_raw_error()["body_text"],
           "raw detail is the primary message")

    # ---- 2. Unknown error: structured, correlation id, escalate. ----
    raw_text = "frobnicate plasma conduit 9ZQ7 utterly bizarre"
    payload = agent_error_payload("mystery op", ValueError(raw_text))
    _check(payload["mode_id"] == "unknown",
           "expected unknown fallback, got %r" % payload["mode_id"])
    _check(payload["escalate"] is True, "unknown must escalate")
    _check(re.fullmatch(r"[0-9a-f]{12}", payload["correlation_id"] or ""),
           "unknown needs a correlation id")
    for anchor in ANCHORS:
        _check(anchor in payload["message"],
               "unknown message missing anchor %r" % anchor)
    _check(payload["correlation_id"] in payload["message"],
           "unknown message must reference the correlation id")

    # ---- 3. Raw exception text is never the primary message. ----
    _check(payload["message"] != raw_text,
           "raw exception text is the primary message")
    _check(raw_text not in payload["message"],
           "raw exception text leaked into the primary message")
    _check(payload["engineering_detail"].startswith(ENGINEERING_LABEL),
           "engineering detail must carry the untrusted-data label")
    _check(raw_text in payload["engineering_detail"],
           "engineering detail should still carry the (labeled) raw text")

    # ---- 4. Secrets are scrubbed from agent-visible fields. ----
    # Fixture token built by concatenation: the literal sk_live_... shape
    # trips GitHub push protection even as an obvious test fixture.
    secret = "sk_" + "live_abcdef0123456789abcdef0123456789"
    payload = agent_error_payload(
        "secret probe",
        ValueError("provider rejected the call: token=%s&next=1" % secret))
    for field in ("message", "attempted", "evidence", "meaning",
                  "next_step", "auto_action", "engineering_detail"):
        _check(secret not in str(payload[field]),
               "secret leaked into %s" % field)
    _check("[redacted]" in payload["engineering_detail"],
           "secret value should be masked, not echoed")

    # agent_error_text renders the same four-part message as lines.
    text = agent_error_text("text probe", ValueError(raw_text))
    for anchor in ANCHORS:
        _check(anchor in text, "agent_error_text missing anchor %r" % anchor)
    _check(raw_text not in text.split("[mode:")[0],
           "agent_error_text leaked raw text into the message")

    # ---- 5. The real executor CLI funnel wires through. ----
    proc = subprocess.run(
        [sys.executable, os.path.join(_TREE_ROOT, "dispatch", "executor.py"),
         "execute", "--entry", "/nonexistent-entry.json"],
        cwd=_TREE_ROOT, capture_output=True, text=True, timeout=180)
    _check(proc.returncode == 2,
           "CLI funnel must exit 2, got %d (stderr: %s)"
           % (proc.returncode, proc.stderr[-300:]))
    lines = [ln for ln in proc.stderr.splitlines()
             if ln.lstrip().startswith("{")]
    _check(lines, "CLI funnel printed no JSON payload on stderr")
    cli_payload = json.loads(lines[-1])
    _check(cli_payload.get("error") == "FileNotFoundError",
           "error key must keep the exception class name, got %r"
           % cli_payload.get("error"))
    _check("detail" not in cli_payload,
           "'detail' must be gone: raw text is never the primary message")
    _check(cli_payload.get("mode_id") == "unknown",
           "CLI unknown mode expected, got %r" % cli_payload.get("mode_id"))
    _check(cli_payload.get("escalate") is True,
           "CLI unknown must escalate")
    _check(re.fullmatch(r"[0-9a-f]{12}",
                        cli_payload.get("correlation_id") or ""),
           "CLI payload needs a correlation id")
    for anchor in ANCHORS:
        _check(anchor in cli_payload.get("message", ""),
               "CLI message missing anchor %r" % anchor)
    _check(cli_payload.get("attempted") == "execute /nonexistent-entry.json",
           "CLI attempted field wrong: %r" % cli_payload.get("attempted"))
    _check(str(cli_payload.get("engineering_detail", "")).startswith(
        ENGINEERING_LABEL),
        "CLI engineering detail must carry the untrusted-data label")

    print("wiring selftest: PASS (funnel translates; raw text never the "
          "message; secrets scrubbed; CLI funnel verified end to end)")


if __name__ == "__main__":
    main()
