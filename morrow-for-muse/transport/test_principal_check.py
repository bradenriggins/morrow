#!/usr/bin/env python3
"""The Chromium lane works only as the pinned Canvas account.

Failure modes this suite pins down (written before the fix; final muse
audit 2026-09-22, M3): transport/chromium_session.py and
local_chromium.py never compared the signed-in account with the pinned
principal. If someone else signed in inside the helper browser (a
student at a shared machine, a second educator), every read and write
ran silently as that account, while SKILL.md said a different account
is refused.

  1. Before every write, GET /api/v1/users/self must match the pin; a
     mismatch sends nothing, imposes the re-auth write halt, and gives
     the educator a clear message that never shows the other account.
  2. Reads check once per session object; a mismatch refuses the read
     the same way.
  3. An account switch in the middle of a session is caught at the
     next write (writes re-check every time).
  4. With no pin, reads run and writes are refused until the educator
     pins their account.
  5. A damaged pin store fails closed (never read as "no pin").
  6. The agent gets a cataloged failure mode, not the unknown fallback.

Stdlib only; a fake transport stands in for the browser tab.
"""

import json
import os
import shutil
import sys

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (TREE, os.path.join(TREE, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from dispatch import executor as ex  # noqa: E402
from reauth import state_machine as rsm  # noqa: E402
from transport import state as lane_state  # noqa: E402
import chromium_session as cs  # noqa: E402

BASE = "https://school.instructure.com"
_PATH_NAMES = ("STATE_PATH", "HALT_PATH", "QUAR_PATH", "NOTIFY_PATH",
               "APPROVAL_PATH", "SESSION_PATH", "SESSION_PREV",
               "LAST_DEATH_PATH", "SESSION_PREV_MONO")


@pytest.fixture
def home(monkeypatch, tmp_path):
    root = str(tmp_path / "reauth")
    os.makedirs(root, mode=0o700)
    monkeypatch.setattr(rsm, "STORE_DIR", root)
    for name in _PATH_NAMES:
        monkeypatch.setattr(rsm, name, os.path.join(
            root, os.path.basename(getattr(rsm, name))))
    lane_path = os.path.join(root, "browser_lane.json")
    monkeypatch.setattr(lane_state, "STATE_PATH", lane_path)
    bare = sys.modules.get("state")
    if bare is not None and hasattr(bare, "STATE_PATH"):
        monkeypatch.setattr(bare, "STATE_PATH", lane_path)
    yield root
    shutil.rmtree(root, ignore_errors=True)


class Tab:
    """Fake browser tab: answers users/self with whoever is signed in."""

    def __init__(self, signed_in):
        self.signed_in = signed_in
        self.calls = []

    def api(self, method, path, data=None, as_json=False, timeout=60,
            max_bytes=None):
        self.calls.append((method, path))
        if path.startswith("/api/v1/users/self"):
            return 200, {}, json.dumps({"id": self.signed_in,
                                        "name": "Account %s" % self.signed_in})
        return 200, {}, json.dumps({"id": 1, "ok": True})


def _session(tab):
    sess = cs.ChromiumSession(BASE, transport=tab)
    sess._check_expiry_warning = lambda: None
    return sess


def _read(sess):
    return sess.raw_request("GET", BASE + "/api/v1/courses/1", {}, None)


def _write(sess):
    return sess.raw_request("PUT", BASE + "/api/v1/courses/1",
                            {"Content-Type": "application/json"},
                            b'{"course": {"name": "x"}}', is_write=True)


def _sent(tab):
    return [c for c in tab.calls if not c[1].startswith("/api/v1/users/self")]


def _self_reads(tab):
    return [c for c in tab.calls if c[1].startswith("/api/v1/users/self")]


def test_pinned_account_reads_check_once_and_writes_check_every_time(home):
    rsm.pin_principal(BASE, 777, "Edu T. Or", first_signin=True)
    tab = Tab(777)
    sess = _session(tab)
    _read(sess)
    _read(sess)
    assert len(_self_reads(tab)) == 1
    _write(sess)
    _write(sess)
    assert len(_self_reads(tab)) == 3
    assert len(_sent(tab)) == 4
    assert rsm.check_write_allowed()[0] is True


def test_other_account_read_is_refused_and_halts(home):
    rsm.pin_principal(BASE, 777, "Edu T. Or", first_signin=True)
    tab = Tab(999)
    with pytest.raises(cs.PrincipalMismatch) as info:
        _read(_session(tab))
    assert isinstance(info.value, ex.ExecutorError)
    assert _sent(tab) == []
    assert rsm.check_write_allowed()[0] is False
    message = str(info.value)
    assert "Edu T. Or" in message
    assert "999" not in message and "Account 999" not in message


def test_other_account_write_sends_nothing(home):
    rsm.pin_principal(BASE, 777, "Edu T. Or", first_signin=True)
    tab = Tab(999)
    with pytest.raises(cs.PrincipalMismatch):
        _write(_session(tab))
    assert _sent(tab) == []
    assert rsm.check_write_allowed()[0] is False


def test_account_switch_mid_session_is_caught_at_the_next_write(home):
    rsm.pin_principal(BASE, 777, "Edu T. Or", first_signin=True)
    tab = Tab(777)
    sess = _session(tab)
    _read(sess)
    tab.signed_in = 999
    with pytest.raises(cs.PrincipalMismatch):
        _write(sess)
    assert _sent(tab) == [("GET", "/api/v1/courses/1")]


def test_no_pin_reads_run_and_writes_are_refused(home):
    tab = Tab(777)
    sess = _session(tab)
    _read(sess)
    with pytest.raises(cs.PrincipalNotPinned) as info:
        _write(sess)
    assert _sent(tab) == [("GET", "/api/v1/courses/1")]
    assert "pin" in str(info.value)


def test_damaged_pin_store_fails_closed(home):
    rsm.pin_principal(BASE, 777, "Edu T. Or", first_signin=True)
    with open(lane_state.STATE_PATH, "w") as fh:
        fh.write("{not json")
    os.chmod(lane_state.STATE_PATH, 0o600)
    tab = Tab(777)
    with pytest.raises(ex.ExecutorError):
        _read(_session(tab))
    assert _sent(tab) == []


def test_the_pin_read_itself_is_not_blocked(home):
    # reauth/state_machine.read_live_principal reads users/self through
    # this lane to pin and to verify a resume; it must see who is signed
    # in, and it returns only that account's own record.
    rsm.pin_principal(BASE, 777, "Edu T. Or", first_signin=True)
    tab = Tab(999)
    status, _h, raw, _n = _session(tab).raw_request(
        "GET", BASE + "/api/v1/users/self", {}, None)
    assert status == 200 and json.loads(raw)["id"] == 999


def test_agent_gets_a_cataloged_mode_with_a_clear_message(home):
    from failures.funnel import agent_error_payload
    rsm.pin_principal(BASE, 777, "Edu T. Or", first_signin=True)
    with pytest.raises(cs.PrincipalMismatch) as info:
        _write(_session(Tab(999)))
    payload = agent_error_payload("write", info.value)
    assert payload["mode_id"] == "canvas-account-mismatch"
    assert "different Canvas account" in payload["message"]


def test_agent_gets_a_cataloged_mode_when_no_account_is_pinned(home):
    from failures.funnel import agent_error_payload
    with pytest.raises(cs.PrincipalNotPinned) as info:
        _write(_session(Tab(777)))
    payload = agent_error_payload("write", info.value)
    assert payload["mode_id"] == "canvas-account-not-pinned"
