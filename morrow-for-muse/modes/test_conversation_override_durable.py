#!/usr/bin/env python3
"""Per-conversation mode overrides must reach dispatch in a new process.

Every dispatch is a new CLI process, so an override held only in one
process's memory never reaches the write gate. Failure modes this suite
pins down (written before the fix; re-audit 2026-09-22, probes
reaudit/override_a.py + override_b.py):
  1. default_mode=edit, then "use plan mode for this conversation": the
     reply said plan, but the next process admitted writes with no
     approval (edit).
  2. "use edit mode for this conversation" never took effect in the
     next process.
  3. An edit override must not outlive what the educator granted:
     "turn off edit mode" (anywhere) and the conversation ending both
     end it, in every later process.
  4. A tampered override store fails closed to plan, never to edit.
  5. Every override change is journaled in the settings audit, and the
     audit chain still verifies.

Each step runs in a fresh interpreter, exactly like a dispatch.
Scratch lives under .selftest-work/ (never /tmp); MORROW_HOME and the
tree state dir point there, so the real ~/.morrow is never touched.
"""

import json
import os
import shutil
import subprocess
import sys
import textwrap

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)

USER = "muse:educator@school.edu"
CONV = "conv-durable-1"
OTHER = "conv-durable-2"

PRELUDE = textwrap.dedent("""
    import json, sys
    sys.path.insert(0, %r)
    from settings import commands, store
    from modes import state as ms
    from modes import errors as me
    from dispatch.admission import check_mode_authority
    USER, CONV, OTHER = %r, %r, %r
    ENTRY = {"name": "canvas_create_page", "effects": "write",
             "provider": "canvas",
             "request": {"method": "POST",
                         "url": "{canvas_base}/api/v1/courses/{course_id}/pages"}}

    def say(text, conv=CONV, confirmed=False):
        op, _ = commands.parse_command(text, USER, conv)
        return commands.apply_command(op, USER, conv,
                                      educator_confirmed=confirmed)

    def gate(conv):
        try:
            audit, _ = check_mode_authority(
                ENTRY, {"course_id": "1"}, None,
                {"user_id": USER, "conversation_id": conv})
            return "admitted-" + str(audit.get("mode"))
        except me.PlanModeWriteWithoutApproval:
            return "needs-approval"
""") % (TREE, USER, CONV, OTHER)


@pytest.fixture
def home():
    root = os.path.join(HERE, ".selftest-work", "durable-%d" % os.getpid())
    shutil.rmtree(root, ignore_errors=True)
    os.makedirs(root)
    try:
        yield root
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _run(home, body):
    env = dict(os.environ)
    env["MORROW_HOME"] = home
    env["HOME"] = home
    env["MORROW_TREE_STATE_DIR"] = os.path.join(home, "tree-state")
    env.pop("MORROW_APPROVAL_SIGNING_KEY", None)
    proc = subprocess.run([sys.executable, "-c", PRELUDE + body],
                          capture_output=True, text=True, env=env,
                          cwd=TREE, timeout=120)
    assert proc.returncode == 0, proc.stderr
    return proc.stdout.strip().splitlines()[-1]


def test_plan_override_reaches_the_next_process(home):
    _run(home, "say('use edit mode', confirmed=True); print('ok')")
    _run(home, "print(say('use plan mode for this conversation'))")
    out = _run(home, "print(json.dumps([ms.current_mode(USER, CONV), "
                     "gate(CONV), gate(OTHER)]))")
    assert json.loads(out) == ["plan", "needs-approval", "admitted-edit"]


def test_edit_override_reaches_the_next_process(home):
    _run(home, "print(say('use edit mode for this conversation', "
               "confirmed=True))")
    out = _run(home, "print(json.dumps([ms.current_mode(USER, CONV), "
                     "gate(CONV), gate(OTHER)]))")
    assert json.loads(out) == ["edit", "admitted-edit", "needs-approval"]


def test_edit_override_ends_when_edit_is_turned_off(home):
    _run(home, "say('use edit mode for this conversation', confirmed=True);"
               "print('ok')")
    _run(home, "print(say('turn off edit mode', conv=OTHER))")
    out = _run(home, "print(json.dumps([ms.current_mode(USER, CONV), "
                     "gate(CONV)]))")
    assert json.loads(out) == ["plan", "needs-approval"]


def test_edit_override_ends_with_the_conversation(home):
    _run(home, "say('use edit mode for this conversation', confirmed=True);"
               "print('ok')")
    _run(home, "store.end_conversation(USER, CONV); print('ok')")
    out = _run(home, "print(json.dumps([ms.current_mode(USER, CONV), "
                     "gate(CONV), store.get_conversation_mode(USER, CONV)]))")
    assert json.loads(out) == ["plan", "needs-approval", None]


def test_plan_override_survives_later_edit_default_elsewhere(home):
    _run(home, "say('use plan mode for this conversation'); print('ok')")
    _run(home, "say('use edit mode', conv=OTHER, confirmed=True); "
               "print('ok')")
    out = _run(home, "print(json.dumps([gate(CONV), gate(OTHER)]))")
    assert json.loads(out) == ["needs-approval", "admitted-edit"]


def test_tampered_override_store_fails_closed_to_plan(home):
    _run(home, "say('use plan mode for this conversation'); print('ok')")
    settings_dir = os.path.join(home, "settings")
    [name] = [n for n in os.listdir(settings_dir) if n.endswith(".json")]
    path = os.path.join(settings_dir, name)
    with open(path) as fh:
        doc = json.load(fh)
    blob = json.dumps(doc)
    assert CONV in blob and '"plan"' in blob
    doc = json.loads(blob.replace('"plan"', '"edit"'))
    with open(path, "w") as fh:
        json.dump(doc, fh)
    out = _run(home, "print(json.dumps([ms.current_mode(USER, CONV), "
                     "gate(CONV)]))")
    assert json.loads(out) == ["plan", "needs-approval"]


def test_override_store_is_private_and_journaled(home):
    _run(home, "say('use edit mode for this conversation', confirmed=True);"
               "print('ok')")
    _run(home, "say('use plan mode for this conversation'); print('ok')")
    _run(home, "store.end_conversation(USER, CONV); print('ok')")
    out = _run(home, "print(json.dumps([r['kind'] for r in "
                     "store.read_audit(USER)] + [store.verify_audit(USER)]))")
    kinds = json.loads(out)
    assert kinds[:-1] == ["settings.conversation_mode",
                          "settings.conversation_mode",
                          "settings.conversation_ended"]
    assert kinds[-1] == 3
    settings_dir = os.path.join(home, "settings")
    for name in os.listdir(settings_dir):
        if name.endswith((".json", ".jsonl")):
            mode = os.stat(os.path.join(settings_dir, name)).st_mode & 0o777
            assert mode == 0o600, (name, oct(mode))
