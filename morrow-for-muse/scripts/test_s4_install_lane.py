#!/usr/bin/env python3
"""Sweep-4 muse-install lane: installer and rig-script regressions.

Failure modes this suite pins down (written before the fix):
  F5. install.sh normalized or deduped a PRE-EXISTING keepalive cron
      entry and still recorded ledger entry "cron", so a later
      failure's rollback deleted supervision that predates the run.
      Only a genuinely new entry is tracked now: a normalized entry
      survives the rollback, a created one is still removed.
  F6. The upgrade backup build/verify shelled out to sha256sum, which
      macOS does not ship and the prereq gate never listed, so every
      macOS version-change upgrade failed at backup. The manifest
      build and verify are python3 now (a hard requirement).
  F7. Backup retention sorted by reverse-lexicographic path (wrong on
      same-second ties) and its .bak-* glob also matched quarantined
      .PARTIAL dirs and sidecar files. Retention is mtime-newest-first
      over backup dirs only; .PARTIAL forensics are never pruned.
  F8. install-record ledger entries were tracked before the atomic
      renames, so an install-record failure on a reinstall
      rollback-deleted the previous version's records. Pre-existing
      records are never tracked now.
  F9. _build_backup_manifest piped find into xargs sha256sum without
      -print0/-0, so tree filenames with whitespace broke the manifest
      and failed the upgrade. The python3 builder handles them.
  F12. bin/keepalive-canvas.sh only handled the 401 expiry signal and
      matched a 100-char body head, missing the documented 302-to-login
      signal (fetch follows the redirect, so it surfaces as the login
      page URL). It now checks the full parsed body and the landing URL.

End to end: the real install.sh from a carved tree (F5-F9) and the real
keepalive-canvas.sh against stub CDP/state-machine modules (F12), in
scratch under .selftest-work/ and dist/ (never /tmp). The F5 runs fail
fast at the step-8 secrets gate (a planted content-pattern line in
helper/env, which the gate still checks). The install-record and
exported-tenant checks run all shipped selftest suites.
"""

import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import time

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import carve  # noqa: E402

CANVAS_BASE_PAGE = "https://school.example.edu"
# A planted step-8 failure: session material the gate's content rules
# still check in helper/env (only the tenant rule skips that file).
PLANTED_SESSION_LINE = "canvas_session=abcdefghijklmnopqr"


def _write_exe(path, body):
    # Unlink first: opening a symlink with "w" would truncate its
    # target (a system tool), not replace the link.
    if os.path.lexists(path):
        os.unlink(path)
    with open(path, "w") as fh:
        fh.write(body)
    os.chmod(path, 0o755)


def _link_all(bindir, skip=()):
    """Every executable on PATH (by symlink) except `skip`; python3 is
    this interpreter, so the rig never depends on the system python."""
    os.makedirs(bindir, exist_ok=True)
    for parent in os.environ.get("PATH", "").split(os.pathsep):
        if not os.path.isdir(parent):
            continue
        for name in os.listdir(parent):
            dest, src = (os.path.join(bindir, name),
                         os.path.join(parent, name))
            if name in skip or os.path.lexists(dest) \
                    or os.path.isdir(src) or not os.access(src, os.X_OK):
                continue
            os.symlink(src, dest)
    for name in ("python3", "python"):
        dest = os.path.join(bindir, name)
        if os.path.lexists(dest):
            os.unlink(dest)
        os.symlink(sys.executable, dest)


FAKE_CRONTAB = """#!/bin/bash
f="${FAKE_CRONTAB_FILE}"
case "$1" in
  -l) [ -f "$f" ] && cat "$f" || exit 1 ;;
  -r) rm -f "$f" ;;
  -) cat > "$f" ;;
  *) cat > "$f" ;;
esac
"""

FAKE_CHROMIUM = """#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "Chromium 152.0.7977.90"
  exit 0
fi
echo "fake-chromium: unexpected args: $*" >&2
exit 1
"""


