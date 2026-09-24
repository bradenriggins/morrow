#!/usr/bin/env python3
"""After the educator disconnects, nothing reconnects on its own.

Failure modes this suite pins down (written before the fix; muse UX
audit 3, finding muse-ux3/disconnect-undone-by-helper-down-recovery):
  1. Nothing recorded the disconnect. The next Canvas command found the
     helper stopped and returned helper-down, which says "your Canvas
     sign-in is not affected", although the disconnect deleted it, and
     whose next step is to relaunch the helper and run bin/morrow start.
  2. bin/morrow start then started the keepalive loop and marked it
     installed, so the helper and its restart schedule came back
     without the educator asking.
  3. On a machine with cron, bin/morrow start said "install.sh
     installed the entry" when crontab held no entry for this tree.

While the disconnect is recorded, students find, the failed-students
chain, and every Chromium-lane command say the educator disconnected
(canvas-disconnected) before they reach the helper, and bin/morrow
start starts nothing and names install.sh. Hermetic: a closed port
stands in for the stopped helper, CHROMIUM_BIN names a missing file so
no browser can start, and crontab is a stand-in on PATH.
"""

import importlib.machinery
import importlib.util
import json
import os
import socket
import subprocess
import sys

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if TREE not in sys.path:
    sys.path.insert(0, TREE)

from config import disconnect  # noqa: E402

BASE = "https://canvas.example.edu"


def _closed_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


