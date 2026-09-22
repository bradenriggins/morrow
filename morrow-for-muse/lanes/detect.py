#!/usr/bin/env python3
"""Lane detection prober for Morrow for Muse.

Given a Canvas base URL and an authenticated session, probe (read-only;
never creates a token) whether the educator can self-mint a personal
access token, and recommend a lane: "pat" or "session".

The rule from the setup evaluation: never ask the educator to choose.
The connector recommends a lane, and the other lane stays as fallback.

What the probe checks (all read-only):
  1. GET /api/v1/users/self
     Proves the session is alive and captures the principal (id, name).
  2. GET /profile/settings
     The same Approved Integrations page the educator would use. We look
     for the section ("Approved Integrations") and the minting affordance
     ("New Access Token"). When the institution flipped the
     limit_personal_access_tokens kill switch, the button is not rendered.
     Explicit disabled language is treated as a positive kill-switch
     signal, reported as a detected reason, never as a question to the
     educator.
  3. GET /api/v1/users/self/tokens (list, read-only)
     Supplementary reachability signal only: a 200 here means the token
     listing API answers; it does NOT prove creation ability. A denial is
     informative.

Nothing here writes anything: no token is created, no setting is changed,
nothing is logged out. The probe is read-only by construction (GET only).

Exit codes:
  0  the probe completed; the recommendation is in the output even when
     confidence is low or the session could not be verified
  1  usage error, missing dependency, or a network failure before any
     evidence could be gathered
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Dict, List, Optional
from urllib.parse import urlparse

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None  # type: ignore

try:  # package import, e.g. "python3 -m lanes.detect"
    from moodle.session import SafeRedirectSession, normalize_moodle_base
except ImportError:  # script usage: python3 lanes/detect.py
    sys.path.insert(0, os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    from moodle.session import SafeRedirectSession, normalize_moodle_base  # noqa: E402

USER_AGENT = "morrow-lane-prober/0.1 (read-only setup probe; creates nothing)"
DEFAULT_TIMEOUT = 20

# Markers searched (case-insensitively) in the visible text of
# /profile/settings, the Approved Integrations page.
SECTION_MARKERS = ["approved integrations"]
BUTTON_MARKERS = ["new access token"]
# Explicit disabled language. Treated as a kill-switch signal only when the
# mint button is absent; never trusted on its own.
DISABLED_HINTS = [
    "personal access tokens are disabled",
    "access tokens are disabled",
    "tokens are disabled",
    "token generation is disabled",
    "token creation is disabled",
]


class _TextExtractor(HTMLParser):
    """Collect visible text, skipping script, style, and noscript content."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._chunks: List[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag in ("script", "style", "noscript"):
            self._skip_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style", "noscript") and self._skip_depth:
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if not self._skip_depth:
            self._chunks.append(data)

    def text(self) -> str:
        return " ".join(self._chunks)


def _normalize(text: str) -> str:
    return " ".join(text.lower().split())


@dataclass
class Evidence:
    base_url: str
    session_ok: bool = False
    session_error: Optional[str] = None
    principal: Dict[str, object] = field(default_factory=dict)
    settings_status: Optional[int] = None
    settings_final_url: Optional[str] = None
    settings_error: Optional[str] = None
    section_found: bool = False
    button_found: bool = False
    disabled_hints: List[str] = field(default_factory=list)
    tokens_api_status: Optional[int] = None
    tokens_api_error: Optional[str] = None


def _load_cookies(args: argparse.Namespace) -> Dict[str, str]:
    # D10 note 2026-09-20: the --cookie-header option was removed. Cookie
    # values on the command line leak into shell history and the process
    # table. The one-shot diagnostic path is a 0600 JSON file only; the
    # installed product never handles raw cookie values (the browser lane
    # holds the session, and the executor refuses cookie-jar slots).
    path = args.cookies_file
    st = os.stat(path)
    if st.st_mode & 0o077:
        raise ValueError(
            "--cookies-file must be mode 0600 (it holds session cookies); "
            "refusing to read %s with mode %o" % (path, st.st_mode & 0o777))
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict) or not data:
        raise ValueError("--cookies-file must contain a JSON object of name: value")
    return {str(k): str(v) for k, v in data.items()}


def _normalize_base_url(raw: str) -> str:
    # W4-P1-5: the probe attaches the educator's session cookies, so the
    # base is HTTPS-enforced here (before any cookie is attached) via
    # the shared Moodle normalizer. MOODLE_BASE_ALLOW_HTTP=1 overrides.
    return normalize_moodle_base(raw)


