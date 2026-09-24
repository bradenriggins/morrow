#!/usr/bin/env python3
"""install.sh talks to the helper on the tree's own port.

Failure mode this suite pins down (written before the fix; round-2
finding muse-ux-r2-disconnect-ignores-tree-port, 2026-09-23): install.sh
set HELPER_PORT from the shell's LOGIN_HELPER_PORT before it read the
tree's helper/env. A tree that pins LOGIN_HELPER_PORT there (two trees
on one machine, which INSTALL.md supports) had keepalive start the
helper on the pinned port, while install.sh checked /status on 8901 and
told the educator to sign in at http://127.0.0.1:8901/.

Step 10 runs as install.sh runs it: every top-level HELPER_PORT
assignment made before step 10, then the step 10 block itself. Only
curl and keepalive are stand-ins (curl records the URLs it was given),
so no helper starts and nothing leaves the machine.
"""

import os
import re
import shutil
import stat
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)

FAKE_CURL = """#!/bin/bash
printf '%s\\n' "$*" >> "${FAKE_CURL_LOG}"
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
  esac
  shift
done
if [ -n "${out}" ]; then
  printf '<html>Canvas</html>' > "${out}"
else
  printf '{"logged_in": true, "profile_has_cookies": true}'
fi
"""


def _step10_script():
    with open(os.path.join(TREE, "install.sh"), encoding="utf-8") as fh:
        text = fh.read()
    start = text.index("# -- 10. helper launch")
    end = text.index("# Record this install:")
    before = "\n".join(re.findall(r"^HELPER_PORT=.*$", text[:start], re.M))
    return before + "\n" + text[start:end]


def _executable(path, body):
    with open(path, "w") as fh:
        fh.write(body)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)


@pytest.fixture
def world(tmp_path):
    tree = tmp_path / "tree"
    (tree / "helper").mkdir(parents=True)
    (tree / "helper" / "env").write_text(
        "CANVAS_BASE=https://school.instructure.com\n"
        "LOGIN_HELPER_PORT=18911\n")
    # The step-10 tenant gate imports the tree's shared validator
    # (config.tree_config, which pulls in config.paths), so the fake
    # tree carries the real modules.
    cfg = tree / "config"
    cfg.mkdir()
    for name in ("tree_config.py", "paths.py"):
        shutil.copy(os.path.join(TREE, "config", name),
                    str(cfg / name))
    _executable(str(tree / "helper" / "keepalive.sh"),
                '#!/bin/bash\nexit "${FAKE_KEEP_RC}"\n')
    bindir = tmp_path / "bin"
    bindir.mkdir()
    _executable(str(bindir / "curl"), FAKE_CURL)
    _executable(str(bindir / "python3"),
                '#!/bin/sh\nexec "%s" "$@"\n' % sys.executable)
    home = tmp_path / "morrow"
    home.mkdir()
    prelude = "\n".join([
        "set -u",
        'step() { :; }',
        'note() { printf "%s\\n" "$*"; }',
        'fail() { printf "FAIL %s\\n" "$*"; exit 1; }',
        '_track_created() { :; }',
        'TREE="%s"' % tree,
        'TREE_ENV_FILE="${TREE}/helper/env"',
        'ENV_FILE="${TREE_ENV_FILE}"',
        'MORROW_HOME="%s"' % home,
        'LEGACY_ENV_FILE="${MORROW_HOME}/env"',
        'ONBOARDED_SENTINEL="${MORROW_HOME}/onboarded"',
        'TREE_STATE_DIR="${MORROW_HOME}/state"',
    ])
    env = {k: v for k, v in os.environ.items()
           if k not in ("CANVAS_BASE", "LOGIN_HELPER_PORT")}
    env.update({"PATH": str(bindir) + os.pathsep + env.get("PATH", ""),
                "FAKE_CURL_LOG": str(tmp_path / "curl.log")})
    return {"script": prelude + "\n" + _step10_script(), "env": env,
            "curl_log": tmp_path / "curl.log", "home": home}


def _run(world, keep_rc):
    env = dict(world["env"], FAKE_KEEP_RC=str(keep_rc))
    proc = subprocess.run(["bash", "-c", world["script"]], env=env,
                          capture_output=True, text=True, timeout=60)
    return proc.stdout + proc.stderr


def test_a_healthy_helper_is_checked_on_the_pinned_port(world):
    out = _run(world, 0)
    assert "helper healthy" in out, out
    calls = world["curl_log"].read_text()
    assert "http://127.0.0.1:18911/status" in calls, calls
    assert "8901" not in calls, calls


def test_the_sign_in_notice_names_the_pinned_port(world):
    out = _run(world, 2)
    assert "SIGN-IN NEEDED" in out, out
    assert "http://127.0.0.1:18911/" in out, out
    assert "8901" not in out, out
