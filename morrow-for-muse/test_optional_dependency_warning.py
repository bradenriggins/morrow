#!/usr/bin/env python3
"""A run without 'cryptography' says loudly that privacy tests skipped.

Failure mode pinned down (final muse audit 2026-09-22, M4): CI and the
pre-commit hook never installed the optional 'cryptography' package, so
37 learner-privacy tests skipped on every run and the summary only said
"skipped". conftest.py must end such a run with a warning that names the
missing package and the fix.
"""

import importlib.util
import os
import sys

TREE = os.path.dirname(os.path.abspath(__file__))
if TREE not in sys.path:
    sys.path.insert(0, TREE)

import conftest  # noqa: E402


def test_warning_when_cryptography_is_missing(monkeypatch):
    real = importlib.util.find_spec
    monkeypatch.setattr(
        importlib.util, "find_spec",
        lambda name, *a: None if name == "cryptography" else real(name, *a))
    text = conftest.missing_cryptography_warning()
    assert text and "cryptography" in text
    assert "requirements-optional.txt" in text
    assert "SKIPPED" in text


def test_no_warning_when_cryptography_is_installed(monkeypatch):
    monkeypatch.setattr(importlib.util, "find_spec",
                        lambda name, *a: object())
    assert conftest.missing_cryptography_warning() is None
