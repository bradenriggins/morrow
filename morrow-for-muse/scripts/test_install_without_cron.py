#!/usr/bin/env python3
"""install.sh installs on a machine without cron, and installs again.

Failure modes this suite pins down (written before the fix; final sweep
2026-09-22):
  1. The Muse VM has no cron. Step 7 started the keepalive background
     loop, whose log (helper/keepalive-supervisor.log) landed inside the
     tree, and step 8's secrets gate denied it (*.log). Every fresh
     install failed and rolled back.
  2. A rerun after the helper had run found helper/keepalive.log and
     helper/server.log inside the tree and failed the same gate, so
     "safe to run twice", the reconnect after `morrow disconnect`, and
     in-place upgrades all failed.
  3. A rotated helper/keepalive.log.1 failed the integrity walk as an
     extra file.
  4. A fresh install never minted .morrow-tree-id (the mint sat inside
     the upgrade branch), so the tree's state dir followed its path.
Runtime files belong in the tree's state dir
(<MORROW_HOME>/trees/<tree id>/). A tree that an older release already
ran keeps them in helper/; the installer moves them out before either
gate reads the tree.

End to end: the real install.sh from a carved tree, a PATH with no
crontab, a scratch HOME and MORROW_HOME. No helper starts (CANVAS_BASE
stays unset). Scratch lives under .selftest-work/ and dist/ (never
/tmp). Slow: each install runs the secrets gate and the 23 suites.
Linux only, like the Muse VM: the helper suites read /proc and use
flock.
"""

import json
import os
import re
import shutil
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import carve  # noqa: E402

RUNTIME_NAME = re.compile(
    r"(^|/)(keepalive|server|keepalive-supervisor)\.log(\.\d+)?$"
    r"|(^|/)keepalive-supervisor\.json(\.lock)?$")


def _no_cron_path(bindir):
    """Every tool on PATH except crontab, plus shims for the two Linux
    tools a macOS dev machine lacks (the no-cron path never calls
    them). python3 is the interpreter running this suite, so the
    install suites see the same optional packages."""
    os.makedirs(bindir)
    for name in ("python3", "python"):
        with open(os.path.join(bindir, name), "w") as fh:
            fh.write('#!/bin/sh\nexec "%s" "$@"\n' % sys.executable)
        os.chmod(os.path.join(bindir, name), 0o755)
    for d in os.environ.get("PATH", "").split(os.pathsep):
        if not os.path.isdir(d):
            continue
        for name in os.listdir(d):
            dest = os.path.join(bindir, name)
            src = os.path.join(d, name)
            if name == "crontab" or os.path.lexists(dest) \
                    or os.path.isdir(src) or not os.access(src, os.X_OK):
                continue
            os.symlink(src, dest)
    for tool in ("ss", "flock"):
        if not os.path.lexists(os.path.join(bindir, tool)):
            with open(os.path.join(bindir, tool), "w") as fh:
                fh.write("#!/bin/sh\nexit 0\n")
            os.chmod(os.path.join(bindir, tool), 0o755)
    chrome = os.path.join(bindir, "fake-chromium")
    with open(chrome, "w") as fh:
        fh.write("#!/bin/sh\necho 'Chromium 152.0.7977.90'\n")
    os.chmod(chrome, 0o755)
    assert shutil.which("crontab", path=bindir) is None
    return chrome


pytestmark = pytest.mark.skipif(
    not sys.platform.startswith("linux"),
    reason="install.sh's helper suites need Linux (/proc, flock), like "
           "the Muse VM")


