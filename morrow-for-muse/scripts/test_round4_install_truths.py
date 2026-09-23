#!/usr/bin/env python3
"""Install text and install suites say only what is true.

Failure modes this suite pins down (written before the fix; round-4
audit 2026-09-22):
  L4. install.sh and INSTALL.md said Python 3.10 "reached" security
      end-of-life in October 2026; on 2026-09-22 that is in the future.
  L6. transport/egress_selftest.py hard-coded a path under
      ~/workspace/audits/..., an external dependency no install has.
  F2. knowledge/troubleshooting-playbook.md said install.sh "checks
      python3 >= 3.10", but install.sh refuses 3.10, so an agent
      reading it would call a 3.10 VM fine (final sweep 2026-09-23).
"""

import os
import re
import subprocess

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(rel):
    with open(os.path.join(TREE, rel), encoding="utf-8") as fh:
        return fh.read()


def test_python_310_eol_is_stated_as_future():
    for rel in ("install.sh", "INSTALL.md"):
        text = _read(rel)
        assert "reached security end-of-life in October 2026" not in text
        assert not re.search(r"reached\s+security\s+end-of-life", text), rel
        assert re.search(r"reaches\s+security\s+end-of-life\s+in\s+"
                         r"October\s+2026", text), rel


def test_every_doc_names_the_python_floor_install_enforces():
    floor = re.search(r"sys\.version_info >= \(3, (\d+)\)",
                      _read("install.sh")).group(1)
    docs = subprocess.run(["git", "-C", TREE, "ls-files", "*.md"],
                          capture_output=True, text=True,
                          check=True).stdout.split()
    claims = []
    for rel in docs:
        if rel == "CHANGELOG.md":
            continue  # history: past floors stay as they were
        for m in re.finditer(r"python3\s*\(?\s*>=\s*3\.(\d+)"
                             r"|Python 3\.(\d+) or newer", _read(rel),
                             re.IGNORECASE):
            claims.append((rel, m.group(1) or m.group(2)))
    assert claims, "no doc states the python3 floor"
    assert [c for c in claims if c[1] != floor] == [], claims


def test_selftests_depend_on_no_external_paths():
    for rel in ("transport/egress_selftest.py", "helper/helper_selftest.py"):
        text = _read(rel)
        assert "~/workspace" not in text, rel
        assert "/audits/" not in text, rel


# Final sweep 2026-09-23 (written before the fix): INSTALL.md step 1
# unzipped and then ran `mv morrow-muse-connector morrow-canvas`. Run
# again for an upgrade, mv put the new tree INSIDE the old one. The
# upgrade section offered "a fresh directory", which leaves helper/env
# and the sign-in (helper/profile/) behind, while promising both
# survive. And the educator line told a Muse with no Morrow to say
# "Connect my Canvas account", which cannot start setup.
def _step1_unzip_block():
    text = _read("INSTALL.md")
    start = text.index("Unzip the release into the skills directory")
    block = re.search(r"```\n(.*?)```", text[start:], re.S)
    assert block, "INSTALL.md step 1 has no unzip commands"
    return block.group(1)


def _release_zip(dest, version):
    import zipfile
    with zipfile.ZipFile(dest, "w") as zf:
        zf.writestr("morrow-muse-connector/VERSION", version + "\n")
        zf.writestr("morrow-muse-connector/install.sh", "#!/bin/bash\n")
        zf.writestr("morrow-muse-connector/helper/server.py", "# helper\n")


def test_rerunning_step_1_updates_the_tree_in_place(tmp_path):
    import shutil
    if not shutil.which("unzip"):
        import pytest
        pytest.skip("unzip is not installed")
    block = _step1_unzip_block()
    version = re.search(r"morrow-muse-connector-([0-9.]+)\.zip",
                        block).group(1)
    home = tmp_path / "home"
    downloads = tmp_path / "downloads"
    home.mkdir()
    downloads.mkdir()
    env = dict(os.environ, HOME=str(home))
    zip_path = downloads / ("morrow-muse-connector-%s.zip" % version)

    _release_zip(zip_path, "first")
    subprocess.run(["bash", "-c", block], cwd=downloads, env=env,
                   check=True, capture_output=True, text=True)
    tree = home / "workspace" / "skills" / "morrow-canvas"
    (tree / "helper" / "env").write_text("CANVAS_BASE=https://x.edu\n")
    (tree / "helper" / "profile").mkdir()
    (tree / "helper" / "profile" / "Cookies").write_text("session")

    _release_zip(zip_path, "second")
    proc = subprocess.run(["bash", "-c", block], cwd=downloads, env=env,
                          capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    assert not (tree / "morrow-muse-connector").exists()
    assert not (home / "workspace" / "skills"
                / "morrow-muse-connector").exists()
    assert (tree / "VERSION").read_text() == "second\n"
    assert (tree / "helper" / "env").read_text() == \
        "CANVAS_BASE=https://x.edu\n"
    assert (tree / "helper" / "profile" / "Cookies").exists()


def test_the_upgrade_section_names_working_commands():
    text = _read("INSTALL.md")
    section = text[text.index("## Upgrading"):]
    section = " ".join(section[:section.index("\n## ", 3)].split())
    assert "or into a fresh directory" not in section
    assert "step 1" in section
    assert "bash install.sh" in section


def test_an_educator_without_morrow_is_sent_to_the_setup_page():
    for rel in ("INSTALL.md", "content/setup-guide.md"):
        head = " ".join(_read(rel).split())[:2500]
        assert "https://meetmorrow.app/morrow-for-muse" in head, rel
