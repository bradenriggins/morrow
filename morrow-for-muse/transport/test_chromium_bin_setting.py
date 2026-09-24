#!/usr/bin/env python3
"""A VM without the platform Chromium has one fallback that works.

Failure modes this suite pins down (written before the fix; final sweep
2026-09-23):
  1. INSTALL.md told the operator to place a Chromium binary at
     transport/chromium/chrome inside the tree. Install step 2 refuses
     any file the release does not ship, so that fallback could never
     install ("INTEGRITY FAIL ... extra: transport/chromium/chrome").
  2. CHROMIUM_BIN worked only when exported in the shell. keepalive.sh
     and the helper read helper/env, but install step 3 and Morrow's
     own Canvas reads did not, so a value in helper/env reached the
     helper and nothing else, and a shell export was gone after the
     install. CHROMIUM_BIN is now a tree setting: the environment,
     then helper/env.
  3. INSTALL.md step 3 listed the search order backwards.
"""

import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(rel):
    with open(os.path.join(TREE, rel), encoding="utf-8") as fh:
        return fh.read()


def _section(text, heading):
    start = text.index(heading)
    end = text.find("\n## ", start + len(heading))
    return " ".join(text[start:end if end != -1 else None].split())


@pytest.fixture
def scratch():
    work = os.path.join(TREE, ".selftest-work")
    os.makedirs(work, exist_ok=True)
    root = tempfile.mkdtemp(prefix="chromium-bin-", dir=work)
    try:
        yield root
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _fake_chromium(root, name):
    path = os.path.join(root, name)
    with open(path, "w") as fh:
        fh.write('#!/bin/sh\necho "Chromium 152.0.7977.90"\n')
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)
    return path


def _step3(env):
    """install.sh step 3's own probe, run the way install.sh runs it."""
    text = _read("install.sh")
    code = re.search(r'CHROME_BIN="\$\(cd / && python3 -c "(.*?)"\)"',
                     text, re.S).group(1).replace("${TREE}", TREE)
    proc = subprocess.run([sys.executable, "-c", code], cwd="/", env=env,
                          capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return proc.stdout.strip().splitlines()[-1]


def _env(root, **extra):
    env = {k: v for k, v in os.environ.items() if k != "CHROMIUM_BIN"}
    env["MORROW_HELPER_ENV_FILE"] = os.path.join(root, "helper-env")
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env.update(extra)
    return env


def test_chromium_bin_in_helper_env_reaches_install_and_morrow(scratch):
    chrome = _fake_chromium(scratch, "chrome-from-env-file")
    with open(os.path.join(scratch, "helper-env"), "w") as fh:
        fh.write("CANVAS_BASE=https://myschool.instructure.com\n"
                 "CHROMIUM_BIN=%s\n" % chrome)
    assert _step3(_env(scratch)) == chrome


def test_the_environment_wins_over_helper_env(scratch):
    in_file = _fake_chromium(scratch, "chrome-from-env-file")
    exported = _fake_chromium(scratch, "chrome-exported")
    with open(os.path.join(scratch, "helper-env"), "w") as fh:
        fh.write("CHROMIUM_BIN=%s\n" % in_file)
    assert _step3(_env(scratch, CHROMIUM_BIN=exported)) == exported


def test_a_missing_chromium_names_the_working_fallback(scratch):
    open(os.path.join(scratch, "helper-env"), "w").close()
    out = _step3(_env(scratch))
    if not out.startswith("MISSING"):
        pytest.skip("this machine has a Chromium where the probe looks")
    text = _read("install.sh")
    message = re.search(r'fail "chromium" "([^"]*)"', text).group(1)
    assert "CHROMIUM_BIN" in message and "helper/env" in message, message
    assert "transport/chromium/chrome" not in message, message


def test_install_md_names_the_fallback_that_installs():
    prereq = _section(_read("INSTALL.md"), "## Prerequisites")
    assert "transport/chromium/chrome" not in prereq
    assert "CHROMIUM_BIN" in prereq and "helper/env" in prereq
    step = _read("INSTALL.md")
    step = step[step.index("3. **Chromium locate.**"):]
    step = " ".join(step[:step.index("\n4. ")].split())
    assert "CHROMIUM_BIN" in step
    assert step.index("CHROMIUM_BIN") < step.index("/opt/meta-chromium/chrome")
    assert "transport/chromium/chrome" not in step