@pytest.fixture(scope="module")
def rig():
    work = os.path.join(TREE, ".selftest-work", "nocron-%d" % os.getpid())
    out = os.path.join(os.path.dirname(TREE), "dist",
                       "nocron-test-%d" % os.getpid(), carve.DIST_NAME)
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    carve.carve(out, run_gate=False)
    bindir = os.path.join(work, "bin")
    chrome = _no_cron_path(bindir)
    home = os.path.join(work, "home")
    os.makedirs(home)
    env = {"PATH": bindir, "HOME": home,
           "MORROW_HOME": os.path.join(home, ".morrow"),
           "CHROMIUM_BIN": chrome, "LANG": "C.UTF-8"}
    rig = {"tree": out, "env": env, "home": env["MORROW_HOME"]}
    try:
        yield rig
    finally:
        subprocess.run(
            [sys.executable, os.path.join(out, "helper", "supervisor.py"),
             "uninstall", "--tree", out],
            env=dict(env, PYTHONDONTWRITEBYTECODE="1"),
            capture_output=True, timeout=60)
        shutil.rmtree(os.path.dirname(out), ignore_errors=True)
        shutil.rmtree(work, ignore_errors=True)


def _install(rig):
    proc = subprocess.run(["bash", os.path.join(rig["tree"], "install.sh")],
                          cwd=rig["tree"], env=rig["env"],
                          capture_output=True, text=True, timeout=1800)
    out = proc.stdout + proc.stderr
    if "INSTALL FAIL [egress]" in out:
        pytest.skip("this machine has no network egress: %s" % out[-400:])
    return proc.returncode, out


def _runtime_files_in_tree(tree):
    found = []
    for root, dirs, files in os.walk(tree):
        dirs[:] = [d for d in dirs if d != "profile"]
        for name in files:
            rel = os.path.relpath(os.path.join(root, name), tree)
            if RUNTIME_NAME.search(rel):
                found.append(rel)
    return sorted(found)


def _state_dir(rig):
    with open(os.path.join(rig["tree"], ".morrow-tree-id")) as fh:
        tree_id = fh.read().strip()
    return os.path.join(rig["home"], "trees", tree_id)


def _supervisor(rig, command):
    proc = subprocess.run(
        [sys.executable, os.path.join(rig["tree"], "helper",
                                      "supervisor.py"), command],
        env=dict(rig["env"], PYTHONDONTWRITEBYTECODE="1"),
        capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return json.loads(proc.stdout)


def test_install_without_cron_twice_and_after_an_older_release_ran(rig):
    tree = rig["tree"]

    rc, out = _install(rig)
    assert rc == 0, out[-3000:]
    assert "keepalive runs as a supervised background loop" in out
    assert "Install complete." in out
    assert os.path.isfile(os.path.join(tree, ".morrow-tree-id")), \
        "a fresh install mints the stable tree id"
    state = _state_dir(rig)
    assert _supervisor(rig, "status")["running"] is True
    assert os.path.isfile(os.path.join(state, "keepalive-supervisor.json"))
    assert os.path.isfile(os.path.join(state, "keepalive-supervisor.log"))
    assert _runtime_files_in_tree(tree) == []

    # Keepalive writes its log and the helper's log to the state dir.
    probe = subprocess.run(
        ["bash", "-c", 'KEEPALIVE_SOURCE_ONLY=1 . "$1/helper/keepalive.sh"'
         ' && printf "%s\\n%s\\n" "${KEEPALIVE_LOG}" "${SERVER_LOG}"',
         "probe", tree],
        env=rig["env"], capture_output=True, text=True, timeout=60)
    assert probe.stdout.split() == [
        os.path.join(state, "keepalive.log"),
        os.path.join(state, "server.log")], probe.stdout + probe.stderr

    # Rerun, as after the helper ran under an older release: its logs,
    # a rotated archive, and the loop's log sit in helper/. The rerun
    # moves them to the state dir before any gate reads the tree, and
    # keeps the loop that already runs.
    pid = _supervisor(rig, "status")["pid"]
    legacy = {"keepalive.log": "ka\n", "keepalive.log.1": "ka-old\n",
              "server.log": "srv\n", "server.log.2": "srv-old\n",
              "keepalive-supervisor.log": "sup\n"}
    for name, text in legacy.items():
        with open(os.path.join(tree, "helper", name), "w") as fh:
            fh.write(text)
    rc, out = _install(rig)
    assert rc == 0, out[-3000:]
    assert "Install complete." in out
    assert _runtime_files_in_tree(tree) == []
    for name, text in legacy.items():
        with open(os.path.join(state, name)) as fh:
            assert text in fh.read(), name
    assert _supervisor(rig, "status")["pid"] == pid
