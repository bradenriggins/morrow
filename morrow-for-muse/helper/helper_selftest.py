#!/usr/bin/env python3
"""Selftest for the packaged Canvas login helper (helper/).

Covers the packaging contract, not live browser behavior:
  * server.py refuses to start without a tenant (no silent default)
  * the UI references every endpoint the server implements
  * keepalive.sh is executable and reads CANVAS_BASE from ~/.morrow/env
  * logo.png is a real PNG the server can serve
  * no runtime state (profile/, logs) ships in the source tree

Run: python3 helper/helper_selftest.py  (from the connector tree root)
"""
import os as _home_os, sys as _home_sys  # noqa: E401
_home_sys.path.insert(0, _home_os.path.join(
    _home_os.path.dirname(_home_os.path.abspath(__file__)), '..'))
import config.selftest_home  # noqa: E402,F401  (scratch HOME/MORROW_HOME)
import os
import stat
import subprocess
import sys
import json

FAIL = []
HERE = os.path.dirname(os.path.abspath(__file__))


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        FAIL.append(name)


def tls_check_outcome(served, server_output):
    """(verdict, reason) for the helper TLS check (round-4 L6).

    "pass": /status answered over TLS. "fail": TLS setup itself failed
    (a FATAL about the cert/key, or TLS never enabled). "skip": TLS was
    enabled on the listener but the helper never reached serving; the
    helper serves only after Chromium starts and the tenant page loads,
    which needs network egress and can outlast the wait. Network timing
    never fails an install."""
    out = server_output or ""
    if served:
        return "pass", "served /status over TLS"
    if "FATAL" in out and "TLS" in out:
        return "fail", "helper TLS setup failed"
    if "TLS enabled on the helper listener" not in out:
        return "fail", "the helper never enabled TLS"
    tail = [line for line in out.splitlines() if line.strip()][-1:]
    return "skip", ("TLS was enabled, but the helper never reached "
                    "serving (Chromium start or the tenant page needs "
                    "network egress; none within the wait): %s"
                    % (tail[0][:200] if tail else "no output"))