def _stop_processes_under(root):
    """SIGTERM every process whose command line names the scratch root."""
    try:
        out = subprocess.run(["ps", "-A", "-o", "pid=", "-o", "args="],
                             capture_output=True, text=True).stdout
    except OSError:
        return
    for line in out.splitlines():
        pid, _, command = line.strip().partition(" ")
        if root in command and pid.isdigit() and int(pid) != os.getpid():
            try:
                os.kill(int(pid), signal.SIGTERM)
            except OSError:
                pass


@pytest.fixture(scope="module")
def carved_base():
    base = os.path.join(os.path.dirname(TREE), "dist",
                        "s4-lane-%d" % os.getpid())
    out = os.path.join(base, carve.DIST_NAME)
    shutil.rmtree(base, ignore_errors=True)
    carve.carve(out, run_gate=False)
    try:
        yield out
    finally:
        _stop_processes_under(base)
        shutil.rmtree(base, ignore_errors=True)


@pytest.fixture(scope="module")
def lane_work():
    work = os.path.join(TREE, ".selftest-work",
                        "s4-lane-%d" % os.getpid())
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    try:
        yield work
    finally:
        _stop_processes_under(work)
        shutil.rmtree(work, ignore_errors=True)


def _fresh_tree(carved_base, lane_work, name):
    dest = os.path.join(lane_work, name)
    shutil.rmtree(dest, ignore_errors=True)
    shutil.copytree(carved_base, dest, symlinks=True)
    return dest


def _install(tree, env, timeout=600):
    proc = subprocess.run(["bash", os.path.join(tree, "install.sh")],
                          cwd=tree, env=env,
                          capture_output=True, text=True, timeout=timeout)
    return proc.returncode, proc.stdout + proc.stderr


def _base_env(bindir, home):
    return {"PATH": bindir, "HOME": home,
            "MORROW_HOME": os.path.join(home, ".morrow"),
            "LANG": "C.UTF-8",
            "https_proxy": "http://muse:proxy@127.0.0.1:9"}


def test_exported_tenant_reaches_tenant_probe_after_selftests(carved_base,
                                                            lane_work):
    tree = _fresh_tree(carved_base, lane_work, "exported-tenant-tree")
    work = os.path.join(lane_work, "exported-tenant")
    bindir = os.path.join(work, "bin")
    _link_all(bindir)
    for tool in ("ss", "flock"):
        if not os.path.lexists(os.path.join(bindir, tool)):
            _write_exe(os.path.join(bindir, tool), "#!/bin/sh\nexit 0\n")
    chrome = os.path.join(bindir, "fake-chromium")
    _write_exe(chrome, FAKE_CHROMIUM)
    # Refuse the tenant probe without opening any network connection.
    _write_exe(os.path.join(bindir, "curl"), "#!/bin/sh\nexit 7\n")
    home = os.path.join(work, "home")
    os.makedirs(home, exist_ok=True)
    tenant = "https://chcp.instructure.com"
    with open(os.path.join(tree, "helper", "env"), "w") as fh:
        fh.write("CANVAS_BASE=%s\n" % tenant)
    env = _base_env(bindir, home)
    env.update(CHROMIUM_BIN=chrome, MORROW_CRON="0", CANVAS_BASE=tenant,
               MORROW_LMS_PROVIDER="canvas",
               MORROW_INSTALL_TEST_SHOW_SELFTEST_FAILURES="1")
    rc, text = _install(tree, env)
    assert rc != 0, text[-3000:]
    assert "ok: 23/23 selftest suites pass" in text, text[-6000:]
    assert "INSTALL FAIL [tenant]" in text, text[-3000:]
    assert "INSTALL FAIL [selftest]" not in text, text[-6000:]


# ------------------------------------------------------- F12: canvas rig

STUB_CDP = """import json, os
def tab_fetch(base, path, want_url=False):
    with open(os.environ["CANVAS_CANNED"]) as fh:
        canned = json.load(fh)
    if "error" in canned:
        raise RuntimeError(canned["error"])
    if want_url:
        return canned["status"], canned["body"], canned.get("url", "")
    return canned["status"], canned["body"]
"""

