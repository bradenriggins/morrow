#!/usr/bin/env python3
"""First-run regression tests for the failed-students query chain.

2026-09-22 lane 5 (first-time setup and use):
- the chain must check for a configured tenant BEFORE initializing the
  browser lane, so a fresh install gets the warm
  setup-tenant-not-configured message, not a helper/Chromium failure;
- helper health-check failures must classify to named catalog entries
  (helper-down / the session-dead family), never the unknown fallback;
- the CLI must exit 2 with the educator-facing message, never a
  traceback.
"""

import os
import sys

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if TREE not in sys.path:
    sys.path.insert(0, TREE)

from query.chain import ChainFailure  # noqa: E402
from query import chain as C  # noqa: E402
from query import live_read as LR  # noqa: E402


class _BoomReader:
    def __init__(self, *a, **k):
        raise AssertionError("LiveReader must not initialize before "
                             "the tenant check")


class _FailingReader:
    closed = False

    def __init__(self, message):
        self._message = message
        _FailingReader.closed = False

    def health_check(self):
        raise LR.LiveReadError(self._message)

    def close(self):
        _FailingReader.closed = True


def _run_no_tenant(monkeypatch, **kw):
    monkeypatch.setattr(C._live_read, "LiveReader", _BoomReader)
    monkeypatch.setattr(C._live_read, "TENANT_BASE", "")
    with pytest.raises(ChainFailure) as ei:
        C.run_query("show me all the students that failed last week's quiz",
                    "89585", tenant_base=None, **kw)
    return ei.value


def test_missing_tenant_fails_before_reader_init(monkeypatch):
    failure = _run_no_tenant(monkeypatch)
    assert failure.translated.mode_id == "setup-tenant-not-configured"


def test_missing_tenant_message_names_next_step(monkeypatch):
    failure = _run_no_tenant(monkeypatch)
    assert "not connected" in failure.translated.agent_message.lower()


def _run_failing_health(monkeypatch, message):
    monkeypatch.setattr(C._live_read, "LiveReader",
                        lambda *a, **k: _FailingReader(message))
    monkeypatch.setattr(C._live_read, "TENANT_BASE",
                        "https://school.example.edu")
    with pytest.raises(ChainFailure) as ei:
        C.run_query("show me all the students that failed last week's quiz",
                    "89585", tenant_base="https://school.example.edu")
    return ei.value


def test_helper_down_classified(monkeypatch):
    failure = _run_failing_health(
        monkeypatch,
        "helper /status failed: <urlopen error [Errno 111] "
        "Connection refused>")
    assert failure.translated.mode_id == "helper-down"


def test_dead_chromium_classified_as_session_dead(monkeypatch):
    failure = _run_failing_health(monkeypatch, "helper Chromium is not alive")
    assert failure.translated.mode_id == "canvas-session-dead"
    assert _FailingReader.closed, "failed health check must close the reader"


def test_signed_out_session_classified_as_session_dead(monkeypatch):
    failure = _run_failing_health(
        monkeypatch, "helper session is not logged in to Canvas")
    assert failure.translated.mode_id == "canvas-session-dead"


def test_main_exits_two_with_mode_line(monkeypatch, capsys):
    failure = _run_failing_health(monkeypatch, "helper Chromium is not alive")
    assert failure.translated.mode_id == "canvas-session-dead"

    def boom(*a, **k):
        raise failure

    monkeypatch.setattr(C, "run_query", boom)
    rc = C.main(["show me all the students that failed last week's quiz",
                 "--course", "89585", "--tenant",
                 "https://school.example.edu"])
    assert rc == 2
    out = capsys.readouterr().out
    assert "(mode canvas-session-dead, ref " in out
    assert "Traceback" not in out
