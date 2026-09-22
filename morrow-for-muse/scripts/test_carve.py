#!/usr/bin/env python3
"""The carve pipeline and repository hygiene it depends on.

Failure modes pinned down (written before the fix):
  1. install.sh step 2 requires pack/carve-manifest.json, but nothing in
     the repo produced it, so the repo could not be installed at all.
  2. The manifest must cover every shipped file with its real sha256,
     or install.sh's integrity walk fails (or passes a tampered file).
  3. The carved tree must pass the secrets gate with no exclusions:
     no tenant hosts in code, no scratch, no session material.
  4. Dev-only surface (live drivers, proof evidence, Moodle research)
     must not ship.
  5. Test scratch (vault keys, a Cookies file) was committed under
     privacy/.selftest-work/. No scratch may be tracked, and git must
     ignore it so it cannot be committed again.

The full install proof (install.sh run from the carved tree into a
scratch HOME/MORROW_HOME, then disconnect and uninstall) runs in a
Linux container: scripts/install-e2e.sh. Scratch lives under
.selftest-work/ (never /tmp).
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import carve  # noqa: E402


def _git(*args):
    return subprocess.run(["git", "-C", TREE] + list(args),
                          capture_output=True, text=True)


def test_no_scratch_is_tracked():
    tracked = _git("ls-files").stdout.split("\n")
    bad = [p for p in tracked
           if ".selftest-work/" in p or "__pycache__/" in p
           or p.endswith((".pyc", ".pyo")) or ".test-state/" in p]
    assert not bad, "tracked scratch: %s" % bad[:10]


@pytest.mark.parametrize("path", [
    "privacy/.selftest-work/wire-purge-vault.json.key",
    "dispatch/.selftest-work/journal/ops.jsonl",
    "modes/.test-state/pid-1/modes/grants/x.json",
])
def test_scratch_is_ignored(path):
    assert _git("check-ignore", "-q", path).returncode == 0, path


@pytest.fixture(scope="module")
def carved():
    root = os.path.join(HERE, ".selftest-work", "carve-%d" % os.getpid())
    shutil.rmtree(root, ignore_errors=True)
    out = os.path.join(os.path.dirname(TREE), "dist", "carve-test-%d"
                       % os.getpid(), carve.DIST_NAME)
    try:
        # The secrets gate takes minutes over the whole tree; the gate
        # test below runs it once, and scripts/install-e2e.sh always does.
        carve.carve(out, run_gate=False)
        yield out
    finally:
        shutil.rmtree(os.path.dirname(out), ignore_errors=True)
        shutil.rmtree(root, ignore_errors=True)


def test_manifest_covers_every_shipped_file(carved):
    with open(os.path.join(carved, "pack", "carve-manifest.json")) as fh:
        man = json.load(fh)
    on_disk = set()
    for root, _dirs, files in os.walk(carved):
        for name in files:
            on_disk.add(os.path.relpath(os.path.join(root, name), carved))
    assert on_disk - set(man["files"]) == {"pack/carve-manifest.json"}
    for rel, want in man["files"].items():
        with open(os.path.join(carved, rel), "rb") as fh:
            assert hashlib.sha256(fh.read()).hexdigest() == want, rel
    with open(os.path.join(TREE, "VERSION")) as fh:
        assert man["carve_version"] == fh.read().strip()


@pytest.mark.skipif(not os.environ.get("MORROW_CARVE_GATE"),
                    reason="slow (minutes); set MORROW_CARVE_GATE=1, or run "
                           "scripts/install-e2e.sh, which always gates")
def test_carved_tree_passes_secrets_gate_without_exclusions(carved):
    proc = subprocess.run(
        ["bash", os.path.join(carved, "scripts", "verify-no-secrets.sh"),
         carved], capture_output=True, text=True,
        env=dict(os.environ, VERIFY_EXCLUDE=""))
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_dev_only_surface_does_not_ship(carved):
    for rel in ("moodle", "lanes", "qr-proof", "learners/evidence",
                "proof-battery/evidence", "dispatch/live_proof_modes.py",
                "session/capture.py", "requirements-dev.txt",
                "scripts/carve.py", "bin/keepalive-moodle.sh",
                "bin/keepalive-canvas.sh", "bin/scheduler.py", "DEPLOY.md",
                # pytest-only: the suite's HOME isolation and its check
                "conftest.py", "test_suite_isolation.py"):
        assert not os.path.exists(os.path.join(carved, rel)), rel
    for rel in ("install.sh", "proof-battery/OPERATION_CATALOG.md",
                "scripts/uninstall.sh", "dispatch/executor.py",
                "SKILL.md", "INSTALL.md"):
        assert os.path.exists(os.path.join(carved, rel)), rel


def test_every_install_suite_ships(carved):
    with open(os.path.join(TREE, "install.sh")) as fh:
        text = fh.read()
    block = text.split('SUITES="', 1)[1].split('"', 1)[0]
    for suite in block.split():
        assert os.path.isfile(os.path.join(carved, suite)), suite


def test_carve_refuses_output_inside_source():
    with pytest.raises(SystemExit):
        carve.carve(os.path.join(TREE, "dist-inside"))
    assert not os.path.exists(os.path.join(TREE, "dist-inside"))


def test_shipped_docs_name_no_missing_file_as_shipped(carved):
    # A shipped doc may mention dev-only code (moodle/, session/capture.py)
    # only while saying it is not shipped; otherwise the educator (or the
    # agent) is sent to a file the release does not contain.
    import re
    path_re = re.compile(r"(?<![\w/.-])((?:[a-z_]+/)+[a-z_.-]+\.(?:py|sh))\b")
    stale = []
    for rel in ("failures/catalog.json", "SCOPE.md", "SKILL.md",
                "INSTALL.md", "FIRST_RUN.md"):
        with open(os.path.join(carved, rel), encoding="utf-8") as fh:
            text = fh.read()
        for match in path_re.finditer(text):
            name = match.group(1)
            if name.startswith(("~/", "/")) or "<" in name:
                continue
            if os.path.exists(os.path.join(carved, name)):
                continue
            window = text[max(0, match.start() - 200):match.end() + 200]
            if "not shipped" in window or "not in the release" in window:
                continue
            stale.append("%s: %s" % (rel, name))
    assert not stale, stale


def test_no_shipped_file_invokes_a_dev_only_script(carved):
    # Nothing in the release may call a script the carve leaves out.
    missing = []
    for root, _dirs, files in os.walk(carved):
        for name in files:
            if not name.endswith((".py", ".sh")):
                continue
            path = os.path.join(root, name)
            with open(path, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
            for script in ("keepalive-moodle.sh", "keepalive-canvas.sh",
                           "bin/scheduler.py"):
                if script in text:
                    missing.append("%s -> %s"
                                   % (os.path.relpath(path, carved), script))
    assert not missing, missing


def test_env_template_promises_only_what_keepalive_honors():
    # keepalive.sh always pins the helper profile to <tree>/helper/profile,
    # so the tree env template must not offer LOGIN_HELPER_PROFILE_DIR as
    # a setting (it would be silently overridden).
    with open(os.path.join(TREE, "install.sh"), encoding="utf-8") as fh:
        text = fh.read()
    template = text.split('cat > "${TREE_ENV_FILE}" <<\'EOF\'', 1)[1]
    template = template.split("\nEOF\n", 1)[0]
    assert "LOGIN_HELPER_PROFILE_DIR=" not in template
    assert "helper/profile" in template
    with open(os.path.join(TREE, "helper", "keepalive.sh"),
              encoding="utf-8") as fh:
        keepalive = fh.read()
    assert 'export LOGIN_HELPER_PROFILE_DIR="${HELPER_DIR}/profile"' \
        in keepalive
