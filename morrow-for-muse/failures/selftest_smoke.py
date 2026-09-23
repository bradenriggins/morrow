#!/usr/bin/env python3
"""Smoke selftest for the failures/ package.

Verifies: the package imports, the merged catalog loads and validates,
translate() resolves representative failure modes to the right mode id
(including the 422-CSRF vs 429 tiebreaker and the stale-vs-dead ordering),
and genuinely unknown errors get the structured fallback (never a shrug).
Exits 0 on success, non-zero with a loud reason on failure. The sibling
test lane owns the full suite; this is the smoke check only.

Catalog under test: the merged catalog (53 canonical inventory
modes + 3 kept seeded modes + 6 query-chain modes + 4 edit/plan-mode
modes + 1 destructive-confirmation mode + 2 CSRF/422-tier modes + 8
newer workstream modes + 2 query-chain read/ref-resolution modes + 6 dispatch-outcome modes
+ 3 signed-in-account modes + 1 validation-refusal mode + 1
session-expiry halt mode + 1 account-mismatch halt mode + 1
saved-task-not-pinned mode + 1
local-input-refusal mode + 1 maintenance-confirmation mode + 1
never-dispatch mode + 1
course-roster mode + 2 prepared-write-gone modes + 2 not-sent modes
for the helper browser and Item Banks + 3 Canvas refusal modes: not
permitted, not found, and any other refused request), less the 14 modes
retired on 2026-09-23 for lanes that do not ship (Moodle, the raw HTTPS
lane's access token, the form and browser-task lanes): 89 entries at
failures/catalog.json.
"""
import os as _home_os, sys as _home_sys  # noqa: E401
_home_sys.path.insert(0, _home_os.path.join(
    _home_os.path.dirname(_home_os.path.abspath(__file__)), '..'))
import config.selftest_home  # noqa: E402,F401  (scratch HOME/MORROW_HOME)

import os
import sys

_TREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE_ROOT not in sys.path:
    sys.path.insert(0, _TREE_ROOT)

from failures import load_catalog, translate  # noqa: E402

BANNED = ["\u2014", "i don't know what happened", "sorry, i don't know",
          "oh well", "no idea what"]


def _check(cond, reason):
    if not cond:
        print("SMOKE FAIL: %s" % reason, file=sys.stderr)
        sys.exit(1)


