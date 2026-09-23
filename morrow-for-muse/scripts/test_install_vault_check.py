#!/usr/bin/env python3
"""install.sh says when student-data work cannot run.

Failure mode this suite pins down (written before the fix; final sweep
2026-09-22): working by name, the failed-students question, and every
student-data read need the encrypted learner vault, which needs the
'cryptography' package. INSTALL.md said the tree needs nothing from
pip and that without the package "all other privacy features work
normally", and install.sh never checked. An install on a VM without
the package passed with no warning, and the educator's first question
about a student was refused.

install.sh now runs the vault's own check (privacy.core.
learner_vault_problem) in step 1 and prints a warning that names what
will not work and the hash-pinned install command. The closing summary
repeats it (scripts/test_install_without_cron.py checks that on Linux).

End to end: the real install.sh from a carved tree. python3 on PATH is
this interpreter, with 'cryptography' hidden for the missing case.
CHROMIUM_BIN names a missing file, so the install stops at step 3,
after the check, and rolls back. Scratch lives under .selftest-work/
and dist/ (never /tmp).
"""

import importlib.util
import os
import shutil
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
sys.path.insert(0, HERE)
if TREE not in sys.path:
    sys.path.insert(0, TREE)

import carve  # noqa: E402
from privacy import core  # noqa: E402

WARNING = "student data"
INSTALL_CMD = ("python3 -m pip install --require-hashes -r "
               "requirements-optional.txt")


def _bin(bindir, hide_cryptography):
    """PATH for the installer: every tool on PATH, python3 wrapped so the
    missing case hides 'cryptography', and stubs for the two Linux tools
    a macOS machine lacks (steps 1 to 3 only look them up)."""
    os.makedirs(bindir)
    lines = ["#!/bin/sh"]
    if hide_cryptography:
        block = os.path.join(os.path.dirname(bindir), "block")
        os.makedirs(block)
        with open(os.path.join(block, "cryptography.py"), "w") as fh:
            fh.write('raise ImportError("hidden by the install test")\n')
        lines.append('export PYTHONPATH="%s${PYTHONPATH:+:$PYTHONPATH}"'
                     % block)
    lines.append('exec "%s" "$@"' % sys.executable)
    for name in ("python3", "python"):
        path = os.path.join(bindir, name)
        with open(path, "w") as fh:
            fh.write("\n".join(lines) + "\n")
        os.chmod(path, 0o755)
    for d in os.environ.get("PATH", "").split(os.pathsep):
        if not os.path.isdir(d):
            continue
        for name in os.listdir(d):
            dest, src = os.path.join(bindir, name), os.path.join(d, name)
            if os.path.lexists(dest) or os.path.isdir(src) \
                    or not os.access(src, os.X_OK):
                continue
            os.symlink(src, dest)
    for tool in ("ss", "flock"):
        if not os.path.lexists(os.path.join(bindir, tool)):
            with open(os.path.join(bindir, tool), "w") as fh:
                fh.write("#!/bin/sh\nexit 0\n")
            os.chmod(os.path.join(bindir, tool), 0o755)


@pytest.fixture(scope="module")
def carved():
    out = os.path.join(os.path.dirname(TREE), "dist",
                       "vault-check-%d" % os.getpid(), carve.DIST_NAME)
    carve.carve(out, run_gate=False)
    try:
        yield out
    finally:
        shutil.rmtree(os.path.dirname(out), ignore_errors=True)


def _install(carved, name, hide_cryptography):
    work = os.path.join(TREE, ".selftest-work", "vault-check-%d-%s"
                        % (os.getpid(), name))
    shutil.rmtree(work, ignore_errors=True)
    bindir = os.path.join(work, "bin")
    _bin(bindir, hide_cryptography)
    home = os.path.join(work, "home")
    os.makedirs(home)
    env = {"PATH": bindir, "HOME": home, "LANG": "C.UTF-8",
           "MORROW_HOME": os.path.join(home, ".morrow"),
           "CHROMIUM_BIN": os.path.join(work, "no-chromium-here")}
    try:
        proc = subprocess.run(["bash", os.path.join(carved, "install.sh")],
                              cwd=carved, env=env, capture_output=True,
                              text=True, timeout=600)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    out = proc.stdout + proc.stderr
    assert "INSTALL FAIL [chromium]" in out, out[-3000:]
    return out.split("--- 3/10", 1)[0]


def test_install_warns_when_cryptography_is_missing(carved):
    head = _install(carved, "missing", hide_cryptography=True)
    assert WARNING in head, head
    assert "cryptography" in head
    assert INSTALL_CMD in head
    for feature in ("by name", "failed", "grades",
                    "names in course pages are hidden"):
        assert feature in head, (feature, head)


def _vault_ready():
    check = getattr(core, "learner_vault_problem", None)
    return check is not None and check() is None


@pytest.mark.skipif(not _vault_ready(),
                    reason="this interpreter has no usable cryptography")
def test_install_is_quiet_when_cryptography_is_ready(carved):
    head = _install(carved, "ready", hide_cryptography=False)
    assert WARNING not in head, head
    assert "ok: learner vault ready" in head, head


def test_the_check_is_the_vaults_own(monkeypatch):
    if importlib.util.find_spec("cryptography") is not None \
            and core.AESGCM is not None:
        monkeypatch.setattr(core.cryptography, "__version__", "48.0.1")
        problem = core.learner_vault_problem()
        assert problem and "50.0.1" in problem, problem
        monkeypatch.undo()
    monkeypatch.setattr(core, "AESGCM", None)
    problem = core.learner_vault_problem()
    assert problem and "cryptography" in problem
    assert "requirements-optional.txt" in problem
