#!/usr/bin/env python3
"""INSTALL.md's steps work as written, the first time and on an upgrade.

Failure modes this suite pins down (written before the fix; final sweep
2026-09-23, known-2):
  1. Step 1 unzipped the release into ~/workspace/skills/ and ran
     `mv .../morrow-muse-connector .../morrow-canvas`. Run again for an
     upgrade, `mv` moved the new release INSIDE the installed tree
     (morrow-canvas/morrow-muse-connector/), so nothing was upgraded and
     install step 2 then refused the tree's unexpected files. The
     Upgrading section said only "unzip the new release over the tree",
     which the release's top folder does not do.
  2. The numbered steps never installed the `cryptography` package that
     student data needs; the only command sat in the prerequisites,
     before the tree that holds requirements-optional.txt exists.
  3. Step 4 told the operator to start `bash helper/keepalive.sh` by
     hand when the installer skipped the helper, which skips the
     installer's Canvas address check (a placeholder, an address that
     does not load, a Canvas error page). SKILL.md said the same.
  4. `unzip` was missing from the prerequisites.
  5. The network prerequisite named only the Canvas tenant (muse
     round 2, 2026-09-23). Step 1 downloads from github.com, which
     redirects the download to release-assets.githubusercontent.com,
     and step 2's pip resolves on pypi.org and downloads from
     files.pythonhosted.org. A VM whose egress proxy allows only the
     named hosts failed both, and without cryptography Morrow refuses
     all student data.

The step 1 commands run for real, twice, against stand-in releases in
a scratch home under .selftest-work/.
"""

import os
import re
import shutil
import stat
import subprocess
import tempfile
import zipfile

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
DIST = "morrow-muse-connector"


def _read(rel):
    with open(os.path.join(TREE, rel), encoding="utf-8") as fh:
        return fh.read()


def _section(text, heading):
    start = text.index(heading)
    end = text.find("\n## ", start + len(heading))
    return text[start:end if end != -1 else None]


def _blocks(text):
    return re.findall(r"^```[^\n]*\n(.*?)^```", text, re.MULTILINE | re.DOTALL)


def _version():
    return _read("VERSION").strip()


def _release(path, files):
    """A stand-in release zip laid out the way scripts/carve.py lays it
    out: every file under one morrow-muse-connector/ folder."""
    with zipfile.ZipFile(path, "w") as zf:
        for rel, (content, mode) in files.items():
            info = zipfile.ZipInfo(DIST + "/" + rel)
            info.external_attr = (stat.S_IFREG | mode) << 16
            zf.writestr(info, content)


def _step1_block():
    step1 = _section(_read("INSTALL.md"), "## Step 1:")
    found = [b for b in _blocks(step1) if "unzip" in b]
    assert len(found) == 1, "Step 1 has one unzip block"
    return found[0]


@pytest.fixture
def scratch():
    work = os.path.join(TREE, ".selftest-work")
    os.makedirs(work, exist_ok=True)
    home = tempfile.mkdtemp(prefix="install-doc-", dir=work)
    try:
        yield home
    finally:
        shutil.rmtree(home, ignore_errors=True)


def _run_step1(home):
    downloads = os.path.join(home, "downloads")
    proc = subprocess.run(
        ["bash", "-e", "-c", _step1_block()], cwd=downloads,
        env=dict(os.environ, HOME=home), capture_output=True, text=True,
        timeout=60)
    assert proc.returncode == 0, proc.stdout + proc.stderr


