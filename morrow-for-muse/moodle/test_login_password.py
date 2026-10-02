#!/usr/bin/env python3
"""--password refuses any real credential on argv.

Failure mode pinned down (written before the fix): resolve_password
accepted an argv password with a warning only, placing real
credentials in the process table and shell history, against the
function's own contract that a REAL credential must never travel on
argv. Only exactly the published sandbox demo password, for the
sandbox host, is accepted on argv; anything else is refused loudly.
"""

import sys
from pathlib import Path
from unittest import mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from moodle.login import (resolve_password, SANDBOX_BASE,
                          SANDBOX_DEMO_PASSWORD)


def test_demo_password_on_argv_for_sandbox_is_accepted():
    assert resolve_password(SANDBOX_DEMO_PASSWORD, SANDBOX_BASE) == \
        SANDBOX_DEMO_PASSWORD
    assert resolve_password(SANDBOX_DEMO_PASSWORD,
                            SANDBOX_BASE + "/") == SANDBOX_DEMO_PASSWORD


def test_real_password_on_argv_is_refused():
    with pytest.raises(RuntimeError, match="refusing --password"):
        resolve_password("correct-horse-battery", SANDBOX_BASE)


def test_demo_password_on_argv_for_another_host_is_refused():
    with pytest.raises(RuntimeError, match="refusing --password"):
        resolve_password(SANDBOX_DEMO_PASSWORD,
                         "https://school.example.edu")


def test_env_password_still_wins_without_argv(monkeypatch):
    monkeypatch.setenv("MOODLE_PASSWORD", "env-secret")
    assert resolve_password(None, "https://school.example.edu") == \
        "env-secret"


def test_sandbox_default_still_applies_without_argv(monkeypatch):
    monkeypatch.delenv("MOODLE_PASSWORD", raising=False)
    assert resolve_password(None, SANDBOX_BASE) == SANDBOX_DEMO_PASSWORD


def test_no_password_off_tty_explains_without_argv(monkeypatch):
    monkeypatch.delenv("MOODLE_PASSWORD", raising=False)
    with mock.patch("moodle.login.sys.stdin.isatty", return_value=False):
        with pytest.raises(RuntimeError, match="no password"):
            resolve_password(None, "https://school.example.edu")
