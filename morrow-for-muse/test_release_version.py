#!/usr/bin/env python3
"""Every statement of the current Morrow for Muse version names VERSION.

Failure mode pinned down (written before the fix; final sweep
2026-09-23): the tree carried many changes since the published 0.4.0
release but still said 0.4.0, and a release is bumped by hand in several
files. A bump that misses one leaves the agent told the wrong version
(SKILL.md), sends an educator to the old download (INSTALL.md), or
publishes a release with no notes of its own (CHANGELOG.md). Dated
records (older changelog sections, the deployment record) keep the
versions they had.
"""

import json
import os
import re

TREE = os.path.dirname(os.path.abspath(__file__))
_VER = r"\d+\.\d+\.\d+"


def _read(rel):
    with open(os.path.join(TREE, rel), encoding="utf-8") as fh:
        return fh.read()


def _version():
    return _read("VERSION").strip()


def _key(version):
    return tuple(int(part) for part in version.split("."))


def test_version_is_plain_semver():
    assert re.fullmatch(_VER, _version())


def test_pack_names_the_tree_version():
    version = _version()
    assert _read("pack/version.txt").strip() == version
    assert json.loads(_read("pack/pack.json"))["version"] == version


def test_skill_names_the_tree_version():
    stated = re.findall(r"Morrow for Muse connector, v(%s)" % _VER,
                        _read("SKILL.md"))
    assert stated == [_version()]


def test_install_guide_downloads_the_tree_version():
    version = _version()
    text = _read("INSTALL.md")
    url = ("https://github.com/bradenriggins/morrow/releases/download/"
           "muse/v%s/morrow-muse-connector-%s.zip" % (version, version))
    assert url in text
    zips = set(re.findall(r"morrow-muse-connector-(%s)\.zip" % _VER, text))
    tags = set(re.findall(r"muse/v(%s)" % _VER, text))
    assert zips == {version}
    assert tags == {version}


def test_install_selftest_stub_reports_the_tree_version():
    stated = re.findall(r'^VERSION = "(%s)"$' % _VER,
                        _read("scripts/install-robustness-selftest.sh"),
                        re.MULTILINE)
    assert stated == [_version()]


def test_changelog_opens_with_a_dated_section_for_the_tree_version():
    version = _version()
    headings = re.findall(r"^## (%s) \(\d{4}-\d\d-\d\d\)$" % _VER,
                          _read("CHANGELOG.md"), re.MULTILINE)
    assert headings, "no dated version section"
    assert headings[0] == version
    assert all(_key(older) < _key(version) for older in headings[1:])


def test_changelog_section_names_its_release_zip():
    version = _version()
    text = _read("CHANGELOG.md")
    section = text.split("## %s (" % version, 1)[1].split("\n## ", 1)[0]
    assert ("`morrow-muse-connector-%s.zip` from the `muse/v%s`"
            % (version, version)) in " ".join(section.split())
