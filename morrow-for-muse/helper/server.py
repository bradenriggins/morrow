#!/usr/bin/env python3
"""Morrow Canvas Login Helper.

Problem this solves: an educator must sign into Canvas in the VM-local
headless Chromium (the local-Chromium lane that can run page JS), but they
cannot type into that browser directly, and they must never hand the agent
their password.

What this does:
  * Launches headless Chromium with a PERSISTENT profile under
    helper/profile/ (created on first run, never wiped, never shipped).
    The authenticated session (including the "stay signed in" cookie)
    survives helper and VM restarts, so the educator signs in once.
  * Lands on the tenant homepage, not the login form: with a live session
    this renders the dashboard; when the session is dead Canvas itself
    redirects to /login/canvas. (Parking on the login form directly is
    what used to make live sessions LOOK logged out.)
  * Serves the helper UI (index.html): a live screenshot stream of the
    page that forwards the user's clicks and keystrokes into the page via
    CDP Input.dispatchMouseEvent / Input.dispatchKeyEvent.

The educator types into the rendered Canvas page itself. No password, key
value, or token is ever logged to server.log, persisted, or returned by
this server. The one exception is a bare dev launch with no
HELPER_AUTH_TOKEN set: the server mints an ephemeral token and prints it
to the live console only (never to server.log), so the developer can
call the protected endpoints. Logs carry only event counts and types.

Auth: keepalive.sh mints a 64-hex token at launch, writes it to
${TREE_STATE_DIR}/helper_token (0600), and exports HELPER_AUTH_TOKEN
into this process. Every POST/PUT/DELETE/PATCH endpoint and
GET /screenshot require the X-Helper-Token header (else 403
{"error":"forbidden"}). Open without a token: GET /status, GET / (the
sign-in UI, which gets the token injected server-side), GET /logo.png.
The token stops blind/off-origin API use and port-forward exposure; it
does not stop a party that can already read the locally served page.

Usage:
  CANVAS_BASE=https://myschool.instructure.com python3 helper/server.py
  or: python3 helper/server.py https://myschool.instructure.com
  (<tree>/helper/env may also export CANVAS_BASE; keepalive.sh sources it.
  The legacy global ~/.morrow/env is honored for CANVAS_BASE only.)

There is no default tenant: the helper refuses to start without one.

Endpoints (all on 127.0.0.1):
  GET  /                 -> the helper UI (index.html); the server injects
                           the auth token into a __HELPER_TOKEN__ placeholder
  GET  /logo.png         -> the Morrow logo for the UI
  GET  /status           -> open: {"url", "logged_in", "chromium_alive",
                               "starting", "profile_dir",
                               "profile_has_cookies", "helper_version",
                               "session_expiry_horizon_days",
                               "session_expiry_warning"}
    url is scheme://host/path only (query and fragment stripped; the
    logged_in check keeps using the full href internally). profile_dir
    abbreviates $HOME as ~ so the account name never leaves the box.
    session_expiry_horizon_days is cookie METADATA only (whole days
    until the earliest persistent tenant cookie expires; null when
    unknown); session_expiry_warning is true when the horizon is
    within 7 days so the educator can re-sign in before the session
    dies. Cookie values and names never leave this endpoint.
  GET  /screenshot       -> PROTECTED: PNG bytes of the current page
                           (can capture password entry; requires the token)
  POST /input/key        -> PROTECTED: {"kind":"down"|"up","key","code","keyCode"}
  POST /input/mouse      -> PROTECTED: {"kind":"pressed"|"released"|"moved",
                             "x","y","button"}
  POST /navigate         -> PROTECTED: {"url"}  switch tenant / re-navigate
                           (HTTPS targets only, W4-P2-8)
  POST /cdp/tabs         -> PROTECTED: {}  list live targets
  POST /cdp/new-tab      -> PROTECTED: {"url"}  open a tab (about:blank or
                           https only); returns the tab
  POST /cdp/call         -> PROTECTED: {"target_id", "method", "params"}
                           one allowlisted CDP method on a live target
                           (no target_id = browser-level); returns
                           {"result"} or {"error"}
  POST /cdp/evaluate     -> PROTECTED: {"target_id", "expression",
                           "await_promise", "context_id"}  Runtime.evaluate
                           on a live target; returns {"ok", "value"} or
                           {"ok": false, "error"}
  POST /cdp/navigate     -> PROTECTED: {"target_id", "url"}  Page.navigate
                           on a live target (https only); {"ok": true}
  POST /cdp/close-tab    -> PROTECTED: {"target_id"}  close the tab;
                           {"ok": true}
  GET  /cdp/events       -> PROTECTED: ?target_id=&timeout_s=  drain
                           buffered CDP events for one target; {"events"}
  The /cdp/* proxy exists because a second local Morrow process (the
  executor) must reach CDP while this server owns the browser, and the
  browser's --remote-debugging-pipe is private to this process
  (W4-P0-3: no TCP CDP listener exists anywhere). Every /cdp/*
  request requires the launch token; the proxied method must be on a
  strict allowlist; the target must be a live tab id; payloads and
  timeouts are bounded. This is the only cross-process CDP path.
  Every POST/PUT/DELETE/PATCH on any path is protected. A wrong method
  on a known path returns 405 JSON (not 404); an unknown path is 404.
    logged_in requires the tab to be on the tenant base (error pages
    and chrome-error:// tabs never count).
    starting=true means Chromium is alive but the tab has not landed yet
    (boot in progress), not signed-out. chromium_alive=false with
    logged_in=false means the browser died: recoverable by restart.
    helper_version is this tree's VERSION marker; keepalive.sh uses it to
    detect a stale server from a pre-upgrade install and recycles it
    instead of adopting it.
    W4-P2-18: document.title is never read at all. It is
    page-controlled text that used to feed /status.logged_in; a hostile
    page could set a Canvas error title ("Page not found") and flip
    logged_in. logged_in rests on the tab's actual document URL
    (location.href), which page JS cannot forge.
  GET  /screenshot       -> PNG bytes of the current page
  POST /input/key        -> {"kind":"down"|"up","key","code","keyCode"}
  POST /input/mouse      -> {"kind":"pressed"|"released"|"moved",
                             "x","y","button"}
  POST /navigate         -> {"url"}  switch tenant / re-navigate

Hardening (W3-P2-7): per-IP token-bucket rate limiting (429 JSON past
the limit), a 60s total request timeout plus a 30s per-I/O socket
timeout (a hung handler's connection is closed and its worker slot
reclaimed), at most 16 concurrent handler threads (503 JSON past the
cap), and size-based rotation of server.log (1 MiB, 4 archives, log
format unchanged). See helper/README.md for the exact limits and the
env tuning knobs.
"""

import base64
import fcntl
import hashlib
import hmac
import ipaddress
import json
import os
import signal
import socket
import ssl
import stat
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_HERE = os.path.dirname(os.path.realpath(__file__))

# Reuse the connector's local-Chromium transport (launcher + CDP client).
# Packaged layout: helper/../transport. No silent fallback to another
# checkout: if the sibling transport dir is missing, the operator must
# point MORROW_TRANSPORT_DIR at the right one (W2-P2-21).
_TDIR = os.path.normpath(os.path.join(_HERE, "..", "transport"))
if not os.path.isdir(_TDIR):
    _TDIR = os.environ.get("MORROW_TRANSPORT_DIR", "")
if not _TDIR or not os.path.isdir(_TDIR):
    print("FATAL: cannot locate this tree's transport directory "
          "(expected %s); set MORROW_TRANSPORT_DIR explicitly"
          % os.path.normpath(os.path.join(_HERE, "..", "transport")),
          file=sys.stderr)
    sys.exit(1)
if _TDIR not in sys.path:
    sys.path.insert(0, _TDIR)
import local_chromium as lc  # noqa: E402

# W2-P1-27: tree-scoped env. server.py sources <tree>/helper/env (this
# file's own tree) at startup, before the CANVAS_BASE check. Parsed as
# KEY=VALUE lines; blanks and # comments skipped; an optional leading
# "export " is tolerated. setdefault: the real environment always wins
# over the file. Values are never logged.
#
# The legacy global ~/.morrow/env is honored ONLY for CANVAS_BASE.
# Profile/port/production vars found there are IGNORED with a loud
# warning: one global file must never be able to cross-configure every
# tree's profile or satisfy every tree's production guard.
_TREE_ENV_VARS_IGNORED_FROM_GLOBAL = (
    "LOGIN_HELPER_PROFILE_DIR", "LOGIN_HELPER_PORT",
    "LOGIN_HELPER_CDP_PORT", "LOGIN_HELPER_BIND",
    "LOGIN_HELPER_PRODUCTION",
)


def _tighten_env_perms(path):
    """W4-P1-2: helper env files may hold deployment config and, in the
    legacy global file, CANVAS_BASE. They must not be readable by other
    users. Tighten to 0600 when readable by group/other, with a loud
    note (startup is tightening something it did not necessarily
    create; the installer does the same on fresh installs)."""
    try:
        st = os.stat(path)
    except OSError:
        return
    # W4-P1-18: only tighten regular files. An override like /dev/null
    # (or any device/fifo) must never be chmodded.
    if not stat.S_ISREG(st.st_mode):
        return
    if st.st_mode & 0o077:
        try:
            os.chmod(path, 0o600)
        except OSError as e:
            print("WARNING: cannot tighten permissions on %s (%s); "
                  "refusing to source a world-readable env file" % (path, e),
                  file=sys.stderr)
            raise SystemExit(1)
        print("NOTE: tightened permissions on %s to 0600 (was %o); "
              "helper env files must not be readable by other users"
              % (path, st.st_mode & 0o777), file=sys.stderr)


def _source_morrow_env():
    # W4-P1-17: legacy env resolves under the unified state root. This
    # module puts the transport dir (not the tree root) on sys.path, so
    # insert the tree root for the config.paths import.
    _root = os.path.normpath(os.path.join(_HERE, ".."))
    if _root not in sys.path:
        sys.path.insert(0, _root)
    from config.paths import morrow_home  # noqa: E402
    # The same parser every agent-side reader uses (config/tree_config).
    from config.tree_config import parse_env_file as _parse_env_file  # noqa: E402
    # W4-P1-18: test seam. MORROW_HELPER_ENV_FILE overrides the tree env
    # file location (default <tree>/helper/env). The selftests point it
    # at an empty scratch file so they never mutate, move, or depend on
    # the educator's real helper/env.
    tree_env = os.environ.get("MORROW_HELPER_ENV_FILE") \
        or os.path.join(_HERE, "env")
    _tighten_env_perms(tree_env)
    for key, value in _parse_env_file(tree_env).items():
        os.environ.setdefault(key, value)
    legacy = os.path.join(morrow_home(), "env")
    _tighten_env_perms(legacy)
    legacy_data = _parse_env_file(legacy)
    for key in _TREE_ENV_VARS_IGNORED_FROM_GLOBAL:
        if key in legacy_data:
            print("WARNING: ignoring %s from the global ~/.morrow/env "
                  "(profile/port settings are tree-scoped now); move it "
                  "to %s" % (key, tree_env), file=sys.stderr)
    if "CANVAS_BASE" in legacy_data:
        if "CANVAS_BASE" not in os.environ:
            print("WARNING: CANVAS_BASE is read from the legacy global "
                  "~/.morrow/env; move it to %s" % tree_env,
                  file=sys.stderr)
        os.environ.setdefault("CANVAS_BASE", legacy_data["CANVAS_BASE"])


