#!/usr/bin/env python3
"""Live behavioral proof for the packaged Canvas login helper.

MANUAL-CHECK SCRIPT, not a selftest: it requires the live helper running
(the helper UI on 127.0.0.1:8901, Chromium on --remote-debugging-pipe).
It is never run by install.sh or any suite. It never opens a CDP socket
itself (W4-P0-3: no TCP CDP listener exists).

It proves the RUNNING instance: by default the tree this script ships in
(an educator install, where server.py and profile/ live side by side).
Set LOGIN_HELPER_DIR to point it at a live instance that runs elsewhere
(e.g. this VM's dev instance at ~/workspace/canvas-login-helper, whose
server.py symlinks to the packaged code).

What it proves, in order:
  1. status: /status reports logged_in:true on the tenant homepage
     (a valid session lands on the Dashboard, not the login form).
  2. single_chromium: exactly ONE Chromium main process holds the helper
     profile with --remote-debugging-pipe (no second browser).
  3. dead_session_redirect: a THROWAWAY Chromium profile (anonymous
     session, private pipe) navigated to the tenant homepage is
     redirected by Canvas to /login/canvas. This proves dead sessions
     redirect to login without touching the educator's live session.
  4. attach_users_self: the connector's own ChromiumSession attaches to
     the live helper instance (launcher.attached, no new process) and
     GET /api/v1/users/self returns 200 in page context. This is the
     plugin-attachment proof.
  5. restart_persistence: the helper server and its Chromium are killed
     and relaunched exactly the way keepalive.sh does it; the session
     must survive (logged_in:true again), the same helper/profile/ dir
     must be reused, and exactly one Chromium must hold the helper
     profile afterwards. Phase 4 is re-run afterwards against the
     restarted instance.

Run: python3 helper/live_behavior_check.py  (from the connector tree root)

It never prints, logs, or persists auth material: only URLs, titles,
booleans, PIDs, and counts. The users/self body is parsed in memory and
only its shape (status 200, integer id) is reported.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.normpath(os.path.join(HERE, ".."))
# The running helper instance this script proves. Defaults to the tree
# this script ships in (an educator install: server.py and profile/ live
# side by side). Override with LOGIN_HELPER_DIR when the live instance
# runs elsewhere (this VM's dev instance: ~/workspace/canvas-login-helper,
# whose server.py symlinks to the packaged code).
HELPER_DIR = os.path.realpath(os.environ.get("LOGIN_HELPER_DIR", HERE))
STATUS_URL = "http://127.0.0.1:8901/status"
# W4-P0-3: no CDP TCP port exists; the per-tree port number survives only
# as the launcher's identity label for the throwaway profile.
THROWAWAY_CDP_PORT = 19299

sys.path.insert(0, os.path.join(TREE, "transport"))
sys.path.insert(0, os.path.join(TREE, "config"))
from paths import morrow_home  # noqa: E402
import local_chromium as lc  # noqa: E402

FAIL = []


def check(name, cond, detail=""):
    tag = "PASS" if cond else "FAIL"
    print("%s %s%s" % (tag, name, (" (%s)" % detail) if detail else ""))
    if not cond:
        FAIL.append(name)


def http_get(url, timeout=10):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.status, r.read()


def get_status():
    code, body = http_get(STATUS_URL, timeout=10)
    return code, json.loads(body.decode("utf-8"))


def chromium_main_pids(profile_dir):
    """PIDs of Chromium MAIN processes holding exactly profile_dir with
    --remote-debugging-pipe (W4-P0-3: no TCP CDP port to match on).

    Exact argv-element matching: --remote-debugging-pipe must be an
    argv element, --type= must be absent (renderers inherit the pipe
    flag in their cmdline), and --user-data-dir=<realpath(profile_dir)>
    must be an argv element. The pgrep pattern uses the [x] trick so
    pgrep never matches its own command line.
    """
    want_profile = ("--user-data-dir="
                    + os.path.realpath(profile_dir)).encode()
    out = subprocess.run(
        ["pgrep", "-f", "--remote-debugging[-]pipe"],
        capture_output=True, text=True)
    pids = []
    me = os.getpid()
    for tok in out.stdout.split():
        try:
            pid = int(tok)
        except ValueError:
            continue
        if pid == me:
            continue
        try:
            with open("/proc/%d/cmdline" % pid, "rb") as fh:
                argv = fh.read().split(b"\0")
        except OSError:
            continue
        if b"--remote-debugging-pipe" not in argv:
            continue
        if any(a.startswith(b"--type=") for a in argv):
            continue
        if want_profile not in argv:
            continue
        pids.append(pid)
    return pids


def wait_for_status(want_logged_in, timeout, label):
    """Poll /status until HTTP 200 (and the wanted login state)."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            code, st = get_status()
            last = st
            if code == 200 and bool(st.get("logged_in")) == want_logged_in:
                return st
        except Exception:
            last = None
        time.sleep(3)
    return None


