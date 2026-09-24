"""Local Chromium transport for the Muse product.

The connector uses the platform Chromium shipped in the Muse VM image
(/opt/meta-chromium/chrome, Meta-provided and boot-reconciled), launches it
headless on the agent VM, and drives it via CDP (open protocol). All Canvas
API calls execute as fetch() inside the page context of an authenticated
tab, so the session cookies (including HttpOnly and MFA-bound device state)
never leave the browser process.

This replaces the managed-browser-task lane, which could not execute page-
context JavaScript. With CDP Runtime.evaluate, the fetch lane runs at full
fidelity: GET, POST, PUT, DELETE through the Canvas REST API, all on the
educator's authenticated session.

Security model (no-exposure principle):
- The connector NEVER reads cookie values, CSRF tokens, or PATs into its
  own memory as extractable secrets. Cookies live in the Chromium profile
  directory; CSRF tokens are used inside page-context JS and never returned
  to Python except as opaque API results.
- W4-P0-3: CDP uses --remote-debugging-pipe (two anonymous fds inherited
  by the Chromium child). There is no TCP listener, no /json/* HTTP, no
  devtools WebSocket: no other local process can enumerate or drive the
  browser's tabs. The only CDP client is the ChromiumLauncher that owns
  the pipe; a second tree/process reaches the browser only through the
  login helper's token-authenticated /cdp/* HTTP proxy.
- W4-P1-12: API and session probes run in a dedicated isolated world
  (Page.createIsolatedWorld), never the page's default realm, so page
  JavaScript that replaces window.fetch cannot forge probe results.
- W4-P1-13: downloads are denied browser-wide (Browser.setDownloadBehavior
  {"behavior": "deny"}) immediately after launch/attach.
- The browser profile lives under ~/workspace/ (persistent across VM
  restarts).
- No hosted dependencies, no third-party pages, no user-provisioned infra.

Session bootstrap (one time per educator):
- The connector navigates to the tenant login; credentials come from the
  Secure Vault (filled via CDP Input, never logged); MFA codes are provided
  by the educator in chat, used once, never stored. The authenticated
  profile persists; subsequent runs reuse it without re-authentication.
"""

import base64
import collections
import hashlib
import json
import os
import re
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import urllib.error
from contextlib import contextmanager

# egress.py lives next to this module. Ensure the transport dir is on
# sys.path at import time (not just at call time): importers that only
# put the tree root on sys.path (e.g. `from transport.local_chromium
# import ...`) would otherwise fail with ModuleNotFoundError: egress.
_here = os.path.dirname(os.path.abspath(__file__))
if _here not in sys.path:
    sys.path.insert(0, _here)
del _here
import egress

# SINGLE-PROFILE RULE (packaging blocker #4 fix): the connector's Chromium
# IS the login helper's Chromium. One profile, one browser, one CDP pipe.
# The helper's live profile holds the proven, authenticated Canvas
# session; the old product default (~/workspace/morrow-chromium/profile)
# is retired and must not be reintroduced. A launcher that finds the live
# helper's pipe-holder for its profile ATTACHES to it instead of launching
# a second browser with a second profile. Do not move or copy the 67 MB
# profile directory; only the resolved path changed.
HELPER_CDP_PORT = 19223


def _origin_of_url(url):
    """The scheme://host origin of a URL (host lowercased), or "" when the
    URL is unparseable. Used to pin a captured network response to the
    origin it is expected from."""
    try:
        parts = urllib.parse.urlsplit(str(url or ""))
    except Exception:  # noqa: BLE001 - unparsable URL has no origin
        return ""
    if not parts.scheme or not parts.hostname:
        return ""
    return "%s://%s" % (parts.scheme.lower(), parts.hostname.lower())


# ---------------------------------------------------------------------------
# Tree identity. Every tree derives its own runtime identity from its own
# location on disk (file-location default) with environment overrides.
# Nothing here is hardcoded to the live helper's profile or ports: a tree
# copied to a new path automatically owns a new profile, new ports, and
# new state directories.
# ---------------------------------------------------------------------------

def tree_root():
    """Canonical root of the tree this module ships in."""
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _tree_root_on_path():
    """Make sure this tree's root is on sys.path so `config.paths` (W4-P1-17
    single source of truth) imports in every launch mode: `python3 -m`
    package mode, `python3 transport/local_chromium.py` script mode, and
    helper server.py (which inserts the tree root before importing)."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if root not in sys.path:
        sys.path.insert(0, root)


def _slug_old(p):
    """Pre-W4-P2-13 slug: unbounded. Only used for the dual-lookup in
    tree_id() so existing installs keep resolving their state dir;
    never minted for new installs."""
    return re.sub(r"[^A-Za-z0-9]+", "_", p).strip("_").lower() or "tree"


def _slug_new(p):
    """W4-P2-13 bounded slug: <first 48 chars>-<sha256(path)[:16]>.

    Same algorithm as helper/keepalive.sh's tree_id_bounded(). Max 65
    chars, always NAME_MAX-safe, human-recognizable, and the hash keeps
    distinct paths distinct when the readable prefix collides."""
    s = re.sub(r"[^A-Za-z0-9]+", "_", p).strip("_").lower()
    prefix = (s[:48] or "tree")
    digest = hashlib.sha256(os.fsencode(p)).hexdigest()[:16]
    return "%s-%s" % (prefix, digest)


def tree_id(root=None):
    """Stable identity for a tree root.

    W4-P1-16: prefer the install-time UUID in <tree>/.morrow-tree-id
    (minted by install.sh), so moving or copying the tree keeps the
    state dir, journal path, and op-id idempotency instead of resetting
    them.

    W4-P2-13: pre-UUID trees fall back to the BOUNDED path slug
    (<48 chars>-<16 hex>, max 65 chars, NAME_MAX-safe; same algorithm
    as helper/keepalive.sh's tree_id_bounded) with a loud stderr
    warning, so their existing state dir is still found. When the
    legacy (unbounded) slug's state dir exists and the bounded one
    does not, the legacy slug still resolves (dual-lookup), so nothing
    is orphaned; new installs always get the bounded slug.
    """
    _tree_root_on_path()
    from config.paths import read_tree_uuid  # noqa: E402
    p = os.path.realpath(root or tree_root())
    uid = read_tree_uuid(p)
    if uid:
        return uid
    new = _slug_new(p)
    old = _slug_old(p)
    if new != old:
        base = os.path.join(morrow_home(), "trees")
        if os.path.isdir(os.path.join(base, old)) \
                and not os.path.isdir(os.path.join(base, new)):
            sys.stderr.write(
                "morrow: WARNING: using the legacy (pre-W4-P2-13) tree "
                "slug '%s' for the existing state dir; new installs use "
                "the bounded form '%s'.\n" % (old, new))
            return old
    sys.stderr.write(
        "morrow: WARNING: %s has no .morrow-tree-id; using bounded "
        "path-slug tree id '%s'. Moving this tree resets its state dir "
        "and op-id idempotency. Run install.sh (or the next upgrade) "
        "to mint a stable tree id.\n"
        % (os.path.join(p, ".morrow-tree-id"), new))
    return new


def morrow_home():
    """Global Morrow state root. Honors MORROW_HOME, defaults to ~/.morrow.

    W4-P1-17: delegated to config.paths (single source of truth)."""
    _tree_root_on_path()
    from config.paths import morrow_home as _mh  # noqa: E402
    return _mh()


def tree_state_dir(root=None):
    """Per-tree runtime state dir (keepalive lock and logs, journals,
    helper token). Not the package tree (no runtime residue in shipped
    installs) and not the bare ~/.morrow root (no cross-tree
    contention). Honors MORROW_TREE_STATE_DIR when set. root defaults
    to the tree this module ships in."""
    override = os.environ.get("MORROW_TREE_STATE_DIR")
    if override:
        return override
    return os.path.join(morrow_home(), "trees", tree_id(root))


def tree_helper_profile_dir():
    """The profile dir for THIS tree. LOGIN_HELPER_PROFILE_DIR wins when
    explicitly set (keepalive always exports it); otherwise the
    file-location default <tree>/helper/profile. Never the live helper's
    profile unless this tree IS the live tree."""
    override = os.environ.get("LOGIN_HELPER_PROFILE_DIR")
    if override:
        return os.path.expanduser(override)
    return os.path.join(tree_root(), "helper", "profile")


def _tree_setting(name, default=None):
    """One of this tree's settings: the environment, then helper/env
    (config/tree_config.py, the order keepalive.sh and the helper use)."""
    _tree_root_on_path()
    from config import tree_config  # noqa: E402
    return tree_config.setting(name, default)


def _tree_int(name, default):
    _tree_root_on_path()
    from config import tree_config  # noqa: E402
    return tree_config.int_setting(name, default)


def tree_cdp_port(default=HELPER_CDP_PORT):
    """This tree's Chromium identity label. LOGIN_HELPER_CDP_PORT (the
    environment, then helper/env) wins; defaults to the historical
    HELPER_CDP_PORT only when unset.

    W4-P0-3: with --remote-debugging-pipe there is no CDP TCP port; the
    number survives only as the tree's identity label (forwarder-port
    derivation, CDP client labeling). It opens nothing."""
    return _tree_int("LOGIN_HELPER_CDP_PORT", default)


def _tree_version():
    """This tree's VERSION marker (same file the helper server reads for
    /status helper_version); "unknown" when absent. Used to refuse
    attaching to a stale pre-upgrade helper server squatting our port."""
    try:
        root = os.path.dirname(
            os.path.dirname(os.path.abspath(__file__)))
        with open(os.path.join(root, "VERSION"), "r",
                  encoding="utf-8") as fh:
            return fh.read().strip().split()[0]
    except OSError:
        return "unknown"


def tree_helper_port(default=8901):
    """This tree's helper HTTP port: LOGIN_HELPER_PORT from the
    environment, then helper/env."""
    return _tree_int("LOGIN_HELPER_PORT", default)


# ---------------------------------------------------------------------------
# Login-helper HTTP client (W3-P0-7/W3-P0-8).
#
# keepalive.sh mints the helper token at launch and stores it at
# <tree-state-dir>/helper_token (0600). Every helper request goes through
# _helper_request, the single path that attaches the X-Helper-Token
# header. All helper calls (status, input, navigate, screenshot) funnel
# through it; nothing in this file talks to the helper HTTP port
# directly.
# ---------------------------------------------------------------------------

HELPER_TOKEN_HEADER = "X-Helper-Token"
HELPER_TOKEN_FILE = "helper_token"


def helper_token_path():
    """Absolute path of this tree's helper token file."""
    return os.path.join(tree_state_dir(), HELPER_TOKEN_FILE)


def helper_token():
    """This tree's helper auth token, or "" when no token file exists.

    A missing file means the helper is running a bare/dev launch with an
    ephemeral token (server.py prints it to the console at startup);
    callers that need a protected endpoint must supply the token another
    way. The token value is never logged here.
    """
    try:
        with open(helper_token_path(), "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def _helper_tls_context():
    """W6-P2-8: TLS client config for the login helper.

    Returns (scheme, ssl_context_or_None). HTTPS is used exactly when
    the server's TLS mode is on: LOGIN_HELPER_TLS_CERT and
    LOGIN_HELPER_TLS_KEY both set and both files exist (the same
    condition helper/server.py uses to wrap its listener; read from the
    environment, then helper/env, as the server reads them). The loopback
    cert is typically self-signed, so verification pins to the
    configured cert file itself as the trust anchor: only that exact
    certificate validates. LOGIN_HELPER_TLS_INSECURE=1 skips
    verification for loopback bring-up only. Anything else (env half
    set, cert file missing) stays on plain HTTP: never silently mix
    schemes.
    """
    cert = _tree_setting("LOGIN_HELPER_TLS_CERT", "")
    key = _tree_setting("LOGIN_HELPER_TLS_KEY", "")
    if not (cert and key and os.path.isfile(cert)
            and os.path.isfile(key)):
        return "http", None
    if _tree_setting("LOGIN_HELPER_TLS_INSECURE", "") == "1":
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return "https", ctx
    # Pin to the exact configured cert: with cafile given, only this
    # file is trusted (system CAs are not consulted).
    ctx = ssl.create_default_context(cafile=cert)
    ctx.check_hostname = True
    return "https", ctx


def _helper_request(method, path, body=None, port=None, timeout=10):
    """One authenticated request against this tree's login helper.

    Attaches X-Helper-Token on every call. Returns (status_code, bytes).
    Raises RuntimeError with the HTTP code on transport/HTTP failure;
    a 403 means the token is missing or wrong (check the token file).
    W6-P2-8: speaks HTTPS with cert-pinned verification when the
    helper's TLS mode is on (see _helper_tls_context).
    """
    p = port if port is not None else tree_helper_port()
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    token = helper_token()
    if token:
        headers[HELPER_TOKEN_HEADER] = token
    scheme, _tls_ctx = _helper_tls_context()
    req = urllib.request.Request(
        "%s://127.0.0.1:%d%s" % (scheme, p, path), data=data,
        headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout,
                                    context=_tls_ctx) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:160]
        except Exception:
            pass
        raise RuntimeError(
            "login helper %s %s failed: HTTP %d %s"
            % (method, path, exc.code, detail))
    except Exception as exc:
        raise RuntimeError(
            "login helper %s %s unreachable: %s"
            % (method, path, type(exc).__name__))


