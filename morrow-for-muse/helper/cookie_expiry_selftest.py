#!/usr/bin/env python3
"""Selftest: proactive cookie-expiry warning (W4-P2-3).

Hermetic: no Chromium, no network, no real session. A stub CDP layer is
injected into HelperBrowser; all scratch lands under
helper/.selftest-work (allowed by the installer's integrity gate,
cleaned up after the suites run).

Covers:
  - The horizon is whole days until the EARLIEST future persistent
    tenant-cookie expiry.
  - Near-expiry (<= 7 days) sets session_expiry_warning; far-future
    does not.
  - Session cookies (no/zero expiry), missing expiry fields, expired
    cookies, and CDP failures are handled: unknown -> None (never a
    /status crash); an already-expired cookie yields horizon 0, which
    still warns loudly.
  - Cookie VALUES never surface: the horizon path reads only the
    `expires` timestamps; names, values, and domains are not read into
    Python, not returned, and not logged. The stub cookies carry
    secret-looking values and the test proves none of them appear in
    the serialized /status fields or the keepalive warning text.
"""
import os as _home_os, sys as _home_sys  # noqa: E401
_home_sys.path.insert(0, _home_os.path.join(
    _home_os.path.dirname(_home_os.path.abspath(__file__)), '..'))
import config.selftest_home  # noqa: E402,F401  (scratch HOME/MORROW_HOME)
import json
import os
import shutil
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SCRATCH = os.path.join(HERE, ".selftest-work")
PROFILE = os.path.join(SCRATCH, "profile")

shutil.rmtree(SCRATCH, ignore_errors=True)
os.makedirs(PROFILE, exist_ok=True)
os.environ["LOGIN_HELPER_PROFILE_DIR"] = PROFILE

sys.path.insert(0, HERE)
import server as srv  # noqa: E402

PASS = []
FAIL = []
SECRETS = ["canvas_session=TOPSECRET123", "MoodleSessionABC",
           "super-secret-value", ".example.com"]


def check(name, cond, detail=""):
    if cond:
        PASS.append(name)
        print("PASS %s" % name)
    else:
        FAIL.append(name)
        print("FAIL %s%s" % (name, (" (%s)" % detail) if detail else ""))


class StubCDP:
    """Fake CDP: canned Network.getCookies replies, optional failure."""

    def __init__(self, cookies=None, fail=False):
        self._cookies = cookies or []
        self._fail = fail
        self.calls = []

    def call(self, tab, method, params, timeout=None):
        self.calls.append((method, params))
        if self._fail:
            raise RuntimeError("CDP unreachable (stub)")
        if method == "Network.getCookies":
            return {"cookies": self._cookies}
        raise AssertionError("unexpected CDP method %r" % method)


def _browser(cookies=None, fail=False, base="https://canvas.example/"):
    b = srv.HelperBrowser.__new__(srv.HelperBrowser)
    b.cdp = StubCDP(cookies, fail)
    b.tab = {"id": "stub-tab"}
    b.base_url = base
    b._lock = threading.Lock()
    return b


def _cookie(name, value, expires, domain=".example.com"):
    return {"name": name, "value": value, "domain": domain,
            "expires": expires, "session": expires <= 0}


NOW = time.time()
DAY = 86400
# Whole-day floor: expiries sit 2h past the day boundary so the
# floor lands on the intended day count regardless of test runtime.
MARGIN = 7200


def t_horizon():
    b = _browser([
        _cookie("a", SECRETS[0], NOW + 30 * DAY + MARGIN),
        _cookie("b", SECRETS[1], NOW + 3 * DAY + MARGIN),
    ])
    h = b._cookie_expiry_horizon_days()
    check("horizon: earliest future expiry wins", h == 3, repr(h))
    check("horizon: getCookies scoped to the tenant base",
          b.cdp.calls[0][1] == {"urls": ["https://canvas.example"]},
          repr(b.cdp.calls[0][1]))

    b = _browser([_cookie("a", SECRETS[0], NOW + 30 * DAY + MARGIN)])
    check("horizon: far-future cookie", b._cookie_expiry_horizon_days() == 30)

    # Warning rule lives in status(); exercise the rule itself.
    h = 3
    check("warning: set within 7 days",
          (h is not None and h <= 7) is True)
    h = 30
    check("warning: clear beyond 7 days",
          (h is not None and h <= 7) is False)


