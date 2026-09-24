#!/usr/bin/env python3
"""The educator's user id has a source: the Canvas account they signed
in with.

Failure modes this suite pins down (written before the fix; final sweep
2026-09-23):
  1. Plan/Edit mode, conversation overrides, settings, and the name echo
     are keyed on a user id that only --user-id or MORROW_USER_ID
     supplied, and nothing set either one: no installer step, no website
     step, and no Muse harness (modes/README.md said one existed).
     `morrow mode set edit` answered "No user id: pass --user-id or set
     MORROW_USER_ID.", so the agent had to make an id up. A different
     made-up id in the next conversation silently turned Edit off.
  2. With neither given, every command now uses the Canvas account
     pinned at first sign-in ("canvas:<account id>@<Canvas host>"): the
     mode and settings commands, the executor's write gate, and the
     failed-students query's time zone setting. So Edit set with
     `morrow mode set edit` is the Edit the executor's gate sees.
  3. --user-id and MORROW_USER_ID still win.
  4. Before any account is pinned, or when the pin record cannot be
     trusted, there is no user id: the settings commands refuse in plain
     words and change nothing, and the write gate is plan.
  5. SKILL.md tells the agent where the conversation id comes from (a
     new one for each conversation, never reused), and no doc claims a
     harness supplies either id.
  6. Every command SKILL.md sends the conversation id to takes it as
     --conversation-id. `morrow query` read it only from
     MORROW_CONVERSATION_ID, so a student the educator named in the
     conversation was never shown by that name in its result.

Scratch lives in pytest's tmp_path.
"""

