#!/usr/bin/env python3
"""End to end: the executor CLI, started the documented ways, runs one
copy of itself.

Scenario (final sweep round 2, 2026-09-23, finding
muse-ux-r2-executor-dual-module): the educator approves a page change,
and Canvas refuses it, fails with a server error, or the Canvas session
ends while the change is on its way. The agent starts the executor as
SKILL.md says: `python3 dispatch/executor.py`, `bin/morrow dispatch`,
or `python3 -m dispatch.executor`. In each form the file ran as
__main__, and the Chromium lane imported a second copy as
dispatch.executor. Every error the lane raised came from that second
copy, so none of the executor's own handlers matched. Every in-process
test calls main() on one copy, so no test saw it.

Failure modes this suite pins down (written before the fix):
  1. A write Canvas refuses (HTTP 422) told the educator "the task might
     have made a change" and kept the op's claim pending for good. It
     must say Canvas refused it and nothing changed, and release the
     claim, in all three documented forms.
  2. A write that fails with HTTP 500 left only the pending claim. The
     journal must hold the op's uncertain outcome.
  3. A session that ends during the write left the op unpaused, and the
     notice said "No change was in progress". The op must be paused
     (quarantined) and the notice must not say nothing was in progress.

Only the browser transport is replaced (a sitecustomize on PYTHONPATH
wraps the Chromium lane's session with a scripted Canvas). The command
line is exactly the documented one. The run writes a repeatable
artifact to .selftest-work/cli-one-module-e2e-artifact.json.
"""

import glob
import json
import os
import subprocess
import sys
import textwrap

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARTIFACT = os.path.join(TREE, ".selftest-work",
                        "cli-one-module-e2e-artifact.json")
BASE = "https://canvas.example.edu"
COURSE = "89585"
CONV = "cli-one-module-conv"
ENTRY_FORMS = {
    "script": [os.path.join("dispatch", "executor.py")],
    "morrow": [os.path.join("bin", "morrow"), "dispatch"],
    "module": ["-m", "dispatch.executor"],
}
MAYBE_APPLIED = "might have made a change"

FAKE_CANVAS = textwrap.dedent('''
    """Test-only: replace the Chromium lane's browser transport with a
    scripted Canvas. Nothing else in the run changes."""
    import importlib.abc
    import importlib.machinery
    import json
    import os
    import sys
    import urllib.parse

    ROSTER = [{"id": 7001, "name": "Jane Doe", "sortable_name": "Doe, Jane",
               "short_name": "Jane Doe", "login_id": "jdoe",
               "enrollments": [{"type": "StudentEnrollment",
                                "enrollment_state": "active"}]}]
    PAGE = {"page_id": 11, "url": "week-1", "title": "Week 1",
            "body": "<p>Hello</p>", "published": True}


    class FakeTransport:
        def api(self, method, path, data=None, _tab=None, timeout=60,
                as_json=False, max_bytes=None):
            method = method.upper()
            with open(os.environ["FAKE_CANVAS_LOG"], "a") as fh:
                fh.write(json.dumps([method, path]) + "\\n")
            if method != "GET" and os.environ.get("FAKE_DEAD_ON_WRITE"):
                raise sys.modules["local_chromium"].SessionDead(
                    "fake: Canvas answered 401 unauthenticated")
            status = os.environ.get("FAKE_WRITE_STATUS")
            if method != "GET" and status:
                return int(status), {}, json.dumps(
                    {"errors": [{"message": "refused"}]})
            route = urllib.parse.urlsplit(path).path.rstrip("/")
            if route == "/api/v1/users/self":
                return 200, {}, json.dumps({"id": 4242,
                                            "name": "Pat Teacher"})
            if route == "/api/v1/courses/%(course)s":
                return 200, {}, json.dumps({"id": %(course)s,
                                            "name": "Biology 101"})
            if route.endswith("/users"):
                return 200, {}, json.dumps(ROSTER)
            if route.endswith("/enrollments"):
                return 200, {}, "[]"
            if route.endswith("/pages/week-1"):
                page = dict(PAGE)
                if method == "PUT":
                    page.update((data or {}).get("wiki_page") or {})
                return 200, {}, json.dumps(page)
            return 404, {}, json.dumps({"errors": [{"message": "no route"}]})


    def _patch(module):
        original = module.ChromiumSession.__init__

        def __init__(self, base_url, launcher=None, transport=None):
            original(self, base_url, launcher=launcher,
                     transport=transport or FakeTransport())
        module.ChromiumSession.__init__ = __init__


    class _Finder(importlib.abc.MetaPathFinder):
        def find_spec(self, name, path, target=None):
            if name not in ("chromium_session", "transport.chromium_session"):
                return None
            spec = importlib.machinery.PathFinder.find_spec(name, path)
            if spec is None:
                return None
            run = spec.loader.exec_module

            def exec_module(module):
                run(module)
                _patch(module)
            spec.loader.exec_module = exec_module
            return spec


    if os.environ.get("FAKE_CANVAS_LOG"):
        sys.meta_path.insert(0, _Finder())
''') % {"course": COURSE}

_ARTIFACT_ROWS = []


