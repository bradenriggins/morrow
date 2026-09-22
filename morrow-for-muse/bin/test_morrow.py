#!/usr/bin/env python3
"""QOL-2 tests: bin/morrow unified operator CLI.

Safety contract under test:
- the wrapper changes no behavior: it execs existing entry points with
  the operator's arguments passed through untouched;
- unknown commands exit 2 with help, never a traceback;
- doctor is read-only: it performs one GET to the helper /status
  endpoint and reads tree files; it never reads or sends auth material;
- doctor degrades cleanly (exit 1, plain message) when the helper is
  unreachable.
"""

import importlib.machinery
import importlib.util
import io
import json
import os
import sys
import urllib.error

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN_MORROW = os.path.join(TREE, "bin", "morrow")


def _load():
    loader = importlib.machinery.SourceFileLoader("morrow_cli", BIN_MORROW)
    spec = importlib.util.spec_from_loader("morrow_cli", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


@pytest.fixture()
def cli():
    return _load()


def test_help_lists_commands(cli, capsys):
    assert cli.main(["--help"]) == 0
    out = capsys.readouterr().out
    for cmd in ("dispatch", "audit", "plan", "query", "doctor"):
        assert cmd in out


def test_unknown_command_exit_2(cli, capsys):
    assert cli.main(["bogus"]) == 2
    err = capsys.readouterr().err
    assert "unknown command" in err
    assert "Traceback" not in err


def test_dispatch_passthrough(cli, monkeypatch):
    seen = {}

    def fake_run(cmd, **kwargs):
        seen["cmd"] = cmd

        class P:
            returncode = 7
        return P()

    monkeypatch.setattr(cli.subprocess, "run", fake_run)
    rc = cli.main(["dispatch", "catalog", "--name", "x"])
    assert rc == 7
    exe = os.path.join(TREE, "dispatch", "executor.py")
    assert seen["cmd"] == [sys.executable, exe, "catalog", "--name", "x"]


def test_audit_prepends_subcommand(cli, monkeypatch):
    seen = {}

    def fake_run(cmd, **kwargs):
        seen["cmd"] = cmd

        class P:
            returncode = 0
        return P()

    monkeypatch.setattr(cli.subprocess, "run", fake_run)
    assert cli.main(["audit", "--target-kind", "canvas_page"]) == 0
    exe = os.path.join(TREE, "catalog", "a11y", "runner.py")
    assert seen["cmd"][:3] == [sys.executable, exe, "audit"]
    assert seen["cmd"][3:] == ["--target-kind", "canvas_page"]


def test_launch_failure_is_clean(cli, monkeypatch, capsys):
    def fake_run(cmd, **kwargs):
        raise OSError("nope")

    monkeypatch.setattr(cli.subprocess, "run", fake_run)
    assert cli.main(["dispatch"]) == 127
    assert "cannot launch" in capsys.readouterr().err


class _FakeResp:
    def __init__(self, payload):
        self._payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return json.dumps(self._payload).encode("utf-8")


def test_doctor_healthy(cli, monkeypatch, capsys):
    monkeypatch.setattr(
        cli.urllib.request, "urlopen",
        lambda url, timeout=10: _FakeResp(
            {"logged_in": True, "chromium_alive": True}))
    assert cli.main(["doctor"]) == 0
    out = capsys.readouterr().out
    assert "logged_in=True" in out
    assert "chromium_alive=True" in out


def test_doctor_unhealthy_session(cli, monkeypatch, capsys):
    monkeypatch.setattr(
        cli.urllib.request, "urlopen",
        lambda url, timeout=10: _FakeResp(
            {"logged_in": False, "chromium_alive": True}))
    assert cli.main(["doctor"]) == 1
    assert "logged_in=False" in capsys.readouterr().out


def test_doctor_unreachable(cli, monkeypatch, capsys):
    def _boom(url, timeout=10):
        raise urllib.error.URLError("connection refused")

    monkeypatch.setattr(cli.urllib.request, "urlopen", _boom)
    assert cli.main(["doctor"]) == 1
    captured = capsys.readouterr()
    assert "UNREACHABLE" in captured.out
    assert "Traceback" not in captured.out + captured.err


def test_doctor_reads_no_auth_material(cli, monkeypatch, capsys):
    opened = []
    real_open = open

    def spy_open(path, *args, **kwargs):
        opened.append(str(path))
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr(
        cli.urllib.request, "urlopen",
        lambda url, timeout=10: _FakeResp(
            {"logged_in": True, "chromium_alive": True}))
    import builtins
    monkeypatch.setattr(builtins, "open", spy_open)
    assert cli.main(["doctor"]) == 0
    for path in opened:
        low = path.lower()
        assert "session" not in low, path
        assert "secret" not in low, path
        assert "credential" not in low, path


# ---------------------------------------------------------------------------
# QOL-4/QOL-5/QOL-6 tests: version, failure lookup, doctor --json.
#
# Safety contract under test:
# - version and failure are read-only and additive; they touch no proven
#   path and change no default behavior;
# - failure never reads auth material and degrades with exit codes, never
#   tracebacks;
# - doctor --json reports exactly the same facts as the default text mode;
#   the default mode output is unchanged.
# ---------------------------------------------------------------------------


def _version_text():
    with open(os.path.join(TREE, "VERSION"), encoding="utf-8") as fh:
        return fh.read().strip()


def test_version_output(cli, capsys):
    assert cli.main(["version"]) == 0
    out = capsys.readouterr().out
    assert out.startswith("morrow %s" % _version_text())
    for cmd in ("dispatch", "audit", "plan", "query", "doctor",
                "version", "failure"):
        assert cmd in out
    assert "\u2014" not in out


def test_version_rejects_args(cli, capsys):
    assert cli.main(["version", "extra"]) == 2
    assert "Traceback" not in capsys.readouterr().err


def test_help_lists_new_commands(cli, capsys):
    assert cli.main(["--help"]) == 0
    out = capsys.readouterr().out
    assert "version" in out
    assert "failure" in out


def test_failure_exact_id(cli, capsys):
    assert cli.main(["failure", "canvas-csrf-422-writes-only"]) == 0
    out = capsys.readouterr().out
    assert "id: canvas-csrf-422-writes-only" in out
    assert "What to tell the educator:" in out
    assert "What to do:" in out
    assert "\u2014" not in out


def test_failure_unique_fragment(cli, capsys):
    assert cli.main(["failure", "csrf-422"]) == 0
    assert "id: canvas-csrf-422-writes-only" in capsys.readouterr().out


def test_failure_ambiguous(cli, capsys):
    assert cli.main(["failure", "canvas"]) == 1
    captured = capsys.readouterr()
    assert "matches" in captured.err
    assert "Traceback" not in captured.out + captured.err


def test_failure_no_match(cli, capsys):
    assert cli.main(["failure", "nope-xyz-123"]) == 1
    assert "no catalog entry matches" in capsys.readouterr().err


def test_failure_no_args_is_usage(cli, capsys):
    assert cli.main(["failure"]) == 2
    assert "usage" in capsys.readouterr().out


def test_failure_list_count_matches_catalog(cli, capsys):
    sys.path.insert(0, TREE)
    from failures.catalog import load_catalog
    expected = len(load_catalog().entries)
    assert expected > 0
    assert cli.main(["failure", "--list"]) == 0
    lines = [l for l in capsys.readouterr().out.splitlines() if l.strip()]
    assert len(lines) == expected


def test_failure_reads_no_auth_material(cli, capsys, monkeypatch):
    opened = []
    real_open = open

    def spy_open(path, *args, **kwargs):
        opened.append(str(path))
        return real_open(path, *args, **kwargs)

    import builtins
    monkeypatch.setattr(builtins, "open", spy_open)
    assert cli.main(["failure", "canvas-csrf-422-writes-only"]) == 0
    for path in opened:
        low = path.lower()
        assert "session" not in low, path
        assert "secret" not in low, path
        assert "credential" not in low, path


def test_doctor_json_parses_and_matches_exit(cli, monkeypatch, capsys):
    monkeypatch.setattr(
        cli.urllib.request, "urlopen",
        lambda url, timeout=10: _FakeResp(
            {"logged_in": True, "chromium_alive": True}))
    assert cli.main(["doctor", "--json"]) == 0
    facts = json.loads(capsys.readouterr().out)
    assert facts["ok"] is True
    assert facts["helper"]["logged_in"] is True
    assert facts["helper"]["chromium_alive"] is True
    assert facts["tree"]["VERSION"] == "ok"
    assert facts["entries"]["query"] == "ok"


def test_doctor_json_unhealthy(cli, monkeypatch, capsys):
    monkeypatch.setattr(
        cli.urllib.request, "urlopen",
        lambda url, timeout=10: _FakeResp(
            {"logged_in": False, "chromium_alive": True}))
    assert cli.main(["doctor", "--json"]) == 1
    facts = json.loads(capsys.readouterr().out)
    assert facts["ok"] is False
    assert facts["helper"]["logged_in"] is False


def test_doctor_default_output_unchanged(cli, monkeypatch, capsys):
    monkeypatch.setattr(
        cli.urllib.request, "urlopen",
        lambda url, timeout=10: _FakeResp(
            {"logged_in": True, "chromium_alive": True}))
    assert cli.main(["doctor"]) == 0
    out = capsys.readouterr().out
    assert out.startswith("helper:")
    try:
        json.loads(out)
    except ValueError:
        pass
    else:
        raise AssertionError("default doctor output must stay plain text")


def test_doctor_rejects_bad_args(cli, capsys):
    assert cli.main(["doctor", "--bogus"]) == 2
    assert "usage" in capsys.readouterr().err