def helper_status(port=None, timeout=10):
    """GET /status through the authenticated helper path (open endpoint)."""
    code, raw = _helper_request("GET", "/status", port=port, timeout=timeout)
    return json.loads(raw.decode("utf-8"))


def helper_screenshot(port=None, timeout=20):
    """GET /screenshot through the authenticated helper path (protected)."""
    code, raw = _helper_request("GET", "/screenshot", port=port,
                                timeout=timeout)
    return raw


def helper_input_key(kind, key, code, key_code, port=None, timeout=10):
    """POST /input/key through the authenticated helper path (protected)."""
    _helper_request("POST", "/input/key",
                    {"kind": kind, "key": key, "code": code,
                     "keyCode": key_code},
                    port=port, timeout=timeout)


def helper_input_mouse(kind, x, y, button="left", port=None, timeout=10):
    """POST /input/mouse through the authenticated helper path (protected)."""
    _helper_request("POST", "/input/mouse",
                    {"kind": kind, "x": x, "y": y, "button": button},
                    port=port, timeout=timeout)


def helper_navigate(url, port=None, timeout=10):
    """POST /navigate through the authenticated helper path (protected)."""
    _helper_request("POST", "/navigate", {"url": url},
                    port=port, timeout=timeout)


def default_forwarder_port(cdp_port):
    """Per-tree egress-forwarder port derived from the tree's CDP port
    (+10000). Each tree's Chromium gets its own forwarder, so no tree
    ever rides another tree's upstream proxy (W2-P1-33). Deterministic
    per tree; override with the MORROW_FORWARDER_PORT env var when it
    must be pinned manually.

    W3-P2-15 precondition: the +10000 derivation is only valid below the
    Linux ephemeral range. A derived port >= 32768 (the ephemeral range
    floor) would collide with outbound ephemeral ports: FATAL
    (RuntimeError) here instead of handing the launcher a
    collision-prone port. An explicit forwarder_port constructor arg or
    MORROW_FORWARDER_PORT pin is the operator's deliberate choice and
    bypasses this check (neither reaches this function).
    """
    derived = int(cdp_port) + 10000
    if derived >= 32768:
        raise RuntimeError(
            "derived forwarder port %d (CDP port %s + 10000) lands in the "
            "ephemeral range (>= 32768); pick a CDP port below 22768 or pin "
            "the forwarder port explicitly" % (derived, cdp_port))
    return derived


def _pipe_chromium_holders(proc_root="/proc"):
    """Return [(pid, user_data_dir_or_None), ...] for local processes
    whose argv carries the EXACT element --remote-debugging-pipe.
    W4-P0-3: with pipe CDP there is no port to scan; process identity is
    the pipe flag plus --user-data-dir. Exact argv-element matching only,
    never substring (a --remote-debugging-pipe-for-test flag must not
    match). Stdlib only.

    The user-data-dir is the flag's exact argv value; None means the
    holder did not pass --user-data-dir at all.
    """
    holders = []
    try:
        pids = os.listdir(proc_root)
    except OSError:
        return holders
    for pid in pids:
        if not pid.isdigit():
            continue
        try:
            with open(os.path.join(proc_root, pid, "cmdline"), "rb") as fh:
                raw = fh.read()
        except OSError:
            continue
        argv = [a.decode("utf-8", "replace") for a in raw.split(b"\0")]
        if "--remote-debugging-pipe" not in argv:
            continue
        udd = None
        i = 0
        while i < len(argv):
            a = argv[i]
            if a.startswith("--user-data-dir="):
                udd = a.split("=", 1)[1]
            elif a == "--user-data-dir" and i + 1 < len(argv):
                udd = argv[i + 1]
                i += 1
            i += 1
        holders.append((pid, udd))
    return holders


def _forwarder_holder_pid(port, proc_root="/proc", script_names=("proxy_forwarder.py",)):
    """PID of the local process proving it is an egress forwarder on
    this port, else None.

    Proof (W3-P2-12): one argv element's basename is exactly a known
    forwarder script name AND one argv element is exactly the port.
    Both exact, never substring: a squatter on the per-tree forwarder
    port (or a same-name decoy like myproxy_forwarder.py) must never be
    adopted as the browser's upstream proxy. The basename form (not the
    absolute script path) is deliberate: keepalive.sh launches the
    forwarder after cd-ing into the transport dir, so its argv carries
    the relative "proxy_forwarder.py".
    """
    want_port = str(port)
    try:
        pids = os.listdir(proc_root)
    except OSError:
        return None
    for pid in pids:
        if not pid.isdigit():
            continue
        try:
            with open(os.path.join(proc_root, pid, "cmdline"), "rb") as fh:
                raw = fh.read()
        except OSError:
            continue
        argv = [a.decode("utf-8", "replace") for a in raw.split(b"\0") if a]
        names_script = any(os.path.basename(a) in script_names for a in argv)
        names_port = any(a == want_port for a in argv)
        if names_script and names_port:
            return int(pid)
    return None


def _forwarder_holder_verified(port, proc_root="/proc", script_names=("proxy_forwarder.py",)):
    """True when a local process proves it is an egress forwarder on this
    port: one argv element's basename is exactly a known forwarder
    script name AND one argv element is exactly the port. Both exact,
    never substring (W3-P2-12): a squatter on the per-tree forwarder
    port (or a same-name decoy like myproxy_forwarder.py) must never be
    adopted as the browser's upstream proxy. The basename form (not the
    absolute script path) is deliberate: keepalive.sh launches the
    forwarder after cd-ing into the transport dir, so its argv carries
    the relative "proxy_forwarder.py".
    """
    return _forwarder_holder_pid(port, proc_root, script_names) is not None


def _verify_forwarder_holder(port, script_names):
    """Adopt-or-refuse decision for a listening forwarder port.

    Returns the proxy URL when the holder proves it is an egress
    forwarder (W3-P2-12): exact proxy_forwarder.py basename + exact port
    element in its argv. A same-tree launcher that won the spawn race
    runs the identical forwarder on this port, so adoption is safe. A
    foreign squatter must never receive the browser's proxy traffic:
    fail closed, never adopt blind.

    W4-P2-9: the forwarder authenticates clients by launcher-PID
    ancestry, so a forwarder started by ANOTHER launcher would refuse
    this launcher's Chromium (403 on every CONNECT). Adopting it would
    build a browser with dead egress, so the adopt additionally requires
    the holder's MORROW_FORWARDER_LAUNCHER_PID to be this process. Our
    own orphaned forwarder (same PID) still adopts fine.
    """
    holder = _forwarder_holder_pid(port, script_names=script_names)
    if holder is None:
        raise RuntimeError(
            "refusing to use forwarder port %s: the listening process "
            "is not proxy_forwarder.py" % (port,))
    fw_launcher = _proc_environ(holder).get(
        "MORROW_FORWARDER_LAUNCHER_PID")
    if fw_launcher != str(os.getpid()):
        raise RuntimeError(
            "refusing to adopt forwarder port %s: it belongs to "
            "another launcher's proxy_forwarder.py (pid %s), whose "
            "W4-P2-9 client auth would refuse this launcher's "
            "Chromium. Stop the other launcher or wait for it to "
            "exit; not adopting." % (port, holder))
    return "http://127.0.0.1:%d" % port


def _proc_environ(pid, proc_root="/proc"):
    """The environment of a local process as {name: value}.

    Read from /proc/<pid>/environ (kernel-owned; a process cannot forge
    another process's environ). Used to read a forwarder holder's
    MORROW_FORWARDER_LAUNCHER_PID before adopting it (W4-P2-9).
    """
    env = {}
    try:
        with open(os.path.join(proc_root, str(pid), "environ"), "rb") as fh:
            raw = fh.read()
    except OSError:
        return env
    for item in raw.split(b"\0"):
        if b"=" not in item:
            continue
        k, v = item.split(b"=", 1)
        env[k.decode("utf-8", "replace")] = v.decode("utf-8", "replace")
    return env


def _no_sandbox_args():
    """W4-P0-9: --no-sandbox is passed ONLY as root. Chromium hard-refuses
    to run sandboxed as root ("Running as root without --no-sandbox is
    not supported", crbug.com/638180); verified 2026-09-21 that a
    sandboxed root launch exits immediately and that Chromium cannot run
    as an unprivileged user in this container at all, so no working
    sandboxed configuration exists here. Non-root never gets the flag.
    Returns [] or ["--no-sandbox"]; the loud warning is printed at the
    launch site."""
    if os.geteuid() == 0:
        return ["--no-sandbox"]
    return []


def _assert_https_nav_url(url):
    """W4-P2-8: refuse non-HTTPS navigation targets at the CDP layer.

    Plaintext http:// navigation would expose the educator's session to
    network interception; file:, javascript:, data:, and other exotic
    schemes are never legitimate navigation targets for this
    transport. Only https:// targets are allowed. Raises ValueError
    otherwise.
    """
    if not isinstance(url, str) or not url:
        raise ValueError("refusing empty navigation target")
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        raise ValueError("refusing malformed navigation target")
    if parts.scheme.lower() != "https":
        raise ValueError(
            "refusing non-HTTPS navigation target %r: only https:// "
            "targets are allowed" % url[:80])


def _origin_of(url):
    """(scheme, host, port) of a URL with default-port normalization, or
    None when the URL has no usable http(s) origin."""
    try:
        parsed = urllib.parse.urlsplit(url)
    except Exception:
        return None
    scheme = (parsed.scheme or "").lower()
    host = (parsed.hostname or "").lower()
    if scheme not in ("http", "https") or not host:
        return None
    try:
        port = parsed.port
    except ValueError:
        return None
    if port is None:
        port = 443 if scheme == "https" else 80
    return (scheme, host, port)


def is_tenant_url(url, base_url):
    """True when url is on the exact origin of base_url.

    W2-P0-8: tab selection used to strip the trailing slash and
    startswith() the base URL, so a sibling host like
    https://tenant.instructure.com.evil.com/ matched a tenant of
    https://tenant.instructure.com and API calls executed in the wrong
    page context. Origin equality (scheme + host, case-insensitive +
    port) can never prefix-match a sibling host.
    """
    want = _origin_of(base_url)
    return want is not None and _origin_of(url) == want


def _is_unauthenticated(body):
    """True for Canvas's 401 session-expiry body ({"status":
    "unauthenticated"}). A 401 {"status": "unauthorized"} is a
    permission refusal on a live session and returns False."""
    try:
        doc = json.loads(body or "")
    except (ValueError, TypeError):
        return False
    return isinstance(doc, dict) and \
        str(doc.get("status") or "").lower() == "unauthenticated"


def _parses_as_json(text):
    try:
        json.loads(text)
    except ValueError:
        return False
    return True


def _looks_like_login_page(body, content_type=None):
    """True when body is an HTML login page, even with HTTP 200.

    W2-P0-10: the old check only caught redirects and /login in the
    final URL; an IdP that serves the login form with status 200 passed
    silently as valid API data. Markers count only in an HTML document
    (a doctype or <html> open tag, or a text/html answer that is not
    JSON). API data is JSON, and a course page, quiz question, or post
    in it can show the sign-in form's markup, so a JSON body is never a
    sign-in page. In the document:
    - Canvas's login-form field namespace (pseudonym_session), or
    - a password field, or a login/sign-in <title>.
    """
    if not isinstance(body, str) or not body:
        return False
    lowered = body[:8192].lower()
    stripped = lowered.lstrip("\ufeff \t\r\n")
    if not (stripped.startswith("<!doctype html")
            or stripped.startswith("<html")):
        if "text/html" not in str(content_type or "").lower() \
                or _parses_as_json(body):
            return False
    if "pseudonym_session" in lowered:
        return True
    if 'type="password"' in lowered or "type='password'" in lowered:
        return True
    title = re.search(r"<title[^>]*>(.*?)</title>", lowered, re.DOTALL)
    if title and re.search(r"log[\s_-]*in|sign[\s_-]*in", title.group(1)):
        return True
    return False


