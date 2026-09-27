#!/usr/bin/env python3
"""Moodle session bootstrap for Morrow Direct.

Establishes a Moodle session by logging in with the provider's own
published demo credentials (sandbox.moodledemo.net publishes teacher /
student / manager / admin accounts plus the password right on the login
page, for exactly this purpose). Never create accounts, never touch
Braden's identity, never touch any credential that is not published
for public demo use.

The intended production Lane 2 bootstrap needs a VM browser-session
handoff, but this module does not implement one. It proves the
downstream mechanics against the live public sandbox: the session
cookie plus the per-session sesskey is all the AJAX layer needs,
however the cookie was obtained.

Login is the standard Moodle form flow:
  1. GET {base}/login/index.php -> capture Set-Cookie jar + the
     logintoken anti-CSRF field from the form.
  2. POST the same URL with username / password / logintoken.
  3. Follow the redirect chain; a landing on /my/ (or any page whose
     title/body proves the principal) proves the session.

sesskey discovery:
  - GET {base}/my/ (authenticated) and extract M.cfg's sesskey
    (regex on "sesskey":"<10+ alphanumerics>"; Moodle 5.x uses exactly
    10, but the regex accepts 10 or more so a longer token on another
    version does not break discovery). If /my/ is disabled on the
    tenant, the site front page ({base}/) is tried as a fallback;
    both carry M.cfg on stock themes.
  - Cross-check the sesskey is stable across two page loads.

The cookie jar is returned in memory and NEVER written to disk. Callers
log names, lengths, and statuses only: no raw cookie or sesskey values
are ever printed or persisted (per the sandbox-proof constraint).

Contract:
  bootstrap(base, username, password) -> dict with:
    base, username, principal {id, name, sesskey_len, cookies_names},
    session: requests.Session (cookie jar held in memory only)

Usage:
  login.py --base https://sandbox.moodledemo.net --username teacher
"""

from __future__ import annotations

import argparse
import getpass
import os
import re
import sys
from typing import Dict, List, Optional

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None  # type: ignore

try:  # package import, e.g. "python3 -m moodle.login"
    from moodle.session import SafeRedirectSession, normalize_moodle_base
except ImportError:  # script usage: python3 moodle/login.py
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from session import SafeRedirectSession, normalize_moodle_base  # noqa: E402

USER_AGENT = "morrow-moodle-lane/0.1 (lane builder; public demo account only)"
DEFAULT_TIMEOUT = 25

# The sandbox publishes this password for the demo accounts right on the
# login page (public by design). It is the ONLY credential this module
# may ever default, and only when pointed at the sandbox host itself.
# Verified current 2026-09-22 (the provider rotates it; an older default
# silently fails login, so this value is re-verified on each live proof).
SANDBOX_BASE = "https://sandbox.moodledemo.net"
SANDBOX_DEMO_PASSWORD = "sandbox24"

LOGIN_URL_TMPL = "{base}/login/index.php"
LOGTOKEN_RE = re.compile(r'name="logintoken"\s+value="([^"]+)"')
# Moodle 5.x sesskeys are exactly 10 alphanumerics; accept 10 or more so
# a longer token on another version does not break discovery.
SESSKEY_RE = re.compile(r'"sesskey"\s*:\s*"([A-Za-z0-9]{10,})"')
# Principal fallback: the user menu embeds the full name and the userid.
USERID_RE = re.compile(r'"userid"\s*:\s*(\d+)')
# Authenticated pages that carry M.cfg (sesskey) and the user menu
# (principal). /my/ is first; some tenants disable it, so the site
# front page is the fallback. Both carry M.cfg on stock themes.
_AUTH_PAGES = ("/my/", "/")


def resolve_password(cli_password: Optional[str], base: str) -> str:
    """Resolve the login password without requiring it on argv.

    Precedence: --password > MOODLE_PASSWORD env > the published
    sandbox demo default (sandbox host only) > getpass stdin prompt.

    --password is kept for one-liner demo use but prints a loud
    warning: argv is visible in the process table and shell history,
    so a REAL credential must never travel on the command line.
    """
    if cli_password:
        print("WARNING: password supplied on the command line (argv). "
              "It is visible in the process table and shell history. "
              "Use the MOODLE_PASSWORD environment variable or the "
              "stdin prompt for any real credential; argv is for the "
              "published demo password only.", file=sys.stderr)
        return cli_password
    env_pw = os.environ.get("MOODLE_PASSWORD")
    if env_pw:
        return env_pw
    if base.strip().rstrip("/") == SANDBOX_BASE:
        return SANDBOX_DEMO_PASSWORD
    if sys.stdin.isatty():
        return getpass.getpass("Moodle password for %s: " % base)
    raise RuntimeError(
        "no password: set MOODLE_PASSWORD, pass --password (published "
        "demo password only), or run on a tty for the stdin prompt")


def _fetch_logintoken(session: "requests.Session", base: str,
                      timeout: int) -> str:
    resp = session.get(LOGIN_URL_TMPL.format(base=base), timeout=timeout)
    resp.raise_for_status()
    m = LOGTOKEN_RE.search(resp.text)
    if not m:
        raise RuntimeError("login page did not carry a logintoken field")
    return m.group(1)