def _educator_notice_paths():
    # W6-P1-S2: the re-auth machine's store lives under morrow_home()
    # (MORROW_HOME-aware, like the state machine itself). This module
    # puts the transport dir on sys.path, so insert the tree root for
    # the config.paths import, mirroring _source_morrow_env.
    _root = os.path.normpath(os.path.join(_HERE, ".."))
    if _root not in sys.path:
        sys.path.insert(0, _root)
    from config.paths import morrow_home  # noqa: E402
    store = morrow_home()
    return (os.path.join(store, "notify.txt"),
            os.path.join(store, "write_halt"))


def _educator_session_notice():
    # W6-P1-S2: read-only surface for the pending educator
    # notification (session death paused ops). Never clears it: only
    # `reauth/state_machine.py notify` clears after the educator (via
    # the agent) has seen it. Failures yield None, never a /status
    # crash.
    try:
        notify_path, _ = _educator_notice_paths()
        with open(notify_path, encoding="utf-8") as fh:
            text = fh.read().strip()
        return text or None
    except (OSError, ValueError):
        return None


def _educator_write_halt_active():
    try:
        _, halt_path = _educator_notice_paths()
        return os.path.exists(halt_path)
    except (OSError, ValueError):
        return False


def _educator_principal_name():
    # W6-P2-A4: who the pinned account is, so the helper UI can show
    # WHO is signed in (not just that someone is). Reads the principal
    # pinned at first sign-in (browser_lane.json), with the rig
    # session.json as fallback; name only, never secrets. None when no
    # account is pinned yet.
    try:
        _root = os.path.normpath(os.path.join(_HERE, ".."))
        if _root not in sys.path:
            sys.path.insert(0, _root)
        from config.paths import morrow_home  # noqa: E402
        home = morrow_home()
    except (ImportError, OSError):
        return None
    for fname in ("browser_lane.json", "session.json"):
        try:
            with open(os.path.join(home, fname), encoding="utf-8") as fh:
                principal = (json.load(fh) or {}).get("canvas", {}) \
                    .get("principal", {})
        except FileNotFoundError:
            continue
        except (OSError, ValueError, AttributeError):
            return None
        name = principal.get("name") if isinstance(principal, dict) else None
        if isinstance(name, str) and name.strip():
            return name
    return None


_source_morrow_env()

# W3-P0-7/W3-P0-8, W6-P1-1: helper API token lifecycle. keepalive.sh
# mints a 64-hex token per tree at ${TREE_STATE_DIR}/helper_token (0600)
# and passes its PATH (never the value) as HELPER_AUTH_TOKEN_FILE, so
# the secret never appears in /proc/<pid>/environ (W6-P2-7).
# HELPER_AUTH_TOKEN (the raw value) is still honored for manual/dev
# launches, but it must be exactly 64 hex chars (W6-P2-3): a truncated
# token used to be silently enforced, which would make brute force
# feasible inside the rate limit. ROTATION: keepalive mints a FRESH
# token on every (re)launch and proactively past
# HELPER_TOKEN_MAX_AGE_SECONDS; the replaced token is staged at
# helper_token.prev ("<hex>:<epoch>", path via
# HELPER_AUTH_TOKEN_PREV_FILE) and stays valid for
# HELPER_TOKEN_PREV_GRACE_SECONDS (default 300s) so in-flight clients
# are not cut off. A captured token is therefore valid at most until
# the next rotation, never forever.
# Every POST/PUT/DELETE/PATCH endpoint and GET /screenshot require the
# X-Helper-Token header to equal the live token (else 403 JSON
# {"error":"forbidden"}); GET /status, GET /, and GET /logo.png stay open.
def _valid_token_shape(token):
    return (isinstance(token, str) and len(token) == 64
            and all(c in "0123456789abcdef" for c in token))


def _int_env(name, default):
    try:
        return int(os.environ.get(name, "") or default)
    except (TypeError, ValueError):
        return default


def _fatal_token(msg):
    print("FATAL: helper auth token: %s" % msg, file=sys.stderr)
    sys.exit(1)


# W6-P2-7: the token lives in a zeroizable buffer, not a str, and is
# overwritten at process exit (see config/secretbuf.py for the honest
# residual statement: interpreter/hmac copies cannot be erased).
_sb_root = os.path.normpath(os.path.join(_HERE, ".."))
if _sb_root not in sys.path:
    sys.path.insert(0, _sb_root)
from config.securebuf import (  # noqa: E402
    SecretBytes, secret_bytes, zero_later)


def _load_helper_token():
    raw = os.environ.get("HELPER_AUTH_TOKEN", "").strip()
    if raw:
        # Manual/dev override: the operator chose to put the value in
        # the environment. Enforce the 64-hex shape (W6-P2-3) rather
        # than silently serving a weak token.
        if not _valid_token_shape(raw):
            _fatal_token(
                "HELPER_AUTH_TOKEN is malformed (must be exactly 64 hex "
                "chars); refusing to serve with a weak token")
        return secret_bytes(raw.encode("utf-8"))
    path = os.environ.get("HELPER_AUTH_TOKEN_FILE", "").strip()
    if path:
        try:
            with open(path, "r", encoding="utf-8") as fh:
                file_token = fh.read().strip()
        except OSError as exc:
            _fatal_token("cannot read HELPER_AUTH_TOKEN_FILE=%r (%s); "
                         "refusing to launch unauthenticated"
                         % (path, exc))
        if not _valid_token_shape(file_token):
            _fatal_token("token file %r is malformed (must hold exactly "
                         "64 hex chars); refusing to serve a weak token"
                         % path)
        return secret_bytes(file_token.encode("utf-8"))
    # Bare/dev launch: mint an ephemeral token that dies with the
    # process. The full token is printed ONLY to a live console. Under
    # keepalive HELPER_AUTH_TOKEN_FILE is always set, so this branch
    # never fires there. When stdout is not a TTY (a pipe, a log file,
    # e.g. server.log under keepalive) the notice is still printed to
    # stdout but the token value is NEVER included: it must never land
    # in server.log.
    import secrets
    ephemeral = secrets.token_hex(32)
    if sys.stdout.isatty():
        print("NOTICE: no helper auth token configured; minted an "
              "ephemeral helper token for this run only: %s" % ephemeral)
        print("NOTICE: protected helper endpoints (every POST/PUT/DELETE/"
              "PATCH, plus GET /screenshot) require the X-Helper-Token "
              "header on each request.")
    else:
        print("NOTICE: no helper auth token configured; an ephemeral "
              "helper token was minted for this run only (not shown here: "
              "stdout is not a console). Set HELPER_AUTH_TOKEN to a "
              "64-hex token and relaunch (see helper/README.md).")
    return secret_bytes(ephemeral.encode("ascii"))


HELPER_TOKEN = zero_later(_load_helper_token())


def _load_helper_token_prev():
    """(token, replaced_at_epoch) of the pre-rotation token, else (None, 0).

    keepalive.sh stages helper_token.prev as "<64hex>:<epoch>" on every
    rotation and passes its path as HELPER_AUTH_TOKEN_PREV_FILE. A
    missing or malformed prev file is ignored (fail closed to
    current-token-only), never fatal: rotation bookkeeping must not
    wedge the server.
    """
    path = os.environ.get("HELPER_AUTH_TOKEN_PREV_FILE", "").strip()
    if not path:
        return None, 0
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = fh.read().strip()
    except OSError:
        return None, 0
    try:
        hexpart, epoch = raw.split(":", 1)
        replaced_at = int(epoch)
    except (ValueError, TypeError):
        return None, 0
    if not _valid_token_shape(hexpart) or replaced_at <= 0:
        return None, 0
    return secret_bytes(hexpart.encode("ascii")), replaced_at


HELPER_TOKEN_PREV, HELPER_TOKEN_PREV_REPLACED_AT = _load_helper_token_prev()
HELPER_TOKEN_PREV_GRACE_SECONDS = _int_env(
    "HELPER_TOKEN_PREV_GRACE_SECONDS", 300)


def _token_ok(presented):
    """Constant-time token comparison. Never logs the values.

    Accepts the current token, or the pre-rotation token while it is
    inside the rotation grace window (W6-P1-1)."""
    try:
        presented = str(presented or "")
        presented_b = presented.encode("utf-8")
        if hmac.compare_digest(presented_b, HELPER_TOKEN.view()):
            return True
        prev = HELPER_TOKEN_PREV
        if prev is not None and hmac.compare_digest(presented_b,
                                                     prev.view()):
            age = time.time() - HELPER_TOKEN_PREV_REPLACED_AT
            return 0 <= age <= HELPER_TOKEN_PREV_GRACE_SECONDS
        return False
    except Exception:
        return False

# W2-P1-16: this tree's version identity. keepalive.sh compares it with
# the running server's /status helper_version; a mismatch means a stale
# pre-upgrade server is squatting the port and gets recycled, never
# adopted.
def _helper_version():
    try:
        with open(os.path.join(os.path.dirname(_HERE), "VERSION"),
                  "r", encoding="utf-8") as fh:
            return fh.read().strip().split()[0]
    except OSError:
        return "unknown"


HELPER_VERSION = _helper_version()

PORT = int(os.environ.get("LOGIN_HELPER_PORT", "8901"))
BIND = os.environ.get("LOGIN_HELPER_BIND", "127.0.0.1")
CDP_PORT = int(os.environ.get("LOGIN_HELPER_CDP_PORT", "19223"))

# W3-P1-11: LOGIN_HELPER_BIND must be loopback unless the operator
# explicitly opts in. Binding the session-driving API to a non-loopback
# address publishes it to the network (W3-P0-7); a non-loopback BIND
# without the explicit LOGIN_HELPER_BIND_PUBLIC=1 opt-in is a FATAL
# startup error. Loopback (127.x, ::1, localhost) always works.
def _bind_is_loopback(bind):
    try:
        return ipaddress.ip_address(bind).is_loopback
    except ValueError:
        return bind.strip().lower() == "localhost"


if not _bind_is_loopback(BIND) \
        and os.environ.get("LOGIN_HELPER_BIND_PUBLIC") != "1":
    print("FATAL: LOGIN_HELPER_BIND=%r is not a loopback address; "
          "refusing to expose the helper's session-driving API beyond "
          "this machine. Set LOGIN_HELPER_BIND_PUBLIC=1 to acknowledge "
          "the risk and opt in explicitly." % BIND, file=sys.stderr)
    sys.exit(1)

# W5-P2-3/W6-P2-8: the helper has an optional TLS mode
# (LOGIN_HELPER_TLS_CERT/LOGIN_HELPER_TLS_KEY). A public bind without
# TLS still puts the token, /screenshot bytes, and the /cdp/* proxy on
# the LAN in cleartext. That is operator residual risk by explicit
# opt-in, but it must never be a silent default: say it loudly on every
# startup so the operator cannot miss what the opt-in actually
# publishes. With TLS enabled the token is still a bearer secret: it
# rotates on every relaunch (W6-P1-1), bounding any capture.
if os.environ.get("LOGIN_HELPER_BIND_PUBLIC") == "1" \
        and not (os.environ.get("LOGIN_HELPER_TLS_CERT", "").strip()
                 and os.environ.get("LOGIN_HELPER_TLS_KEY", "").strip()):
    print("WARNING: LOGIN_HELPER_BIND_PUBLIC=1 exposes the helper API "
          "WITHOUT TLS: the X-Helper-Token, screenshots, and CDP proxy "
          "traffic cross the network in CLEARTEXT. Anyone able to "
          "observe LAN traffic can steal the token and drive the "
          "session-bearing browser. Set LOGIN_HELPER_TLS_CERT and "
          "LOGIN_HELPER_TLS_KEY to enable helper TLS; keep the loopback "
          "bind unless remote access is genuinely required.",
          file=sys.stderr, flush=True)