def _ensure_profile_dir(path):
    """Create a Chromium profile dir as 0700; tighten a pre-existing dir
    that is looser. Profiles hold session state: group/other must never
    read them. A dir that is already 0700 (or tighter) is left alone."""
    os.makedirs(path, mode=0o700, exist_ok=True)
    if os.stat(path).st_mode & 0o077:
        os.chmod(path, 0o700)


# ---------------------------------------------------------------------------
# CDP over --remote-debugging-pipe (W4-P0-3)
# ---------------------------------------------------------------------------
#
# The browser is launched with --remote-debugging-pipe: Chromium reads CDP
# messages from fd 3 and writes responses/events to fd 4 of its own
# process. The two pipe ends are created by the launcher and inherited by
# the Chromium child at spawn. No TCP socket is ever opened: there is no
# /json/* HTTP surface and no devtools WebSocket for any other local
# process to enumerate or drive. The ONLY CDP client is the
# ChromiumLauncher that spawned the browser and holds the pipe fds.
#
# A second process that needs the browser (the executor while the login
# helper is serving this tree) goes through the helper's
# token-authenticated /cdp/* HTTP proxy (ProxyCDP below). The pipe itself
# never crosses the process boundary, and the proxy requires the helper's
# launch token (0600 file, same user), so an unrelated local process gets
# neither path.


class CDP:
    """CDP client interface. Two transports:

    PipeCDP  - speaks to the launcher-owned browser over
               --remote-debugging-pipe (same process).
    ProxyCDP - speaks to the login helper's token-authenticated /cdp/*
               HTTP proxy (executor process while the helper serves).

    W4-P2-16: direct CDP(port) construction is refused. A client is only
    ever issued by the ChromiumLauncher that owns (or is attached to) the
    browser: holder-keyed construction. Test doubles pass an explicit
    owner.
    """

    def __init__(self, port, owner=None):
        if owner is None:
            raise CDPError(
                "refusing direct CDP construction: a CDP client is issued "
                "only by the ChromiumLauncher that owns the browser's "
                "--remote-debugging-pipe (W4-P2-16). Use "
                "ChromiumLauncher.start() and read launcher.cdp.")
        # Identity label only: with --remote-debugging-pipe there is no TCP
        # listener, so this number opens nothing. It still names the tree
        # (forwarder-port derivation, holder checks).
        self.port = port
        self._owner = owner

    # -- transport interface -------------------------------------------------
    def tabs(self):
        """[{id, type, url, title}] for live page targets."""
        raise NotImplementedError

    def new_tab(self, url="about:blank"):
        """Open a tab; return its {"id", ...} dict. Registers the tab."""
        raise NotImplementedError

    def tab_session(self, tab):
        """Opaque session handle addressing `tab` (dict or target id)."""
        raise NotImplementedError

    def call(self, session, method, params=None, timeout=30):
        """Raw CDP call. session is a tab (dict/id) for page-domain
        methods, or None for browser-level methods (Target.*, Browser.*)."""
        raise NotImplementedError

    def evaluate(self, session, expression, await_promise=False,
                 timeout=30, context_id=None):
        """Runtime.evaluate; returns the value. Raises RuntimeError on a
        page JS exception (same contract as the old WebSocket client)."""
        raise NotImplementedError

    def navigate(self, session, url, timeout=30):
        raise NotImplementedError

    def close_tab(self, tab):
        """Close one tab by id; best effort, never raises."""
        raise NotImplementedError

    def poll_session_events(self, session, timeout=5):
        """Drain buffered CDP events for one tab session (Network, etc.)."""
        raise NotImplementedError

    def close(self):
        """Release transport resources. Best effort."""

    # -- shared helpers ------------------------------------------------------
    @staticmethod
    def _target_id(tab):
        tid = tab.get("id") if isinstance(tab, dict) else tab
        if not tid:
            raise CDPError("tab has no id")
        return str(tid)

    def create_isolated_world(self, tab, world_name):
        """W4-P1-12: create a dedicated isolated world in the tab's root
        frame and return its executionContextId. Probes evaluated with
        this context id run outside the page's default realm, so page
        JavaScript that replaces window.fetch cannot forge their results.
        """
        tree = self.call(tab, "Page.getFrameTree", {}, timeout=30)
        root = ((tree or {}).get("frameTree") or {}).get("frame") or {}
        frame_id = root.get("id")
        if not frame_id:
            raise CDPError("the CDP frame tree has no root frame id; "
                           "cannot create the isolated execution world")
        world = self.call(tab, "Page.createIsolatedWorld",
                          {"frameId": frame_id, "worldName": world_name},
                          timeout=30)
        context_id = (world or {}).get("executionContextId")
        if context_id is None:
            raise CDPError("Page.createIsolatedWorld returned no "
                           "executionContextId")
        return context_id

    def _evaluate_result(self, r):
        if isinstance(r, dict) and "exceptionDetails" in r:
            # The script threw (or its execution context was destroyed by a
            # navigation): never return the empty-object placeholder as a
            # value; that masks real failures as confusing TypeErrors
            # downstream.
            details = r.get("exceptionDetails") or {}
            exc = details.get("exception") or {}
            text = (exc.get("description") or details.get("text")
                    or "unknown page exception")
            raise RuntimeError("page JS exception: %s" % text)
        result = (r or {}).get("result", {})
        if result.get("subtype") == "error":
            raise RuntimeError("page JS error: %s"
                               % result.get("description"))
        return result.get("value")

    def capture_request_headers(self, tab, url, match, timeout=120):
        """Enable Network on the tab's session, navigate to `url`, and
        return (request_url, headers) for the first request `match(url,
        headers)` accepts. match is this tree's fixed policy closure
        (tenant-bound host + Authorization header); it runs in THIS
        process, so a proxy transport cannot smuggle a different policy.
        Raises TimeoutError when nothing matches in time.
        """
        session = self.tab_session(tab)
        self.call(tab, "Network.enable", {}, timeout=30)
        try:
            # Navigate only after the subscription is live so the first
            # request cannot slip past the watcher.
            self.navigate(tab, url, timeout=60)
            deadline = time.monotonic() + timeout
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(
                        "no matching request observed within %ds of "
                        "navigating to %s" % (timeout, url))
                for ev in self.poll_session_events(
                        session, min(remaining, 5)):
                    if not isinstance(ev, dict):
                        continue
                    method = ev.get("method")
                    if method == "Inspector.targetCrashed":
                        raise CDPError("the tab crashed during the header "
                                       "capture")
                    if method != "Network.requestWillBeSent":
                        continue
                    params = ev.get("params") or {}
                    request = params.get("request") or {}
                    rurl = str(request.get("url") or "")
                    headers = request.get("headers") or {}
                    try:
                        if match(rurl, headers):
                            return rurl, dict(headers)
                    except Exception:
                        continue
        finally:
            try:
                self.call(tab, "Network.disable", {}, timeout=10)
            except Exception:
                pass

    def capture_network_response(self, tab, url, url_fragment, timeout=120):
        """Enable Network on the tab's session, navigate to `url`, and
        return (response_url, body_text) for the first response whose URL
        contains `url_fragment`. Raises TimeoutError when nothing matches.
        """
        session = self.tab_session(tab)
        self.call(tab, "Network.enable", {}, timeout=30)
        try:
            self.navigate(tab, url, timeout=60)
            deadline = time.monotonic() + timeout
            pending = {}  # requestId -> response url
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(
                        "no response for %r observed within %ds"
                        % (url_fragment, timeout))
                for ev in self.poll_session_events(
                        session, min(remaining, 5)):
                    if not isinstance(ev, dict):
                        continue
                    method = ev.get("method")
                    if method == "Inspector.targetCrashed":
                        raise CDPError("the tab crashed during the "
                                       "response capture")
                    params = ev.get("params") or {}
                    if method == "Network.responseReceived":
                        response = params.get("response") or {}
                        rurl = str(response.get("url") or "")
                        if url_fragment in rurl:
                            pending[params.get("requestId")] = rurl
                    elif method == "Network.loadingFinished":
                        rid = params.get("requestId")
                        if rid in pending:
                            rurl = pending.pop(rid)
                            try:
                                body = self.call(
                                    tab, "Network.getResponseBody",
                                    {"requestId": rid}, timeout=30)
                            except CDPError:
                                continue
                            text = body.get("body", "")
                            if body.get("base64Encoded"):
                                text = base64.b64decode(
                                    text.encode("ascii")).decode(
                                        "utf-8", "replace")
                            return rurl, text
        finally:
            try:
                self.call(tab, "Network.disable", {}, timeout=10)
            except Exception:
                pass


class _PipeTransport:
    """Framed JSON over the --remote-debugging-pipe file descriptors.

    Chromium's pipe protocol: each message is one JSON object terminated
    by NUL, in both directions. One reader thread demultiplexes responses
    (matched by "id") and buffers events per sessionId. send() is
    serialized by a lock; only the reader thread ever reads.
    """

    _MAX_EVENT_BUFFER = 10000

    def __init__(self, read_fd, write_fd):
        self._r = os.fdopen(read_fd, "rb", buffering=0)
        self._w = os.fdopen(write_fd, "wb", buffering=0)
        self._send_lock = threading.Lock()
        self._id_lock = threading.Lock()
        self._next_id = 0
        self._pending = {}  # id -> [threading.Event, response-or-None]
        self._pending_lock = threading.Lock()
        self._events = {}   # sessionId (None = browser-level) -> deque
        self._events_lock = threading.Lock()
        self._closed = False
        # W5-P2-3: guards FD closure so the read loop's death path and
        # close() cannot race or double-close.
        self._fds_closed = False
        self._fds_lock = threading.Lock()
        self._reader = threading.Thread(target=self._read_loop,
                                        name="cdp-pipe-reader",
                                        daemon=True)
        self._reader.start()

    def _close_fds(self):
        """W5-P2-3: synchronized, idempotent FD closure. Both owned
        file objects are closed exactly once, from whichever path gets
        there first: the read loop's finally block (unexpected browser
        death: EOF or read error) or close(). Without this, a browser
        that died mid-session left both FDs open: the reader thread
        exited but the write FD stayed open, leaking until process
        exit and letting a later send() write into a dead pipe."""
        with self._fds_lock:
            if self._fds_closed:
                return
            self._fds_closed = True
            for fh in (self._r, self._w):
                try:
                    fh.close()
                except OSError:
                    pass

    # -- reading -----------------------------------------------------------
    def _read_loop(self):
        buf = b""
        try:
            while not self._closed:
                try:
                    chunk = self._r.read(65536)
                except OSError:
                    break
                if not chunk:
                    break  # EOF: the browser died
                buf += chunk
                while b"\0" in buf:
                    raw, buf = buf.split(b"\0", 1)
                    if raw:
                        self._dispatch(raw)
        finally:
            # W5-P2-3: the loop exited without close() being called,
            # so the browser died unexpectedly. Mark closed (further
            # sends fail fast) and release both FDs now; the
            # synchronized helper keeps this idempotent with close().
            self._closed = True
            self._close_fds()
            self._fail_all_pending(
                CDPError("the Chromium CDP pipe closed (browser died?)"))

    def _dispatch(self, raw):
        try:
            msg = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return
        if not isinstance(msg, dict):
            return
        mid = msg.get("id")
        if mid is not None:
            with self._pending_lock:
                slot = self._pending.get(mid)
            if slot is not None:
                slot[1] = msg
                slot[0].set()
            return
        session = msg.get("sessionId")  # None = browser-level event
        with self._events_lock:
            buf = self._events.get(session)
            if buf is None:
                buf = collections.deque(maxlen=self._MAX_EVENT_BUFFER)
                self._events[session] = buf
            buf.append(msg)

    def _fail_all_pending(self, exc):
        with self._pending_lock:
            slots = list(self._pending.values())
            self._pending.clear()
        for slot in slots:
            slot[1] = {"_transport_error": str(exc)}
            slot[0].set()

    # -- writing -----------------------------------------------------------
    def send(self, method, params=None, session_id=None, timeout=30):
        """One CDP round trip. Returns the result dict. Raises CDPError
        on timeout, transport failure, or a CDP-level error response."""
        with self._id_lock:
            self._next_id += 1
            mid = self._next_id
        message = {"id": mid, "method": method,
                   "params": params if params is not None else {}}
        if session_id is not None:
            message["sessionId"] = session_id
        payload = json.dumps(message).encode("utf-8") + b"\0"
        slot = [threading.Event(), None]
        with self._pending_lock:
            self._pending[mid] = slot
        try:
            with self._send_lock:
                if self._closed:
                    raise CDPError("the Chromium CDP pipe is closed")
                try:
                    self._w.write(payload)
                    self._w.flush()
                except OSError as exc:
                    raise CDPError("CDP pipe write failed: %s" % exc)
        except Exception:
            with self._pending_lock:
                self._pending.pop(mid, None)
            raise
        if not slot[0].wait(timeout):
            with self._pending_lock:
                self._pending.pop(mid, None)
            raise CDPError("CDP %s timed out after %ss"
                           % (method, timeout))
        resp = slot[1] or {}
        if "_transport_error" in resp:
            raise CDPError(resp["_transport_error"])
        if "error" in resp:
            err = resp["error"] or {}
            raise CDPError("CDP %s failed: %s"
                           % (method, err.get("message") or err))
        return resp.get("result") or {}

    def poll_events(self, session_id, timeout=5):
        """Wait up to `timeout` seconds for buffered events for one
        session; return and clear what arrived (possibly empty)."""
        deadline = time.monotonic() + timeout
        while True:
            with self._events_lock:
                buf = self._events.get(session_id)
                if buf:
                    events = list(buf)
                    buf.clear()
                    return events
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return []
            time.sleep(min(0.05, remaining))

    def close(self):
        self._closed = True
        # W5-P2-3: reuse the synchronized, idempotent FD closure.
        self._close_fds()


