#!/usr/bin/env python3
"""The helper selftest leaves no scratch in the tree.

Failure mode pinned down (written before the fix; final sweep
2026-09-23, item warn-profile-residue): install.sh step 9 runs
helper/helper_selftest.py, and INSTALL.md says test scratch is removed
afterwards. The public-bind warning probes made
helper/.selftest-warn-profile; the first probe's cleanup ran before the
second probe made it again, and nothing removed it after that. Every
install left the empty directory in the educator's tree, and
install.sh removes only .selftest-work.

End to end: the real selftest, run the way scripts/install-suites.sh
runs a suite (tree root, scratch HOME under .selftest-work/, live-state
variables removed).
"""

import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)


def _live_state_variables():
    with open(os.path.join(TREE, "scripts", "install-suites.sh"),
              encoding="utf-8") as fh:
        text = fh.read()
    return text.split('SELFTEST_UNSET="', 1)[1].split('"', 1)[0].split()


def _scratch_outside_work():
    found = set()
    for root, dirs, files in os.walk(TREE):
        dirs[:] = [d for d in dirs if d not in (".git", ".selftest-work")]
        for name in dirs + files:
            if name.startswith(".selftest"):
                found.add(os.path.relpath(os.path.join(root, name), TREE))
    return found


def test_helper_selftest_removes_its_scratch():
    before = _scratch_outside_work()
    work = os.path.join(TREE, ".selftest-work")
    os.makedirs(work, exist_ok=True)
    home = tempfile.mkdtemp(prefix="helper-scratch-", dir=work)
    env = dict(os.environ, HOME=home, PYTHONDONTWRITEBYTECODE="1")
    for name in _live_state_variables():
        env.pop(name, None)
    try:
        proc = subprocess.run(
            [sys.executable, os.path.join("helper", "helper_selftest.py")],
            cwd=TREE, env=env, capture_output=True, text=True, timeout=600)
    finally:
        shutil.rmtree(home, ignore_errors=True)
    assert proc.returncode == 0, proc.stdout[-3000:] + proc.stderr[-2000:]
    assert _scratch_outside_work() - before == set()