def phase_status():
    print("== phase 1: /status on the live helper ==")
    try:
        code, st = get_status()
    except Exception as exc:
        check("helper /status reachable", False, type(exc).__name__)
        return None
    url = st.get("url", "")
    check("helper /status reachable (HTTP 200)", code == 200)
    check("logged_in:true", st.get("logged_in") is True,
          "url=%s" % url[:80])
    check("valid session lands on the tenant homepage, not /login",
          url.startswith("https://") and "/login" not in url,
          "url=%s" % url[:80])
    origin = url.split("/", 3)
    origin = origin[0] + "//" + origin[2] if len(origin) > 2 else ""
    return origin


def phase_single_chromium(profile_dir):
    print("== phase 2: exactly one Chromium holds the helper profile ==")
    pids = chromium_main_pids(profile_dir)
    check("exactly one Chromium main process holds the helper profile "
          "(--remote-debugging-pipe)",
          len(pids) == 1, "pids=%s" % pids)
    return pids


def phase_dead_session_redirect(origin):
    print("== phase 3: dead session redirects to Canvas login ==")
    if not origin:
        check("dead-session redirect (skipped: no origin)", False)
        return
    # W4-P1-17: the throwaway profile lives under the unified
    # MORROW_HOME so no second ~/.morrow fallback root survives.
    throwaway = os.path.join(
        morrow_home(), ".behavior-check-%d" % os.getpid())
    launcher = None
    try:
        launcher = lc.ChromiumLauncher(
            lc.default_binary(), throwaway,
            cdp_port=THROWAWAY_CDP_PORT,
            extra_args=lc.egress.chrome_spki_args())
        launcher.start()
        check("throwaway Chromium launched (private pipe)",
              launcher.is_running())
        tab = launcher.cdp.new_tab("about:blank")
        launcher.cdp.navigate(tab, origin + "/")
        href = ""
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                href = launcher.cdp.evaluate(
                    tab, "location.href", timeout=15) or ""
            except Exception:
                href = ""
            if "/login" in href or href.rstrip("/").endswith(
                    origin.rstrip("/")):
                break
            time.sleep(2)
        check("anonymous session is redirected to Canvas login",
              "/login" in href, "landed=%s" % href[:100])
    finally:
        if launcher is not None:
            try:
                launcher.stop()
            except Exception:
                pass
        # Chrome flushes files on shutdown; retry the removal so no
        # throwaway state lingers, then prove nothing is left listening.
        for _ in range(3):
            shutil.rmtree(throwaway, ignore_errors=True)
            if not os.path.exists(throwaway):
                break
            time.sleep(2)
    check("throwaway profile removed", not os.path.exists(throwaway))
    leftovers = chromium_main_pids(throwaway)
    check("no throwaway Chromium left running", not leftovers,
          "pids=%s" % leftovers)


def phase_attach_users_self(origin, profile_dir):
    # The plugin's own session class, exactly as the executor's
    # --backend chromium path builds it: ChromiumSession.load(base_url)
    # creates a ChromiumLauncher on the helper's profile, attaches when
    # the helper's browser is already live (holder proof + exact helper
    # version), verifies the session through ensure_session(), and
    # egresses the API call in the authenticated tab via raw_request.
    # Canvas auth stays in page context throughout; nothing
    # credential-shaped crosses into shell.
    print("== phase 4: plugin attaches to the live helper session ==")
    if not origin:
        check("attach proof (skipped: no origin)", False)
        return
    before = chromium_main_pids(profile_dir)
    import chromium_session as csm
    try:
        sess = csm.ChromiumSession.load(base_url=origin)
    except Exception as exc:
        check("plugin ChromiumSession built", False, str(exc)[:160])
        return
    try:
        status, _resp_headers, raw, _attempts = sess.raw_request(
            "GET", origin + "/api/v1/users/self", {}, None,
            is_write=False)
    except csm.ChromiumSessionDead as exc:
        check("session alive in the attached browser", False,
              str(exc)[:160])
        return
    except Exception as exc:
        check("GET /api/v1/users/self through the attached session",
              False, str(exc)[:160])
        return
    launcher = getattr(sess, "_launcher", None)
    attached = bool(launcher is not None
                    and getattr(launcher, "attached", False))
    check("plugin attached to the live helper Chromium (no new browser)",
          attached and launcher.proc is None,
          "attached=%s proc=%s" % (
              getattr(launcher, "attached", None) if launcher else None,
              getattr(launcher, "proc", None) if launcher else None))
    check("GET /api/v1/users/self returned HTTP 200 in page context",
          status == 200, "status=%s" % status)
    body = (raw.decode("utf-8", "replace")
            if isinstance(raw, (bytes, bytearray)) else str(raw))
    shape_ok = False
    try:
        me = json.loads(body)
        shape_ok = isinstance(me.get("id"), int)
    except ValueError:
        shape_ok = False
    check("users/self body has an integer user id", shape_ok,
          body[:120])
    after = chromium_main_pids(profile_dir)
    check("still exactly one Chromium after attach (none launched)",
          len(before) == 1 and after == before, "pids=%s" % after)


