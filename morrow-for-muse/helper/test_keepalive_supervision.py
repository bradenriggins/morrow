#!/usr/bin/env python3
"""Keepalive supervision does not depend on cron.

Failure modes this suite pins down (written before the fix; round-4
audit 2026-09-22, M5): INSTALL.md and SKILL.md said a cron keepalive
exists, DEPLOY.md said the VM has no cron, and install.sh only warned
when crontab was missing, so on that VM nothing ever restarted the
helper. Supervision must detect what the machine has (cron, or no
cron) and, without cron, run a supervised background loop that
`bin/morrow start` (and the first morrow command after a reboot)
starts. Uninstall must stop that loop and must not refuse to run on a
machine with no crontab.

Hermetic: a scratch tree with a fake keepalive.sh and a PATH without
crontab. No real helper is started.
"""

import json
import os
import shutil
import stat
import subprocess
import sys
import time
import uuid

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
if TREE not in sys.path:
    sys.path.insert(0, TREE)

from helper import supervisor as sup  # noqa: E402


def _fake_tree(tmp_path, name="tree"):
    tree = tmp_path / name
    (tree / "helper").mkdir(parents=True)
    (tree / ".morrow-tree-id").write_text(uuid.uuid4().hex + "\n")
    shutil.copy(os.path.join(HERE, "supervisor.py"),
                str(tree / "helper" / "supervisor.py"))
    ticks = tmp_path / ("ticks.log" if name == "tree"
                        else "ticks-%s.log" % name)
    ka = tree / "helper" / "keepalive.sh"
    ka.write_text("#!/bin/sh\necho tick >> '%s'\n" % ticks)
    ka.chmod(ka.stat().st_mode | stat.S_IXUSR)
    return tree, ticks


def _path_without_crontab(tmp_path):
    bindir = tmp_path / "bin-no-cron"
    bindir.mkdir()
    for tool in ("sh", "bash", "ps", "env", "python3"):
        real = shutil.which(tool)
        if real:
            os.symlink(real, str(bindir / tool))
    return str(bindir)


def _path_with_crontab(tmp_path):
    bindir = tmp_path / "bin-cron"
    bindir.mkdir(exist_ok=True)
    fake = bindir / "crontab"
    fake.write_text("#!/bin/sh\nexit 0\n")
    fake.chmod(0o755)
    return str(bindir) + os.pathsep + os.environ.get("PATH", "")


