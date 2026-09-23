#!/usr/bin/env python3
"""`bin/morrow disconnect`: end the Canvas connection for real.

Failure modes this suite pins down (written before the fix):
  1. The docs said deleting ~/.morrow/trees/<tree> clears the helper
     profile. It does not: the profile is <tree>/helper/profile, so the
     signed-in session survived a "full disconnect".
  2. The keepalive cron entry relaunched the signed-in helper within
     5 minutes. Disconnect must remove it and verify it is gone.
  3. Disconnect must delete the session material (the helper profile,
     the pinned account, the rig session record), and nothing that is
     the educator's record: settings, the audit journal, the tree.
  4. Other crontab lines must survive untouched.
  5. Without --yes it must not delete anything.
  6. (round-4 audit L3) uninstall.sh honored LOGIN_HELPER_PROFILE_DIR,
     while keepalive always uses <tree>/helper/profile: a stray env
     var made disconnect delete an unrelated directory and leave the
     real signed-in profile behind. The profile deleted is the one
     keepalive uses, never an env-supplied path.
  7. (round-4 audit M5) with no crontab on the machine, disconnect
     must still run (supervision is the background loop, which it
     stops) instead of refusing.
  8. (final sweep 2026-09-23) a disconnect run without --yes (the
     normal agent run) printed "UNINSTALL FAIL: nothing was changed",
     so the agent told the educator that uninstalling failed for a
     disconnect that correctly waited for a yes. Every stop names the
     mode, and a missing yes reads as not confirmed. A completed
     uninstall printed "Uninstall complete" twice; it prints it once.

The real crontab is never touched: a fake `crontab` on PATH stores the
table in a scratch file, and a fake `ss` reports no listeners. The
script runs from a scratch copy of bin/, scripts/, and helper/, so the
profile it deletes is the copy's helper/profile. Scratch lives under
.selftest-work/ (never /tmp).
"""

import os
import shutil
import stat
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)


def _copy_tree(dest):
    """The parts of the tree disconnect runs from, without runtime
    state (profiles, logs, scratch)."""
    ignore = shutil.ignore_patterns("profile", "*.log", ".selftest-*",
                                    "__pycache__", "*.pid")
    for part in ("bin", "scripts", "helper", "config", "transport"):
        shutil.copytree(os.path.join(TREE, part), os.path.join(dest, part),
                        ignore=ignore)
    return dest

FAKE_CRONTAB = """#!/bin/bash
f="${FAKE_CRONTAB_FILE}"
case "$1" in
  -l) [ -f "$f" ] && cat "$f" || exit 1 ;;
  -r) rm -f "$f" ;;
  -) cat > "$f" ;;
  *) cat > "$f" ;;
esac
"""


@pytest.fixture
def rig():
    root = os.path.join(HERE, ".selftest-work", "disconnect-%d" % os.getpid())
    shutil.rmtree(root, ignore_errors=True)
    tree = _copy_tree(os.path.join(root, "tree"))
    home = os.path.join(root, "home")
    morrow_home = os.path.join(home, ".morrow")
    profile = os.path.join(tree, "helper", "profile")
    decoy = os.path.join(root, "not-the-profile")
    fakebin = os.path.join(root, "bin")
    for d in (morrow_home, profile, decoy, fakebin,
              os.path.join(morrow_home, "settings"),
              os.path.join(morrow_home, "trees", "t1", "journal")):
        os.makedirs(d, exist_ok=True)
    for name, body in (("crontab", FAKE_CRONTAB), ("ss", "#!/bin/bash\n")):
        path = os.path.join(fakebin, name)
        with open(path, "w") as fh:
            fh.write(body)
        os.chmod(path, 0o755)
    with open(os.path.join(profile, "Cookies"), "w") as fh:
        fh.write("session cookie bytes")
    with open(os.path.join(decoy, "keep.txt"), "w") as fh:
        fh.write("an unrelated directory")
    files = {
        "lane": os.path.join(morrow_home, "browser_lane.json"),
        "session": os.path.join(morrow_home, "session.json"),
        "pin_audit": os.path.join(morrow_home, "principal_pin.json"),
        "settings": os.path.join(morrow_home, "settings", "edu.json"),
        "journal": os.path.join(morrow_home, "trees", "t1", "journal",
                                "ops.jsonl"),
    }
    for path in files.values():
        with open(path, "w") as fh:
            fh.write("{}\n")
        os.chmod(path, 0o600)
    cron = os.path.join(root, "crontab.txt")
    keepalive = os.path.join(tree, "helper", "keepalive.sh")
    with open(cron, "w") as fh:
        fh.write("0 3 * * * /usr/bin/backup-my-files\n")
        fh.write("# morrow-muse-connector-keepalive\n")
        fh.write("*/5 * * * * bash %s >/dev/null 2>&1\n" % keepalive)
    env = dict(os.environ)
    env.update({"HOME": home, "MORROW_HOME": morrow_home,
                "LOGIN_HELPER_PROFILE_DIR": decoy,
                "FAKE_CRONTAB_FILE": cron,
                "PATH": fakebin + os.pathsep + env.get("PATH", "")})
    env.pop("MORROW_SOURCE_VAULT_PATH", None)
    try:
        yield {"root": root, "env": env, "profile": profile, "cron": cron,
               "files": files, "keepalive": keepalive, "decoy": decoy,
               "morrow": os.path.join(tree, "bin", "morrow"),
               "tree": tree}
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _run(rig, *args):
    return subprocess.run([sys.executable, rig["morrow"], "disconnect"]
                          + list(args),
                          env=rig["env"], capture_output=True, text=True,
                          timeout=120, stdin=subprocess.DEVNULL)