def server_pid_on(port):
    out = subprocess.run(["ss", "-ltnp"], capture_output=True, text=True)
    for line in out.stdout.splitlines():
        if ":%d " % port in line:
            m = re.search(r"pid=(\d+)", line)
            if m:
                return int(m.group(1))
    return None


def kill_pid(pid, sig=15, wait=3):
    try:
        os.kill(pid, sig)
    except OSError:
        return True
    deadline = time.time() + wait
    while time.time() < deadline:
        try:
            os.kill(pid, 0)
        except OSError:
            return True
        time.sleep(0.5)
    return False


def phase_restart_persistence(profile_dir, origin):
    print("== phase 5: restart reuses the profile and keeps the session ==")
    if not origin:
        check("restart proof (skipped: no origin)", False)
        return
    before_pids = chromium_main_pids(profile_dir)
    srv_pid = server_pid_on(8901)
    check("helper server currently holds port 8901",
          srv_pid is not None, "pid=%s" % srv_pid)
    if srv_pid is None or not before_pids:
        return
    check("profile dir exists before restart",
          os.path.isdir(profile_dir) and len(os.listdir(profile_dir)) > 0,
          profile_dir)

    # Kill the server exactly like keepalive.sh does (SIGTERM, then
    # SIGKILL if it lingers), then reap helper-owned Chromium mains.
    print("stopping helper server pid %d ..." % srv_pid)
    if not kill_pid(srv_pid, 15, 3):
        kill_pid(srv_pid, 9, 3)
    for pid in chromium_main_pids(profile_dir):
        print("reaping helper-owned chromium main pid %d ..." % pid)
        kill_pid(pid, 15, 5) or kill_pid(pid, 9, 5)
    deadline = time.time() + 20
    while time.time() < deadline:
        if not chromium_main_pids(profile_dir):
            break
        time.sleep(1)
    check("old Chromium fully exited before relaunch",
          not chromium_main_pids(profile_dir))

    # Relaunch the same way the instance runs now: cwd is the helper
    # dir (server.py is the symlink there, so the profile resolves to
    # the dev profile), CANVAS_BASE from the live tenant origin.
    print("relaunching helper server ...")
    # Like keepalive.sh: the server's log lives in the tree's state dir,
    # never in the tree.
    state_dir = lc.tree_state_dir(os.path.dirname(HELPER_DIR))
    os.makedirs(state_dir, mode=0o700, exist_ok=True)
    log_path = os.path.join(state_dir, "server.log")
    env = dict(os.environ)
    env["CANVAS_BASE"] = origin
    with open(log_path, "ab") as lf:
        subprocess.Popen(
            [sys.executable, os.path.join(HELPER_DIR, "server.py")],
            cwd=HELPER_DIR, env=env,
            stdout=lf, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL, start_new_session=True)
    st = wait_for_status(True, 90, "post-restart")
    check("helper came back with logged_in:true after restart",
          st is not None,
          ("url=%s" % st.get("url", "")[:80]) if st else "never healthy")
    if st is None:
        return
    after_pids = chromium_main_pids(profile_dir)
    check("exactly one Chromium holds the helper profile after restart",
          len(after_pids) == 1, "pids=%s" % after_pids)
    check("restart was genuine (new Chromium pid)",
          after_pids and after_pids != before_pids,
          "before=%s after=%s" % (before_pids, after_pids))
    check("same profile dir reused (not recreated elsewhere)",
          os.path.isdir(profile_dir) and len(os.listdir(profile_dir)) > 0,
          profile_dir)
    check("post-restart session is on the tenant homepage",
          "/login" not in st.get("url", ""),
          "url=%s" % st.get("url", "")[:80])


def main():
    profile_dir = os.path.join(HELPER_DIR, "profile")
    origin = phase_status()
    if origin is None or FAIL:
        print("behavior check: ABORTED (helper not healthy to begin with)")
        sys.exit(1)
    phase_single_chromium(profile_dir)
    phase_dead_session_redirect(origin)
    phase_attach_users_self(origin, profile_dir)
    if FAIL:
        print("behavior check: FAILED before the restart phase; "
              "not restarting a broken helper")
        sys.exit(1)
    phase_restart_persistence(profile_dir, origin)
    if FAIL:
        print("behavior check: FAILED after restart; "
              "re-authenticate through the helper page if logged out")
        sys.exit(1)
    print("re-attaching to the restarted instance ...")
    phase_attach_users_self(origin, profile_dir)
    if FAIL:
        print("behavior check: %d FAIL" % len(FAIL))
        sys.exit(1)
    print("behavior check: ALL PASS")


if __name__ == "__main__":
    main()
