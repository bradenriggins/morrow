#!/usr/bin/env python3
"""chromium_memory_selftest.py -- executable contract for the W2-P2-6
Chromium memory policy (transport/local_chromium.py + helper/memory_watch.py).

W4-P0-3 (pipe edition): Chromium runs with --remote-debugging-pipe, so
there is no CDP port anywhere. Process identity is the exact
--remote-debugging-pipe argv element plus the --user-data-dir value;
the port parameter is gone from find_chromium_pids and from
MEMORY_WATCH_* (MEMORY_WATCH_CDP_PORT is legacy, ignored).

Sections:
  A. Fake /proc tree (deterministic): find_chromium_pids exact identity,
     substring-trap refusal, subtree_pids_for, subtree_rss_bytes,
     process_age_seconds.
  B. Real scratch Chromium (scratch profiles, never the live profile):
     identity matching across two trees, tree RSS, tab registry
     auto-register/protect/reap, restart via stop()/start(),
     memory_watch.py exit codes.

Scratch lives under the wave's authorized worker-browser scratch area
(never /tmp) and is removed at the end.
Run: python3 transport/chromium_memory_selftest.py  (exit 0 = all pass)
"""
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import local_chromium as lc

PASS = 0
FAIL = 0
FAILURES = []


def check(name, cond):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("PASS %s" % name)
    else:
        FAIL += 1
        FAILURES.append(name)
        print("FAIL %s" % name)


def _pid_alive(pid):
    try:
        os.kill(pid, 0)
    except (OSError, ValueError):
        return False
    return True


_USED_PORTS = set()


def _scratch_port():
    # Distinct cdp_port values keep the two trees' derived forwarder
    # ports apart (W4-P0-3: two trees must not share one forwarder).
    # These are identity labels only; nothing listens on them.
    for port in range(19800, 19950):
        if port in _USED_PORTS:
            continue
        s = socket.socket()
        try:
            s.bind(("127.0.0.1", port))
            s.close()
            _USED_PORTS.add(port)
            return port
        except OSError:
            continue
    raise RuntimeError("no free scratch identity port")


# ---------------------------------------------------------------- A: fake tree
def fake_proc_tree(root):
    """Pipe-era fake /proc: pid 100 (profile A) with child 101;
    pid 200 (profile B); pid 300 (profile A, second holder);
    pid 400 carries --remote-debugging-pipe-for-test (substring trap:
    exact argv-element matching must NOT count it)."""
    os.makedirs(root, exist_ok=True)
    with open(os.path.join(root, "uptime"), "w") as fh:
        fh.write("12345.67 0.00\n")

    def proc(pid, ppid, udd, start_ticks, resident_pages,
             renderer=False, pipe_trap=False):
        d = os.path.join(root, str(pid))
        os.makedirs(d, exist_ok=True)
        if renderer:
            # Chromium children carry --type=renderer, NOT the pipe flag
            # or user-data-dir (that is what makes the main process
            # identifiable).
            cmd = b"chrome\0--type=renderer\0"
        elif pipe_trap:
            cmd = (b"chrome\0--headless\0"
                   b"--remote-debugging-pipe-for-test\0"
                   b"--user-data-dir=" + udd.encode() + b"\0")
        else:
            cmd = (b"chrome\0--headless\0"
                   b"--remote-debugging-pipe\0"
                   b"--user-data-dir=" + udd.encode() + b"\0")
        with open(os.path.join(d, "cmdline"), "wb") as fh:
            fh.write(cmd)
        fields = ["S", str(ppid)] + ["0"] * 17 + [str(start_ticks)]
        assert len(fields) == 20  # ppid at [1], starttime at [19]
        with open(os.path.join(d, "stat"), "w") as fh:
            fh.write("%d (chrome) %s\n" % (pid, " ".join(fields)))
        with open(os.path.join(d, "statm"), "w") as fh:
            fh.write("0 %d 0 0 0 0 0\n" % resident_pages)

    proc(100, 1, "/fake/profile-a", 12345, 1000)
    proc(101, 100, "/fake/profile-a", 12400, 500, renderer=True)
    proc(200, 1, "/fake/profile-b", 12345, 250)
    proc(300, 1, "/fake/profile-a", 12345, 250)
    proc(400, 1, "/fake/profile-a", 12345, 250, pipe_trap=True)