class PipeCDP(CDP):
    """CDP client for the launcher-owned browser, over its
    --remote-debugging-pipe. Constructed only by ChromiumLauncher after
    spawning Chromium; the pipe fds never leave this process."""

    def __init__(self, port, owner, read_fd, write_fd):
        super().__init__(port, owner=owner)
        self._pipe = _PipeTransport(read_fd, write_fd)
        self._sessions = {}  # targetId -> sessionId
        self._sessions_lock = threading.Lock()

    def _browser(self, method, params=None, timeout=30):
        return self._pipe.send(method, params, session_id=None,
                              timeout=timeout)

    def _session_id(self, tab):
        tid = self._target_id(tab)
        with self._sessions_lock:
            sid = self._sessions.get(tid)
        if sid is None:
            res = self._browser("Target.attachToTarget",
                                {"targetId": tid, "flatten": True},
                                timeout=30)
            sid = res.get("sessionId")
            if not sid:
                raise CDPError("Target.attachToTarget returned no "
                               "sessionId for tab %s" % tid)
            with self._sessions_lock:
                self._sessions[tid] = sid
        return sid

    def _drop_session(self, tab_id):
        with self._sessions_lock:
            self._sessions.pop(str(tab_id), None)

    # -- interface ---------------------------------------------------------
    def tabs(self):
        res = self._browser("Target.getTargets", {}, timeout=30)
        infos = res.get("targetInfos") or []
        out = []
        for t in infos:
            if not isinstance(t, dict):
                continue
            if t.get("type") != "page" or not t.get("targetId"):
                continue
            out.append({"id": t["targetId"], "type": "page",
                        "url": t.get("url") or "",
                        "title": t.get("title") or ""})
        return out

    def new_tab(self, url="about:blank"):
        res = self._browser("Target.createTarget", {"url": url},
                            timeout=30)
        tid = res.get("targetId")
        if not tid:
            raise CDPError("Target.createTarget returned no targetId")
        try:
            if self._owner is not None:
                self._owner.register_tab(tid)
        except Exception:
            pass
        return {"id": tid, "type": "page", "url": url or ""}

    def tab_session(self, tab):
        return self._session_id(tab)

    def call(self, session, method, params=None, timeout=30):
        sid = None if session is None else self._session_id(session)
        try:
            return self._pipe.send(method, params, session_id=sid,
                                   timeout=timeout)
        except CDPError as exc:
            # A dead tab/session surfaces here; drop the cached session
            # so the next call re-attaches instead of reusing a corpse.
            if session is not None and (
                    "No target with given id" in str(exc)
                    or "No session with given id" in str(exc)):
                self._drop_session(self._target_id(session))
            raise

    def evaluate(self, session, expression, await_promise=False,
                 timeout=30, context_id=None):
        params = {"expression": expression,
                  "awaitPromise": await_promise,
                  "returnByValue": True}
        if context_id is not None:
            params["contextId"] = context_id
        r = self.call(session, "Runtime.evaluate", params,
                      timeout=timeout)
        return self._evaluate_result(r)

    def navigate(self, session, url, timeout=30):
        _assert_https_nav_url(url)  # W4-P2-8: https only, at the CDP layer
        return self.call(session, "Page.navigate", {"url": url},
                          timeout=timeout)

    def close_tab(self, tab):
        tid = self._target_id(tab)
        try:
            self._browser("Target.closeTarget", {"targetId": tid},
                          timeout=15)
        except Exception:
            pass
        finally:
            self._drop_session(tid)
            try:
                if self._owner is not None:
                    self._owner.unregister_tab(tid)
            except Exception:
                pass
        # /json/list used to lag the close; Target.getTargets can too.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                live = {t.get("id") for t in self.tabs()}
            except Exception:
                return
            if tid not in live:
                return
            time.sleep(0.25)

    def poll_session_events(self, session, timeout=5):
        sid = session if isinstance(session, str) else self._session_id(
            session)
        return self._pipe.poll_events(sid, timeout)

    def close(self):
        try:
            self._pipe.close()
        except Exception:
            pass


class ProxyCDP(CDP):
    """CDP client through the login helper's token-authenticated /cdp/*
    HTTP proxy. Used by a second process (the executor) while the helper
    server owns the browser. Every call carries X-Helper-Token (read from
    the 0600 token file); the pipe itself never crosses the process
    boundary, so this is the only cross-process CDP path and it is
    authenticated."""

    def __init__(self, port, owner, server_port=None):
        super().__init__(port, owner=owner)
        self._server_port = server_port if server_port is not None \
            else tree_helper_port()

    def _post(self, path, body, timeout):
        code, raw = _helper_request("POST", path, body,
                                    port=self._server_port,
                                    timeout=timeout)
        if code != 200:
            raise CDPError(
                "helper CDP proxy %s failed: HTTP %d %s"
                % (path, code, raw[:160].decode("utf-8", "replace")))
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            raise CDPError("helper CDP proxy %s returned non-JSON" % path)

    def _get(self, path, timeout):
        code, raw = _helper_request("GET", path, port=self._server_port,
                                    timeout=timeout)
        if code != 200:
            raise CDPError(
                "helper CDP proxy %s failed: HTTP %d" % (path, code))
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            raise CDPError("helper CDP proxy %s returned non-JSON" % path)

    # -- interface ---------------------------------------------------------
    def tabs(self):
        data = self._post("/cdp/tabs", {}, timeout=30)
        return data.get("tabs") or []

    def new_tab(self, url="about:blank"):
        return self._post("/cdp/new-tab", {"url": url}, timeout=30)

    def tab_session(self, tab):
        # The proxy addresses tabs by target id; the server resolves the
        # pipe session itself.
        return self._target_id(tab)

    def call(self, session, method, params=None, timeout=30):
        body = {"method": method, "params": params or {}}
        if session is not None:
            body["target_id"] = self._target_id(session)
        data = self._post("/cdp/call", body, timeout=timeout)
        if isinstance(data, dict) and data.get("error"):
            raise CDPError("helper CDP proxy call %s failed: %s"
                           % (method, data["error"]))
        return (data or {}).get("result") or {}

    def evaluate(self, session, expression, await_promise=False,
                 timeout=30, context_id=None):
        data = self._post("/cdp/evaluate",
                          {"target_id": self._target_id(session),
                           "expression": expression,
                           "await_promise": await_promise,
                           "context_id": context_id},
                          timeout=timeout)
        if not isinstance(data, dict) or not data.get("ok"):
            # Preserve the page-JS-exception contract of the local client.
            raise RuntimeError((data or {}).get("error")
                               or "helper CDP proxy evaluate failed")
        return data.get("value")

    def navigate(self, session, url, timeout=30):
        self._post("/cdp/navigate",
                   {"target_id": self._target_id(session), "url": url},
                   timeout=timeout)

    def close_tab(self, tab):
        try:
            self._post("/cdp/close-tab",
                       {"target_id": self._target_id(tab)}, timeout=30)
        except Exception:
            pass

    def poll_session_events(self, session, timeout=5):
        tid = self._target_id(session)
        data = self._get("/cdp/events?target_id=%s&timeout_s=%.1f"
                         % (urllib.parse.quote(tid, safe=""),
                            max(0.1, min(timeout, 25))),
                         timeout=timeout + 5)
        return (data or {}).get("events") or []


# ---------------------------------------------------------------------------
# Memory policy (W2-P2-6): RSS accounting, idle-tab reaping, safe restart.
#
# The helper's headless Chromium runs for days. The policy is:
#   * keepalive watches the Chromium process TREE's total RSS (never one
#     PID) via the exact profile+port identity, and recycles the browser
#     over CHROMIUM_MAX_RSS_MB with a loud log. The session survives:
#     cookies live in the persistent profile on disk, so the relaunched
#     browser re-reads them; only the helper server is restarted by the
#     existing recover path.
#   * idle tabs owned by this tree (registry-tracked) that show nothing
#     (about:blank / error pages) and have had no CDP activity for
#     CHROMIUM_IDLE_TAB_MINUTES are closed. The helper's primary tab is
#     protected and never reaped; a tab showing real content is never
#     reaped.
# Process selection is exact-identity only (profile dir + CDP port), the
# same rule that fixed the keepalive wrong-tree kill (W2-P0-6) and the
# blind CDP attach (W2-P0-7). Attached launchers never restart a browser
# they did not start. Never pgrep -f / kill by name anywhere in here.
# ---------------------------------------------------------------------------

_TAB_REGISTRY_NAME = "morrow-tab-registry.json"
_TAB_REGISTRY_LOCK_NAME = "morrow-tab-registry.lock"


def _tab_registry_path(profile_dir):
    return os.path.join(profile_dir, _TAB_REGISTRY_NAME)


def _tab_registry_lock_path(profile_dir):
    return os.path.join(profile_dir, _TAB_REGISTRY_LOCK_NAME)


