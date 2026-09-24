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
  9. (final sweep 2026-09-23) the paths to delete were one
     space-joined string, split again on every space. With the tree at
     ~/workspace/skills/morrow canvas, disconnect deleted an unrelated
     ~/workspace/skills/morrow folder, kept the real sign-in, checked
     the same wrong paths, and reported the sign-in deleted. A
     MORROW_HOME with a space split the same way, in disconnect and in
     uninstall.
 10. (round-2 finding muse-ux-r2-disconnect-ignores-tree-port) the
     helper port came only from the environment. A tree that pins
     LOGIN_HELPER_PORT in helper/env (two trees on one machine) was
     checked on 8901, nothing was stopped, and disconnect reported "The
     helper is stopped" while the helper kept running on the pinned
     port. The port resolves as keepalive resolves it: the environment,
     then helper/env, then 8901.

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


def _make_rig(root, tree_rel, home_rel):
    shutil.rmtree(root, ignore_errors=True)
    tree = _copy_tree(os.path.join(root, tree_rel))
    home = os.path.join(root, home_rel)
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
    # Commands run from an empty folder, so a path split into a
    # relative piece can only name something inside the scratch root.
    cwd = os.path.join(root, "cwd")
    os.makedirs(cwd)
    return {"root": root, "env": env, "profile": profile, "cron": cron,
            "files": files, "keepalive": keepalive, "decoy": decoy,
            "morrow": os.path.join(tree, "bin", "morrow"),
            "tree": tree, "cwd": cwd}


@pytest.fixture
def rig():
    root = os.path.join(HERE, ".selftest-work", "disconnect-%d" % os.getpid())
    try:
        yield _make_rig(root, "tree", "home")
    finally:
        shutil.rmtree(root, ignore_errors=True)


@pytest.fixture
def spaced_rig():
    """The tree and MORROW_HOME under paths with a space, next to
    folders named like the first word of each path."""
    root = os.path.join(HERE, ".selftest-work",
                        "disconnect-spaces-%d" % os.getpid())
    try:
        rig = _make_rig(root, os.path.join("skills", "morrow canvas"),
                        "home dir")
        rig["siblings"] = []
        for rel in (os.path.join("skills", "morrow"), "home"):
            path = os.path.join(root, rel, "educator-notes.txt")
            os.makedirs(os.path.dirname(path))
            with open(path, "w") as fh:
                fh.write("not Morrow's\n")
            rig["siblings"].append(path)
        yield rig
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _run(rig, *args):
    return subprocess.run([sys.executable, rig["morrow"], "disconnect"]
                          + list(args),
                          env=rig["env"], capture_output=True, text=True,
                          timeout=120, stdin=subprocess.DEVNULL,
                          cwd=rig["cwd"])


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
                          timeout=120, stdin=subprocess.DEVNULL,
                          cwd=rig["cwd"])


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


# muse UX audit 3 (2026-09-23): nothing used to record that the educator
# disconnected, so the next Canvas command read helper-down ("your
# Canvas sign-in is not affected") and its next step relaunches the
# helper and re-arms supervision. A disconnect records the marker in the
# tree's state dir (config/disconnect.py), and a reconnecting install
# clears it.
def test_disconnect_writes_the_marker_install_clears_it(rig):
    marker = os.path.join(rig["env"]["MORROW_HOME"], "trees", "t1-tree",
                          "disconnected")
    # Same resolution config/disconnect.py runs with (the rig's MORROW_HOME
    # and the scratch tree's path-slug id).
    sys.path.insert(0, os.path.join(rig["tree"], "transport"))
    from transport import local_chromium
    rig_tree_id = local_chromium.tree_id(rig["tree"])
    marker = os.path.join(rig["env"]["MORROW_HOME"], "trees", rig_tree_id,
                          "disconnected")
    assert not os.path.exists(marker)
    proc = _run(rig, "--yes")
    out = proc.stdout + proc.stderr
    assert proc.returncode == 0, out
    assert os.path.isfile(marker), out
    # The full installer is too heavy for this suite (it runs all 23
    # selftest suites); assert the clearing step and its placement
    # directly.
    with open(os.path.join(TREE, "install.sh")) as fh:
        install = fh.read()
    assert 'disconnect marker' in install
    # Security review 2026-09-24: the marker is cleared only AFTER the
    # step-10 helper-launch branch succeeds. Clearing it earlier let a
    # later install failure (selftest, helper down) leave the marker
    # gone while the keepalive cron was already installed: the helper
    # relaunches within five minutes and silently undoes the recorded
    # disconnect.
    launch = install.index('"${TREE}/helper/keepalive.sh" >/dev/null 2>&1')
    assert install.index('rm -f "${_disconnect_marker}"') > launch, install
    # and fail() re-records the disconnect when the marker was cleared
    # this run, so a later failure (install record, rollback) restores it.
    fail_def = install[install.index("fail() {"):install.index(
        "\nstep()", install.index("fail() {"))]
    assert "_disconnect_marker_cleared" in fail_def, fail_def
    assert 'disconnect.py" mark' in fail_def, fail_def