@pytest.mark.skipif(shutil.which("unzip") is None, reason="needs unzip")
def test_step1_installs_and_upgrades_in_place(scratch):
    downloads = os.path.join(scratch, "downloads")
    os.makedirs(downloads)
    zip_path = os.path.join(downloads, "%s-%s.zip" % (DIST, _version()))
    _release(zip_path, {"VERSION": (b"old\n", 0o644),
                        "install.sh": (b"#!/bin/bash\n", 0o755),
                        "helper/keepalive.sh": (b"#!/bin/bash\n", 0o755)})
    _run_step1(scratch)
    skills = os.path.join(scratch, "workspace", "skills")
    tree = os.path.join(skills, "morrow-canvas")
    with open(os.path.join(tree, "VERSION")) as fh:
        assert fh.read() == "old\n"
    # What an installed, signed-in tree holds that no release ships.
    for rel, content in (("helper/env", "CANVAS_BASE=https://x\n"),
                         ("helper/profile/Cookies", "session"),
                         (".morrow-tree-id", "tree-1\n")):
        os.makedirs(os.path.dirname(os.path.join(tree, rel)), exist_ok=True)
        with open(os.path.join(tree, rel), "w") as fh:
            fh.write(content)
    os.remove(zip_path)
    _release(zip_path, {"VERSION": (b"new\n", 0o644),
                        "install.sh": (b"#!/bin/bash\n# new\n", 0o755),
                        "helper/keepalive.sh": (b"#!/bin/bash\n", 0o755),
                        "LICENSE": (b"MIT License\n", 0o644)})
    _run_step1(scratch)
    assert not os.path.exists(os.path.join(tree, DIST)), \
        "the upgrade nested the new release inside the installed tree"
    assert sorted(os.listdir(skills)) == ["morrow-canvas"]
    with open(os.path.join(tree, "VERSION")) as fh:
        assert fh.read() == "new\n"
    assert os.path.isfile(os.path.join(tree, "LICENSE"))
    for rel, content in (("helper/env", "CANVAS_BASE=https://x\n"),
                         ("helper/profile/Cookies", "session"),
                         (".morrow-tree-id", "tree-1\n")):
        with open(os.path.join(tree, rel)) as fh:
            assert fh.read() == content, rel
    for rel in ("install.sh", "helper/keepalive.sh"):
        assert os.access(os.path.join(tree, rel), os.X_OK), rel


def test_prerequisites_name_unzip():
    prereq = _section(_read("INSTALL.md"), "## Prerequisites")
    assert "`unzip`" in prereq


def test_prerequisites_name_every_host_install_reaches():
    prereq = _section(_read("INSTALL.md"), "## Prerequisites")
    network = " ".join(next(
        item for item in prereq.split("\n- ")
        if item.startswith("Network egress")).split())
    step1 = "\n".join(_blocks(_section(_read("INSTALL.md"), "## Step 1:")))
    step2 = "\n".join(_blocks(_section(_read("INSTALL.md"), "## Step 2:")))
    hosts = set(re.findall(r"curl [^\n]*https://([^/\s]+)/", step1))
    changelog = _read("CHANGELOG.md")
    unpublished = re.search(r"^## %s \(unreleased\)$" % re.escape(_version()),
                            changelog, re.MULTILINE)
    if unpublished:
        assert hosts == set(), hosts
        assert "source repository" in _section(_read("INSTALL.md"), "## Step 1:").lower()
        assert "`github.com`" not in network
        assert "`release-assets.githubusercontent.com`" not in network
    else:
        assert hosts == {"github.com"}, hosts
        # GitHub release downloads redirect to this host.
        hosts.add("release-assets.githubusercontent.com")
    assert "pip install" in step2
    hosts |= {"pypi.org", "files.pythonhosted.org"}
    assert "Canvas tenant" in network
    assert [h for h in sorted(hosts) if "`%s`" % h not in network] == []


def test_the_steps_install_the_student_data_package_before_install_sh():
    step2 = _section(_read("INSTALL.md"), "## Step 2:")
    commands = "\n".join(_blocks(step2))
    pip = commands.find("-r requirements-optional.txt")
    assert pip != -1, "step 2 does not install cryptography"
    assert pip < commands.find("bash install.sh")


def test_a_skipped_helper_launch_reruns_the_installer():
    for rel, heading in (("INSTALL.md", "## Step 4:"),
                         ("SKILL.md", "## First run:")):
        section = _section(_read(rel), heading)
        assert "bash install.sh" in section, rel
        # Starting keepalive.sh by hand skips the installer's address
        # checks; it is never the way to start a helper setup skipped.
        assert "bash helper/keepalive.sh" not in section, rel


def test_upgrading_uses_the_step1_commands():
    upgrading = _section(_read("INSTALL.md"), "## Upgrading")
    assert "Unzip the new release over the tree" not in upgrading
    assert "Step 1" in upgrading
    install = _read("INSTALL.md")
    assert "nothing needs pip" not in install
    assert "stdlib-only" not in install