STUB_STATE_MACHINE = """import os, sys
with open(os.environ["CANVAS_SM_CALLS"], "a") as fh:
    fh.write(" ".join(sys.argv[1:]) + "\\n")
print("classify: stubbed")
"""


def _canvas_run(tmp_path, canned):
    """Run the REAL keepalive-canvas.sh against stub cdp + state machine
    modules planted in a scratch tree shaped like a deploy dir."""
    root = tmp_path / "canvas"
    for part in ("bin", "session", "reauth", "logs", "home"):
        (root / part).mkdir(parents=True)
    shutil.copy2(os.path.join(TREE, "bin", "keepalive-canvas.sh"),
                 str(root / "bin" / "keepalive-canvas.sh"))
    (root / "session" / "cdp.py").write_text(STUB_CDP)
    (root / "reauth" / "state_machine.py").write_text(STUB_STATE_MACHINE)
    (root / "home" / "session.json").write_text(json.dumps(
        {"canvas": {"base": CANVAS_BASE_PAGE}}))
    canned_path = root / "canned.json"
    canned_path.write_text(json.dumps(canned))
    calls_path = root / "sm-calls.txt"
    env = dict(os.environ, MORROW_HOME=str(root / "home"),
               CANVAS_CANNED=str(canned_path),
               CANVAS_SM_CALLS=str(calls_path))
    proc = subprocess.run(["bash", str(root / "bin" / "keepalive-canvas.sh")],
                          cwd=str(root), env=env,
                          capture_output=True, text=True, timeout=120)
    try:
        calls = calls_path.read_text()
    except OSError:
        calls = ""
    try:
        log = (root / "logs" / "keepalive-canvas.log").read_text()
    except OSError:
        log = ""
    return proc.returncode, calls, log


def test_canvas_401_hands_to_the_state_machine(tmp_path):
    rc, calls, log = _canvas_run(
        tmp_path, {"status": 401,
                   "body": '{"status":"unauthenticated","x":1}',
                   "url": CANVAS_BASE_PAGE + "/api/v1/users/self/profile"})
    assert rc == 1
    assert "detect --status 401" in calls
    assert "EXPIRY 401" in log


def test_canvas_200_clean_exits_zero_without_handoff(tmp_path):
    rc, calls, log = _canvas_run(
        tmp_path, {"status": 200, "body": '{"id":7,"name":"Edu"}',
                   "url": CANVAS_BASE_PAGE + "/api/v1/users/self/profile"})
    assert rc == 0, log
    assert calls == ""


def test_canvas_unauthenticated_body_buried_deep_is_expiry(tmp_path):
    # The marker sits past the old 100-char head and pretty-printed:
    # the old substring missed it and exited 0.
    body = '{"data":"%s","status": "unauthenticated"}' % ("x" * 150)
    assert body.index("unauthenticated") > 100
    rc, calls, log = _canvas_run(
        tmp_path, {"status": 200, "body": body,
                   "url": CANVAS_BASE_PAGE + "/api/v1/users/self/profile"})
    assert rc == 1, log
    assert "detect --status 200" in calls
    assert '{"status":"unauthenticated"}' in calls


def test_canvas_login_landing_reports_the_302_signal(tmp_path):
    # fetch followed the redirect: status 200, but the landing URL is
    # the login page. The old script saw a clean 200 and exited 0.
    rc, calls, log = _canvas_run(
        tmp_path, {"status": 200, "body": "<html>sign in</html>",
                   "url": CANVAS_BASE_PAGE + "/login"})
    assert rc == 1, log
    assert "detect --status 302" in calls
    assert "--location %s/login" % CANVAS_BASE_PAGE in calls
    assert "302-to-/login" in log


def test_canvas_probe_error_never_trips_expiry(tmp_path):
    rc, calls, log = _canvas_run(tmp_path, {"error": "CDP unreachable"})
    assert rc == 2
    assert calls == ""
    assert "ERROR probe failed" in log


# --------------------------------- F6+F7+F9: upgrade backup and retention

