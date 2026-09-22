#!/usr/bin/env python3
"""One user-id contract for modes and settings.

Failure modes this suite pins down (written before the fix; re-audit
2026-09-22, probe reaudit/uid_probe.py):
  1. modes accepted [A-Za-z0-9_.:@-]{1,160} while settings accepted
     [A-Za-z0-9][A-Za-z0-9_.-]{0,63}, so a real Muse id such as
     "muse:educator@school.edu" could hold an edit grant that settings
     then refused to turn off.
  2. switch_mode revoked the grants first and only then raised
     SettingsError, before anything was journaled: a half-applied
     "turn off edit mode".
  3. Both layers must accept exactly the same ids, and refuse path
     tricks the same way.

Scratch lives under .selftest-work/ (never /tmp).
"""

import os
import shutil
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
if TREE not in sys.path:
    sys.path.insert(0, TREE)

from modes import state as ms  # noqa: E402
from settings import commands, store  # noqa: E402


@pytest.fixture(autouse=True)
def scratch_home():
    root = os.path.join(HERE, ".selftest-work", "uid-%d" % os.getpid())
    shutil.rmtree(root, ignore_errors=True)
    os.makedirs(root)
    old = os.environ.get("MORROW_HOME")
    old_state = os.environ.get("MORROW_TREE_STATE_DIR")
    os.environ["MORROW_HOME"] = root
    os.environ["MORROW_TREE_STATE_DIR"] = os.path.join(root, "tree-state")
    import dispatch.admission as adm
    saved = (adm.SECRETS_DIR, adm.SIGNING_KEY_PATH)
    adm.SECRETS_DIR = os.path.join(root, "secrets")
    adm.SIGNING_KEY_PATH = os.path.join(root, "secrets",
                                        "approval-signing.key")
    try:
        yield root
    finally:
        adm.SECRETS_DIR, adm.SIGNING_KEY_PATH = saved
        for key, value in (("MORROW_HOME", old),
                           ("MORROW_TREE_STATE_DIR", old_state)):
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        shutil.rmtree(root, ignore_errors=True)


IDS = ["muse:educator@school.edu", "educator-1", "a", "A.b_c-d",
       "x" * 160, "x" * 161, "", "../evil", "..", ".", "-lead", "_lead",
       "sp ace", "semi;colon", "slash/inside", "back\\slash", "tab\tx",
       "new\nline", "trailing\n", "\u00e9ducateur", ":lead", "@lead"]


def _accepts(fn, uid):
    try:
        fn(uid)
        return True
    except Exception:
        return False


@pytest.mark.parametrize("uid", IDS)
def test_modes_and_settings_accept_the_same_ids(uid):
    in_modes = _accepts(ms.current_mode, uid)
    in_settings = _accepts(lambda u: store.get_setting(u, "default_mode"),
                           uid)
    assert in_modes == in_settings, (uid, in_modes, in_settings)


def test_real_muse_id_can_turn_edit_off():
    uid = "muse:educator@school.edu"
    ms.request_edit_grant(uid, "conversation", {
        "by": "educator", "channel": "educator-chat",
        "authorization": "yes use edit mode for this conversation please"},
        conversation_id="c1")
    store.set_setting(uid, "default_mode", "edit", educator_confirmed=True)
    assert ms.current_mode(uid, "c1") == "edit"
    op, _ = commands.parse_command("turn off edit mode", uid, "c1")
    reply = commands.apply_command(op, uid, "c1")
    assert "plan mode" in reply
    assert ms.current_mode(uid, "c1") == "plan"
    assert ms.current_mode(uid) == "plan"
    assert store.get_setting(uid, "default_mode") == "plan"


def test_switch_mode_validates_before_it_mutates():
    good = "educator-valid"
    ms.request_edit_grant(good, "conversation", {
        "by": "educator", "channel": "educator-chat",
        "authorization": "yes use edit mode for this conversation please"},
        conversation_id="c1")
    for bad in ("../evil", "", "sp ace", "x" * 161):
        with pytest.raises(ValueError):
            ms.switch_mode(bad, "plan")
    # Nothing for the valid user was touched by the refused calls.
    assert ms.current_mode(good, "c1") == "edit"
