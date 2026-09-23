#!/usr/bin/env python3
"""Self-test for transport/local_chromium.py.

Covers the Wave 4 browser/CDP security rework:
- W4-P0-3: no TCP CDP; Chromium uses --remote-debugging-pipe and the
  launching process privately owns the pipe. CDP() without an owner is
  refused (W4-P2-16).
- W4-P0-9: --no-sandbox is passed ONLY as root (Chromium hard-refuses
  the sandbox as root; verified 2026-09-21), via _no_sandbox_args().
- W4-P2-17: minimum Chromium version gate on every launch.
- W4-P2-22: explicit CHROMIUM_BIN fails fast (no silent fall-through);
  explicit constructor binaries are executability-checked and the exact
  binary is version-probed.
- W4-P1-13: Browser.setDownloadBehavior deny is applied fail-closed.
- W4-P1-12: API probes run in an isolated world, never the page realm.
- W4-P2-8: HTTPS-only navigation at the CDP layer.
- W4-P2-18: (helper-side) login state no longer consults document.title;
  see helper/helper_selftest.py.

No live helper, live profile, or real credentials are used. All scratch
state goes under the authorized scratch directory
~/workspace/audits/adversarial-wave-4-2026-09-21/scratch/worker-browser/
(never /tmp). The live-browser test at the end is opt-in via
MORROW_SELFTEST_LIVE_BROWSER=1.
"""
import os as _home_os, sys as _home_sys  # noqa: E401
_home_sys.path.insert(0, _home_os.path.join(
    _home_os.path.dirname(_home_os.path.abspath(__file__)), '..'))
import config.selftest_home  # noqa: E402,F401  (scratch HOME/MORROW_HOME)

import contextlib
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import local_chromium as lc  # noqa: E402

PASS = []
FAIL = []


def check(name, fn):
    try:
        fn()
    except Exception as exc:  # noqa: BLE001
        FAIL.append((name, "%r" % (exc,)))
        print("FAIL %s: %r" % (name, exc))
        return
    PASS.append(name)
    print("ok %s" % name)


def expect_raises(name, fn, exc_type=Exception):
    def _run():
        try:
            fn()
        except exc_type:
            return
        raise AssertionError("expected %s" % exc_type.__name__)
    check(name, _run)


# ---------------------------------------------------------------------------
# Scratch space (NEVER /tmp).
# ---------------------------------------------------------------------------

SCRATCH = os.path.expanduser(
    "~/workspace/audits/adversarial-wave-4-2026-09-21/"
    "scratch/worker-browser/local-chromium-selftest")
assert not SCRATCH.startswith("/tmp"), "scratch must never be /tmp"


def _mk_scratch(name):
    d = os.path.join(SCRATCH, name)
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d, exist_ok=True)
    return d


def _fake_binary(d, name, script):
    p = os.path.join(d, name)
    with open(p, "w") as fh:
        fh.write(script)
    os.chmod(p, 0o755)
    return p


def _with_env(env, fn):
    old = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    try:
        return fn()
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


# ---------------------------------------------------------------------------
# Fake CDP (no websocket, no port): the owner passes itself.
# ---------------------------------------------------------------------------

class _FakeCDP(lc.CDP):
    """Scripted CDP surface. Tabs are dicts; evaluate records params."""

    def __init__(self):
        super().__init__(port=19223, owner="selftest")
        self.events = []       # queued poll_session_events batches
        self.calls = []        # (method, params) records
        self.evaluations = []  # (expression, context_id, await_promise)
        self.navigated = []
        self.closed = []
        self.new_tabs = []

    # -- primitive surface ------------------------------------------------
    def call(self, tab, method, params=None, timeout=30):
        self.calls.append((method, params or {}))
        if method == "Page.getFrameTree":
            return {"frameTree": {"frame": {"id": "F-top",
                                            "url": "https://t/"},
                                  "childFrames": []}}
        if method == "Page.createIsolatedWorld":
            fid = (params or {}).get("frameId")
            if not fid:
                raise AssertionError("createIsolatedWorld needs frameId")
            return {"executionContextId": 77}
        if method == "Browser.setDownloadBehavior":
            return {}
        if method in ("Network.enable", "Network.disable"):
            return {}
        raise AssertionError("unexpected CDP call %s" % method)

    def tabs(self):
        return [{"id": "fake-tab", "type": "page",
                 "url": "https://t/"}]

    def new_tab(self, url="about:blank"):
        tab = {"id": "fake-new", "type": "page", "url": url}
        self.new_tabs.append(tab)
        return tab

    def close_tab(self, tab):
        self.closed.append(tab.get("id") if isinstance(tab, dict) else tab)
        return {"ok": True}

    def navigate(self, tab, url, timeout=30):
        lc._assert_https_nav_url(url)
        self.navigated.append(url)
        return {"frameId": "F-top"}

    def evaluate(self, tab, expression, await_promise=False, timeout=30,
                 context_id=None):
        self.evaluations.append((expression, context_id, await_promise))
        if expression == "location.href":
            return "https://t/"
        # LocalChromiumTransport.api() json.loads() this envelope.
        return json.dumps({"ok": True, "status": 200,
                           "body": '{"id": 7, "name": "T"}'})

    # NOTE: create_isolated_world is intentionally NOT overridden: the
    # real CDP.create_isolated_world (root-frame resolution, frameId,
    # fail-closed) is what the isolated-world tests exercise; the fake
    # only scripts the wire calls in call() above.

    def tab_session(self, tab):
        return tab

    def poll_session_events(self, session, timeout=5):
        # Real shape: an iterable of CDP event dicts.
        if self.events:
            return list(self.events.pop(0))
        return []


def _transport_with(fake, base="https://t/"):
    launcher = lc.ChromiumLauncher.__new__(lc.ChromiumLauncher)
    launcher.cdp = fake
    return lc.LocalChromiumTransport(base, launcher)


# -- W4-P0-3 / W4-P2-16: no TCP CDP, owner required -------------------------

def _t_cdp_ownerless_refused():
    expect_raises("cdp-ownerless-refused",
                  lambda: lc.CDP(19223),
                  lc.CDPError)


def _t_cdp_ownerless_refused_none():
    expect_raises("cdp-owner-none-refused",
                  lambda: lc.CDP(19223, owner=None),
                  lc.CDPError)


def _t_cdp_owner_accepted():
    def _run():
        cdp = lc.CDP(19223, owner="selftest")
        assert cdp.port == 19223
    check("cdp-owner-accepted", _run)


def _t_no_tcp_probe_helpers():
    # Nothing in the module offers a TCP probe anymore.
    def _run():
        for attr in ("_probe_cdp", "_verify_cdp_holder", "ws_path"):
            assert not hasattr(lc, attr), attr
            assert not hasattr(lc.CDP, attr), attr
    check("no-tcp-probe-helpers", _run)


def _t_no_debugging_port_flag():
    # W4-P0-3: --remote-debugging-port must not appear in production
    # sources. The pipe is the only CDP transport; a stray port flag
    # would reopen the unauthenticated TCP surface.
    def _run():
        for rel in ("local_chromium.py",
                    os.path.join("..", "helper", "server.py")):
            text = open(os.path.join(HERE, rel)).read()
            assert "--remote-debugging-port" not in text, rel
    check("no-debugging-port-flag", _run)


def _t_verify_forwarder_holder_own_ok():
    # W4-P2-9: a holder whose env names this launcher is adopted.
    def _run():
        real_holder = lc._forwarder_holder_pid
        real_env = lc._proc_environ
        try:
            lc._forwarder_holder_pid = lambda port, **kw: 4242
            lc._proc_environ = lambda pid, **kw: {
                "MORROW_FORWARDER_LAUNCHER_PID": str(os.getpid())}
            url = lc._verify_forwarder_holder(
                19224, ("proxy_forwarder.py",))
            assert url == "http://127.0.0.1:19224", url
        finally:
            lc._forwarder_holder_pid = real_holder
            lc._proc_environ = real_env
    check("verify-forwarder-holder-own-ok", _run)


def _t_verify_forwarder_holder_foreign_refused():
    # W4-P2-9: a forwarder owned by another launcher is refused, not
    # adopted (its client auth would 403 this launcher's Chromium).
    def _run():
        real_holder = lc._forwarder_holder_pid
        real_env = lc._proc_environ
        try:
            lc._forwarder_holder_pid = lambda port, **kw: 4242
            lc._proc_environ = lambda pid, **kw: {
                "MORROW_FORWARDER_LAUNCHER_PID": "999999"}
            try:
                lc._verify_forwarder_holder(19224, ("proxy_forwarder.py",))
            except RuntimeError as exc:
                assert "another launcher" in str(exc)
                return
            raise AssertionError("foreign forwarder must be refused")
        finally:
            lc._forwarder_holder_pid = real_holder
            lc._proc_environ = real_env
    check("verify-forwarder-holder-foreign-refused", _run)


