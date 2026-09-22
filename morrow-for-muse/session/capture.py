#!/usr/bin/env python3
"""RIG/PROOF INFRASTRUCTURE ONLY. NOT PART OF THE INSTALLED PRODUCT.

Capture the Canvas session from the rig Chrome browser context into the session store.

The installed Muse product NEVER runs this script and NEVER holds cookie
values: its browser lane (transport/browser_backend.py) keeps lane metadata
only (transport/state.py) and performs every call inside the managed
browser's authenticated profile. This script exists so the proof battery
can capture a session for direct API-contract verification. Keeping it is
deliberate; using it in the product is forbidden by the no-exposure
principle (transport/README.md).

Source of truth for the Lane 2 (session, no-PAT) capture contract.

How it works:
  - Attaches through the login helper's token-authenticated /cdp/*
    proxy (W4-P0-3: no TCP CDP listener exists; Chromium runs with
    --remote-debugging-pipe). The educator signs in through the helper
    page; the agent never sees a password.
  - Finds a page target on the configured Canvas tenant origin (never hardcodes a tab id).
  - Discovers the session cookie name from the tenant's actual cookie jar
    (heuristic, not a hardcoded name: httpOnly + Secure + session-scoped +
    name contains "session", largest value wins). Live tenant uses
    `canvas_session`; `_normandy_session` (canvas-lms source name) is NOT assumed.
  - Reads the CSRF token from the LIVE page context (document.cookie), because
    the stale CDP cookie-store copy of _csrf_token caused 422 on writes in the
    live proof of 2026-09-20.
  - Verifies capture by calling GET /api/v1/users/self inside the authenticated
    tab and records the principal (id, name).

It never exits, restarts, replaces, or relaunches the browser, and never
navigates away from the educator's tabs. It opens no CDP socket of its
own. Values are written only to
~/.morrow/session.json (0600). stdout carries names, lengths, IDs, and
statuses only: no raw cookie or token values are ever printed.

Contract (sibling workers implement against this shape; do not change it
without updating them):

  {"canvas": {"base": "https://chcp.instructure.com",
              "cookies": {"<discovered_name>": "...", "_csrf_token": "..."},
              "csrf_token": "...",
              "principal": {"id": N, "name": "..."},
              "captured_at": <epoch>,
              "lane": "session"}}

Usage:
  capture.py [--base https://chcp.instructure.com] [--verify-direct]
  --verify-direct also attempts one direct HTTPS GET /api/v1/users/self from
  this host with the captured cookies and reports the status. On tenants with
  OTP device-binding this returns 302 to /login/otp and does NOT indicate a
  bad capture (live-observed on chcp.instructure.com 2026-09-20).
"""
import json
import os
import sys
import time
import urllib.request

# W4-P1-17: single source of truth for the morrow state root (rig script
# honors the same MORROW_HOME override as the product).
_TREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE_ROOT not in sys.path:
    sys.path.insert(0, _TREE_ROOT)
from config.paths import morrow_home  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# W4-P0-3: no TCP CDP anymore. cdp.py drives the login helper's
# token-authenticated /cdp/* proxy; the educator signs in through the
# helper page instead of a manually launched --remote-debugging-port
# rig browser.
from cdp import (cdp_call, find_tab, read_document_cookie, tab_fetch)

# P2-9: the default base is a neutral placeholder, never an operator
# tenant. The real tenant comes from CANVAS_BASE (read here, never logged)
# or the explicit --base flag.
BASE = os.environ.get("CANVAS_BASE", "https://example.instructure.com")
STORE_DIR = morrow_home()
STORE_PATH = os.path.join(STORE_DIR, "session.json")


def discover_session_cookie(cookies, base):
    """Pick the tenant's session cookie from jar metadata (no hardcoded name).

    Candidate: name contains 'session' (case-insensitive), httpOnly, Secure,
    session-scoped (no expiry), scoped to the base host or its parent domains.
    Largest value wins; ties are broken toward the exact base host.
    """
    host = base.split("://", 1)[1].split("/", 1)[0].lower()
    cands = []
    for c in cookies:
        name = c.get("name", "")
        domain = (c.get("domain") or "").lstrip(".").lower()
        if "session" not in name.lower():
            continue
        if not c.get("httpOnly"):
            continue
        if c.get("secure") is not True:
            continue
        if c.get("expires", -1) not in (-1, 0):
            continue  # persistent: helper, not the session
        if host != domain and not host.endswith("." + domain):
            continue  # wrong domain scope (e.g. per-file-host copies)
        exact = 1 if domain == host else 0
        cands.append((len(c.get("value", "")), exact, c))
    if not cands:
        names = sorted({c.get("name") for c in cookies})
        raise RuntimeError(f"no session cookie discovered; jar holds: {names}")
    cands.sort(key=lambda t: (t[0], t[1]), reverse=True)
    return cands[0][2]