@contextmanager
def _tab_registry_locked(profile_dir):
    """LANE2-D7: one flock-guarded critical section for every
    tab-registry access. The old code locked the data file itself
    around the read and again around the write (and truncated with
    open("w") BEFORE taking the lock), so two concurrent
    read-modify-write cycles interleaved and the last writer silently
    discarded the other's registrations; a reader could also catch the
    file truncated-but-unwritten. The lock lives on a separate file so
    the data file stays a plain atomic-rename target; writes go through
    a tmp file + os.replace so readers never see torn JSON. Never
    nested: locked sections call only the _data helpers below."""
    import fcntl
    _ensure_profile_dir(profile_dir)
    with open(_tab_registry_lock_path(profile_dir), "a+b") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def _read_tab_registry_data(profile_dir):
    """Read the registry without locking; call with _tab_registry_locked
    held."""
    path = _tab_registry_path(profile_dir)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_tab_registry_data(profile_dir, reg):
    """Write the registry without locking; call with _tab_registry_locked
    held. Tmp + os.replace: the live file is never truncated in place."""
    _ensure_profile_dir(profile_dir)
    path = _tab_registry_path(profile_dir)
    tmp = "%s.tmp.%d" % (path, os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(reg, fh)
        fh.write("\n")
    os.replace(tmp, path)


def _read_tab_registry(profile_dir):
    """Tab registry: {tab_id: {ws, created, touched, protect}}.

    Shared across processes (server.py registers, keepalive's memory
    watch reaps), so every access goes through the registry lock.
    """
    with _tab_registry_locked(profile_dir):
        return _read_tab_registry_data(profile_dir)


def _write_tab_registry(profile_dir, reg):
    with _tab_registry_locked(profile_dir):
        _write_tab_registry_data(profile_dir, reg)


def find_chromium_pids(profile_dir, proc_root="/proc"):
    """Main-process PIDs of the Chromium for EXACTLY this identity.

    W4-P0-3: with --remote-debugging-pipe there is no CDP port to scan.
    Identity is the exact --remote-debugging-pipe argv element plus the
    --user-data-dir argv value realpath-resolving to profile_dir
    (_pipe_chromium_holders; exact element match, never substring). A
    foreign browser (another tree's, the live helper's) is never
    returned. proc_root is injectable for deterministic tests on fake
    process trees.
    """
    want = os.path.realpath(profile_dir)
    found = []
    for pid, udd in _pipe_chromium_holders(proc_root=proc_root):
        if not udd:
            continue
        try:
            if os.path.realpath(udd) == want:
                found.append(int(pid))
        except (ValueError, OSError):
            continue
    return sorted(found)


def _ppid_of(pid, proc_root="/proc"):
    """Parent PID from /proc/<pid>/stat; None when unreadable."""
    try:
        with open(os.path.join(proc_root, str(pid), "stat")) as fh:
            data = fh.read()
        # comm may contain spaces/parens: fields after the last ")".
        after = data.rsplit(")", 1)[1].split()
        return int(after[1])  # state, ppid, ...
    except (OSError, ValueError, IndexError):
        return None


def subtree_pids_for(root_pids, proc_root="/proc"):
    """Root PIDs plus every descendant, by /proc parent links.

    The memory policy accounts the whole tree: the browser main process
    spawns renderers, GPU, and utility children that hold most of the
    RSS. proc_root is injectable for fake-tree tests.
    """
    roots = set()
    for p in root_pids:
        try:
            roots.add(int(p))
        except (TypeError, ValueError):
            pass
    children = {}
    try:
        entries = os.listdir(proc_root)
    except OSError:
        return sorted(roots)
    for entry in entries:
        if not entry.isdigit():
            continue
        ppid = _ppid_of(int(entry), proc_root)
        if ppid is not None:
            children.setdefault(ppid, []).append(int(entry))
    seen = set(roots)
    queue = list(roots)
    while queue:
        for child in children.get(queue.pop(), ()):
            if child not in seen:
                seen.add(child)
                queue.append(child)
    return sorted(seen)


def process_rss_bytes(pid, proc_root="/proc"):
    """Resident set size of one PID in bytes (0 when unreadable)."""
    try:
        with open(os.path.join(proc_root, str(pid), "statm")) as fh:
            pages = int(fh.read().split()[1])
    except (OSError, ValueError, IndexError):
        return 0
    try:
        page = os.sysconf("SC_PAGE_SIZE")
    except (ValueError, OSError):
        page = 4096
    return pages * page


def subtree_rss_bytes(pids, proc_root="/proc"):
    """Total RSS of a process tree in bytes."""
    return sum(process_rss_bytes(p, proc_root) for p in pids)


def process_age_seconds(pid, proc_root="/proc"):
    """Age of a process in seconds; None when unknowable.

    W5-P2-1: computed from /proc/uptime and the process start time in
    ticks, never from the wall clock. The old form (boot = time.time()
    - uptime) let a clock jump make a fresh helper look ancient or an
    ancient one look fresh; uptime and starttime are both monotonic, so
    their difference is jump-proof.
    """
    try:
        with open(os.path.join(proc_root, "uptime")) as fh:
            uptime = float(fh.read().split()[0])
    except (OSError, ValueError, IndexError):
        return None
    try:
        with open(os.path.join(proc_root, str(pid), "stat")) as fh:
            data = fh.read()
        # starttime is the 22nd field; index 19 after the comm ")".
        start_ticks = int(data.rsplit(")", 1)[1].split()[19])
    except (OSError, ValueError, IndexError):
        return None
    try:
        ticks = os.sysconf("SC_CLK_TCK")
    except (ValueError, OSError):
        ticks = 100
    return max(0.0, uptime - start_ticks / ticks)


# ---------------------------------------------------------------------------
# Chromium process lifecycle
# ---------------------------------------------------------------------------

class ChromiumLauncher:
    """Owns the headless Chromium process (and its egress forwarder) for
    the connector."""

    def __init__(self, binary, profile_dir, cdp_port=HELPER_CDP_PORT,
                 proxy=None, extra_args=None, forwarder_port=None,
                 forwarder_script=None):
        # W4-P2-17/22: the constructor's explicit binary is checked as
        # an executable file HERE, before any version probing or
        # launch. start() re-validates the version floor on every
        # start, but a missing/non-executable binary must fail at
        # construction, never deep inside a launch attempt.
        self.binary = _require_executable_binary(binary)
        self.profile_dir = profile_dir
        self.cdp_port = cdp_port
        self.proxy = proxy  # upstream egress proxy URL (may carry auth)
        self.extra_args = extra_args or []
        # W2-P1-33: per-tree forwarder port. Explicit constructor arg wins,
        # then the MORROW_FORWARDER_PORT env override, then the default
        # derived from this tree's CDP port. Never a fixed global port:
        # two trees must not share (or race for) one upstream forwarder.
        if forwarder_port is None:
            env_port = os.environ.get("MORROW_FORWARDER_PORT")
            try:
                forwarder_port = int(env_port) if env_port else default_forwarder_port(cdp_port)
            except (TypeError, ValueError):
                forwarder_port = default_forwarder_port(cdp_port)
        self.forwarder_port = forwarder_port
        self.forwarder_script = forwarder_script or os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "proxy_forwarder.py")
        self.proc = None
        self.forwarder_proc = None
        # W4-P0-3/W4-P2-16: no CDP client exists before start(). start()
        # binds exactly one: PipeCDP for a privately launched browser
        # (this launcher holds the --remote-debugging-pipe fds), ProxyCDP
        # for the serving login helper (token-authenticated /cdp/* proxy).
        # There is deliberately no TCP client anymore.
        self.cdp = None
        self._egress_probe = None  # cached probe_egress() result for this start
        self.attached = False  # True when start() attached to a live instance

    def is_running(self):
        """True when this launcher's browser is alive.

        Privately launched: the Chromium child is still running. Attached
        (helper-serving): the helper reports a live Chromium. Never probes
        a TCP port: there is none anymore (W4-P0-3).
        """
        if self.proc is not None:
            return self.proc.poll() is None
        try:
            status = helper_status(port=tree_helper_port(), timeout=5)
        except Exception:
            return False
        return bool(status.get("chromium_alive"))

    def _helper_serving(self, server_port):
        """True when a login-helper server on `server_port` reports a live
        Chromium (not starting). Decides attach-vs-launch."""
        try:
            status = helper_status(port=server_port, timeout=5)
        except Exception:
            return False
        return bool(status.get("chromium_alive")) \
            and not bool(status.get("starting"))

    def _verify_helper_holder(self, server_port, proc_root="/proc"):
        """W2-P0-7 (pipe edition): prove the serving helper is THIS tree's.

        Two gates, both required; anything else raises loudly instead of
        attaching (fail closed, never adopt, never kill):
          1. the server's /status helper_version equals this tree's
             VERSION: a stale pre-upgrade server squatting the port is
             refused, never adopted;
          2. a local Chromium carrying the exact --remote-debugging-pipe
             argv element holds THIS launcher's profile dir: the browser
             behind the helper is proven ours, not another tree's.
        """
        try:
            status = helper_status(port=server_port, timeout=10)
        except Exception as exc:
            raise RuntimeError(
                "refusing to attach to the login helper on port %d: "
                "/status unreachable (%s)" % (server_port, exc))
        running_version = status.get("helper_version") or "unknown"
        if running_version != _tree_version():
            raise RuntimeError(
                "refusing to attach to the login helper on port %d: it "
                "reports helper_version %r, this tree is %r; a stale "
                "pre-upgrade server is squatting the port. Stop it and "
                "retry." % (server_port, running_version, _tree_version()))
        if not find_chromium_pids(self.profile_dir, proc_root=proc_root):
            raise RuntimeError(
                "refusing to attach to the login helper on port %d: no "
                "local Chromium with --remote-debugging-pipe holds this "
                "launcher's profile %s, so the browser behind the helper "
                "cannot be proven ours. Stop the foreign browser (or "
                "point this launcher at its profile) and retry."
                % (server_port, self.profile_dir))

    def _probe(self):
        """Egress probe for this launcher, computed once per instance.

        Priority: (a) authenticated proxy, (b) unauthenticated proxy,
        (c) direct egress check. The raw upstream URL inside the result is
        INTERNAL: it may carry credentials, so it is passed only to the
        forwarder subprocess environment and never logged or printed.
        """
        if self._egress_probe is None:
            self._egress_probe = egress.probe_egress(proxy_url=self.proxy)
        return self._egress_probe

    def _needs_forwarder(self):
        """True only when the upstream proxy carries credentials: Chrome
        cannot do proxy auth itself, so the loopback forwarder injects
        Proxy-Authorization. Unauthenticated proxies go straight into
        --proxy-server; direct egress needs no proxy at all. A blocked
        probe raises with the diagnostic instead of failing later."""
        probe = self._probe()
        if probe["mode"] == "blocked":
            raise RuntimeError("no usable egress: " + probe["detail"])
        return probe["needs_forwarder"]

    def _start_forwarder(self):
        if not self._needs_forwarder():
            return None
        probe = self._probe()

        def _adopt_or_refuse():
            script_names = ("proxy_forwarder.py",
                            os.path.basename(self.forwarder_script))
            return _verify_forwarder_holder(self.forwarder_port,
                                            script_names)

        # Already listening?
        try:
            s = socket.create_connection(
                ("127.0.0.1", self.forwarder_port), timeout=3)
            s.close()
            return _adopt_or_refuse()
        except RuntimeError:
            raise
        except Exception:
            pass
        env = dict(os.environ)
        # The forwarder reads the upstream URL from the environment. This
        # is the one sanctioned handoff of the credentialed URL: child
        # process env for the component whose job is proxy auth. It never
        # appears in argv, logs, or error messages.
        env["https_proxy"] = probe["upstream"]
        env["HTTPS_PROXY"] = probe["upstream"]
        # W4-P2-9: the forwarder authenticates its CONNECT clients by
        # launcher-PID ancestry. Our PID goes in the child's env (never
        # argv); our Chromium is our strict descendant, so it passes,
        # and any other local process fails closed with 403.
        env["MORROW_FORWARDER_LAUNCHER_PID"] = str(os.getpid())
        log = os.path.join(self.profile_dir, "forwarder.log")
        _ensure_profile_dir(self.profile_dir)
        with open(log, "ab") as lf:
            self.forwarder_proc = subprocess.Popen(
                [sys.executable, self.forwarder_script,
                 str(self.forwarder_port)],
                stdout=lf, stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL, start_new_session=True, env=env)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                s = socket.create_connection(
                    ("127.0.0.1", self.forwarder_port), timeout=3)
                s.close()
                return f"http://127.0.0.1:{self.forwarder_port}"
            except Exception:
                pass
            # W2-P2-23: spawn race. If our child already exited but the
            # port is listening anyway, another launcher won the race for
            # this port: adopt the winner ONLY after it proves it is the
            # forwarder (W3-P2-12, _adopt_or_refuse); a foreign squatter
            # is refused loudly instead of adopted. The loser's clean exit
            # line is in forwarder.log.
            if self.forwarder_proc.poll() is not None:
                try:
                    s = socket.create_connection(
                        ("127.0.0.1", self.forwarder_port), timeout=3)
                    s.close()
                    return _adopt_or_refuse()
                except RuntimeError:
                    raise
                except Exception:
                    pass
                break
            time.sleep(0.5)
        raise RuntimeError("proxy forwarder did not start; see " + log)

    def _proxy_arg(self, forwarder_url):
        """The --proxy-server value for this launch, from the egress probe.
        Returns None for direct egress (no proxy flag at all)."""
        if forwarder_url:
            return forwarder_url
        probe = self._probe()
        if probe["mode"] == "proxy":
            # probe["proxy"] is the redacted scheme://host:port form; the
            # raw upstream carries no credentials in this mode, so the
            # redacted form is complete and safe to pass to Chromium.
            return probe["proxy"]
        return None

    def start(self, timeout=30):
        """Bring up this launcher's Chromium: attach to the serving login
        helper's browser via its token-authenticated /cdp/* proxy, or
        launch a private Chromium with --remote-debugging-pipe.

        Returns "attached" or "launched". W4-P0-3: no TCP CDP exists in
        either mode. Raises loudly (never adopts, never kills) when the
        serving helper fails the holder proof.
        """
        # W4-P2-17/22: the binary being launched is the constructor's
        # explicit binary, version-validated HERE (fail closed). start()
        # used to validate default_binary() but launch self.binary, so an
        # explicit constructor binary could run unvalidated; and the old
        # self._binary was write-only. Now: validate exactly what we
        # launch, loudly, every start.
        version = _check_version_floor(self.binary)
        print("[chromium] launching validated binary %s (version %s)"
              % (self.binary, version), flush=True)
        if os.environ.get("LOGIN_HELPER_OWN_BROWSER") == "1":
            # This process IS the login helper server: it bound the
            # helper HTTP port itself a moment ago (bind would have
            # failed loudly if a stale server were squatting it), so no
            # other helper can be serving. Probing /status here would
            # hit our own bound-but-not-yet-serving socket and burn the
            # 5s timeout before failing closed to the launch path.
            # Skip straight to launching our own pipe browser.
            return self._launch_private(timeout=timeout)
        server_port = tree_helper_port()
        if self._helper_serving(server_port):
            # W2-P0-7: never attach blind. The serving helper must prove
            # it is this tree's (version match) and its browser must
            # prove it holds this launcher's profile (pipe identity). A
            # foreign browser/server is refused loudly, never adopted.
            self._verify_helper_holder(server_port)
            self.cdp = ProxyCDP(self.cdp_port, owner=self,
                                server_port=server_port)
            self.attached = True
            self._apply_download_deny()  # W4-P1-13, fail closed
            print("[chromium] attached to the login helper's browser via "
                  "its authenticated CDP proxy (helper port %d)"
                  % server_port, flush=True)
            return "attached"
        return self._launch_private(timeout=timeout)

    def _launch_private(self, timeout=30):
        """Launch a private headless Chromium with --remote-debugging-pipe
        and bind a PipeCDP to it. Returns "launched".

        LANE2-D8: a failed startup never orphans children. Every failure
        from the forwarder spawn through the CDP readiness wait and the
        download-deny guard funnels through self.stop(), which closes the
        CDP pipe and terminates the Chromium and forwarder child processes
        (and is safe when they already exited).
        """
        _ensure_profile_dir(self.profile_dir)
        # Pipe fds are tracked here until ownership passes to the child
        # (duped to fds 3/4) or to PipeCDP, so the failure path below can
        # close exactly the fds nobody owns yet and never double-close
        # one PipeCDP already owns.
        unowned_fds = []
        try:
            proxy_arg = self._proxy_arg(self._start_forwarder())
            args = [
                self.binary,
                "--headless=new",
                "--disable-gpu",
                "--disable-dev-shm-usage",
                "--disable-extensions",
                # W5-P2-6: component extensions (built-in, not Web-Store
                # installs) are a separate vector from --disable-extensions;
                # disable their background pages explicitly too.
                "--disable-component-extensions-with-background-pages",
                "--no-first-run",
                "--no-default-browser-check",
                # W4-P0-3: the pipe replaces the TCP debug port. Chromium reads
                # CDP on fd 3 and writes on fd 4; no other local process can
                # reach them.
                "--remote-debugging-pipe",
                f"--user-data-dir={self.profile_dir}",
                *self.extra_args,
            ]
            for _ns in _no_sandbox_args():
                # W4-P0-9: root-only (see _no_sandbox_args), logged loudly.
                args.append(_ns)
                print("[chromium] WARNING: running as root; passing "
                      "--no-sandbox because Chromium refuses the sandbox as "
                      "root (crbug.com/638180). Renderer sandboxing is "
                      "unavailable in this deployment; compensating controls "
                      "are the private CDP pipe, the isolated-world API "
                      "probes, and browser-wide download denial.",
                      flush=True)
            if proxy_arg:
                args.append(f"--proxy-server={proxy_arg}")
                # W5-P2-2: pin the loopback proxy bypass EXPLICITLY instead of
                # relying on Chromium's implicit loopback bypass (M72+,
                # undocumented, version-specific). The helper API (:8901) and
                # the form-host page are loopback-only and must be reached
                # directly; routing them through the egress forwarder would
                # break them (it speaks CONNECT only). The explicit list is
                # additive over the implicit rules and keeps working even if
                # Chromium ever changes the implicit default. NOTE:
                # --proxy-bypass-list=<-loopback> means the OPPOSITE of this:
                # it subtracts the implicit bypass and sends loopback THROUGH
                # the proxy. Never use it here.
                args.append("--proxy-bypass-list=localhost,127.0.0.1,::1")
            args.append("about:blank")
            # Pipe setup: Chromium reads CDP on fd 3, writes on fd 4. The
            # bash wrapper dups our pipes onto 3/4 in the child (thread-safe:
            # no preexec_fn fork inside this possibly-threaded process).
            to_child_r, to_child_w = os.pipe()
            from_child_r, from_child_w = os.pipe()
            unowned_fds = [to_child_r, to_child_w, from_child_r, from_child_w]
            wrapper = ("exec 3<&%d 4>&%d; exec \"$@\"" %
                       (to_child_r, from_child_w))
            # bash -c 'script' name binary arg1...: "$@" becomes
            # (binary, arg1, ...) so exec replaces bash with Chromium keeping
            # fds 3/4.
            cmd = ["bash", "-c", wrapper, "chromium-pipe-launch",
                   self.binary] + args[1:]
            log = os.path.join(self.profile_dir, "chromium.log")
            _ensure_profile_dir(self.profile_dir)
            with open(log, "ab") as lf:
                self.proc = subprocess.Popen(
                    cmd, stdout=lf, stderr=subprocess.STDOUT,
                    stdin=subprocess.DEVNULL, start_new_session=True,
                    pass_fds=(to_child_r, from_child_w))
            # Parent ends of the pipes; the child's ends were duped to 3/4.
            os.close(to_child_r)
            os.close(from_child_w)
            self.cdp = PipeCDP(self.cdp_port, owner=self,
                               read_fd=from_child_r, write_fd=to_child_w)
            # PipeCDP now owns to_child_w and from_child_r; stop() closes
            # them via cdp.close().
            unowned_fds = []
            self.attached = False
            deadline = time.monotonic() + timeout
            while True:
                if self.proc.poll() is not None:
                    raise RuntimeError(
                        "chromium exited during startup (code %s); see %s"
                        % (self.proc.returncode, log))
                try:
                    self.cdp.tabs()
                    break
                except Exception:
                    pass
                if time.monotonic() >= deadline:
                    raise RuntimeError(
                        "chromium did not answer on its CDP pipe in time; "
                        "see %s" % log)
                time.sleep(0.5)
            self._apply_download_deny()  # W4-P1-13, fail closed
        except Exception:
            for _fd in unowned_fds:
                try:
                    os.close(_fd)
                except OSError:
                    pass
            # LANE2-D8: never orphan the just-launched Chromium (or its
            # egress forwarder) when startup fails after spawn. stop()
            # closes the CDP pipe and terminates both children, and is
            # safe when they already exited.
            try:
                self.stop()
            except Exception:
                pass
            raise
        print("[chromium] launched private browser (pid %d) with "
              "--remote-debugging-pipe" % self.proc.pid, flush=True)
        return "launched"

    def _apply_download_deny(self):
        """W4-P1-13: deny downloads browser-wide, immediately after
        launch/attach and before any provider page is touched. Fail
        closed: without the guard the browser does not run."""
        try:
            self.cdp.call(None, "Browser.setDownloadBehavior",
                          {"behavior": "deny"}, timeout=30)
        except Exception as exc:
            raise RuntimeError(
                "could not deny browser downloads at startup (%s); "
                "refusing to run without the download guard" % exc)
        print("[chromium] downloads denied browser-wide "
              "(Browser.setDownloadBehavior)", flush=True)

    def stop(self):
        try:
            if self.cdp is not None:
                self.cdp.close()
        except Exception:
            pass
        finally:
            self.cdp = None
        if self.proc is not None:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=10)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass
            self.proc = None
        if self.forwarder_proc is not None:
            try:
                self.forwarder_proc.terminate()
                self.forwarder_proc.wait(timeout=5)
            except Exception:
                try:
                    self.forwarder_proc.kill()
                except Exception:
                    pass
            self.forwarder_proc = None
        self.attached = False

    # -- memory policy (W2-P2-6) -------------------------------------------
    # Tab registry: which tabs this tree opened, when they were last
    # active, and which are protected. Cross-process readable (server.py
    # registers/touches; the file is flock-guarded), persisted in the
    # profile dir as morrow-tab-registry.json. Reaping runs in the
    # browser-owning process (the helper server, or a private launcher)
    # via reap_idle_tabs: a foreign process can no longer reach CDP
    # (W4-P0-3), so keepalive's memory watch no longer reaps.

    def register_tab(self, tab_id, protect=False):
        if not tab_id:
            return
        # LANE2-D7: the read-modify-write is one locked section; the old
        # separate read-lock / write-lock let a concurrent writer's
        # registration vanish.
        with _tab_registry_locked(self.profile_dir):
            reg = _read_tab_registry_data(self.profile_dir)
            now = time.time()
            entry = reg.get(tab_id) or {}
            entry["touched"] = now
            entry.setdefault("created", now)
            if protect:
                entry["protect"] = True
            reg[tab_id] = entry
            _write_tab_registry_data(self.profile_dir, reg)

    def set_tab_protected(self, tab_id, protect=True):
        if not tab_id:
            return
        with _tab_registry_locked(self.profile_dir):
            reg = _read_tab_registry_data(self.profile_dir)
            entry = reg.get(tab_id) or {"created": time.time(),
                                        "touched": time.time()}
            if protect:
                entry["protect"] = True
            else:
                entry.pop("protect", None)
            reg[tab_id] = entry
            _write_tab_registry_data(self.profile_dir, reg)

    def touch_tab(self, tab_id):
        if not tab_id:
            return
        with _tab_registry_locked(self.profile_dir):
            reg = _read_tab_registry_data(self.profile_dir)
            entry = reg.get(tab_id)
            if entry is None:
                return
            entry["touched"] = time.time()
            _write_tab_registry_data(self.profile_dir, reg)

    def unregister_tab(self, tab_id):
        if not tab_id:
            return
        with _tab_registry_locked(self.profile_dir):
            reg = _read_tab_registry_data(self.profile_dir)
            if reg.pop(tab_id, None) is not None:
                _write_tab_registry_data(self.profile_dir, reg)

    def reap_idle_tabs(self, max_idle_seconds):
        """Close this tree's idle, contentless tabs through the
        launcher-owned CDP client (pipe or helper proxy).

        W4-P2-16: the old module-level reap_idle_tabs constructed a bare
        CDP(cdp_port); that path is refused now. Reaping runs
        in-process here (the browser owner), because a foreign process
        can no longer reach CDP at all (W4-P0-3).

        A tab is reaped only when ALL hold:
          - it is in this tree's registry (opened by this tree),
          - it is not protected (the helper's primary tab is protected),
          - no activity for >= max_idle_seconds,
          - its live URL is "" / about:blank / chrome-error:// (never a
            tab showing real content).
        Registry entries for tabs that no longer exist are pruned. Never
        touches processes. Returns the list of reaped tab ids.

        LANE2-D15: two-phase reap. Phase 1 snapshots the registry under
        the lock; phase 2 does the slow CDP work (tabs(), close_tab())
        WITHOUT the lock, so a reap never blocks register/touch; phase
        3 re-opens the latest registry under the lock and removes only
        entries whose metadata is unchanged since the snapshot. A
        concurrent register/touch/protect is never silently discarded
        (the old code held the lock across the CDP calls AND overwrote
        concurrent updates with its stale snapshot).

        LANE2-D15b: protection wins over an in-flight reap. Before
        close_tab, the entry's CURRENT metadata is re-read under a brief
        lock (no CDP while held): a concurrent set_tab_protected, or an
        entry that vanished (unregistered), vetoes the close. A mere
        concurrent touch does not veto the close, but the phase-3
        conditional writeback still preserves the refreshed entry.

        Returns the ids of tabs that were both closed AND removed from
        the registry. Tabs closed while a concurrent update kept their
        registry entry are logged separately, never reported as reaped.
        """
        if self.cdp is None:
            return []
        with _tab_registry_locked(self.profile_dir):
            snapshot = _read_tab_registry_data(self.profile_dir)
        if not snapshot:
            return []
        try:
            live = {t.get("id"): t for t in self.cdp.tabs()
                    if t.get("id")}
        except Exception:
            return []
        now = time.time()
        victims = []
        for tab_id, meta in snapshot.items():
            tab = live.get(tab_id)
            if tab is None:
                victims.append((tab_id, dict(meta), False))
                continue
            if meta.get("protect"):
                continue
            try:
                idle = now - float(meta.get("touched",
                                            meta.get("created", now)))
            except (TypeError, ValueError):
                idle = 0.0
            if idle < max_idle_seconds:
                continue
            url = (tab.get("url") or "")
            if url not in ("", "about:blank") \
                    and not url.startswith("chrome-error://"):
                continue
            # LANE2-D15b: re-read the entry's current metadata under a
            # brief lock before closing. A concurrent set_tab_protected
            # (or an unregister) vetoes the close: protection is a safety
            # property, and the snapshot may predate it. No CDP call runs
            # while this lock is held.
            with _tab_registry_locked(self.profile_dir):
                fresh = _read_tab_registry_data(
                    self.profile_dir).get(tab_id)
            if fresh is None or fresh.get("protect"):
                continue
            try:
                self.cdp.close_tab({"id": tab_id})
            except Exception:
                continue
            victims.append((tab_id, dict(meta), True))
        if not victims:
            return []
        reaped = []
        retained = []
        pruned = []
        with _tab_registry_locked(self.profile_dir):
            reg = _read_tab_registry_data(self.profile_dir)
            changed = False
            for tab_id, meta, was_closed in victims:
                cur = reg.get(tab_id)
                if cur is None:
                    # No entry: close_tab unregistered it on the way
                    # out, or a concurrent unregister did. Either way
                    # the registry is clean; a closed tab with no
                    # entry is fully reaped, a missing one pruned.
                    if was_closed:
                        reaped.append(tab_id)
                    else:
                        pruned.append(tab_id)
                    continue
                # Conditional writeback: remove only when the entry is
                # unchanged since the snapshot. A concurrent
                # register/touch changed the metadata; their update
                # survives (a closed tab with a fresh entry is pruned on
                # the next pass, when it is no longer live).
                if cur == meta:
                    del reg[tab_id]
                    changed = True
                    if was_closed:
                        reaped.append(tab_id)
                    else:
                        pruned.append(tab_id)
                elif was_closed:
                    # Closed, but a concurrent update refreshed the entry:
                    # never report it as reaped.
                    retained.append(tab_id)
                # else: a missing-live tab with a concurrently refreshed
                # entry is left alone; a later pass prunes it once quiet.
            if changed:
                _write_tab_registry_data(self.profile_dir, reg)
        if reaped:
            print("[chromium] reaped %d idle tab(s): %s"
                  % (len(reaped), ",".join(reaped)), flush=True)
        if retained:
            print("[chromium] closed %d tab(s) but kept their registry "
                  "entries after concurrent updates: %s"
                  % (len(retained), ",".join(retained)), flush=True)
        if pruned:
            print("[chromium] pruned %d stale registry entr(ies): %s"
                  % (len(pruned), ",".join(pruned)), flush=True)
        return reaped

    def owned_main_pids(self):
        """Chromium main-process PIDs for EXACTLY this identity
        (profile dir + --remote-debugging-pipe). A foreign browser is
        never returned."""
        return find_chromium_pids(self.profile_dir)

    def subtree_pids(self):
        """This browser's whole process tree (main + descendants)."""
        return subtree_pids_for(self.owned_main_pids())

    def memory_rss_bytes(self):
        """Total RSS of this browser's process tree in bytes."""
        return subtree_rss_bytes(self.subtree_pids())

    def browser_age_seconds(self):
        """Age of the oldest owned main process; None when unknowable."""
        ages = [process_age_seconds(p) for p in self.owned_main_pids()]
        ages = [a for a in ages if a is not None]
        return max(ages) if ages else None

    # W3-P2-16: there is deliberately NO restart_owned_browser method.
    # Browser restarts in production are owned by exactly one path:
    # helper/keepalive.sh's recover_helper (memory-policy verdict 3,
    # dead Chromium, version skew), whose ownership gates (tree-gated
    # server kill, exact-profile Chromium reap, post-relaunch
    # foreign-browser check) are the ones that actually run. A
    # launcher-level restart was production-dead code (only the
    # selftest called it) and is removed rather than presented as the
    # ownership story. To restart this launcher's browser, call
    # launcher.stop() then launcher.start() directly.