def _t_verify_forwarder_holder_not_forwarder_refused():
    # W3-P2-12: a squatter that is not proxy_forwarder.py is refused.
    def _run():
        real_holder = lc._forwarder_holder_pid
        try:
            lc._forwarder_holder_pid = lambda port, **kw: None
            try:
                lc._verify_forwarder_holder(19224, ("proxy_forwarder.py",))
            except RuntimeError as exc:
                assert "not proxy_forwarder.py" in str(exc)
                return
            raise AssertionError("non-forwarder holder must be refused")
        finally:
            lc._forwarder_holder_pid = real_holder
    check("verify-forwarder-holder-not-forwarder-refused", _run)


def _t_proc_environ_real():
    # _proc_environ reads the real /proc for a live process. Linux only:
    # the Muse VM has /proc, and a host without it has nothing to read.
    if not os.path.isdir("/proc/self"):
        print("skip proc-environ-real (this host has no /proc)")
        return

    def _run():
        env = lc._proc_environ(os.getpid())
        assert isinstance(env, dict) and env, "must parse own environ"
    check("proc-environ-real", _run)


# -- version gate (W4-P2-17) / binary validation (W4-P2-22) ------------------

def _t_version_floor_ok():
    def _run():
        d = _mk_scratch("version-ok")
        b = _fake_binary(d, "chrome",
                         '#!/bin/sh\necho "Chromium 152.0.7977.82"\n')
        assert lc._check_version_floor(b) == "152.0.7977.82"
    check("version-floor-ok", _run)


def _t_version_floor_chrome_brand():
    def _run():
        d = _mk_scratch("version-chrome")
        b = _fake_binary(d, "chrome",
                         '#!/bin/sh\necho "Google Chrome 153.0.1.2"\n')
        assert lc._check_version_floor(b) == "153.0.1.2"
    check("version-floor-chrome-brand", _run)


def _t_version_floor_below():
    def _run():
        d = _mk_scratch("version-old")
        b = _fake_binary(d, "chrome",
                         '#!/bin/sh\necho "Chromium 151.0.9999.99"\n')
        try:
            lc._check_version_floor(b)
        except RuntimeError as exc:
            assert "below the minimum" in str(exc)
            assert "151.0.9999.99" in str(exc)
            return
        raise AssertionError("old version must be refused")
    check("version-floor-below-refused", _run)


def _t_version_floor_garbage():
    def _run():
        d = _mk_scratch("version-garbage")
        b = _fake_binary(d, "chrome", '#!/bin/sh\necho "not a browser"\n')
        try:
            lc._check_version_floor(b)
        except RuntimeError as exc:
            assert "did not report a sane" in str(exc)
            return
        raise AssertionError("garbage version output must be refused")
    check("version-floor-garbage-refused", _run)


def _t_version_floor_nonzero_exit():
    def _run():
        d = _mk_scratch("version-exit")
        b = _fake_binary(d, "chrome", '#!/bin/sh\nexit 3\n')
        try:
            lc._check_version_floor(b)
        except RuntimeError as exc:
            # Empty output + nonzero exit: not a sane version line.
            assert "did not report a sane" in str(exc)
            return
        raise AssertionError("nonzero --version exit must be refused")
    check("version-floor-nonzero-exit-refused", _run)


def _t_version_floor_missing_binary():
    expect_raises("version-floor-missing-binary-refused",
                  lambda: lc._check_version_floor(
                      "/nonexistent-for-selftest/chrome"),
                  RuntimeError)


def _t_chromium_bin_override_ok():
    def _run():
        d = _mk_scratch("bin-override")
        b = _fake_binary(d, "chrome",
                         '#!/bin/sh\necho "Chromium 152.0.7977.82"\n')
        def _go():
            assert lc.default_binary() == b
        _with_env({"CHROMIUM_BIN": b}, _go)
    check("chromium-bin-override-ok", _run)


def _t_chromium_bin_bad_fails_fast():
    # W4-P2-22: a bad CHROMIUM_BIN must NOT silently fall through to a
    # different browser (the platform binary ships in the image, so a
    # fall-through would be a quiet browser substitution).
    def _run():
        try:
            _with_env({"CHROMIUM_BIN": "/nonexistent-for-selftest/chrome"},
                      lc.default_binary)
        except RuntimeError as exc:
            assert "CHROMIUM_BIN" in str(exc)
            assert "refusing" in str(exc)
            return
        raise AssertionError("bad CHROMIUM_BIN must fail fast")
    check("chromium-bin-missing-fails-fast", _run)


def _t_chromium_bin_old_version_fails_fast():
    def _run():
        d = _mk_scratch("bin-override-old")
        b = _fake_binary(d, "chrome",
                         '#!/bin/sh\necho "Chromium 140.0.0.0"\n')
        try:
            _with_env({"CHROMIUM_BIN": b}, lc.default_binary)
        except RuntimeError as exc:
            assert "version gate" in str(exc)
            return
        raise AssertionError("below-floor CHROMIUM_BIN must fail fast")
    check("chromium-bin-old-version-fails-fast", _run)


def _t_launcher_rejects_missing_binary_at_construction():
    # W4-P2-17/22: a missing explicit binary fails in the constructor
    # (executable-file check), not deep inside start().
    def _run():
        d = _mk_scratch("launcher-binary")
        profile = os.path.join(d, "profile")
        try:
            lc.ChromiumLauncher(
                profile_dir=profile,
                binary="/nonexistent-for-selftest/chrome")
        except RuntimeError as exc:
            assert "not an executable file" in str(exc)
            return
        raise AssertionError("constructor must reject a missing binary")
    check("launcher-rejects-missing-binary-at-construction", _run)


def _t_launcher_rejects_non_executable_binary():
    # A non-executable FILE (not just a missing path) is refused too.
    def _run():
        d = _mk_scratch("launcher-binary-noexec")
        profile = os.path.join(d, "profile")
        p = os.path.join(d, "chrome")
        with open(p, "w") as fh:
            fh.write("#!/bin/sh\necho 'Chromium 152.0.7977.82'\n")
        os.chmod(p, 0o644)  # not executable
        try:
            lc.ChromiumLauncher(profile_dir=profile, binary=p)
        except RuntimeError as exc:
            assert "not an executable file" in str(exc)
            return
        raise AssertionError("constructor must reject a non-executable file")
    check("launcher-rejects-non-executable-binary", _run)


def _t_launcher_rejects_directory_binary():
    def _run():
        d = _mk_scratch("launcher-binary-dir")
        profile = os.path.join(d, "profile")
        try:
            lc.ChromiumLauncher(profile_dir=profile, binary=d)
        except RuntimeError as exc:
            assert "not an executable file" in str(exc)
            return
        raise AssertionError("constructor must reject a directory")
    check("launcher-rejects-directory-binary", _run)


def _t_launcher_normalizes_binary_path():
    # The stored binary is the realpath: a symlinked override resolves
    # to exactly the file that launches.
    def _run():
        d = _mk_scratch("launcher-binary-link")
        profile = os.path.join(d, "profile")
        real = _fake_binary(d, "chrome-real",
                            '#!/bin/sh\necho "Chromium 152.0.7977.82"\n')
        link = os.path.join(d, "chrome-link")
        os.symlink(real, link)
        launcher = lc.ChromiumLauncher(profile_dir=profile, binary=link)
        assert launcher.binary == os.path.realpath(real), launcher.binary
    check("launcher-normalizes-binary-path", _run)


def _t_launcher_start_version_gates_exact_binary():
    # The constructor's executable check passes for a below-floor
    # binary; start() must still refuse it on the version floor.
    def _run():
        d = _mk_scratch("launcher-binary-old")
        profile = os.path.join(d, "profile")
        b = _fake_binary(d, "chrome-old",
                         '#!/bin/sh\necho "Chromium 140.0.0.0"\n')
        launcher = lc.ChromiumLauncher(profile_dir=profile, binary=b)
        try:
            launcher.start()
        except RuntimeError as exc:
            assert "below the minimum" in str(exc), str(exc)
            return
        raise AssertionError("start() must version-gate its exact binary")
    check("launcher-start-version-gates-exact-binary", _run)


def _t_launcher_start_rejects_garbage_version():
    # Malformed --version output must fail through start(), not only
    # through _check_version_floor directly: start() must not launch a
    # binary it cannot version-identify.
    def _run():
        d = _mk_scratch("launcher-binary-garbage")
        profile = os.path.join(d, "profile")
        b = _fake_binary(d, "chrome-garbage",
                         '#!/bin/sh\necho "not a browser"\n')
        launcher = lc.ChromiumLauncher(profile_dir=profile, binary=b)
        try:
            launcher.start()
        except RuntimeError as exc:
            assert "version" in str(exc).lower(), str(exc)
            return
        raise AssertionError(
            "start() must refuse a binary with unparseable --version")
    check("launcher-start-rejects-garbage-version", _run)