def test_a_failed_install_after_the_marker_clear_remarks_the_disconnect():
    """Security review 2026-09-24: once install.sh has cleared the
    disconnect marker and a later step fails, fail() must re-record the
    disconnect (config/disconnect.py mark into the same state dir);
    otherwise the keepalive cron relaunches the helper within five
    minutes and silently undoes the educator's disconnect. fail() is
    run in isolation with the tree's config/ and transport/ copies, the
    state dir pointed at scratch, and everything fail() may touch
    empty, so only the re-mark path executes."""
    import re
    import tempfile
    work = os.path.join(HERE, ".selftest-work",
                        "fail-remark-%d" % os.getpid())
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    try:
        tree = os.path.join(work, "tree")
        for part in ("config", "transport"):
            shutil.copytree(os.path.join(TREE, part),
                            os.path.join(tree, part),
                            ignore=shutil.ignore_patterns(
                                "__pycache__", "*.pyc"))
        state = os.path.join(work, "state")
        os.makedirs(state)
        with open(os.path.join(TREE, "install.sh")) as fh:
            install = fh.read()
        fail_def = install[install.index("fail() {"):install.index(
            "\nstep()", install.index("fail() {"))]
        script = (
            "TREE=%s\nTREE_STATE_DIR=%s\n_CREATED=''\nUPGRADE_BACKUP=''\n"
            % (tree, state))
        marker = os.path.join(state, "disconnected")
        # With the flag set, fail() re-marks the disconnect.
        proc = subprocess.run(
            ["bash", "-c", script + fail_def
             + "\n_disconnect_marker_cleared=1\nfail test \"boom\""],
            capture_output=True, text=True, env=dict(os.environ),
            timeout=60)
        assert proc.returncode == 1, proc.stdout + proc.stderr
        assert os.path.isfile(marker), proc.stdout + proc.stderr
        with open(marker, encoding="utf-8") as fh:
            body = fh.read()
        assert "disconnected_at" in body, body
        assert "the disconnect record is restored" in \
            proc.stdout + proc.stderr, proc.stdout + proc.stderr
        # Without the flag (a failure before the clear), fail() must not
        # create a marker (a fresh state dir: the first run re-marked
        # the one above).
        state2 = os.path.join(work, "state2")
        os.makedirs(state2)
        marker2 = os.path.join(state2, "disconnected")
        script2 = (
            "TREE=%s\nTREE_STATE_DIR=%s\n_CREATED=''\nUPGRADE_BACKUP=''\n"
            % (tree, state2))
        proc = subprocess.run(
            ["bash", "-c", script2 + fail_def + "\nfail test \"no\""],
            capture_output=True, text=True, env=dict(os.environ),
            timeout=60)
        assert proc.returncode == 1, proc.stdout + proc.stderr
        assert not os.path.exists(marker2), proc.stdout + proc.stderr
    finally:
        shutil.rmtree(work, ignore_errors=True)


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


def test_disconnect_with_spaces_in_the_paths(spaced_rig):
    rig = spaced_rig
    proc = _run(rig, "--yes")
    out = proc.stdout + proc.stderr
    assert proc.returncode == 0, out
    assert not os.path.exists(rig["profile"]), out
    for key in ("lane", "session", "pin_audit"):
        assert not os.path.exists(rig["files"][key]), (key, out)
    for key in ("settings", "journal"):
        assert os.path.exists(rig["files"][key]), (key, out)
    for path in rig["siblings"]:
        assert os.path.exists(path), (path, out)
    assert os.listdir(rig["cwd"]) == [], out
    assert "deleted: %s" % rig["profile"] in out, out


def test_uninstall_with_spaces_in_the_paths(spaced_rig):
    rig = spaced_rig
    proc = _run_uninstall(rig, "--yes")
    out = proc.stdout + proc.stderr
    assert proc.returncode == 0, out
    assert not os.path.exists(rig["tree"]), out
    assert not os.path.exists(rig["env"]["MORROW_HOME"]), out
    for path in rig["siblings"]:
        assert os.path.exists(path), (path, out)
    assert os.listdir(rig["cwd"]) == [], out


# A listener on the pinned port whose PID is not this install's process:
# disconnect must look at that port and refuse, never skip it as free.
PINNED_LISTENER = """#!/bin/bash
echo 'State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process'
echo 'LISTEN 0      5      127.0.0.1:18911    0.0.0.0:*         users:(("python3",pid=99999999,fd=3))'
"""


def _pin_ports(rig, listener=None):
    for name in ("LOGIN_HELPER_PORT", "LOGIN_HELPER_CDP_PORT"):
        rig["env"].pop(name, None)
    with open(os.path.join(rig["tree"], "helper", "env"), "w") as fh:
        fh.write("LOGIN_HELPER_PORT=18911\nLOGIN_HELPER_CDP_PORT=18912\n")
    if listener is not None:
        with open(os.path.join(rig["root"], "bin", "ss"), "w") as fh:
            fh.write(listener)


def test_disconnect_checks_the_helper_port_pinned_in_helper_env(rig):
    _pin_ports(rig)
    proc = _run(rig, "--yes")
    out = proc.stdout + proc.stderr
    assert proc.returncode == 0, out
    assert "stop the helper (port 18911)" in out, out
    assert "helper: port 18911 is free; nothing to stop" in out, out
    assert "8901" not in out, out


def test_a_helper_on_the_pinned_port_is_never_reported_stopped(rig):
    _pin_ports(rig, listener=PINNED_LISTENER)
    proc = _run(rig, "--yes")
    out = proc.stdout + proc.stderr
    assert proc.returncode != 0, out
    assert "port 18911 is held by PID 99999999" in out, out
    assert "The helper is stopped" not in out, out
    assert os.path.exists(os.path.join(rig["profile"], "Cookies")), out


def test_the_environment_port_wins_over_helper_env(rig):
    _pin_ports(rig)
    rig["env"]["LOGIN_HELPER_PORT"] = "18921"
    proc = _run(rig, "--yes")
    out = proc.stdout + proc.stderr
    assert proc.returncode == 0, out
    assert "helper: port 18921 is free; nothing to stop" in out, out
