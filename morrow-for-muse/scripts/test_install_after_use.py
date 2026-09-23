#!/usr/bin/env python3
"""install.sh runs again after the educator connected and signed in.

Failure modes this suite pins down (written before the fix; final sweep
2026-09-23):
  1. Connecting writes CANVAS_BASE=https://<school>.instructure.com to
     helper/env and runs install.sh again. Step 8's secrets gate denied
     every *.instructure.com host that is not a placeholder, helper/env
     included, so the connect, reconnect, repair, and upgrade runs all
     failed for a real school ("INSTALL FAIL [secrets]").
  2. Once the helper's Chromium had run, helper/profile held Cookies,
     Login Data, Web Data, *.db, *.log, and Trust Tokens. The helper
     suite matched every file under helper/, the live profile included,
     against the deny-list, so every later install failed at step 9
     ("INSTALL FAIL [selftest]"), and an upgrade rolled back.
  3. INSTALL.md's upgrade copies the new release over the tree before
     install.sh runs, so the installer's backup holds the new release.
     A failed upgrade restored that backup and printed "pre-upgrade tree
     is back", while the tree held the new release's files and the old
     release's leftovers.
  4. The gate must still check what helper/env holds: only the tenant
     rule skips it, so session material written there still fails.

End to end: the real install.sh from a carved tree, in a scratch HOME
and MORROW_HOME under .selftest-work/ and dist/ (never /tmp). The VM's
authenticated egress proxy is a stand-in nothing listens on, a stand-in
curl answers the Canvas address probe (no request reaches a school),
the helper's Chromium is a stand-in that reports its version and exits,
and MORROW_CRON=0 leaves supervision out. Slow: each install runs the
secrets gate and all install suites.
"""

import json
import os
import re
import shutil
import signal
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import carve  # noqa: E402

TENANT = "https://northwoods.instructure.com"
LOGIN_PAGE = "<html><head><title>Log In to Canvas</title></head></html>\n"
ERROR_PAGE = "<html><head><title>Page Not Found</title></head></html>\n"
# What the helper's Chromium leaves in helper/profile after it runs once
# (from a real first launch of Chrome 154): one file for each deny-list
# pattern such a profile matches.
USED_PROFILE = ("Default/Cookies", "Default/Cookies-journal",
                "Default/Network/Cookies", "Default/Login Data",
                "Default/Login Data For Account", "Default/Web Data",
                "Default/History", "Default/Trust Tokens",
                "Default/Local Storage/leveldb/000003.log",
                "Default/heavy_ad_intervention_opt_out.db",
                "first_party_sets.db", "Local State")
OLD_ONLY = "notes-from-the-previous-release.md"


def _bindir(bindir, work):
    """Every tool on PATH except crontab and curl; python3 is this
    interpreter; stubs for ss and flock where the machine lacks them
    (macOS); a curl that answers the Canvas address probe from a file
    and passes every other call to the real curl."""
    os.makedirs(bindir)
    for name in ("python3", "python"):
        path = os.path.join(bindir, name)
        with open(path, "w") as fh:
            fh.write('#!/bin/sh\nexec "%s" "$@"\n' % sys.executable)
        os.chmod(path, 0o755)
    real_curl = shutil.which("curl")
    assert real_curl, "curl is required"
    for d in os.environ.get("PATH", "").split(os.pathsep):
        if not os.path.isdir(d):
            continue
        for name in os.listdir(d):
            dest, src = os.path.join(bindir, name), os.path.join(d, name)
            if name in ("crontab", "curl") or os.path.lexists(dest) \
                    or os.path.isdir(src) or not os.access(src, os.X_OK):
                continue
            os.symlink(src, dest)
    for tool in ("ss", "flock"):
        if not os.path.lexists(os.path.join(bindir, tool)):
            with open(os.path.join(bindir, tool), "w") as fh:
                fh.write("#!/bin/sh\nexit 0\n")
            os.chmod(os.path.join(bindir, tool), 0o755)
    page = os.path.join(work, "tenant-page.html")
    with open(os.path.join(bindir, "curl"), "w") as fh:
        fh.write("""#!/bin/bash
for arg in "$@"; do
  case "$arg" in
    https://*.instructure.com*)
      out=""; prev=""
      for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
      if [ -n "$out" ]; then cat "%s" > "$out"; else cat "%s"; fi
      exit 0 ;;
  esac
done
exec "%s" "$@"
""" % (page, page, real_curl))
    os.chmod(os.path.join(bindir, "curl"), 0o755)
    chrome = os.path.join(bindir, "fake-chromium")
    with open(chrome, "w") as fh:
        fh.write('#!/bin/sh\nif [ "$1" = "--version" ]; then '
                 'echo "Chromium 152.0.7977.90"; exit 0; fi\nexit 1\n')
    os.chmod(chrome, 0o755)
    assert shutil.which("crontab", path=bindir) is None
    return chrome, page