# ---------------------------------------------------------------------------
# Canvas API transport over the authenticated tab
# ---------------------------------------------------------------------------

# JS template: session-authenticated API call. Cookies ride automatically
# (same-origin fetch from a Canvas tab). The CSRF token is harvested fresh
# from the _csrf_token cookie in page context, per call (P0-3): the
# csrf-token meta tag and authenticity_token inputs are never used.
# W4-CSRF: when the cookie is absent the write is refused in page context
# (csrf_missing flag) before any network call, instead of going out
# headerless and failing as a misleading provider 422.
# The token is used entirely inside page context: it is never returned to
# Python. P0-6: no retry on 422; an ordinary 4xx is a provider refusal and
# the write fails fast rather than being replayed.
_API_JS = r"""(async () => {
  const method = %s, path = %s, data = %s, asJson = %s, maxBytes = %s;
  const harvest = () => {
    const m = document.cookie.match(/(?:^|;\s*)_csrf_token=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : null;
  };
  const headers = {'Accept': 'application/json',
                   'X-Requested-With': 'XMLHttpRequest'};
  // One pair per list item (include[]=a&include[]=b): URLSearchParams
  // would join an array into one comma-separated value.
  const encode = (d) => {
    const qs = new URLSearchParams();
    for (const [k, v] of (Array.isArray(d) ? d : Object.entries(d))) {
      for (const x of (Array.isArray(v) ? v : [v])) {
        if (x !== null && x !== undefined) qs.append(k, x);
      }
    }
    return qs.toString();
  };
  let url = path, body = null;
  if (data && (method === 'GET' || method === 'DELETE')) {
    const qs = encode(data);
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  } else if (data) {
    if (asJson) {
      body = JSON.stringify(data);
      headers['Content-Type'] = 'application/json';
    } else {
      body = encode(data);
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  }
  const needsCsrf = method !== 'GET';
  const attempt = async () => {
    if (needsCsrf && !harvest()) {
      // W4-CSRF: fail closed before any network call. A missing
      // _csrf_token cookie means the page context cannot build a valid
      // write; sending it headerless would produce a misleading
      // provider 422 instead of naming the real cause. The token value
      // itself never crosses back: only this boolean flag does.
      return {status: 0, url: '', body: '', link: null, retryAfter: null,
              truncated: false, redirected: false, csrf_missing: true};
    }
    const h = Object.assign({}, headers);
    if (needsCsrf) {
      const t = harvest();
      if (t) h['X-CSRF-Token'] = t;
    }
    const r = await fetch(url, {method, headers: h, body,
                                credentials: 'same-origin',
                                redirect: 'manual'});
    // P1-23: redirects are surfaced, never silently followed. A dead
    // Canvas session 302-redirects API calls to /login; following the
    // redirect would hand api() a 200 login page as a fake success.
    // With redirect:'manual' the response type is 'opaqueredirect'
    // (status 0); either signal marks the call redirected.
    if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) {
      return {status: 0, url: '', body: '', redirected: true};
    }
    // W2-P2-8: stream the body through a reader, stopping at
    // maxBytes+1 BYTES. r.text() would hold the entire body first;
    // the reader caps memory before the body crosses the CDP
    // boundary. Byte counts use Uint8Array lengths, not JS string
    // length (UTF-16 code units), and the cut lands on a byte
    // boundary, never inside a character.
    // W2-P1-6: the Link response header is captured so the Python side
    // can follow Canvas pagination. W2-P2-7: Retry-After is captured
    // so 429 backoff honors the provider's ask.
    const limit = (maxBytes !== null) ? maxBytes : Infinity;
    let bytes = 0;
    const chunks = [];
    let truncated = false;
    let link = null;
    let retryAfter = null;
    let contentType = null;
    try { link = r.headers.get('link'); } catch (e) { link = null; }
    try { retryAfter = r.headers.get('retry-after'); } catch (e) { retryAfter = null; }
    try { contentType = r.headers.get('content-type'); } catch (e) { contentType = null; }
    const reader = r.body ? r.body.getReader() : null;
    if (reader) {
      try {
        for (;;) {
          const rd = await reader.read();
          if (rd.done) break;
          // Take up to limit+1 bytes: the +1 proves truncation.
          const room = limit - bytes + 1;
          const take = Math.min(rd.value.byteLength, Math.max(room, 0));
          if (take > 0) {
            chunks.push(rd.value.slice(0, take));
            bytes += take;
          }
          if (bytes > limit || take < rd.value.byteLength) {
            truncated = true;
            break;
          }
        }
      } finally {
        try { await reader.cancel(); } catch (e) {}
      }
    }
    let text = "";
    if (chunks.length > 0) {
      const total = new Uint8Array(bytes);
      let off = 0;
      for (const c of chunks) { total.set(c, off); off += c.byteLength; }
      const bodyBytes = (truncated && limit !== Infinity)
        ? total.slice(0, limit) : total;
      text = new TextDecoder("utf-8", {fatal: false}).decode(bodyBytes);
    }
    return {status: r.status, url: r.url, body: text, link: link,
            retryAfter: retryAfter, contentType: contentType,
            truncated: truncated, redirected: false};
  };
  let res = await attempt();
  return JSON.stringify(res);
})()"""