@pytest.fixture
def tree_env(tmp_path, monkeypatch):
    """A tree state dir and helper/env whose helper is not running."""
    from transport import local_chromium
    state = tmp_path / "tree-state"
    state.mkdir()
    (state / "helper_token").write_text("ab" * 32 + "\n")
    # The executor refuses a state dir that is not bound to this tree.
    (state / ".morrow-tree-binding").write_text(local_chromium.tree_id(TREE))
    env_file = tmp_path / "helper-env"
    env_file.write_text("CANVAS_BASE=%s\nLOGIN_HELPER_PORT=%d\n"
                        "CHROMIUM_BIN=%s\n"
                        % (BASE, _closed_port(), tmp_path / "no-chromium"))
    env_file.chmod(0o600)
    for name in ("CANVAS_BASE", "LOGIN_HELPER_PORT", "CHROMIUM_BIN",
                 "LOGIN_HELPER_TLS_CERT", "LOGIN_HELPER_TLS_KEY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("MORROW_HELPER_ENV_FILE", str(env_file))
    monkeypatch.setenv("MORROW_TREE_STATE_DIR", str(state))
    return {"state": state, "env_file": env_file}


def _plain(message):
    assert "not affected" not in message, message
    assert "you disconnected" in message.lower(), message
    assert "Connect my Canvas account" in message, message


def test_the_marker_is_kept_in_the_tree_state_dir(tree_env):
    assert disconnect.is_disconnected() is False
    disconnect.mark()
    assert os.path.isfile(os.path.join(str(tree_env["state"]),
                                       "disconnected"))
    assert disconnect.is_disconnected() is True
    disconnect.clear()
    assert disconnect.is_disconnected() is False
    disconnect.clear()  # clearing twice is not an error


def test_students_find_says_the_educator_disconnected(tree_env, capsys):
    from learners import find
    disconnect.mark()

    def no_fetch(url):
        raise AssertionError("nothing may be read after a disconnect")
    rc = find.main(["--course", "89585", "--conversation-id", "c1",
                    "Jane Doe"], fetcher=no_fetch)
    out = json.loads(capsys.readouterr().out)
    assert rc == 1
    assert out["mode_id"] == "canvas-disconnected", out
    _plain(out["message"])
    assert "install.sh" in out["next_step"], out
    assert "keepalive" not in out["next_step"], out


def test_students_find_without_a_disconnect_is_still_helper_down(
        tree_env, capsys):
    from learners import find
    rc = find.main(["--course", "89585", "Jane Doe"])
    out = json.loads(capsys.readouterr().out)
    assert rc == 1
    assert out["mode_id"] == "helper-down", out


def test_the_query_says_the_educator_disconnected(tree_env, monkeypatch):
    from query import chain

    class NoReader:
        def __init__(self, *a, **k):
            raise AssertionError("no reader may start after a disconnect")
    # As on the day the submissions row is live-proven.
    monkeypatch.setattr(chain, "_require_live_proven", lambda *a: None)
    monkeypatch.setattr(chain._live_read, "LiveReader", NoReader)
    disconnect.mark()
    with pytest.raises(chain.ChainFailure) as info:
        chain.run_query("89585", "last_week")
    assert info.value.translated.mode_id == "canvas-disconnected"
    _plain(info.value.translated.agent_message)


def test_the_chromium_session_refuses_before_the_browser(tree_env):
    from transport import chromium_session as cs
    disconnect.mark()
    with pytest.raises(disconnect.CanvasDisconnected):
        cs.ChromiumSession.load()


def test_an_executor_command_says_the_educator_disconnected(tree_env):
    disconnect.mark()
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    proc = subprocess.run(
        [sys.executable, os.path.join(TREE, "bin", "morrow"), "dispatch",
         "catalog", "--name", "canvas_list_courses", "--method", "GET",
         "--path", "/api/v1/courses", "--class", "read",
         "--backend", "chromium"],
        cwd=TREE, env=env, capture_output=True, text=True, timeout=120)
    assert proc.returncode == 2, proc.stdout + proc.stderr
    payload = json.loads(proc.stderr.strip().splitlines()[-1])
    assert payload["mode_id"] == "canvas-disconnected", payload
    _plain(payload["message"])


def _cli():
    loader = importlib.machinery.SourceFileLoader(
        "morrow_cli_disconnected", os.path.join(TREE, "bin", "morrow"))
    mod = importlib.util.module_from_spec(
        importlib.util.spec_from_loader("morrow_cli_disconnected", loader))
    loader.exec_module(mod)
    return mod


@pytest.mark.parametrize("method", ["cron", "loop"])
def test_start_starts_nothing_after_a_disconnect(tree_env, monkeypatch,
                                                 capsys, method):
    from helper import supervisor
    started = []
    monkeypatch.setattr(supervisor, "detect", lambda path=None: method)
    monkeypatch.setattr(supervisor, "ensure",
                        lambda *a, **k: started.append(a) or {})
    disconnect.mark()
    rc = _cli().main(["start"])
    out = json.loads(capsys.readouterr().out)
    assert rc == 1, out
    assert started == []
    assert out["started"] is False
    assert "install.sh" in out["message"], out
    assert not os.path.exists(os.path.join(
        str(tree_env["state"]), supervisor.STATE_NAME))


def _fake_crontab(tmp_path, monkeypatch, table):
    fakebin = tmp_path / "fakebin"
    fakebin.mkdir()
    crontab = fakebin / "crontab"
    table_file = tmp_path / "crontab.txt"
    if table is not None:
        table_file.write_text(table)
    crontab.write_text('#!/bin/bash\n[ "$1" = "-l" ] || exit 2\n'
                       '[ -f "%s" ] && cat "%s" || exit 1\n'
                       % (table_file, table_file))
    crontab.chmod(0o755)
    monkeypatch.setenv("PATH", "%s%s%s" % (fakebin, os.pathsep,
                                           os.environ.get("PATH", "")))


@pytest.mark.parametrize("table", [
    None, "", "0 3 * * * /usr/bin/backup-my-files\n",
    '*/5 * * * * "/elsewhere/other-tree/helper/keepalive.sh"\n'])
def test_start_with_cron_never_claims_a_missing_entry(
        tree_env, tmp_path, monkeypatch, capsys, table):
    from helper import supervisor
    monkeypatch.setattr(supervisor, "detect", lambda path=None: "cron")
    _fake_crontab(tmp_path, monkeypatch, table)
    rc = _cli().main(["start"])
    out = json.loads(capsys.readouterr().out)
    assert rc == 1, out
    assert "installed the entry" not in out["message"], out
    assert "install.sh" in out["message"], out


def test_start_with_cron_reports_this_trees_entry(tree_env, tmp_path,
                                                  monkeypatch, capsys):
    from helper import supervisor
    monkeypatch.setattr(supervisor, "detect", lambda path=None: "cron")
    _fake_crontab(tmp_path, monkeypatch,
                  '# morrow-muse-connector-keepalive\n'
                  '*/5 * * * * "%s/helper/keepalive.sh"\n'
                  % os.path.realpath(TREE))
    rc = _cli().main(["start"])
    out = json.loads(capsys.readouterr().out)
    assert rc == 0, out
    assert out["method"] == "cron" and out["started"] is False