# W5-P0-1: DNS-rebinding defense. The Host header must name this
# listener: a loopback literal, or the configured BIND. A hostile page
# running in the helper's own Chromium can rebind its DNS to 127.0.0.1
# and become same-origin with the helper; without this gate it could
# fetch the open GET / page, steal the injected X-Helper-Token, and
# drive the full browser API with it. The gate runs before rate
# limiting, routing, and auth on every method, and its 403 body
# carries no token material. Legitimate clients (the sign-in UI, the
# transport's _helper_request) all address the helper as 127.0.0.1,
# so the allowlist is exactly the loopback literals plus BIND (which
# covers the public-bind opt-in's LAN address/hostname).
def _allowed_host_names():
    names = {"127.0.0.1", "localhost", "::1"}
    bind = (BIND or "").strip().lower()
    if bind:
        names.add(bind)
    return names


_ALLOWED_HOST_NAMES = _allowed_host_names()


def _host_header_ok(headers):
    """True when the request's Host header names this listener."""
    raw = headers.get("Host") or ""
    host = raw.strip()
    if not host:
        return False  # HTTP/1.1 requires Host; missing fails closed
    if host.startswith("["):
        # bracketed IPv6 literal: [::1]:8901
        host = host[1:].split("]", 1)[0]
    else:
        host = host.split(":", 1)[0]
    return host.strip().lower() in _ALLOWED_HOST_NAMES

# P0-1: the persistent profile defaults to helper/profile/ under the tree
# this file was invoked from (file-location derived, never cwd-derived).
# W2-P1-28: derived with realpath, not abspath: a symlink alias of the
# live profile must canonicalize to the same path in every comparison.
# Override (tests, dev) via LOGIN_HELPER_PROFILE_DIR.
DEFAULT_PROFILE = os.path.join(_HERE, "profile")
PROFILE_DIR = os.path.expanduser(os.environ.get("LOGIN_HELPER_PROFILE_DIR") or DEFAULT_PROFILE)

# W5-P2-1: steady-clock-anchored wall estimate. Cookie `expires` values
# are epoch timestamps, so expiry math needs an epoch "now", but
# time.time() jumps with the wall clock. Capture (wall, monotonic)
# together ONCE AT MODULE IMPORT and advance the wall reading with the
# steady clock: the estimate stays smooth across later jumps. The
# anchor is taken at helper start, when the clock is trusted (the same
# trust the TLS stack already requires for certificate validation).
# It must NOT be lazy: a first call after a wall-clock jump would
# anchor the "smooth" estimate to the jumped time.
_clock_anchor = (time.time(), time.monotonic())


def _steady_now():
    wall0, mono0 = _clock_anchor
    return wall0 + (time.monotonic() - mono0)

# P0-1/P0-4 (W2-P1-17 regression 2026-09-21: a rework narrowed this guard to
# fire only when the profile IS the live profile, letting a bare launch
# with any other profile squat the production ports. The wave-1 mandate
# stands: a bare launch can never occupy a production port, period).
# keepalive.sh always exports LOGIN_HELPER_PROFILE_DIR, so this only stops
# misconfigured bare launches. LOGIN_HELPER_PRODUCTION=1 is the explicit
# escape hatch.
if (PORT == 8901 or CDP_PORT == 19223) \
        and "LOGIN_HELPER_PROFILE_DIR" not in os.environ \
        and os.environ.get("LOGIN_HELPER_PRODUCTION") != "1":
    print("FATAL: refusing production ports without LOGIN_HELPER_PROFILE_DIR "
          "set; launch via helper/keepalive.sh", file=sys.stderr)
    sys.exit(3)

# P1-27: under the file-derived design the tree's own helper/profile IS the
# live profile, so a scratch/test boot must never silently use it. When the
# resolved profile is the default, the ports are not the production pair,
# and the profile was NOT explicitly pinned, refuse: tests and bare
# launches must pass an explicit LOGIN_HELPER_PROFILE_DIR. An explicit
# pin (even to the default path) proves intent, so keepalive.sh -- which
# always exports LOGIN_HELPER_PROFILE_DIR -- and multi-tree deployments
# on non-production ports keep working. Opt-in escape hatch for tests
# that genuinely mean the default profile:
# LOGIN_HELPER_ALLOW_TEST_ON_LIVE_PROFILE=1.
if (os.path.realpath(PROFILE_DIR) == os.path.realpath(DEFAULT_PROFILE)
        and not (PORT == 8901 and CDP_PORT == 19223)
        and "LOGIN_HELPER_PROFILE_DIR" not in os.environ
        and os.environ.get("LOGIN_HELPER_ALLOW_TEST_ON_LIVE_PROFILE") != "1"):
    print("FATAL: refusing to run with the tree's live profile "
          "(helper/profile/) on non-production ports; pass an explicit "
          "scratch LOGIN_HELPER_PROFILE_DIR for tests (or set "
          "LOGIN_HELPER_ALLOW_TEST_ON_LIVE_PROFILE=1 to opt in)",
          file=sys.stderr)
    sys.exit(3)

# P2-11: loud banner when LOGIN_HELPER_PRODUCTION=1 bypasses the
# production-port guard above. The operator owns the profile/port choice.
if os.environ.get("LOGIN_HELPER_PRODUCTION") == "1":
    print("WARNING: LOGIN_HELPER_PRODUCTION=1 set: production-port guard "
          "bypassed; you are responsible for the profile/port choice",
          file=sys.stderr)

# Chromium keeps cookies at <profile>/Default/Cookies (older layouts used
# <profile>/Cookies); check both.
# P1-20: computed per /status request, never cached at import: after a
# genuine first sign-in the cookie store appears mid-run. File existence
# alone is NOT enough: Chromium creates an empty Cookies DB on first
# launch, so count rows best-effort (immutable read, no locks taken on
# the live DB). An unreadable file falls back to True: a Cookies file is
# still evidence of a used profile.
def _normalize_tenant_base(base_url):
    # P0-7: normalize the tenant base to EXACTLY scheme://netloc/ (with a
    # trailing slash). Paths, queries, fragments, and any deep link hiding
    # in CANVAS_BASE are discarded: the helper always lands on the tenant
    # origin root, and status() keeps a direct href.startswith(base_url)
    # prefix check against that root, so sibling hostnames like
    # tenant.instructure.com.evil.com can never match (the trailing slash
    # makes the prefix check origin-exact).
    #
    # W2-P0-11: CANVAS_BASE is a server-side request primitive (the helper
    # drives Chromium at it), so validation is strict:
    # - absolute http(s) URL with a host (unchanged);
    # - https required, unless CANVAS_BASE_ALLOW_HTTP=1 documents an
    #   explicit local-dev override;
    # - no userinfo (a URL carrying user:pass credentials is rejected);
    # - no non-routable IP literals (loopback, link-local, RFC1918,
    #   multicast, reserved, unspecified);
    # - a Canvas-shaped tenant: *.instructure.com, or a self-hosted
    #   Canvas domain the educator explicitly confirms with
    #   CANVAS_BASE_CUSTOM_DOMAIN_CONFIRMED=<that exact host>.
    parsed = urllib.parse.urlsplit(base_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError(
            "CANVAS_BASE must be an absolute http(s) URL with a host, "
            "got %r" % (base_url,))
    if parsed.username or parsed.password:
        raise ValueError(
            "CANVAS_BASE must not embed credentials (userinfo); got %r"
            % (base_url,))
    if parsed.scheme != "https" \
            and os.environ.get("CANVAS_BASE_ALLOW_HTTP") != "1":
        raise ValueError(
            "CANVAS_BASE must be https (got %r); set "
            "CANVAS_BASE_ALLOW_HTTP=1 for a documented local-dev override"
            % (base_url,))
    host = (parsed.hostname or "").lower()
    # Placeholder rejection (first-run audit 2026-09-22): FIRST_RUN.md
    # promises placeholder hosts fail loudly at the tenant gate. The
    # install.sh probe rejects the doc placeholders, but the helper is
    # the runtime gate (CANVAS_BASE can be set or changed after
    # install), so it must reject them too. Bare instructure.com is
    # the corporate site, never a Canvas tenant.
    _PLACEHOLDER_HOSTS = frozenset({
        "instructure.com",
        "example.com",
        "example.instructure.com",
        "myschool.instructure.com",
        "canvas.instructure.com",
    })
    _PLACEHOLDER_LABELS = frozenset({
        "your-school", "yourschool", "your_school", "example", "myschool",
    })
    labels = host.split(".")
    if host in _PLACEHOLDER_HOSTS or any(
            lab in _PLACEHOLDER_LABELS for lab in labels):
        raise ValueError(
            "CANVAS_BASE looks like a placeholder (%r); set your school's "
            "real Canvas URL, e.g. https://<your-school>.instructure.com "
            "(got %r)" % (host, base_url))
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None and not literal.is_global:
        raise ValueError(
            "CANVAS_BASE must not point at a non-routable address "
            "(loopback, link-local, or private); got %r" % (base_url,))
    confirmed = os.environ.get(
        "CANVAS_BASE_CUSTOM_DOMAIN_CONFIRMED", "").strip().lower()
    if not (host == "instructure.com"
            or host.endswith(".instructure.com")
            or (confirmed and host == confirmed)):
        raise ValueError(
            "CANVAS_BASE must be a Canvas tenant (*.instructure.com); for "
            "a self-hosted Canvas domain set "
            "CANVAS_BASE_CUSTOM_DOMAIN_CONFIRMED=%s (got %r)"
            % (host, base_url))
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "/", "", ""))


def _profile_has_cookies():
    import sqlite3
    for cand in ("Default/Cookies", "Cookies"):
        try:
            path = os.path.join(PROFILE_DIR, cand)
            if not os.path.isfile(path):
                continue
        except OSError:
            continue
        try:
            con = sqlite3.connect("file:%s?immutable=1" % path, uri=True)
            try:
                n = con.execute("SELECT COUNT(*) FROM cookies").fetchone()[0]
            finally:
                con.close()
            if n and n > 0:
                return True
        except Exception:
            return True
    return False
DEFAULT_BASE = os.environ.get("CANVAS_BASE", "")
# Large browser window: the helper UI renders this 1:1 up to CSS limits.
VIEWPORT = (1600, 1000)

# Egress CA handling is environment-derived (transport/egress.py), never
# hardcoded. The probe runs LAZILY (never at import): importing this module
# must not touch the CA file or DER-parse anything. At launcher build we
# probe for the local egress MITM CA: the MORROW_EGRESS_CA_PEM env override
# first, then well-known sandbox paths. The SPKI pin
# (--ignore-certificate-errors-spki-list) is derived from the actual file
# present. On a VM with direct egress (no MITM CA file), the flag is
# omitted entirely and Chromium launches without it. Logs carry only
# booleans (ca_found), never cert contents or pin values.
def _chrome_args():
    """Chromium args with the egress SPKI pin, computed at launcher build
    (first use), never at import time."""
    return [
        "--window-size=%d,%d" % VIEWPORT,
        *lc.egress.chrome_spki_args(),
    ]


