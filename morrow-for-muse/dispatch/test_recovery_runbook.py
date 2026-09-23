#!/usr/bin/env python3
"""The backup and restore runbook works as INSTALL.md writes it.

Failure modes this suite pins down (written before the fix; final sweep
2026-09-23):
  1. INSTALL.md and SKILL.md passed one folder to create, verify, and
     restore. create makes a morrow-backup-<time> folder inside it, so
     the documented verify and restore ended in a FileNotFoundError
     traceback, exactly when the operator needed them.
  2. The runbooks said to run `journal-reconcile` without --yes. The
     executor refuses that without a terminal, and the refusal reached
     the educator as the unknown failure ("the task might have made a
     change"), so the restored state stayed locked.
  3. A folder that holds no backup, or several, is named in a plain
     message, never a traceback, and restore never picks one of
     several by itself.

The commands run for real, in order, from the tree root, with no
terminal (as the agent runs them), against a scratch MORROW_HOME under
.selftest-work/ (never /tmp).
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLACEHOLDER_DIR = "/path/to/backup-dir"


def _read(rel):
    with open(os.path.join(TREE, rel), encoding="utf-8") as fh:
        return fh.read()


def _runbook_commands():
    """The shell commands of INSTALL.md's "Backup and restore" section,
    in order."""
    text = _read("INSTALL.md")
    start = text.index("### Backup and restore")
    end = text.index("\n### ", start + 1)
    blocks = re.findall(r"^```[^\n]*\n(.*?)^```", text[start:end],
                        re.MULTILINE | re.DOTALL)
    return [line.strip() for block in blocks
            for line in block.splitlines() if line.strip()]


@pytest.fixture
def scratch():
    work = os.path.join(TREE, ".selftest-work")
    os.makedirs(work, exist_ok=True)
    root = tempfile.mkdtemp(prefix="runbook-", dir=work)
    home = os.path.join(root, "home")
    os.makedirs(home)
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("MORROW_", "LOGIN_HELPER_"))}
    env.update({"HOME": home, "MORROW_HOME": os.path.join(home, ".morrow"),
                "MORROW_HELPER_ENV_FILE": os.path.join(root, "helper-env"),
                "PYTHONDONTWRITEBYTECODE": "1"})
    try:
        yield {"root": root, "env": env,
               "backups": os.path.join(root, "backups")}
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _run(scratch, command):
    argv = command.split()
    assert argv[0] == "python3", command
    return subprocess.run([sys.executable] + argv[1:], cwd=TREE,
                          env=scratch["env"], capture_output=True,
                          text=True, timeout=300, stdin=subprocess.DEVNULL)


def _backup(scratch, *args):
    return _run(scratch, "python3 -m dispatch.state_backup " + " ".join(args))


def _seed_journal(scratch):
    """One journaled operation, as any Morrow that has done work has."""
    proc = subprocess.run(
        [sys.executable, "-c",
         "from dispatch import executor as ex\n"
         "ex.journal_append({'wal': 'audit', 'event': 'runbook.test', "
         "'op_id': '00000000-0000-4000-8000-000000000001'})"],
        cwd=TREE, env=scratch["env"], capture_output=True, text=True,
        timeout=120)
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_the_documented_runbook_runs_in_order(scratch):
    _seed_journal(scratch)
    commands = _runbook_commands()
    assert [c.split()[3] for c in commands] == \
        ["create", "verify", "restore", "journal-reconcile"], commands
    printed = None
    for command in commands:
        command = command.replace(PLACEHOLDER_DIR, scratch["backups"])
        if printed:
            command = command.replace("morrow-backup-<time>", printed)
        proc = _run(scratch, command)
        out = proc.stdout + proc.stderr
        assert proc.returncode == 0, (command, out)
        assert "Traceback" not in out, (command, out)
        result = json.loads(proc.stdout.strip().splitlines()[-1])
        assert "mode_id" not in result, (command, out)
        if " create " in command:
            printed = os.path.basename(result["backup"])
            assert printed.startswith("morrow-backup-"), out
    assert result.get("reconciled") is True, out


def test_a_folder_with_one_backup_is_used(scratch):
    proc = _backup(scratch, "create", scratch["backups"])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    made = json.loads(proc.stdout)["backup"]
    proc = _backup(scratch, "verify", scratch["backups"])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert json.loads(proc.stdout)["verified"] is True
    assert made in proc.stderr, proc.stderr


def test_a_folder_with_several_backups_is_refused_by_name(scratch):
    os.makedirs(scratch["backups"])
    names = []
    for stamp in ("20260101T000000Z", "20260102T000000Z"):
        path = os.path.join(scratch["backups"], "morrow-backup-" + stamp)
        os.makedirs(path)
        with open(os.path.join(path, "manifest.json"), "w") as fh:
            fh.write("{}\n")
        names.append(path)
    for args in (("verify", scratch["backups"]),
                 ("restore", scratch["backups"], "--yes")):
        proc = _backup(scratch, *args)
        out = proc.stdout + proc.stderr
        assert proc.returncode != 0, out
        assert "Traceback" not in out, out
        for path in names:
            assert path in out, out
    assert not os.path.exists(os.path.join(
        scratch["env"]["MORROW_HOME"], "trees")), "restore changed state"


def test_a_folder_with_no_backup_is_named_plainly(scratch):
    os.makedirs(scratch["backups"])
    for args in (("verify", scratch["backups"]),
                 ("restore", scratch["backups"], "--yes")):
        proc = _backup(scratch, *args)
        out = proc.stdout + proc.stderr
        assert proc.returncode != 0, out
        assert "Traceback" not in out, out
        assert scratch["backups"] in out, out
        assert "create" in out, out


def test_reconcile_without_yes_says_nothing_ran_and_names_the_flag(scratch):
    proc = _run(scratch, "python3 -m dispatch.executor journal-reconcile")
    assert proc.returncode != 0
    result = json.loads(proc.stderr.strip().splitlines()[-1])
    assert result["mode_id"] == "maintenance-confirmation-required", result
    message = result["message"]
    assert "--yes" in message, message
    assert "nothing ran" in message.lower(), message
    assert "might have made a change" not in message, message
    assert result["engineering_detail"].startswith("[Morrow input check]")


CONFIRM_COMMANDS = ("journal-seal", "journal-repair", "journal-reconcile",
                    "journal-recover-secret", "retired-seal",
                    "claim-release")


def test_the_commands_that_need_yes_are_the_ones_the_docs_check():
    from dispatch import executor as ex
    parser = ex.build_parser()
    sub = next(a for a in parser._actions
               if a.__class__.__name__ == "_SubParsersAction")
    with_yes = sorted(name for name, p in sub.choices.items()
                      if any("--yes" in a.option_strings
                             for a in p._actions))
    assert with_yes == sorted(CONFIRM_COMMANDS)


def _doc_paths():
    for root, dirs, files in os.walk(TREE):
        dirs[:] = [d for d in dirs if not d.startswith(".")
                   and d not in ("audit", "__pycache__")]
        for name in files:
            if name.endswith(".md") and name != "CHANGELOG.md":
                yield os.path.join(root, name)


def test_every_documented_confirm_command_passes_yes():
    missing = []
    pattern = re.compile(r"(?<![\w-])(%s)(?![\w-])"
                         % "|".join(map(re.escape, CONFIRM_COMMANDS)))
    for path in _doc_paths():
        text = open(path, encoding="utf-8").read()
        # Inline code spans and fenced commands, continuations joined.
        spans = re.findall(r"```[^\n]*\n(.*?)```", text, re.DOTALL)
        spans = [line for block in spans
                 for line in block.replace("\\\n", " ").splitlines()]
        prose = re.sub(r"```[^\n]*\n.*?```", "", text, flags=re.DOTALL)
        spans += re.findall(r"`([^`]+)`", prose)
        for span in spans:
            if pattern.search(span) and "--yes" not in span:
                missing.append("%s: %s" % (os.path.relpath(path, TREE),
                                           " ".join(span.split())))
    assert missing == []