def probe(base_url: str, cookies: Dict[str, str], timeout: int) -> Evidence:
    """Run the read-only probe sequence and return the gathered evidence."""
    ev = Evidence(base_url=base_url)
    if requests is None:
        raise RuntimeError("the 'requests' package is required to run the probe")
    # W4-P2-7: the probe attaches the educator's session cookies, so the
    # session refuses https->http redirect downgrades (fail closed) and
    # strips credential headers on host/scheme change.
    session = SafeRedirectSession()
    session.headers.update({"User-Agent": USER_AGENT})
    for name, value in cookies.items():
        session.cookies.set(name, value)

    # 1. Prove the session is alive; capture the principal.
    try:
        resp = session.get(
            base_url + "/api/v1/users/self", timeout=timeout, allow_redirects=False
        )
    except Exception as exc:  # network failure: nothing probed, report it
        ev.session_error = "network error on GET /api/v1/users/self: %s" % exc
        return ev
    if resp.status_code != 200:
        ev.session_error = "GET /api/v1/users/self returned HTTP %d" % resp.status_code
        return ev
    try:
        body = resp.json()
    except Exception:
        ev.session_error = "GET /api/v1/users/self did not return JSON"
        return ev
    if not isinstance(body, dict):
        # A tenant answering 200 with a JSON array/string (some tenants
        # serve an HTML error page as 200 with a JSON content type) is
        # not a usable principal: report it, never TypeError downstream.
        ev.session_error = ("GET /api/v1/users/self returned JSON of "
                            "unexpected shape (%s)" % type(body).__name__)
        return ev
    ev.session_ok = True
    ev.principal = {
        key: body[key] for key in ("id", "name", "login_id", "email") if key in body
    }

    # 2. Read the Approved Integrations page, the same surface the educator
    #    would use. Read-only: a plain GET, parsed locally.
    try:
        resp = session.get(base_url + "/profile/settings", timeout=timeout)
    except Exception as exc:
        ev.settings_error = "network error on GET /profile/settings: %s" % exc
    else:
        ev.settings_status = resp.status_code
        ev.settings_final_url = resp.url
        if resp.status_code == 200:
            if "login" in urlparse(resp.url).path:
                ev.settings_error = (
                    "redirected to the login page; the session is not valid "
                    "for browser flows"
                )
            else:
                extractor = _TextExtractor()
                try:
                    extractor.feed(resp.text)
                except Exception as exc:
                    ev.settings_error = "could not parse /profile/settings HTML: %s" % exc
                else:
                    text = _normalize(extractor.text())
                    ev.section_found = any(m in text for m in SECTION_MARKERS)
                    ev.button_found = any(m in text for m in BUTTON_MARKERS)
                    ev.disabled_hints = [h for h in DISABLED_HINTS if h in text]
        else:
            ev.settings_error = "GET /profile/settings returned HTTP %d" % resp.status_code

    # 3. Supplementary signal: can the token listing API be reached at all?
    #    Read-only list; a 200 here does NOT prove creation ability.
    try:
        resp = session.get(
            base_url + "/api/v1/users/self/tokens",
            timeout=timeout,
            allow_redirects=False,
        )
    except Exception as exc:
        ev.tokens_api_error = "network error: %s" % exc
    else:
        ev.tokens_api_status = resp.status_code

    return ev


def decide(ev: Evidence) -> Dict[str, object]:
    """Turn evidence into a lane recommendation with plain-language reasons."""
    reasons: List[str] = []

    if not ev.session_ok:
        reasons.append(
            "We could not verify your Canvas session (%s), so token support "
            "could not be checked. Re-run this probe with a live session."
            % (ev.session_error or "no further detail was captured")
        )
        return {
            "recommendation": "pat",
            "fallback": "session",
            "confidence": "none",
            "reasons": reasons,
            "educator_note": (
                "We could not check your account automatically, so we start "
                "with the 30-second token path. If you do not see the "
                "'New Access Token' button, use the one-time sign-in instead."
            ),
        }

    if ev.button_found:
        reasons.append(
            "Your Canvas settings page shows the 'New Access Token' button, "
            "so your account can create its own token."
        )
        reasons.append(
            "The token path is the simplest: about 30 seconds, and it does "
            "not depend on a browser session that needs daily upkeep."
        )
        return {
            "recommendation": "pat",
            "fallback": "session",
            "confidence": "high",
            "reasons": reasons,
            "educator_note": (
                "Your school allows personal tokens, so the 30-second token "
                "path is the simplest way to connect."
            ),
        }

    if ev.disabled_hints and not ev.button_found:
        reasons.append(
            "Your school has turned off personal access tokens for your "
            "account (Canvas calls this the limit_personal_access_tokens "
            "setting), so there is no 'New Access Token' button to click. "
            "This was detected from your account page, not asked of you."
        )
        reasons.append(
            "The one-time sign-in path gives you the same access through "
            "your normal Canvas login, with no token needed."
        )
        return {
            "recommendation": "session",
            "fallback": "pat",
            "confidence": "high",
            "reasons": reasons,
            "educator_note": (
                "Your school turned off personal tokens, so we are using the "
                "one-time sign-in path instead. Same access, no token needed."
            ),
        }

    if ev.section_found and not ev.button_found:
        reasons.append(
            "Your Canvas settings page shows the Approved Integrations "
            "section but no way to create a new token, which usually means "
            "your school disabled personal tokens."
        )
        reasons.append(
            "The one-time sign-in path gives you the same access through "
            "your normal Canvas login. If your school later enables tokens, "
            "the token path stays available as the fallback."
        )
        return {
            "recommendation": "session",
            "fallback": "pat",
            "confidence": "medium",
            "reasons": reasons,
            "educator_note": (
                "It looks like your school disabled personal tokens, so we "
                "are using the one-time sign-in path instead."
            ),
        }

    # Inconclusive: default to the self-correcting path. A wrong "pat"
    # recommendation costs the educator 30 seconds (the button is either
    # there or it is not, and the guide names the fallback); a wrong
    # "session" recommendation commits her to the higher-friction flow for
    # no reason.
    if ev.settings_error:
        reasons.append(
            "The settings page could not be read automatically (%s), so "
            "token support is unconfirmed."
            % ev.settings_error
        )
    else:
        reasons.append(
            "The settings page did not show the expected markers, so token "
            "support is unconfirmed."
        )
    reasons.append(
        "Starting with the 30-second token path: if you do not see the "
        "'New Access Token' button, use the one-time sign-in instead. "
        "Same access, no penalty."
    )
    return {
        "recommendation": "pat",
        "fallback": "session",
        "confidence": "low",
        "reasons": reasons,
        "educator_note": (
            "We could not confirm the token option automatically, so we "
            "start with the 30-second token path and the sign-in path stays "
            "ready as the fallback."
        ),
    }