def discover_sesskey(session: "requests.Session", base: str,
                     timeout: int) -> str:
    """Read the per-session sesskey from an authenticated page (M.cfg).

    Tries /my/ first, then the site front page: some tenants disable
    /my/, and both pages carry M.cfg on stock themes. A page that
    fails to load (404/403 on a disabled /my/) is skipped in favor of
    the next candidate. Raises RuntimeError naming both attempts when
    neither page carries a sesskey, instead of failing on the first
    page alone.
    """
    tried = []
    for path in _AUTH_PAGES:
        try:
            resp = session.get(base + path, timeout=timeout,
                               allow_redirects=True)
            resp.raise_for_status()
        except Exception as exc:
            if requests is not None and isinstance(
                    exc, requests.exceptions.HTTPError):
                tried.append("%s (HTTP error, skipped)" % path)
                continue
            raise
        m = SESSKEY_RE.search(resp.text)
        if m:
            return m.group(1)
        tried.append(path)
    raise RuntimeError(
        "authenticated page did not carry M.cfg.sesskey "
        "(tried %s; the regex accepts 10+ alphanumerics)"
        % ", ".join(tried))


def extract_principal(session: "requests.Session", base: str,
                      timeout: int) -> Dict[str, object]:
    """Best-effort principal extraction from an authenticated page.

    Theme-coupled: the regexes target one theme's user-menu markup
    (class="usertext..." / class="userbutton"). Returns {} when the
    markup misses. Callers MUST treat an empty principal as zero
    evidence: the re-auth pinning in reauth.py refuses vacuous
    matches, so an empty extraction can never approve resuming
    quarantined ops.
    """
    for path in _AUTH_PAGES:
        try:
            resp = session.get(base + path, timeout=timeout,
                               allow_redirects=True)
            resp.raise_for_status()
        except Exception as exc:
            if requests is not None and isinstance(
                    exc, requests.exceptions.HTTPError):
                continue  # disabled page: try the next candidate
            raise
        principal: Dict[str, object] = {}
        m = USERID_RE.search(resp.text)
        if m:
            principal["id"] = int(m.group(1))
        # The user menu carries the full name as data or visible text.
        m2 = re.search(r'class="usertext[^"]*"[^>]*>\s*<span[^>]*class="[^"]*meta[^"]*"[^>]*>([^<]+)',
                       resp.text)
        if m2:
            principal["name"] = m2.group(1).strip()
        else:
            m3 = re.search(r'<span class="userbutton"[^>]*>.*?<span[^>]*>([^<]+)</span>',
                           resp.text, re.S)
            if m3:
                principal["name"] = m3.group(1).strip()
        if principal:
            return principal
    return {}


def bootstrap(base: str, username: str, password: str,
              timeout: int = DEFAULT_TIMEOUT) -> Dict[str, object]:
    """Log in to the Moodle sandbox and return the live session bundle."""
    if requests is None:
        raise RuntimeError("the 'requests' package is required")
    # W4-P1-5: HTTPS-enforce the base BEFORE any session or credential
    # is created, so no secret ever touches plaintext.
    base = normalize_moodle_base(base)
    # W4-P2-7: the login POST carries the educator's credentials, so the
    # session refuses https->http redirect downgrades (fail closed) and
    # strips credential headers on host/scheme change.
    session = SafeRedirectSession()
    session.headers.update({"User-Agent": USER_AGENT})

    token = _fetch_logintoken(session, base, timeout)
    resp = session.post(
        LOGIN_URL_TMPL.format(base=base),
        data={"username": username, "password": password,
              "logintoken": token},
        timeout=timeout,
        allow_redirects=True,
    )
    resp.raise_for_status()
    # A failed login stays on /login/index.php with an error banner.
    if "/login" in resp.url and "index.php" in resp.url:
        raise RuntimeError(
            "login did not complete: still on the login page "
            "(username=%r, http=%d)" % (username, resp.status_code)
        )

    sesskey = discover_sesskey(session, base, timeout)
    principal = extract_principal(session, base, timeout)
    # Stability check: the sesskey must not rotate between two page loads.
    sesskey2 = discover_sesskey(session, base, timeout)

    return {
        "base": base,
        "username": username,
        "session": session,
        "sesskey": sesskey,
        "sesskey_stable": sesskey == sesskey2,
        "sesskey_len": len(sesskey),
        "principal": principal,
        "cookie_names": sorted(session.cookies.get_dict().keys()),
        "cookie_value_len": {
            n: len(v) for n, v in session.cookies.get_dict().items()
        },
        "landed_url": resp.url,
    }


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Bootstrap a Moodle sandbox session (public demo account only).")
    p.add_argument("--base", default="https://sandbox.moodledemo.net")
    p.add_argument("--username", default="teacher")
    p.add_argument("--password", default=None,
                   help="DISCOURAGED: visible in the process table and shell "
                        "history. Prefer the MOODLE_PASSWORD environment "
                        "variable or the stdin prompt. Never put a real "
                        "credential here; argv is for the published demo "
                        "password only.")
    p.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    return p.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    try:
        password = resolve_password(args.password, args.base)
        bundle = bootstrap(args.base, args.username, password, args.timeout)
    except Exception as exc:
        print("bootstrap failed: %s" % exc, file=sys.stderr)
        return 1
    # Names, lengths, statuses only: no raw cookie or sesskey values.
    print("login ok: landed on %s" % bundle["landed_url"])
    print("principal: %s" % bundle["principal"])
    print("sesskey: len=%d stable=%s" % (bundle["sesskey_len"],
                                         bundle["sesskey_stable"]))
    print("cookies: %s" % ", ".join(
        "%s(len=%d)" % (n, bundle["cookie_value_len"][n])
        for n in bundle["cookie_names"]))
    print("This demo check does not activate a scheduled keepalive or save "
          "a reusable session. The session ends when this command exits.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