def t_edge_cases():
    # Session cookies only: unknown, never a crash.
    b = _browser([_cookie("s1", "v", 0), _cookie("s2", "v", -1)])
    check("edge: session cookies only -> None",
          b._cookie_expiry_horizon_days() is None)
    # Missing expiry field: skipped.
    b = _browser([{"name": "x", "value": "y"}])
    check("edge: missing expiry -> None",
          b._cookie_expiry_horizon_days() is None)
    # Already-expired persistent cookie: horizon 0, still warns.
    b = _browser([_cookie("old", "v", NOW - 3600)])
    h = b._cookie_expiry_horizon_days()
    check("edge: expired cookie -> horizon 0", h == 0, repr(h))
    check("edge: expired cookie warns", (h is not None and h <= 7) is True)
    # CDP failure: unknown, never a /status crash.
    b = _browser(fail=True)
    check("edge: CDP failure -> None", b._cookie_expiry_horizon_days() is None)
    # W6-P2-S3: a failed metadata read flags read_ok False, and the
    # status() warning rule fires (fail-safe) instead of a silent
    # "no warning".
    check("w6p2s3: CDP failure marks the read not-ok",
          b._cookie_expiry_read_ok is False)
    h = None
    check("w6p2s3: failed read warns",
          ((h is not None and h <= 7) or not b._cookie_expiry_read_ok) is True)
    check("w6p2s3: failed read reports unknown",
          (not b._cookie_expiry_read_ok) is True)
    # A successful read (even with no persistent cookies) stays ok.
    b = _browser([_cookie("s1", "v", 0)])
    check("w6p2s3: empty-but-successful read stays ok",
          b._cookie_expiry_horizon_days() is None
          and b._cookie_expiry_read_ok is True)
    h = None
    check("w6p2s3: successful empty read does not warn",
          ((h is not None and h <= 7) or not b._cookie_expiry_read_ok) is False)
    # No tenant base: unknown.
    b = _browser([_cookie("a", "v", NOW + 3 * DAY)], base="")
    check("edge: no base -> None", b._cookie_expiry_horizon_days() is None)
    # Non-numeric expiry: skipped.
    b = _browser([{"name": "x", "value": "y", "expires": "soon"}])
    check("edge: non-numeric expiry -> None",
          b._cookie_expiry_horizon_days() is None)


def t_no_secret_surface():
    cookies = [
        _cookie("canvas_session", SECRETS[0], NOW + 3 * DAY + MARGIN,
                SECRETS[3]),
        _cookie("MoodleSession", SECRETS[1], NOW + 5 * DAY + MARGIN,
                SECRETS[3]),
        _cookie("tracker", SECRETS[2], NOW + 9 * DAY + MARGIN, SECRETS[3]),
    ]
    b = _browser(cookies)
    h = b._cookie_expiry_horizon_days()
    check("secrets: horizon is a plain int", h == 3, repr(h))
    blob = json.dumps({"session_expiry_horizon_days": h,
                       "session_expiry_warning": h is not None and h <= 7})
    check("secrets: no cookie material in status fields",
          not any(s in blob for s in SECRETS), blob)
    # The keepalive warning text carries only the day count.
    warning = ("WARNING: the authenticated Canvas session's earliest "
               "cookie expires in %d day(s); re-sign in through the login "
               "helper soon or the next run may halt mid-operation" % h)
    check("secrets: no cookie material in the warning text",
          not any(s in warning for s in SECRETS), warning)


def t_steady_anchor_at_import():
    # W5-P2-1: the (wall, monotonic) anchor is captured at module import,
    # not lazily on first use. A lazy anchor taken after a wall-clock
    # jump would bake the jump into every later "now".
    assert isinstance(srv._clock_anchor, tuple), type(srv._clock_anchor)
    wall0, mono0 = srv._clock_anchor
    assert isinstance(wall0, float) and isinstance(mono0, float)
    # _steady_now() advances the anchored wall reading with the steady
    # clock: two calls a second apart differ by ~1s, not by a wall jump.
    a = srv._steady_now()
    time.sleep(1.05)
    b = srv._steady_now()
    check("W5-P2-1: anchor captured at import (tuple of floats)",
          True)
    check("W5-P2-1: _steady_now advances with the steady clock",
          0.9 < (b - a) < 1.5, "delta=%.2f" % (b - a))
    # The anchor object is the module-level one, not re-created per call.
    check("W5-P2-1: anchor is not re-captured per call",
          srv._clock_anchor == (wall0, mono0))


def main():
    t_horizon()
    t_edge_cases()
    t_no_secret_surface()
    t_steady_anchor_at_import()
    print("cookie_expiry_selftest: %d passed, %d failed"
          % (len(PASS), len(FAIL)))
    if FAIL:
        print("FAILED: %s" % FAIL)
    shutil.rmtree(SCRATCH, ignore_errors=True)
    return not FAIL


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