def test_disconnect_removes_session_and_keepalive(rig):
    proc = _run(rig, "--yes")
    out = proc.stdout + proc.stderr
    assert proc.returncode == 0, out
    assert not os.path.exists(rig["profile"]), out
    for key in ("lane", "session", "pin_audit"):
        assert not os.path.exists(rig["files"][key]), (key, out)
    for key in ("settings", "journal"):
        assert os.path.exists(rig["files"][key]), (key, out)
    with open(rig["cron"]) as fh:
        cron = fh.read()
    assert rig["keepalive"] not in cron
    assert "morrow-muse-connector-keepalive" not in cron
    assert "/usr/bin/backup-my-files" in cron
    assert os.path.isdir(os.path.join(rig["tree"], "helper"))
    assert os.path.exists(os.path.join(rig["decoy"], "keep.txt")), out
    assert "Disconnected" in out
    assert "install.sh" in out  # the reconnect step is named


def test_disconnect_without_yes_changes_nothing(rig):
    proc = _run(rig)
    assert proc.returncode != 0
    assert os.path.exists(os.path.join(rig["profile"], "Cookies"))
    assert os.path.exists(rig["files"]["lane"])
    with open(rig["cron"]) as fh:
        assert rig["keepalive"] in fh.read()


def test_disconnect_is_listed_in_help():
    proc = subprocess.run([sys.executable,
                           os.path.join(TREE, "bin", "morrow"), "--help"],
                          capture_output=True, text=True, timeout=30)
    assert "disconnect" in proc.stdout


def test_non_interactive_disconnect_without_yes_names_the_flag(rig):
    # The agent has no terminal: a run without --yes must say how to
    # proceed (the educator confirms in chat, then --yes), not report
    # "aborted by user" for a question nobody could answer.
    proc = _run(rig)
    out = proc.stdout + proc.stderr
    assert proc.returncode != 0
    assert "--yes" in out
    assert "aborted by user" not in out
    assert "UNINSTALL" not in out and "FAIL" not in out, out
    assert "DISCONNECT STOPPED: not confirmed" in proc.stderr, out
    assert "nothing was changed" in proc.stderr, out
    assert os.path.exists(os.path.join(rig["profile"], "Cookies"))


def _run_uninstall(rig, *args):
    return subprocess.run(["bash", os.path.join(rig["tree"], "scripts",
                                                "uninstall.sh")]
                          + list(args),
                          env=rig["env"], capture_output=True, text=True,
                          timeout=120, stdin=subprocess.DEVNULL)


def test_non_interactive_uninstall_without_yes_says_not_confirmed(rig):
    proc = _run_uninstall(rig)
    out = proc.stdout + proc.stderr
    assert proc.returncode != 0
    assert "UNINSTALL STOPPED: not confirmed" in proc.stderr, out
    assert "scripts/uninstall.sh --yes" in proc.stderr, out
    assert "FAIL" not in out, out
    assert os.path.isdir(rig["tree"])


def test_a_completed_uninstall_says_so_once(rig):
    proc = _run_uninstall(rig, "--yes")
    out = proc.stdout + proc.stderr
    assert proc.returncode == 0, out
    assert not os.path.exists(rig["tree"]), out
    assert out.count("Uninstall complete") == 1, out


# consent.md describes the disconnect in plain words and names no
# command; a doc that names the command names the --yes form.
@pytest.mark.parametrize("doc,names_command", [
    ("content/revoke.md", True), ("content/consent.md", False),
    ("SKILL.md", True)])
def test_documented_agent_path_uses_yes(doc, names_command):
    with open(os.path.join(TREE, doc), encoding="utf-8") as fh:
        text = fh.read()
    runs = [line for line in text.splitlines()
            if "bin/morrow disconnect" in line]
    assert bool(runs) == names_command, doc
    if names_command:
        assert "bin/morrow disconnect --yes" in text, doc
    assert "bin/morrow disconnect`" not in text.replace(
        "bin/morrow disconnect --yes`", ""), doc


def test_disconnect_without_crontab_still_disconnects(rig):
    nocron = os.path.join(rig["root"], "bin-nocron")
    os.makedirs(nocron, exist_ok=True)
    os.symlink(os.path.join(rig["root"], "bin", "ss"),
               os.path.join(nocron, "ss"))
    seen = {"ss"}  # the rig's stub ss is linked above; never the real one
    for d in rig["env"]["PATH"].split(os.pathsep)[1:]:
        try:
            names = os.listdir(d)
        except OSError:
            continue
        for name in names:
            if name == "crontab" or name in seen:
                continue
            src = os.path.join(d, name)
            if os.path.isfile(src) and os.access(src, os.X_OK):
                seen.add(name)
                os.symlink(src, os.path.join(nocron, name))
    rig["env"]["PATH"] = nocron
    proc = _run(rig, "--yes")
    out = proc.stdout + proc.stderr
    assert proc.returncode == 0, out
    assert not os.path.exists(rig["profile"]), out
    assert "no crontab" in out