# -- W4-P0-9: --no-sandbox root-only -----------------------------------------

def _t_proxy_generic_call_methods_allowlisted():
    # W4-P0-3: in attach mode every generic /cdp/call method must be on
    # the helper's _CDP_PROXY_ALLOWLIST. Dedicated routes (/cdp/evaluate,
    # /cdp/navigate, /cdp/tabs, /cdp/new-tab, /cdp/close-tab, /cdp/events)
    # bypass the allowlist by design, so ProxyCDP must shadow the
    # base-class methods that would otherwise route those through call().
    def _run():
        import inspect
        import re
        srv = open(os.path.join(HERE, "..", "helper", "server.py")).read()
        m = re.search(
            r"_CDP_PROXY_ALLOWLIST = frozenset\(\{([^}]*)\}\)", srv, re.S)
        assert m, "proxy allowlist must be present in helper/server.py"
        allowed = set(re.findall(r'"([A-Za-z]+\.[A-Za-z]+)"', m.group(1)))
        assert allowed, "allowlist must not be empty"
        for name in ("evaluate", "navigate", "close_tab", "tabs",
                     "new_tab", "tab_session", "poll_session_events"):
            assert ("def %s(" % name) in inspect.getsource(lc.ProxyCDP), \
                "ProxyCDP must shadow %s (dedicated route)" % name
        via_generic = set()
        sources = ["local_chromium.py", "item_bank_sdk.py",
                   os.path.join("..", "session", "cdp.py")]
        # The rig-only header capture is left out of the release
        # (scripts/carve.py DEV_ONLY), where this suite also ships.
        capture = os.path.join("..", "session", "capture.py")
        if os.path.exists(os.path.join(HERE, capture)):
            sources.append(capture)
        for rel in sources:
            text = open(os.path.join(HERE, rel)).read()
            via_generic |= set(re.findall(
                r'\.call\(\s*(?:[a-z_]+\s*,\s*)?"([A-Za-z]+\.[A-Za-z]+)"',
                text))
            via_generic |= set(re.findall(
                r'cdp_call\(\s*(?:[a-z_]+\s*,\s*)?"([A-Za-z]+\.[A-Za-z]+)"',
                text))
        # Runtime.evaluate / Page.navigate reach .call() only from the
        # base-class evaluate()/navigate(), both shadowed by ProxyCDP
        # with dedicated routes; they never touch /cdp/call.
        via_generic -= {"Runtime.evaluate", "Page.navigate"}
        missing = via_generic - allowed
        assert not missing, \
            "generic /cdp/call methods missing from the proxy allowlist: %s" \
            % sorted(missing)
    check("proxy-generic-call-methods-allowlisted", _run)


def _t_no_sandbox_root_only():
    def _run():
        real = os.geteuid
        try:
            os.geteuid = lambda: 0
            assert lc._no_sandbox_args() == ["--no-sandbox"]
            os.geteuid = lambda: 1000
            assert lc._no_sandbox_args() == []
        finally:
            os.geteuid = real
    check("no-sandbox-root-only", _run)


def _t_no_sandbox_launch_site():
    # The launch site must gate on _no_sandbox_args(), not on a raw
    # euid check, and must warn loudly when it fires.
    def _run():
        import inspect
        src = inspect.getsource(lc.ChromiumLauncher._launch_private)
        assert "_no_sandbox_args()" in src
        assert "WARNING" in src
    check("no-sandbox-launch-site-gated", _run)


def _t_proxy_bypass_list_explicit():
    # W5-P2-2: the loopback proxy bypass must be pinned EXPLICITLY in
    # the launch args, not left to Chromium's implicit (M72+,
    # undocumented, version-specific) behavior. The <-loopback> token
    # means the OPPOSITE (it subtracts the implicit bypass and sends
    # loopback THROUGH the proxy, which would break the helper API and
    # the form-host page) and must never appear at the launch site.
    def _run():
        import inspect
        src = inspect.getsource(lc.ChromiumLauncher._launch_private)
        assert "--proxy-bypass-list=localhost,127.0.0.1,::1" in src, \
            "explicit loopback bypass list missing at launch site"
        # The dangerous form is the quoted flag value; the explanatory
        # comment in the source names the token without quoting it.
        assert '"--proxy-bypass-list=<-loopback>"' not in src, \
            "<-loopback> would route loopback through the proxy"
    check("proxy-bypass-list-explicit", _run)


def _t_component_extensions_disabled():
    # W5-P2-6: component extensions (built-in, separate vector from
    # --disable-extensions) must have their background pages disabled
    # explicitly at launch.
    def _run():
        import inspect
        src = inspect.getsource(lc.ChromiumLauncher._launch_private)
        assert "--disable-component-extensions-with-background-pages" in src
    check("component-extensions-disabled", _run)


# -- W4-P2-8: HTTPS-only navigation ------------------------------------------

def _t_https_nav_guard():
    def _run():
        lc._assert_https_nav_url("https://tenant.instructure.com/")
        for bad in ("http://tenant.instructure.com/",
                    "file:///etc/passwd",
                    "javascript:alert(1)",
                    "data:text/html,<h1>x</h1>",
                    ""):
            try:
                lc._assert_https_nav_url(bad)
            except ValueError:
                continue
            raise AssertionError("must refuse %r" % (bad,))
        try:
            lc._assert_https_nav_url(None)
        except ValueError:
            return
        raise AssertionError("must refuse None")
    check("https-nav-guard", _run)


def _t_navigate_refuses_http_before_cdp():
    def _run():
        r1, w1 = os.pipe()
        r2, w2 = os.pipe()
        cdp = lc.PipeCDP(1, owner="selftest", read_fd=r1, write_fd=w2)
        try:
            try:
                cdp.navigate({"id": "t"}, "http://evil.example/")
            except ValueError:
                return
            raise AssertionError("PipeCDP.navigate must refuse http")
        finally:
            # Close through the transport: it owns read_fd/write_fd via
            # os.fdopen and runs a reader thread. Raw os.close() on those
            # fds double-closes them, and a later GC pass can then close
            # the reused fd number out from under an unrelated open()
            # (flaky EBADF in later tests). w1/r2 stay ours to close.
            cdp.close()
            for fd in (w1, r2):
                try:
                    os.close(fd)
                except OSError:
                    pass
    check("navigate-refuses-http", _run)


# -- W4-P1-13: download denial, fail closed ----------------------------------

def _t_download_deny_fail_closed():
    def _run():
        # Happy path: deny is applied browser-wide.
        launcher = lc.ChromiumLauncher.__new__(lc.ChromiumLauncher)
        launcher.cdp = _FakeCDP()
        launcher._apply_download_deny()
        assert ("Browser.setDownloadBehavior",
                {"behavior": "deny"}) in launcher.cdp.calls

        # Failure path: deny must be fail-closed, not best-effort.
        class _DenyFails(lc.CDP):
            def __init__(self):
                super().__init__(port=1, owner="selftest")

            def call(self, tab, method, params=None, timeout=30):
                raise RuntimeError("boom")

        launcher2 = lc.ChromiumLauncher.__new__(lc.ChromiumLauncher)
        launcher2.cdp = _DenyFails()
        try:
            launcher2._apply_download_deny()
        except RuntimeError as exc:
            assert "download" in str(exc).lower()
            return
        raise AssertionError("deny failure must be fail-closed")
    check("download-deny-fail-closed", _run)


# -- W4-P1-12: isolated-world API probes -------------------------------------

def _t_create_isolated_world_frame_id():
    # The world creation must resolve the root frameId first; calling
    # Page.createIsolatedWorld without a frameId is a CDP error.
    def _run():
        fake = _FakeCDP()
        ctx = fake.create_isolated_world({"id": "t"}, "morrow_probe")
        assert ctx == 77
        calls = [m for m, _p in fake.calls]
        assert "Page.getFrameTree" in calls
        assert "Page.createIsolatedWorld" in calls
        ciw = [p for m, p in fake.calls
               if m == "Page.createIsolatedWorld"][0]
        assert ciw.get("frameId") == "F-top"
    check("create-isolated-world-uses-frame-id", _run)


def _t_create_isolated_world_no_tree():
    def _run():
        class _NoTree(_FakeCDP):
            def call(self, tab, method, params=None, timeout=30):
                if method == "Page.getFrameTree":
                    return {"frameTree": {"frame": {}}}
                return super().call(tab, method, params, timeout)
        try:
            _NoTree().create_isolated_world({"id": "t"}, "w")
        except lc.CDPError as exc:
            assert "root frame" in str(exc)
            return
        raise AssertionError("missing frame id must raise")
    check("create-isolated-world-no-tree-refused", _run)