def test_fake_tree(scratch):
    root = os.path.join(scratch, "fakeproc")
    fake_proc_tree(root)
    page = os.sysconf("SC_PAGE_SIZE")

    check("fake: exact profile identity finds pids 100 and 300",
          lc.find_chromium_pids("/fake/profile-a",
                                proc_root=root) == [100, 300])
    check("fake: sibling profile finds only pid 200",
          lc.find_chromium_pids("/fake/profile-b",
                                proc_root=root) == [200])
    check("fake: unknown profile finds nothing",
          lc.find_chromium_pids("/fake/profile-c",
                                proc_root=root) == [])
    check("fake: --remote-debugging-pipe-for-test is not a holder "
          "(exact argv-element match, never substring)",
          400 not in lc.find_chromium_pids("/fake/profile-a",
                                           proc_root=root))
    check("fake: subtree includes the child but not the sibling",
          lc.subtree_pids_for([100], proc_root=root) == [100, 101])
    check("fake: tree RSS sums the subtree",
          lc.subtree_rss_bytes([100, 101], proc_root=root) == 1500 * page)
    check("fake: missing pid contributes 0 RSS",
          lc.subtree_rss_bytes([99999], proc_root=root) == 0)
    age = lc.process_age_seconds(100, proc_root=root)
    check("fake: process age is sane (uptime - starttime)",
          age is not None and 12200 < age < 12250)
    check("fake: missing pid age is None",
          lc.process_age_seconds(99999, proc_root=root) is None)