def _stop_processes_under(root):
    """Stop every process whose command line names the scratch root:
    the helper and anything keepalive started for this tree."""
    out = subprocess.run(["ps", "-A", "-o", "pid=", "-o", "args="],
                         capture_output=True, text=True).stdout
    for line in out.splitlines():
        pid, _, command = line.strip().partition(" ")
        if root in command and pid.isdigit() and int(pid) != os.getpid():
            try:
                os.kill(int(pid), signal.SIGTERM)
            except OSError:
                pass


@pytest.fixture(scope="module")
def rig():
    work = os.path.join(TREE, ".selftest-work", "after-use-%d" % os.getpid())
    base = os.path.join(os.path.dirname(TREE), "dist",
                        "after-use-test-%d" % os.getpid())
    out = os.path.join(base, carve.DIST_NAME)
    shutil.rmtree(work, ignore_errors=True)
    shutil.rmtree(base, ignore_errors=True)
    os.makedirs(work)
    carve.carve(out, run_gate=False)
    chrome, page = _bindir(os.path.join(work, "bin"), work)
    home = os.path.join(work, "home")
    os.makedirs(home)
    env = {"PATH": os.path.join(work, "bin"), "HOME": home,
           "MORROW_HOME": os.path.join(home, ".morrow"),
           "CHROMIUM_BIN": chrome, "LANG": "C.UTF-8", "MORROW_CRON": "0",
           "https_proxy": "http://muse:proxy@127.0.0.1:9"}
    rig = {"tree": out, "env": env, "home": env["MORROW_HOME"],
           "page": page}
    _tenant_page(rig, LOGIN_PAGE)
    try:
        rc, text = _install(rig)
        assert rc == 0, text[-3000:]
        assert "CANVAS_BASE is not set yet" in text
        yield rig
    finally:
        _stop_processes_under(work)
        _stop_processes_under(base)
        shutil.rmtree(base, ignore_errors=True)
        shutil.rmtree(work, ignore_errors=True)


def _tenant_page(rig, html):
    with open(rig["page"], "w") as fh:
        fh.write(html)


def _install(rig):
    proc = subprocess.run(["bash", os.path.join(rig["tree"], "install.sh")],
                          cwd=rig["tree"], env=rig["env"],
                          capture_output=True, text=True, timeout=1800)
    return proc.returncode, proc.stdout + proc.stderr


