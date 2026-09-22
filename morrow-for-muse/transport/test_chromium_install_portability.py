#!/usr/bin/env python3
"""Chromium lane portability: the helper profile is the tree's own
profile for any install user, and distro Chromium builds pass the
version probe."""

import os
import stat
import sys

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (TREE, os.path.join(TREE, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import local_chromium as lc  # noqa: E402


def test_helper_profile_is_the_tree_profile(monkeypatch):
    monkeypatch.delenv("LOGIN_HELPER_PROFILE_DIR", raising=False)
    assert lc.helper_profile_dir() == lc.tree_helper_profile_dir()
    assert "/home/hatch" not in lc.helper_profile_dir()


def test_helper_profile_follows_the_helper_override(monkeypatch, tmp_path):
    monkeypatch.setenv("LOGIN_HELPER_PROFILE_DIR", str(tmp_path / "p"))
    assert lc.helper_profile_dir() == str(tmp_path / "p")


def _fake_binary(tmp_path, line):
    path = tmp_path / "chromium"
    path.write_text("#!/bin/sh\necho '%s'\n" % line)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return str(path)


@pytest.mark.parametrize("line", [
    "Chromium 153.0.8010.52 built on Debian GNU/Linux 13 (trixie)",
    "Chromium 153.0.8010.52 snap",
    "Google Chrome 153.0.8010.52 ",
    "Chromium 153.0.8010.52"])
def test_distro_version_lines_accepted(tmp_path, line):
    nums, text = lc._probe_binary_version(_fake_binary(tmp_path, line))
    assert text == "153.0.8010.52"


@pytest.mark.parametrize("line", [
    "Chromium", "Firefox 153.0.8010.52", "Chromium 153.0",
    "Chromium 153.0.8010.52.1", "not chromium 153.0.8010.52"])
def test_insane_version_lines_refused(tmp_path, line):
    with pytest.raises(RuntimeError):
        lc._probe_binary_version(_fake_binary(tmp_path, line))