def _spaced_file(tree):
    rel = os.path.join("notes", "field notes jan.txt")
    path = os.path.join(tree, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        fh.write("field notes\n")
    manifest_path = os.path.join(tree, "pack", "carve-manifest.json")
    with open(manifest_path, encoding="utf-8") as fh:
        manifest = json.load(fh)
    with open(path, "rb") as fh:
        digest = hashlib.sha256(fh.read()).hexdigest()
    manifest["files"][rel] = digest
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=1, sort_keys=True)
        fh.write("\n")
    return rel


def test_upgrade_backup_needs_no_sha256sum_and_prunes_by_mtime(
        carved_base, lane_work):
    tree = _fresh_tree(carved_base, lane_work, "f67-tree")
    work = os.path.join(lane_work, "f67")
    os.makedirs(work, exist_ok=True)
    bindir = os.path.join(work, "bin")
    _link_all(bindir, skip=("sha256sum",))
    assert shutil.which("sha256sum", path=bindir) is None
    for tool in ("ss", "flock"):
        if not os.path.lexists(os.path.join(bindir, tool)):
            _write_exe(os.path.join(bindir, tool), "#!/bin/sh\nexit 0\n")
    home = os.path.join(work, "home")
    morrow_home = os.path.join(home, ".morrow")
    os.makedirs(morrow_home, exist_ok=True)

    spaced = _spaced_file(tree)
    with open(os.path.join(tree, "pack", "carve-manifest.json"),
              encoding="utf-8") as fh:
        manifest = json.load(fh)
    with open(os.path.join(morrow_home, "installed-version"), "w") as fh:
        fh.write("0.0.0-s4old\n")
    with open(os.path.join(morrow_home, "installed-manifest.json"),
              "w") as fh:
        json.dump(manifest, fh)

    # Old backups whose reverse-lexicographic order is the reverse of
    # their mtime order, plus sidecars and a quarantined .PARTIAL.
    parent, base = os.path.dirname(tree), os.path.basename(tree)
    olds = [(".bak-20200101-000000-1-AAAAAA", 100),   # mtime-newest
            (".bak-20210101-000000-1-AAAAAA", 200),
            (".bak-20220101-000000-1-AAAAAA", 300),
            (".bak-20230101-000000-1-AAAAAA", 400)]   # mtime-oldest
    now = time.time()
    for suffix, age in olds:
        path = parent + "/" + base + suffix
        os.makedirs(path)
        with open(os.path.join(path, "marker.txt"), "w") as fh:
            fh.write("old backup %s\n" % suffix)
        with open(path + ".sha256", "w") as fh:
            fh.write("sidecar\n")
        if suffix.startswith(".bak-2023"):
            with open(path + ".meta", "w") as fh:
                fh.write("meta\n")
        stamp = (now - age, now - age)
        os.utime(os.path.join(path, "marker.txt"), stamp)
        os.utime(path, stamp)
    partial = parent + "/" + base + ".bak-20200101-000000-9-QQQQQQ.PARTIAL"
    os.makedirs(partial)
    with open(os.path.join(partial, "forensics.txt"), "w") as fh:
        fh.write("do not prune\n")
    with open(partial + ".sha256", "w") as fh:
        fh.write("sidecar\n")

    env = _base_env(bindir, home)
    env["MORROW_CRON"] = "0"
    # Muse has an absolute-path Chromium fallback even when PATH omits it.
    env["CHROMIUM_BIN"] = os.path.join(work, "missing-chromium")
    rc, text = _install(tree, env)
    assert rc != 0, text[-3000:]
    # Past backup, retention, and migration without sha256sum: the run
    # fails later, at the chromium probe (no Chromium here).
    assert "INSTALL FAIL [chromium]" in text, text[-3000:]
    assert "sha256sum" not in text, text[-3000:]
    assert "restore complete" in text, text[-3000:]
    assert os.path.isfile(os.path.join(tree, spaced))

    remaining = sorted(name for name in os.listdir(parent)
                       if name.startswith(base + ".bak-")
                       and not name.endswith(".PARTIAL")
                       and os.path.isdir(os.path.join(parent, name)))
    # The run's own backup was consumed by the restore; the two
    # mtime-newest olds survive, whatever their names sort as.
    assert remaining == [base + ".bak-20200101-000000-1-AAAAAA",
                         base + ".bak-20210101-000000-1-AAAAAA"], remaining
    for suffix, _ in olds[2:]:
        gone = parent + "/" + base + suffix
        assert not os.path.exists(gone), gone
        assert not os.path.exists(gone + ".sha256"), gone
    assert not os.path.exists(parent + "/" + base
                               + ".bak-20230101-000000-1-AAAAAA.meta")
    assert os.path.isfile(os.path.join(partial, "forensics.txt"))
    assert os.path.isfile(partial + ".sha256")
    failed = [name for name in os.listdir(parent)
              if name.startswith(base + ".failed-")]
    assert len(failed) == 1


