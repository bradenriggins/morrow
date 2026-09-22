#!/usr/bin/env python3
"""Principal pinning: the signed-in Canvas account is pinned on first
sign-in, and a re-sign-in resumes paused work only for that account.

Failure modes this suite pins down (written before the fix):
  1. No pinned principal: resume used to lift the halt for ANY id.
     It must refuse, keep the halt, and name the recovery step.
  2. Nothing in the product wrote the pin: the first-sign-in path must.
  3. A different account signing in must never replace the pin
     silently, and must never resume paused work.
  4. First-sign-in auto pinning must not run during a re-auth halt:
     that would pin whoever signed back in (the same fail-open).
  5. A pin file that is unreadable, loosely permissioned, or corrupt
     must fail closed, never read as "no pin" and never swallowed.
  6. The educator can still recover an install that has no pin, but
     only with their own confirming words, never by the agent alone.
  7. The resume CLI verifies the live principal itself; a caller-given
     id that disagrees with the live session is refused.

Stdlib only. Scratch lives under .selftest-work/ (never /tmp).
"""

import json
import os
import shutil
import sys
import uuid

import pytest

_TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE not in sys.path:
    sys.path.insert(0, _TREE)

from reauth import state_machine as rsm  # noqa: E402
from transport import state as lane_state  # noqa: E402

_PATH_NAMES = ("STATE_PATH", "HALT_PATH", "QUAR_PATH", "NOTIFY_PATH",
               "APPROVAL_PATH", "SESSION_PATH", "SESSION_PREV",
               "LAST_DEATH_PATH", "SESSION_PREV_MONO")
BASE = "https://school.instructure.com"


@pytest.fixture
def home(monkeypatch):
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        ".selftest-work", "pin-%d" % os.getpid())
    shutil.rmtree(root, ignore_errors=True)
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
    try:
        yield root
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _halt_with_op():
    rsm.impose_halt({"signal": "test"})
    op = str(uuid.uuid4())
    rsm.quarantine_op(op, "create_page", "paused by session death")
    return op


def test_resume_without_pin_fails_closed(home, capsys):
    op = _halt_with_op()
    assert rsm.verified_resume_after_manual_signin(4242, "Anyone") == -1
    assert rsm.check_write_allowed()[0] is False
    assert rsm.op_quarantine_status(op) == "quarantined"
    out = capsys.readouterr().out
    assert "no Canvas account is pinned" in out
    assert "pin --confirm-account" in out


def test_first_signin_pins_then_only_that_account_resumes(home):
    rsm.pin_principal(BASE, 777, "Edu T. Or", first_signin=True)
    pinned = rsm.pinned_principal()
    assert str(pinned["id"]) == "777" and pinned["name"] == "Edu T. Or"
    op = _halt_with_op()
    assert rsm.verified_resume_after_manual_signin(999, "Intruder") == -1
    assert rsm.check_write_allowed()[0] is False
    assert rsm.op_quarantine_status(op) == "quarantined"
    assert rsm.verified_resume_after_manual_signin(777, "Edu Tutor") == 1
    assert rsm.check_write_allowed()[0] is True
    assert rsm.op_quarantine_status(op) == "awaiting_approval"
    assert rsm.pinned_principal()["name"] == "Edu Tutor"


def test_different_account_never_replaces_pin(home):
    rsm.pin_principal(BASE, 777, "Edu T. Or", first_signin=True)
    with pytest.raises(rsm.PrincipalPinError):
        rsm.pin_principal(BASE, 999, "Intruder", first_signin=True)
    with pytest.raises(rsm.PrincipalPinError):
        rsm.pin_principal(BASE, 999, "Intruder",
                          confirmation="yes this is my account, pin it")
    assert str(rsm.pinned_principal()["id"]) == "777"


def test_first_signin_pin_skipped_during_reauth_halt(home):
    _halt_with_op()
    with pytest.raises(rsm.PrincipalPinError):
        rsm.pin_principal(BASE, 4242, "Whoever", first_signin=True)
    assert rsm.pinned_principal() is None


def test_educator_confirmation_recovers_unpinned_install(home):
    op = _halt_with_op()
    with pytest.raises(rsm.PrincipalPinError):
        rsm.pin_principal(BASE, 777, "Edu T. Or", confirmation="ok")
    rsm.pin_principal(
        BASE, 777, "Edu T. Or",
        confirmation="Yes, Edu T. Or is my own Canvas account")
    assert rsm.verified_resume_after_manual_signin(777, "Edu T. Or") == 1
    assert rsm.op_quarantine_status(op) == "awaiting_approval"


@pytest.mark.parametrize("damage", ["loose_mode", "corrupt", "unreadable"])
def test_damaged_pin_fails_closed(home, damage, capsys):
    rsm.pin_principal(BASE, 777, "Edu T. Or", first_signin=True)
    path = lane_state.STATE_PATH
    if damage == "loose_mode":
        os.chmod(path, 0o644)
    elif damage == "corrupt":
        with open(path, "w") as fh:
            fh.write("{not json")
        os.chmod(path, 0o600)
    else:
        os.chmod(path, 0o000)
    if damage == "unreadable" and os.geteuid() == 0:
        pytest.skip("root reads mode-000 files")
    with pytest.raises(rsm.PrincipalPinError):
        rsm.pinned_principal()
    op = _halt_with_op()
    assert rsm.verified_resume_after_manual_signin(777, "Edu T. Or") == -1
    assert rsm.check_write_allowed()[0] is False
    assert rsm.op_quarantine_status(op) == "quarantined"
    os.chmod(path, 0o600)


def test_resume_cli_verifies_live_principal(home, monkeypatch):
    rsm.pin_principal(BASE, 777, "Edu T. Or", first_signin=True)
    _halt_with_op()
    monkeypatch.setattr(rsm, "read_live_principal",
                        lambda base=None: (999, "Intruder", BASE))
    monkeypatch.setattr(sys, "argv", ["state_machine.py", "resume",
                                      "--principal-id", "777"])
    assert rsm.cmd_resume() is False
    assert rsm.check_write_allowed()[0] is False
    monkeypatch.setattr(rsm, "read_live_principal",
                        lambda base=None: (777, "Edu T. Or", BASE))
    monkeypatch.setattr(sys, "argv", ["state_machine.py", "resume"])
    assert rsm.cmd_resume() is True
    assert rsm.check_write_allowed()[0] is True


def test_pin_cli_first_signin_is_quiet_when_already_pinned(home,
                                                         monkeypatch):
    monkeypatch.setattr(rsm, "read_live_principal",
                        lambda base=None: (777, "Edu T. Or", BASE))
    monkeypatch.setattr(sys, "argv", ["state_machine.py", "pin",
                                      "--first-signin"])
    assert rsm.cmd_pin() is True
    assert rsm.cmd_pin() is True
    assert str(rsm.pinned_principal()["id"]) == "777"


def test_helper_ui_shows_pinned_name(home, monkeypatch):
    import importlib.util
    import config.paths as cp
    rsm.pin_principal(BASE, 777, "Edu T. Or", first_signin=True)
    profile = os.path.join(home, "profile")
    os.makedirs(profile)
    monkeypatch.setenv("LOGIN_HELPER_PROFILE_DIR", profile)
    monkeypatch.setattr(cp, "morrow_home", lambda: home)
    spec = importlib.util.spec_from_file_location(
        "helper_server_pin_test", os.path.join(_TREE, "helper", "server.py"))
    server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server)
    assert server._educator_principal_name() == "Edu T. Or"