def build_report(ev: Evidence, decision: Dict[str, object]) -> Dict[str, object]:
    return {
        "tool": "morrow-lane-prober",
        "version": "0.1",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "base_url": ev.base_url,
        "probe_ok": ev.session_ok,
        "principal": ev.principal,
        "recommendation": decision["recommendation"],
        "fallback": decision["fallback"],
        "confidence": decision["confidence"],
        "reasons": decision["reasons"],
        "educator_note": decision["educator_note"],
        "evidence": {
            "users_self": "ok" if ev.session_ok else ev.session_error,
            "settings_page_status": ev.settings_status,
            "settings_final_url": ev.settings_final_url,
            "settings_error": ev.settings_error,
            "approved_integrations_section_found": ev.section_found,
            "new_access_token_button_found": ev.button_found,
            "disabled_language_found": ev.disabled_hints,
            "tokens_list_api_status": ev.tokens_api_status,
            "tokens_list_api_error": ev.tokens_api_error,
            "tokens_list_api_note": (
                "Listing reachability only; a 200 here does not prove "
                "token creation ability."
            ),
        },
    }


def _print_human(report: Dict[str, object]) -> None:
    principal = report.get("principal") or {}
    who = ""
    if principal:
        who = " (%s)" % ", ".join(
            "%s=%s" % (k, v) for k, v in principal.items()
        )
    print("Morrow lane probe")
    print("  Canvas:         %s" % report["base_url"])
    print("  Session:        %s%s" % ("ok" if report["probe_ok"] else "NOT VERIFIED", who))
    print("  Recommendation: %s  (confidence: %s)" % (
        report["recommendation"], report["confidence"]))
    print("  Fallback:       %s" % report["fallback"])
    print("  Reasons:")
    for reason in report["reasons"]:
        print("    - %s" % reason)
    print("  Tell the educator:")
    print("    %s" % report["educator_note"])


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Probe (read-only; never creates a token) whether a Canvas user "
            "can self-mint a personal access token, and recommend the "
            "'pat' or 'session' lane."
        )
    )
    parser.add_argument(
        "--base-url",
        required=True,
        help="Canvas base URL, e.g. https://school.instructure.com",
    )
    parser.add_argument(
        "--cookies-file",
        required=True,
        help="Path to a 0600 JSON file mapping cookie names to values "
             "(one-shot diagnostic only; the installed product never "
             "handles raw cookie values)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT,
        help="HTTP timeout in seconds (default: %d)" % DEFAULT_TIMEOUT,
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print only the JSON report",
    )
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    try:
        base_url = _normalize_base_url(args.base_url)
        cookies = _load_cookies(args)
        evidence = probe(base_url, cookies, args.timeout)
    except Exception as exc:
        # Agent-facing error funnel: translate before the agent sees it.
        # Exit code 1 is preserved (usage / dependency / pre-evidence
        # network failure); only the stderr payload becomes structured.
        try:
            from failures.funnel import agent_error_payload
            print(json.dumps(agent_error_payload(
                "lane detection probe", exc)), file=sys.stderr)
        except Exception:
            print("probe failed before gathering evidence: %s" % exc,
                  file=sys.stderr)
        return 1
    decision = decide(evidence)
    report = build_report(evidence, decision)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        _print_human(report)
        print()
        print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