def _t_api_probe_uses_isolated_world():
    # API calls evaluate in an isolated world, never the page's default
    # realm (page JS can replace window.fetch; W4-P1-12).
    def _run():
        fake = _FakeCDP()
        transport = _transport_with(fake)
        status, _headers, body = transport.api("GET", "/api/v1/courses")
        assert status == 200
        assert json.loads(body)["id"] == 7
        worlds = [ctx for _e, ctx, _a in fake.evaluations
                  if ctx is not None]
        assert worlds, "API must run in an isolated world, got %r" % \
            (fake.evaluations,)
        assert all(ctx == 77 for ctx in worlds)
        ciw = [p for m, p in fake.calls
               if m == "Page.createIsolatedWorld"]
        assert ciw and ciw[0]["worldName"] == "morrow_api_probe"
    check("api-probe-uses-isolated-world", _run)


# -- transport happy paths ---------------------------------------------------

def _t_ensure_session_ok():
    def _run():
        fake = _FakeCDP()
        transport = _transport_with(fake)
        assert transport.ensure_session() == (7, "T")
    check("ensure-session-ok", _run)


def _t_ensure_session_dead_on_401():
    def _run():
        class _Dead(_FakeCDP):
            def evaluate(self, tab, expression, await_promise=False,
                         timeout=30, context_id=None):
                self.evaluations.append((expression, context_id,
                                         await_promise))
                return json.dumps({"ok": True, "status": 401, "body": ""})
        transport = _transport_with(_Dead())
        try:
            transport.ensure_session()
        except lc.SessionDead:
            return
        raise AssertionError("401 must raise SessionDead")
    check("ensure-session-dead-on-401", _run)


def _t_api_post_program():
    def _run():
        fake = _FakeCDP()
        transport = _transport_with(fake)
        status, _headers, _body = transport.api("POST", "/api/v1/courses",
                                                {"name": "x"})
        assert status == 200
        post = [e for e, _c, _a in fake.evaluations if '"POST"' in e]
        assert post, "POST must evaluate the POST-capable fetch program"
    check("api-post-program", _run)


def _t_api_refuses_redirect():
    def _run():
        class _Redirect(_FakeCDP):
            def evaluate(self, tab, expression, await_promise=False,
                         timeout=30, context_id=None):
                self.evaluations.append((expression, context_id,
                                         await_promise))
                return json.dumps({"ok": True, "status": 302,
                                   "redirected": True,
                                   "url": "https://t/login", "body": ""})
        transport = _transport_with(_Redirect())
        try:
            transport.api("GET", "/api/v1/courses")
        except lc.SessionDead:
            return
        raise AssertionError("API redirect must raise SessionDead")
    check("api-refuses-redirect", _run)


def _t_api_refuses_login_html():
    def _run():
        class _LoginHtml(_FakeCDP):
            def evaluate(self, tab, expression, await_promise=False,
                         timeout=30, context_id=None):
                self.evaluations.append((expression, context_id,
                                         await_promise))
                return json.dumps({
                    "ok": True, "status": 200,
                    "body": "<html><body><title>Log In</title>"
                            '<input type="password" name="pseudonym_session'
                            '[password]"></body></html>'})
        transport = _transport_with(_LoginHtml())
        try:
            transport.api("GET", "/api/v1/courses")
        except lc.SessionDead:
            return
        raise AssertionError("login HTML body must raise SessionDead")
    check("api-refuses-login-html", _run)


def _t_api_refuses_login_url():
    def _run():
        class _LoginUrl(_FakeCDP):
            def evaluate(self, tab, expression, await_promise=False,
                         timeout=30, context_id=None):
                self.evaluations.append((expression, context_id,
                                         await_promise))
                return json.dumps({"ok": True, "status": 200,
                                   "body": '{"a":1}',
                                   "url": "https://t/login?x=1"})
        transport = _transport_with(_LoginUrl())
        try:
            transport.api("GET", "/api/v1/courses")
        except lc.SessionDead:
            return
        raise AssertionError("login URL must raise SessionDead")
    check("api-refuses-login-url", _run)


def _t_api_truncated_header():
    # A truncated body is not an error: it is flagged in the headers so
    # the caller never mistakes a cut body for a full one (W2-P2-8).
    def _run():
        class _Trunc(_FakeCDP):
            def evaluate(self, tab, expression, await_promise=False,
                         timeout=30, context_id=None):
                self.evaluations.append((expression, context_id,
                                         await_promise))
                return json.dumps({"ok": True, "status": 200,
                                   "body": "x" * 10, "truncated": True})
        transport = _transport_with(_Trunc())
        status, headers, _body = transport.api("GET", "/api/v1/courses",
                                               max_bytes=10)
        assert status == 200
        assert "x-morrow-truncated" in headers
    check("api-truncated-header", _run)


def _t_api_retry_after_header():
    def _run():
        class _Retry(_FakeCDP):
            def evaluate(self, tab, expression, await_promise=False,
                         timeout=30, context_id=None):
                self.evaluations.append((expression, context_id,
                                         await_promise))
                return json.dumps({"ok": True, "status": 429,
                                   "retryAfter": "0", "body": ""})
        transport = _transport_with(_Retry())
        status, headers, _body = transport.api("GET", "/api/v1/courses")
        assert status == 429
        assert headers.get("retry-after") == "0"
    check("api-retry-after-header", _run)


def _t_api_js_origin_scoped():
    # The fetch program must be same-origin by construction: it fetches
    # a RELATIVE path (the tab is already on the tenant origin), never
    # an absolute URL, and no tenant hostname is hardcoded into it
    # (W4-P1-12 sibling: no cross-origin session use).
    def _run():
        import re
        src = open(os.path.join(HERE, "local_chromium.py")).read()
        m = re.search(r'_API_JS = r"""(.*?)"""', src, re.S)
        assert m, "_API_JS must be present"
        js = m.group(1)
        assert "fetch(" in js
        assert "http://" not in js and "https://" not in js, \
            "fetch program must not contain absolute URLs"
        assert "instructure.com" not in js
    check("api-js-origin-scoped", _run)


def _t_api_js_no_token_echo():
    # The session rides first-party cookies (no Authorization header is
    # ever set), and the returned envelope is a fixed key allowlist:
    # {status, url, body, link, retryAfter, truncated, redirected,
    #  csrf_missing}. The csrf_missing boolean is the only signal that
    # may cross back about the token (W4-CSRF fail-closed); the token
    # value itself never does. Request headers and document.cookie
    # must never cross back.
    def _run():
        import re
        src = open(os.path.join(HERE, "local_chromium.py")).read()
        m = re.search(r'_API_JS = r"""(.*?)"""', src, re.S)
        js = m.group(1)
        finals = [mm.start() for mm in re.finditer(r"return \{", js)]
        assert finals, "the fetch program must return an envelope"
        envelope = js[finals[-1]:finals[-1] + 300]
        keys = set(re.findall(r"(\w+)\s*:", envelope))
        assert keys <= {"status", "url", "body", "link", "retryAfter",
                        "truncated", "redirected", "csrf_missing"}, keys
        assert "headers" not in keys and "cookie" not in keys
    check("api-js-no-token-echo", _run)


def _t_api_js_csrf_missing_fail_closed():
    # W4-CSRF: the fetch program must refuse a write with no harvestable
    # _csrf_token BEFORE any network call, signalling csrf_missing.
    def _run():
        import re
        src = open(os.path.join(HERE, "local_chromium.py")).read()
        m = re.search(r'_API_JS = r"""(.*?)"""', src, re.S)
        js = m.group(1)
        assert "csrf_missing: true" in js, \
            "the fetch program must carry the csrf_missing fail-closed signal"
        # The refusal must precede the fetch call textually and be gated
        # on needsCsrf with the harvest check.
        idx_refuse = js.index("csrf_missing: true")
        idx_fetch = js.index("await fetch(")
        assert idx_refuse < idx_fetch, \
            "the csrf refusal must come before the fetch call"
        assert "needsCsrf && !harvest()" in js, \
            "the refusal must be gated on the live harvest, not a cached flag"
    check("api-js-csrf-missing-fail-closed", _run)


