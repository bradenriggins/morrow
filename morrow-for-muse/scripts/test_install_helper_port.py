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
  printf '%s' "${FAKE_STATUS_BODY}"
  exit "${FAKE_STATUS_RC:-0}"
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
    _executable(str(bindir / "flock"),
                '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_FLOCK_LOG"\n'
                'exit "${FAKE_FLOCK_RC:-0}"\n')
    _executable(str(bindir / "python3"),
                '#!/bin/sh\nexec "%s" "$@"\n' % sys.executable)
    home = tmp_path / "morrow"
    home.mkdir()
    (home / "installed-version").write_text("previous-version\n")
    (home / "installed-manifest.json").write_text('{"previous":true}\n')
    (tree / "helper" / "profile").mkdir()
    (tree / "helper" / "profile" / "prior-state").write_text("keep me\n")
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
        'TREE_VERSION="0.4.6"',
    ])
    env = {k: v for k, v in os.environ.items()
           if k not in ("CANVAS_BASE", "LOGIN_HELPER_PORT")}
    env.update({"PATH": str(bindir) + os.pathsep + env.get("PATH", ""),
                "FAKE_CURL_LOG": str(tmp_path / "curl.log"),
                "FAKE_FLOCK_LOG": str(tmp_path / "flock.log")})
    return {"script": prelude + "\n" + _step10_script(), "env": env,
            "curl_log": tmp_path / "curl.log", "home": home}


def _run(world, keep_rc, status=None, status_rc=0, flock_rc=0):
    if status is None:
        status = ('{"logged_in":true,"profile_has_cookies":true,'
                  '"chromium_alive":true,"starting":false,'
                  '"helper_version":"0.4.6","profile_dir":"%s"}'
                  % (world["home"].parent / "tree" / "helper" / "profile"))
    env = dict(world["env"], FAKE_KEEP_RC=str(keep_rc),
               FAKE_STATUS_BODY=status, FAKE_STATUS_RC=str(status_rc),
               FAKE_FLOCK_RC=str(flock_rc))
    proc = subprocess.run(["bash", "-c", world["script"]], env=env,
                          capture_output=True, text=True, timeout=60)
    return proc


def test_a_healthy_helper_is_checked_on_the_pinned_port(world):
    proc = _run(world, 0)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    out = proc.stdout + proc.stderr
    assert "helper healthy" in out, out
    calls = world["curl_log"].read_text()
    assert "http://127.0.0.1:18911/status" in calls, calls
    assert "8901" not in calls, calls


def test_the_sign_in_notice_names_the_pinned_port(world):
    proc = _run(world, 2, status=(
        '{"logged_in":false,"profile_has_cookies":false,'
        '"chromium_alive":true,"starting":false,'
        '"helper_version":"0.4.6","profile_dir":"%s"}'
        % (world["home"].parent / "tree" / "helper" / "profile")))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    out = proc.stdout + proc.stderr
    assert "SIGN-IN NEEDED" in out, out
    assert "http://127.0.0.1:18911/" in out, out
    assert "8901" not in out, out


def test_lock_skip_with_verified_signed_out_helper_shows_sign_in(world):
    status = ('{"logged_in":false,"profile_has_cookies":false,'
              '"chromium_alive":true,"starting":false,'
              '"helper_version":"0.4.6","profile_dir":"%s"}'
              % (world["home"].parent / "tree" / "helper" / "profile"))
    proc = _run(world, 0, status=status)
    out = proc.stdout + proc.stderr
    assert proc.returncode == 0, out
    assert "SIGN-IN NEEDED" in out, out
    assert "helper healthy:" not in out, out
    assert not (world["home"] / "onboarded").exists()
    assert "keepalive.lock" in (world["home"].parent / "flock.log").read_text()


def test_install_refuses_lock_wait_timeout_even_with_status(world):
    proc = _run(world, 0, flock_rc=1)
    out = proc.stdout + proc.stderr
    assert proc.returncode != 0, out
    assert "FAIL helper" in out, out
    assert "helper healthy:" not in out, out


@pytest.mark.parametrize("status,status_rc", [
    ("", 7),  # keepalive skipped a held lock; no server listens yet
    ("", 0),  # a successful HTTP response with no status body
    ("not-json", 0),
    ("{}", 0),
    ('{"logged_in":true}', 0),
])
def test_install_refuses_lock_skip_without_verified_helper(
        world, status, status_rc):
    (world["home"] / "onboarded").write_text("previous session\n")
    before = {p: p.read_bytes() for p in (
        world["home"] / "installed-version",
        world["home"] / "installed-manifest.json",
        world["home"] / "onboarded",
        world["home"].parent / "tree" / "helper" / "profile" /
        "prior-state")}
    proc = _run(world, 0, status=status, status_rc=status_rc)
    out = proc.stdout + proc.stderr
    assert proc.returncode != 0, out
    assert "FAIL helper" in out, out
    assert "helper healthy" not in out, out
    assert "Install complete." not in out, out
    assert {p: p.read_bytes() for p in before} == before


