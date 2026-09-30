#!/usr/bin/env python3
"""install.sh and CI run the install suites through one runner.

Failure modes this suite pins down (written before the runner; final
sweep 2026-09-23):
  1. CI ran only `python -m pytest`, which collects none of the
     *_selftest.py install suites, so a suite that failed every
     educator install (install.sh step 9) still passed CI. The suite
     list and how a suite runs now live in scripts/install-suites.sh,
     which install.sh step 9 and CI both run, so they cannot drift.
  2. Every suite runs from the tree root in its own fresh scratch HOME
     under the tree's .selftest-work/, with every variable that names
     live state removed, whatever the caller exported.
  3. A failed suite is named, the other suites still run, and the exit
     status is non-zero. --show-failures (CI) also prints the failed
     suite's output; without it (install.sh) the output stays quiet.
  4. (final sweep 2026-09-23) the egress suite bound fixed loopback
     ports 18093 to 18099, so any program holding one of them, or a
     second install running at the same time, failed install step 9.
  5. A dependency installed in the invoking interpreter's user site
     disappeared when each suite changed HOME. A VM with a current
     user-site cryptography package then imported an older system copy
     and failed step 9. Preserve the invoking interpreter's package
     search path while keeping each suite's HOME and live state isolated.
"""

import json
import os
import shutil
import subprocess
import sys
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
RUNNER = os.path.join(HERE, "install-suites.sh")
sys.path.insert(0, HERE)

import carve  # noqa: E402


@pytest.mark.parametrize("crypto_version", ["41.0.7", None])
def test_shipped_privacy_suites_accept_unavailable_optional_crypto(tmp_path, crypto_version):
    """Importable but unsupported crypto must not break course-only installs.

    The degraded suites must still check that learner data stays refused.
    """
    tree = tmp_path / "release"
    carve.carve(str(tree), run_gate=False)
    shim = tmp_path / "dependency-state"
    shim.mkdir()
    (shim / "sitecustomize.py").write_text(
        "import sys, types\n"
        "for name in list(sys.modules):\n"
        "    if name == 'cryptography' or name.startswith('cryptography.'):\n"
        "        del sys.modules[name]\n"
        + ("class MissingCrypto:\n"
           "    def find_spec(self, fullname, path=None, target=None):\n"
           "        if fullname == 'cryptography' or fullname.startswith('cryptography.'):\n"
           "            raise ModuleNotFoundError('cryptography is unavailable')\n"
           "sys.meta_path.insert(0, MissingCrypto())\n" if crypto_version is None else
           "crypto = types.ModuleType('cryptography')\n"
           "crypto.__version__ = %r\n"
           "sys.modules['cryptography'] = crypto\n"
           "for name in ['cryptography.hazmat', 'cryptography.hazmat.primitives',\n"
           "             'cryptography.hazmat.primitives.ciphers',\n"
           "             'cryptography.hazmat.primitives.ciphers.aead']:\n"
           "    sys.modules[name] = types.ModuleType(name)\n"
           "class UnsupportedAESGCM:\n"
           "    def __init__(self, *args):\n"
           "        raise AssertionError('unsupported crypto must not encrypt')\n"
           "sys.modules['cryptography.hazmat.primitives.ciphers.aead'].AESGCM = UnsupportedAESGCM\n"
           % crypto_version))
    env = dict(os.environ, PYTHONPATH=str(shim), PYTHONDONTWRITEBYTECODE="1",
               MORROW_HOME=str(tmp_path / "probe-state"))
    probe = subprocess.run([sys.executable, "-c", """
from privacy.executor_wire import project_learner_result
entry = {'name': 't_users', 'request': {'url': 'https://school.instructure.com/api/v1/courses/1/users'}}
result = {'receipt': [{'id': 8675309, 'name': 'Jane Doe'}], 'truncated': False, 'bytes_received': 10}
try:
    project_learner_result(entry, result, 'https://school.instructure.com')
except Exception as exc:
    message = str(exc)
    assert 'cryptography' in message and 'requirements-optional.txt' in message, message
    assert 'Jane Doe' not in message and '8675309' not in message, message
else:
    raise AssertionError('unsupported crypto must refuse learner data')
"""], cwd=tree, env=env, capture_output=True, text=True, timeout=30)
    assert probe.returncode == 0, probe.stdout + probe.stderr
    suites = ["transport/chromium_session_selftest.py",
              "privacy/source_privacy_selftest.py",
              "privacy/deidentif_selftest.py"]
    proc = subprocess.run(["bash", str(tree / "scripts/install-suites.sh"),
                           "--show-failures", *suites], cwd=tree, env=env,
                          capture_output=True, text=True, timeout=180)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert proc.stdout.splitlines()[-1] == "3/3 selftest suites pass"

LIVE = {"MORROW_HOME": "/live/.morrow",
        "MORROW_TREE_STATE_DIR": "/live/.morrow/trees/t",
        "MORROW_SOURCE_VAULT_PATH": "/live/vault.json",
        "MORROW_APPROVAL_SIGNING_KEY": "/live/key",
        "MORROW_USER_ID": "educator", "MORROW_CONVERSATION_ID": "c1",
        "MORROW_HELPER_ENV_FILE": "/live/helper/env",
        "MORROW_PRIVACY_MAP": "/live/map", "MORROW_PRIVACY_SALT": "s",
        "MORROW_SELFTEST_HOME": "/live/.morrow",
        "LOGIN_HELPER_PROFILE_DIR": "/live/profile",
        "LOGIN_HELPER_PORT": "8901", "LOGIN_HELPER_CDP_PORT": "9222"}