def _t_api_csrf_missing_raises():
    # W4-CSRF: api() turns the csrf_missing flag into a named refusal:
    # the write never reached the provider, and there is no retry of
    # the evaluate (a retry cannot conjure a cookie).
    def _run():
        class _NoCsrf(_FakeCDP):
            def evaluate(self, tab, expression, await_promise=False,
                         timeout=30, context_id=None):
                self.evaluations.append((expression, context_id,
                                         await_promise))
                return json.dumps({"status": 0, "url": "", "body": "",
                                   "link": None, "retryAfter": None,
                                   "truncated": False, "redirected": False,
                                   "csrf_missing": True})

        fake = _NoCsrf()
        launcher = lc.ChromiumLauncher.__new__(lc.ChromiumLauncher)
        launcher.cdp = fake
        t = lc.LocalChromiumTransport("https://t", launcher)
        try:
            t.api("POST", "/api/v1/courses/1/assignments",
                  {"assignment[name]": "x"})
        except RuntimeError as exc:
            msg = str(exc)
            assert "_csrf_token" in msg and "not sent" in msg, msg
        else:
            raise AssertionError("api() must refuse a csrf_missing write")
        evals = [e for e in fake.evaluations
                 if e[0] != "location.href"]
        assert len(evals) == 1, \
            "a csrf refusal must not be retried, got %d evaluates" % len(evals)
    check("api-csrf-missing-raises", _run)


# -- header capture ----------------------------------------------------------

def _t_capture_happy_path():
    def _run():
        fake = _FakeCDP()
        fake.events.append([
            {"method": "Network.requestWillBeSent",
             "params": {"request": {
                 "url": "https://t/api/v1/x",
                 "headers": {"Authorization": "Bearer TOK"}}}},
        ])

        def match(rurl, headers):
            return (rurl == "https://t/api/v1/x"
                    and "Authorization" in headers)

        url, headers = fake.capture_request_headers(
            {"id": "t"}, "https://t/", match, timeout=5)
        assert url == "https://t/api/v1/x"
        assert headers["Authorization"] == "Bearer TOK"
        calls = [m for m, _p in fake.calls]
        assert "Network.enable" in calls
        assert "Network.disable" in calls
    check("capture-happy-path", _run)


def _t_capture_timeout():
    def _run():
        fake = _FakeCDP()
        try:
            fake.capture_request_headers({"id": "t"}, "https://t/",
                                         lambda u, h: False, timeout=1)
        except TimeoutError:
            return
        raise AssertionError("capture timeout must raise TimeoutError")
    check("capture-timeout", _run)


# -- helper-holder verification (attach path) --------------------------------

class _StatusHandler(BaseHTTPRequestHandler):
    payload = b"{}"

    def do_GET(self):
        if self.path == "/status":
            body = self.payload
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *a):
        pass


@contextlib.contextmanager
def _status_server(payload):
    _StatusHandler.payload = json.dumps(payload).encode()
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _StatusHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        yield srv.server_address[1]
    finally:
        srv.shutdown()


def _fake_proc_tree(root, pids):
    """pids: {pid: (ppid, [argv...])}. Writes a minimal /proc."""
    for pid, (ppid, argv) in pids.items():
        d = os.path.join(root, str(pid))
        os.makedirs(d, exist_ok=True)
        cmdline = b"\x00".join(a.encode() for a in argv) + b"\x00"
        with open(os.path.join(d, "cmdline"), "wb") as fh:
            fh.write(cmdline)
        with open(os.path.join(d, "stat"), "w") as fh:
            fh.write("%d (chrome) S %d 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 "
                     "0 0 0 0\n" % (pid, ppid))


def _holder_args(profile):
    return ["chrome", "--headless=new", "--remote-debugging-pipe",
            "--user-data-dir=%s" % profile, "about:blank"]


def _t_verify_helper_holder_match_ok():
    def _run():
        d = _mk_scratch("holder-ok")
        profile = os.path.join(d, "profile")
        os.makedirs(profile, exist_ok=True)
        proc = os.path.join(d, "proc")
        os.makedirs(proc, exist_ok=True)
        _fake_proc_tree(proc, {4242: (1, _holder_args(profile))})
        version = lc._tree_version()
        launcher = lc.ChromiumLauncher.__new__(lc.ChromiumLauncher)
        launcher.profile_dir = profile
        with _status_server({"helper_version": version,
                             "chromium_alive": True,
                             "starting": False}) as port:
            launcher._verify_helper_holder(
                server_port=port, proc_root=proc)  # must not raise
    check("verify-helper-holder-match-ok", _run)


def _t_verify_helper_holder_version_mismatch():
    def _run():
        d = _mk_scratch("holder-version")
        profile = os.path.join(d, "profile")
        os.makedirs(profile, exist_ok=True)
        proc = os.path.join(d, "proc")
        os.makedirs(proc, exist_ok=True)
        _fake_proc_tree(proc, {4242: (1, _holder_args(profile))})
        launcher = lc.ChromiumLauncher.__new__(lc.ChromiumLauncher)
        launcher.profile_dir = profile
        with _status_server({"helper_version": "stale-1.0.0",
                             "chromium_alive": True,
                             "starting": False}) as port:
            try:
                launcher._verify_helper_holder(
                    server_port=port, proc_root=proc)
            except RuntimeError as exc:
                assert "helper_version" in str(exc)
                return
            raise AssertionError("stale helper version must be refused")
    check("verify-helper-holder-version-mismatch", _run)


def _t_verify_helper_holder_foreign_refused():
    def _run():
        d = _mk_scratch("holder-foreign")
        mine = os.path.join(d, "mine")
        other = os.path.join(d, "other")
        os.makedirs(mine, exist_ok=True)
        os.makedirs(other, exist_ok=True)
        proc = os.path.join(d, "proc")
        os.makedirs(proc, exist_ok=True)
        _fake_proc_tree(proc, {4242: (1, _holder_args(other))})
        launcher = lc.ChromiumLauncher.__new__(lc.ChromiumLauncher)
        launcher.profile_dir = mine
        with _status_server({"helper_version": lc._tree_version(),
                             "chromium_alive": True,
                             "starting": False}) as port:
            try:
                launcher._verify_helper_holder(
                    server_port=port, proc_root=proc)
            except RuntimeError as exc:
                assert "pipe" in str(exc).lower()
                return
            raise AssertionError("foreign-profile holder must be refused")
    check("verify-helper-holder-foreign-refused", _run)


def _t_verify_helper_holder_no_holder():
    def _run():
        d = _mk_scratch("holder-none")
        profile = os.path.join(d, "profile")
        os.makedirs(profile, exist_ok=True)
        proc = os.path.join(d, "proc")
        os.makedirs(proc, exist_ok=True)
        launcher = lc.ChromiumLauncher.__new__(lc.ChromiumLauncher)
        launcher.profile_dir = profile
        with _status_server({"helper_version": lc._tree_version(),
                             "chromium_alive": True,
                             "starting": False}) as port:
            try:
                launcher._verify_helper_holder(
                    server_port=port, proc_root=proc)
            except RuntimeError as exc:
                assert "pipe" in str(exc).lower()
                return
            raise AssertionError("missing holder must be refused")
    check("verify-helper-holder-no-holder", _run)


def _t_verify_helper_holder_unreachable():
    def _run():
        d = _mk_scratch("holder-down")
        profile = os.path.join(d, "profile")
        os.makedirs(profile, exist_ok=True)
        proc = os.path.join(d, "proc")
        os.makedirs(proc, exist_ok=True)
        launcher = lc.ChromiumLauncher.__new__(lc.ChromiumLauncher)
        launcher.profile_dir = profile
        try:
            launcher._verify_helper_holder(server_port=1, proc_root=proc)
        except RuntimeError as exc:
            assert "helper" in str(exc).lower()
            return
        raise AssertionError("unreachable helper must be refused")
    check("verify-helper-holder-unreachable", _run)


# -- tree config surface -----------------------------------------------------

def _t_tree_profile_default():
    def _run():
        def _go():
            assert lc.tree_helper_profile_dir() == os.path.join(
                lc.tree_root(), "helper", "profile")
        _with_env({k: v for k, v in os.environ.items()
                   if k != "LOGIN_HELPER_PROFILE_DIR"}, _go)
    check("tree-profile-default", _run)


def _t_tree_profile_env():
    def _run():
        d = _mk_scratch("profile-env")
        p = os.path.join(d, "x-profile")
        def _go():
            assert lc.tree_helper_profile_dir() == p
        _with_env({"LOGIN_HELPER_PROFILE_DIR": p}, _go)
    check("tree-profile-env", _run)


def _t_tree_cdp_port_default():
    def _run():
        def _go():
            assert lc.tree_cdp_port() == lc.HELPER_CDP_PORT
        _with_env({k: v for k, v in os.environ.items()
                   if k != "LOGIN_HELPER_CDP_PORT"}, _go)
    check("tree-cdp-port-default", _run)


def _t_tree_cdp_port_env():
    def _run():
        def _go():
            assert lc.tree_cdp_port() == 19223
        _with_env({"LOGIN_HELPER_CDP_PORT": "19223"}, _go)
    check("tree-cdp-port-env", _run)


def _t_tree_helper_port_default():
    def _run():
        def _go():
            assert lc.tree_helper_port() == 8901
        _with_env({k: v for k, v in os.environ.items()
                   if k != "LOGIN_HELPER_PORT"}, _go)
    check("tree-helper-port-default", _run)