class LocalChromiumTransport:
    """Canvas REST over a local Chromium's authenticated tab via CDP.

    Usage:
        t = LocalChromiumTransport(base_url, launcher)
        t.ensure_session()          # raises SessionDead if login required
        status, body = t.api("GET", "/api/v1/users/self")
        status, body = t.api("POST", "/api/v1/courses/123/assignments",
                             {"assignment[name]": "X"})
    """

    def __init__(self, base_url, launcher):
        self.base = base_url.rstrip("/")
        self.launcher = launcher
        self.cdp = launcher.cdp
        # W2-P2-9: guards the tenant-tab find-or-create so two threads
        # racing a cold start create exactly one tenant tab.
        self._tab_lock = threading.Lock()
        # W4-P1-12: tab id -> isolated-world executionContextId for API
        # probes. Recreated when the context dies (see api()).
        self._api_worlds = {}

    def _new_api_world(self, tab):
        """Create the API probe's isolated world in the tab; cache and
        return its executionContextId. Fail closed: without a trusted
        world there is no API call."""
        try:
            context_id = self.cdp.create_isolated_world(
                tab, "morrow_api_probe")
        except Exception as exc:
            raise RuntimeError(
                "could not create the API probe's isolated world: %s"
                % exc)
        tab_id = (tab or {}).get("id")
        if tab_id:
            self._api_worlds[tab_id] = context_id
        return context_id

    # -- tab management ----------------------------------------------------

    def _tenant_tab(self, fresh=False):
        """Tab dict of a page tab on the tenant origin.

        W2-P2-9: the find-or-create runs under one lock. The check
        (scan existing tabs) and the create (open + navigate a new tab)
        are a single critical section, so two threads racing a cold
        start cannot both decide "no tenant tab" and open duplicates.
        """
        with self._tab_lock:
            return self._tenant_tab_locked(fresh=fresh)

    def _tenant_tab_locked(self, fresh=False):
        """_tenant_tab body; call only with _tab_lock held."""
        if not fresh:
            for t in self.cdp.tabs():
                # W2-P0-8: exact-origin match, never a prefix match: a
                # sibling host (tenant.instructure.com.evil.com) must
                # never be picked as the tenant's authenticated tab.
                if t.get("type") == "page" and \
                   is_tenant_url(t.get("url", ""), self.base):
                    return t
        # No tenant tab yet: open a blank tab and navigate explicitly.
        # (new_tab(url) does not reliably navigate; and the tab-list URL
        # reports the requested URL even when the document never loaded, so
        # settle is verified against location.href in page context instead.)
        tab = self.cdp.new_tab("about:blank")
        try:
            self.cdp.navigate(tab, self.base + "/")
        except Exception:
            pass
        # Wait for the document to actually land on the tenant origin before
        # any evaluate: evaluating mid-navigation raises "Inspected target
        # navigated or closed" at the CDP layer, and a chrome-error document
        # cannot parse relative URLs.
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            try:
                href = self.cdp.evaluate(
                    tab, "location.href", await_promise=False, timeout=15)
            except Exception:
                href = ""
            if isinstance(href, str) and is_tenant_url(href, self.base):
                return tab
            time.sleep(1)
        return tab

    # -- session -----------------------------------------------------------

    def ensure_session(self):
        """Verify the browser holds a live Canvas session.

        Raises SessionDead when the tab lands on a login page.
        """
        try:
            return self._probe_once(fresh=False)
        except RuntimeError as exc:
            msg = str(exc)
            if "navigated or closed" not in msg and "page JS exception" not in msg:
                raise
        # Transient CDP race (the new tab was still committing navigation
        # when the probe evaluated). Retry once on a fresh, settled tab; a
        # second failure is genuine and propagates. The probe is a read-only
        # GET, so the retry creates nothing.
        return self._probe_once(fresh=True)

    def _probe_once(self, fresh):
        tab = self._tenant_tab(fresh=fresh)
        status, _headers, body = self.api("GET", "/api/v1/users/self",
                                          _tab=tab)
        if status == 200:
            try:
                me = json.loads(body)
                return me.get("id"), me.get("name")
            except Exception:
                pass
        # Anything else (401/302-to-login/HTML) means no usable session.
        raise SessionDead(
            f"no live Canvas session in the local browser "
            f"(GET users/self -> {status})")

    # -- API ----------------------------------------------------------------

    def api(self, method, path, data=None, _tab=None, timeout=60,
            as_json=False, max_bytes=None):
        """One Canvas API call in page context.

        Returns (status, headers, body_text). headers carries the
        response's Link header (for Canvas pagination, W2-P1-6), the
        Retry-After header when present (W2-P2-7), and an
        x-morrow-truncated flag when max_bytes cut the body (W2-P2-8:
        the page truncates before the body crosses into Python memory,
        so Python never holds more than max_bytes of any one response).

        `data` is a dict of form fields (a list value is one pair per
        item, include[]=a&include[]=b) or a list of [key, value] pairs, in
        order. GET/DELETE encode it into the query string; POST/PUT
        form-encode the body with the CSRF header, unless as_json is true,
        in which case the body goes as application/json (for
        executor-built JSON bodies, which may nest).
        The CSRF token is harvested inside page-context JS and never enters
        Python memory; only (status, url, body) come back.

        W4-P1-12: the fetch program runs in a dedicated isolated world
        (Page.createIsolatedWorld, "morrow_api_probe"), created after the
        tab settled on the tenant origin - never the page's default
        realm. A page that replaces window.fetch cannot forge the
        result. The world is cached per tab and recreated when its
        execution context dies (navigation). A read retries once with a
        fresh world; a change retries only when its world was gone before
        the program ran, and otherwise raises ApiCallMaybeSent.
        """
        tab = _tab or self._tenant_tab()
        tab_id = (tab or {}).get("id")
        context_id = self._api_worlds.get(tab_id)
        if context_id is None:
            context_id = self._new_api_world(tab)
        url = path  # same-origin relative path keeps cookies first-party
        js = _API_JS % (json.dumps(method.upper()), json.dumps(url),
                        json.dumps(data or None), json.dumps(bool(as_json)),
                        json.dumps(max_bytes))
        try:
            raw = self.cdp.evaluate(tab, js, await_promise=True,
                                    timeout=timeout, context_id=context_id)
        except (RuntimeError, CDPError) as exc:
            text = str(exc)
            if "context" not in text.lower() \
                    and "navigated or closed" not in text:
                raise
            # The world's execution context died (navigation, crash).
            self._api_worlds.pop(tab_id, None)
            # A world that was already gone refused the program before it
            # ran. Any other context loss can land after the fetch left
            # the browser, so only a read runs again.
            if method.upper() != "GET" and _STALE_WORLD not in text:
                raise ApiCallMaybeSent(
                    "%s %s: the tab navigated or closed while the request "
                    "was in flight (%s); Canvas may have received it, so "
                    "it is not sent again" % (method.upper(), url, text))
            context_id = self._new_api_world(tab)
            raw = self.cdp.evaluate(tab, js, await_promise=True,
                                    timeout=timeout, context_id=context_id)
        resp = json.loads(raw)
        # W4-CSRF: fail closed with the real cause. The page context
        # refused to send the write because no _csrf_token could be
        # harvested from the live document.cookie; surfacing this as a
        # provider 422 would misdiagnose it.
        if resp.get("csrf_missing"):
            raise CsrfTokenMissing(
                "refusing %s %s: no _csrf_token in the live "
                "document.cookie, so no CSRF header could be built; the "
                "write was not sent (check the helper session, not the "
                "provider)" % (method.upper(), url))
        # P1-23: a redirect (or a login page served with 200) means the
        # Canvas session is dead. Raise the existing SessionDead so the
        # caller takes the re-auth path instead of treating the login
        # page as a successful API response.
        if resp.get("redirected") or 300 <= resp.get("status", 0) < 400:
            raise SessionDead(
                "Canvas redirected the API call to a login page; the "
                "browser session is dead (sign in again through the "
                "login helper).")
        if _is_sign_in_path(resp.get("url")):
            raise SessionDead(
                "Canvas served a login page for the API call; the "
                "browser session is dead (sign in again through the "
                "login helper).")
        # W2-P0-10: a login page served with HTTP 200 (no redirect, no
        # /login in the final URL) is a dead session too. Detect
        # login-page markers in the body and raise loudly instead of
        # returning the HTML as if it were valid API data.
        if _looks_like_login_page(resp.get("body"),
                                  resp.get("contentType")):
            raise SessionDead(
                "Canvas served a login page (HTTP %s) for the API call; "
                "the browser session is dead (sign in again through the "
                "login helper)." % (resp.get("status"),))
        if resp.get("status") == 401 and _is_unauthenticated(resp.get("body")):
            raise SessionRejected(
                "Canvas answered HTTP 401 unauthenticated for the API "
                "call; the browser session expired or was revoked (sign "
                "in again through the login helper).")
        headers = {}
        if resp.get("link"):
            headers["link"] = resp["link"]
        if resp.get("retryAfter"):
            headers["retry-after"] = resp["retryAfter"]
        if resp.get("truncated"):
            headers["x-morrow-truncated"] = (
                "body truncated at %s bytes" % max_bytes)
        return resp["status"], headers, resp["body"]


