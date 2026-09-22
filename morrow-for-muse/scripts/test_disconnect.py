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

The real crontab is never touched: a fake `crontab` on PATH stores the
table in a scratch file, and a fake `ss` reports no listeners. Scratch
lives under .selftest-work/ (never /tmp).
"""

import os
import shutil
import stat
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
MORROW = os.path.join(TREE, "bin", "morrow")

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
    home = os.path.join(root, "home")
    morrow_home = os.path.join(home, ".morrow")
    profile = os.path.join(root, "profile")
    fakebin = os.path.join(root, "bin")
    for d in (morrow_home, profile, fakebin,
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
    keepalive = os.path.join(TREE, "helper", "keepalive.sh")
    with open(cron, "w") as fh:
        fh.write("0 3 * * * /usr/bin/backup-my-files\n")
        fh.write("# morrow-muse-connector-keepalive\n")
        fh.write("*/5 * * * * bash %s >/dev/null 2>&1\n" % keepalive)
    env = dict(os.environ)
    env.update({"HOME": home, "MORROW_HOME": morrow_home,
                "LOGIN_HELPER_PROFILE_DIR": profile,
                "FAKE_CRONTAB_FILE": cron,
                "PATH": fakebin + os.pathsep + env.get("PATH", "")})
    env.pop("MORROW_SOURCE_VAULT_PATH", None)
    try:
        yield {"root": root, "env": env, "profile": profile, "cron": cron,
               "files": files, "keepalive": keepalive}
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _run(rig, *args):
    return subprocess.run([sys.executable, MORROW, "disconnect"] + list(args),
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
    assert os.path.isdir(os.path.join(TREE, "helper"))
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
    proc = subprocess.run([sys.executable, MORROW, "--help"],
                          capture_output=True, text=True, timeout=30)
    assert "disconnect" in proc.stdout