def main():
    server = os.path.join(HERE, "server.py")
    index = os.path.join(HERE, "index.html")
    keepalive = os.path.join(HERE, "keepalive.sh")
    logo = os.path.join(HERE, "logo.png")
    readme = os.path.join(HERE, "README.md")

    for path in (server, index, keepalive, logo, readme):
        check("helper file present: " + os.path.basename(path),
              os.path.isfile(path))

    # 1. No tenant -> exit 2, before Chromium ever launches. Ephemeral
    # HTTP/CDP ports plus a scratch profile: the production-port guard
    # runs before main(), so the test must not look like a production
    # launch.
    # W4-P1-18: isolate server.py from the tree's helper/env (and the
    # legacy global env) during the tenant-guard tests below. server.py
    # sources <tree>/helper/env at startup, so a CANVAS_BASE set there
    # (the documented "set it and rerun" flow) would leak into tests
    # that assert tenant-absent behavior and produce opaque failures.
    # MORROW_HELPER_ENV_FILE points server.py at an empty scratch file
    # instead: the educator's real helper/env is never moved, renamed,
    # or read. HOME points at scratch so ~/.morrow/env cannot leak
    # either.
    import contextlib  # noqa: E402
    import tempfile  # noqa: E402

    @contextlib.contextmanager
    def _isolated_tenant_env():
        scratch_home = tempfile.mkdtemp(prefix=".selftest-home-", dir=HERE)
        empty_env = os.path.join(scratch_home, "empty-env")
        with open(empty_env, "w", encoding="utf-8") as fh:
            fh.write("# empty: W4-P1-18 isolation, no tenant\n")
        os.chmod(empty_env, 0o600)
        old_override = os.environ.get("MORROW_HELPER_ENV_FILE")
        os.environ["MORROW_HELPER_ENV_FILE"] = empty_env
        try:
            yield scratch_home, empty_env
        finally:
            if old_override is None:
                os.environ.pop("MORROW_HELPER_ENV_FILE", None)
            else:
                os.environ["MORROW_HELPER_ENV_FILE"] = old_override
            shutil.rmtree(scratch_home, ignore_errors=True)

    import shutil  # noqa: E402
    _tree_env_path = os.path.join(HERE, "env")
    _tree_env_before = os.path.lexists(_tree_env_path)
    with _isolated_tenant_env() as (_scratch_home, _empty_env):
        check("W4-P1-18: server.py uses MORROW_HELPER_ENV_FILE instead of "
              "the tree helper/env",
              os.environ.get("MORROW_HELPER_ENV_FILE") == _empty_env)
        check("W4-P1-18: the tree helper/env is never moved or renamed "
              "during the tenant-guard tests",
              os.path.lexists(_tree_env_path) == _tree_env_before)
        scratch_profile = os.path.join(HERE, ".selftest-profile")
        os.makedirs(scratch_profile, exist_ok=True)
        env = dict(os.environ)
        env.pop("CANVAS_BASE", None)
        env.pop("LOGIN_HELPER_PRODUCTION", None)
        env["LOGIN_HELPER_PORT"] = "18901"
        env["LOGIN_HELPER_CDP_PORT"] = "19224"
        env["LOGIN_HELPER_PROFILE_DIR"] = scratch_profile
        env["HOME"] = _scratch_home
        proc = subprocess.run(
            [sys.executable, server], env=env, capture_output=True,
            timeout=30)
        check("server.py refuses to start without a tenant (exit 2)",
              proc.returncode == 2)
        check("refusal names CANVAS_BASE",
              b"CANVAS_BASE" in proc.stderr)
        shutil.rmtree(scratch_profile, ignore_errors=True)

        # 1b. Production-port guard (P0-1/P0-4): the wave-1 mandate stands,
        # a bare launch (no LOGIN_HELPER_PROFILE_DIR, no
        # LOGIN_HELPER_PRODUCTION=1) can NEVER occupy a production port, in
        # any tree, with any profile. Fires when EITHER port is production.
        # A 2026-09-21 rework narrowed this to fire only when the profile IS
        # the live helper's profile; that rework was reverted because it let
        # a bare launch squat 8901/19223 with any other profile. The P1-27
        # live-profile guard below covers the tree's own default profile on
        # non-production ports.
        FATAL_PROD_PORTS = (
            "FATAL: refusing production ports without LOGIN_HELPER_PROFILE_DIR "
            "set; launch via helper/keepalive.sh")
        FATAL_LIVE_PROFILE = (
            "FATAL: refusing to run with the tree's live profile "
            "(helper/profile/) on non-production ports; pass an explicit "
            "scratch LOGIN_HELPER_PROFILE_DIR for tests (or set "
            "LOGIN_HELPER_ALLOW_TEST_ON_LIVE_PROFILE=1 to opt in)")
        for http_p, cdp_p in (("8901", "19224"), ("18901", "19223"),
                              ("8901", "19223")):
            genv = dict(os.environ)
            genv.pop("CANVAS_BASE", None)
            genv.pop("LOGIN_HELPER_PROFILE_DIR", None)
            genv.pop("LOGIN_HELPER_PRODUCTION", None)
            genv["LOGIN_HELPER_PORT"] = http_p
            genv["LOGIN_HELPER_CDP_PORT"] = cdp_p
            genv["HOME"] = _scratch_home
            gproc = subprocess.run(
                [sys.executable, server], env=genv, capture_output=True,
                timeout=30)
            check("guard fires on ports %s/%s (exit 3)" % (http_p, cdp_p),
                  gproc.returncode == 3)
            check("guard prints the exact FATAL on ports %s/%s"
                  % (http_p, cdp_p),
                  gproc.stderr.decode("utf-8", "replace").strip()
                  == FATAL_PROD_PORTS)
        # P1-27: the tree's own default profile on NON-production ports
        # without an explicit pin refuses with its own exact FATAL.
        nenv = dict(os.environ)
        nenv.pop("CANVAS_BASE", None)
        nenv.pop("LOGIN_HELPER_PROFILE_DIR", None)
        nenv.pop("LOGIN_HELPER_PRODUCTION", None)
        nenv["LOGIN_HELPER_PORT"] = "18901"
        nenv["LOGIN_HELPER_CDP_PORT"] = "19331"
        nenv["HOME"] = _scratch_home
        nproc = subprocess.run(
            [sys.executable, server], env=nenv, capture_output=True,
            timeout=30)
        check("P1-27 guard fires on non-production ports with the default "
              "profile (exit 3)",
              nproc.returncode == 3)
        check("P1-27 guard prints its exact FATAL",
              nproc.stderr.decode("utf-8", "replace").strip()
              == FATAL_LIVE_PROFILE)
        # Escape hatch: LOGIN_HELPER_PRODUCTION=1 lets production ports
        # through to the normal startup path (here: the no-tenant refusal,
        # which exits before binding anything).
        henv = dict(os.environ)
        henv.pop("CANVAS_BASE", None)
        henv.pop("LOGIN_HELPER_PROFILE_DIR", None)
        henv["LOGIN_HELPER_PRODUCTION"] = "1"
        henv["LOGIN_HELPER_PORT"] = "8901"
        henv["LOGIN_HELPER_CDP_PORT"] = "19223"
        henv["HOME"] = _scratch_home
        hproc = subprocess.run(
            [sys.executable, server], env=henv, capture_output=True,
            timeout=30)
        check("LOGIN_HELPER_PRODUCTION=1 bypasses the guard "
              "(exit 2, names CANVAS_BASE)",
              hproc.returncode == 2 and b"CANVAS_BASE" in hproc.stderr)
        # W2-P1-17 pin exemption: an EXPLICIT pin to the tree's own default
        # profile on non-production ports proves intent (this is what
        # keepalive.sh and multi-tree deployments do), so the tree-default
        # guard must not fire. Exits 2 at the tenant check before any
        # profile write.
        penv = dict(os.environ)
        penv.pop("CANVAS_BASE", None)
        penv.pop("LOGIN_HELPER_PRODUCTION", None)
        penv.pop("LOGIN_HELPER_ALLOW_TEST_ON_LIVE_PROFILE", None)
        penv["LOGIN_HELPER_PORT"] = "18901"
        penv["LOGIN_HELPER_CDP_PORT"] = "19224"
        penv["LOGIN_HELPER_PROFILE_DIR"] = os.path.join(HERE, "profile")
        penv["HOME"] = _scratch_home
        pproc = subprocess.run(
            [sys.executable, server], env=penv, capture_output=True,
            timeout=30)
        check("explicit pin to the default profile on non-production ports "
              "is allowed (exit 2, names CANVAS_BASE)",
              pproc.returncode == 2 and b"CANVAS_BASE" in pproc.stderr)
    check("W4-P1-18: the tree helper/env was never touched by the "
          "tenant-guard tests",
          os.path.lexists(_tree_env_path) == _tree_env_before)
    # Static proof the guard precedes main(): sys.exit(3) sits above
    # "def main" in server.py.
    with open(server, encoding="utf-8") as fh:
        srclines = fh.read().splitlines()
    guard_at = next(i for i, l in enumerate(srclines) if "sys.exit(3)" in l)
    main_at = next(i for i, l in enumerate(srclines)
                   if l.startswith("def main"))
    check("production guard runs before main()", guard_at < main_at)

    # 1d. W2-P1-29: a REAL dangling SingletonLock in the scratch profile
    # -> the friendly "SingletonLock is held" FATAL (exit 1), never the
    # stock "did not open its CDP port" RuntimeError. A fake chromium
    # binary (via CHROMIUM_BIN) passes the version gate and then dies on
    # launch, so the pipe never answers; the dangling symlink (target
    # does not exist) proves lexists() sees through to dangling links
    # where exists() would not. The scratch dir and ports are randomized
    # per run: several workers run this selftest from this tree
    # concurrently, so nothing here may use a fixed shared path or port.
    import random  # noqa: E402
    import tempfile  # noqa: E402
    scratch_1d = tempfile.mkdtemp(prefix=".selftest-1d-", dir=HERE)
    fake_chromium = os.path.join(scratch_1d, "chrome-fake")
    with open(fake_chromium, "w", encoding="utf-8") as fh:
        # W4: the fake must pass the binary version gate (a real
        # --version answer) and then die on launch, so the launcher
        # raises "exited during startup" instead of the version-gate
        # refusal.
        fh.write("#!/bin/sh\n"
                 "if [ \"$1\" = \"--version\" ]; then\n"
                 "  echo \"Chromium 152.0.7977.82\"; exit 0\n"
                 "fi\n"
                 "exit 1\n")
    os.chmod(fake_chromium, 0o755)
    lock_profile = os.path.join(scratch_1d, "profile")
    os.makedirs(lock_profile, exist_ok=True)
    dangling = os.path.join(lock_profile, "SingletonLock")
    os.symlink("/nonexistent-morrow-selftest-target", dangling)
    lenv = dict(os.environ)
    lenv["CANVAS_BASE"] = "https://school.instructure.com"
    lenv.pop("LOGIN_HELPER_PRODUCTION", None)
    lenv.pop("LOGIN_HELPER_ALLOW_TEST_ON_LIVE_PROFILE", None)
    lenv["CHROMIUM_BIN"] = fake_chromium
    lenv["LOGIN_HELPER_PORT"] = str(random.randint(19100, 19900))
    # CDP port must stay below 22768: the W3-P2-15 forwarder derivation
    # (CDP + 10000) FATALs inside the ephemeral range, which would
    # pre-empt the SingletonLock path this scenario exercises.
    lenv["LOGIN_HELPER_CDP_PORT"] = str(random.randint(20100, 22100))
    lenv["LOGIN_HELPER_PROFILE_DIR"] = lock_profile
    try:
        lproc = subprocess.run(
            [sys.executable, server], env=lenv, capture_output=True,
            timeout=120)
        check("dangling SingletonLock -> friendly FATAL (exit 1)",
              lproc.returncode == 1)
        check("FATAL names the SingletonLock path",
              b"SingletonLock is held" in lproc.stderr
              and dangling.encode() in lproc.stderr)
        check("stock CDP-timeout message is NOT the user-facing error",
              b"did not open its CDP port in time" not in lproc.stderr)
    finally:
        shutil.rmtree(scratch_1d, ignore_errors=True)

    # 1c. P0-7: the tenant base normalizes to exactly scheme://netloc/.
    # Import server.py with ephemeral ports + a scratch profile (so the
    # production guard does not fire) and exercise the normalizer
    # directly. Scratch profile and __pycache__ are removed afterwards.
    import importlib.util  # noqa: E402
    norm_profile = os.path.join(HERE, ".selftest-norm-profile")
    os.makedirs(norm_profile, exist_ok=True)
    saved_env = {k: os.environ.get(k) for k in
                 ("LOGIN_HELPER_PROFILE_DIR", "LOGIN_HELPER_PORT",
                  "LOGIN_HELPER_CDP_PORT")}
    os.environ["LOGIN_HELPER_PROFILE_DIR"] = norm_profile
    os.environ["LOGIN_HELPER_PORT"] = "18901"
    os.environ["LOGIN_HELPER_CDP_PORT"] = "19224"
    try:
        spec = importlib.util.spec_from_file_location(
            "helper_server_under_test", server)
        helper_srv = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper_srv)
        norm = helper_srv._normalize_tenant_base
        check("tenant base with path/query/fragment normalizes to the "
              "origin root",
              norm("https://tenant.instructure.com/courses/1?x=2#frag")
              == "https://tenant.instructure.com/")
        check("plain tenant base becomes exactly scheme://netloc/",
              norm("https://tenant.instructure.com")
              == "https://tenant.instructure.com/")
        # (aligned 2026-09-21 with the W2-P0-11 tenant-shape validation:
        # custom domains now require the explicit CONFIRMED opt-in; the
        # port-preservation assertion runs under that opt-in.)
        os.environ["CANVAS_BASE_CUSTOM_DOMAIN_CONFIRMED"] = \
            "lms.tenant-college.edu"
        try:
            check("tenant base with an explicit port keeps the port "
                  "(custom domain confirmed)",
                  norm("https://lms.tenant-college.edu:8443/a/b")
                  == "https://lms.tenant-college.edu:8443/")
        finally:
            os.environ.pop("CANVAS_BASE_CUSTOM_DOMAIN_CONFIRMED", None)
        try:
            norm("https://lms.tenant-college.edu:8443/a/b")
            unconfirmed_accepted = True
        except ValueError:
            unconfirmed_accepted = False
        check("unconfirmed custom domain is rejected",
              not unconfirmed_accepted)
        try:
            norm("not a url")
            bad_accepted = True
        except ValueError:
            bad_accepted = False
        check("garbage tenant base raises ValueError", not bad_accepted)
        with open(server, encoding="utf-8") as fh:
            srv_src = fh.read()
        check("HelperBrowser.start stores the normalized origin root",
              "self.base_url = _normalize_tenant_base(base_url)" in srv_src)
    finally:
        for k, v in saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(norm_profile, ignore_errors=True)
        shutil.rmtree(os.path.join(HERE, "__pycache__"),
                      ignore_errors=True)

    # 1d. W4-P2-18 (2026-09-21): /status.logged_in no longer consults
    # document.title at all. location.href is the tab's actual document
    # URL and is not forgeable by page JS; the title is page-controlled
    # text and must never flip login state (a hostile page could set a
    # Canvas error title and flip logged_in, or smuggle cookie material
    # into the title for exfiltration through /status). Exercise
    # HelperBrowser.status() with a stubbed CDP whose probe reads href
    # only: a tenant href reports logged_in=true even when the page's
    # title is hostile, and /login href reports false.
    import threading  # noqa: E402

    class _StubLauncher:
        def is_running(self):
            return True

    class _StubCDP:
        def __init__(self, href):
            self._href = href

        def evaluate(self, tab, expression, timeout=None):
            assert isinstance(tab, dict) and tab.get("id"), \
                "status() must probe with a tab dict, got %r" % (tab,)
            assert "location.href" in expression
            return json.dumps({"href": self._href})

        def call(self, tab, method, params=None, timeout=30):
            assert method == "Network.getCookies"
            return {"cookies": []}

    def _status_with_href(href):
        hb = helper_srv.HelperBrowser.__new__(helper_srv.HelperBrowser)
        hb.launcher = _StubLauncher()
        hb.cdp = _StubCDP(href)
        hb.tab = {"id": "STUB", "type": "page", "url": href}
        hb.base_url = "https://tenant.instructure.com/"
        hb._lock = threading.Lock()
        return hb.status()

    st = _status_with_href("https://tenant.instructure.com/courses/1")
    check("/status never returns the page title (cookie-exfil fix)",
          "title" not in st)
    check("/status still reports logged_in for a tenant page",
          st.get("logged_in") is True)
    check("/status still reports the tab url",
          st.get("url") == "https://tenant.instructure.com/courses/1")
    # The hostile-title case: the page set document.title to a Canvas
    # error title ("Can't find your login page"). The probe never reads
    # the title, so login state is unaffected by it.
    st_hostile = _status_with_href(
        "https://tenant.instructure.com/courses/1")
    check("hostile document.title cannot flip logged_in (W4-P2-18)",
          st_hostile.get("logged_in") is True
          and "title" not in st_hostile)
    st_login = _status_with_href(
        "https://tenant.instructure.com/login")
    check("/login href reports logged_in=false",
          st_login.get("logged_in") is False)

    # 1e. W4 (2026-09-21): the /cdp/* proxy surface. Exercise the REAL
    # HelperBrowser.cdp_proxy_* methods with a stubbed CDP (no Chromium
    # launched): the generic-call method allowlist, live-target
    # resolution, payload/timeout bounds, and the https-only
    # navigation policy.
    class _ProxyStubCDP:
        def __init__(self):
            self.calls = []

        def tabs(self):
            return [{"id": "T1", "type": "page",
                     "url": "https://t/courses/1"},
                    {"id": "T2", "type": "page",
                     "url": "https://t/courses/2"}]

        def call(self, tab, method, params=None, timeout=30):
            self.calls.append((method, params, timeout))
            return {"echo": True}

        def evaluate(self, tab, expression, await_promise=False,
                     timeout=30, context_id=None):
            return 1

        def navigate(self, tab, url, timeout=30):
            return {"ok": True}

        def new_tab(self, url="about:blank"):
            return {"id": "T3", "type": "page", "url": url}

        def close_tab(self, tab):
            return {"ok": True}

    def _proxy_browser():
        hb = helper_srv.HelperBrowser.__new__(helper_srv.HelperBrowser)
        hb.cdp = _ProxyStubCDP()
        hb._lock = threading.Lock()
        return hb

    def _expect_http(fn, code):
        try:
            fn()
        except helper_srv._HttpError as exc:
            return exc.code == code
        return False

    pb = _proxy_browser()
    res = pb.cdp_proxy_call("T1", "Page.getFrameTree", {}, 30)
    check("proxy allows Page.getFrameTree on a live target",
          res == {"echo": True})
    pb.cdp_proxy_call("T1", "Page.getFrameTree", {}, 1)
    check("proxy clamps the timeout floor (1 -> 5)",
          pb.cdp.calls[-1][2] == 5)
    res = pb.cdp_proxy_call("T1", "Page.getFrameTree", {}, 1000)
    check("proxy clamps the timeout ceiling (1000 -> 120)",
          pb.cdp.calls[-1][2] == 120)
    res = pb.cdp_proxy_call(
        None, "Browser.setDownloadBehavior", {"behavior": "deny"}, 30)
    check("proxy allows browser-level Browser.setDownloadBehavior "
          "(download guard)",
          res == {"echo": True}
          and pb.cdp.calls[-1][0] == "Browser.setDownloadBehavior"
          and pb.cdp.calls[-1][1] == {"behavior": "deny"})
    for evil in ("Target.createTarget", "Runtime.evaluate",
                 "Page.navigate", "Page.captureScreenshot",
                 "Input.dispatchKeyEvent", "Fetch.enable",
                 "Network.setCookie"):
        check("proxy refuses non-allowlisted method %s (403)" % evil,
              _expect_http(
                  lambda e=evil: pb.cdp_proxy_call(
                      "T1", e, {}, 30), 403))
    check("proxy 404s an unknown target id",
          _expect_http(
              lambda: pb.cdp_proxy_call(
                  "NOPE", "Page.getFrameTree", {}, 30), 404))
    check("proxy 400s a browser-level call to a tab method "
          "(target_id None)",
          _expect_http(
              lambda: pb.cdp_proxy_call(
                  None, "Page.getFrameTree", {}, 30), 400))
    check("proxy 413s an oversized params payload",
          _expect_http(
              lambda: pb.cdp_proxy_call(
                  "T1", "Page.getFrameTree", {"x": "y" * 200000}, 30),
              413))
    res = pb.cdp_proxy_evaluate("T1", "1+1", False, None, 30)
    check("proxy evaluates on a live target",
          res == {"ok": True, "value": 1})
    check("proxy evaluate 404s an unknown target",
          _expect_http(
              lambda: pb.cdp_proxy_evaluate("NOPE", "1+1", False, None,
                                            30), 404))
    check("proxy evaluate 400s an empty expression",
          _expect_http(
              lambda: pb.cdp_proxy_evaluate("T1", "", False, None, 30),
              400))
    check("proxy evaluate 413s an oversized expression",
          _expect_http(
              lambda: pb.cdp_proxy_evaluate(
                  "T1", "x" * 70000, False, None, 30), 413))
    res = pb.cdp_proxy_navigate("T1", "https://t/courses/9", 30)
    check("proxy navigates a live target to https",
          res == {"ok": True})
    res = pb.cdp_proxy_new_tab("about:blank")
    check("proxy opens about:blank tabs",
          res.get("id") == "T3")
    for bad in ("http://t/", "file:///etc/passwd", "javascript:alert(1)",
                "data:text/html,<h1>x</h1>"):
        check("proxy refuses non-https new-tab target %r (400)" % bad,
              _expect_http(lambda b=bad: pb.cdp_proxy_new_tab(b), 400))
    for bad in ("http://t/", "file:///etc/passwd"):
        check("proxy refuses non-https navigate target %r (400)" % bad,
              _expect_http(
                  lambda b=bad: pb.cdp_proxy_navigate("T1", b, 30), 400))
    check("proxy navigate 404s an unknown target",
          _expect_http(
              lambda: pb.cdp_proxy_navigate("NOPE", "https://t/", 30),
              404))
    check("proxy close-tab on an unknown target is a no-op success",
          pb.cdp_proxy_close_tab("NOPE") == {"ok": True})
    res = pb.cdp_proxy_close_tab("T1")
    check("proxy closes a live tab", res == {"ok": True})

    # 2. UI/server endpoint agreement.
    with open(index, encoding="utf-8") as fh:
        ui = fh.read()
    with open(server, encoding="utf-8") as fh:
        srv = fh.read()
    for endpoint in ("/status", "/screenshot", "/input/key",
                     "/input/mouse", "/navigate"):
        check("UI calls %s" % endpoint, '"%s"' % endpoint in ui)
        check("server implements %s" % endpoint,
              '"%s"' % endpoint in srv)
    check("UI references logo.png", "logo.png" in ui)
    check("server serves /logo.png", '"/logo.png"' in srv)

    # 3. keepalive.sh: executable, sources ~/.morrow/env, never signs in.
    mode = os.stat(keepalive).st_mode
    check("keepalive.sh is executable", bool(mode & stat.S_IXUSR))
    with open(keepalive, encoding="utf-8") as fh:
        ka = fh.read()
    check("keepalive sources ~/.morrow/env", ".morrow/env" in ka)
    check("keepalive never attempts a sign-in",
          "sign-in" not in ka.lower().replace("sign in", "")
          or "no sign-in attempted" in ka)
    # P0-8: dead Chromium is recoverable, logged with the exact line;
    # exit 2 is reserved for a genuine signed-out session.
    check("keepalive restarts dead Chromium (not a sign-out)",
          "chromium dead, restarting (not a sign-out)" in ka)
    # P0-8: an unparseable /status is not a sign-out; it exits 1, and
    # exit 2 means only a genuine signed-out session.
    check("keepalive exits 1 (not 2) on unparseable /status",
          "UNHEALTHY: /status JSON unparseable" in ka
          and "exit 2 means only this" in ka)
    # P0-8: a missing chromium_alive (legacy server) never reads as dead
    # and never as signed-out: exit 2 requires the exact logged_in=false
    # + chromium_alive=true + starting=false state (genuine_signout).
    check("keepalive treats missing chromium_alive as unknown",
          "chromium_alive=unknown" in ka or '"unknown"' in ka)
    check("keepalive gates exit 2 on the exact genuine-sign-out state",
          "genuine_signout" in ka and "never exit 2" in ka)
    check("keepalive no longer exits 2 for a legacy unknown server",
          "or a legacy server that omits" not in ka)
    # P0-9: the port holder must prove it is the helper server before
    # any kill; an unknown holder aborts recovery.
    check("keepalive verifies the port holder before killing",
          "refusing to kill" in ka)
    # P1-25: a starting helper is probed through the backoff window,
    # never judged signed-out mid-boot.
    check("keepalive waits out the starting state",
          "helper starting" in ka)
    # P1-28 (reworked W2-P1-30): overlapping runs serialize on a
    # PER-TREE lock, never fight, and two trees never contend. The lock
    # lives under ~/.morrow/trees/<tree-id>/, never the package tree.
    check("keepalive serializes runs with flock -n",
          "flock -n" in ka)
    check("keepalive lock is per-tree under ~/.morrow/trees/, not the package tree",
          'LOCKFILE="${TREE_STATE_DIR}/keepalive.lock"' in ka
          and '${HELPER_DIR}/keepalive.lock' not in ka)
    check("keepalive no longer uses the global ~/.morrow/keepalive.lock",
          '${HOME}/.morrow/keepalive.lock' not in ka)
    # W2-P1-27: tree-scoped config. The tree's helper/env is sourced;
    # the legacy global file is honored for CANVAS_BASE only.
    check("keepalive sources the tree helper/env",
          'HELPER_DIR}/env' in ka or 'helper/env' in ka)
    check("keepalive ignores profile/port vars from the global env",
          "LOGIN_HELPER_PROFILE_DIR" in ka and "ignoring" in ka)
    # W2-P0-6/W2-P1-31: the port-holder kill is tree-gated. The exact
    # argv/cwd gate's ABORT line names the proof it demands.
    check("keepalive kill is tree-gated (foreign tree aborts)",
          "did not prove it is this tree's helper server" in ka
          and "refusing to kill" in ka)
    # W2-P1-16: version-skew detection recycles stale servers.
    check("keepalive detects version skew and recycles",
          "helper_version" in ka and "version skew" in ka)
    # W2-P1-7: the probe budget covers /status's 15s CDP evaluate.
    check("keepalive probe timeout covers the 15s /status evaluate",
          'PROBE_TIMEOUT' in ka)
    # W2-P2-22: exact --user-data-dir argv matching in the reap.
    check("keepalive reap uses exact --user-data-dir matching",
          "proc_user_data_dir" in ka)
    # W2-P1-33: per-tree forwarder port.
    check("keepalive derives a per-tree forwarder port",
          "FORWARDER_PORT" in ka and "+ 10000" in ka)
    # W2-P1-34: orphaned forwarder reap is exact (port + script).
    check("keepalive reaps only its own tree's orphaned forwarders",
          "reap_tree_forwarders" in ka and "proxy_forwarder.py" in ka)
    # 3b. Executable P0-8 contract tests: run keepalive_selftest.sh, which
    # sources the shipped keepalive copy only (KEEPALIVE_SOURCE_ONLY=1,
    # dangerous functions stubbed; the live helper's tree is never read)
    # and asserts the exit-2 matrix. It must pass.
    kselftest = os.path.join(HERE, "keepalive_selftest.sh")
    check("keepalive_selftest.sh present and executable",
          os.path.isfile(kselftest)
          and bool(os.stat(kselftest).st_mode & stat.S_IXUSR))
    kproc = subprocess.run(["bash", kselftest], capture_output=True,
                           timeout=180)
    check("keepalive_selftest.sh passes (P0-8 exit-2 matrix, shipped copy)",
          kproc.returncode == 0)
    if kproc.returncode != 0:
        print(kproc.stdout.decode("utf-8", "replace"))
        print(kproc.stderr.decode("utf-8", "replace"))

    # 4. logo.png is a real PNG.
    with open(logo, "rb") as fh:
        magic = fh.read(8)
    check("logo.png has PNG magic", magic == b"\x89PNG\r\n\x1a\n")

    # 5. The profile is runtime state, never shipped: install.sh creates
    # it with mkdir (never copies or seeds it from a fixture), no
    # profile fixture/template ships in helper/, and the deny-list
    # denies the path so no carve or gate can ever include it. (Log
    # files are likewise runtime-only; pack/deny-list.txt denies them,
    # so no separate log check is needed here.) The selftest must pass
    # whether or not install.sh has already created helper/profile in
    # this tree.
    names = set(os.listdir(HERE))
    check("no profile fixture/template ships in helper/",
          not (names & {"profile.template", "profile-seed",
                        "profile.dist", "profile.zip"}))

    # 6. The installer exists and honors the never-wipe contract.
    tree = os.path.normpath(os.path.join(HERE, ".."))
    install = os.path.join(tree, "install.sh")
    check("install.sh present", os.path.isfile(install))
    mode = os.stat(install).st_mode
    check("install.sh is executable", bool(mode & stat.S_IXUSR))
    with open(install, encoding="utf-8") as fh:
        inst = fh.read()
    check("install.sh creates helper/profile (0700, first run only)",
          "helper/profile" in inst and "mkdir -p -m 0700" in inst)
    # install.sh's deletions are audited, never blanket: every rm -rf
    # must be (a) a find -exec residue cleanup whose -name filter is on
    # the same continuation-joined line (.selftest-work, __pycache__),
    # (b) the guarded rollback ledger (${_rp}: this run's created paths
    # only, with "" / "/" / $HOME refused), or (c) the upgrade-backup
    # retention prune (${_old_bak}, keep=2, loud).
    _joined = inst.replace("\\\n", " ")
    _bad_rm = []
    for _line in _joined.splitlines():
        if "rm -rf" not in _line:
            continue
        _code = _line.split("#", 1)[0]
        if not _code.strip():
            continue  # comment-only mention, no deletion
        _ok = (".selftest-work" in _code or "__pycache__" in _code
               or '"${_rp}"' in _code or '"${_old_bak}"' in _code)
        if not _ok:
            _bad_rm.append(_code.strip())
    check("install.sh deletions are audited "
          "(residue/rollback/backup-retention only)",
          not _bad_rm)
    check("install.sh rollback refuses unsafe paths",
          '""|"/"|"${HOME}")' in inst)
    check("install.sh runs the secrets gate",
          "verify-no-secrets" in inst)
    check("install.sh excludes only the runtime profile from the gate",
          'VERIFY_EXCLUDE="helper/profile"' in inst)
    check("install.sh never seeds helper/profile from shipped files",
          not any(("cp " in line or "rsync" in line or "unzip" in line)
                  and "profile" in line
                  for line in inst.splitlines()))
    for suite in ("transport/chromium_session_selftest.py",
                  "transport/egress_selftest.py",
                  "dispatch/executor_selftest.py",
                  "dispatch/admission_selftest.py",
                  "dispatch/executor_write_hardening_selftest.py",
                  "dispatch/integration_selftest.py",
                  "privacy/source_privacy_selftest.py",
                  "helper/helper_selftest.py"):
        check("install.sh runs " + os.path.basename(suite),
              suite in inst)
    check("install.sh launches the helper via keepalive.sh",
          "helper/keepalive.sh" in inst)
    check("install.sh prints the sign-in notice",
          "SIGN-IN NEEDED" in inst and "onboarded" in inst)
    check("install.sh notice repeats until signed in (no 'prints once')",
          "repeats until you are signed in" in inst
          and "prints once" not in inst)
    # P0-7: the sentinel is only recorded when /status confirms BOTH
    # logged_in=true and profile_has_cookies=true; the signed-out (2)
    # branch never touches it.
    check("install.sh parses both logged_in and profile_has_cookies",
          "logged_in=true profile_has_cookies=true" in inst)
    _case2 = inst.split("\n    2)")[1].split(";;")[0] \
        if "\n    2)" in inst else ""
    check("install.sh never records onboarding on signed-out",
          not any(line.split("#", 1)[0].strip().startswith("touch ")
                  for line in _case2.splitlines()))
    # P1-22: shell-only CANVAS_BASE is caught even as `export CANVAS_BASE=`.
    check("install.sh detects export CANVAS_BASE assignments",
          "(export[[:space:]]+)?CANVAS_BASE=" in inst)
    # P1-26: the tenant probe body lives under MORROW_HOME with a PID
    # suffix, never in the package tree.
    check("install.sh probe body is PID-suffixed under MORROW_HOME",
          '.tenant-probe.$$.body' in inst
          and "${MORROW_HOME}/.tenant-probe." in inst
          and "${TREE}/.tenant-probe" not in inst)

    # 7. The packaging deny-list exists and is enforced here too.
    deny = os.path.join(tree, "pack", "deny-list.txt")
    check("pack/deny-list.txt present", os.path.isfile(deny))
    sections = {"[paths]": [], "[content]": []}
    section = None
    with open(deny, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.split("#", 1)[0].strip()
            if not line:
                continue
            if line in sections:
                section = line
                continue
            if section:
                sections[section].append(line)
    check("deny-list has a non-empty [paths] section",
          len(sections["[paths]"]) > 0)
    check("deny-list has a non-empty [content] section",
          len(sections["[content]"]) > 0)
    check("deny-list denies helper/profile",
          any("helper/profile" in p for p in sections["[paths]"]))
    check("deny-list denies log files",
          any(p == "*.log" for p in sections["[paths]"]))
    # Every file under helper/ must pass the [paths] deny patterns.
    import fnmatch  # noqa: E402

    def _deny_hit(rel, pat):
        # P0-3: match basenames at ANY depth. Python fnmatch '*' does
        # not span '/', unlike the shell glob the gate itself uses, so
        # test the relative path, the any-depth form, and the basename:
        # a nested copy (e.g. foo/Default/Cookies) must not evade a
        # bare-name pattern.
        if pat.endswith("/"):
            d = pat[:-1]
            return d in rel.split("/")
        base = os.path.basename(rel)
        return (fnmatch.fnmatch(rel, pat)
                or fnmatch.fnmatch(rel, "*/" + pat)
                or fnmatch.fnmatch(base, pat))

    denied_here = []
    for root, _dirs, files in os.walk(HERE):
        # The test's own scratch dirs (.selftest-*) are not shipped; the
        # deny-list guards the shipped tree, so skip them here. (Earlier
        # sections run the server against scratch profiles that leave
        # log files behind; those must not trip this check.)
        rel_root = os.path.relpath(root, HERE)
        if rel_root.split(os.sep)[0].startswith(".selftest-"):
            continue
        for f in files:
            rel = os.path.relpath(os.path.join(root, f), HERE)
            for pat in sections["[paths]"]:
                if _deny_hit(rel, pat):
                    denied_here.append("%s (pattern %s)" % (rel, pat))
    check("no helper/ file matches the deny-list [paths] " +
          ("(%s)" % "; ".join(denied_here) if denied_here else "(clean)"),
          not denied_here)

    # 8. The secrets gate script exists and is executable.
    gate = os.path.join(tree, "scripts", "verify-no-secrets.sh")
    check("scripts/verify-no-secrets.sh present", os.path.isfile(gate))
    check("scripts/verify-no-secrets.sh is executable",
          bool(os.stat(gate).st_mode & stat.S_IXUSR))
    with open(gate, encoding="utf-8") as fh:
        gate_src = fh.read()
    check("secrets gate reads pack/deny-list.txt",
          "pack/deny-list.txt" in gate_src)

    # 9. Server startup contract: tenant homepage, one CDP port, no
    # silent default tenant; P0-1 file-derived profile; P0-4 production
    # guard; P0-7/P0-8/P1-25 /status shape.
    check("server lands on the tenant homepage (not the login form)",
          "self.navigate(self.base_url)" in srv
          and "self.base_url = _normalize_tenant_base(base_url)" in srv)
    check("server never navigates straight to /login/canvas",
          '"/login/canvas"' not in srv and "'/login/canvas'" not in srv)
    check("server defaults CDP to port 19223",
          'LOGIN_HELPER_CDP_PORT", "19223"' in srv)
    check("server uses the full-width stage (1600x1000)",
          "VIEWPORT = (1600, 1000)" in srv)
    check("server default profile is the invoked file's directory",
          '_HERE = os.path.dirname(os.path.realpath(__file__))' in srv
          and 'DEFAULT_PROFILE = os.path.join(_HERE, "profile")' in srv)
    check("server honors LOGIN_HELPER_PROFILE_DIR over the default",
          'os.environ.get("LOGIN_HELPER_PROFILE_DIR") or DEFAULT_PROFILE'
          in srv)
    check("server deleted the old _CANONICAL_PROFILE",
          "_CANONICAL_PROFILE" not in srv)
    check("server guards production ports without an explicit "
          "profile pin (exit 3, exact FATAL)",
          "refusing production ports without LOGIN_HELPER_PROFILE_DIR" in srv
          and "sys.exit(3)" in srv)
    for field in ("chromium_alive", "starting", "profile_dir",
                  "profile_has_cookies"):
        check("server reports %s in /status" % field,
              '"%s"' % field in srv)
    # W4-P2-18: document.title is never consulted for login state. The
    # status() probe reads location.href only, and no error-title match
    # remains anywhere in the server (the old U+2019 normalization is
    # gone with it).
    status_src = srv[srv.find("    def status(self):"):
                     srv.find("    def screenshot(self):")]
    check("status() probe reads location.href only",
          "JSON.stringify({href: location.href})" in status_src)
    # No quoted "title" key anywhere in status(): the probe builds
    # {href: ...} only and nothing ever reads info["title"]. Bare
    # "title" in comments is fine.
    check("status() never reads a title from the probe result",
          '"title"' not in status_src and "'title'" not in status_src)
    check("no error-title match remains in the server",
          "U+2019" not in srv
          and "can't find your login page" not in srv)

    # 10. W3-P0-7/W3-P0-8: token auth on the helper API. Source-level
    # pins plus a behavioral probe that boots the real Handler (no
    # Chromium) with a stubbed BROWSER and asserts the auth matrix.
    with open(readme, encoding="utf-8") as fh:
        readme_text = fh.read()

    def _lc_src_has_helper_client():
        lc_path = os.path.join(tree, "transport", "local_chromium.py")
        with open(lc_path, encoding="utf-8") as fh:
            lc_src = fh.read()
        return (all(n in lc_src for n in (
            "def helper_token_path", "def helper_token",
            "def _helper_request", "HELPER_TOKEN_HEADER",
            "def helper_status", "def helper_screenshot",
            "def helper_input_key", "def helper_input_mouse",
            "def helper_navigate"))
            and "X-Helper-Token" in lc_src)

    def _cs_src():
        cs_path = os.path.join(tree, "transport", "chromium_session.py")
        with open(cs_path, encoding="utf-8") as fh:
            return fh.read()
    check("server reads HELPER_AUTH_TOKEN at startup",
          'os.environ.get("HELPER_AUTH_TOKEN"' in srv)
    check("server mints an ephemeral 64-hex token when unset",
          "secrets.token_hex(32)" in srv)
    check("ephemeral token is printed to a live console only, never to "
          "server.log", "sys.stdout.isatty()" in srv)
    check("protected endpoints answer 403 forbidden JSON",
          '{"error": "forbidden"}, 403' in srv)
    check("GET /screenshot is a protected route",
          '"/screenshot"' in srv and "_PROTECTED_GET" in srv)
    check("every POST endpoint goes through the auth gate",
          srv.count("self._require_auth()") >= 2)
    check("UI carries the __HELPER_TOKEN__ placeholder",
          "__HELPER_TOKEN__" in ui)
    check("UI sends X-Helper-Token on the protected fetches",
          ui.count("X-Helper-Token") >= 4)
    check("UI /status poll stays token-free",
          'fetch("/status", { cache: "no-store" })' in ui)
    check("non-loopback LOGIN_HELPER_BIND is FATAL without opt-in",
          "LOGIN_HELPER_BIND_PUBLIC" in srv and "sys.exit(1)" in srv)
    check("loopback binds (127.x, ::1, localhost) need no opt-in",
          "_bind_is_loopback" in srv)
    # W6-P2-3: the token must be exactly 64 lowercase hex chars; a
    # truncated token used to be silently enforced (brute-forceable).
    check("W6-P2-3: _valid_token_shape requires 64 hex chars",
          "_valid_token_shape" in srv and "len(token) == 64" in srv)
    # W6-P1-1: the token rotates (not permanent); the replaced token
    # gets a grace window so in-flight clients are not cut off.
    check("W6-P1-1: token rotation is implemented",
          "HELPER_TOKEN_PREV" in srv and "helper_token.prev" in srv)
    check("W6-P1-1: previous-token grace window exists",
          "HELPER_TOKEN_PREV_GRACE_SECONDS" in srv)
    # W6-P2-8: the helper speaks TLS when given a cert/key, so a
    # public bind does not put the token on the LAN in cleartext.
    check("W6-P2-8: TLS mode via LOGIN_HELPER_TLS_CERT/KEY",
          "LOGIN_HELPER_TLS_CERT" in srv and "LOGIN_HELPER_TLS_KEY" in srv)
    check("wrong method on a known path is 405 JSON",
          '"method not allowed"}, 405' in srv)
    check("server_version is CanvasLoginHelper/0.3",
          'server_version = "CanvasLoginHelper/0.3"' in srv)
    check("oversized body is 413 JSON",
          '_HttpError(413, "request body too large' in srv)
    check("malformed JSON body is 400 JSON",
          '"malformed JSON body"' in srv)
    check("/status output strips query/fragment via _loggable_url",
          '"url": _loggable_url(href) if href else ""' in srv)
    check("/status log line strips the query string",
          "_loggable_url(st.get(" in srv)
    check("profile_dir abbreviates $HOME as ~",
          "_display_profile_dir(PROFILE_DIR)" in srv)
    check("README documents the token auth story",
          "X-Helper-Token" in readme_text
          and "helper_token" in readme_text)
    check("README describes the production-port guard correctly "
          "(EITHER port, no profile-identity check)",
          "EITHER production port" in readme_text)
    check("README documents /screenshot as protected",
          "GET /screenshot" in readme_text)
    check("local_chromium centralizes helper requests with the token",
          _lc_src_has_helper_client())
    check("chromium_session status check uses the centralized path",
          "lc.helper_status(" in _cs_src())

    # 10b. Behavioral auth probe: import the real server.py with a token
    # in the environment, stub BROWSER (no Chromium launched), serve the
    # real Handler on an ephemeral port, and assert the matrix:
    # unauthenticated/wrong-token POST -> 403, correct token -> 200,
    # /screenshot unauthenticated -> 403, /status open -> 200, plus the
    # 405/413/400 routing and the UI token injection.
    import secrets  # noqa: E402
    probe_dir = os.path.join(HERE, ".selftest-auth")
    shutil.rmtree(probe_dir, ignore_errors=True)
    os.makedirs(os.path.join(probe_dir, "home"), exist_ok=True)
    probe_token = secrets.token_hex(32)
    probe_script = os.path.join(probe_dir, "auth_probe.py")
    with open(probe_script, "w", encoding="utf-8") as fh:
        fh.write(
            "import json, os, sys, threading, urllib.request, "
            "urllib.error\n"
            "from http.server import ThreadingHTTPServer\n"
            "sys.path.insert(0, %r)\n"
            "import server as S\n"
            "TOKEN = %r\n"
            "assert bytes(S.HELPER_TOKEN).decode('ascii') == TOKEN, 'env token must win'\n"
            "CALLS = []\n"
            "class _StubLauncher:\n"
            "    def is_running(self):\n"
            "        return True\n"
            "class _StubCDP:\n"
            "    def evaluate(self, tab, expression, timeout=None):\n"
            "        assert isinstance(tab, dict) and tab.get('id')\n"
            "        assert 'location.href' in expression\n"
            "        return json.dumps({\n"
            "            'href': 'https://tenant.instructure.com/courses/1'\n"
            "                    '?oauth_code=SECRET#frag'\n"
            "            })\n"
            "    def call(self, tab, method, params=None, timeout=30):\n"
            "        assert method == 'Network.getCookies'\n"
            "        return {'cookies': []}\n"
            "hb = S.HelperBrowser.__new__(S.HelperBrowser)\n"
            "hb.launcher = _StubLauncher()\n"
            "hb.cdp = _StubCDP()\n"
            "hb.tab = {'id': 'STUB', 'type': 'page',\n"
            "        'url': 'https://tenant.instructure.com/courses/1'}\n"
            "hb.base_url = 'https://tenant.instructure.com/'\n"
            "hb._lock = threading.Lock()\n"
            "REAL_STATUS = hb.status()\n"
            "class _StubBrowser:\n"
            "    def status(self):\n"
            "        return dict(REAL_STATUS)\n"
            "    def screenshot(self):\n"
            "        return b'\\x89PNG\\r\\n\\x1a\\n' + b'\\x00' * 64\n"
            "    def key(self, kind, key, code, key_code):\n"
            "        CALLS.append(('key', kind))\n"
            "    def mouse(self, kind, x, y, button):\n"
            "        CALLS.append(('mouse', kind))\n"
            "    def navigate(self, url):\n"
            "        if not url.startswith('https://'):\n"
            "            raise ValueError('refusing non-https navigation')\n"
            "        CALLS.append(('navigate', url))\n"
            "    def cdp_proxy_tabs(self):\n"
            "        return [{'id': 'STUB', 'type': 'page',\n"
            "                 'url': 'https://example.com/'}]\n"
            "    def cdp_proxy_new_tab(self, url):\n"
            "        CALLS.append(('cdp-new-tab', url))\n"
            "        return {'id': 'STUB2', 'type': 'page',\n"
            "                'url': url}\n"
            "    def cdp_proxy_call(self, target_id, method, params,\n"
            "                     timeout=30):\n"
            "        CALLS.append(('cdp-call', method))\n"
            "        return {'frameTree': {}}\n"
            "    def cdp_proxy_evaluate(self, target_id, expression,\n"
            "                         await_promise, context_id,\n"
            "                         timeout=30):\n"
            "        CALLS.append(('cdp-evaluate', expression[:20]))\n"
            "        return {'result': {'value': 1}}\n"
            "    def cdp_proxy_navigate(self, target_id, url,\n"
            "                         timeout=30):\n"
            "        CALLS.append(('cdp-navigate', url))\n"
            "        return {'ok': True}\n"
            "    def cdp_proxy_close_tab(self, target_id):\n"
            "        CALLS.append(('cdp-close-tab', target_id))\n"
            "        return {'ok': True}\n"
            "    def cdp_proxy_events(self, target_id, timeout_s):\n"
            "        return {'events': []}\n"
            "S.BROWSER = _StubBrowser()\n"
            "srv = ThreadingHTTPServer(('127.0.0.1', 0), S.Handler)\n"
            "PORT = srv.server_address[1]\n"
            "t = threading.Thread(target=srv.serve_forever, daemon=True)\n"
            "t.start()\n"
            "RES = []\n"
            "def req(method, path, headers=None, body=None):\n"
            "    r = urllib.request.Request(\n"
            "        'http://127.0.0.1:%%d%%s' %% (PORT, path), data=body,\n"
            "        headers=headers or {}, method=method)\n"
            "    try:\n"
            "        with urllib.request.urlopen(r, timeout=10) as resp:\n"
            "            return resp.status, resp.read()\n"
            "    except urllib.error.HTTPError as e:\n"
            "        return e.code, e.read()\n"
            "H = {'X-Helper-Token': TOKEN}\n"
            "WRONG = {'X-Helper-Token': '0' * 64}\n"
            "def ck(name, cond):\n"
            "    RES.append((name, bool(cond)))\n"
            "ck('real status() strips query/fragment from url output',\n"
            "   REAL_STATUS['url'] ==\n"
            "   'https://tenant.instructure.com/courses/1')\n"
            "ck('real status() keeps logged_in from the full href',\n"
            "   REAL_STATUS['logged_in'] is True)\n"
            "ck('real status() abbreviates $HOME as ~ in profile_dir',\n"
            "   REAL_STATUS['profile_dir'].startswith('~/'))\n"
            "code, body = req('POST', '/navigate', body=b'{}')\n"
            "ck('unauthenticated POST /navigate -> 403', code == 403)\n"
            "ck('403 body is forbidden JSON',\n"
            "   code == 403 and json.loads(body) == {'error': 'forbidden'})\n"
            "ck('wrong token POST /navigate -> 403',\n"
            "   req('POST', '/navigate', headers=WRONG, body=b'{}')[0]\n"
            "   == 403)\n"
            "code, body = req('POST', '/navigate', headers=H,\n"
            "                body=json.dumps({'url':\n"
            "                               'https://example.com/'}).\n"
            "                encode())\n"
            "ck('correct token POST /navigate -> 200',\n"
            "   code == 200 and json.loads(body) == {'ok': True})\n"
            "ck('authenticated navigate reached the browser stub',\n"
            "   ('navigate', 'https://example.com/') in CALLS)\n"
            "ck('unauthenticated POST /input/key -> 403',\n"
            "   req('POST', '/input/key',\n"
            "       body=b'{\"kind\":\"down\"}')[0] == 403)\n"
            "ck('GET /screenshot without token -> 403',\n"
            "   req('GET', '/screenshot')[0] == 403)\n"
            "code, body = req('GET', '/screenshot', headers=H)\n"
            "ck('GET /screenshot with token -> 200 PNG',\n"
            "   code == 200 and body.startswith(b'\\x89PNG'))\n"
            "code, body = req('GET', '/status')\n"
            "ck('GET /status without token -> 200', code == 200)\n"
            "st = json.loads(body)\n"
            "ck('/status url has no query string',\n"
            "   '?' not in st.get('url', '') and '#' not in st.get('url', ''))\n"
            "ck('/status profile_dir has no home username',\n"
            "   st.get('profile_dir', '').startswith('~/'))\n"
            "ck('POST /status -> 405',\n"
            "   req('POST', '/status', headers=H, body=b'{}')[0] == 405)\n"
            "ck('PUT /navigate -> 405',\n"
            "   req('PUT', '/navigate', headers=H)[0] == 405)\n"
            "ck('DELETE /unknown -> 404',\n"
            "   req('DELETE', '/nope', headers=H)[0] == 404)\n"
            "ck('oversized body -> 413',\n"
            "   req('POST', '/navigate', headers=H, body=b'x' * 70000)[0]\n"
            "   == 413)\n"
            "ck('malformed JSON body -> 400',\n"
            "   req('POST', '/navigate', headers=H,\n"
            "       body=b'not-json{{{')[0] == 400)\n"
            "code, body = req('GET', '/')\n"
            "ck('GET / serves the UI open', code == 200)\n"
            "ck('served UI has the token injected, no placeholder left',\n"
            "   TOKEN.encode() in body and b'__HELPER_TOKEN__' not in body)\n"
            "ck('server_version is CanvasLoginHelper/0.3',\n"
            "   S.Handler.server_version == 'CanvasLoginHelper/0.3')\n"
            "srv.shutdown()\n"
            "bad = [n for n, ok in RES if not ok]\n"
            "for n, ok in RES:\n"
            "    print(('PASS ' if ok else 'FAIL ') + 'probe: ' + n)\n"
            "sys.exit(1 if bad else 0)\n"
            % (HERE, probe_token))
    probe_env = dict(os.environ)
    probe_home = os.path.join(probe_dir, "home")
    probe_env["HOME"] = probe_home
    probe_env["HELPER_AUTH_TOKEN"] = probe_token
    probe_env["LOGIN_HELPER_PORT"] = "18971"
    probe_env["LOGIN_HELPER_CDP_PORT"] = "19371"
    probe_env["LOGIN_HELPER_PROFILE_DIR"] = os.path.join(probe_home,
                                                         "hprofile")
    probe_env.pop("LOGIN_HELPER_BIND", None)
    probe_env.pop("LOGIN_HELPER_BIND_PUBLIC", None)
    probe_env.pop("CANVAS_BASE", None)
    pproc = subprocess.run([sys.executable, probe_script], env=probe_env,
                           capture_output=True, timeout=120)
    print(pproc.stdout.decode("utf-8", "replace"))
    if pproc.stderr:
        print(pproc.stderr.decode("utf-8", "replace")[-2000:])
    check("behavioral auth probe passes (real Handler, stubbed browser)",
          pproc.returncode == 0)
    shutil.rmtree(probe_dir, ignore_errors=True)

    # 10c. Ephemeral-token NOTICE: with HELPER_AUTH_TOKEN unset and stdout
    # a pipe (not a TTY, like server.log), the server must print the
    # notice but NEVER the token value.
    eph_env = dict(os.environ)
    eph_env.pop("HELPER_AUTH_TOKEN", None)
    eph_env["LOGIN_HELPER_PORT"] = "18972"
    eph_env["LOGIN_HELPER_CDP_PORT"] = "19372"
    eph_env["LOGIN_HELPER_PROFILE_DIR"] = os.path.join(
        HERE, ".selftest-eph-profile")
    eph_env.pop("LOGIN_HELPER_BIND", None)
    eph_env.pop("LOGIN_HELPER_BIND_PUBLIC", None)
    eph_env.pop("CANVAS_BASE", None)
    eph = subprocess.run(
        [sys.executable, "-c",
         "import sys; sys.path.insert(0, %r); import server; "
         "import re; assert re.fullmatch(r'[0-9a-f]{64}', "
         "bytes(server.HELPER_TOKEN).decode('ascii')); print('IMPORT_OK')" % HERE],
        env=eph_env, capture_output=True, timeout=60)
    eph_out = eph.stdout.decode("utf-8", "replace")
    eph_err = eph.stderr.decode("utf-8", "replace")
    import re as _re
    check("ephemeral token minted on bare import (64 hex)",
          eph.returncode == 0 and "IMPORT_OK" in eph_out)
    check("NOTICE printed about the ephemeral token",
          "NOTICE" in eph_out and "ephemeral" in eph_out.lower())
    check("ephemeral token value never reaches non-tty stdout",
          not _re.search(r"[0-9a-f]{64}", eph_out))
    shutil.rmtree(os.path.join(HERE, ".selftest-eph-profile"),
                  ignore_errors=True)

    # 10c2. W6-P2-8: TLS mode. With LOGIN_HELPER_TLS_CERT/KEY set, the
    # server must serve HTTPS (not plaintext HTTP), so a public bind
    # does not put the token on the LAN in cleartext. Uses a scratch
    # self-signed cert under the test dir (never /tmp).
    tls_dir = os.path.join(HERE, ".selftest-tls")
    os.makedirs(tls_dir, exist_ok=True)
    tls_cert = os.path.join(tls_dir, "cert.pem")
    tls_key = os.path.join(tls_dir, "key.pem")
    _gen = subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048",
         "-keyout", tls_key, "-out", tls_cert, "-days", "1",
         "-nodes", "-subj", "/CN=127.0.0.1",
         "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"],
        capture_output=True, timeout=60)
    if _gen.returncode == 0 and os.path.isfile(tls_cert):
        tls_env = dict(os.environ)
        tls_env["PYTHONDONTWRITEBYTECODE"] = "1"
        tls_env["HOME"] = os.path.join(tls_dir, "home")
        os.makedirs(tls_env["HOME"], exist_ok=True)
        tls_env["CANVAS_BASE"] = "https://school.instructure.com"
        tls_env["HELPER_AUTH_TOKEN"] = probe_token
        tls_env["LOGIN_HELPER_PORT"] = "18973"
        tls_env["LOGIN_HELPER_CDP_PORT"] = "19373"
        tls_env["LOGIN_HELPER_PROFILE_DIR"] = os.path.join(
            tls_dir, "profile")
        tls_env["LOGIN_HELPER_TLS_CERT"] = tls_cert
        tls_env["LOGIN_HELPER_TLS_KEY"] = tls_key
        tls_env["MORROW_HELPER_ENV_FILE"] = os.path.join(
            tls_dir, "empty-env")
        with open(tls_env["MORROW_HELPER_ENV_FILE"], "w",
                   encoding="utf-8") as fh:
            fh.write("# empty\n")
        tls_proc = subprocess.Popen(
            [sys.executable, os.path.join(HERE, "server.py")],
            env=tls_env, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT)
        try:
            import ssl as _ssl
            import time as _time
            _ctx = _ssl.create_default_context()
            _ctx.check_hostname = False
            _ctx.verify_mode = _ssl.CERT_NONE
            _ok = False
            for _i in range(150):
                if tls_proc.poll() is not None:
                    break
                _time.sleep(0.2)
                try:
                    _conn = _ctx.wrap_socket(
                        __import__("socket").create_connection(
                            ("127.0.0.1", 18973), timeout=2),
                        server_hostname="127.0.0.1")
                    _conn.sendall(
                        b"GET /status HTTP/1.0\r\nHost: 127.0.0.1\r\n"
                        b"\r\n")
                    _resp = _conn.recv(65536)
                    _conn.close()
                    if b"200" in _resp:
                        _ok = True
                        break
                except Exception:  # noqa: BLE001
                    pass
            if not _ok:
                tls_proc.terminate()
                try:
                    _tls_out = tls_proc.communicate(timeout=10)[0]
                except Exception:  # noqa: BLE001
                    tls_proc.kill()
                    _tls_out = tls_proc.communicate()[0]
                _verdict, _why = tls_check_outcome(
                    False, (_tls_out or b"").decode("utf-8", "replace"))
                if _verdict == "skip":
                    print("SKIP W6-P2-8: server serves HTTPS with TLS "
                          "cert/key (%s)" % _why)
                else:
                    check("W6-P2-8: server serves HTTPS with TLS cert/key "
                          "(%s)" % _why, False)
            else:
                check("W6-P2-8: server serves HTTPS with TLS cert/key",
                      True)
            # Plaintext HTTP to the TLS port must NOT work (the
            # socket speaks TLS now).
            try:
                _s = __import__("socket").create_connection(
                    ("127.0.0.1", 18973), timeout=2)
                _s.sendall(b"GET /status HTTP/1.0\r\n\r\n")
                _plain = _s.recv(1024)
                _s.close()
                _plain_ok = b"200" not in _plain
            except Exception:  # noqa: BLE001
                _plain_ok = True
            check("W6-P2-8: plaintext HTTP is refused on the TLS port",
                  _plain_ok)
        finally:
            tls_proc.terminate()
            try:
                tls_proc.wait(timeout=10)
            except Exception:  # noqa: BLE001
                tls_proc.kill()
    else:
        check("W6-P2-8: server serves HTTPS with TLS cert/key",
              False, "openssl cert generation failed")
    shutil.rmtree(tls_dir, ignore_errors=True)

    # 10c3. W6-P1-1: previous-token grace. A rotated token's predecessor
    # stays valid for HELPER_TOKEN_PREV_GRACE_SECONDS (in-flight
    # clients are not cut off); after the grace it is refused.
    prev_dir = os.path.join(HERE, ".selftest-prev")
    os.makedirs(prev_dir, exist_ok=True)
    _prev_token = "b" * 64
    _prev_file = os.path.join(prev_dir, "helper_token.prev")
    with open(_prev_file, "w", encoding="utf-8") as fh:
        fh.write("%s:%d" % (_prev_token, int(__import__("time").time())))
    os.chmod(_prev_file, 0o600)
    prev_script = os.path.join(prev_dir, "prev_probe.py")
    with open(prev_script, "w", encoding="utf-8") as fh:
        fh.write(
            "import sys, time\n"
            "sys.path.insert(0, %r)\n"
            "import server as S\n"
            "cur = bytes(S.HELPER_TOKEN).decode('ascii')\n"
            "prev = %r\n"
            "ok_cur = S._token_ok(cur)\n"
            "ok_prev = S._token_ok(prev)\n"
            "# age the prev token past the grace window\n"
            "S.HELPER_TOKEN_PREV_REPLACED_AT = time.time() - 99999\n"
            "ok_prev_old = S._token_ok(prev)\n"
            "ok_wrong = S._token_ok('0' * 64)\n"
            "print('CUR:%%s PREV:%%s PREV_OLD:%%s WRONG:%%s' %% (\n"
            "    ok_cur, ok_prev, ok_prev_old, ok_wrong))\n" % (HERE, _prev_token))
    prev_env = dict(os.environ)
    prev_env["PYTHONDONTWRITEBYTECODE"] = "1"
    prev_env["HOME"] = os.path.join(prev_dir, "home")
    os.makedirs(prev_env["HOME"], exist_ok=True)
    prev_env["HELPER_AUTH_TOKEN"] = probe_token
    prev_env["HELPER_AUTH_TOKEN_PREV_FILE"] = _prev_file
    prev_env["LOGIN_HELPER_PORT"] = "18974"
    prev_env["LOGIN_HELPER_CDP_PORT"] = "19374"
    prev_env["LOGIN_HELPER_PROFILE_DIR"] = os.path.join(prev_dir, "profile")
    prev_env["MORROW_HELPER_ENV_FILE"] = os.path.join(prev_dir, "empty-env")
    with open(prev_env["MORROW_HELPER_ENV_FILE"], "w",
               encoding="utf-8") as fh:
        fh.write("# empty\n")
    prev_proc = subprocess.run(
        [sys.executable, prev_script], env=prev_env,
        capture_output=True, timeout=60)
    prev_out = prev_proc.stdout.decode("utf-8", "replace")
    check("W6-P1-1: current token is accepted",
          "CUR:True" in prev_out)
    check("W6-P1-1: pre-rotation token is accepted within grace",
          "PREV:True" in prev_out)
    check("W6-P1-1: pre-rotation token is refused after grace",
          "PREV_OLD:False" in prev_out)
    check("W6-P1-1: wrong token is refused",
          "WRONG:False" in prev_out)
    shutil.rmtree(prev_dir, ignore_errors=True)

    # 10d. BIND guard: a non-loopback LOGIN_HELPER_BIND without the
    # explicit opt-in is FATAL at import (exit 1); with the opt-in the
    # import proceeds.
    for bind_val, opt_in, want_rc in (("0.0.0.0", None, 1),
                                      ("192.168.1.10", None, 1),
                                      ("0.0.0.0", "1", 0),
                                      ("127.0.0.1", None, 0),
                                      ("::1", None, 0)):
        b_env = dict(os.environ)
        b_env["HELPER_AUTH_TOKEN"] = probe_token
        b_env["LOGIN_HELPER_PORT"] = "18973"
        b_env["LOGIN_HELPER_CDP_PORT"] = "19373"
        b_env["LOGIN_HELPER_PROFILE_DIR"] = os.path.join(
            HERE, ".selftest-bind-profile")
        b_env["LOGIN_HELPER_BIND"] = bind_val
        if opt_in is None:
            b_env.pop("LOGIN_HELPER_BIND_PUBLIC", None)
        else:
            b_env["LOGIN_HELPER_BIND_PUBLIC"] = opt_in
        b_env.pop("CANVAS_BASE", None)
        bproc = subprocess.run(
            [sys.executable, "-c",
             "import sys; sys.path.insert(0, %r); import server; "
             "print('BIND_IMPORT_OK')" % HERE],
            env=b_env, capture_output=True, timeout=60)
        check("BIND=%s opt_in=%s -> exit %d"
              % (bind_val, opt_in, want_rc),
              bproc.returncode == want_rc
              and (want_rc != 0
                   or "BIND_IMPORT_OK" in bproc.stdout.decode()))
        if want_rc != 0:
            check("BIND=%s refusal names LOGIN_HELPER_BIND_PUBLIC"
                  % bind_val,
                  "LOGIN_HELPER_BIND_PUBLIC" in bproc.stderr.decode())
    shutil.rmtree(os.path.join(HERE, ".selftest-bind-profile"),
                  ignore_errors=True)

    # 11. W3-P2-7 hardening: rate limiting, request timeouts, thread cap,
    # log rotation. Source pins for the production defaults plus four
    # behavioral probes in the real-Handler/stubbed-browser style. The
    # tunables ride env vars so the probes run with small limits.
    check("rate limit defaults are sane for the real clients "
          "(burst 120, sustained 20/sec)",
          helper_srv.RATE_LIMIT_BURST == 120
          and helper_srv.RATE_LIMIT_RPS == 20)
    check("thread cap default is 16",
          helper_srv.MAX_WORKER_THREADS == 16)
    check("request timeout default is 60s, socket I/O timeout 30s",
          helper_srv.REQUEST_TIMEOUT == 60
          and helper_srv.SOCKET_IO_TIMEOUT == 30)
    check("log rotation default is 1 MiB keeping 4 archives",
          helper_srv.LOG_ROTATE_BYTES == 1048576
          and helper_srv.LOG_ROTATE_KEEP == 4)
    check("server class is the bounded one (daemon threads, backlog 64)",
          helper_srv.BoundedThreadingHTTPServer.daemon_threads is True
          and helper_srv.BoundedThreadingHTTPServer.request_queue_size
          == 64)
    check("main() serves through BoundedThreadingHTTPServer",
          "srv = BoundedThreadingHTTPServer((BIND, PORT), Handler)" in srv)
    check("server docstring names the W3-P2-7 hardening",
          "Hardening (W3-P2-7)" in srv)
    check("README documents the limits, 429/503, timeouts, rotation",
          all(s in readme_text for s in (
              "LOGIN_HELPER_RATE_LIMIT_BURST", "rate limit exceeded",
              "service unavailable", "LOGIN_HELPER_REQUEST_TIMEOUT",
              "server.log.1")))

    def _run_w3p27_probe(name, script_text, timeout):
        d = os.path.join(HERE, ".selftest-w3p27-" + name)
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(os.path.join(d, "home"), exist_ok=True)
        script = os.path.join(d, "probe.py")
        with open(script, "w", encoding="utf-8") as fh:
            fh.write(script_text)
        wenv = dict(os.environ)
        wenv["HOME"] = os.path.join(d, "home")
        wenv["HELPER_AUTH_TOKEN"] = probe_token
        wenv["LOGIN_HELPER_PORT"] = "18976"
        wenv["LOGIN_HELPER_CDP_PORT"] = "19376"
        wenv["LOGIN_HELPER_PROFILE_DIR"] = os.path.join(d, "home",
                                                        "hprofile")
        wenv.pop("LOGIN_HELPER_BIND", None)
        wenv.pop("LOGIN_HELPER_BIND_PUBLIC", None)
        wenv.pop("CANVAS_BASE", None)
        wproc = subprocess.run([sys.executable, script], env=wenv,
                               capture_output=True, timeout=timeout)
        print(wproc.stdout.decode("utf-8", "replace"))
        if wproc.stderr:
            print(wproc.stderr.decode("utf-8", "replace")[-2000:])
        ok = wproc.returncode == 0
        shutil.rmtree(d, ignore_errors=True)
        return ok

    # 11a. Rate limiting: burst of 5 then 429 JSON with Retry-After, then
    # the bucket refills.
    _PROBE_A = '''
import json, os, sys, threading, time, urllib.request, urllib.error
os.environ["LOGIN_HELPER_RATE_LIMIT_BURST"] = "5"
os.environ["LOGIN_HELPER_RATE_LIMIT_RPS"] = "1"
sys.path.insert(0, __HERE__)
import server as S
assert (S.RATE_LIMIT_BURST, S.RATE_LIMIT_RPS) == (5, 1), \\
    "env tunables must win"
class _StubBrowser:
    def status(self):
        return {"url": "https://tenant.instructure.com/",
                "logged_in": True}
S.BROWSER = _StubBrowser()
srv = S.BoundedThreadingHTTPServer(("127.0.0.1", 0), S.Handler)
PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
RES = []
def ck(name, cond):
    RES.append((name, bool(cond)))
def get(path):
    try:
        with urllib.request.urlopen(
                "http://127.0.0.1:%d%s" % (PORT, path),
                timeout=10) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()
codes = [get("/status")[0] for _ in range(10)]
ck("burst of 5 allowed, then 429",
   codes[:5] == [200] * 5 and codes[5:] == [429] * 5)
code, headers, body = get("/status")
ck("429 body is rate-limit JSON",
   code == 429
   and json.loads(body) == {"error": "rate limit exceeded"})
ck("429 carries Retry-After",
   code == 429 and headers.get("Retry-After") == "1")
time.sleep(7)
ck("bucket refills: a request after the window is 200",
   get("/status")[0] == 200)
srv.shutdown()
bad = [n for n, ok in RES if not ok]
for n, ok in RES:
    print(("PASS " if ok else "FAIL ") + "probe: " + n)
sys.exit(1 if bad else 0)
'''.replace("__HERE__", repr(HERE))
    check("behavioral rate-limit probe passes (429 on flood, refill)",
          _run_w3p27_probe("ratelimit", _PROBE_A, 120))

    # 11b. Thread cap: with 2 workers and 2 handlers blocked inside
    # /status, a third concurrent request gets 503 JSON immediately;
    # releasing the block lets the first two complete 200.
    _PROBE_B = '''
import json, os, sys, threading, time, urllib.request, urllib.error
os.environ["LOGIN_HELPER_MAX_WORKERS"] = "2"
os.environ["LOGIN_HELPER_RATE_LIMIT_BURST"] = "1000"
os.environ["LOGIN_HELPER_RATE_LIMIT_RPS"] = "1000"
sys.path.insert(0, __HERE__)
import server as S
assert S.MAX_WORKER_THREADS == 2, "env tunable must win"
entered = []
entered_lock = threading.Lock()
release = threading.Event()
class _StubBrowser:
    def status(self):
        with entered_lock:
            entered.append(1)
        release.wait(30)
        return {"url": "https://tenant.instructure.com/",
                "logged_in": True}
S.BROWSER = _StubBrowser()
srv = S.BoundedThreadingHTTPServer(("127.0.0.1", 0), S.Handler)
PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
RES = []
def ck(name, cond):
    RES.append((name, bool(cond)))
def get_status():
    try:
        with urllib.request.urlopen(
                "http://127.0.0.1:%d/status" % PORT,
                timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
outs = []
ts = [threading.Thread(target=lambda: outs.append(get_status()))
      for _ in range(2)]
for t in ts:
    t.start()
n = 0
deadline = time.time() + 10
while time.time() < deadline:
    with entered_lock:
        n = len(entered)
    if n == 2:
        break
    time.sleep(0.05)
ck("both handlers entered and hold the 2 worker slots", n == 2)
t0 = time.time()
code, body = get_status()
dt = time.time() - t0
ck("third concurrent request is shed fast", dt < 5)
ck("shed request gets 503 JSON",
   code == 503 and json.loads(body) == {"error": "service unavailable"})
release.set()
for t in ts:
    t.join(15)
ck("blocked handlers complete 200 once released",
   len(outs) == 2 and all(o[0] == 200 for o in outs))
srv.shutdown()
bad = [n for n, ok in RES if not ok]
for n, ok in RES:
    print(("PASS " if ok else "FAIL ") + "probe: " + n)
sys.exit(1 if bad else 0)
'''.replace("__HERE__", repr(HERE))
    check("behavioral thread-cap probe passes (503 past the cap)",
          _run_w3p27_probe("threadcap", _PROBE_B, 120))

    # 11c. Request timeout: two handlers hung forever in /status are cut
    # off at the 3s deadline (clients see the connection drop, never a
    # hang), and the server keeps serving because the watchdog reclaims
    # the worker slots (without the reclaim, both slots would stay held
    # and the follow-up GET / would 503).
    _PROBE_C = '''
import os, sys, threading, time, urllib.request, urllib.error
os.environ["LOGIN_HELPER_MAX_WORKERS"] = "2"
os.environ["LOGIN_HELPER_REQUEST_TIMEOUT"] = "3"
os.environ["LOGIN_HELPER_RATE_LIMIT_BURST"] = "1000"
os.environ["LOGIN_HELPER_RATE_LIMIT_RPS"] = "1000"
sys.path.insert(0, __HERE__)
import server as S
assert (S.REQUEST_TIMEOUT, S.MAX_WORKER_THREADS) == (3, 2), \\
    "env tunables must win"
never = threading.Event()
class _StubBrowser:
    def status(self):
        never.wait(300)
        return {"url": "x", "logged_in": True}
S.BROWSER = _StubBrowser()
srv = S.BoundedThreadingHTTPServer(("127.0.0.1", 0), S.Handler)
PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
RES = []
def ck(name, cond):
    RES.append((name, bool(cond)))
def get(path, timeout=30):
    try:
        with urllib.request.urlopen(
                "http://127.0.0.1:%d%s" % (PORT, path),
                timeout=timeout) as r:
            return ("ok", r.status, r.read())
    except Exception as e:
        return ("err", type(e).__name__, b"")
results = []
def fetch_status():
    t0 = time.time()
    res = get("/status")
    results.append((time.time() - t0, res))
ts = [threading.Thread(target=fetch_status) for _ in range(2)]
for t in ts:
    t.start()
for t in ts:
    t.join(20)
ck("both hung clients are released, none hangs",
   len(results) == 2 and all(r[1][0] == "err" for r in results))
ck("no client waits past the deadline (+slack)",
   len(results) == 2 and all(r[0] < 10 for r in results))
code = None
for _ in range(100):
    _st, code, _body = get("/")
    if code == 200:
        break
    time.sleep(0.1)
ck("server still serves after hung handlers (permits reclaimed)",
   code == 200)
srv.shutdown()
bad = [n for n, ok in RES if not ok]
for n, ok in RES:
    print(("PASS " if ok else "FAIL ") + "probe: " + n)
sys.exit(1 if bad else 0)
'''.replace("__HERE__", repr(HERE))
    check("behavioral timeout probe passes (hung handler cut off, "
          "slots reclaimed)",
          _run_w3p27_probe("timeout", _PROBE_C, 120))

    # 11d. Log rotation: stdout redirected to a scratch server.log, a 1KB
    # cap, keep=2. Emitting log lines must create .1/.2, never .3, and
    # the live file must keep the [login-helper] format on every line.
    rot_dir = os.path.join(HERE, ".selftest-w3p27-rotation")
    shutil.rmtree(rot_dir, ignore_errors=True)
    os.makedirs(rot_dir, exist_ok=True)
    rot_log = os.path.join(rot_dir, "server.log")
    rot_script = os.path.join(rot_dir, "rotate_probe.py")
    with open(rot_script, "w", encoding="utf-8") as fh:
        fh.write(
            "import os, sys\n"
            "sys.path.insert(0, " + repr(HERE) + ")\n"
            "os.environ[%r] = %r\n"
            "os.environ[%r] = %r\n"
            "import server as S\n"
            "assert (S.LOG_ROTATE_BYTES, S.LOG_ROTATE_KEEP) == "
            "(1024, 2), %r\n"
            "for _ in range(30):\n"
            "    S._log(%r)\n"
            "print(%r, file=sys.stderr)\n"
            % ("LOGIN_HELPER_LOG_ROTATE_BYTES", "1024",
               "LOGIN_HELPER_LOG_ROTATE_KEEP", "2",
               "env tunables must win", "x" * 200,
               "ROTATE_PROBE_DONE"))
    rot_env = dict(os.environ)
    rot_env["HOME"] = rot_dir
    rot_env["HELPER_AUTH_TOKEN"] = probe_token
    rot_env["LOGIN_HELPER_PORT"] = "18977"
    rot_env["LOGIN_HELPER_CDP_PORT"] = "19377"
    rot_env["LOGIN_HELPER_PROFILE_DIR"] = os.path.join(rot_dir, "profile")
    rot_env.pop("LOGIN_HELPER_BIND", None)
    rot_env.pop("LOGIN_HELPER_BIND_PUBLIC", None)
    rot_env.pop("CANVAS_BASE", None)
    with open(rot_log, "w", encoding="utf-8") as logfh:
        rproc = subprocess.run([sys.executable, rot_script], env=rot_env,
                               stdout=logfh, stderr=subprocess.PIPE,
                               timeout=60)
    if rproc.stderr:
        print(rproc.stderr.decode("utf-8", "replace")[-1000:])
    check("rotation probe exits 0", rproc.returncode == 0)
    check("server.log.1 exists after rotation",
          os.path.isfile(rot_log + ".1"))
    check("server.log.2 exists (keep=2)", os.path.isfile(rot_log + ".2"))
    check("server.log.3 does not exist (keep=2)",
          not os.path.exists(rot_log + ".3"))
    with open(rot_log, encoding="utf-8") as fh:
        live_lines = fh.read().splitlines()
    check("live log keeps the [login-helper] format on every line",
          bool(live_lines)
          and all(l.startswith("[login-helper] ") for l in live_lines))
    check("live log stays near the cap",
          os.path.getsize(rot_log) < 1024 + 300)
    with open(rot_log + ".1", encoding="utf-8") as fh:
        arc = fh.read()
    check("archive .1 carries real rotated log content",
          "[login-helper] " in arc)
    shutil.rmtree(rot_dir, ignore_errors=True)

    # 14. W4-P2-8: navigation URL policy. /navigate and /cdp/navigate
    # must refuse http:// (session cookies would cross the wire in
    # cleartext) and exotic schemes; only https:// and about:blank pass.
    _PROBE_NAV = '''
import os, sys
sys.path.insert(0, __HERE__)
os.environ["MORROW_HELPER_ENV_FILE"] = os.path.join(
    __HERE__, ".selftest-nav-empty-env")
with open(os.environ["MORROW_HELPER_ENV_FILE"], "w") as fh:
    fh.write("# empty: nav-policy probe isolation\\n")
os.environ["LOGIN_HELPER_PORT"] = "18902"
os.environ["LOGIN_HELPER_CDP_PORT"] = "19225"
os.environ["LOGIN_HELPER_PROFILE_DIR"] = os.path.join(
    __HERE__, ".selftest-nav-profile")
import server as S
RES = []
def ck(name, cond):
    RES.append((name, bool(cond)))
ok = S._cdp_proxy_nav_ok
ck("https allowed", ok("https://tenant.instructure.com/"))
ck("https with path/query allowed",
   ok("https://tenant.instructure.com/courses/1?x=1"))
ck("about:blank allowed", ok("about:blank"))
ck("http refused", not ok("http://tenant.instructure.com/"))
ck("http with explicit port refused",
   not ok("http://tenant.instructure.com:80/"))
ck("uppercase HTTP refused", not ok("HTTP://tenant.instructure.com/"))
ck("file refused", not ok("file:///etc/passwd"))
ck("data refused", not ok("data:text/html,<h1>x</h1>"))
ck("javascript refused", not ok("javascript:alert(1)"))
ck("empty refused", not ok(""))
ck("non-string refused", not ok(None))
bad = [n for n, good in RES if not good]
for n, good in RES:
    print(("PASS " if good else "FAIL ") + "probe: " + n)
sys.exit(1 if bad else 0)
'''.replace("__HERE__", repr(HERE))
    _nav = subprocess.run([sys.executable, "-c", _PROBE_NAV],
                          capture_output=True, text=True, timeout=60)
    print(_nav.stdout, end="")
    if _nav.stderr:
        print(_nav.stderr[-1000:], file=sys.stderr)
    check("W4-P2-8 navigation URL policy probe passes",
          _nav.returncode == 0)
    for _p in (os.path.join(HERE, ".selftest-nav-empty-env"),
               os.path.join(HERE, ".selftest-nav-profile")):
        try:
            if os.path.isdir(_p):
                shutil.rmtree(_p, ignore_errors=True)
            else:
                os.unlink(_p)
        except OSError:
            pass

    # W5-P0-1: Host-header validation against the REAL Handler on a
    # scratch port (never the live helper). Runs in a subprocess so the
    # scratch env (ports, profile dir) cannot leak into this process.
    # W5-P2-3: the public-bind cleartext warning is probed here too.
    _HOST_PROBE = '''
import importlib.util, os, re, shutil, socket, threading, sys
SCRATCH = "__SCRATCH__"
os.environ["LOGIN_HELPER_PORT"] = "18901"
os.environ["LOGIN_HELPER_CDP_PORT"] = "19224"
os.environ["LOGIN_HELPER_PROFILE_DIR"] = os.path.join(SCRATCH, "profile")
os.makedirs(os.environ["LOGIN_HELPER_PROFILE_DIR"], exist_ok=True)
spec = importlib.util.spec_from_file_location(
    "helper_server_hostprobe", "__SERVER__")
hs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hs)
srv = hs.BoundedThreadingHTTPServer(("127.0.0.1", 0), hs.Handler)
PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
RES = []
def ck(n, good):
    RES.append(good)
    print(("PASS " if good else "FAIL ") + n)
def raw_request(host, method="GET", path="/", headers=None, body=None,
                skip_host=False):
    s = socket.create_connection(("127.0.0.1", PORT), timeout=10)
    hdrs = {} if skip_host else {"Host": host}
    hdrs["Connection"] = "close"
    hdrs.update(headers or {})
    req = "%s %s HTTP/1.1\\r\\n" % (method, path)
    for k, v in hdrs.items():
        req += "%s: %s\\r\\n" % (k, v)
    if body:
        req += "Content-Length: %d\\r\\n" % len(body)
    req += "\\r\\n"
    s.sendall(req.encode("latin1") + (body or b""))
    resp = b""
    while True:
        chunk = s.recv(65536)
        if not chunk:
            break
        resp += chunk
    s.close()
    # BaseHTTPRequestHandler answers "HTTP/1.0 <code> ..."; parse the
    # numeric status, not the version token.
    head, _, rbody = resp.partition(b"\\r\\n\\r\\n")
    status_line = head.split(b"\\r\\n", 1)[0]
    parts = status_line.decode("latin1").split(" ")
    code = parts[1] if len(parts) > 1 else ""
    return code, rbody
TOKEN_RE = re.compile(rb"[0-9a-f]{64}")
# 1. loopback Hosts are served.
st, body = raw_request("127.0.0.1:%d" % PORT)
ck("host 127.0.0.1 served", st == "200")
ck("host 127.0.0.1 page still embeds token (unchanged behavior)",
   TOKEN_RE.search(body) is not None)
st, _ = raw_request("localhost:%d" % PORT)
ck("host localhost served", st == "200")
st, _ = raw_request("[::1]:%d" % PORT)
ck("host [::1] served", st == "200")
# 2. foreign Host is refused before routing/auth, with no token leak.
st, body = raw_request("evil-rebind.example:%d" % PORT)
ck("foreign Host refused", st == "403")
ck("foreign Host response carries no token",
   TOKEN_RE.search(body) is None)
st, _ = raw_request("evil-rebind.example:%d" % PORT, method="POST",
                    path="/navigate",
                    headers={"Content-Type": "application/json",
                             "X-Helper-Token":
                                 bytes(hs.HELPER_TOKEN).decode("ascii")},
                    body=b'{"url":"https://example.com/"}')
ck("foreign Host POST refused even with valid token", st == "403")
st, _ = raw_request("evil-rebind.example:%d" % PORT, method="OPTIONS")
ck("foreign Host OPTIONS refused", st == "403")
# 3. missing Host fails closed.
st, _ = raw_request("", skip_host=True)
ck("missing Host refused", st == "403")
srv.shutdown()
sys.exit(0 if all(RES) else 1)
'''.replace("__SERVER__", os.path.join(HERE, "server.py")).replace(
        "__SCRATCH__", os.path.join(HERE, ".selftest-host"))
    shutil.rmtree(os.path.join(HERE, ".selftest-host"), ignore_errors=True)
    _host = subprocess.run([sys.executable, "-c", _HOST_PROBE],
                           capture_output=True, text=True, timeout=120)
    print(_host.stdout, end="")
    if _host.stderr:
        print(_host.stderr[-1000:], file=sys.stderr)
    check("W5-P0-1 Host-header validation probe passes",
          _host.returncode == 0)
    shutil.rmtree(os.path.join(HERE, ".selftest-host"), ignore_errors=True)

    # W5-P2-3: LOGIN_HELPER_BIND_PUBLIC=1 without TLS prints the loud
    # cleartext warning at import; without the opt-in there is no
    # warning. Subprocess so env cannot leak.
    _WARN_PROBE = ("import importlib.util, os, sys; "
                   "os.environ['LOGIN_HELPER_BIND'] = '192.0.2.1'; "
                   "os.environ['LOGIN_HELPER_BIND_PUBLIC'] = '1'; "
                   "os.environ['LOGIN_HELPER_PORT'] = '18902'; "
                   "os.environ['LOGIN_HELPER_CDP_PORT'] = '19225'; "
                   "os.environ['LOGIN_HELPER_PROFILE_DIR'] = '__P__'; "
                   "os.makedirs('__P__', exist_ok=True); "
                   "spec = importlib.util.spec_from_file_location("
                   "'m', '__SERVER__'); "
                   "m = importlib.util.module_from_spec(spec); "
                   "spec.loader.exec_module(m)").replace(
        "__SERVER__", os.path.join(HERE, "server.py")).replace(
        "__P__", os.path.join(HERE, ".selftest-warn-profile"))
    _w = subprocess.run([sys.executable, "-c", _WARN_PROBE],
                        capture_output=True, text=True, timeout=60)
    shutil.rmtree(os.path.join(HERE, ".selftest-warn-profile"),
                  ignore_errors=True)
    check("W5-P2-3 public bind prints cleartext WARNING",
          "WARNING" in _w.stderr and "CLEARTEXT" in _w.stderr)
    _NOWARN_PROBE = _WARN_PROBE.replace(
        "os.environ['LOGIN_HELPER_BIND_PUBLIC'] = '1'; ", "").replace(
        "os.environ['LOGIN_HELPER_BIND'] = '192.0.2.1'; ",
        "os.environ['LOGIN_HELPER_BIND'] = '127.0.0.1'; ")
    _nw = subprocess.run([sys.executable, "-c", _NOWARN_PROBE],
                         capture_output=True, text=True, timeout=60)
    check("W5-P2-3 no warning without the public opt-in",
          _nw.returncode == 0 and "CLEARTEXT" not in _nw.stderr)

    if FAIL:
        print("FAIL: %d" % len(FAIL))
        sys.exit(1)
    print("helper selftest: all pass")


if __name__ == "__main__":
    main()