@pytest.mark.parametrize("change", [
    ('"helper_version":"0.4.6"', '"helper_version":"0.3.0"'),
    ('"chromium_alive":true', '"chromium_alive":false'),
    ('"starting":false', '"starting":true'),
    ('"profile_has_cookies":true', '"profile_has_cookies":false'),
])
def test_install_refuses_status_that_disagrees_with_healthy_keepalive(
        world, change):
    good = _run(world, 0).stdout
    assert "helper healthy" in good
    status = ('{"logged_in":true,"profile_has_cookies":true,'
              '"chromium_alive":true,"starting":false,'
              '"helper_version":"0.4.6","profile_dir":"%s"}'
              % (world["home"].parent / "tree" / "helper" / "profile"))
    proc = _run(world, 0, status=status.replace(*change))
    assert proc.returncode != 0, proc.stdout + proc.stderr
    assert "FAIL helper" in proc.stdout + proc.stderr


def test_install_refuses_status_from_another_profile(world):
    status = ('{"logged_in":true,"profile_has_cookies":true,'
              '"chromium_alive":true,"starting":false,'
              '"helper_version":"0.4.6","profile_dir":"/other/profile"}')
    proc = _run(world, 0, status=status)
    assert proc.returncode != 0, proc.stdout + proc.stderr
    assert "FAIL helper" in proc.stdout + proc.stderr


def test_tls_helper_status_uses_https_and_pinned_cert(world):
    cert = world["home"].parent / "school-cert.pem"
    key = world["home"].parent / "school-key.pem"
    cert.write_text("test certificate\n")
    key.write_text("test key\n")
    with (world["home"].parent / "tree" / "helper" / "env").open("a") as fh:
        fh.write("LOGIN_HELPER_TLS_CERT=%s\n" % cert)
        fh.write("LOGIN_HELPER_TLS_KEY=%s\n" % key)
    proc = _run(world, 0)
    out = proc.stdout + proc.stderr
    assert proc.returncode == 0, out
    calls = world["curl_log"].read_text()
    assert "https://127.0.0.1:18911/status" in calls, calls
    assert "--cacert %s" % cert in calls, calls
    assert " -k " not in calls, calls


def test_tls_helper_status_allows_explicit_insecure_opt_in(world):
    cert = world["home"].parent / "school-cert.pem"
    key = world["home"].parent / "school-key.pem"
    cert.write_text("test certificate\n")
    key.write_text("test key\n")
    with (world["home"].parent / "tree" / "helper" / "env").open("a") as fh:
        fh.write("LOGIN_HELPER_TLS_CERT=%s\n" % cert)
        fh.write("LOGIN_HELPER_TLS_KEY=%s\n" % key)
        fh.write("LOGIN_HELPER_TLS_INSECURE=1\n")
    proc = _run(world, 0)
    out = proc.stdout + proc.stderr
    assert proc.returncode == 0, out
    calls = world["curl_log"].read_text()
    assert "https://127.0.0.1:18911/status" in calls, calls
    assert " -k " in calls, calls
    assert "--cacert" not in calls, calls


@pytest.mark.parametrize("missing", ["cert", "key"])
def test_tls_helper_status_refuses_missing_material(world, missing):
    cert = world["home"].parent / "school-cert.pem"
    key = world["home"].parent / "school-key.pem"
    cert.write_text("test certificate\n")
    key.write_text("test key\n")
    (cert if missing == "cert" else key).unlink()
    with (world["home"].parent / "tree" / "helper" / "env").open("a") as fh:
        fh.write("LOGIN_HELPER_TLS_CERT=%s\n" % cert)
        fh.write("LOGIN_HELPER_TLS_KEY=%s\n" % key)
    proc = _run(world, 0)
    out = proc.stdout + proc.stderr
    assert proc.returncode != 0, out
    assert "FAIL helper" in out, out
    assert "helper healthy:" not in out, out
    assert not world["curl_log"].exists()


def test_lock_wait_covers_supervisor_tick_budget(world):
    proc = _run(world, 0)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    wait = (world["home"].parent / "flock.log").read_text()
    assert "-w 610" in wait, wait