def _t_tab_registry_concurrent_rmw():
    # LANE2-D7: concurrent register/touch/unregister cycles must not
    # lose registrations. The old code locked the data file around the
    # read and again around the write (truncating before locking), so
    # interleaved read-modify-writes silently discarded entries.
    def _run():
        d = _mk_scratch("tab-registry-concurrency")
        launcher = object.__new__(lc.ChromiumLauncher)
        launcher.profile_dir = d
        barrier = threading.Barrier(16)

        def _worker(i):
            barrier.wait()
            for _n in range(10):
                launcher.register_tab("tab-%d" % i)
                launcher.touch_tab("tab-%d" % i)

        workers = [threading.Thread(target=_worker, args=(i,))
                   for i in range(16)]
        for w in workers:
            w.start()
        for w in workers:
            w.join(timeout=120)
        assert not any(w.is_alive() for w in workers), "worker hung"
        reg = lc._read_tab_registry(d)
        missing = ["tab-%d" % i for i in range(16) if "tab-%d" % i not in reg]
        assert not missing, "lost registrations: %s" % missing
        mode = oct(os.stat(os.path.join(
            d, "morrow-tab-registry.json")).st_mode & 0o777)
        assert mode == "0o600", "registry not 0600: %s" % mode
    check("tab-registry-concurrent-rmw", _run)


def _t_reap_idle_tabs_keeps_concurrent_updates():
    # LANE2-D15: the reap is two-phase (snapshot under lock, CDP work
    # without the lock, conditional writeback). A touch/register that
    # lands between the snapshot and the writeback must survive: the
    # writeback removes only entries unchanged since the snapshot.
    def _run():
        d = _mk_scratch("tab-reap-concurrent")
        launcher = object.__new__(lc.ChromiumLauncher)
        launcher.profile_dir = d
        entered_tabs = threading.Event()
        release_tabs = threading.Event()

        class _FakeCDP:
            def __init__(self):
                self.closed = []

            def tabs(self):
                entered_tabs.set()
                assert release_tabs.wait(timeout=30), "reap hung in tabs()"
                return [{"id": "A", "url": "about:blank"},
                        {"id": "B", "url": "about:blank"},
                        {"id": "C", "url": "about:blank"}]

            def close_tab(self, spec):
                self.closed.append(spec["id"])

        launcher.cdp = _FakeCDP()
        launcher.register_tab("A")
        launcher.register_tab("B")
        old = time.time() - 3600
        with lc._tab_registry_locked(d):
            reg = lc._read_tab_registry_data(d)
            reg["A"]["touched"] = old
            reg["B"]["touched"] = old
            lc._write_tab_registry_data(d, reg)

        result = {}

        def _reap():
            result["reaped"] = launcher.reap_idle_tabs(60)

        t = threading.Thread(target=_reap)
        t.start()
        assert entered_tabs.wait(timeout=30), "reap never reached tabs()"
        # Concurrent mutations land between the snapshot and the
        # writeback: B is touched (fresh activity), C is registered.
        launcher.touch_tab("B")
        touched_b = lc._read_tab_registry(d)["B"]["touched"]
        assert touched_b > old, "touch did not refresh B"
        launcher.register_tab("C")
        release_tabs.set()
        t.join(timeout=60)
        assert not t.is_alive(), "reap hung"

        assert set(launcher.cdp.closed) == {"A", "B"}, launcher.cdp.closed
        # LANE2-D15b: only closed-AND-removed tabs are reported as
        # reaped. B was closed but its concurrent touch kept the
        # registry entry, so B is not reported as reaped.
        assert set(result["reaped"]) == {"A"}, result["reaped"]
        reg = lc._read_tab_registry(d)
        assert "A" not in reg, "A was not removed: %s" % (reg,)
        # B's concurrent touch survives the conditional writeback...
        assert "B" in reg, "concurrent touch discarded: %s" % (reg,)
        assert reg["B"]["touched"] == touched_b, reg["B"]
        # ...and so does C's concurrent registration.
        assert "C" in reg, "concurrent registration discarded: %s" % (reg,)
    check("tab-reap-keeps-concurrent-updates", _run)


def _t_reap_idle_tabs_missing_live_prune_keeps_concurrent_touch():
    # LANE2-D15b: a registry entry whose tab is already gone from the
    # live listing is pruned, but a concurrent touch still vetoes the
    # prune. Pruned entries are never reported as reaped.
    def _run():
        d = _mk_scratch("tab-reap-missing-live")
        launcher = object.__new__(lc.ChromiumLauncher)
        launcher.profile_dir = d
        entered_tabs = threading.Event()
        release_tabs = threading.Event()

        class _FakeCDP:
            def tabs(self):
                entered_tabs.set()
                assert release_tabs.wait(timeout=30), "reap hung in tabs()"
                return []  # every registered tab is already gone

            def close_tab(self, spec):
                raise AssertionError("close_tab on a missing tab")

        launcher.cdp = _FakeCDP()
        launcher.register_tab("A")
        launcher.register_tab("B")
        old = time.time() - 3600
        with lc._tab_registry_locked(d):
            reg = lc._read_tab_registry_data(d)
            reg["A"]["touched"] = old
            reg["B"]["touched"] = old
            lc._write_tab_registry_data(d, reg)

        result = {}

        def _reap():
            result["reaped"] = launcher.reap_idle_tabs(60)

        t = threading.Thread(target=_reap)
        t.start()
        assert entered_tabs.wait(timeout=30), "reap never reached tabs()"
        # B is touched while the reap is blocked inside tabs(), i.e.
        # after the snapshot: the entry is fresh, so the reap must not
        # prune it, even though the tab is gone from the live listing.
        launcher.touch_tab("B")
        touched_b = lc._read_tab_registry(d)["B"]["touched"]
        assert touched_b > old, "touch did not refresh B"
        release_tabs.set()
        t.join(timeout=60)
        assert not t.is_alive(), "reap hung"

        assert result["reaped"] == [], result["reaped"]
        reg = lc._read_tab_registry(d)
        assert "A" not in reg, "stale entry not pruned: %s" % (reg,)
        assert reg["B"]["touched"] == touched_b, \
            "concurrent touch pruned: %s" % (reg,)
    check("tab-reap-missing-live-prune-keeps-concurrent-touch", _run)


def _t_reap_idle_tabs_concurrent_protect_vetoes_close():    # LANE2-D15b: a set_tab_protected that lands while the reap is
    # blocked in CDP vetoes the close. Protection is a safety property;
    # the snapshot predates it, so the reap re-reads current metadata
    # before close_tab.
    def _run():
        d = _mk_scratch("tab-reap-concurrent-protect")
        launcher = object.__new__(lc.ChromiumLauncher)
        launcher.profile_dir = d
        entered_tabs = threading.Event()
        release_tabs = threading.Event()

        class _FakeCDP:
            def __init__(self):
                self.closed = []

            def tabs(self):
                entered_tabs.set()
                assert release_tabs.wait(timeout=30), "reap hung in tabs()"
                return [{"id": "A", "url": "about:blank"},
                        {"id": "B", "url": "about:blank"}]

            def close_tab(self, spec):
                self.closed.append(spec["id"])

        launcher.cdp = _FakeCDP()
        launcher.register_tab("A")
        launcher.register_tab("B")
        old = time.time() - 3600
        with lc._tab_registry_locked(d):
            reg = lc._read_tab_registry_data(d)
            reg["A"]["touched"] = old
            reg["B"]["touched"] = old
            lc._write_tab_registry_data(d, reg)

        result = {}

        def _reap():
            result["reaped"] = launcher.reap_idle_tabs(60)

        t = threading.Thread(target=_reap)
        t.start()
        assert entered_tabs.wait(timeout=30), "reap never reached tabs()"
        # B is protected while the reap is blocked inside tabs(): the
        # snapshot still shows it unprotected and idle.
        launcher.set_tab_protected("B", True)
        release_tabs.set()
        t.join(timeout=60)
        assert not t.is_alive(), "reap hung"

        assert launcher.cdp.closed == ["A"], launcher.cdp.closed
        assert result["reaped"] == ["A"], result["reaped"]
        reg = lc._read_tab_registry(d)
        assert "A" not in reg, "A was not removed: %s" % (reg,)
        assert reg["B"].get("protect") is True, \
            "concurrent protect discarded: %s" % (reg,)
    check("tab-reap-concurrent-protect-vetoes-close", _run)