# CDP's answer when Runtime.evaluate names a world that no longer exists:
# the program never started.
_STALE_WORLD = "Cannot find context with specified id"


def _is_sign_in_path(url):
    """True when url is Canvas's own sign-in page (/login or /login/...),
    never a course page whose address merely starts with "login"."""
    path = urllib.parse.urlsplit(str(url or "")).path
    return path == "/login" or path.startswith("/login/")


class ApiCallMaybeSent(RuntimeError):
    """A change's page-context program lost its tab mid-call: the fetch
    may have reached Canvas, so it is never sent again. The caller
    treats it as an uncertain write."""


class SessionDead(RuntimeError):
    """The local browser has no live Canvas session; re-authentication is
    required (educator signs in again through the connector's browser)."""


class SessionRejected(SessionDead):
    """Canvas answered 401 with status "unauthenticated": the session
    expired or was revoked. The provider answered, so the request was
    NOT applied (unlike a session that died mid-call)."""


class CDPError(RuntimeError):
    """CDP misuse: ownerless CDP construction (W4-P2-16), malformed tab
    handles, and other client-side CDP contract violations."""


class CsrfTokenMissing(RuntimeError):
    """LANE2-1: the page context refused to send a write because no
    _csrf_token could be harvested from the live document.cookie. The
    write was NOT sent (no provider call happened), so this must never
    be misdiagnosed as a provider 422. A dedicated class (not a bare
    RuntimeError) so the failure translator and any caller can match it
    by name instead of substring-sniffing the message."""


# W4-P2-17: minimum Chromium version. The isolated-world, download-deny,
# and pipe transports used here require a modern Chromium; anything older
# fails closed at launch.
_MIN_CHROMIUM_VERSION = (152, 0, 7977, 82)
_MIN_CHROMIUM_VERSION_STR = "152.0.7977.82"


def _probe_binary_version(path):
    """Run `<path> --version`; return ((major, minor, build, patch),
    "x.y.z.w"). Raises RuntimeError when the output is not a sane
    Chromium/Google Chrome version line."""
    try:
        proc = subprocess.run(
            [path, "--version"], capture_output=True, text=True, timeout=15)
    except Exception as exc:
        raise RuntimeError(
            "could not probe Chromium version for %r: %s" % (path, exc))
    out = (proc.stdout or "").strip().splitlines()
    text = out[0].strip() if out else ""
    # Distro builds append build notes after the version ("built on
    # Debian GNU/Linux 13 (trixie)", "snap"); the version itself must
    # still be exactly four numeric parts.
    m = re.match(r"^(Chromium|Google Chrome)\s+(\d+)\.(\d+)\.(\d+)\.(\d+)"
                 r"(?:\s+\S.*)?\s*$", text)
    if not m or proc.returncode != 0:
        raise RuntimeError(
            "refusing Chromium binary %r: --version did not report a sane "
            "Chromium/Google Chrome version (got %r)" % (path, text[:80]))
    nums = tuple(int(m.group(i)) for i in range(2, 6))
    return nums, "%d.%d.%d.%d" % nums


def _require_executable_binary(path):
    """W4-P2-17/22: fail fast when the named Chromium binary is not an
    executable file, before any version probing. Returns the normalized
    (realpath) path so logs and identity checks name exactly the file
    that launches. No signature attestation is performed: no signature
    material ships with the binary, so identity rests on the explicit
    path plus the --version probe."""
    if not path or not isinstance(path, str):
        raise RuntimeError(
            "refusing Chromium binary %r: not a usable path" % (path,))
    if not (os.path.isfile(path) and os.access(path, os.X_OK)):
        raise RuntimeError(
            "refusing Chromium binary %r: not an executable file"
            % (path,))
    return os.path.realpath(path)


def _check_version_floor(path):
    """W4-P2-17: version-gate the binary. Returns the version string;
    raises RuntimeError below the floor."""
    nums, text = _probe_binary_version(path)
    if nums < _MIN_CHROMIUM_VERSION:
        raise RuntimeError(
            "refusing Chromium binary %r: version %s is below the minimum "
            "supported version %s" % (path, text, _MIN_CHROMIUM_VERSION_STR))
    return text


def default_binary():
    """Platform Chromium location, probed at launch and version-gated.

    /opt/meta-chromium/chrome ships in the Muse VM image (Meta-provided,
    boot-reconciled), so the connector does not bundle its own copy. A
    connector-local build under transport/chromium/ or vendor/chromium/
    is honored first if present (dev override; an installed tree
    refuses both). CHROMIUM_BIN, when set in the environment or in this
    tree's helper/env (the order every tree setting uses), wins over
    every probe: it must point at an executable file whose --version
    reports a sane Chromium/Google Chrome version at or above the floor
    (W4-P2-17); a bad value fails fast instead of silently falling
    through to a different browser.

    W4-P2-22: the override is never silent (logged loudly), and the
    resolved path + version are always printed so the operator knows
    exactly what launched. No signature attestation is performed: no
    signature material ships with the binary, so identity rests on the
    explicit path plus the --version probe.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    override = (_tree_setting("CHROMIUM_BIN") or "").strip()
    if override:
        # W4-P2-22: an explicit CHROMIUM_BIN is fail-fast, never silent
        # fall-through. When the operator names a binary, a bad value
        # must not quietly launch a different browser.
        try:
            override = _require_executable_binary(override)
        except RuntimeError as exc:
            raise RuntimeError(
                "CHROMIUM_BIN=%r is unusable (%s); refusing to fall "
                "through to a different browser" % (override, exc))
        try:
            version = _check_version_floor(override)
        except RuntimeError as exc:
            raise RuntimeError(
                "CHROMIUM_BIN=%r failed the version gate (%s); refusing "
                "to fall through to a different browser" % (override, exc))
        print("[chromium] CHROMIUM_BIN override in effect: using %s "
              "(version %s)" % (override, version), flush=True)
        return override
    candidates = [
        (os.path.join(here, "chromium", "chrome"), "connector-local build"),
        (os.path.join(here, "..", "vendor", "chromium", "chrome"),
         "vendor build"),
        ("/opt/meta-chromium/chrome", "platform Chromium"),
    ]
    tried = []
    for path, why in candidates:
        if not (os.path.isfile(path) and os.access(path, os.X_OK)):
            tried.append("%s (%s: not an executable file)" % (path, why))
            continue
        try:
            version = _check_version_floor(path)
        except RuntimeError as exc:
            tried.append("%s (%s: %s)" % (path, why, exc))
            continue
        path = os.path.realpath(path)
        print("[chromium] using Chromium binary %s (version %s)"
              % (path, version), flush=True)
        return path
    raise RuntimeError(
        "no Chromium binary found: every candidate was missing, not "
        "executable, or failed the version gate (minimum %s). Tried: %s; "
        "set CHROMIUM_BIN=<path> in the environment or in this tree's "
        "helper/env (INSTALL.md, Prerequisites)"
        % (_MIN_CHROMIUM_VERSION_STR, "; ".join(tried)))


def default_profile_dir():
    # P2-16: this used to silently return the live helper's profile, which
    # made it a footgun: any dev/test caller got the educator's live
    # session by default. It is retired: callers that genuinely need the
    # unified live profile must say so explicitly via helper_profile_dir().
    # Dev/test code must pass an explicit scratch profile dir.
    raise RuntimeError(
        "default_profile_dir() is retired: pass an explicit profile dir "
        "to ChromiumLauncher (a scratch dir for tests/dev; "
        "helper_profile_dir() for the connector's unified live profile)")


def helper_profile_dir():
    """The connector's unified live profile: the login helper's Chromium
    profile, which holds the educator's authenticated Canvas session.

    It is this tree's helper profile (tree_helper_profile_dir: the
    LOGIN_HELPER_PROFILE_DIR the helper runs with, else
    <tree>/helper/profile, the directory install.sh creates), so the
    executor's self-launch fallback and the provision launch driver ride
    the same single profile as the helper for any install user.

    Explicit by name, never a silent default: default_profile_dir() raises
    so nothing can open the live session by accident.
    """
    return tree_helper_profile_dir()