def _read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def _connect_and_sign_in(tree):
    """What the connect flow and the helper's first run leave in the
    tree: the school's address in helper/env and a used profile."""
    env_file = os.path.join(tree, "helper", "env")
    with open(env_file, "w") as fh:
        fh.write("CANVAS_BASE=%s\n" % TENANT)
    os.chmod(env_file, 0o600)
    for rel in USED_PROFILE:
        path = os.path.join(tree, "helper", "profile", rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as fh:
            fh.write("browser state\n")


def _assert_signed_in_state_kept(tree):
    assert _read(os.path.join(tree, "helper", "env")) == \
        "CANVAS_BASE=%s\n" % TENANT
    for rel in USED_PROFILE:
        assert os.path.isfile(os.path.join(tree, "helper", "profile", rel)), \
            rel


def _suites_passed(text):
    m = re.search(r"ok: (\d+)/(\d+) selftest suites pass", text)
    return bool(m) and m.group(1) == m.group(2)


def test_rerun_after_connecting_and_signing_in(rig):
    tree = rig["tree"]
    _tenant_page(rig, LOGIN_PAGE)
    _connect_and_sign_in(tree)
    rc, text = _install(rig)
    assert rc == 0, text[-3000:]
    assert "DENIED" not in text, text[-3000:]
    assert "INSTALL FAIL" not in text, text[-3000:]
    assert "verify-no-secrets: PASS" in text
    assert _suites_passed(text), text[-3000:]
    assert "ok: tenant reachable" in text
    assert "Install complete." in text
    _assert_signed_in_state_kept(tree)


def test_failed_upgrade_says_what_it_restored_and_a_rerun_finishes(rig):
    tree, home = rig["tree"], rig["home"]
    version = _read(os.path.join(tree, "VERSION")).strip()
    _connect_and_sign_in(tree)
    # The previous release as its install recorded it: an older version
    # whose manifest listed a file this release no longer ships. Step 1
    # copied the new release over it, so that file is still in the tree.
    with open(os.path.join(tree, "pack", "carve-manifest.json")) as fh:
        old = json.load(fh)
    old["files"][OLD_ONLY] = "0" * 64
    with open(os.path.join(home, "installed-manifest.json"), "w") as fh:
        json.dump(old, fh)
    with open(os.path.join(home, "installed-version"), "w") as fh:
        fh.write("0.4.0\n")
    with open(os.path.join(tree, OLD_ONLY), "w") as fh:
        fh.write("left by the previous release\n")

    # The school's address serves a Canvas error page, so the upgrade
    # fails at its last step, after the backup and the stale-file
    # removal.
    _tenant_page(rig, ERROR_PAGE)
    rc, text = _install(rig)
    assert rc != 0, text[-3000:]
    assert "upgrade detected: 0.4.0 -> %s" % version in text
    assert "removed: %s" % OLD_ONLY in text
    assert "verify-no-secrets: PASS" in text, text[-3000:]
    assert _suites_passed(text), text[-3000:]
    assert "INSTALL FAIL [tenant]" in text, text[-3000:]
    assert "pre-upgrade" not in text, text[-3000:]
    flat = " ".join(text.split())
    assert "is back as this installer found it" in flat, text[-3000:]
    assert "not the previous release" in flat, text[-3000:]
    assert "then run bash install.sh again" in flat, text[-3000:]
    # The restored tree is the one the installer found: this release's
    # files, the previous release's leftover, the sign-in, and no
    # record of the new version.
    assert _read(os.path.join(tree, "VERSION")).strip() == version
    assert os.path.isfile(os.path.join(tree, OLD_ONLY))
    assert _read(os.path.join(home, "installed-version")) == "0.4.0\n"
    _assert_signed_in_state_kept(tree)

    # Fix the cause and run the installer again: the upgrade finishes.
    _tenant_page(rig, LOGIN_PAGE)
    rc, text = _install(rig)
    assert rc == 0, text[-3000:]
    assert "upgrade detected: 0.4.0 -> %s" % version in text
    assert "Install complete." in text
    assert not os.path.exists(os.path.join(tree, OLD_ONLY))
    assert _read(os.path.join(home, "installed-version")).strip() == version
    _assert_signed_in_state_kept(tree)


def _step8_assignments():
    """The variables install.sh step 8 sets for the secrets gate."""
    text = _read(os.path.join(TREE, "install.sh"))
    line = next(l for l in text.splitlines()
                if '"${TREE}/scripts/verify-no-secrets.sh" "${TREE}"' in l)
    pairs = re.findall(r'(\w+)="([^"$]*)"', line.split('"${TREE}', 1)[0])
    assert pairs, line
    return dict(pairs)


@pytest.fixture
def gate_tree():
    import pathlib
    import tempfile
    work = os.path.join(TREE, ".selftest-work")
    os.makedirs(work, exist_ok=True)
    root = pathlib.Path(tempfile.mkdtemp(prefix="gate-", dir=work))
    for rel in ("pack/deny-list.txt", "scripts/verify-no-secrets.sh"):
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(os.path.join(TREE, rel), root / rel)
    (root / "helper").mkdir()
    try:
        yield root
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _gate(root):
    env = dict(os.environ, **_step8_assignments())
    proc = subprocess.run(["bash", str(root / "scripts/verify-no-secrets.sh"),
                           str(root)], env=env, capture_output=True,
                          text=True, timeout=120)
    return proc.returncode, proc.stdout + proc.stderr


def test_the_install_gate_accepts_the_school_address_in_helper_env(gate_tree):
    (gate_tree / "helper" / "env").write_text(
        "CANVAS_BASE=%s\nLOGIN_HELPER_PORT=8901\n" % TENANT)
    rc, text = _gate(gate_tree)
    assert rc == 0, text


def test_the_install_gate_still_checks_what_helper_env_holds(gate_tree):
    (gate_tree / "helper" / "env").write_text(
        "CANVAS_BASE=%s\ncanvas_session=%s\n" % (TENANT, "a" * 24))
    rc, text = _gate(gate_tree)
    assert rc != 0, text
    assert "helper/env (content pattern" in text, text


def test_the_install_gate_still_denies_a_school_address_elsewhere(gate_tree):
    (gate_tree / "helper" / "env").write_text("CANVAS_BASE=%s\n" % TENANT)
    (gate_tree / "helper" / "notes.md").write_text("see %s\n" % TENANT)
    rc, text = _gate(gate_tree)
    assert rc != 0, text
    assert "helper/notes.md (non-example tenant host" in text, text
    assert "helper/env" not in text, text