def _t_launch_private_timeout_cleans_up():
    # LANE2-D8: when the launched Chromium never answers on the CDP
    # pipe, _launch_private must terminate the child, not orphan it.
    def _run():
        d = _mk_scratch("launch-cleanup-timeout")
        launcher, bin_path = _mk_test_launcher(d, "fake-chromium-timeout")

        class _SilentCDP:
            def __init__(self, *a, **k):
                pass

            def tabs(self):
                raise RuntimeError("no cdp answer")

            def close(self):
                pass

        old_cdp = lc.PipeCDP
        lc.PipeCDP = _SilentCDP
        try:
            try:
                launcher._launch_private(timeout=2)
            except RuntimeError as exc:
                assert "did not answer" in str(exc), str(exc)
            else:
                raise AssertionError("expected RuntimeError")
        finally:
            lc.PipeCDP = old_cdp
        assert launcher.proc is None, "proc handle not cleared"
        assert launcher.cdp is None, "cdp not cleared"
        _assert_no_cmdline_fragment(bin_path, "chromium child")
    check("launch-private-timeout-cleans-up", _run)


def _t_launch_private_download_deny_cleans_up():
    # LANE2-D8: when the download-deny guard refuses after a successful
    # launch, the just-started Chromium must still be terminated.
    def _run():
        d = _mk_scratch("launch-cleanup-deny")
        launcher, bin_path = _mk_test_launcher(d, "fake-chromium-deny")

        class _DeafCDP:
            def __init__(self, *a, **k):
                pass

            def tabs(self):
                return [{"id": "T", "type": "page", "url": "about:blank"}]

            def close(self):
                pass

        def _deny_fails():
            raise RuntimeError("deny refused")
        launcher._apply_download_deny = _deny_fails
        old_cdp = lc.PipeCDP
        lc.PipeCDP = _DeafCDP
        try:
            try:
                launcher._launch_private(timeout=5)
            except RuntimeError as exc:
                assert "deny refused" in str(exc), str(exc)
            else:
                raise AssertionError("expected RuntimeError")
        finally:
            lc.PipeCDP = old_cdp
        assert launcher.proc is None, "proc handle not cleared"
        assert launcher.cdp is None, "cdp not cleared"
        _assert_no_cmdline_fragment(bin_path, "chromium child")
    check("launch-private-download-deny-cleans-up", _run)


def _t_launch_private_forwarder_failure_cleans_up():
    # LANE2-D8: when the egress forwarder fails to come up after its
    # child was spawned, the forwarder child must be terminated too.
    def _run():
        d = _mk_scratch("launch-cleanup-forwarder")
        launcher, _bin = _mk_test_launcher(d, "fake-chromium-fw")
        pids = []

        def _failing_forwarder():
            proc = subprocess.Popen(["sleep", "60"])
            pids.append(proc.pid)
            launcher.forwarder_proc = proc
            raise RuntimeError("proxy forwarder did not start")
        launcher._start_forwarder = _failing_forwarder
        try:
            launcher._launch_private(timeout=5)
        except RuntimeError as exc:
            assert "forwarder did not start" in str(exc), str(exc)
        else:
            raise AssertionError("expected RuntimeError")
        assert launcher.forwarder_proc is None, "forwarder handle kept"
        assert launcher.proc is None, "proc handle set without launch"
        assert pids, "forwarder child was never spawned"
        _assert_pid_dead(pids[0], "forwarder child")
    check("launch-private-forwarder-failure-cleans-up", _run)


def _mk_test_launcher(d, name):
    bin_path = _fake_binary(
        d, name, "#!/usr/bin/env python3\nimport time\ntime.sleep(60)\n")
    launcher = object.__new__(lc.ChromiumLauncher)
    launcher.binary = bin_path
    launcher.profile_dir = os.path.join(d, name + "-profile")
    launcher.cdp_port = lc.HELPER_CDP_PORT
    launcher.proxy = None
    launcher.extra_args = []
    launcher.forwarder_port = 19876
    launcher.forwarder_script = os.path.join(d, "nope.py")
    launcher.proc = None
    launcher.forwarder_proc = None
    launcher.cdp = None
    launcher.attached = False
    launcher._egress_probe = {"mode": "direct", "needs_forwarder": False}
    return launcher, bin_path


def _command_lines():
    """[(pid, command line bytes)] of every process: from /proc where the
    host has it, else from ps (macOS)."""
    if not os.path.isdir("/proc/self"):
        out = subprocess.run(["ps", "-axww", "-o", "pid=,command="],
                             capture_output=True, check=True).stdout
        return [tuple(line.strip().split(b" ", 1)) for line in
                out.splitlines() if b" " in line.strip()]
    found = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open("/proc/%s/cmdline" % pid, "rb") as fh:
                found.append((pid, fh.read()))
        except (FileNotFoundError, PermissionError):
            continue
    return found


def _assert_no_cmdline_fragment(fragment, what):
    for pid, data in _command_lines():
        if fragment.encode() in data:
            raise AssertionError(
                "orphaned %s still running: pid %s" % (what, pid))


def _assert_pid_dead(pid, what):
    deadline = time.monotonic() + 10
    while True:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        except PermissionError:
            raise AssertionError(
                "%s pid %d still alive (permission)" % (what, pid))
        if time.monotonic() >= deadline:
            raise AssertionError(
                "%s pid %d still alive after 10s" % (what, pid))
        time.sleep(0.1)


def _t_tree_state_dir():
    def _run():
        d = _mk_scratch("state-dir")
        def _go():
            assert lc.tree_state_dir() == os.path.join(d, "state")
        _with_env({"MORROW_TREE_STATE_DIR": os.path.join(d, "state")},
                  _go)
    check("tree-state-dir", _run)


def _t_launcher_forwarder_port_from_cdp():
    # The forwarder port derives per-tree from the CDP identity label
    # (+10000); explicit constructor arg wins, then the env override.
    def _run():
        d = _mk_scratch("fw-bin")
        binpath = _fake_binary(d, "chrome",
                               '#!/bin/sh\necho "Chromium 152.0.7977.82"\n')

        def _go():
            return lc.ChromiumLauncher(
                binpath,
                os.path.join(_mk_scratch("fw"), "p"),
                cdp_port=19224).forwarder_port
        got = _with_env(
            {k: v for k, v in os.environ.items()
             if k not in ("MORROW_FORWARDER_PORT",
                         "LOGIN_HELPER_CDP_PORT")},
            _go)
        assert got == 29224, got

        def _go2():
            return lc.ChromiumLauncher(
                binpath,
                os.path.join(_mk_scratch("fw2"), "p")).forwarder_port
        got2 = _with_env({"MORROW_FORWARDER_PORT": "9222"}, _go2)
        assert got2 == 9222
    check("launcher-forwarder-port-from-cdp", _run)


# -- tab identity / exact origin ---------------------------------------------

def _t_exact_origin_tab_selection():
    def _run():
        transport = _transport_with(_FakeCDP())
        with transport._tab_lock:
            tab = transport._tenant_tab_locked()
        assert tab["id"] == "fake-tab"
    check("exact-origin-tab-selection", _run)


def _t_tenant_tab_rejects_evil_sibling():
    def _run():
        class _Evil(_FakeCDP):
            def tabs(self):
                return [{"id": "evil", "type": "page",
                         "url": "https://t.evil.example/"}]
        transport = _transport_with(_Evil())
        with transport._tab_lock:
            # No tenant tab exists: a fresh tab is opened and navigated
            # to the tenant base (the fake navigates fine). The evil
            # sibling must never be returned as the tenant tab.
            tab = transport._tenant_tab_locked()
        assert tab["id"] != "evil", \
            "sibling host must never satisfy the tenant tab"
    check("tenant-tab-rejects-evil-sibling", _run)


def _t_is_tenant_url():
    def _run():
        assert lc.is_tenant_url("https://t/courses/1", "https://t/")
        assert not lc.is_tenant_url("https://t.evil.example/",
                                    "https://t/")
        assert not lc.is_tenant_url("http://t/courses/1", "https://t/")
    check("is-tenant-url", _run)


def _t_looks_like_login_page():
    def _run():
        # Markers are HTML-shaped: doctype/<html> + password field (or a
        # login/sign-in title). A JSON body mentioning "login" is never
        # flagged.
        assert lc._looks_like_login_page(
            '<html><body><title>Log In</title>'
            '<input type="password" name="pseudonym_session[password]">'
            "</body></html>")
        assert not lc._looks_like_login_page('{"courses": []}')
        assert not lc._looks_like_login_page('{"message": "login ok"}')
    check("looks-like-login-page", _run)


def _t_forwarder_holder_exact():
    # find_chromium_pids is exact-identity, proc_root injectable.
    def _run():
        d = _mk_scratch("forwarder-holder")
        profile = os.path.join(d, "profile")
        os.makedirs(profile, exist_ok=True)
        proc = os.path.join(d, "proc")
        os.makedirs(proc, exist_ok=True)
        _fake_proc_tree(proc, {
            100: (1, _holder_args(profile)),
            101: (1, ["chrome", "--headless=new",
                      "--remote-debugging-pipe",
                      "--user-data-dir=%s/x" % profile, "about:blank"]),
            102: (1, ["chrome", "--headless=new",
                      "--user-data-dir=%s" % profile, "about:blank"]),
        })
        assert lc.find_chromium_pids(profile, proc_root=proc) == [100]
    check("forwarder-holder-exact", _run)


