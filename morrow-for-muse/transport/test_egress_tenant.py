#!/usr/bin/env python3
"""The egress probe handshakes with the educator's Canvas host.

Failure mode pinned down (written before the fix; final sweep
2026-09-23, item probe-ignores-helper-env-tenant): INSTALL.md step 4
says the probe handshakes with "your tenant host". default_test_host
read only the shell's CANVAS_BASE, but every documented step sets it in
helper/env, so installs probed example.com. A VM that reaches
example.com directly but needs a proxy for the school's host passed
step 4 as mode=direct, a mode that does not fit the Canvas address.

The tenant resolves the way every agent-side reader resolves it
(config/tree_config): the environment, then helper/env, then the legacy
global env.
"""

import os
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
for _p in (TREE, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import egress  # noqa: E402


@pytest.fixture
def config(tmp_path, monkeypatch):
    env_file = tmp_path / "helper-env"
    monkeypatch.setenv("MORROW_HELPER_ENV_FILE", str(env_file))
    monkeypatch.setenv("MORROW_HOME", str(tmp_path / "morrow"))
    monkeypatch.delenv("CANVAS_BASE", raising=False)
    (tmp_path / "morrow").mkdir()
    return env_file, tmp_path / "morrow" / "env"


def test_the_probe_uses_the_tenant_in_helper_env(config):
    env_file, _legacy = config
    env_file.write_text("CANVAS_BASE=https://school.instructure.com/\n")
    assert egress.default_test_host() == "school.instructure.com"


def test_the_probe_uses_the_legacy_global_env(config):
    _env_file, legacy = config
    legacy.write_text("export CANVAS_BASE='https://legacy.example.edu'\n")
    assert egress.default_test_host() == "legacy.example.edu"


def test_the_environment_wins(config, monkeypatch):
    env_file, _legacy = config
    env_file.write_text("CANVAS_BASE=https://school.instructure.com\n")
    monkeypatch.setenv("CANVAS_BASE", "https://shell.example.edu")
    assert egress.default_test_host() == "shell.example.edu"


def test_no_tenant_yet_probes_example_com(config):
    env_file, _legacy = config
    env_file.write_text("# CANVAS_BASE=https://myschool.instructure.com\n")
    assert egress.default_test_host() == "example.com"


def test_install_step_4_reads_the_tree_env(tmp_path):
    """install.sh imports egress with only transport/ on sys.path and
    the working directory outside the tree; the tree's helper/env still
    names the host."""
    env_file = tmp_path / "helper-env"
    env_file.write_text("CANVAS_BASE=https://school.instructure.com\n")
    env = dict(os.environ, MORROW_HELPER_ENV_FILE=str(env_file),
               MORROW_HOME=str(tmp_path / "morrow"), HOME=str(tmp_path),
               PYTHONDONTWRITEBYTECODE="1")
    env.pop("CANVAS_BASE", None)
    code = ("import sys\n"
            "sys.path.insert(0, %r)\n"
            "import egress\n"
            "print(egress.default_test_host())\n" % HERE)
    proc = subprocess.run([sys.executable, "-c", code], cwd="/",
                          env=env, capture_output=True, text=True,
                          timeout=60)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == "school.instructure.com"