import argparse
import json
import os
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
for _p in (TREE, os.path.join(TREE, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from config import identity  # noqa: E402
from dispatch import executor as ex  # noqa: E402
from reauth import state_machine as rsm  # noqa: E402
from transport import state as lane_state  # noqa: E402

BASE = "https://myschool.instructure.com"
PINNED = "canvas:28206@myschool.instructure.com"


@pytest.fixture
def home(tmp_path, monkeypatch):
    root = tmp_path / "morrow"
    root.mkdir(mode=0o700)
    monkeypatch.setenv("MORROW_HOME", str(root))
    monkeypatch.setenv("MORROW_TREE_STATE_DIR", str(root / "tree"))
    monkeypatch.delenv("MORROW_USER_ID", raising=False)
    monkeypatch.delenv("MORROW_CONVERSATION_ID", raising=False)
    lane_path = str(root / "browser_lane.json")
    monkeypatch.setattr(lane_state, "STATE_PATH", lane_path)
    bare = sys.modules.get("state")
    if bare is not None and hasattr(bare, "STATE_PATH"):
        monkeypatch.setattr(bare, "STATE_PATH", lane_path)
    monkeypatch.setattr(rsm, "SESSION_PATH", str(root / "session.json"))
    yield root


def _pin(base=BASE, principal_id=28206):
    lane_state.save(base, principal_id, "Ada Teacher")


def _morrow(home, *argv, user_id=None):
    env = dict(os.environ, MORROW_HOME=str(home),
               PYTHONDONTWRITEBYTECODE="1")
    env.pop("MORROW_USER_ID", None)
    if user_id is not None:
        env["MORROW_USER_ID"] = user_id
    proc = subprocess.run(
        [sys.executable, os.path.join(TREE, "bin", "morrow")] + list(argv),
        capture_output=True, text=True, env=env, timeout=120)
    return proc.returncode, json.loads(proc.stdout.strip().splitlines()[-1])


_GATE_PROBE = """
import argparse, json, sys
sys.path.insert(0, %r)
from dispatch import executor as ex
from modes import state as mode_state
ctx = ex._mode_ctx_from_args(argparse.Namespace(
    user_id=None, conversation_id="conv-1", course_resolution=None,
    destructive_confirmed=None))
print(json.dumps([ctx, mode_state.current_mode(ctx["user_id"], "conv-1")]))
""" % TREE


def _write_gate(home):
    """The executor's mode context and the mode it resolves, in a process
    that shares this Morrow home (the settings seal key lives there)."""
    env = dict(os.environ, MORROW_HOME=str(home),
               PYTHONDONTWRITEBYTECODE="1")
    env.pop("MORROW_USER_ID", None)
    proc = subprocess.run([sys.executable, "-c", _GATE_PROBE],
                          capture_output=True, text=True, env=env,
                          timeout=120)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout.strip().splitlines()[-1])


def _gate_args(**kw):
    return argparse.Namespace(user_id=kw.get("user_id"),
                              conversation_id=kw.get("conversation_id"),
                              course_resolution=None,
                              destructive_confirmed=None)


# -- 2 and 3 ------------------------------------------------------------------

def test_the_pinned_account_is_the_default_user_id(home):
    assert identity.default_user_id() is None
    _pin()
    assert identity.default_user_id() == PINNED


def test_an_explicit_user_id_still_wins(home, monkeypatch):
    _pin()
    monkeypatch.setenv("MORROW_USER_ID", "muse:ada@school.edu")
    assert identity.default_user_id() == "muse:ada@school.edu"
    assert ex._mode_ctx_from_args(_gate_args())["user_id"] \
        == "muse:ada@school.edu"
    assert ex._mode_ctx_from_args(_gate_args(user_id="u-flag"))[
        "user_id"] == "u-flag"


def test_edit_set_without_an_id_is_the_edit_the_write_gate_sees(home):
    _pin()
    code, out = _morrow(home, "mode", "set", "edit")
    assert (code, out["status"], out["mode"]) == (0, "done", "edit"), out
    code, out = _morrow(home, "mode", "status")
    assert (code, out["mode"]) == (0, "edit"), out
    ctx, mode = _write_gate(home)
    assert ctx == {"user_id": PINNED, "conversation_id": "conv-1"}
    assert mode == "edit"
    code, out = _morrow(home, "mode", "set", "plan")
    assert out["mode"] == "plan", out
    assert _write_gate(home)[1] == "plan"


def test_the_time_zone_setting_is_read_for_the_pinned_account(home):
    from query import chain
    from settings import store
    _pin()
    store.set_setting(PINNED, "timezone", "America/Chicago",
                      educator_confirmed=True)

    def never(path):
        raise AssertionError("the saved setting must be used first")
    _zone, name, _source = chain.educator_zone(None, never, "101")
    assert name == "America/Chicago"


# -- 4 ------------------------------------------------------------------------

def test_before_sign_in_nothing_changes_and_the_gate_is_plan(home):
    code, out = _morrow(home, "mode", "set", "edit")
    assert code == 2 and out["ok"] is False, out
    assert out["mode"] == "plan"
    message = out["message"]
    assert "Nothing changed" in message and "sign in" in message.lower()
    assert "MORROW_USER_ID" not in message and "--user-id" not in message
    assert ex._mode_ctx_from_args(_gate_args()) is None


def test_an_untrusted_pin_record_gives_no_user_id(home):
    _pin()
    os.chmod(lane_state.STATE_PATH, 0o644)
    assert identity.default_user_id() is None
    assert ex._mode_ctx_from_args(_gate_args()) is None


# -- 5 ------------------------------------------------------------------------

def _read(*parts):
    with open(os.path.join(TREE, *parts), encoding="utf-8") as fh:
        return fh.read()


def test_the_docs_say_where_each_id_comes_from():
    skill = " ".join(_read("SKILL.md").split())
    assert "new conversation id" in skill
    assert "Never reuse a conversation id" in skill
    assert "signed-in Canvas account" in skill
    for doc in (("SKILL.md",), ("modes", "README.md"),
                ("settings", "README.md")):
        text = " ".join(_read(*doc).split())
        assert "harness supplies" not in text, doc


# -- 6 ------------------------------------------------------------------------

def test_every_command_takes_the_conversation_id():
    from learners import find
    from query import chain
    from settings import commands
    conv = ["--conversation-id", "conv-1"]
    for argv in (["catalog", "--name", "n", "--method", "GET", "--path",
                  "/x"], ["plan-write", "--name", "n", "--method", "PUT",
                          "--path", "/x"],
                 ["approve-write", "--op-id", "x", "--authorization", "Y"]):
        assert ex.build_parser().parse_args(argv + conv) \
            .conversation_id == "conv-1"
    for argv in (["mode", "status"], ["mode", "set", "edit"],
                 ["settings", "show"], ["settings", "get", "timezone"],
                 ["settings", "set", "timezone", "UTC"]):
        assert commands._parser().parse_args(argv + conv) \
            .conversation_id == "conv-1"
    seen = {}
    real_find = find.find_student

    def fake_find(fetcher, tenant_base, course_id, query, **kw):
        seen["find"] = kw.get("conversation_id")
        return {"ok": True, "status": "not_found", "message": "none"}
    find.find_student = fake_find
    try:
        find.main(["--course", "101", "--canvas-base", BASE, "Jane"] + conv,
                  fetcher=lambda url: (200, {}, "[]"))
    finally:
        find.find_student = real_find
    assert seen["find"] == "conv-1"

    def fake_query(*args, **kw):
        seen["query"] = kw.get("conversation_id")
        raise SystemExit(0)
    real_query = chain.run_query
    chain.run_query = fake_query
    try:
        with pytest.raises(SystemExit):
            chain.main(["--course", "101", "--quiz", "last-week"] + conv)
    finally:
        chain.run_query = real_query
    assert seen["query"] == "conv-1"


def test_the_query_echoes_names_typed_in_its_conversation(monkeypatch):
    from query import chain
    from query import test_chain_course_text as fixture
    seen = []
    monkeypatch.setattr(chain, "_require_live_proven", lambda *a: None)
    monkeypatch.setattr(chain._present, "project_live",
                        lambda course_id, rows, tenant_base,
                        conversation_id=None: seen.append(conversation_id)
                        or [])

    class Reader(fixture._Reader):
        def get_paginated(self, path):
            if "/submissions" in path:
                self.paths.append(path)
                return 200, [{"user_id": 98765, "score": 1,
                              "workflow_state": "graded",
                              "user": {"name": "Jane Doe"}}], None
            return super().get_paginated(path)
    chain.run_query("89585", "last_week", reader=Reader(),
                    now_utc=fixture.NOW, tenant_base=fixture.TENANT,
                    timezone="America/Chicago", conversation_id="conv-1")
    assert seen == ["conv-1"]