FAKE_SUITE = """import json, os, sys
with open(os.path.abspath(__file__) + ".seen.json", "w") as fh:
    json.dump({"cwd": os.getcwd(), "env": dict(os.environ)}, fh)
if os.path.basename(__file__) == os.environ.get("FAIL_SUITE_NAME", "-"):
    print("suite output: boom")
    sys.exit(3)
"""


def _fake_tree(tmp_path):
    tree = tmp_path / "tree"
    (tree / "scripts").mkdir(parents=True)
    shutil.copy2(RUNNER, tree / "scripts" / "install-suites.sh")
    for suite in carve.install_suites():
        path = tree / suite
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(FAKE_SUITE)
    return tree


def _run(tree, *args, fail=None):
    env = dict(os.environ, HOME=str(tree.parent / "live-home"), **LIVE)
    if fail:
        env["FAIL_SUITE_NAME"] = os.path.basename(fail)
    return subprocess.run(["bash", str(tree / "scripts" / "install-suites.sh")]
                          + list(args), capture_output=True, text=True,
                          env=env)


def _seen(tree, suite):
    with open(str(tree / suite) + ".seen.json") as fh:
        return json.load(fh)


def test_the_suite_list_is_the_one_install_sh_always_ran():
    suites = carve.install_suites()
    assert len(suites) == len(set(suites)) == 23
    for suite in suites:
        assert os.path.isfile(os.path.join(TREE, suite)), suite


def test_install_step_9_runs_the_shared_runner():
    with open(os.path.join(TREE, "install.sh"), encoding="utf-8") as fh:
        text = fh.read()
    step9 = text[text.index('step "9/10'):text.index('step "10/10')]
    assert "scripts/install-suites.sh" in step9
    assert 'SUITES="' not in text


def test_every_suite_runs_isolated_from_live_state(tmp_path):
    tree = _fake_tree(tmp_path)
    proc = _run(tree)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert proc.stdout.splitlines()[-1] == "23/23 selftest suites pass"
    homes = set()
    for suite in carve.install_suites():
        seen = _seen(tree, suite)
        assert os.path.realpath(seen["cwd"]) == os.path.realpath(str(tree))
        home = os.path.realpath(seen["env"]["HOME"])
        assert home.startswith(os.path.realpath(
            str(tree / ".selftest-work")) + os.sep), home
        homes.add(home)
        assert [v for v in LIVE if v in seen["env"]] == [], suite
    assert len(homes) == 23, "every suite gets its own scratch home"


def test_user_site_dependency_survives_scratch_home(tmp_path):
    tree = _fake_tree(tmp_path)
    live_home = tmp_path / "live-home"
    live_home.mkdir()
    base_python = sys._base_executable
    env = dict(os.environ, HOME=str(live_home), PYTHONPATH="")
    user_site = subprocess.check_output(
        [base_python, "-c", "import site; assert site.ENABLE_USER_SITE; "
         "print(site.getusersitepackages())"], env=env, text=True).strip()
    os.makedirs(user_site)
    module = os.path.join(user_site, "morrow_user_site_probe.py")
    with open(module, "w") as fh:
        fh.write("MARKER = 'user-site dependency available'\n")
    suite = carve.install_suites()[0]
    (tree / suite).write_text(
        "import morrow_user_site_probe\n"
        "assert morrow_user_site_probe.MARKER == "
        "'user-site dependency available'\n"
        "import os\n"
        "assert os.environ['HOME'] != %r\n" % str(live_home)
        + "assert 'MORROW_HOME' not in os.environ\n")
    bindir = tmp_path / "bin"
    bindir.mkdir()
    (bindir / "python3").symlink_to(base_python)
    env["PATH"] = str(bindir) + os.pathsep + os.environ["PATH"]
    env.update(LIVE)
    proc = subprocess.run(
        ["bash", str(tree / "scripts" / "install-suites.sh"), suite],
        cwd=tree, env=env,
        capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert proc.stdout.splitlines()[-1] == "1/1 selftest suites pass"


def test_a_failed_suite_is_named_and_the_rest_still_run(tmp_path):
    tree = _fake_tree(tmp_path)
    suites = carve.install_suites()
    proc = _run(tree, fail=suites[1])
    assert proc.returncode != 0
    lines = proc.stdout.splitlines()
    assert "FAIL %s" % suites[1] in lines
    assert lines[-1] == "22/23 selftest suites pass"
    assert "boom" not in proc.stdout + proc.stderr
    for suite in suites:
        assert os.path.exists(str(tree / suite) + ".seen.json"), suite


def test_show_failures_prints_the_failed_suite_output(tmp_path):
    tree = _fake_tree(tmp_path)
    suites = carve.install_suites()
    proc = _run(tree, "--show-failures", fail=suites[-1])
    assert proc.returncode != 0
    assert "suite output: boom" in proc.stdout
    assert "FAIL %s" % suites[-1] in proc.stdout.splitlines()


def test_the_egress_suite_passes_while_its_old_ports_are_taken():
    import socket
    held = []
    try:
        for port in range(18093, 18100):
            sock = socket.socket()
            try:
                sock.bind(("127.0.0.1", port))
                sock.listen(1)
            except OSError:
                # Another program holds it already: the same case.
                sock.close()
                continue
            held.append(sock)
        proc = subprocess.run(
            ["bash", RUNNER, "--show-failures", "transport/egress_selftest.py"],
            capture_output=True, text=True, timeout=600)
    finally:
        for sock in held:
            sock.close()
    assert proc.returncode == 0, proc.stdout[-4000:] + proc.stderr[-2000:]