@pytest.fixture
def world(tmp_path):
    """A scratch home with the educator's Canvas account pinned, and the
    fake Canvas on PYTHONPATH."""
    hook = tmp_path / "hook"
    hook.mkdir()
    (hook / "sitecustomize.py").write_text(FAKE_CANVAS)
    helper_env = tmp_path / "helper-env"
    helper_env.write_text("")
    env = dict(os.environ, HOME=str(tmp_path),
               MORROW_HOME=str(tmp_path / ".morrow"),
               MORROW_HELPER_ENV_FILE=str(helper_env),
               CANVAS_BASE=BASE, PYTHONDONTWRITEBYTECODE="1",
               FAKE_CANVAS_LOG=str(tmp_path / "canvas.log"),
               PYTHONPATH=os.pathsep.join(
                   [str(hook)] + [p for p in [os.environ.get("PYTHONPATH")]
                                  if p]))
    for name in ("MORROW_TREE_STATE_DIR", "FAKE_WRITE_STATUS",
                 "FAKE_DEAD_ON_WRITE"):
        env.pop(name, None)
    pin = subprocess.run(
        [sys.executable, "-c",
         "from transport import state; state.save(%r, 4242, 'Pat Teacher')"
         % BASE], cwd=TREE, env=env, capture_output=True, text=True,
        timeout=60)
    assert pin.returncode == 0, pin.stderr
    return {"env": env, "home": tmp_path}


def _run(world, argv, extra_env=None, form="script"):
    env = dict(world["env"], **(extra_env or {}))
    return subprocess.run([sys.executable] + ENTRY_FORMS[form] + argv,
                          cwd=TREE, env=env, capture_output=True, text=True,
                          timeout=120)


def _payload(proc):
    lines = [ln for ln in proc.stderr.splitlines() if ln.startswith("{")]
    assert lines, proc.stderr[-2000:]
    return json.loads(lines[-1])


def _approve_page_change(world, form="script", **write_env):
    planned = _run(world, [
        "plan-write", "--name", "canvas_update_create_page_courses",
        "--method", "PUT",
        "--path", "/api/v1/courses/{course_id}/pages/{url_or_id}",
        "--params", json.dumps({"course_id": COURSE, "url_or_id": "week-1"}),
        "--body", json.dumps({"wiki_page": {"title": "Week 1 revised"}}),
        "--backend", "chromium", "--conversation-id", CONV], form=form)
    assert planned.returncode == 0, planned.stderr[-2000:]
    op_id = json.loads(planned.stdout.strip().splitlines()[-1])["op_id"]
    approved = _run(world, [
        "approve-write", "--op-id", op_id, "--authorization", "Yes",
        "--backend", "chromium", "--conversation-id", CONV],
        extra_env=write_env, form=form)
    assert approved.returncode == 2, approved.stdout + approved.stderr
    return op_id, _payload(approved)


def _pending(world):
    proc = _run(world, ["journal-pending"])
    assert proc.returncode == 0, proc.stderr[-2000:]
    return [row["op_id"]
            for row in json.loads(proc.stdout.strip().splitlines()[-1])
            ["pending"]]


def _journal(world, op_id):
    rows = []
    for path in glob.glob(os.path.join(str(world["home"]), ".morrow", "trees",
                                       "*", "journal", "ops.jsonl")):
        with open(path, encoding="utf-8") as fh:
            rows += [json.loads(line) for line in fh if line.strip()]
    return [row for row in rows if row.get("op_id") == op_id]


def _state_machine(world, *argv):
    proc = subprocess.run(
        [sys.executable, os.path.join("reauth", "state_machine.py")]
        + list(argv), cwd=TREE, env=world["env"], capture_output=True,
        text=True, timeout=60)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return proc.stdout


def _record(case, **facts):
    _ARTIFACT_ROWS.append(dict(case=case, **facts))
    os.makedirs(os.path.dirname(ARTIFACT), exist_ok=True)
    with open(ARTIFACT, "w", encoding="utf-8") as fh:
        json.dump({"suite": "dispatch/test_cli_one_module_e2e.py",
                   "cases": _ARTIFACT_ROWS}, fh, indent=2, sort_keys=True)


@pytest.mark.parametrize("form", sorted(ENTRY_FORMS))
def test_a_refused_write_says_nothing_changed_and_frees_the_op(world, form):
    op_id, payload = _approve_page_change(world, form=form,
                                          FAKE_WRITE_STATUS="422")
    assert payload["mode_id"] == "canvas-write-refused-invalid", payload
    assert MAYBE_APPLIED not in payload["message"]
    assert "nothing changed" in payload["message"].lower()
    assert op_id not in _pending(world)
    _record("422 refused write (%s)" % form, mode_id=payload["mode_id"],
            claim_pending=False)


def test_a_server_error_on_a_write_journals_the_uncertain_outcome(world):
    op_id, payload = _approve_page_change(world, FAKE_WRITE_STATUS="500")
    assert payload["mode_id"] == "uncertain-write-ambiguous", payload
    outcomes = [row for row in _journal(world, op_id)
                if row.get("uncertain") is True]
    assert outcomes, _journal(world, op_id)
    _record("500 on a write", mode_id=payload["mode_id"],
            uncertain_journaled=True)


def test_a_session_that_ends_during_the_write_pauses_the_change(world):
    op_id, payload = _approve_page_change(world, FAKE_DEAD_ON_WRITE="1")
    assert payload["mode_id"] == "uncertain-write-ambiguous", payload
    assert [row for row in _journal(world, op_id)
            if row.get("uncertain") is True]
    status = _state_machine(world, "status", "--op-id", op_id)
    assert "status=quarantined" in status, status
    notice = _state_machine(world, "notify")
    assert "No change was in progress" not in notice, notice
    _record("session ended during the write", mode_id=payload["mode_id"],
            quarantined=True)