# ------------------------------------------------------ F5: cron ledger

def _cron_env(tree, work):
    """A rig that reaches step 7's cron install and fails fast at the
    step-8 secrets gate (planted session line in helper/env). Returns
    (env, crontab_file)."""
    bindir = os.path.join(work, "bin")
    _link_all(bindir)
    for tool in ("ss", "flock"):
        if not os.path.lexists(os.path.join(bindir, tool)):
            _write_exe(os.path.join(bindir, tool), "#!/bin/sh\nexit 0\n")
    _write_exe(os.path.join(bindir, "crontab"), FAKE_CRONTAB)
    chrome = os.path.join(bindir, "fake-chromium")
    _write_exe(chrome, FAKE_CHROMIUM)
    home = os.path.join(work, "home")
    os.makedirs(os.path.join(home, ".morrow"), exist_ok=True)
    env_file = os.path.join(tree, "helper", "env")
    with open(env_file, "w") as fh:
        fh.write("CANVAS_BASE=https://myschool.instructure.com\n%s\n"
                 % PLANTED_SESSION_LINE)
    os.chmod(env_file, 0o600)
    crontab_file = os.path.join(work, "crontab.txt")
    env = _base_env(bindir, home)
    env["CHROMIUM_BIN"] = chrome
    env["FAKE_CRONTAB_FILE"] = crontab_file
    for var in ("CANVAS_BASE", "MOODLE_BASE", "MORROW_CRON"):
        env.pop(var, None)
    return env, crontab_file


