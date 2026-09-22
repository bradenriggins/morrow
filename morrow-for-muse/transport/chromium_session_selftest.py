#!/usr/bin/env python3
"""Selftest: --backend chromium wiring (transport/chromium_session.py).

Covers the Phase 0 Worker A deliverable offline, with a mocked CDP layer
(a fake transport is injected; no Chromium is launched, no Canvas touched):

  1. Module surface: ChromiumSessionDead is an ExecutorError; the session
     exposes base_for / slot_secret / raw_request like SessionStore.
  2. Laziness: load() never builds a launcher or transport.
  3. Base URL resolution: explicit arg > CANVAS_BASE env > lane state;
     fails closed (SessionMissing) when none is configured; the
     resolved tenant is bound to the lane state's signed-in tenant
     (W4-P1-14/W4-P2-27: disagreement is refused as
     TenantBindingMismatch naming both tenants).
  4. slot_secret always raises SessionMissing; browser_owned_auth is set;
     build_headers skips credential injection for the chromium session.
  5. raw_request body decoding: JSON bytes -> (dict, as_json=True);
     form-encoded -> (flat dict, as_json=False); None -> (None, False);
     non-JSON bytes fail closed.
  6. Retry discipline parity with request_with_retry: read retries on
     503 then succeeds; write 500 -> UncertainWrite; write transport error
     retries once then succeeds; write timeout -> UncertainWrite;
     422 fails fast as ProviderHttpError; SessionDead (at ensure or mid-op)
     maps to ChromiumSessionDead.
  7. Cross-origin URLs are refused.
  8. dispatch_entry runs end to end on a ChromiumSession with a fake
     transport (same governance: admission, journaling, receipt).
  9. SessionStore.raw_request still delegates to request_with_retry
     (https path byte-identical); the executor CLI accepts
     --backend chromium.
  10. Item Banks SDK lane routing (transport/item_bank_sdk.py).
  11. W4-P2-1: the first SessionDead on a session object imposes the
      write halt, quarantines the session, and notifies via the
      re-auth state machine (stubbed here), exactly once per death; a
      healthy session never touches the machine. W4-P2-2 (sticky
      regression): after the death, further writes fail fast as
      ChromiumSessionDead with no provider call and no second
      UncertainWrite. W4-P2-4: classify_auth_death taxonomy
      (no_live_session vs session_ended; expiry/password-change/
      admin-revocation named as candidates with per-cause remedies).
      W4-P2-3: the near-expiry warning fires once per session object
      when the helper reports a horizon within ~24h, and never on a
      far horizon or a helper failure.

No network, no Chromium, no session. Fakes only.
"""
import os as _home_os, sys as _home_sys  # noqa: E401
_home_sys.path.insert(0, _home_os.path.join(
    _home_os.path.dirname(_home_os.path.abspath(__file__)), '..'))
