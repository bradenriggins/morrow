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
    assert "step 1" in section.lower()
    assert "bash install.sh" in section


def test_an_educator_without_morrow_is_sent_to_the_setup_page():
    for rel in ("INSTALL.md", "content/setup-guide.md"):
        head = " ".join(_read(rel).split())[:2500]
        assert "https://meetmorrow.app/morrow-for-muse" in head, rel


# Final sweep 2026-09-23 (written before the fix): SKILL.md's first run
# started the helper with `bash helper/keepalive.sh` once CANVAS_BASE was
# set, INSTALL.md step 4 did the same, FIRST_RUN.md's "Connect Canvas"
# named no command, and the setup-tenant-not-configured failure mode said
# "record it in the helper env, start the helper". Only install.sh probes
# the address (placeholder, unreachable, Canvas error page) before it
# starts the helper, so a mistyped address reached the educator as a
# sign-in page that could not load.
def _section(rel, heading):
    text = _read(rel)
    start = text.index(heading)
    end = text.find("\n## ", start + len(heading))
    return " ".join(text[start:end if end != -1 else None].split())


def test_install_probes_the_address_before_it_starts_the_helper():
    text = _read("install.sh")
    probe = text.index('fail "tenant" "CANVAS_BASE=${CANVAS_BASE} is unreachable')
    start = text.index('"${TREE}/helper/keepalive.sh" >/dev/null 2>&1')
    assert probe < start


def test_every_first_start_of_the_helper_runs_install():
    first_run = _section("SKILL.md", "## First run: sign the educator in")
    assert "bash install.sh" in first_run
    assert "bash helper/keepalive.sh" not in first_run
    connect = _section("FIRST_RUN.md", "## 2. Connect Canvas")
    assert "helper/env" in connect and "bash install.sh" in connect
    step4 = _section("INSTALL.md", "## Step 4: confirm the login helper")
    assert "bash install.sh" in step4
    assert "bash helper/keepalive.sh" not in step4
    import json
    with open(os.path.join(TREE, "failures", "catalog.json"),
              encoding="utf-8") as fh:
        modes = {e["id"]: e for e in json.load(fh)["entries"]}
    assert "bash install.sh" in \
        modes["setup-tenant-not-configured"]["auto_action"]


# Final sweep 2026-09-23 (written before the fix): the troubleshooting
# playbook told the agent that after a restart "the keepalive cron
# self-heals the helper" (the Muse VM has no cron: a background loop
# runs keepalive, and `bin/morrow start` restarts it after a reboot),
# that the sign-in notice prints "once ever" (it repeats on every
# install until sign-in), to "create ~/.morrow/write_halt" on a dead
# session (the executor imposes the halt; a hand-made one reads as a
# manual pause the educator did not ask for), and gave a placeholder
# executor command.
def test_the_playbook_matches_supervision_notice_and_halt():
    text = " ".join(_read("knowledge/troubleshooting-playbook.md").split())
    assert "cron (every 5 minutes) self-heals" not in text
    assert "runs every 5 minutes from cron" not in text
    assert "background loop" in text and "bin/morrow start" in text
    assert not re.search(r"(?<!not shown )once ever", text)
    assert "sign-in notice on every run until" in text
    assert not re.search(r"create `?~/\.morrow/write_halt", text)
    assert "imposes the write halt" in text
    assert "<a live-proven read row>" not in text
    assert "--name users_self --method GET --path /api/v1/users/self" in text


# Final sweep 2026-09-23 (written before the fix): install.sh's own header
# recommended upgrading into a new directory ("New directory
# (recommended)") and said 2 upgrade backups are kept, while INSTALL.md
# says a fresh directory loses helper/env and the sign-in, and the code
# keeps 3. Its step-10 message told the operator to "wait for the next
# keepalive run" when CANVAS_BASE was unset, but keepalive skips the
# address check, and INSTALL.md and SKILL.md say never to start the
# helper for the first time that way.
def _install_header():
    text = _read("install.sh")
    return " ".join(text[:text.index("\nset -u")].split())


def test_the_install_header_upgrades_in_place_only():
    header = _install_header()
    assert "New directory" not in header
    assert "somewhere new" not in header
    assert "Do not unzip into a fresh directory" in header
    assert "helper/env" in header and "helper/profile" in header


def test_the_install_header_states_the_backups_the_code_keeps():
    keep = int(re.search(r"^\s*_keep_n=(\d+);", _read("install.sh"),
                         re.M).group(1))
    header = _install_header()
    assert re.findall(r"the (\d+) most recent are kept", header) == \
        [str(keep)]
    upgrading = " ".join(_read("INSTALL.md").split())
    assert "Only the %d most recent backups are kept" % keep in upgrading


def test_install_never_offers_keepalive_as_the_first_start():
    text = _read("install.sh")
    assert "keepalive run)" not in text
    assert not re.search(r"wait for the next\s+keepalive", text)
    unset = text[text.index('note "CANVAS_BASE is not set yet'):]
    unset = unset[:unset.index("\nelse\n")]
    assert "rerun this installer" in unset
    assert "keepalive" not in unset