def _ensure_cron_path(tree, env):
    """supervisor.detect() must choose cron in this rig (a fake cron
    daemon on Linux, where /proc exists; macOS has no /proc and always
    qualifies). Returns a cleanup callable."""
    detect = subprocess.run(
        [sys.executable, os.path.join(tree, "helper", "supervisor.py"),
         "detect"],
        env=dict(env, PATH=env["PATH"] + os.pathsep + os.environ["PATH"]),
        capture_output=True, text=True, timeout=60).stdout.strip()
    if detect == "cron":
        return lambda: None
    if not os.path.isdir("/proc"):
        pytest.fail("supervisor chose %r, not cron" % detect)
    try:
        sleeper = subprocess.Popen(
            [sys.executable, "-c",
             "import ctypes, time; "
             "ctypes.CDLL('libc.so.6').prctl(15, b'cron', 0, 0, 0); "
             "time.sleep(300)"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        pytest.skip("no cron daemon and cannot fake one here")
    detect = subprocess.run(
        [sys.executable, os.path.join(tree, "helper", "supervisor.py"),
         "detect"],
        env=dict(env, PATH=env["PATH"] + os.pathsep + os.environ["PATH"]),
        capture_output=True, text=True, timeout=60).stdout.strip()
    if detect != "cron":
        sleeper.terminate()
        pytest.skip("no cron daemon on this machine")

    def _cleanup():
        sleeper.terminate()
        try:
            sleeper.wait(timeout=10)
        except subprocess.TimeoutExpired:
            sleeper.kill()
    return _cleanup


def _read_table(crontab_file):
    try:
        with open(crontab_file) as fh:
            return fh.read()
    except OSError:
        return ""


def test_normalized_cron_entry_survives_a_later_failure(carved_base,
                                                        lane_work):
    tree = _fresh_tree(carved_base, lane_work, "f5-tree-norm")
    work = os.path.join(lane_work, "f5-norm")
    os.makedirs(work, exist_ok=True)
    env, crontab_file = _cron_env(tree, work)
    with open(crontab_file, "w") as fh:
        fh.write("0 * * * * %s/helper/keepalive.sh\n" % tree)
    cleanup = _ensure_cron_path(tree, env)
    try:
        rc, text = _install(tree, env)
    finally:
        cleanup()
    assert rc != 0, text[-3000:]
    assert "INSTALL FAIL [secrets]" in text, text[-3000:]
    assert "normalizing this tree's keepalive entry" in text, text[-3000:]
    table = _read_table(crontab_file)
    canonical = '*/5 * * * * "%s/helper/keepalive.sh"' % tree
    assert canonical in table, table
    assert "morrow-muse-connector-keepalive" in table, table


def test_fresh_cron_entry_is_still_rolled_back(carved_base, lane_work):
    tree = _fresh_tree(carved_base, lane_work, "f5-tree-fresh")
    work = os.path.join(lane_work, "f5-fresh")
    os.makedirs(work, exist_ok=True)
    env, crontab_file = _cron_env(tree, work)
    cleanup = _ensure_cron_path(tree, env)
    try:
        rc, text = _install(tree, env)
    finally:
        cleanup()
    assert rc != 0, text[-3000:]
    assert "INSTALL FAIL [secrets]" in text, text[-3000:]
    assert "installed keepalive cron for this tree" in text, text[-3000:]
    assert tree not in _read_table(crontab_file)


# -------------------------------------------- F8: install-record ledger

def test_reinstall_keeps_prior_records_when_record_step_fails(carved_base,
                                                              lane_work):
    tree = _fresh_tree(carved_base, lane_work, "f8-tree")
    work = os.path.join(lane_work, "f8")
    os.makedirs(work, exist_ok=True)
    bindir = os.path.join(work, "bin")
    _link_all(bindir)
    for tool in ("ss", "flock"):
        if not os.path.lexists(os.path.join(bindir, tool)):
            _write_exe(os.path.join(bindir, tool), "#!/bin/sh\nexit 0\n")
    chrome = os.path.join(bindir, "fake-chromium")
    _write_exe(chrome, FAKE_CHROMIUM)
    real_mv = shutil.which("mv")
    assert real_mv
    _write_exe(os.path.join(bindir, "mv"),
               "#!/bin/bash\n"
               'for a in "$@"; do\n'
               "  case \"$a\" in *installed-manifest*|*installed-version*)"
               " exit 1;;\n"
               "  esac\n"
               "done\n"
               'exec "%s" "$@"\n' % real_mv)
    home = os.path.join(work, "home")
    morrow_home = os.path.join(home, ".morrow")
    os.makedirs(morrow_home, exist_ok=True)
    with open(os.path.join(tree, "VERSION"), encoding="utf-8") as fh:
        version = fh.read().strip()
    with open(os.path.join(tree, "pack", "carve-manifest.json"),
              "rb") as fh:
        manifest_bytes = fh.read()
    with open(os.path.join(morrow_home, "installed-version"), "w") as fh:
        fh.write(version + "\n")
    with open(os.path.join(morrow_home, "installed-manifest.json"),
              "wb") as fh:
        fh.write(manifest_bytes)

    env = _base_env(bindir, home)
    env["CHROMIUM_BIN"] = chrome
    env["MORROW_CRON"] = "0"
    for var in ("CANVAS_BASE", "MOODLE_BASE"):
        env.pop(var, None)
    rc, text = _install(tree, env, timeout=1500)
    assert rc != 0, text[-3000:]
    assert "INSTALL FAIL [install-record]" in text, text[-3000:]
    with open(os.path.join(morrow_home, "installed-manifest.json"),
              "rb") as fh:
        assert fh.read() == manifest_bytes
    with open(os.path.join(morrow_home, "installed-version"),
              encoding="utf-8") as fh:
        assert fh.read() == version + "\n"
    assert "rollback removed: %s/installed-manifest.json" % morrow_home \
        not in text
