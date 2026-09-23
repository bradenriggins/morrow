#!/usr/bin/env python3
"""Selftests always run in a scratch home, whatever the caller's env.

Failure modes this suite pins down (written before the fix; round-4
audit 2026-09-22, probe audit-muse4/live_journal.py):
  H2a. With MORROW_HOME set, config/selftest_home.py returned early, so
       a selftest used the caller's MORROW_HOME and MORROW_TREE_STATE_DIR.
       The journal generation high-water went to the live tree state
       dir, and the live journal then failed closed as a STALE restore.
  H2b. MORROW_HOME=~/.morrow made every suite exit 2, so install.sh
       failed for an educator who exported the default path.
  H2c. install.sh ran the suites with the educator's env; it must run
       them with every live state path removed.
  Final sweep 2026-09-22: agent-side code now reads the tree's
       helper/env when the environment has no value, so a selftest in
       an installed tree must read an empty scratch env file, never
       the educator's helper/env (their tenant, ports, TLS files).

Each check runs in a fresh interpreter, exactly like an install suite.
"""

import json
import os
import subprocess
import sys

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PROBE = r"""
import json, os, sys
sys.path.insert(0, %r)
import config.selftest_home
from config import tree_config
from dispatch import executor as ex
ex.journal_append({"wal": "audit", "event": "selftest.probe",
                   "op_id": "00000000-0000-4000-8000-000000000001"})
print(json.dumps({k: os.environ.get(k) for k in (
    "HOME", "MORROW_HOME", "MORROW_TREE_STATE_DIR",
    "MORROW_SOURCE_VAULT_PATH", "MORROW_APPROVAL_SIGNING_KEY",
    "MORROW_USER_ID", "MORROW_CONVERSATION_ID",
    "MORROW_HELPER_ENV_FILE", "LOGIN_HELPER_PROFILE_DIR")}
    | {"TREE_STATE_DIR": ex.TREE_STATE_DIR,
       "ENV_FILE": tree_config.env_file_path()}))
""" % TREE


def _files_under(path):
    out = []
    for root, _dirs, files in os.walk(path):
        out.extend(os.path.join(root, f) for f in files)
    return sorted(out)


def _run(env_extra, tmp_path):
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("MORROW_")}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env.update(env_extra)
    r = subprocess.run([sys.executable, "-c", PROBE], env=env, cwd=TREE,
                       capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stdout + r.stderr
    return json.loads(r.stdout.strip().splitlines()[-1])


def test_live_morrow_home_and_tree_state_dir_are_never_used(tmp_path):
    live_home = tmp_path / "live" / ".morrow"
    live_tree = tmp_path / "live" / "tree-state"
    live_home.mkdir(parents=True)
    live_tree.mkdir(parents=True)
    (live_home / "keep.txt").write_text("educator state")
    before = _files_under(str(tmp_path / "live"))
    seen = _run({"HOME": str(tmp_path / "live"),
                 "MORROW_HOME": str(live_home),
                 "MORROW_TREE_STATE_DIR": str(live_tree),
                 "MORROW_SOURCE_VAULT_PATH": str(live_home / "vault.json"),
                 "MORROW_APPROVAL_SIGNING_KEY": "00" * 32,
                 "MORROW_USER_ID": "muse:real@school.edu",
                 "MORROW_CONVERSATION_ID": "real-conv",
                 "MORROW_HELPER_ENV_FILE": str(live_home / "env"),
                 "LOGIN_HELPER_PROFILE_DIR": str(live_home / "profile")},
                tmp_path)
    assert seen["MORROW_HOME"] != str(live_home)
    assert not seen["MORROW_HOME"].startswith(str(tmp_path / "live"))
    assert not seen["TREE_STATE_DIR"].startswith(str(tmp_path / "live"))
    for key in ("MORROW_TREE_STATE_DIR", "MORROW_SOURCE_VAULT_PATH",
                "MORROW_APPROVAL_SIGNING_KEY", "MORROW_USER_ID",
                "MORROW_CONVERSATION_ID", "LOGIN_HELPER_PROFILE_DIR"):
        assert seen[key] is None, key
    assert seen["MORROW_HELPER_ENV_FILE"] == seen["ENV_FILE"]
    assert seen["ENV_FILE"].startswith(seen["MORROW_HOME"] + os.sep)
    assert _files_under(str(tmp_path / "live")) == before


def test_the_tree_helper_env_never_reaches_a_selftest(tmp_path):
    seen = _run({}, tmp_path)
    assert seen["ENV_FILE"] != os.path.join(TREE, "helper", "env")
    assert seen["ENV_FILE"].startswith(seen["MORROW_HOME"] + os.sep)


def test_real_default_morrow_home_does_not_refuse(tmp_path):
    import pwd
    real = os.path.join(pwd.getpwuid(os.getuid()).pw_dir, ".morrow")
    seen = _run({"MORROW_HOME": real}, tmp_path)
    assert os.path.realpath(seen["MORROW_HOME"]) != os.path.realpath(real)


def test_a_scratch_home_made_by_a_parent_selftest_is_reused(tmp_path):
    """Child processes of a selftest share its scratch home (the parent
    marks it); that is the only MORROW_HOME a selftest adopts."""
    scratch = tmp_path / "scratch" / ".morrow"
    seen = _run({"HOME": str(tmp_path / "scratch"),
                 "MORROW_HOME": str(scratch),
                 "MORROW_SELFTEST_HOME": str(scratch)}, tmp_path)
    assert seen["MORROW_HOME"] == str(scratch)


def test_install_runs_suites_with_live_state_removed():
    with open(os.path.join(TREE, "install.sh"), encoding="utf-8") as fh:
        text = fh.read()
    decl = text[text.index("SELFTEST_UNSET=\""):]
    decl = decl[:decl.index("\"\n", len("SELFTEST_UNSET=\""))]
    for var in ("MORROW_HOME", "MORROW_TREE_STATE_DIR",
                "MORROW_SOURCE_VAULT_PATH", "MORROW_APPROVAL_SIGNING_KEY",
                "MORROW_USER_ID", "MORROW_CONVERSATION_ID",
                "MORROW_HELPER_ENV_FILE", "LOGIN_HELPER_PROFILE_DIR"):
        assert var in decl, var
    loop = text[text.index("for suite in ${SUITES}; do"):]
    loop = loop[:loop.index("\ndone")]
    assert "selftest_env" in loop