import config.selftest_home  # noqa: E402,F401  (scratch HOME/MORROW_HOME)
import io
import json
import os
import sys
import types
from contextlib import redirect_stderr, redirect_stdout

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (REPO, os.path.join(REPO, "dispatch"), os.path.join(REPO, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from dispatch import executor as ex  # noqa: E402
# The fixtures use literal ids and synthetic paths that are not catalog
# path templates; the live-proven catalog gate is covered by
# dispatch/test_direct_lane_hardening.py and is a no-op here.
ex.live_proven_gate = lambda *a, **k: None  # noqa: E731
import chromium_session as cs  # noqa: E402
# The signed-in account check (final muse audit M3) reads users/self
# before writes; these fakes script every provider call, so it is a
# no-op here. It is covered by transport/test_principal_check.py.
cs.ChromiumSession._verify_principal = lambda *a, **k: None  # noqa: E731

import local_chromium as lc  # noqa: E402

PASS = []
FAIL = []
SKIP = []


def _skip_crypto_section(names):
    """Loud skip for checks that need the optional `cryptography` package.

    requirements-optional.txt promises every selftest passes without it;
    the learner-vault projection these sections exercise fail-closes
    without it, so the checks skip loudly instead of failing.
    """
    for _n in names:
        SKIP.append(_n)
        print("SKIP %s (cryptography not installed: the learner-vault "
              "projection this check exercises cannot run)" % _n)


try:
    import cryptography  # noqa: F401
    _CRYPTO_AVAILABLE = True
except ImportError:
    _CRYPTO_AVAILABLE = False


def _reset_journal(journal_path):
    """Remove a selftest journal and its sidecar index/lock/secret.

    The executor keeps ops.idx.json, ops.lock, and ops.secret next to
    the journal under fixed names. Removing only the .jsonl leaves a
    stale index behind, and the next run in the same tree trips
    DuplicateOpId on the same op ids; leaving a stale secret behind
    trips the W4-P0-1 missing-journal tripwire (a secret with no journal
    means the journal was deleted). (The carve and install.sh remove
    .selftest-work wholesale; this only matters for repeat runs in one
    tree.)
    """
    _d = os.path.dirname(journal_path)
    for _p in (journal_path,
               os.path.join(_d, "ops.idx.json"),
               os.path.join(_d, "ops.lock"),
               os.path.join(_d, "ops.secret")):
        try:
            os.remove(_p)
        except OSError:
            pass


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(
        "%s%s" % (name, (" (%s)" % detail) if detail and not cond else ""))


BASE = "https://canvas.example.edu"

# W4-P1-14/W4-P2-27: the tenant binding gate compares the session tenant
# against the lane state's signed-in tenant. Stub the lane state to the
# fake tenant for the whole file so every load()/dispatch stays
# self-consistent (section 3 manages its own stubbing on top of this).
class _SelftestStateMod:
    @staticmethod
    def load():
        return {"canvas": {"base": BASE}}


sys.modules["state"] = _SelftestStateMod

# Speed up: no real backoff sleeps in retry tests.
_ex_backoff = ex._backoff_sleep
ex._backoff_sleep = lambda attempt: None  # noqa: E731

# W4-P2-1: stub the re-auth state machine so the session-death wiring
# under test records its calls instead of touching the real ~/.morrow.
# Installed before any test that can raise SessionDead; the real
# reauth.state_machine is never imported in this process. It also
# answers the executor's lazy re-auth gate reads (_check_write_gates
# consults the machine for every dispatch), hermetically.
class _FakeRsm:
    def __init__(self):
        self.calls = []

    def impose_halt(self, detection, reason="session_expiry"):
        self.calls.append(("impose_halt", detection, reason))

    def quarantine_session(self, cause, detection=None):
        self.calls.append(("quarantine_session", cause, detection))

    def write_notify_expired(self, n):
        self.calls.append(("write_notify_expired", n))

    def quarantined_ops(self):
        return []

    # Executor gate reads (hermetic answers; the real machine is the
    # session_lifecycle_selftest's subject, not this file's).
    def check_write_allowed(self):
        return True, "no write halt (selftest stub)"

    def op_quarantine_status(self, op_id):
        return None

    def on_expiry_detected(self, detection, simulated=False):
        self.calls.append(("on_expiry_detected", detection, simulated))

    def quarantine_op(self, op_id, action, summary="", detection=None):
        self.calls.append(("quarantine_op", op_id, action))

    def write_notify_stale(self, n):
        self.calls.append(("write_notify_stale", n))


_fake_rsm = _FakeRsm()
_fake_rsm_mod = types.SimpleNamespace(
    impose_halt=_fake_rsm.impose_halt,
    quarantine_session=_fake_rsm.quarantine_session,
    write_notify_expired=_fake_rsm.write_notify_expired,
    quarantined_ops=_fake_rsm.quarantined_ops,
    check_write_allowed=_fake_rsm.check_write_allowed,
    op_quarantine_status=_fake_rsm.op_quarantine_status,
    on_expiry_detected=_fake_rsm.on_expiry_detected,
    quarantine_op=_fake_rsm.quarantine_op,
    write_notify_stale=_fake_rsm.write_notify_stale)
sys.modules["reauth"] = types.SimpleNamespace(
    state_machine=_fake_rsm_mod)
sys.modules["reauth.state_machine"] = _fake_rsm_mod


# ----------------------------------------------------------------------
# fakes
# ----------------------------------------------------------------------

class FakeTransport:
    """Scripted stand-in for LocalChromiumTransport (the CDP layer)."""

    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def ensure_session(self):
        return (1, "Test User")

    def api(self, method, path, data=None, _ws=None, timeout=60,
            as_json=False, max_bytes=None):
        self.calls.append({"method": method, "path": path, "data": data,
                           "as_json": as_json})
        if not self.script:
            return 200, {}, "{}"
        kind = self.script.pop(0)
        if kind[0] == "raise":
            raise kind[1]
        return kind[1], {}, kind[2]


class FakeLauncher:
    def __init__(self):
        self.started = False

    def start(self):
        self.started = True


# ----------------------------------------------------------------------
# 1. module surface
# ----------------------------------------------------------------------
check("ChromiumSessionDead is an ExecutorError",
      issubclass(cs.ChromiumSessionDead, ex.ExecutorError))
for meth in ("base_for", "slot_secret", "raw_request"):
    check("ChromiumSession exposes %s" % meth,
          callable(getattr(cs.ChromiumSession, meth, None)))

# ----------------------------------------------------------------------
# 2. laziness
# ----------------------------------------------------------------------
sess = cs.ChromiumSession.load(base_url=BASE)
check("load() resolves the explicit base", sess.base_for("canvas") == BASE)
check("load() builds no launcher (lazy)", sess._launcher is None)
check("load() builds no transport (lazy)", sess._transport is None)
check("browser_owned_auth marker set", sess.browser_owned_auth is True)
try:
    sess.base_for("moodle")
    check("base_for(moodle) raises SessionMissing", False, "no exception")
except ex.SessionMissing:
    check("base_for(moodle) raises SessionMissing", True)
try:
    sess.slot_secret("canvas_pat")
    check("slot_secret raises SessionMissing", False, "no exception")
except ex.SessionMissing as exc:
    check("slot_secret raises SessionMissing", True)
    check("slot_secret message names no material",
          "PAT" not in str(exc) and "cookie" not in str(exc).lower()
          or "owns" in str(exc))

# ----------------------------------------------------------------------
# 3. base URL resolution precedence
# ----------------------------------------------------------------------
class _FakeStateMod:
    @staticmethod
    def load():
        return {"canvas": {"base": "https://lane.example.edu"}}


def _refused_tenant_binding(fn):
    try:
        fn()
    except ex.TenantBindingMismatch as exc:
        return str(exc)
    return None


_saved_state = sys.modules.get("state")
_saved_env = os.environ.get("CANVAS_BASE")
try:
    sys.modules["state"] = _FakeStateMod
    if "CANVAS_BASE" in os.environ:
        del os.environ["CANVAS_BASE"]
    check("lane state is the fallback",
          cs.ChromiumSession.load().base_for("canvas")
          == "https://lane.example.edu")
    # W4-P1-14/W4-P2-27: a resolved tenant that disagrees with the lane
    # state's signed-in tenant is refused loudly, naming both tenants;
    # the old "higher-precedence source wins silently" behavior is gone.
    os.environ["CANVAS_BASE"] = "https://env.example.edu"
    detail = _refused_tenant_binding(cs.ChromiumSession.load)
    check("CANVAS_BASE disagreeing with lane state is refused",
          detail is not None
          and "https://env.example.edu" in detail
          and "https://lane.example.edu" in detail, repr(detail))
    detail = _refused_tenant_binding(
        lambda: cs.ChromiumSession.load(base_url="https://arg.example.edu"))
    check("explicit arg disagreeing with lane state is refused",
          detail is not None
          and "https://arg.example.edu" in detail
          and "https://lane.example.edu" in detail, repr(detail))
    # Agreement still loads: same tenant from a higher-precedence source
    # (normalization-tolerant: case and trailing slash).
    os.environ["CANVAS_BASE"] = "HTTPS://LANE.EXAMPLE.EDU/"
    check("CANVAS_BASE agreeing with lane state loads",
          cs.ChromiumSession.load().base_for("canvas")
          == "HTTPS://LANE.EXAMPLE.EDU")
    check("explicit arg agreeing with lane state loads",
          cs.ChromiumSession.load(
              base_url="https://lane.example.edu/").base_for("canvas")
          == "https://lane.example.edu")

    class _EmptyStateMod:
        @staticmethod
        def load():
            return None

    sys.modules["state"] = _EmptyStateMod
    del os.environ["CANVAS_BASE"]
    try:
        cs.ChromiumSession.load()
        check("no base anywhere raises SessionMissing", False,
              "no exception")
    except ex.SessionMissing:
        check("no base anywhere raises SessionMissing", True)
    # No lane state: nothing to bind against, the check cannot run and
    # does not block.
    os.environ["CANVAS_BASE"] = "https://env.example.edu"
    check("no lane state: explicit tenant loads unbound",
          cs.ChromiumSession.load(
              base_url="https://env.example.edu").base_for("canvas")
          == "https://env.example.edu")
finally:
    if _saved_state is not None:
        sys.modules["state"] = _saved_state
    else:
        sys.modules.pop("state", None)
    if _saved_env is not None:
        os.environ["CANVAS_BASE"] = _saved_env
    elif "CANVAS_BASE" in os.environ:
        del os.environ["CANVAS_BASE"]

# ----------------------------------------------------------------------
# 4. build_headers skips credential injection for the chromium session
# ----------------------------------------------------------------------
pack = {"credential_slots": {
    "canvas_pat": {"inject": {"header": "Authorization",
                              "scheme": "Bearer"}}}}
entry = ex.catalog_descriptor_to_entry(
    "cs_hdr", "GET", "/api/v1/users/self", "read", provider="canvas")
headers = ex.build_headers(entry, entry["request"]["headers"], sess, {}, {},
                           pack, False)
check("chromium session: no Authorization header injected",
      "Authorization" not in headers, repr(headers))

https_sess = ex.SessionStore(
    {"canvas": {"base": BASE, "pat": "faketoken"}})
headers2 = ex.build_headers(entry, entry["request"]["headers"], https_sess,
                            {}, {}, pack, False)
check("https session: Authorization header still injected",
      headers2.get("Authorization") == "Bearer faketoken", repr(headers2))

# ----------------------------------------------------------------------
# 5. body decoding
# ----------------------------------------------------------------------
t = FakeTransport([("ok", 200, '{"id": 1}')])
s = cs.ChromiumSession(BASE, transport=t)
status, resp_headers, raw, attempts = s.raw_request(
    "POST", BASE + "/api/v1/courses/9/assignments", {},
    json.dumps({"assignment": {"name": "X", "published": False}}).encode(),
    is_write=False)
check("JSON body decodes to dict with as_json=True",
      t.calls[0]["data"] == {"assignment": {"name": "X",
                                            "published": False}}
      and t.calls[0]["as_json"] is True, repr(t.calls[0]))
check("raw_request returns attempts", attempts == 1)
check("raw_request returns bytes body", raw == b'{"id": 1}')
check("resp headers declare JSON",
      resp_headers.get("Content-Type") == "application/json")

t = FakeTransport([("ok", 200, "{}")])
s = cs.ChromiumSession(BASE, transport=t)
s.raw_request("POST", BASE + "/api/v1/x",
              {"Content-Type": "application/x-www-form-urlencoded"},
              b"a=1&b=two", is_write=False)
check("form body decodes to flat dict, as_json=False",
      t.calls[0]["data"] == {"a": "1", "b": "two"}
      and t.calls[0]["as_json"] is False, repr(t.calls[0]))

t = FakeTransport([("ok", 200, "{}")])
s = cs.ChromiumSession(BASE, transport=t)
s.raw_request("GET", BASE + "/api/v1/users/self", {}, None,
              is_write=False)
check("None body -> data None",
      t.calls[0]["data"] is None and t.calls[0]["as_json"] is False)
check("GET path keeps the query string",
      t.calls[0]["path"] == "/api/v1/users/self")

t = FakeTransport([("ok", 200, "{}")])
s = cs.ChromiumSession(BASE, transport=t)
try:
    s.raw_request("POST", BASE + "/api/v1/x", {}, b"\x00\x01binary",
                  is_write=False)
    check("non-JSON body fails closed", False, "no exception")
except ex.ExecutorError:
    check("non-JSON body fails closed", True)

# ----------------------------------------------------------------------
# 6. retry discipline
# ----------------------------------------------------------------------
t = FakeTransport([("ok", 503, "x"), ("ok", 503, "x"), ("ok", 200, "{}")])
s = cs.ChromiumSession(BASE, transport=t)
status, _, _, attempts = s.raw_request("GET", BASE + "/api/v1/x", {}, None,
                                       is_write=False)
check("read retries on 503 then succeeds",
      status == 200 and attempts == 3, "status=%s attempts=%s"
      % (status, attempts))

t = FakeTransport([("ok", 503, "x")] * 4)
s = cs.ChromiumSession(BASE, transport=t)
try:
    s.raw_request("GET", BASE + "/api/v1/x", {}, None, is_write=False)
    check("read 503 x4 raises ProviderHttpError", False, "no exception")
except ex.ProviderHttpError as exc:
    check("read 503 x4 raises ProviderHttpError", exc.status == 503)

t = FakeTransport([("ok", 500, "boom")])
s = cs.ChromiumSession(BASE, transport=t)
try:
    s.raw_request("POST", BASE + "/api/v1/x", {},
                  json.dumps({"a": 1}).encode(), is_write=True)
    check("write 500 raises UncertainWrite", False, "no exception")
except ex.UncertainWrite:
    check("write 500 raises UncertainWrite", True)
check("write 500 not retried", len(t.calls) == 1)

t = FakeTransport([("raise", ConnectionRefusedError("refused")),
                   ("ok", 200, "{}")])
s = cs.ChromiumSession(BASE, transport=t)
status, _, _, attempts = s.raw_request(
    "POST", BASE + "/api/v1/x", {}, json.dumps({"a": 1}).encode(),
    is_write=True)
check("write refused-connection retries once then succeeds",
      status == 200 and attempts == 2)

# W2-P0-1 doctrine: a reset AFTER the server applied the write is
# indistinguishable from one before it, so reset/broken-pipe
# ConnectionErrors are NEVER safe to retry for writes.
t = FakeTransport([("raise", ConnectionError("reset")),
                   ("ok", 200, "{}")])
s = cs.ChromiumSession(BASE, transport=t)
try:
    s.raw_request("POST", BASE + "/api/v1/x", {},
                  json.dumps({"a": 1}).encode(), is_write=True)
    check("write reset raises UncertainWrite", False, "no exception")
except ex.UncertainWrite:
    check("write reset raises UncertainWrite", True)
check("write reset not retried", len(t.calls) == 1)

t = FakeTransport([("raise", TimeoutError("timed out"))])
s = cs.ChromiumSession(BASE, transport=t)
try:
    s.raw_request("POST", BASE + "/api/v1/x", {},
                  json.dumps({"a": 1}).encode(), is_write=True)
    check("write timeout raises UncertainWrite", False, "no exception")
except ex.UncertainWrite:
    check("write timeout raises UncertainWrite", True)

# LANE2-D1 parity: the read retry predicate was inverted ("timed out" not
# in str(exc) retried everything, including deterministic failures). A
# deterministic non-transport read failure is now attempted exactly once;
# a genuinely retryable transport failure still retries.
t = FakeTransport([("raise", ValueError("deterministic programming bug"))])
s = cs.ChromiumSession(BASE, transport=t)
try:
    s.raw_request("GET", BASE + "/api/v1/x", {}, None, is_write=False)
    check("read deterministic failure raises ExecutorError", False,
          "no exception")
except ex.ExecutorError:
    check("read deterministic failure raises ExecutorError", True)
check("read deterministic failure attempted exactly once",
      len(t.calls) == 1, "calls=%d" % len(t.calls))

t = FakeTransport([("raise", ConnectionError("reset by peer")),
                   ("ok", 200, "{}")])
s = cs.ChromiumSession(BASE, transport=t)
status, _, _, attempts = s.raw_request("GET", BASE + "/api/v1/x", {}, None,
                                       is_write=False)
check("read transport failure retries then succeeds",
      status == 200 and attempts == 2 and len(t.calls) == 2,
      "status=%s attempts=%s calls=%d" % (status, attempts, len(t.calls)))

# Same discipline on the Item Banks SDK read path (_sdk_item_request).
class _FakeSdk:
    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def request(self, method, path, data, course_id=None):
        self.calls.append((method, path))
        kind = self.script.pop(0)
        if kind[0] == "raise":
            raise kind[1]
        return kind[1], kind[2]


def _sdk_session(script):
    sdk = _FakeSdk(script)
    sess = cs.ChromiumSession(BASE, transport=FakeTransport([]))
    sess._sdk_course_id = "89585"
    sess._sdk_for_course = lambda cid: sdk  # noqa: E731
    return sess, sdk


s, sdk = _sdk_session([("raise", ValueError("deterministic programming bug"))])
try:
    s._sdk_item_request("GET", "/api/banks/items", None, {}, False)
    check("SDK read deterministic failure raises ExecutorError", False,
          "no exception")
except ex.ExecutorError:
    check("SDK read deterministic failure raises ExecutorError", True)
check("SDK read deterministic failure attempted exactly once",
      len(sdk.calls) == 1, "calls=%d" % len(sdk.calls))

s, sdk = _sdk_session([("raise", ConnectionError("reset by peer")),
                       ("ok", 200, "{}")])
status, _, _, attempts = s._sdk_item_request("GET", "/api/banks/items",
                                            None, {}, False)
check("SDK read transport failure retries then succeeds",
      status == 200 and attempts == 2 and len(sdk.calls) == 2,
      "status=%s attempts=%s calls=%d" % (status, attempts, len(sdk.calls)))

t = FakeTransport([("ok", 422, "nope")])
s = cs.ChromiumSession(BASE, transport=t)
try:
    s.raw_request("POST", BASE + "/api/v1/x", {},
                  json.dumps({"a": 1}).encode(), is_write=True)
    check("write 422 fails fast as ProviderHttpError", False,
          "no exception")
except ex.ProviderHttpError as exc:
    check("write 422 fails fast as ProviderHttpError", exc.status == 422)
check("write 422 not retried", len(t.calls) == 1)

t = FakeTransport([("raise", lc.SessionDead("signed out"))])
s = cs.ChromiumSession(BASE, transport=t)
try:
    s.raw_request("GET", BASE + "/api/v1/x", {}, None, is_write=False)
    check("mid-op SessionDead maps to ChromiumSessionDead", False,
          "no exception")
except cs.ChromiumSessionDead:
    check("mid-op SessionDead maps to ChromiumSessionDead", True)
except ex.ExecutorError as exc:
    check("mid-op SessionDead maps to ChromiumSessionDead", False,
          "wrong type %r" % type(exc).__name__)

# ensure_session raising SessionDead -> ChromiumSessionDead, and the
# launcher is started lazily exactly once for it.
_real_lct = lc.LocalChromiumTransport


class _DeadTransport(FakeTransport):
    def ensure_session(self):
        raise lc.SessionDead("signed out")


def _dead_factory(base_url, launcher):
    return _DeadTransport([])


lc.LocalChromiumTransport = _dead_factory
try:
    launcher = FakeLauncher()
    s = cs.ChromiumSession(BASE, launcher=launcher)
    try:
        s.raw_request("GET", BASE + "/api/v1/x", {}, None, is_write=False)
        check("dead session at ensure maps to ChromiumSessionDead", False,
              "no exception")
    except cs.ChromiumSessionDead:
        check("dead session at ensure maps to ChromiumSessionDead", True)
    check("launcher started lazily on first request", launcher.started)
finally:
    lc.LocalChromiumTransport = _real_lct

# P1-24: a launcher that was started and then found session-dead is
# stopped, so a broken instance is not left behind.
class _StoppingLauncher(FakeLauncher):
    def __init__(self):
        super().__init__()
        self.stopped = False

    def stop(self):
        self.stopped = True


lc.LocalChromiumTransport = _dead_factory
try:
    launcher = _StoppingLauncher()
    s = cs.ChromiumSession(BASE, launcher=launcher)
    try:
        s.raw_request("GET", BASE + "/api/v1/x", {}, None, is_write=False)
        check("SessionDead after start stops the launcher", False,
              "no exception")
    except cs.ChromiumSessionDead:
        check("SessionDead after start stops the launcher", launcher.stopped)
finally:
    lc.LocalChromiumTransport = _real_lct

# P1-24: the defensive getattr means a launcher that defines only start()
# (like the FakeLauncher above) still maps cleanly instead of raising
# AttributeError.
lc.LocalChromiumTransport = _dead_factory
try:
    launcher = FakeLauncher()
    s = cs.ChromiumSession(BASE, launcher=launcher)
    try:
        s.raw_request("GET", BASE + "/api/v1/x", {}, None, is_write=False)
        check("SessionDead with stop-less launcher maps cleanly", False,
              "no exception")
    except cs.ChromiumSessionDead:
        check("SessionDead with stop-less launcher maps cleanly", True)
    except AttributeError as exc:
        check("SessionDead with stop-less launcher maps cleanly", False,
              str(exc))
finally:
    lc.LocalChromiumTransport = _real_lct

# P1-24: a failed launch with the helper endpoint down names the remedy.
class _FailLauncher:
    def start(self):
        raise RuntimeError("no chromium binary")


_real_http_up = cs.ChromiumSession._helper_http_up
cs.ChromiumSession._helper_http_up = lambda self, timeout=3: False  # noqa: E731
try:
    s = cs.ChromiumSession(BASE, launcher=_FailLauncher())
    try:
        s.raw_request("GET", BASE + "/api/v1/x", {}, None, is_write=False)
        check("helper-down diagnostic names keepalive.sh", False,
              "no exception")
    except ex.ExecutorError as exc:
        check("helper-down diagnostic names keepalive.sh",
              "helper/keepalive.sh" in str(exc), str(exc)[:160])
finally:
    cs.ChromiumSession._helper_http_up = _real_http_up

# ----------------------------------------------------------------------
# 7. cross-origin refused
# ----------------------------------------------------------------------
t = FakeTransport([("ok", 200, "{}")])
s = cs.ChromiumSession(BASE, transport=t)
try:
    s.raw_request("GET", "https://evil.example/api", {}, None,
                  is_write=False)
    check("cross-origin URL refused", False, "no exception")
except ex.ExecutorError as exc:
    check("cross-origin URL refused", "tenant origin only" in str(exc))
check("refused request never reached the transport", t.calls == [])

# ----------------------------------------------------------------------
# 7b. W2-P0-9: evil sibling origin refused (prefix match is not enough)
# ----------------------------------------------------------------------
# The old check was url.startswith(base): a sibling host like
# canvas.example.edu.evil.com shares the string prefix with the tenant
# base https://canvas.example.edu and would have passed as
# "same-origin". Exact-origin comparison must reject it.
t = FakeTransport([("ok", 200, "{}")])
s = cs.ChromiumSession(BASE, transport=t)
try:
    s.raw_request("GET",
                  "https://canvas.example.edu.evil.com/api/v1/users/self",
                  {}, None, is_write=False)
    check("evil sibling origin refused", False, "no exception")
except ex.ExecutorError as exc:
    check("evil sibling origin refused",
          "tenant origin only" in str(exc), str(exc)[:120])
check("sibling request never reached the transport", t.calls == [])
# Same-origin reads still work, including explicit default ports and
# case-insensitive hosts.
t = FakeTransport([("ok", 200, "{}")])
s = cs.ChromiumSession(BASE, transport=t)
try:
    s.raw_request("GET", "https://CANVAS.EXAMPLE.EDU:443/api/v1/courses",
                  {}, None, is_write=False)
    check("same-origin read with explicit port allowed", t.calls != [])
except ex.ExecutorError as exc:
    check("same-origin read with explicit port allowed", False,
          str(exc)[:120])

# ----------------------------------------------------------------------
# 8. dispatch_entry end to end on a ChromiumSession (fake transport)
# ----------------------------------------------------------------------
# Wave-3 hygiene: MORROW_SELFTEST_SCRATCH redirects test scratch to the
# wave's authorized scratch area (never /tmp).
scratch = os.path.join(REPO, "transport", ".selftest-work",
                       "chromium-session")
if os.environ.get("MORROW_SELFTEST_SCRATCH"):
    scratch = os.path.join(os.environ["MORROW_SELFTEST_SCRATCH"],
                           "chromium-session")
os.makedirs(scratch, exist_ok=True)
_saved_journal = ex.JOURNAL_PATH
_saved_home = ex.MORROW_HOME
ex.JOURNAL_PATH = os.path.join(scratch, "ops.jsonl")
ex.MORROW_HOME = scratch
_reset_journal(ex.JOURNAL_PATH)
try:
    t = FakeTransport([("ok", 200, '{"id": 12345, "name": "T User"}')])
    s = cs.ChromiumSession(BASE, transport=t)
    e = ex.catalog_descriptor_to_entry(
        "cs_e2e_read", "GET", "/api/v1/users/self", "read",
        provider="canvas")
    out = ex.dispatch_entry(e, {}, s, pack, plan=None,
                            op_id="11111111-2222-4333-8444-555555555555")
    check("dispatch_entry returns the receipt",
          out["receipt"].get("id") == 12345, repr(out["receipt"]))
    check("dispatch_entry journals the op",
          ex.find_journal_op(out["op_id"]) is not None)
    check("fake transport got the GET",
          t.calls and t.calls[0]["method"] == "GET"
          and t.calls[0]["path"] == "/api/v1/users/self",
          repr(t.calls))
    # Duplicate op id is refused (governance parity with the https path).
    t2 = FakeTransport([("ok", 200, "{}")])
    s2 = cs.ChromiumSession(BASE, transport=t2)
    try:
        ex.dispatch_entry(e, {}, s2, pack, plan=None, op_id=out["op_id"])
        check("duplicate op id refused", False, "no exception")
    except ex.DuplicateOpId:
        check("duplicate op id refused", True)
    check("refused duplicate made no provider call", t2.calls == [])
finally:
    ex.JOURNAL_PATH = _saved_journal
    ex.MORROW_HOME = _saved_home

# ----------------------------------------------------------------------
# 8b. dispatch_entry projects learner PII through the privacy boundary
# ----------------------------------------------------------------------
# The live executor path (not just the proof-battery lane) must
# de-identify learner records: provider JSON carrying student PII comes
# back as stable "Student A<n>" labels in both the returned receipt and
# the journaled record. Hermetic source vault under scratch.
#
# The vault seal needs the optional `cryptography` package; without it
# the boundary fail-closes and every dispatch here raises, so this
# section skips loudly instead (requirements-optional.txt contract).
_SECTION8B_CHECKS = [
    "learner names projected in returned receipt",
    "learner emails projected in returned receipt",
    "stable Student A<n> labels issued",
    "no pii_reveal on default path",
    "journaled receipt carries no learner PII",
    "journal records the projection labels",
    "non-learner read is not projected",
]
if _CRYPTO_AVAILABLE:
    _vault_path = os.path.join(scratch, "source_vault_8b.json")
    _saved_vault = os.environ.get("MORROW_SOURCE_VAULT_PATH")
    os.environ["MORROW_SOURCE_VAULT_PATH"] = _vault_path
    os.environ.pop("MORROW_REVEAL_STUDENT_PII_REASON", None)
    _ex_journal = ex.JOURNAL_PATH
    _ex_home = ex.MORROW_HOME
    ex.JOURNAL_PATH = os.path.join(scratch, "ops8b.jsonl")
    ex.MORROW_HOME = scratch
    _reset_journal(ex.JOURNAL_PATH)
    try:
        users_body = json.dumps([
            {"id": 99, "name": "Ada Lovelace", "email": "ada@example.edu",
             "login_id": "alovelace"},
            {"id": 100, "name": "Grace Hopper",
             "email": "grace@example.edu"},
        ])
        t3 = FakeTransport([("ok", 200, users_body)])
        s3 = cs.ChromiumSession(BASE, transport=t3)
        e3 = ex.catalog_descriptor_to_entry(
            "cs_e2e_users", "GET", "/api/v1/courses/42/users", "read",
            provider="canvas")
        out3 = ex.dispatch_entry(e3, {}, s3, pack, plan=None,
                                 op_id="22222222-3333-4444-8555-666666666666")
        receipt = out3["receipt"]
        receipt_text = json.dumps(receipt)
        check("learner names projected in returned receipt",
              "Ada Lovelace" not in receipt_text
              and "Grace Hopper" not in receipt_text, receipt_text[:200])
        check("learner emails projected in returned receipt",
              "ada@example.edu" not in receipt_text
              and "grace@example.edu" not in receipt_text)
        check("stable Student A<n> labels issued",
              "Student A1" in receipt_text, receipt_text[:200])
        check("no pii_reveal on default path",
              not (isinstance(receipt, dict) and receipt.get("pii_reveal")))
        rec3 = ex.find_journal_op(out3["op_id"])
        jtext = json.dumps(rec3)
        check("journaled receipt carries no learner PII",
              "Ada Lovelace" not in jtext and "ada@example.edu" not in jtext)
        check("journal records the projection labels",
              "Student A1" in jtext)
        # Control: the educator's own profile is not learner data and must
        # pass through unprojected.
        t4 = FakeTransport(
            [("ok", 200, '{"id": 7, "name": "Instructor I"}')])
        s4 = cs.ChromiumSession(BASE, transport=t4)
        e4 = ex.catalog_descriptor_to_entry(
            "cs_e2e_self", "GET", "/api/v1/users/self", "read",
            provider="canvas")
        out4 = ex.dispatch_entry(e4, {}, s4, pack, plan=None,
                                 op_id="33333333-4444-5555-8666-777777777777")
        check("non-learner read is not projected",
              "Instructor I" in json.dumps(out4["receipt"]))
    finally:
        ex.JOURNAL_PATH = _ex_journal
        ex.MORROW_HOME = _ex_home
        if _saved_vault is None:
            os.environ.pop("MORROW_SOURCE_VAULT_PATH", None)
        else:
            os.environ["MORROW_SOURCE_VAULT_PATH"] = _saved_vault
        for _f in (_vault_path, _vault_path + ".key",
                   _vault_path + ".lock",
                   os.path.join(scratch, "ops8b.jsonl"),
                   os.path.join(scratch, "ops.idx.json"),
                   os.path.join(scratch, "ops.lock")):
            try:
                os.unlink(_f)
            except FileNotFoundError:
                pass
else:
    _skip_crypto_section(_SECTION8B_CHECKS)

# ----------------------------------------------------------------------
# 9. https path untouched; CLI accepts --backend chromium
# ----------------------------------------------------------------------
seen = {}


def _fake_rwr(method, url, headers, body_bytes, is_write=False,
              max_bytes=None):
    seen.update(method=method, url=url, is_write=is_write,
                max_bytes=max_bytes)
    return 200, {}, b"{}", 1


# NOTE: SessionStore.raw_request resolves the module-global
# request_with_retry at call time, so patch the module attribute.
_real_rwr = ex.request_with_retry
ex.request_with_retry = _fake_rwr
try:
    https_sess = ex.SessionStore({"canvas": {"base": BASE}})
    out = https_sess.raw_request("GET", BASE + "/x", {}, None,
                                 is_write=False)
    check("SessionStore.raw_request delegates to request_with_retry",
          out[0] == 200 and seen.get("url") == BASE + "/x"
          and seen.get("is_write") is False, repr(seen))
finally:
    ex.request_with_retry = _real_rwr

# ----------------------------------------------------------------------
# W2-P1-6 / W2-P2-7 / W2-P2-8: pagination, Retry-After, aggregate cap
# ----------------------------------------------------------------------

class _FakePaginatedTransport:
    """Scripted transport.api: list of (status, headers, body) per call."""

    def __init__(self, pages):
        self.pages = list(pages)
        self.calls = []

    def api(self, method, path, data=None, as_json=False, timeout=None,
            max_bytes=None):
        self.calls.append(path)
        status, headers, body = self.pages.pop(0)
        return status, headers, body


def _cs_session(transport):
    return cs.ChromiumSession(BASE, transport=transport)


def _link(url):
    return '<%s>; rel="next"' % url


# 0. The standard quoted rel="next" form parses (regression: the old
# end-strip left rel="next unmatched, so pagination never followed).
check("parse_next_link quoted rel=next",
      cs.ChromiumSession._parse_next_link(
          '<https://canvas.example.edu/a?page=2>; rel="next"')
      == "https://canvas.example.edu/a?page=2")
check("parse_next_link unquoted rel=next",
      cs.ChromiumSession._parse_next_link(
          "<https://canvas.example.edu/a?page=2>; rel=next")
      == "https://canvas.example.edu/a?page=2")

# 1. Two JSON-array pages merge; complete note names the page count.
_t = _FakePaginatedTransport([
    (200, {}, "[3]"),
])
_s = _cs_session(_t)
st, hdrs, raw, att = _s._paginated_get(
    _t, "/api/v1/p", 100000, 200,
    {"link": _link(BASE + "/api/v1/p?page=2")}, "[1, 2]", 1)
check("pagination merges JSON-array pages",
      json.loads(raw.decode("utf-8")) == [1, 2, 3], raw[:80])
check("pagination complete note names page count",
      hdrs.get("x-morrow-pagination") == "complete: followed 2 pages",
      repr(hdrs))

# 2. Eleven pages stop at ten with a partial notice, never silently.
_pages = [(200, {"link": _link(BASE + "/api/v1/p?page=%d" % (i + 1))},
           "[%d]" % i) for i in range(1, 12)]
_t = _FakePaginatedTransport(_pages)
_s = _cs_session(_t)
st, hdrs, raw, att = _s._paginated_get(
    _t, "/api/v1/p", 100000, 200,
    {"link": _link(BASE + "/api/v1/p?page=2")}, "[0]", 1)
check("pagination stops at ten pages",
      len(_t.calls) == 9 and "partial" in hdrs.get("x-morrow-pagination", ""),
      "calls=%r hdrs=%r" % (len(_t.calls), hdrs))

# 3. A next link off the tenant origin is refused, not followed.
_t = _FakePaginatedTransport([])
_s = _cs_session(_t)
st, hdrs, raw, att = _s._paginated_get(
    _t, "/api/v1/p", 100000, 200,
    {"link": _link("https://evil.example.com/api/v1/p?page=2")}, "[1]", 1)
check("cross-origin next link refused",
      _t.calls == [] and json.loads(raw.decode("utf-8")) == [1],
      repr(hdrs))
check("cross-origin stop says so loudly",
      "tenant origin" in hdrs.get("x-morrow-pagination", ""), repr(hdrs))

# 4. Non-array pages: first page only, loudly.
_t = _FakePaginatedTransport([
    (200, {}, '{"not": "a list"}'),
])
_s = _cs_session(_t)
st, hdrs, raw, att = _s._paginated_get(
    _t, "/api/v1/p", 100000, 200,
    {"link": _link(BASE + "/api/v1/p?page=2")}, '{"a": 1}', 1)
check("non-array pages return first page only",
      raw.decode("utf-8") == '{"a": 1}', raw[:80])
check("non-array pages say so loudly",
      "not JSON arrays" in hdrs.get("x-morrow-pagination", ""), repr(hdrs))

# 5. A truncated first page is never merged silently.
_t = _FakePaginatedTransport([])
_s = _cs_session(_t)
st, hdrs, raw, att = _s._paginated_get(
    _t, "/api/v1/p", 100, 200,
    {"link": _link(BASE + "/api/v1/p?page=2"),
     "x-morrow-truncated": "body truncated at 100 bytes"}, "[1, 2", 1)
check("truncated first page not merged",
      _t.calls == [] and raw.decode("utf-8") == "[1, 2", raw[:80])
check("truncated first page reported partial",
      "partial" in hdrs.get("x-morrow-pagination", ""), repr(hdrs))

# 6. Aggregate byte cap: many small pages stop when the total exceeds
#    CHROMIUM_MAX_PAGES * max_bytes.
_big_pages = [(200, {"link": _link(BASE + "/api/v1/p?page=%d" % (i + 1))},
               '"%s"' % ("x" * 2000)) for i in range(1, 12)]
_t = _FakePaginatedTransport(_big_pages)
_s = _cs_session(_t)
st, hdrs, raw, att = _s._paginated_get(
    _t, "/api/v1/p", 1000, 200,
    {"link": _link(BASE + "/api/v1/p?page=2")}, '"%s"' % ("x" * 2000), 1)
check("aggregate byte cap stops pagination",
      "aggregate byte cap" in hdrs.get("x-morrow-pagination", ""),
      repr(hdrs))

# 7. W2-P2-7: a 429 with Retry-After sleeps the provider's delay.
_slept = []


class _Fake429Transport:
    def __init__(self):
        self.calls = 0

    def api(self, method, path, data=None, as_json=False, timeout=None,
            max_bytes=None):
        self.calls += 1
        if self.calls == 1:
            return 429, {"retry-after": "7"}, "slow"
        return 200, {}, "[]"


_real_sleep = cs.time.sleep
cs.time.sleep = lambda s: _slept.append(s)
try:
    _t429 = _Fake429Transport()
    _s429 = _cs_session(_t429)
    st, hdrs, raw, att = _s429.raw_request(
        "GET", BASE + "/api/v1/p", {}, None, is_write=False,
        max_bytes=100000)
    check("429 Retry-After honored on read",
          st == 200 and _slept == [7.0],
          "status=%r slept=%r" % (st, _slept))
finally:
    cs.time.sleep = _real_sleep

buf = io.StringIO()
try:
    with redirect_stdout(buf):
        ex.main(["execute", "--help"])
except SystemExit as exc:
    check("CLI --help exits 0", exc.code == 0, repr(exc.code))
help_text = buf.getvalue()
check("CLI --backend offers chromium", "chromium" in help_text)
check("CLI help describes the chromium lane",
      "127.0.0.1:19223" in help_text)

mod = ex._chromium_session_mod()
check("_chromium_session_mod loads chromium_session",
      mod.ChromiumSession is cs.ChromiumSession)

# ----------------------------------------------------------------------
# 10. Item Banks SDK lane routing (transport/item_bank_sdk.py)
# ----------------------------------------------------------------------
import types as _types


class _FakeSdk:
    """Stand-in for item_bank_sdk.ItemBankSdk (no browser, no token)."""

    instances = []

    def __init__(self, cdp, base, course_id):
        self.cdp = cdp
        self.base = base
        self.course_id = course_id
        self.calls = []
        self.script = []
        _FakeSdk.instances.append(self)

    def request(self, method, path, body=None, course_id=None,
                auth_type="Signature"):
        self.calls.append({"method": method, "path": path, "body": body,
                           "course_id": course_id})
        if not self.script:
            return 200, "{}"
        kind = self.script.pop(0)
        if kind[0] == "raise":
            raise kind[1]
        return kind[1], kind[2]

    def close(self):
        self.closed = True

    def drop_credential(self):
        self.dropped = True


_real_sdk_cls = cs.ibsdk.ItemBankSdk
cs.ibsdk.ItemBankSdk = _FakeSdk
_FakeSdk.instances = []
try:
    def _sdk_session(script=()):
        t = FakeTransport([])
        launcher = _types.SimpleNamespace(cdp=object(), started=False)
        s = cs.ChromiumSession(BASE, launcher=launcher, transport=t)
        s.set_sdk_course("89585")
        return s, t

    s, t = _sdk_session()
    body = json.dumps({"item": {"item_body": "<p>Q</p>"}}).encode()
    out = s.raw_request("POST", BASE + "/api/banks/7/items",
                        {"Content-Type": "application/json"}, body,
                        is_write=True)
    check("SDK lane: item POST routes to the SDK, not transport.api",
          out[0] == 200 and t.calls == []
          and len(_FakeSdk.instances) == 1, repr(out[0]))
    inst = _FakeSdk.instances[-1]
    check("SDK lane: bound to the session course",
          inst.course_id == "89585", repr(inst.course_id))
    check("SDK lane: path and body reach the SDK",
          inst.calls[0]["path"] == "/api/banks/7/items"
          and inst.calls[0]["body"] == {"item": {"item_body": "<p>Q</p>"}}
          and inst.calls[0]["method"] == "POST", repr(inst.calls))
    check("SDK lane: attempts reported", out[3] == 1, repr(out[3]))

    # Non-SDK paths still use the canvas-origin transport.
    s2, t2 = _sdk_session()
    out2 = s2.raw_request("GET", BASE + "/api/v1/courses/1", {}, None)
    check("non-SDK path still uses transport.api",
          out2[0] == 200 and len(t2.calls) == 1
          and t2.calls[0]["path"] == "/api/v1/courses/1"
          and len(_FakeSdk.instances) == 1, repr(t2.calls))

    # Missing course_id fails closed before any provider call.
    s3, t3 = _sdk_session()
    s3.set_sdk_course(None)
    n_before = len(_FakeSdk.instances)
    try:
        s3.raw_request("POST", BASE + "/api/banks/7/items",
                       {"Content-Type": "application/json"}, body,
                       is_write=True)
        check("SDK lane without course_id refuses", False, "no exception")
    except ex.ExecutorError as exc:
        check("SDK lane without course_id refuses", True)
        check("refusal names the missing course_id",
              "course_id" in str(exc), str(exc)[:80])
    check("refused SDK call made no provider call",
          len(_FakeSdk.instances) == n_before and t3.calls == [])

    # SDK session death maps to ChromiumSessionDead (nothing journaled).
    s4, t4 = _sdk_session()
    s4.raw_request("GET", BASE + "/api/banks/7", {}, None)
    _FakeSdk.instances[-1].script.append(
        ("raise", cs.ibsdk.ItemBankSdkSessionDead("signed out")))
    try:
        s4.raw_request("GET", BASE + "/api/banks/7/items/9", {}, None)
        check("SDK session death maps", False, "no exception")
    except cs.ChromiumSessionDead:
        check("SDK session death maps to ChromiumSessionDead", True)

    # Write 500 -> UncertainWrite; write 422 fails fast; read 503 retries.
    s5, t5 = _sdk_session()
    s5.raw_request("GET", BASE + "/api/banks/7", {}, None)
    _FakeSdk.instances[-1].script.append(("status", 500, "x"))
    try:
        s5.raw_request("POST", BASE + "/api/banks/7/items",
                       {"Content-Type": "application/json"}, body,
                       is_write=True)
        check("SDK write 500 -> UncertainWrite", False, "no exception")
    except ex.UncertainWrite:
        check("SDK write 500 -> UncertainWrite", True)
    s6, t6 = _sdk_session()
    s6.raw_request("GET", BASE + "/api/banks/7", {}, None)
    _FakeSdk.instances[-1].script.append(("status", 422, "x"))
    try:
        s6.raw_request("POST", BASE + "/api/banks/7/items",
                       {"Content-Type": "application/json"}, body,
                       is_write=True)
        check("SDK write 422 fails fast", False, "no exception")
    except ex.ProviderHttpError as exc:
        check("SDK write 422 fails fast as ProviderHttpError",
              exc.status == 422, repr(exc.status))
    s7, t7 = _sdk_session()
    s7.raw_request("GET", BASE + "/api/banks/7", {}, None)
    _FakeSdk.instances[-1].script.extend(
        [("status", 503, "x"), ("status", 200, '{"ok":true}')])
    out7 = s7.raw_request("GET", BASE + "/api/banks/7/items/9", {}, None)
    check("SDK read 503 retries then succeeds",
          out7[0] == 200 and out7[3] == 2, repr(out7[0:1] + out7[3:4]))

    # W3-P2-19: status 0 and 3xx are never successful API responses.
    s9, t9 = _sdk_session()
    s9.raw_request("GET", BASE + "/api/banks/7", {}, None)
    _FakeSdk.instances[-1].script.append(("status", 301, "x"))
    try:
        s9.raw_request("GET", BASE + "/api/banks/7/items/9", {}, None)
        check("SDK read 301 fails fast", False, "no exception")
    except ex.ProviderHttpError as exc:
        check("SDK read 301 fails fast as ProviderHttpError",
              exc.status == 301, repr(exc.status))
    s10, t10 = _sdk_session()
    s10.raw_request("GET", BASE + "/api/banks/7", {}, None)
    _FakeSdk.instances[-1].script.extend([("status", 0, "x")] * 4)
    try:
        s10.raw_request("GET", BASE + "/api/banks/7/items/9", {}, None)
        check("SDK read status 0 fails", False, "no exception")
    except ex.ExecutorError as exc:
        check("SDK read status 0 retried then ExecutorError",
              type(exc) is ex.ExecutorError
              and "no HTTP response" in str(exc), str(exc)[:80])
    s11, t11 = _sdk_session()
    s11.raw_request("GET", BASE + "/api/banks/7", {}, None)
    _FakeSdk.instances[-1].script.extend(
        [("status", 0, "x"), ("status", 200, '{"ok":true}')])
    out11 = s11.raw_request("GET", BASE + "/api/banks/7/items/9", {}, None)
    check("SDK read status 0 retries then succeeds",
          out11[0] == 200 and out11[3] == 2, repr(out11[0:1] + out11[3:4]))
    s12, t12 = _sdk_session()
    s12.raw_request("GET", BASE + "/api/banks/7", {}, None)
    _FakeSdk.instances[-1].script.append(("status", 301, "x"))
    try:
        s12.raw_request("POST", BASE + "/api/banks/7/items",
                        {"Content-Type": "application/json"}, body,
                        is_write=True)
        check("SDK write 301 -> UncertainWrite", False, "no exception")
    except ex.UncertainWrite:
        check("SDK write 301 -> UncertainWrite", True)
    s13, t13 = _sdk_session()
    s13.raw_request("GET", BASE + "/api/banks/7", {}, None)
    _FakeSdk.instances[-1].script.append(("status", 0, "x"))
    try:
        s13.raw_request("POST", BASE + "/api/banks/7/items",
                        {"Content-Type": "application/json"}, body,
                        is_write=True)
        check("SDK write status 0 -> UncertainWrite", False, "no exception")
    except ex.UncertainWrite:
        check("SDK write status 0 -> UncertainWrite", True)

    # Course rebind drops the cached SDK object (no cross-course reuse).
    s8, t8 = _sdk_session()
    s8.raw_request("GET", BASE + "/api/banks/7", {}, None)
    first = _FakeSdk.instances[-1]
    s8.set_sdk_course("12345")
    check("course rebind closes the old SDK session",
          getattr(first, "closed", False) is True,
          repr(getattr(first, "closed", None)))
    s8.raw_request("GET", BASE + "/api/banks/7", {}, None)
    check("course rebind creates a fresh SDK object",
          _FakeSdk.instances[-1] is not first
          and _FakeSdk.instances[-1].course_id == "12345")

    # LANE6-2: SDK lane honors max_bytes like the canvas lane (W2-P2-8),
    # with the x-morrow-truncated flag.
    s14, t14 = _sdk_session()
    s14.raw_request("GET", BASE + "/api/banks/7", {}, None)
    _FakeSdk.instances[-1].script.append(("status", 200, "x" * 5000))
    out14 = s14.raw_request("GET", BASE + "/api/banks/7", {}, None,
                            max_bytes=100)
    check("SDK lane truncates the body at max_bytes",
          len(out14[2]) == 100, repr(len(out14[2])))
    check("SDK lane flags the truncation",
          out14[1].get("x-morrow-truncated") == "body truncated at 100 bytes",
          repr(out14[1]))
    check("SDK lane does not truncate short bodies",
          "x-morrow-truncated" not in s14.raw_request(
              "GET", BASE + "/api/banks/7", {}, None, max_bytes=100)[1])

    # LANE6-5: a 401 drops the captured credential so the next call
    # relaunches instead of failing on the stale token forever.
    s15, t15 = _sdk_session()
    s15.raw_request("GET", BASE + "/api/banks/7", {}, None)
    inst15 = _FakeSdk.instances[-1]
    inst15.script.append(("status", 401, '{"error":"unauthorized"}'))
    try:
        s15.raw_request("GET", BASE + "/api/banks/7", {}, None)
        check("SDK read 401 fails fast", False, "no exception")
    except ex.ProviderHttpError as exc:
        check("SDK read 401 fails fast as ProviderHttpError",
              exc.status == 401, repr(exc.status))
    check("SDK 401 drops the captured credential",
          getattr(inst15, "dropped", False) is True,
          repr(getattr(inst15, "dropped", None)))

    # LANE6-7: SDK session death is sticky session-dead for writes too,
    # never an uncertain write: SessionDead fires only in launch(),
    # before any provider activity, and the op_id stays reusable.
    s16, t16 = _sdk_session()
    s16.raw_request("GET", BASE + "/api/banks/7", {}, None)
    _FakeSdk.instances[-1].script.append(
        ("raise", cs.ibsdk.ItemBankSdkSessionDead("signed out")))
    try:
        s16.raw_request("POST", BASE + "/api/banks/7/items",
                        {"Content-Type": "application/json"}, body,
                        is_write=True)
        check("SDK write session death is not UncertainWrite",
              False, "no exception")
    except ex.UncertainWrite:
        check("SDK write session death is not UncertainWrite",
              False, "got UncertainWrite")
    except cs.ChromiumSessionDead as exc:
        check("SDK write session death is not UncertainWrite", True)
        check("SDK write session death keeps the op_id reusable",
              "op_id stays reusable" in str(exc), str(exc)[:100])

    # LANE6-8: a page-context call that may already have issued its
    # fetch is UncertainWrite for writes, hard failure for reads.
    s17, t17 = _sdk_session()
    s17.raw_request("GET", BASE + "/api/banks/7", {}, None)
    _FakeSdk.instances[-1].script.append(
        ("raise", cs.ibsdk.ItemBankSdkMaybeAttempted("context lost")))
    try:
        s17.raw_request("POST", BASE + "/api/banks/7/items",
                        {"Content-Type": "application/json"}, body,
                        is_write=True)
        check("SDK maybe-attempted write -> UncertainWrite",
              False, "no exception")
    except ex.UncertainWrite:
        check("SDK maybe-attempted write -> UncertainWrite", True)
    s18, t18 = _sdk_session()
    s18.raw_request("GET", BASE + "/api/banks/7", {}, None)
    _FakeSdk.instances[-1].script.append(
        ("raise", cs.ibsdk.ItemBankSdkMaybeAttempted("context lost")))
    try:
        s18.raw_request("GET", BASE + "/api/banks/7/items/9", {}, None)
        check("SDK maybe-attempted read fails hard", False, "no exception")
    except ex.ExecutorError as exc:
        check("SDK maybe-attempted read fails hard as ExecutorError",
              type(exc) is ex.ExecutorError, repr(type(exc)))
finally:
    cs.ibsdk.ItemBankSdk = _real_sdk_cls

# ----------------------------------------------------------------------
# 11. W4-P2-1: death wires into the re-auth machine, exactly once.
#     W4-P2-2 (sticky regression): no provider re-attempt, no second
#     uncertain. W4-P2-4: taxonomy. W4-P2-3: near-expiry warning.
# ----------------------------------------------------------------------

def _rsm_calls(kind):
    return [c for c in _fake_rsm.calls if c[0] == kind]


# A healthy session never touches the re-auth machine.
_fake_rsm.calls.clear()
t = FakeTransport([("ok", 200, "{}")])
s = cs.ChromiumSession(BASE, transport=t)
s.raw_request("GET", BASE + "/api/v1/x", {}, None, is_write=False)
check("wiring: healthy session never touches the re-auth machine",
      _fake_rsm.calls == [], repr(_fake_rsm.calls))

# First death: write hits SessionDead mid-write -> UncertainWrite
# (journaled once by the executor), and the machine fires exactly once:
# halt imposed, session quarantined, notify written.
_fake_rsm.calls.clear()
t = FakeTransport([("ok", 200, '{"id": 1}'),
                   ("raise", lc.SessionDead(
                       "Canvas served a login page for the API call; "
                       "the browser session is dead")),
                   ("ok", 200, "{}")])
s = cs.ChromiumSession(BASE, transport=t)
s.raw_request("GET", BASE + "/api/v1/x", {}, None, is_write=False)
try:
    s.raw_request("POST", BASE + "/api/v1/x", {},
                  json.dumps({"a": 1}).encode(), is_write=True)
    check("wiring: mid-write SessionDead -> UncertainWrite", False,
          "no exception")
except ex.UncertainWrite:
    check("wiring: mid-write SessionDead -> UncertainWrite", True)
check("wiring: exactly one provider call before the death",
      len(t.calls) == 2, "calls=%d" % len(t.calls))
halt = _rsm_calls("impose_halt")
quar = _rsm_calls("quarantine_session")
note = _rsm_calls("write_notify_expired")
check("wiring: write halt imposed exactly once", len(halt) == 1,
      repr(_fake_rsm.calls))
check("wiring: session quarantined exactly once", len(quar) == 1)
check("wiring: notify written exactly once", len(note) == 1)
check("wiring: halt detection carries the taxonomy cause",
      halt and halt[0][1].get("cause") == cs.AUTH_DEATH_SESSION_ENDED
      and halt[0][1].get("signal") == "chromium_session_dead",
      repr(halt[0][1]) if halt else "no halt call")
check("wiring: quarantine records the taxonomy cause",
      quar and quar[0][1] == cs.AUTH_DEATH_SESSION_ENDED,
      repr(quar))

# Sticky (W4-P2-2): the next write on the same dead object fails fast
# as ChromiumSessionDead: no provider call, no second UncertainWrite,
# no second trip through the re-auth machine.
n_calls_before = len(t.calls)
n_rsm_before = len(_fake_rsm.calls)
try:
    s.raw_request("POST", BASE + "/api/v1/x", {},
                  json.dumps({"a": 2}).encode(), is_write=True)
    check("sticky: write after death fails fast", False, "no exception")
except cs.ChromiumSessionDead as exc:
    check("sticky: write after death -> ChromiumSessionDead", True)
    check("sticky: fail-fast names the taxonomy + remedy",
          "password change" in str(exc) and "admin" in str(exc)
          and "sign in again" in str(exc), str(exc)[:160])
except ex.UncertainWrite:
    check("sticky: write after death -> ChromiumSessionDead", False,
          "a second UncertainWrite was journaled")
check("sticky: no provider call after death",
      len(t.calls) == n_calls_before, "calls=%d" % len(t.calls))
check("sticky: re-auth machine not re-entered",
      len(_fake_rsm.calls) == n_rsm_before, repr(_fake_rsm.calls))
# Reads fail fast too, without touching the provider.
try:
    s.raw_request("GET", BASE + "/api/v1/y", {}, None, is_write=False)
    check("sticky: read after death fails fast", False, "no exception")
except cs.ChromiumSessionDead:
    check("sticky: read after death -> ChromiumSessionDead", True)
check("sticky: read made no provider call",
      len(t.calls) == n_calls_before)

# W4-P2-4: taxonomy unit checks.
key, msg = cs.classify_auth_death(
    Exception("Canvas redirected the API call to a login page"), True)
check("taxonomy: live session + login page -> session_ended",
      key == cs.AUTH_DEATH_SESSION_ENDED
      and "password change" in msg and "admin revocation" in msg,
      msg[:120])
check("taxonomy: session_ended remedy names the re-death test",
      "sign in again" in cs.AUTH_DEATH_REMEDIES[key]
      and "dies again" in cs.AUTH_DEATH_REMEDIES[key])
key2, msg2 = cs.classify_auth_death(
    Exception("no live Canvas session in the local browser"), False)
check("taxonomy: never-live session -> no_live_session",
      key2 == cs.AUTH_DEATH_NO_LIVE_SESSION, msg2[:120])
check("taxonomy: never-live message never claims expiry",
      "expir" not in msg2.lower(), msg2[:120])
check("taxonomy: no_live_session remedy is sign-in (not re-sign-in)",
      "sign in to Canvas through the login helper"
      in cs.AUTH_DEATH_REMEDIES[key2])

# W4-P2-3: near-expiry warning, once per object, metadata only.
_real_helper_status = lc.helper_status
try:
    lc.helper_status = lambda timeout=5: {"session_expiry_horizon_days": 1}
    s = cs.ChromiumSession(BASE, transport=FakeTransport([]))
    buf = io.StringIO()
    with redirect_stderr(buf):
        s._check_expiry_warning()
    check("expiry warning: 1-day horizon warns on stderr",
          "within ~24h" in buf.getvalue(), buf.getvalue()[:120])
    buf2 = io.StringIO()
    with redirect_stderr(buf2):
        s._check_expiry_warning()
    check("expiry warning: emitted once per session object",
          buf2.getvalue() == "", repr(buf2.getvalue()[:80]))
    lc.helper_status = lambda timeout=5: {"session_expiry_horizon_days": 30}
    s2 = cs.ChromiumSession(BASE, transport=FakeTransport([]))
    buf3 = io.StringIO()
    with redirect_stderr(buf3):
        s2._check_expiry_warning()
    check("expiry warning: 30-day horizon stays silent",
          buf3.getvalue() == "", repr(buf3.getvalue()[:80]))

    def _helper_down(timeout=5):
        raise RuntimeError("helper down")

    lc.helper_status = _helper_down
    s3 = cs.ChromiumSession(BASE, transport=FakeTransport([]))
    try:
        with redirect_stderr(io.StringIO()):
            s3._check_expiry_warning()
        check("expiry warning: helper failure never raises", True)
    except Exception as exc:
        check("expiry warning: helper failure never raises", False,
              str(exc))
finally:
    lc.helper_status = _real_helper_status

# restore
ex._backoff_sleep = _ex_backoff

print("PASS: %d" % len(PASS))
for name in PASS:
    print("  ok %s" % name)
if SKIP:
    print("skip: %d" % len(SKIP))
    for name in SKIP:
        print("  skip %s" % name)
if FAIL:
    print("FAIL: %d" % len(FAIL))
    for name in FAIL:
        print("  FAIL %s" % name)
    sys.exit(1)
print("chromium session selftest: %d passed, %d failed, %d skipped"
      % (len(PASS), len(FAIL), len(SKIP)))
print("all chromium session selftests passed")