def _egress_ca_found():
    """Boolean only, for logs. Never cert contents."""
    return lc.egress.ca_found()


def _validate_ca_pem_env():
    # P2-14: named validation. If MORROW_EGRESS_CA_PEM is set but the file
    # is not a parseable PEM certificate, fail loudly here instead of
    # dying later in a DER-parse traceback.
    pem_path = os.environ.get("MORROW_EGRESS_CA_PEM")
    if not pem_path:
        return
    try:
        lc.egress.spki_pin_for_pem(pem_path)
    except Exception as exc:
        print("FATAL: MORROW_EGRESS_CA_PEM is not a parseable PEM "
              "certificate: %s" % exc, file=sys.stderr)
        sys.exit(1)

# Event counters. We log counts and types ONLY. Never key values, text,
# coordinates are not logged either (positions on a form are treated as
# uninteresting, but we keep the logs minimal anyway).
_counters = {"key": 0, "mouse": 0, "screenshot": 0, "status": 0,
             "navigate": 0, "cdp": 0}
_counters_lock = threading.Lock()


def _bump(kind):
    with _counters_lock:
        _counters[kind] += 1
        return _counters[kind]


def _log(msg):
    _rotate_log_if_needed()
    print("[login-helper] %s" % msg, flush=True)


def _loggable_url(url):
    """scheme://host/path with the query string and fragment stripped.

    W2-P2-3: tokens (OAuth codes, LTI params, magic links) travel in the
    query; they must never reach the helper's stdout log. Unparseable
    input degrades to a redacted placeholder, never the raw value.
    """
    try:
        parts = urllib.parse.urlsplit(str(url))
        if not parts.scheme or not parts.netloc:
            return "<unparseable-url>"
        return urllib.parse.urlunsplit(
            (parts.scheme, parts.netloc, parts.path or "/", "", ""))
    except Exception:
        return "<unparseable-url>"


def _display_profile_dir(path):
    """W3-P2-6: /status must not disclose the account name embedded in
    the absolute profile path. Abbreviate $HOME as ~; the remaining
    suffix keeps scratch profiles identifiable for tests."""
    home = os.path.expanduser("~")
    if home and (path == home or path.startswith(home + os.sep)):
        return "~" + path[len(home):]
    return path


# W3-P2-7: server hardening. Four mechanisms, all tunable by env (the
# selftest pins them small; the production defaults below are chosen
# for the real clients: the sign-in UI polls /status every 2s and
# streams /screenshot every 500ms, the Python transport makes sequential
# helper calls with 10-20s client timeouts, and key/mouse input arrives
# in bursts while typing):
#
# 1. Rate limiting: per-IP token bucket checked before auth and routing.
#    Past the limit the server answers 429 JSON {"error": "rate limit
#    exceeded"} with a Retry-After header. Rejected requests are NOT
#    logged per-request (that would reintroduce the log-write
#    amplification this fixes); a per-minute summary line is emitted
#    instead. Default: burst 120, sustained 20/sec per IP. On the
#    loopback bind this is effectively one shared bucket, which is the
#    intent: it bounds total load on the helper process.
# 2. Request timeouts: every socket I/O op must make progress within
#    SOCKET_IO_TIMEOUT (default 30s), and the whole request (read +
#    handler) has REQUEST_TIMEOUT (default 60s). A watchdog closes the
#    connection at the deadline and reclaims the worker slot. Python
#    cannot kill a thread, so a truly deadlocked worker may linger until
#    its own blocking call returns, but it no longer counts against the
#    thread cap and the client never waits past the deadline. Every
#    BROWSER CDP call carries its own shorter timeout (10-20s), so in
#    practice a stuck handler is released when its CDP call times out.
# 3. Thread bound: at most MAX_WORKER_THREADS (default 16) concurrent
#    request-handler threads. Past the cap, connections are rejected
#    inline on the accept thread with 503 JSON {"error": "service
#    unavailable"} and no worker thread is spent. Handler threads are
#    daemons, so a hung worker can never wedge process shutdown.
# 4. Log rotation: server.log rotates when it passes LOG_ROTATE_BYTES
#    (default 1 MiB), keeping LOG_ROTATE_KEEP archives (server.log.1 ..
#    server.log.4, newest first). Rotation is copytruncate against the
#    file stdout is appended to (discovered via /proc/self/fd/1, or
#    F_GETPATH where there is no /proc; that file is how keepalive.sh
#    launches the server): the live file is copied to
#    server.log.1 and truncated in place, so the O_APPEND descriptor
#    keepalive holds keeps working and no log line is reformatted. The
#    server forces O_APPEND on its own stdout at import
#    (_ensure_stdout_append), so the in-place truncate stays correct
#    even if stdout was redirected with `>` instead of `>>`. A write
#    racing the copy/truncate window can be lost; that is acceptable for
#    a diagnostic log. When stdout is not a regular file (console or
#    pipe, e.g. a dev run), rotation is skipped.
#
# Check order per request: 503 (thread cap, at accept) -> 429 (rate
# limit) -> 403 (auth, unchanged) -> 404/405 -> 400/413 -> handler.
def _env_int(name, default):
    """Positive-int env override with a safe fallback to the default."""
    try:
        value = int(os.environ.get(name, ""))
        if value > 0:
            return value
    except (TypeError, ValueError):
        pass
    return default


RATE_LIMIT_BURST = _env_int("LOGIN_HELPER_RATE_LIMIT_BURST", 120)
RATE_LIMIT_RPS = _env_int("LOGIN_HELPER_RATE_LIMIT_RPS", 20)
MAX_WORKER_THREADS = _env_int("LOGIN_HELPER_MAX_WORKERS", 16)
REQUEST_TIMEOUT = _env_int("LOGIN_HELPER_REQUEST_TIMEOUT", 60)
SOCKET_IO_TIMEOUT = _env_int("LOGIN_HELPER_SOCKET_TIMEOUT", 30)
LOG_ROTATE_BYTES = _env_int("LOGIN_HELPER_LOG_ROTATE_BYTES", 1048576)
LOG_ROTATE_KEEP = _env_int("LOGIN_HELPER_LOG_ROTATE_KEEP", 4)


class _RateLimiter:
    """Per-IP token bucket. allow() returns True and spends one token,
    or False when the bucket is empty. Idle buckets are pruned so the
    map cannot grow without bound."""

    def __init__(self, burst, rps):
        self._burst = float(burst)
        self._rps = float(rps)
        self._buckets = {}
        self._lock = threading.Lock()

    def allow(self, ip):
        now = time.monotonic()
        with self._lock:
            tokens, last = self._buckets.get(ip, (self._burst, now))
            tokens = min(self._burst, tokens + (now - last) * self._rps)
            ok = tokens >= 1.0
            self._buckets[ip] = (tokens - 1.0 if ok else tokens, now)
            if len(self._buckets) > 1024:
                self._buckets = {k: v for k, v in self._buckets.items()
                                 if now - v[1] < 600}
            return ok


_RATE_LIMITER = _RateLimiter(RATE_LIMIT_BURST, RATE_LIMIT_RPS)


class _MinuteSummary:
    """Bounded event logging: note() counts, and at most one summary
    line per minute reaches the log no matter how hot the event is."""

    def __init__(self, fmt):
        self._fmt = fmt
        self._n = 0
        self._last = 0.0
        self._lock = threading.Lock()

    def note(self):
        now = time.monotonic()
        with self._lock:
            self._n += 1
            if now - self._last < 60:
                return
            n, self._n, self._last = self._n, 0, now
        _log(self._fmt % n)


_rate_limited_log = _MinuteSummary(
    "rate limiter: rejected %%d request(s) with 429 in the last minute "
    "(burst=%d, %d/sec per IP)" % (RATE_LIMIT_BURST, RATE_LIMIT_RPS))
_thread_shed_log = _MinuteSummary(
    "thread cap (%d workers): shed %%d request(s) with 503 in the last "
    "minute" % MAX_WORKER_THREADS)


def _ensure_stdout_append():
    """W3-P2-7: log rotation truncates server.log in place, which is
    only correct when every writer appends. keepalive.sh launches with
    >> (O_APPEND), but a bare `> server.log` redirect would leave this
    process's stdout offset past the truncation point and null-fill the
    file. Force O_APPEND on fd 1 so rotation is safe however stdout was
    redirected. Harmless on pipes and consoles."""
    try:
        import fcntl
        flags = fcntl.fcntl(1, fcntl.F_GETFL)
        fcntl.fcntl(1, fcntl.F_SETFL, flags | os.O_APPEND)
    except (OSError, ImportError):
        pass


_ensure_stdout_append()


def _stdout_log_path():
    """Best-effort path of the regular file stdout is appended to (the
    keepalive launch redirects stdout to server.log in the tree's state
    dir, <MORROW_HOME>/trees/<tree id>/).
    Returns None when stdout is not a regular file (console, pipe: dev
    runs), in which case rotation is skipped."""
    try:
        path = os.readlink("/proc/self/fd/1")
    except OSError:
        path = None
    if path is None and hasattr(fcntl, "F_GETPATH"):
        # No /proc (macOS): the kernel names the fd's file directly.
        try:
            raw = fcntl.fcntl(1, fcntl.F_GETPATH, b"\0" * 1024)
            path = raw.split(b"\0", 1)[0].decode("utf-8", "replace")
        except (OSError, ValueError):
            path = None
    if not path:
        return None
    try:
        if os.path.isfile(path):
            return path
    except OSError:
        pass
    return None


def _rotate_log_if_needed():
    path = _stdout_log_path()
    if not path:
        return
    try:
        if os.path.getsize(path) < LOG_ROTATE_BYTES:
            return
    except OSError:
        return
    try:
        for i in range(LOG_ROTATE_KEEP - 1, 0, -1):
            try:
                os.rename("%s.%d" % (path, i), "%s.%d" % (path, i + 1))
            except OSError:
                pass
        with open(path, "rb") as fh:
            data = fh.read()
        with open("%s.1" % path, "wb") as fh:
            fh.write(data)
        with open(path, "wb"):
            pass
    except OSError:
        pass