def main():
    base = BASE
    verify_direct = False
    args = sys.argv[1:]
    for i, a in enumerate(args):
        if a == "--base" and i + 1 < len(args):
            base = args[i + 1].rstrip("/")
        if a == "--verify-direct":
            verify_direct = True

    print("cdp: attaching via the login helper's authenticated CDP proxy")
    target_id = find_tab(base)
    print("cdp: authenticated tab located (id redacted from log)")

    # 1. Cookie jar, scoped to the tenant origin (values stay off stdout).
    res = cdp_call(target_id, "Network.getCookies", {"urls": [base + "/"]})
    jar = res.get("cookies", [])
    session_cookie = discover_session_cookie(jar, base)
    sess_name = session_cookie["name"]
    sess_len = len(session_cookie.get("value", ""))
    csrf_cookie = next((c for c in jar if c.get("name") == "_csrf_token"), None)
    print(f"discovered session cookie: {sess_name} (httpOnly, Secure, "
          f"session-scoped, value_len={sess_len})")
    print(f"_csrf_token in jar: {'present' if csrf_cookie else 'absent'}")

    # 2. CSRF from the LIVE page context (document.cookie), per live-proof
    #    finding 4: the stale CDP cookie-store copy 422s on writes.
    # Live CSRF from the isolated world (W4-P1-12): page-realm JS
    # cannot forge or hide what this read sees.
    doc_cookie = read_document_cookie(target_id)
    live_csrf = None
    for part in doc_cookie.split(";"):
        k, _, v = part.strip().partition("=")
        if k == "_csrf_token":
            live_csrf = v
    if not live_csrf:
        raise RuntimeError("_csrf_token not present in live document.cookie; "
                           "tab may not be fully authenticated")
    print(f"live _csrf_token sourced from document.cookie "
          f"(value_len={len(live_csrf)})")

    # 3. Verify capture: principal readback via in-tab fetch (works even where
    #    server-side cookie replay is OTP-blocked on this tenant).
    status, body = tab_fetch(base, "/api/v1/users/self")
    if status != 200:
        raise RuntimeError(f"principal probe failed: http={status} "
                           f"body_head={body[:80]}")
    principal = json.loads(body)
    pid, pname = principal.get("id"), principal.get("name")
    if not pid:
        raise RuntimeError("principal probe returned no id")
    print(f"principal verified: id={pid} name={pname}")

    # 4. Optional direct-HTTPS probe from this host (informational only).
    if verify_direct:
        cj = f"{sess_name}={session_cookie['value']}; _csrf_token={live_csrf}"
        rq = urllib.request.Request(base + "/api/v1/users/self",
                                    headers={"Cookie": cj,
                                             "Accept": "application/json",
                                             "User-Agent": "morrow-capture/1.0"})
        try:
            with urllib.request.urlopen(rq, timeout=20) as r:
                direct_status = r.status
        except urllib.error.HTTPError as e:
            direct_status = e.code
        except Exception as e:
            direct_status = f"error:{type(e).__name__}"
        print(f"direct-https probe status: {direct_status} "
              "(302 here = tenant OTP device-binding, not a bad capture)")

    record = {
        "canvas": {
            "base": base,
            "cookies": {
                sess_name: session_cookie["value"],
                "_csrf_token": live_csrf,
            },
            "csrf_token": live_csrf,
            "principal": {"id": pid, "name": pname},
            "captured_at": int(time.time()),
            "lane": "session",
        }
    }
    os.makedirs(STORE_DIR, mode=0o700, exist_ok=True)
    # W5-P2-2: pid-unique tmp name; two concurrent writers of the
    # same store file must not share one staging path.
    tmp = "%s.new.%d" % (STORE_PATH, os.getpid())
    # P2-10: create the temp file with 0600 atomically (os.open mode bits
    # apply at creation), never open()-then-chmod: no window exists where
    # the secret record is group/other-readable.
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(record, f)
    os.replace(tmp, STORE_PATH)
    os.chmod(STORE_DIR, 0o700)
    print(f"wrote {STORE_PATH} (0600): principal_id={pid} "
          f"captured_at={record['canvas']['captured_at']} lane=session")


if __name__ == "__main__":
    main()