# -- W5-P2-3: pipe FDs close on unexpected browser death -------------------

def _t_pipe_fds_close_on_browser_death():
    def _run():
        # Two pipes: the transport reads r1 (browser stdout) and writes
        # w2 (browser stdin). Closing w1 simulates the browser dying:
        # the transport's read sees EOF.
        r1, w1 = os.pipe()
        r2, w2 = os.pipe()
        t = lc._PipeTransport(r1, w2)
        try:
            os.close(w1)  # browser death: EOF on the read side
            t._reader.join(timeout=10)
            assert not t._reader.is_alive(), "reader thread must exit on EOF"
            assert t._r.closed, "owned read FD must close on browser death"
            assert t._w.closed, "owned write FD must close on browser death"
            # Idempotent: a later close() is a no-op, not a double-close.
            t.close()
            assert t._r.closed and t._w.closed
            # Sends fail fast after death instead of writing a dead pipe.
            try:
                t.send("Nope.ping", {}, timeout=2)
            except lc.CDPError:
                pass
            else:
                raise AssertionError("send after death must raise CDPError")
        finally:
            for fd in (r2,):
                try:
                    os.close(fd)
                except OSError:
                    pass
    check("pipe-fds-close-on-browser-death", _run)


def _t_pipe_fds_close_idempotent():
    def _run():
        # close() first, then the browser dies: the reader's finally
        # must not double-close or raise.
        r1, w1 = os.pipe()
        r2, w2 = os.pipe()
        t = lc._PipeTransport(r1, w2)
        t.close()
        assert t._r.closed and t._w.closed
        os.close(w1)  # browser death after close
        t._reader.join(timeout=10)
        assert not t._reader.is_alive()
        assert t._r.closed and t._w.closed
        os.close(r2)
    check("pipe-fds-close-idempotent", _run)


# -- opt-in live browser (pipe framing proof) --------------------------------

def _t_live_browser_pipe():
    if os.environ.get("MORROW_SELFTEST_LIVE_BROWSER") != "1":
        print("skip live-browser-pipe (set "
              "MORROW_SELFTEST_LIVE_BROWSER=1 to run)")
        return

    def _run():
        d = _mk_scratch("live-%d" % int(time.time()))
        profile = os.path.join(d, "profile")
        binary = lc.default_binary()
        launcher = lc.ChromiumLauncher(profile_dir=profile, binary=binary)
        # LOGIN_HELPER_OWN_BROWSER=1: launch a private pipe browser
        # directly. Without it, start() would probe the helper HTTP
        # port, and the live helper's bound socket would send us down
        # the attach path (which correctly refuses: the live browser
        # does not hold this scratch profile). The live helper is never
        # touched by this test.
        old = os.environ.get("LOGIN_HELPER_OWN_BROWSER")
        os.environ["LOGIN_HELPER_OWN_BROWSER"] = "1"
        try:
            try:
                result = launcher.start()
            finally:
                if old is None:
                    os.environ.pop("LOGIN_HELPER_OWN_BROWSER", None)
                else:
                    os.environ["LOGIN_HELPER_OWN_BROWSER"] = old
            assert result == "launched", result
            # framing works: a real round trip over the pipe.
            tab = launcher.cdp.new_tab("about:blank")
            assert tab.get("id"), "new_tab must return a tab id"
            got = launcher.cdp.evaluate(tab, "1+1", timeout=15)
            assert got == 2, \
                "pipe round trip must return 2, got %r" % got
            # event flow: real CDP events arrive over the pipe. Enable
            # the Page domain, navigate (about:blank keeps this off the
            # network), and drain session events until a Page.* event
            # shows up.
            launcher.cdp.call(tab, "Page.enable", {}, timeout=15)
            launcher.cdp.call(tab, "Page.navigate",
                              {"url": "about:blank"}, timeout=15)
            seen = []
            deadline = time.time() + 20
            while time.time() < deadline and not seen:
                for ev in launcher.cdp.poll_session_events(tab, timeout=5):
                    if isinstance(ev, dict) \
                            and ev.get("method", "").startswith("Page."):
                        seen.append(ev["method"])
            assert seen, \
                "expected Page.* CDP events over the pipe, got none"
            launcher.cdp.close_tab(tab)
            tabs = launcher.cdp.tabs()
            assert any(t.get("id") for t in tabs)
        finally:
            pid = launcher.proc.pid if launcher.proc else None
            launcher.stop()
            if pid:
                time.sleep(1)
                try:
                    os.kill(pid, 0)
                except OSError:
                    pass  # gone: exact-PID cleanup verified
                else:
                    os.kill(pid, signal.SIGKILL)
                    raise AssertionError(
                        "chromium pid %d survived stop()" % pid)
            shutil.rmtree(d, ignore_errors=True)
    check("live-browser-pipe", _run)


TESTS = [
    _t_cdp_ownerless_refused,
    _t_cdp_ownerless_refused_none,
    _t_cdp_owner_accepted,
    _t_no_tcp_probe_helpers,
    _t_no_debugging_port_flag,
    _t_verify_forwarder_holder_own_ok,
    _t_verify_forwarder_holder_foreign_refused,
    _t_verify_forwarder_holder_not_forwarder_refused,
    _t_proc_environ_real,
    _t_version_floor_ok,
    _t_version_floor_chrome_brand,
    _t_version_floor_below,
    _t_version_floor_garbage,
    _t_version_floor_nonzero_exit,
    _t_version_floor_missing_binary,
    _t_chromium_bin_override_ok,
    _t_chromium_bin_bad_fails_fast,
    _t_chromium_bin_old_version_fails_fast,
    _t_launcher_rejects_missing_binary_at_construction,
    _t_launcher_rejects_non_executable_binary,
    _t_launcher_rejects_directory_binary,
    _t_launcher_normalizes_binary_path,
    _t_launcher_start_version_gates_exact_binary,
    _t_launcher_start_rejects_garbage_version,
    _t_proxy_generic_call_methods_allowlisted,
    _t_no_sandbox_root_only,
    _t_no_sandbox_launch_site,
    _t_proxy_bypass_list_explicit,
    _t_component_extensions_disabled,
    _t_navigate_refuses_http_before_cdp,
    _t_https_nav_guard,
    _t_download_deny_fail_closed,
    _t_create_isolated_world_frame_id,
    _t_create_isolated_world_no_tree,
    _t_api_probe_uses_isolated_world,
    _t_ensure_session_ok,
    _t_ensure_session_dead_on_401,
    _t_api_post_program,
    _t_api_refuses_redirect,
    _t_api_refuses_login_html,
    _t_api_refuses_login_url,
    _t_api_truncated_header,
    _t_api_retry_after_header,
    _t_api_js_origin_scoped,
    _t_api_js_no_token_echo,
    _t_api_js_csrf_missing_fail_closed,
    _t_api_csrf_missing_raises,
    _t_capture_happy_path,
    _t_capture_timeout,
    _t_verify_helper_holder_match_ok,
    _t_verify_helper_holder_version_mismatch,
    _t_verify_helper_holder_foreign_refused,
    _t_verify_helper_holder_no_holder,
    _t_verify_helper_holder_unreachable,
    _t_tree_profile_default,
    _t_tree_profile_env,
    _t_tree_cdp_port_default,
    _t_tree_cdp_port_env,
    _t_tree_helper_port_default,
    _t_tree_state_dir,
    _t_tab_registry_concurrent_rmw,
    _t_reap_idle_tabs_keeps_concurrent_updates,
    _t_reap_idle_tabs_missing_live_prune_keeps_concurrent_touch,
    _t_reap_idle_tabs_concurrent_protect_vetoes_close,
    _t_launch_private_timeout_cleans_up,
    _t_launch_private_download_deny_cleans_up,
    _t_launch_private_forwarder_failure_cleans_up,
    _t_launcher_forwarder_port_from_cdp,
    _t_exact_origin_tab_selection,
    _t_tenant_tab_rejects_evil_sibling,
    _t_is_tenant_url,
    _t_looks_like_login_page,
    _t_forwarder_holder_exact,
    _t_pipe_fds_close_on_browser_death,
    _t_pipe_fds_close_idempotent,
    _t_live_browser_pipe,
]


def main():
    shutil.rmtree(SCRATCH, ignore_errors=True)
    os.makedirs(SCRATCH, exist_ok=True)
    for fn in TESTS:
        fn()
    print("local_chromium selftest: %d passed, %d failed"
          % (len(PASS), len(FAIL)))
    for name, detail in FAIL:
        print("FAIL %s: %s" % (name, detail))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