# ---------------------------------------------------------------- B: real browser
def test_real_browser(scratch):
    try:
        binary = lc.default_binary()
    except RuntimeError as exc:
        print("SKIP real-browser section: %s" % exc)
        return None
    profile = os.path.join(scratch, "profile-a")
    profile2 = os.path.join(scratch, "profile-b")
    port = _scratch_port()
    port2 = _scratch_port()  # distinct identity (forwarder derivation)
    proxy = "http://127.0.0.1:18080"  # inert; browser only needs CDP up

    # Force a private pipe launch: on a machine where a login helper is
    # serving (e.g. the live helper on 8901), start() would otherwise
    # try the attach path and fail the holder proof against the scratch
    # profile. This test owns its browsers outright.
    os.environ["LOGIN_HELPER_OWN_BROWSER"] = "1"

    launcher = lc.ChromiumLauncher(binary, profile, cdp_port=port,
                                   proxy=proxy)
    launcher.start()
    main_pid = launcher.proc.pid
    try:
        check("real: browser started and answers CDP", launcher.is_running())
        check("real: exact identity finds the owned main pid",
              main_pid in lc.find_chromium_pids(profile))
        check("real: other identity finds nothing before it starts",
              lc.find_chromium_pids(profile2) == [])

        launcher2 = lc.ChromiumLauncher(binary, profile2, cdp_port=port2,
                                        proxy=proxy)
        launcher2.start()
        try:
            check("real: cross-identity isolation (tree A)",
                  launcher2.proc.pid not in
                  lc.find_chromium_pids(profile))
            check("real: cross-identity isolation (tree B)",
                  main_pid not in
                  lc.find_chromium_pids(profile2))
            check("real: subtree contains the main pid",
                  main_pid in launcher.subtree_pids())
            check("real: tree RSS is positive",
                  launcher.memory_rss_bytes() > 10 * 1024 * 1024)
            age = launcher.browser_age_seconds()
            check("real: browser age is sane",
                  age is not None and 0 <= age < 600)

            # --- tab registry: auto-register, protect, reap ---
            main_tab = launcher.cdp.new_tab("about:blank")
            main_id = main_tab["id"]
            launcher.set_tab_protected(main_id, True)
            reg = lc._read_tab_registry(profile)
            check("real: new_tab auto-registers the tab",
                  main_id in reg)
            check("real: protection flag is recorded",
                  reg.get(main_id, {}).get("protect") is True)

            temp = launcher.cdp.new_tab("about:blank")
            temp_id = temp["id"]
            content = launcher.cdp.new_tab("about:blank")
            content_id = content["id"]
            # Give the tab a non-blank URL without leaving the tab:
            # data:/http(s): navigations are refused at the CDP layer
            # (W4-P2-8), so flip the fragment via page JS instead. The
            # reaper's predicate is URL-based; about:blank#x is content.
            launcher.cdp.evaluate(content, "location.hash='morrow'")
            curl = [t.get("url") for t in launcher.cdp.tabs()
                    if t.get("id") == content_id]
            check("real: content tab has a non-blank URL",
                  bool(curl) and curl[0] not in ("", "about:blank"))
            time.sleep(1)
            reaped = launcher.reap_idle_tabs(0)
            live_ids = {t.get("id") for t in launcher.cdp.tabs()}
            check("real: idle blank tab is reaped", temp_id in reaped)
            check("real: reaped tab is gone from the browser",
                  temp_id not in live_ids)
            check("real: protected main tab is never reaped",
                  main_id not in reaped and main_id in live_ids)
            check("real: tab with a non-blank URL is never reaped",
                  content_id not in reaped and content_id in live_ids)
            reg = lc._read_tab_registry(profile)
            check("real: registry pruned the reaped tab",
                  temp_id not in reg and main_id in reg)

            # --- memory_watch.py exit codes ---
            watch = os.path.join(TREE, "helper", "memory_watch.py")

            def run_watch(extra):
                env = dict(os.environ,
                           MEMORY_WATCH_PROFILE_DIR=profile)
                env.update(extra)
                return subprocess.run([sys.executable, watch],
                                      env=env, capture_output=True,
                                      text=True, timeout=60)

            p = run_watch({"CHROMIUM_MAX_RSS_MB": "1"})
            check("real: memory_watch exits 3 over a 1MB threshold",
                  p.returncode == 3 and "verdict=rss" in p.stdout)
            p = run_watch({"CHROMIUM_MAX_RSS_MB": "999999"})
            check("real: memory_watch exits 0 under a huge threshold",
                  p.returncode == 0 and "verdict=ok" in p.stdout)
            p = run_watch({"MEMORY_WATCH_PROFILE_DIR":
                           os.path.join(scratch, "profile-unknown")})
            check("real: memory_watch exits 0 for an unknown identity",
                  p.returncode == 0)

            # --- W3-P2-16: restart ownership lives in keepalive.sh ---
            # Browser restarts in production are owned by exactly one
            # path: helper/keepalive.sh's recover_helper. The
            # launcher-level restart_owned_browser was production-dead
            # code and is removed; the launcher exposes stop()/start()
            # for direct use. Pin the removal: the method must not
            # exist, so no caller can depend on the dead ownership
            # story again.
            check("real: launcher has no restart_owned_browser "
                  "(restarts owned by keepalive.sh recover_helper)",
                  not hasattr(lc.ChromiumLauncher, "restart_owned_browser"))
            # --- owned restart via stop()/start() ---
            # The session survives on the persistent profile: cookies
            # live on disk, so the relaunch re-reads them.
            launcher.stop()
            check("real: old main pid is gone after stop()",
                  not _pid_alive(main_pid))
            launcher.start()
            new_pid = launcher.proc.pid if launcher.proc else None
            check("real: restart yields a new main pid",
                  new_pid is not None and new_pid != main_pid)
            check("real: new browser answers CDP", launcher.is_running())
            check("real: same profile still owned after restart",
                  new_pid in lc.find_chromium_pids(profile))
        finally:
            launcher2.stop()
    finally:
        launcher.stop()

    # No stragglers: kill anything still matching, by exact PID.
    for pid in lc.find_chromium_pids(profile):
        try:
            os.kill(pid, 9)
        except OSError:
            pass
    for pid in lc.find_chromium_pids(profile2):
        try:
            os.kill(pid, 9)
        except OSError:
            pass
    time.sleep(1)
    check("real: no stragglers after stop",
          lc.find_chromium_pids(profile) == []
          and lc.find_chromium_pids(profile2) == [])
    return True


def main():
    # Wave 4: scratch Chromium, ports, and profiles stay under the mandated
    # worker-browser directory, never the bare workspace root.
    base = os.path.expanduser(
        "~/workspace/audits/adversarial-wave-4-2026-09-21/scratch/worker-browser")
    os.makedirs(base, exist_ok=True)
    scratch = tempfile.mkdtemp(prefix="chromium-memory-selftest-", dir=base)
    print("scratch: %s" % scratch)
    try:
        test_fake_tree(scratch)
        test_real_browser(scratch)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    print("chromium memory selftest: %d pass, %d fail" % (PASS, FAIL))
    if FAILURES:
        print("failures: %s" % "; ".join(FAILURES))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