def _reject_503(request):
    """Inline 503 JSON on the accept thread: no worker thread is spent
    on a request we are shedding."""
    body = b'{"error": "service unavailable"}'
    head = ("HTTP/1.1 503 Service Unavailable\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: %d\r\n"
            "Cache-Control: no-store\r\n"
            "Retry-After: 1\r\n"
            "Connection: close\r\n\r\n" % len(body)).encode("ascii")
    try:
        request.settimeout(5)
        request.sendall(head + body)
    except OSError:
        pass
    finally:
        try:
            request.close()
        except OSError:
            pass


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    """ThreadingHTTPServer with a hard cap on concurrent request-handler
    threads and a per-request watchdog (W3-P2-7)."""

    daemon_threads = True
    # A deeper-than-default accept backlog: a burst past the thread cap
    # should get a clean 503, not a refused connection.
    request_queue_size = 64

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._permits = threading.Semaphore(MAX_WORKER_THREADS)

    def process_request(self, request, client_address):
        if not self._permits.acquire(blocking=False):
            _thread_shed_log.note()
            _reject_503(request)
            return
        t = threading.Thread(target=self._guarded_request,
                             args=(request, client_address),
                             daemon=True)
        t.start()

    def _guarded_request(self, request, client_address):
        done = threading.Event()
        state = {"timed_out": False, "released": False}
        state_lock = threading.Lock()

        def release_once():
            with state_lock:
                if not state["released"]:
                    state["released"] = True
                    self._permits.release()

        def watchdog():
            if not done.wait(REQUEST_TIMEOUT):
                state["timed_out"] = True
                _log("request from %s exceeded %ds; closing the "
                     "connection" % (client_address[0], REQUEST_TIMEOUT))
                for op in (lambda: request.shutdown(socket.SHUT_RDWR),
                           request.close):
                    try:
                        op()
                    except OSError:
                        pass
                # Reclaim the slot now: the stuck worker no longer counts
                # against the cap even if its thread lingers on a
                # deadlocked call Python cannot interrupt.
                release_once()

        threading.Thread(target=watchdog, daemon=True).start()
        try:
            self.finish_request(request, client_address)
        except Exception:
            # A timed-out request's BrokenPipeError is expected noise;
            # anything else keeps the stdlib traceback.
            if not state["timed_out"]:
                self.handle_error(request, client_address)
        finally:
            done.set()
            try:
                self.shutdown_request(request)
            except OSError:
                pass
            release_once()


