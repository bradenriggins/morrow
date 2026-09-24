#!/usr/bin/env python3
"""Every executor command the docs show parses with the real CLI.

Failure modes this suite pins down (written before the fix; final sweep
2026-09-23):
  1. SKILL.md (the read, plan-write, and approve-write examples),
     INSTALL.md step 6, the troubleshooting playbook, and the operations
     runbook put `--canvas-base "$CANVAS_BASE"` after the subcommand.
     The flag existed only on the top-level parser, so every one of
     those commands exited 2 ("unrecognized arguments") before anything
     was read, prepared, or approved, and no test ran a documented
     command, so the docs and the CLI drifted apart unseen.
  2. --canvas-base is accepted in both places: before the subcommand
     and after it.
  3. With --canvas-base (or --session) before the subcommand, the error
     funnel took the URL for the subcommand, so every refusal told the
     educator "What was attempted: a Morrow maintenance step".

Parse only: nothing here reads Canvas or writes state.
"""

import os
import re
import shlex
import sys

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (TREE, os.path.join(TREE, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from dispatch import executor as ex  # noqa: E402

EXECUTOR = "dispatch/executor.py"
# Dated records keep the commands of their day; audits quote old trees.
SKIP_DOCS = {"CHANGELOG.md"}
SKIP_DIRS = {"audit", ".selftest-work", "__pycache__"}
_FENCE = re.compile(r"^(```|~~~)")
_PLACEHOLDER = re.compile(r"<[^<>\n]+>")
_ENV_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")


def _docs():
    for root, dirs, files in os.walk(TREE):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS
                         and not d.startswith("."))
        for name in sorted(files):
            if name.endswith(".md") and name not in SKIP_DOCS:
                yield os.path.join(root, name)


def _fenced_lines(text):
    inside = False
    for line in text.splitlines():
        if _FENCE.match(line.strip()):
            inside = not inside
            continue
        if inside:
            yield line


def _commands(lines):
    """Shell commands in a code block, with backslash continuations
    joined."""
    joined, parts = [], []
    for line in lines:
        stripped = line.rstrip()
        if stripped.endswith("\\"):
            parts.append(stripped[:-1])
            continue
        parts.append(stripped)
        joined.append(" ".join(p.strip() for p in parts))
        parts = []
    if parts:
        joined.append(" ".join(p.strip() for p in parts))
    return joined


def _executor_argv(command):
    """The executor's own argv from one documented shell command, or
    None when the command does not run the executor."""
    if EXECUTOR not in command:
        return None
    command = command.split(" #", 1)[0]
    # A placeholder such as <op_id from plan-write> stands for one value.
    tokens = shlex.split(_PLACEHOLDER.sub("PLACEHOLDER", command))
    for index, token in enumerate(tokens):
        if token.endswith(EXECUTOR):
            before = [t for t in tokens[:index] if not _ENV_ASSIGN.match(t)]
            if before and before[-1].startswith("python"):
                return tokens[index + 1:]
            return None
    return None


def _documented():
    found = []
    for path in _docs():
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        for command in _commands(_fenced_lines(text)):
            argv = _executor_argv(command)
            if argv is not None:
                found.append((os.path.relpath(path, TREE), argv))
    return found


DOCUMENTED = _documented()


def _parse(argv):
    return ex.build_parser().parse_args(argv)


def test_the_docs_show_the_commands_the_agent_runs():
    # The extractor must find the commands this suite exists for; an
    # empty list would pass every check below.
    where = {doc for doc, _argv in DOCUMENTED}
    assert {"SKILL.md", "INSTALL.md",
            os.path.join("knowledge", "troubleshooting-playbook.md"),
            os.path.join("knowledge", "operations-runbook.md")} <= where
    subcommands = {argv[0] for _doc, argv in DOCUMENTED if argv}
    assert {"catalog", "plan-write", "approve-write"} <= subcommands


@pytest.mark.parametrize("doc,argv", DOCUMENTED,
                         ids=["%s:%s" % (doc, argv[0] if argv else "")
                              for doc, argv in DOCUMENTED])
def test_every_documented_executor_command_parses(doc, argv, capsys):
    try:
        _parse(argv)
    except SystemExit as exc:
        pytest.fail("%s shows a command the executor refuses (exit %s): "
                    "%s\n%s" % (doc, exc.code, " ".join(argv),
                                capsys.readouterr().err))


def test_install_sh_operator_check_parses():
    with open(os.path.join(TREE, "install.sh"), encoding="utf-8") as fh:
        text = fh.read()
    shown = re.findall(r"python3 dispatch/executor\.py ([^\"\n]+)", text)
    assert shown, "install.sh no longer prints the operator check"
    for tail in shown:
        _parse(shlex.split(tail))


@pytest.mark.parametrize("command", ["catalog", "plan-write",
                                     "approve-write", "execute", "undo"])
def test_canvas_base_parses_before_and_after_the_subcommand(command):
    rest = {
        "catalog": ["--name", "users_self", "--method", "GET", "--path",
                    "/api/v1/users/self", "--class", "read"],
        "plan-write": ["--name", "n", "--method", "PUT", "--path", "/x"],
        "approve-write": ["--op-id", "x", "--authorization", "Yes"],
        "execute": ["--entry", "e.json"],
        "undo": ["--entry", "e.json", "--of-op-id", "x"],
    }[command]
    url = "https://myschool.instructure.com"
    after = _parse([command] + rest + ["--canvas-base", url])
    before = _parse(["--canvas-base", url, command] + rest)
    neither = _parse([command] + rest)
    assert after.canvas_base == url
    assert before.canvas_base == url
    assert neither.canvas_base is None
    both = _parse(["--canvas-base", "https://a.example.edu", command]
                  + rest + ["--canvas-base", url])
    assert both.canvas_base == url


@pytest.mark.parametrize("argv", [
    ["--canvas-base", "https://myschool.instructure.com", "catalog"],
    ["--canvas-base=https://myschool.instructure.com", "catalog"],
    ["--session", "/tmp/session.json", "catalog"],
    ["catalog", "--canvas-base", "https://myschool.instructure.com"],
])
def test_the_error_funnel_finds_the_subcommand_after_top_level_options(
        argv):
    argv = argv + ["--name", "canvas_get_course_settings", "--method",
                   "GET", "--path", "/api/v1/courses/{course_id}/settings",
                   "--params", '{"course_id": 101}']
    label = ex._funnel_operation(argv)
    assert "maintenance" not in label
    assert "course 101" in label, label