def main():
    catalog = load_catalog()
    _check(len(catalog.entries) == 89,
           "expected 89 merged entries, got %d" % len(catalog.entries))
    _check(catalog.by_id["unknown"].get("fallback") is True,
           "unknown entry must be the fallback")

    cases = [
        # 422 with a full rate-limit bucket and no Retry-After: CSRF mode.
        ("canvas-csrf-422-writes-only",
         {"provider": "canvas", "http_status": 422,
          "body_text": '{"errors":[{"message":"An error occurred.",'
                       '"error_code":"unprocessable_content"}]}',
          "reads_ok": True, "writes_fail": True,
          "rate_limit_remaining": 700.0, "retry_after_present": False,
          "session_logged_in": True}),
        # 429 with an exhausted bucket and Retry-After: 429 mode, never CSRF.
        ("canvas-rate-limit-429",
         {"provider": "canvas", "http_status": 429,
          "rate_limit_remaining": 0.0, "retry_after_present": True}),
        ("canvas-session-dead",
         {"error_class": "BrowserSessionDead",
          "error_text": "browser session died",
          "session_dead_signal": True}),
        ("canvas-session-dead",
         {"provider": "canvas", "http_status": 401, "reads_ok": False,
          "logged_in": False}),
        ("helper-down",
         {"error_class": "ExecutorError",
          "error_text": "chromium backend: browser unavailable (boom); "
                        "the login helper endpoint is down too -- start it "
                        "with helper/keepalive.sh, then retry"}),
        ("setup-tenant-not-configured",
         {"error_class": "SessionMissing", "provider": "canvas",
          "error_text": "chromium backend needs a Canvas base URL: pass "
                        "base_url, set CANVAS_BASE, or onboard the browser "
                        "lane state (~/.morrow/browser_lane.json)"}),
        ("ib-literal-item-401-scope-refusal",
         {"provider": "item-banks", "http_status": 401,
          "route_kind": "literal",
          "route_path": "/api/items/11269435"}),
        ("ib-canonical-item-get-404",
         {"provider": "item-banks", "http_status": 404,
          "route_kind": "canonical", "operation_kind": "read",
          "route_path": "/api/banks/9/items/11269435"}),
        ("ib-provider-unserved",
         {"provider": "item-banks", "provider_served": False,
          "capability": "ib.random_cap"}),
        ("write-halt-active", {"write_halt_active": True}),
        # Workstream C: mode-system admission refusals (exception class
        # route and dict route both reach the new modes).
        ("edit_self_grant_refused",
         {"error_class": "ModeSelfGrantRefused",
          "error_text": "agent attempted a self-grant"}),
        ("ambiguous_course_write_refused",
         {"error_class": "AmbiguousCourseWriteRefused",
          "query": "Bio 101",
          "candidates_public": "Biology 101 (Fall), Biology 101 (Spring)"}),
        ("settings_tamper_refused",
         {"error_class": "ModeSettingsTamper",
          "setting_name": "default_due_time"}),
        # LANE2-A: the two new query-chain modes (were "unknown" before).
        ("quiz-reference-unsupported",
         {"error_class": "UnsupportedQuizRef",
          "error_text": "quiz reference kind 'yesterday' is not "
                        "implemented"}),
        ("query-live-read-failed",
         {"error_class": "LiveReadError",
          "error_text": "helper Chromium is not alive"}),
    ]
    for want_id, evidence in cases:
        got = translate("smoke op", evidence, catalog=catalog)
        _check(got.mode_id == want_id,
               "evidence %r matched %r, expected %r"
               % (evidence, got.mode_id, want_id))
        lowered = got.agent_message.lower()
        for banned in BANNED:
            _check(banned not in lowered,
                   "mode %s message contains banned phrase %r" % (want_id, banned))
        _check(got.correlation_id and len(got.correlation_id) == 12,
               "mode %s missing correlation id" % want_id)
        _check(got.auto_action, "mode %s missing auto_action" % want_id)
        _check(got.next_step, "mode %s missing next_step" % want_id)

    # The tiebreaker must not cross-match: the 422 evidence must not be the
    # 429 mode and the 429 evidence must not be the CSRF mode.
    e422, e429 = cases[0][1], cases[1][1]
    _check(translate("op", e422, catalog=catalog).mode_id
           == "canvas-csrf-422-writes-only", "422 tiebreaker failed")
    _check(translate("op", e429, catalog=catalog).mode_id
           == "canvas-rate-limit-429", "429 tiebreaker failed")

    # Exception inputs also normalize (WriteHaltActive, session-dead names).
    class WriteHaltActive(Exception):
        pass

    got = translate("smoke op", WriteHaltActive("halt"), catalog=catalog)
    _check(got.mode_id == "write-halt-active",
           "WriteHaltActive matched %r" % got.mode_id)

    class BrowserStaleCommand(Exception):
        pass

    got = translate("smoke op", BrowserStaleCommand("stale"), catalog=catalog)
    _check(got.mode_id != "canvas-session-dead",
           "BrowserStaleCommand must not match session-dead")
    _check(got.mode_id == "unknown",
           "BrowserStaleCommand should fall to unknown, got %r" % got.mode_id)

    # Unknown fallback: structured, never a shrug.
    got = translate("mystery op", {"weird": "payload"}, catalog=catalog)
    _check(got.mode_id == "unknown", "expected unknown fallback")
    _check(got.escalate is True, "unknown must escalate")
    lowered = got.agent_message.lower()
    _check("what was attempted" in lowered, "fallback missing attempted part")
    # The final inventory catalog phrases the second anchor as "what the
    # evidence showed" (the contract's wording); the seeded catalog used
    # "what i checked". Accept either.
    _check("what the evidence showed" in lowered or "what i checked" in lowered,
           "fallback missing evidence part")
    _check(got.correlation_id in got.agent_message,
           "fallback must name the correlation id")
    for banned in BANNED:
        _check(banned not in lowered, "fallback contains banned phrase %r" % banned)

    # Deterministic: same input, same mode, twice.
    e = {"provider": "canvas", "http_status": 422,
         "body_text": "unprocessable_content", "rate_limit_remaining": 700.0,
         "retry_after_present": False, "reads_ok": True, "writes_fail": True,
         "session_logged_in": True}
    _check(translate("op", e, catalog=catalog).mode_id ==
           translate("op", e, catalog=catalog).mode_id,
           "translate() is not deterministic")

    # LANE2-3: secret scrubbing must redact bearer tokens even when the
    # key=value rule would otherwise eat the "Bearer" keyword first.
    from failures.funnel import scrub_secrets, agent_error_payload
    _check("eyJhbGciOiJIUzI1NiJ9" not in scrub_secrets(
        "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9"),
        "bearer token leaked through scrub_secrets")
    _check("sk_live_abc123" not in scrub_secrets("token=sk_live_abc123"),
           "key=value token leaked through scrub_secrets")
    payload = agent_error_payload(
        "smoke op",
        RuntimeError("boom token=supersecretvalue1234567890abcdef"))
    _check("supersecretvalue1234567890abcdef" not in
           payload["engineering_detail"],
           "secret leaked into engineering_detail")
    _check("[untrusted provider data]" in payload["engineering_detail"],
           "engineering_detail missing untrusted label")

    # LANE2-A: compound key names and bare token prefixes. \b never
    # fires inside underscore-joined names, so auth_token, _csrf_token,
    # canvas_session, sessionid, and PHPSESSID values must still be
    # caught; bare sk_live_/xoxb- style runs carry underscores the
    # long-run rule deliberately skips. Test strings are built by
    # concatenation so no literal key=value secret sits in this file.
    _tok = "tok" + "en"
    _sess = "sess" + "ion"
    _csrf = "cs" + "rf"
    _compound_cases = [
        ("auth_" + _tok + "=abc123", "abc123"),
        ("_" + _csrf + "_" + _tok + "=abc123", "abc123"),
        ("canvas_" + _sess + "=abc123def456", "abc123def456"),
        (_sess + "id=abc123", "abc123"),
        # LANE2-D3: the true PHP spelling is PHPSESSID ("sess"+"id", no
        # "session" substring); the compound rule missed it until the
        # sessid keyword landed. sid= is masked only as a standalone key
        # (residual_count must survive: forensics check below).
        ("PHP" + "SESSID=abc123", "abc123"),
        ("sid=abc123", "abc123"),
        ("?sid=abc123&x=1", "abc123"),
        ('{"sid": "abc123"}', "abc123"),
        ('{"_' + _csrf + '_' + _tok + '": "abc123"}', "abc123"),
        ("sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc", "sk_live_"),
        ("xoxb-123456789012-abcdefghij", "xoxb-"),
    ]
    for _raw, _needle in _compound_cases:
        _check(_needle not in scrub_secrets(_raw),
               "secret leaked through scrub_secrets: %r" % _raw)
    # LANE2-D3b forensics: sid inside ordinary words must NOT be masked.
    _check(scrub_secrets("residual_count=5") == "residual_count=5",
           "forensics lost: residual_count was masked")

    print("failures smoke selftest: PASS (%d merged modes + fallback)" % len(cases))


if __name__ == "__main__":
    main()