class HelperBrowser:
    """Owns one Chromium tab pointed at the tenant homepage."""

    def __init__(self):
        proxy = (os.environ.get("https_proxy")
                 or os.environ.get("HTTPS_PROXY")
                 or os.environ.get("http_proxy")
                 or os.environ.get("HTTP_PROXY"))
        self.launcher = lc.ChromiumLauncher(
            lc.default_binary(),
            PROFILE_DIR,
            cdp_port=CDP_PORT,
            proxy=proxy,
            extra_args=_chrome_args(),
        )
        self.cdp = None
        self.tab = None  # the helper's primary tab (CDP tab dict)
        self.base_url = ""
        self._lock = threading.Lock()

    def start(self, base_url):
        # P0-7: the tenant base is normalized to exactly scheme://netloc/
        # (paths, queries, and fragments discarded) and stored exactly that
        # way; status() uses a direct prefix check against it, so sibling
        # hostnames like tenant.instructure.com.evil.com can never match.
        self.base_url = _normalize_tenant_base(base_url)
        # W6-P2-S3: cookie-expiry metadata read health. A failed CDP
        # read must surface as unknown/warning, never as a silent
        # "no warning".
        self._cookie_expiry_read_ok = True
        # P2-8: name a missing Chromium binary with install.sh's guidance
        # instead of a raw RuntimeError traceback (the __init__ probe is
        # the usual source; this wrap covers the same class from start()).
        try:
            self.launcher.start()
        except RuntimeError as exc:
            if "no Chromium binary found" in str(exc):
                raise RuntimeError(
                    "Chromium was not found at the probed locations; "
                    "install Chromium or set CHROMIUM_BIN ... see "
                    "INSTALL.md") from exc
            raise
        self.cdp = self.launcher.cdp
        self.tab = self.cdp.new_tab("about:blank")
        self._protect_primary_tab()
        # Land on the tenant homepage, not the login form: with a live
        # session (stay-signed-in cookie) this renders the dashboard; when
        # the session is dead Canvas itself redirects to /login/canvas.
        # Never navigate straight to the login form: it does not reliably
        # auto-redirect on a live session, which used to make live sessions
        # look logged out and forced needless re-sign-ins.
        self.navigate(self.base_url)

    def _protect_primary_tab(self):
        """W2-P2-6: protect the helper's primary tab in the tab registry,
        so idle-tab reaping can never close it out from under the
        executor. (new_tab auto-registers every tab; protection is the
        extra flag.)

        W6-P2-S4: a failed tab protection used to vanish silently (bare
        except: pass), leaving the helper's primary tab unprotected
        against idle-tab reaping with nobody the wiser. Fail loud on
        stderr instead.
        """
        try:
            self.launcher.set_tab_protected(self.tab.get("id"), True)
        except Exception as exc:
            print("MORROW HELPER WARNING: could not protect the primary "
                  "tab against idle-tab reaping (%s); the sign-in tab "
                  "may be closed from under the executor"
                  % type(exc).__name__, file=sys.stderr)

    def stop(self):
        try:
            self.launcher.stop()
        except Exception:
            pass

    def navigate(self, url):
        # W4-P2-8: HTTPS only. Plaintext http:// would expose the
        # educator's session to network interception; file:, data:,
        # javascript:, and other exotic schemes are never legitimate
        # helper navigation targets. Raises ValueError otherwise.
        if not isinstance(url, str) or not url:
            raise ValueError("refusing empty navigation target")
        try:
            scheme = urllib.parse.urlsplit(url).scheme.lower()
        except ValueError:
            raise ValueError("refusing malformed navigation target")
        if scheme != "https":
            raise ValueError(
                "refusing non-HTTPS navigation target: only https:// "
                "targets are allowed")
        with self._lock:
            self.cdp.navigate(self.tab, url)

    def _cookie_expiry_horizon_days(self):
        """W4-P2-3: whole days until the earliest persistent tenant cookie
        expires, or None when unknown.

        W5-P2-1: "now" is the steady-clock-anchored wall estimate
        (_steady_now()), not time.time(). Cookie `expires` values are
        epoch timestamps, so the comparison needs an epoch now; the
        anchor keeps that estimate smooth across wall-clock jumps (a
        forward jump must not fake an imminent expiry and churn
        re-auths; a backward jump must not hide a real one).

        Reads cookie METADATA ONLY through CDP (Network.getCookies scoped
        to the tenant origin): only the `expires` timestamps and the count
        leave this function. No cookie names, values, or domains are read
        into Python, logged, or returned. Session cookies (expires <= 0)
        and tenants without a configured base are skipped.

        W6-P2-S3: a CDP read failure sets _cookie_expiry_read_ok False
        and returns None (unknown, never a crash of /status); status()
        turns that into session_expiry_warning=True so the educator
        learns the expiry state is UNKNOWN instead of seeing no
        warning at all.
        """
        self._cookie_expiry_read_ok = True
        try:
            base = (self.base_url or "").rstrip("/")
            if not base:
                return None
            with self._lock:
                res = self.cdp.call(
                    self.tab, "Network.getCookies", {"urls": [base]},
                    timeout=15)
            cookies = (res or {}).get("cookies") or []
            now = _steady_now()
            future = [c["expires"] for c in cookies
                      if isinstance(c.get("expires"), (int, float))
                      and c["expires"] > 0]
            if not future:
                return None
            days = int((min(future) - now) // 86400)
            return max(days, 0)
        except Exception:
            # W6-P2-S3: the read failed; the horizon is unknown AND the
            # warning fires (fail-safe), instead of a silent None.
            self._cookie_expiry_read_ok = False
            return None

    def status(self):
        # P0-8: chromium_alive is computed per request from the launcher's
        # process, so a dead Chromium is distinguishable from a signed-out
        # session (dead CDP keeps the old url==""/logged_in=false shape).
        chromium_alive = bool(self.launcher) and self.launcher.is_running()
        # W4-P2-18: the probe reads location.href ONLY. document.title
        # is page-controlled text and must never feed /status.logged_in;
        # a hostile page could set it to a Canvas error title ("Page not
        # found") and flip logged_in. location.href is the tab's actual
        # document URL and is not forgeable by page JS.
        with self._lock:
            try:
                raw = self.cdp.evaluate(
                    self.tab,
                    "JSON.stringify({href: location.href})",
                    timeout=15,
                )
            except Exception:
                raw = None
        info = {}
        if raw:
            try:
                info = json.loads(raw)
            except ValueError:
                info = {}
        href = info.get("href", "") or ""
        path = urllib.parse.urlparse(href).path if href else ""
        # P1-25: about:blank (or an empty href) while Chromium is alive is
        # a boot in progress, not a signed-out session. logged_in stays
        # false, but keepalive must not treat this as signed-out.
        starting = chromium_alive and href in ("", "about:blank")
        # P0-7: logged_in requires the tab to actually be under the tenant
        # base: error pages, chrome-error:// tabs, and typo'd tenants
        # never count (document.title is never consulted, so hostile
        # titles cannot flip this either). The base is stored with a
        # trailing slash, so a direct prefix check rejects sibling
        # hostnames (tenant.evil.com does not start with tenant/).
        # The /login check matches a path segment so legitimate pages like
        # /pages/login-help do not false-negative.
        on_tenant = bool(self.base_url) and href.startswith(self.base_url)
        login_path = path == "/login" or path.startswith("/login/")
        # W4-P2-18: no title check. document.title is page-controlled;
        # a hostile page could set an error title and flip logged_in.
        # logged_in rests on the tab's actual document URL only.
        logged_in = (chromium_alive
                     and bool(href)
                     and on_tenant
                     and not login_path
                     and href != "about:blank"
                     and not href.startswith("chrome-error://"))
        # W2 (2026-09-21, proven live): document.title is page-controlled
        # text -- page JS can copy cookie values into it -- so the title
        # is NEVER read by status(): it is not probed, not returned, and
        # not consulted for login state. A hostile page in the helper tab
        # could otherwise exfiltrate session material through /status
        # into agent-visible output.
        # W3-P1-13: the query string and fragment are stripped for
        # output (scheme://host/path only). A hostile page can smuggle
        # material into location.href's query; the logged_in check above
        # keeps using the full href internally, but consumers never see
        # the query. W3-P2-6: the profile path abbreviates $HOME as ~.
        horizon_days = self._cookie_expiry_horizon_days()
        return {"url": _loggable_url(href) if href else "",
                "logged_in": logged_in,
                "chromium_alive": chromium_alive,
                "starting": starting,
                "profile_dir": _display_profile_dir(PROFILE_DIR),
                "profile_has_cookies": _profile_has_cookies(),
                # W4-P2-3: session-cookie expiry horizon, metadata only
                # (whole days, never cookie names/values). keepalive.sh
                # logs a loud warning when the horizon is within 7 days.
                "session_expiry_horizon_days": horizon_days,
                # W6-P2-S3: a failed metadata read warns (fail-safe):
                # "unknown" must never read as "all clear".
                "session_expiry_warning": ((horizon_days is not None
                                            and horizon_days <= 7)
                                           or not self._cookie_expiry_read_ok),
                "session_expiry_unknown": not self._cookie_expiry_read_ok,
                # W2-P1-16: version identity. keepalive.sh compares this
                # against the tree's VERSION; a mismatch means a stale
                # pre-upgrade server is squatting the port and gets
                # recycled instead of adopted.
                "helper_version": HELPER_VERSION,
                # W6-P1-S2: the educator-notification surface. The
                # re-auth machine writes notify.txt when a session death
                # pauses ops; before this field existed nothing in the
                # product ever read that file back, so the educator
                # could sit unaware for a semester. /status now carries
                # the pending notice (if any) plus the write-halt flag,
                # and the sign-in UI renders it prominently.
                "session_notice": _educator_session_notice(),
                "write_halt_active": _educator_write_halt_active(),
                # W6-P2-A4: the pinned principal's display name, so the
                # UI shows WHO is signed in. Null when no session is
                # pinned yet.
                "principal_name": _educator_principal_name()}

    def screenshot(self):
        # W5-P2-5: CDP.call owns its connection on the private
        # --remote-debugging-pipe (no WebSocket anywhere in the CDP path
        # since W4-P0-3), so screenshots do not hold up
        # latency-sensitive keyboard events.
        res = self.cdp.call(
            self.tab,
            "Page.captureScreenshot",
            {"format": "png", "captureBeyondViewport": False},
            timeout=20,
        )
        data = (res or {}).get("data", "")
        return base64.b64decode(data)

    def key(self, kind, key, code, key_code):
        """Forward one key event. Values are forwarded to CDP only and are
        never logged, stored, or returned."""
        cdp_type = "keyDown" if kind == "down" else "keyUp"
        params = {"type": cdp_type}
        if isinstance(key, str) and key:
            params["key"] = key[:32]
            # Printable single characters: include text so the char lands
            # in the focused field (covers password inputs too).
            if kind == "down" and len(key) == 1:
                params["text"] = key
        if isinstance(code, str) and code:
            params["code"] = code[:32]
        try:
            if key_code:
                params["windowsVirtualKeyCode"] = int(key_code)
        except (TypeError, ValueError):
            pass
        # Keep the key lane independent from screenshots. CDP.call owns its
        # connection, so this can be dispatched immediately and concurrently.
        self.cdp.call(self.tab, "Input.dispatchKeyEvent", params, timeout=10)

    def mouse(self, kind, x, y, button="left"):
        """Forward one mouse event. kind: pressed | released | moved."""
        cdp_type = {"pressed": "mousePressed",
                    "released": "mouseReleased",
                    "moved": "mouseMoved"}[kind]
        params = {"type": cdp_type, "x": float(x), "y": float(y)}
        if cdp_type in ("mousePressed", "mouseReleased"):
            params["button"] = button if button in (
                "left", "right", "middle") else "left"
            params["clickCount"] = 1
        with self._lock:
            self.cdp.call(self.tab, "Input.dispatchMouseEvent", params,
                          timeout=10)

    # -- /cdp/* proxy (W4-P0-3) -------------------------------------------
    # The browser-owning server dispatches narrowly scoped CDP calls for
    # the token-authenticated executor in another process. Every entry
    # point here assumes the handler already required the token.

    def _proxy_live_tabs(self):
        try:
            return self.cdp.tabs()
        except Exception:
            return []

    def _proxy_resolve(self, target_id):
        """The tab dict for an exact live target id, else None. A
        missing/unknown id is a 404, never a guess."""
        if not target_id or not isinstance(target_id, str):
            return None
        for t in self._proxy_live_tabs():
            if t.get("id") == target_id:
                return t
        return None

    @staticmethod
    def _proxy_timeout(value):
        try:
            t = float(value)
        except (TypeError, ValueError):
            t = 30.0
        return max(_CDP_PROXY_MIN_TIMEOUT,
                   min(_CDP_PROXY_MAX_TIMEOUT, t))

    def cdp_proxy_tabs(self):
        with self._lock:
            return self._proxy_live_tabs()

    def cdp_proxy_new_tab(self, url):
        if not _cdp_proxy_nav_ok(url):
            raise _HttpError(
                400, "refusing new-tab target: only about:blank and "
                "https:// URLs are allowed")
        with self._lock:
            return self.cdp.new_tab(url)

    def cdp_proxy_call(self, target_id, method, params, timeout):
        if method not in _CDP_PROXY_ALLOWLIST:
            raise _HttpError(
                403, "CDP method %r is not proxied" % (method,))
        if target_id is None and method != "Browser.setDownloadBehavior":
            raise _HttpError(
                400, "browser-level calls are limited to "
                "Browser.setDownloadBehavior")
        try:
            params_bytes = len(json.dumps(params or {}).encode("utf-8"))
        except (TypeError, ValueError):
            raise _HttpError(400, "params are not JSON-serializable")
        if params_bytes > _CDP_PROXY_MAX_PARAMS_BYTES:
            raise _HttpError(413, "params too large (max %d bytes)"
                             % _CDP_PROXY_MAX_PARAMS_BYTES)
        with self._lock:
            if target_id is None:
                session = None  # browser-level call
            else:
                session = self._proxy_resolve(target_id)
                if session is None:
                    raise _HttpError(404, "no live target %r"
                                     % (target_id[:64],))
            try:
                result = self.cdp.call(
                    session, method, params or {},
                    timeout=self._proxy_timeout(timeout))
            except Exception as exc:
                raise _HttpError(502, "CDP call failed: %s"
                                 % type(exc).__name__)
            return result or {}

    def cdp_proxy_evaluate(self, target_id, expression, await_promise,
                           context_id, timeout):
        if not isinstance(expression, str) or not expression:
            raise _HttpError(400, "expression must be a non-empty string")
        if len(expression.encode("utf-8")) > _CDP_PROXY_MAX_EXPRESSION_BYTES:
            raise _HttpError(413, "expression too large (max %d bytes)"
                             % _CDP_PROXY_MAX_EXPRESSION_BYTES)
        with self._lock:
            tab = self._proxy_resolve(target_id)
            if tab is None:
                raise _HttpError(404, "no live target %r"
                                 % (str(target_id)[:64],))
            try:
                value = self.cdp.evaluate(
                    tab, expression, await_promise=bool(await_promise),
                    timeout=self._proxy_timeout(timeout),
                    context_id=context_id)
            except RuntimeError as exc:
                # Preserve the page-JS-exception contract: the proxy
                # reports the failure; the client raises RuntimeError.
                return {"ok": False, "error": str(exc)[:500]}
            except Exception as exc:
                raise _HttpError(502, "CDP evaluate failed: %s"
                                 % type(exc).__name__)
            return {"ok": True, "value": value}

    def cdp_proxy_navigate(self, target_id, url, timeout):
        if not _cdp_proxy_nav_ok(url):
            raise _HttpError(
                400, "refusing navigation target: only https:// URLs "
                "are allowed")
        if len(url.encode("utf-8")) > _CDP_PROXY_MAX_URL_BYTES:
            raise _HttpError(413, "url too long")
        with self._lock:
            tab = self._proxy_resolve(target_id)
            if tab is None:
                raise _HttpError(404, "no live target %r"
                                 % (str(target_id)[:64],))
            try:
                self.cdp.navigate(tab, url,
                                  timeout=self._proxy_timeout(timeout))
            except ValueError as exc:
                # The transport's own https-only guard, surfaced as 400.
                raise _HttpError(400, str(exc))
            except Exception as exc:
                raise _HttpError(502, "CDP navigate failed: %s"
                                 % type(exc).__name__)
            return {"ok": True}

    def cdp_proxy_close_tab(self, target_id):
        with self._lock:
            tab = self._proxy_resolve(target_id)
            if tab is None:
                # Closing a dead tab is a no-op success.
                return {"ok": True}
            try:
                self.cdp.close_tab(tab)
            except Exception:
                pass
            return {"ok": True}

    def cdp_proxy_events(self, target_id, timeout_s):
        try:
            timeout_s = float(timeout_s)
        except (TypeError, ValueError):
            timeout_s = 5.0
        timeout_s = max(0.1, min(25.0, timeout_s))
        with self._lock:
            tab = self._proxy_resolve(target_id)
            if tab is None:
                raise _HttpError(404, "no live target %r"
                                 % (str(target_id)[:64],))
            try:
                events = self.cdp.poll_session_events(tab,
                                                      timeout=timeout_s)
            except Exception as exc:
                raise _HttpError(502, "CDP event poll failed: %s"
                                 % type(exc).__name__)
            return {"events": events or []}


BROWSER = None


class _HttpError(Exception):
    """Carries an HTTP error response out of a request handler."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


# W3-P2-9: known paths and their allowed methods. A request to a known
# path with any other method gets 405 JSON (not 404); an unknown path
# gets 404 JSON.
_ROUTES = {
    "/": ("GET",),
    "/index.html": ("GET",),
    "/logo.png": ("GET",),
    "/status": ("GET",),
    "/screenshot": ("GET",),
    "/input/key": ("POST",),
    "/input/mouse": ("POST",),
    "/navigate": ("POST",),
    "/cdp/tabs": ("POST",),
    "/cdp/new-tab": ("POST",),
    "/cdp/call": ("POST",),
    "/cdp/evaluate": ("POST",),
    "/cdp/navigate": ("POST",),
    "/cdp/close-tab": ("POST",),
    "/cdp/events": ("GET",),
}

# W3-P0-7/W3-P0-8: protected routes. Every POST/PUT/DELETE/PATCH is
# protected by construction; GET /screenshot is additionally protected
# because a screenshot can capture password entry.
_PROTECTED_GET = ("/screenshot", "/cdp/events")

# W4-P0-3: the /cdp/* proxy is the only cross-process CDP path (the
# browser's --remote-debugging-pipe is private to this process). A
# second local Morrow process (the executor) reaches CDP through it.
# Defense in depth on every proxied call:
#   * the launch token is required (all /cdp/* are protected),
#   * the CDP method must be on _CDP_PROXY_ALLOWLIST (the exact set the
#     transport/executor needs; no Target.createBrowserContext, no
#     Browser.* beyond the download guard, no Fetch.* interception,
#     nothing that escapes the browser),
#   * the target must be a live tab id from this server's own target
#     list (exact match; browser-level calls pass no target_id),
#   * payloads and timeouts are bounded below.
# W4-P2-16 hardening: generic /cdp/call is deliberately narrow. Tab
# listing, creation, and closure, evaluation, and navigation each have
# dedicated routes (/cdp/tabs, /cdp/new-tab, /cdp/close-tab,
# /cdp/evaluate, /cdp/navigate) carrying their own URL and target
# validation, so Target.*, Runtime.evaluate, and Page.navigate are NOT
# proxied here: allowing them would let a caller bypass the dedicated
# checks. Input.* stays server-side only (the sign-in UI drives the
# direct pipe). What remains is exactly what the transport's proxy
# clients need through the generic call:
_CDP_PROXY_ALLOWLIST = frozenset({
    "Page.getFrameTree",        # item_bank_sdk api() frame checks
    "Page.createIsolatedWorld",  # isolated-world probes (W4-P1-12)
    "Network.enable",           # base-class network capture flows
    "Network.disable",
    "Network.getResponseBody",
    "Network.getCookies",       # session/capture.py cookie jar
    "Browser.setDownloadBehavior",  # launcher attach-mode download guard
                                    # (browser-level only)
})
_CDP_PROXY_MAX_EXPRESSION_BYTES = 65536
_CDP_PROXY_MAX_PARAMS_BYTES = 131072
_CDP_PROXY_MAX_URL_BYTES = 2048
_CDP_PROXY_MIN_TIMEOUT = 5
_CDP_PROXY_MAX_TIMEOUT = 120


def _cdp_proxy_nav_ok(url):
    """Proxy-side navigation policy: https:// targets or about:blank.
    Mirrors the transport's _assert_https_nav_url (W4-P2-8)."""
    if url == "about:blank":
        return True
    if not isinstance(url, str) or not url:
        return False
    try:
        return urllib.parse.urlsplit(url).scheme.lower() == "https"
    except ValueError:
        return False


class Handler(BaseHTTPRequestHandler):
    server_version = "CanvasLoginHelper/0.3"

    # W3-P2-9: never disclose the runtime version in the Server banner.
    def version_string(self):
        return self.server_version

    def handle(self):
        # W3-P2-7: one request per connection, then close. The stdlib
        # would keep HTTP/1.1 connections alive across requests; a single
        # request per connection keeps the request-timeout watchdog's
        # budget per-request instead of per-connection. Loopback clients
        # (the UI's fetch, the transport's urllib) are unaffected.
        # Every socket I/O op must make progress within SOCKET_IO_TIMEOUT:
        # a stalled client cannot hold a worker thread on recv/send.
        self.close_connection = True
        try:
            self.request.settimeout(SOCKET_IO_TIMEOUT)
        except OSError:
            return
        self.handle_one_request()
        self.close_connection = True

    def _preflight(self):
        """W3-P2-7: per-IP rate limit, checked before auth and routing.
        Returns True when the request was answered here (429 JSON) and
        dispatch must stop."""
        if _RATE_LIMITER.allow(self.client_address[0]):
            return False
        _rate_limited_log.note()
        self._send_json({"error": "rate limit exceeded"}, 429,
                        [("Retry-After", "1")])
        return True

    def _host_gate(self):
        """W5-P0-1: DNS-rebinding defense. Reject any request whose Host
        header does not name this listener, before rate limiting,
        routing, or auth. A rebound attacker page is same-origin and can
        read the response body, so the 403 body stays generic (no token
        material); the offending host is logged for the operator."""
        if _host_header_ok(self.headers):
            return True
        _log("refusing request with foreign Host header: %r"
             % ((self.headers.get("Host") or "")[:80],))
        self._send_json({"error": "forbidden"}, 403)
        return False

    def _send_json(self, obj, code=200, extra_headers=None):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if extra_headers:
            for key, value in extra_headers:
                self.send_header(key, value)
        self.end_headers()
        if not getattr(self, "_head_only", False):
            self.wfile.write(body)

    def _send_png(self, data):
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if not getattr(self, "_head_only", False):
            self.wfile.write(data)

    def _require_auth(self):
        """W3-P0-7/W3-P0-8: protected endpoints require the X-Helper-Token
        header to equal the launch token. Returns True when authorized;
        otherwise sends 403 JSON {"error":"forbidden"} and returns False.
        The token value is never logged."""
        if _token_ok(self.headers.get("X-Helper-Token")):
            return True
        self._send_json({"error": "forbidden"}, 403)
        return False

    def _method_route(self, method):
        """(allowed, known) for this request's path under the method."""
        path = self.path.split("?", 1)[0]
        if path not in _ROUTES:
            return False, False
        return method in _ROUTES[path], True

    def _send_file(self, name, content_type):
        try:
            with open(os.path.join(_HERE, name), "rb") as f:
                body = f.read()
        except OSError:
            self._send_json({"error": "not found"}, 404)
            return
        if name == "index.html":
            # W3-P0-7: the sign-in UI is the one page allowed to call the
            # protected endpoints, so the server injects the token into
            # the __HELPER_TOKEN__ placeholder when serving it. The token
            # never appears in a URL, a query string, or the logs.
            # Documented honestly in helper/README.md: this stops
            # blind/off-origin API use and port-forward exposure, not a
            # party that can already read the locally served page.
            body = body.replace(b"__HELPER_TOKEN__",
                                bytes(HELPER_TOKEN))
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if not getattr(self, "_head_only", False):
            self.wfile.write(body)

    def _read_json(self):
        # W3-P2-8: oversized and malformed bodies are rejected loudly,
        # never silently discarded. An oversized body is 413 JSON; an
        # unparseable body is 400 JSON. Both surface as _HttpError so the
        # dispatcher answers with the right code.
        length = self.headers.get("Content-Length", "0") or "0"
        try:
            length = int(length)
        except (TypeError, ValueError):
            raise _HttpError(400, "malformed Content-Length")
        if length < 0:
            raise _HttpError(400, "malformed Content-Length")
        if length > 65536:
            raise _HttpError(413, "request body too large (max 65536 bytes)")
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise _HttpError(400, "malformed JSON body")

    def do_GET(self):
        self._do_get(head_only=False)

    def do_HEAD(self):
        # W3-P2-9: HEAD routes like GET (405 on known paths, 404 on
        # unknown) and returns headers only, never a body.
        self._do_get(head_only=True)

    def _do_get(self, head_only):
        self._head_only = head_only
        try:
            if not self._host_gate():
                return
            if self._preflight():
                return
            allowed, known = self._method_route("GET")
            if not known:
                self._send_json({"error": "not found"}, 404)
                return
            if not allowed:
                # W3-P2-9: wrong method on a known path is 405 JSON,
                # not 404.
                self._send_json({"error": "method not allowed"}, 405)
                return
            path = self.path.split("?", 1)[0]
            if path in ("/", "/index.html"):
                self._send_file("index.html", "text/html; charset=utf-8")
            elif path == "/logo.png":
                self._send_file("logo.png", "image/png")
            elif path == "/status":
                n = _bump("status")
                st = BROWSER.status()
                # W3-P1-12: never log the raw URL with its query string.
                # OAuth codes, LTI params, and magic links travel in the
                # query; the log keeps scheme://host/path only.
                _log("status #%d url=%s logged_in=%s" % (
                    n, _loggable_url(st.get("url", ""))[:80],
                    st.get("logged_in")))
                self._send_json(st)
            elif path == "/screenshot":
                # W3-P0-8: screenshots can capture password entry, so
                # /screenshot is protected like the write endpoints.
                if not self._require_auth():
                    return
                n = _bump("screenshot")
                png = BROWSER.screenshot()
                if n == 1 or n % 50 == 0:
                    _log("screenshot #%d bytes=%d" % (n, len(png)))
                self._send_png(png)
            elif path == "/cdp/events":
                # W4-P0-3: protected like the write endpoints; it exposes
                # another process's network traffic.
                if not self._require_auth():
                    return
                qs = urllib.parse.parse_qs(
                    self.path.split("?", 1)[1]
                    if "?" in self.path else "")
                try:
                    data = BROWSER.cdp_proxy_events(
                        qs.get("target_id", [""])[0],
                        qs.get("timeout_s", ["5"])[0])
                except _HttpError as exc:
                    self._send_json({"error": exc.message}, exc.code)
                    return
                n = _bump("cdp")
                if n % 100 == 0:
                    _log("cdp proxy calls: %d" % n)
                self._send_json(data)
            else:
                self._send_json({"error": "not found"}, 404)
        except Exception as exc:
            _log("GET %s failed: %s" % (self.path[:60], type(exc).__name__))
            self._send_json({"error": "internal"}, 500)
        finally:
            self._head_only = False

    def do_POST(self):
        try:
            if not self._host_gate():
                return
            if self._preflight():
                return
            allowed, known = self._method_route("POST")
            if not known:
                self._send_json({"error": "not found"}, 404)
                return
            if not allowed:
                # W3-P2-9: POST /status is a known path with the wrong
                # method: 405 JSON, not 404.
                self._send_json({"error": "method not allowed"}, 405)
                return
            # W3-P0-7: every POST endpoint is protected.
            if not self._require_auth():
                return
            path = self.path.split("?", 1)[0]
            if path == "/input/key":
                body = self._read_json()
                kind = body.get("kind")
                if kind not in ("down", "up"):
                    self._send_json({"error": "kind must be down|up"}, 400)
                    return
                # Values are forwarded to CDP only. We never log them.
                BROWSER.key(kind, body.get("key"), body.get("code"),
                            body.get("keyCode"))
                n = _bump("key")
                if n % 25 == 0:
                    _log("key events: %d (types only, no values)" % n)
                self._send_json({"ok": True})
            elif path == "/input/mouse":
                body = self._read_json()
                kind = body.get("kind")
                if kind not in ("pressed", "released", "moved"):
                    self._send_json(
                        {"error": "kind must be pressed|released|moved"}, 400)
                    return
                BROWSER.mouse(kind, body.get("x", 0), body.get("y", 0),
                              body.get("button", "left"))
                n = _bump("mouse")
                if n % 50 == 0:
                    _log("mouse events: %d (types only)" % n)
                self._send_json({"ok": True})
            elif path == "/navigate":
                body = self._read_json()
                url = str(body.get("url", ""))
                try:
                    BROWSER.navigate(url)
                except ValueError as exc:
                    self._send_json({"error": str(exc)}, 400)
                    return
                n = _bump("navigate")
                # W2-P2-3: never log the query string or fragment. OAuth
                # callbacks, LTI launches, and magic links carry tokens in
                # the query; the log keeps scheme://host/path only.
                _log("navigate #%d to %s" % (n, _loggable_url(url)[:80]))
                self._send_json({"ok": True})
            elif path == "/cdp/tabs":
                # W4-P0-3: the CDP proxy. All /cdp/* routes are
                # protected (the POST gate above already required the
                # token); the proxy additionally allowlists methods,
                # validates live target ids, and bounds payloads.
                try:
                    tabs = BROWSER.cdp_proxy_tabs()
                except _HttpError as exc:
                    self._send_json({"error": exc.message}, exc.code)
                    return
                n = _bump("cdp")
                if n % 100 == 0:
                    _log("cdp proxy calls: %d" % n)
                self._send_json({"tabs": tabs})
            elif path == "/cdp/new-tab":
                body = self._read_json()
                try:
                    tab = BROWSER.cdp_proxy_new_tab(
                        str(body.get("url", "about:blank")))
                except _HttpError as exc:
                    self._send_json({"error": exc.message}, exc.code)
                    return
                _bump("cdp")
                self._send_json(tab)
            elif path == "/cdp/call":
                body = self._read_json()
                try:
                    result = BROWSER.cdp_proxy_call(
                        body.get("target_id"),
                        str(body.get("method", "")),
                        body.get("params") or {},
                        body.get("timeout", 30))
                except _HttpError as exc:
                    self._send_json({"error": exc.message}, exc.code)
                    return
                _bump("cdp")
                self._send_json({"result": result})
            elif path == "/cdp/evaluate":
                body = self._read_json()
                try:
                    data = BROWSER.cdp_proxy_evaluate(
                        body.get("target_id"),
                        body.get("expression", ""),
                        body.get("await_promise", False),
                        body.get("context_id"),
                        body.get("timeout", 30))
                except _HttpError as exc:
                    self._send_json({"error": exc.message}, exc.code)
                    return
                _bump("cdp")
                self._send_json(data)
            elif path == "/cdp/navigate":
                body = self._read_json()
                try:
                    data = BROWSER.cdp_proxy_navigate(
                        body.get("target_id"),
                        str(body.get("url", "")),
                        body.get("timeout", 30))
                except _HttpError as exc:
                    self._send_json({"error": exc.message}, exc.code)
                    return
                n = _bump("cdp")
                _log("cdp navigate #%d to %s"
                     % (n, _loggable_url(str(body.get("url", "")))[:80]))
                self._send_json(data)
            elif path == "/cdp/close-tab":
                body = self._read_json()
                try:
                    data = BROWSER.cdp_proxy_close_tab(
                        body.get("target_id"))
                except _HttpError as exc:
                    self._send_json({"error": exc.message}, exc.code)
                    return
                _bump("cdp")
                self._send_json(data)
            else:
                self._send_json({"error": "not found"}, 404)
        except _HttpError as exc:
            # W3-P2-8: oversized body (413) or malformed JSON (400).
            self._send_json({"error": exc.message}, exc.code)
        except Exception as exc:
            _log("POST %s failed: %s" % (self.path[:60], type(exc).__name__))
            self._send_json({"error": "internal"}, 500)

    def _wrong_method_or_unknown(self):
        # W5-P0-1: the Host gate runs first here too; a rebound page
        # must not get routing oracles either.
        if not self._host_gate():
            return
        # W3-P2-7: the rate limit covers these methods too.
        if self._preflight():
            return
        # W3-P2-9: PUT/DELETE/PATCH/OPTIONS on a known path are 405 JSON;
        # on an unknown path they are 404 JSON. The stdlib's 501 HTML is
        # never served. The 405/404 routing answer comes before auth: it
        # reveals nothing beyond what the served UI page already shows.
        path = self.path.split("?", 1)[0]
        if path in _ROUTES:
            self._send_json({"error": "method not allowed"}, 405)
        else:
            self._send_json({"error": "not found"}, 404)

    def do_PUT(self):
        self._wrong_method_or_unknown()

    def do_DELETE(self):
        self._wrong_method_or_unknown()

    def do_PATCH(self):
        self._wrong_method_or_unknown()

    def do_OPTIONS(self):
        self._wrong_method_or_unknown()

    def log_message(self, fmt, *args):  # keep stdlib access log quiet
        pass


def _start_idle_tab_reaper():
    """W4-P2-16: idle-tab reaping runs in the browser-owning process.

    keepalive's memory_watch used to reap from another process over TCP
    CDP; with --remote-debugging-pipe no other process can reach CDP, so
    the reaper lives here, beside the pipe. Every
    CHROMIUM_IDLE_TAB_MINUTES it asks the launcher to close
    registry-tracked, unprotected, long-idle tabs showing nothing
    (about:blank / chrome-error). The helper's primary tab is protected
    and never reaped. Failures are logged, never fatal.
    """
    try:
        idle_min = float(os.environ.get("CHROMIUM_IDLE_TAB_MINUTES",
                                        "30") or 30)
    except (TypeError, ValueError):
        idle_min = 30.0
    if idle_min <= 0:
        return None

    def _loop():
        interval = max(60.0, idle_min * 60.0)
        while True:
            time.sleep(interval)
            try:
                reaped = BROWSER.launcher.reap_idle_tabs(idle_min * 60.0)
            except Exception as exc:
                _log("idle-tab reap failed: %s" % type(exc).__name__)
                continue
            if reaped:
                _log("idle-tab reap closed %d tab(s)" % len(reaped))

    t = threading.Thread(target=_loop, name="idle-tab-reaper",
                         daemon=True)
    t.start()
    return t


def _cleanup_startup(srv):
    # P1-21: release the bound HTTP socket and stop Chromium after a
    # startup failure; neither may be orphaned. Both calls are defensive.
    try:
        srv.server_close()
    except Exception:
        pass
    try:
        BROWSER.stop()
    except Exception:
        pass


def main():
    global BROWSER
    base = (sys.argv[1] if len(sys.argv) > 1 else DEFAULT_BASE).rstrip("/")
    if not base:
        print("ERROR: no Canvas tenant. Set CANVAS_BASE or pass the base URL, e.g.",
              file=sys.stderr)
        print("  CANVAS_BASE=https://myschool.instructure.com python3 helper/server.py",
              file=sys.stderr)
        sys.exit(2)
    if not base.startswith(("http://", "https://")):
        base = "https://" + base
    # P2-14: validate the egress CA override right after the tenant check,
    # so a bad MORROW_EGRESS_CA_PEM fails here with a named message.
    _validate_ca_pem_env()
    # W4-P0-3: CDP_PORT is this tree's identity label now; Chromium
    # runs with --remote-debugging-pipe and opens no TCP debug port.
    _log("starting (tenant base: %s, http port: %d, tree identity: %d; "
         "Chromium uses --remote-debugging-pipe, no TCP CDP listener)"
         % (base, PORT, CDP_PORT))
    _log("profile: %s (has_cookies=%s)" % (_display_profile_dir(PROFILE_DIR),
                                           _profile_has_cookies()))
    if PORT == 8901 and not _profile_has_cookies():
        # P1-19: lead with the normal first-run case, not the error case.
        _log("WARNING: no session cookies yet in %s. If this is first "
             "onboarding, this is expected: sign in once through the "
             "helper page. If this machine was already onboarded, the "
             "profile path is wrong." % PROFILE_DIR)
    _log("egress CA probe: ca_found=%s" % _egress_ca_found())
    # P1-21: bind the HTTP port BEFORE launching Chromium. A port
    # conflict must die here, not after a browser (and its profile
    # SingletonLock) has been orphaned.
    try:
        srv = BoundedThreadingHTTPServer((BIND, PORT), Handler)
    except OSError as exc:
        print("FATAL: cannot bind helper HTTP port %d (%s); is another "
              "instance running?" % (PORT, exc), file=sys.stderr)
        sys.exit(1)
    # W6-P2-8: optional TLS mode. The helper speaks plaintext HTTP by
    # default (loopback). When LOGIN_HELPER_TLS_CERT and
    # LOGIN_HELPER_TLS_KEY both point at PEM files, the listener is
    # wrapped in TLS (TLS 1.2+). This bounds the W6-P1-1
    # cleartext-capture path on non-loopback binds; a non-loopback bind
    # still requires the explicit LOGIN_HELPER_BIND_PUBLIC=1 opt-in.
    # keepalive.sh probes over https when these are set (see STATUS_URL).
    tls_cert = os.environ.get("LOGIN_HELPER_TLS_CERT", "").strip()
    tls_key = os.environ.get("LOGIN_HELPER_TLS_KEY", "").strip()
    TLS_ACTIVE = False
    if tls_cert or tls_key:
        if not (tls_cert and tls_key):
            print("FATAL: LOGIN_HELPER_TLS_CERT and LOGIN_HELPER_TLS_KEY "
                  "must both be set for helper TLS mode", file=sys.stderr)
            _cleanup_startup(srv)
            sys.exit(1)
        if not (os.path.isfile(tls_cert) and os.path.isfile(tls_key)):
            print("FATAL: helper TLS cert/key not found: %r %r"
                  % (tls_cert, tls_key), file=sys.stderr)
            _cleanup_startup(srv)
            sys.exit(1)
        try:
            _tls_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            _tls_ctx.load_cert_chain(tls_cert, tls_key)
            srv.socket = _tls_ctx.wrap_socket(srv.socket, server_side=True)
            TLS_ACTIVE = True
        except Exception as exc:
            print("FATAL: cannot load helper TLS cert/key (%s)" % exc,
                  file=sys.stderr)
            _cleanup_startup(srv)
            sys.exit(1)
        _log("TLS enabled on the helper listener (cert %s)" % tls_cert)
    # W2-P1-4: fail fast with a human-readable FATAL when the profile
    # directory cannot be created or written. Without this the failure
    # surfaces as a raw traceback from deep inside the Chromium
    # launcher, which names no remedy.
    try:
        os.makedirs(PROFILE_DIR, exist_ok=True)
        _probe = os.path.join(PROFILE_DIR, ".morrow-write-probe")
        with open(_probe, "w") as fh:
            fh.write("ok")
        os.unlink(_probe)
    except OSError as exc:
        print("FATAL: cannot write the Chromium profile directory %s "
              "(%s); the login helper needs a writable profile to persist "
              "the educator's session. Fix the directory's permissions, "
              "or point LOGIN_HELPER_PROFILE_DIR at a writable path."
              % (PROFILE_DIR, exc), file=sys.stderr)
        _cleanup_startup(srv)
        sys.exit(1)
    # W4: this process owns the browser it is about to launch. Tell
    # the launcher to skip the attach probe (it would hit our own
    # bound-but-not-yet-serving HTTP socket and burn 5s timing out).
    # Set here, in main(), so only the server process carries it; the
    # executor and other same-tree processes still probe-and-attach.
    os.environ["LOGIN_HELPER_OWN_BROWSER"] = "1"
    try:
        BROWSER = HelperBrowser()
        BROWSER.start(base)
    except Exception as exc:
        # P2-8: a missing Chromium binary must surface install.sh's
        # guidance, not a raw RuntimeError traceback. (default_binary()
        # raises from HelperBrowser.__init__; the launcher-start wrap in
        # HelperBrowser.start covers the same class from the other side.)
        if (isinstance(exc, RuntimeError)
                and "no Chromium binary found" in str(exc)):
            print("FATAL: Chromium was not found at the probed locations; "
                  "install Chromium (see INSTALL.md: place a binary at "
                  "transport/chromium/chrome, or ensure "
                  "/opt/meta-chromium/chrome exists) or set CHROMIUM_BIN.",
                  file=sys.stderr)
            _cleanup_startup(srv)
            sys.exit(1)
        # P1-21: name the profile SingletonLock when the CDP pipe never
        # opens OR Chromium exits during startup: the usual cause is a
        # second instance sharing the profile (the new Chromium cannot
        # lock the profile and dies), and the stock messages never say
        # so. The lock file must actually exist (lexists sees dangling
        # links); otherwise this is a different startup failure.
        if (isinstance(exc, RuntimeError)
                and ("CDP pipe" in str(exc)
                     or "exited during startup" in str(exc))
                and os.path.lexists(os.path.join(PROFILE_DIR,
                                                 "SingletonLock"))):
            print("FATAL: Chromium did not answer on its CDP pipe; the "
                  "profile SingletonLock is held (%s). Another "
                  "instance is probably using this profile: stop it "
                  "first." % os.path.join(PROFILE_DIR, "SingletonLock"),
                  file=sys.stderr)
            _cleanup_startup(srv)
            sys.exit(1)
        # P1-21: any startup failure after the HTTP bind must release the
        # bound socket and stop Chromium; neither may be orphaned.
        _cleanup_startup(srv)
        raise
    _log("chromium ready, tenant homepage loading")
    _start_idle_tab_reaper()
    _log("serving helper UI at %s://%s:%d/ (TLS %s)"
         % ("https" if TLS_ACTIVE else "http", BIND, PORT,
            "on" if TLS_ACTIVE else "off"))
    _log("auth: X-Helper-Token required on every POST/PUT/DELETE/PATCH "
         "endpoint and on GET /screenshot; GET /status stays open")
    # W2-P1-34: SIGTERM/SIGINT must run launcher cleanup. Without a
    # handler the process dies immediately on SIGTERM (the keepalive's
    # kill path) and the owned egress forwarder -- proxy credentials in
    # memory -- is orphaned on its port until something reaps it.
    # stop() is idempotent, so the finally block below doubling it is
    # harmless.
    def _on_term(signum, frame):
        _log("signal %d: shutting down" % signum)
        try:
            BROWSER.stop()
        except Exception:
            pass
        try:
            srv.server_close()
        except Exception:
            pass
        sys.exit(128 + signum)

    signal.signal(signal.SIGTERM, _on_term)
    signal.signal(signal.SIGINT, _on_term)
    try:
        srv.serve_forever()
    finally:
        _log("shutting down chromium")
        BROWSER.stop()


if __name__ == "__main__":
    main()
