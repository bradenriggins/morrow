#!/usr/bin/env python3
"""Every selftest script runs: in the install suites, or here.

Failure modes pinned down (written before the fix; known-open items
known-1 and known-7, final sweep 2026-09-23):
  1. pytest collects test_*.py only, and CI runs only the install suites
     (scripts/install-suites.sh). The other selftest scripts (22 of
     them: the a11y, approval display, catalog gate, concurrency,
     injection, crypto, Chromium, browser backend, Item Bank SDK, and
     scheduler suites) were run by nothing, so a regression in the code
     they cover went unseen.
  2. transport/form_host_server_selftest.py started
     `python -m transport.form_host_server serve` daemons and, on macOS,
     could not stop them (its stop reads /proc), so they stayed alive
     for hours after a run. A selftest stops every process it starts.

Each script runs the way scripts/install-suites.sh runs an install
suite: from the tree root, in a fresh scratch HOME under .selftest-work/,
with every variable that names live state removed.
"""

import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

import pytest

TREE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(TREE, "scripts"))

import carve  # noqa: E402

SELFTEST = re.compile(r"(^|/)([^/]*_selftest\.(py|sh)|selftest(_[^/]*)?\.py)$")
# Named like a selftest, but the scratch-HOME module the suites import.
NOT_A_SELFTEST = {"config/selftest_home.py"}
# Selftests an install suite runs itself.
RUN_BY_AN_INSTALL_SUITE = {
    "helper/keepalive_selftest.sh": "helper/helper_selftest.py"}


def _tracked_selftests():
    out = subprocess.run(["git", "-C", TREE, "ls-files", "-z", "--", "."],
                         capture_output=True, check=True).stdout
    return sorted(rel for rel in (raw.decode() for raw in out.split(b"\0"))
                  if SELFTEST.search(rel) and rel not in NOT_A_SELFTEST)


def _run_here():
    covered = set(carve.install_suites()) | set(RUN_BY_AN_INSTALL_SUITE)
    return [rel for rel in _tracked_selftests() if rel not in covered]


def _live_state_variables():
    """The variables scripts/install-suites.sh removes before a suite."""
    with open(os.path.join(TREE, "scripts", "install-suites.sh"),
              encoding="utf-8") as fh:
        text = fh.read()
    return text.split('SELFTEST_UNSET="', 1)[1].split('"', 1)[0].split()


def test_every_selftest_is_run_by_the_install_suites_or_by_pytest():
    suites = set(carve.install_suites())
    assert [rel for rel in suites
            if not os.path.isfile(os.path.join(TREE, rel))] == []
    for rel, runner in RUN_BY_AN_INSTALL_SUITE.items():
        assert runner in suites, runner
        with open(os.path.join(TREE, runner), encoding="utf-8") as fh:
            assert os.path.basename(rel) in fh.read(), (runner, rel)
    assert "transport/local_chromium_selftest.py" in _run_here()
    assert "dispatch/wave3_hardening_selftest.py" in _run_here()


def _processes():
    """{pid: (ppid, pgid, command)} for every process ps lists."""
    out = subprocess.run(["ps", "-axww", "-o", "pid=,ppid=,pgid=,command="],
                         capture_output=True, text=True, check=True).stdout
    procs = {}
    for line in out.splitlines():
        parts = line.split(None, 3)
        if len(parts) == 4 and parts[0].isdigit():
            procs[int(parts[0])] = (int(parts[1]), int(parts[2]), parts[3])
    return procs


def _cwd(pid):
    if os.path.isdir("/proc/self"):
        try:
            return os.path.realpath(os.readlink("/proc/%d/cwd" % pid))
        except OSError:
            return None
    try:
        out = subprocess.run(["lsof", "-a", "-p", str(pid), "-d", "cwd",
                              "-Fn"], capture_output=True, text=True,
                             timeout=30).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for line in out.splitlines():
        if line.startswith("n"):
            return os.path.realpath(line[1:])
    return None


def _started_by(before, pgid, home):
    """Processes that did not exist before the run and belong to it: in
    its process group, naming its scratch HOME, or detached (parent 1)
    with a working directory in this tree."""
    tree = os.path.realpath(TREE)
    left = {}
    for pid, (ppid, group, command) in _processes().items():
        if before.get(pid) == command or pid == os.getpid():
            continue
        cwd = _cwd(pid) if ppid == 1 else None
        if group == pgid or home in command or (
                cwd and (cwd == tree or cwd.startswith(tree + os.sep))):
            left[pid] = command
    return left


def _stop(pids):
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for pid in pids:
            try:
                os.kill(pid, sig)
            except OSError:
                pass


@pytest.mark.parametrize("rel", _run_here())
def test_selftest_passes_and_stops_what_it_started(rel):
    work = os.path.join(TREE, ".selftest-work")
    os.makedirs(work, exist_ok=True)
    home = os.path.realpath(tempfile.mkdtemp(prefix="selftest-home-",
                                             dir=work))
    env = {k: v for k, v in os.environ.items()
           if k not in _live_state_variables()}
    env.update(HOME=home, PYTHONDONTWRITEBYTECODE="1")
    cmd = ["bash", rel] if rel.endswith(".sh") else [sys.executable, rel]
    before = {pid: row[2] for pid, row in _processes().items()}
    try:
        proc = subprocess.Popen(cmd, cwd=TREE, env=env,
                                start_new_session=True,
                                stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True)
        try:
            output, _ = proc.communicate(timeout=600)
        except subprocess.TimeoutExpired:
            _stop([proc.pid])
            output, _ = proc.communicate()
            output += "\n(did not finish in 600 seconds)"
        # A process sent a signal just before the script exited gets a
        # moment to finish exiting.
        deadline = time.monotonic() + 10
        left = _started_by(before, proc.pid, home)
        while left and time.monotonic() < deadline:
            time.sleep(0.2)
            left = _started_by(before, proc.pid, home)
        _stop(left)
    finally:
        shutil.rmtree(home, ignore_errors=True)
    problems = []
    if proc.returncode != 0:
        problems.append("exit %s:\n%s" % (proc.returncode, output[-4000:]))
    if left:
        problems.append("left processes running: %s" % left)
    assert problems == [], "%s: %s" % (rel, "\n".join(problems))