def _wait(pred, timeout=15.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return True
        time.sleep(0.05)
    return False


def test_detect_without_crontab_is_loop(tmp_path):
    assert sup.detect(path=_path_without_crontab(tmp_path)) == "loop"


def test_detect_with_crontab_and_a_cron_daemon_is_cron(tmp_path,
                                                      monkeypatch):
    monkeypatch.setattr(sup, "cron_daemon_running", lambda: True)
    assert sup.detect(path=_path_with_crontab(tmp_path)) == "cron"
    monkeypatch.setattr(sup, "cron_daemon_running", lambda: False)
    assert sup.detect(path=_path_with_crontab(tmp_path)) == "loop"


def test_loop_runs_keepalive_repeatedly_single_instance_and_stops(tmp_path):
    tree, ticks = _fake_tree(tmp_path)
    first = sup.ensure(str(tree), interval=0.3, first_delay=0.0)
    try:
        assert first["method"] == "loop" and first["started"] is True
        assert _wait(lambda: ticks.exists()
                     and len(ticks.read_text().splitlines()) >= 2)
        again = sup.ensure(str(tree), interval=0.3, first_delay=0.0)
        assert again["started"] is False
        assert again["pid"] == first["pid"]
        status = sup.status(str(tree))
        assert status["running"] is True and status["pid"] == first["pid"]
    finally:
        stopped = sup.stop(str(tree))
    assert stopped["stopped"] is True
    assert _wait(lambda: not sup.status(str(tree))["running"])
    count = len(ticks.read_text().splitlines())
    time.sleep(0.8)
    assert len(ticks.read_text().splitlines()) == count


def test_stop_also_ends_a_keepalive_run_in_progress(tmp_path):
    """Final muse audit L1: stop killed only the loop's PID. A keepalive
    run in progress (a child of the loop, in the loop's own session)
    kept going and relaunched the helper after stop returned. Stop must
    end the loop's whole process group and wait for it."""
    tree, _ticks = _fake_tree(tmp_path)
    log = tmp_path / "ka.log"
    ka = tree / "helper" / "keepalive.sh"
    ka.write_text("#!/bin/sh\necho start >> '%s'\nsleep 2\n"
                  "echo relaunched-helper >> '%s'\n" % (log, log))
    first = sup.ensure(str(tree), interval=30, first_delay=0.0)
    try:
        assert _wait(lambda: log.exists() and "start" in log.read_text())
    finally:
        stopped = sup.stop(str(tree))
    assert stopped["stopped"] is True
    with pytest.raises(ProcessLookupError):
        os.killpg(first["pid"], 0)
    time.sleep(3)
    assert "relaunched-helper" not in log.read_text()


def test_loop_restarts_after_its_process_died(tmp_path):
    tree, ticks = _fake_tree(tmp_path)
    first = sup.ensure(str(tree), interval=0.3, first_delay=0.0)
    try:
        os.kill(first["pid"], 9)
        assert _wait(lambda: not sup.status(str(tree))["running"])
        second = sup.ensure(str(tree), interval=0.3, first_delay=0.0)
        assert second["started"] is True and second["pid"] != first["pid"]
    finally:
        sup.stop(str(tree))


def test_is_our_loop_matches_the_exact_tree_argument(monkeypatch):
    # S4: the tree must match as the exact --tree argument. A
    # substring match adopted prefix-path neighbors: the loop for
    # /x/morrow2 contains "/x/morrow" in its cmdline, so morrow's
    # status/ensure/stop stole or killed morrow2's loop.
    me = os.getpid()
    run = "python3 /x/morrow/helper/supervisor.py run"
    monkeypatch.setattr(
        sup, "_cmdline",
        lambda pid: "%s --tree /x/morrow --state-dir /s --interval 300 "
                    "--first-delay 300" % run)
    assert sup._is_our_loop(me, "/x/morrow") is True
    monkeypatch.setattr(
        sup, "_cmdline",
        lambda pid: "%s --tree=/x/morrow --state-dir /s" % run)
    assert sup._is_our_loop(me, "/x/morrow") is True
    monkeypatch.setattr(
        sup, "_cmdline",
        lambda pid: "python3 /x/morrow2/helper/supervisor.py run "
                    "--tree /x/morrow2 --state-dir /s --interval 300 "
                    "--first-delay 300")
    assert sup._is_our_loop(me, "/x/morrow") is False


def test_prefix_path_trees_keep_separate_loops(tmp_path):
    # S4 end to end: tree1 (<d>/morrow) holds a stale loop pid that the
    # OS has since recycled to tree2's (<d>/morrow2) live loop. The
    # neighbor's cmdline contains tree1's path as a substring, but
    # tree1 must not adopt, report, or stop it: status stays down,
    # stop refuses, ensure starts tree1's own loop, and tree2's loop
    # survives all of it.
    tree1, _ticks1 = _fake_tree(tmp_path, name="morrow")
    tree2, _ticks2 = _fake_tree(tmp_path, name="morrow2")
    assert str(tree1) in str(tree2)  # the test's premise: prefix path
    second = sup.ensure(str(tree2), interval=30, first_delay=30)
    try:
        assert second["started"] is True
        sup._write_state(str(tree1), {"method": "loop", "installed": True,
                                      "pid": second["pid"]})
        assert sup.status(str(tree1))["running"] is False
        assert sup.stop(str(tree1))["stopped"] is False
        assert sup.status(str(tree2))["running"] is True
        first = sup.ensure(str(tree1), interval=30, first_delay=30)
        assert first["started"] is True
        assert first["pid"] != second["pid"]
        assert sup.status(str(tree2))["running"] is True
    finally:
        sup.stop(str(tree1), forget=True)
        sup.stop(str(tree2), forget=True)
    assert sup.status(str(tree1))["running"] is False
    assert sup.status(str(tree2))["running"] is False


def test_ensure_if_installed_is_a_noop_without_loop_install(tmp_path):
    tree, ticks = _fake_tree(tmp_path)
    assert sup.ensure_if_installed(str(tree)) is None
    assert not sup.status(str(tree))["running"]


def test_ensure_if_installed_restarts_an_installed_loop(tmp_path):
    tree, ticks = _fake_tree(tmp_path)
    sup.mark_installed(str(tree))
    try:
        out = sup.ensure_if_installed(str(tree), interval=0.3,
                                      first_delay=0.0)
        assert out["started"] is True
    finally:
        sup.stop(str(tree))


def test_morrow_start_and_first_command_start_supervision(monkeypatch):
    import importlib.machinery
    import importlib.util
    loader = importlib.machinery.SourceFileLoader(
        "morrow_cli_r4", os.path.join(TREE, "bin", "morrow"))
    spec = importlib.util.spec_from_loader("morrow_cli_r4", loader)
    cli = importlib.util.module_from_spec(spec)
    loader.exec_module(cli)
    calls = []
    monkeypatch.setattr(sup, "ensure",
                        lambda tree, **kw: calls.append(("ensure", tree))
                        or {"method": "loop", "started": True, "pid": 1})
    monkeypatch.setattr(sup, "ensure_if_installed",
                        lambda tree, **kw: calls.append(("if", tree)))
    monkeypatch.setattr(sup, "detect", lambda path=None: "loop")
    assert cli.main(["start"]) == 0
    assert ("ensure", cli.DEPLOY_DIR) in calls
    calls.clear()
    cli.main(["version"])
    assert ("if", cli.DEPLOY_DIR) in calls


def test_docs_and_scripts_tell_the_truth_about_cron():
    def read(rel):
        with open(os.path.join(TREE, rel), encoding="utf-8") as fh:
            return fh.read()
    install = read("install.sh")
    assert "the helper will not self-heal" not in install
    assert "helper/supervisor.py" in install
    uninstall = read("scripts/uninstall.sh")
    assert "crontab not found; cannot verify cron removal" not in uninstall
    assert "supervisor.py" in uninstall
    for rel in ("INSTALL.md", "SKILL.md"):
        text = read(rel)
        assert "background loop" in text, rel
        assert "The same script runs from cron every 5\n   minutes" \
            not in text, rel
    # DEPLOY.md is a dev-tree record that the carved release leaves out.
    if os.path.exists(os.path.join(TREE, "DEPLOY.md")):
        assert "helper/supervisor.py" in read("DEPLOY.md")


def test_helper_down_recovery_works_without_cron():
    """Final muse audit L2: the helper-down failure mode told the agent
    supervision is cron-based and to run keepalive.sh only. On a
    machine without cron, `bin/morrow start` is what brings the
    supervision back, so the recovery must name it. The educator's
    message names no supervision detail at all (final sweep
    2026-09-23: plain words only)."""
    with open(os.path.join(TREE, "failures", "catalog.json"),
              encoding="utf-8") as fh:
        catalog = json.load(fh)
    mode = [e for e in catalog["entries"] if e["id"] == "helper-down"][0]
    assert "bin/morrow start" in mode["auto_action"]
    assert "helper/keepalive.sh" in mode["auto_action"]
    assert "cron-based" not in mode["root_cause"]
    assert "background loop" in mode["root_cause"]
    assert "cron" not in mode["agent_message"]
    assert "start the helper again" in mode["agent_message"]


def _tree_state_dir(tree):
    tree_id = (tree / ".morrow-tree-id").read_text().strip()
    return os.path.join(os.environ["MORROW_HOME"], "trees", tree_id)


def test_loop_state_and_log_live_in_the_state_dir_not_the_tree(tmp_path):
    """Final sweep 2026-09-22: the loop's state and log landed in
    <tree>/helper/, and install.sh's secrets gate (*.log) and integrity
    walk read them as release content, so no install without cron
    could pass. Runtime files belong in the tree's state dir."""
    tree, ticks = _fake_tree(tmp_path)
    sup.mark_installed(str(tree))
    first = sup.ensure(str(tree), interval=0.3, first_delay=0.0)
    try:
        assert _wait(lambda: ticks.exists())
    finally:
        sup.stop(str(tree))
    state = _tree_state_dir(tree)
    assert os.path.isfile(os.path.join(state, "keepalive-supervisor.json"))
    assert os.path.isfile(os.path.join(state, "keepalive-supervisor.log"))
    assert sorted(os.listdir(str(tree / "helper"))) == [
        "keepalive.sh", "supervisor.py"]
    assert first["started"] is True


def test_retire_legacy_stops_an_old_loop_and_moves_its_files(tmp_path):
    """An older release kept the loop's state and every runtime log in
    helper/. Retiring them stops the loop recorded there (its code
    reads only the old state file), keeps the install choice, and
    moves the logs into the state dir so no install gate sees them."""
    tree, _ticks = _fake_tree(tmp_path)
    helper = tree / "helper"
    old = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(120)",
         "supervisor.py", "run", "--tree", os.path.realpath(str(tree))],
        start_new_session=True)
    try:
        (helper / "keepalive-supervisor.json").write_text(json.dumps(
            {"method": "loop", "installed": True, "pid": old.pid}))
        (helper / "keepalive-supervisor.json.lock").write_text("")
        logs = {"keepalive-supervisor.log": "sup\n",
                "keepalive.log": "ka\n", "keepalive.log.1": "ka1\n",
                "server.log": "srv\n", "server.log.3": "srv3\n"}
        for name, text in logs.items():
            (helper / name).write_text(text)
        out = sup.retire_legacy(str(tree))
        assert out["stopped_loop"] == old.pid
        assert old.wait(timeout=10) is not None
        assert sorted(os.listdir(str(helper))) == [
            "keepalive.sh", "supervisor.py"]
        state = _tree_state_dir(tree)
        for name, text in logs.items():
            with open(os.path.join(state, name)) as fh:
                assert fh.read() == text, name
        status = sup.status(str(tree))
        assert status["installed"] is True and status["running"] is False
        assert sup.retire_legacy(str(tree)) == {"stopped_loop": None,
                                                "moved": []}
    finally:
        if old.poll() is None:
            old.kill()
            old.wait()
