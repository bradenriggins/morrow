#!/usr/bin/env python3
"""Concurrent consumption of one approval: exactly one winner, under
every multiprocessing start method this platform has.

Failure mode this suite pins down (written before the fix; round-4
audit 2026-09-22, logs audit-muse4/adm_forkserver.log): the
admission_selftest race worker was a local function, which cannot be
pickled, so the check failed under spawn (the macOS default) and
forkserver (the Linux default from Python 3.14). The worker now lives
at module level in dispatch/admission_race.py and the race runs in its
own interpreter, so no start method re-runs a selftest body.
"""

import json
import multiprocessing
import os
import subprocess
import sys

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if TREE not in sys.path:
    sys.path.insert(0, TREE)

METHODS = [m for m in ("spawn", "forkserver", "fork")
           if m in multiprocessing.get_all_start_methods()]


@pytest.mark.parametrize("method", METHODS)
def test_one_winner_under_each_start_method(tmp_path, method):
    home = tmp_path / "home" / ".morrow"
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("MORROW_")}
    env.update({"HOME": str(tmp_path / "home"), "MORROW_HOME": str(home),
                "PYTHONDONTWRITEBYTECODE": "1"})
    mint = subprocess.run(
        [sys.executable, "-c",
         "import json, sys; sys.path.insert(0, %r)\n"
         "from dispatch import admission as A\n"
         "e = {'name': 'canvas_create_assignment', 'provider': 'canvas',"
         " 'effects': 'write', 'request': {'method': 'POST', 'url':"
         " '{canvas_base}/api/v1/courses/{course_id}/assignments'}}\n"
         "r = A.sign_approval(A.mint_approval(e, {'course_id': '7'},"
         " 'https://s.example.edu'), 'Yes', channel='driver')\n"
         "print(json.dumps(r))" % TREE],
        env=env, capture_output=True, text=True, timeout=60, cwd=TREE)
    assert mint.returncode == 0, mint.stderr
    rec_path = tmp_path / "record.json"
    rec_path.write_text(mint.stdout.strip().splitlines()[-1])
    r = subprocess.run(
        [sys.executable, "-m", "dispatch.admission_race", str(rec_path),
         method, "6"],
        env=env, capture_output=True, text=True, timeout=180, cwd=TREE)
    assert r.returncode == 0, r.stdout + r.stderr
    out = json.loads(r.stdout.strip().splitlines()[-1])
    assert out["method"] == method
    assert out["exitcodes"] == [0] * 6, out
    assert out["results"].count("won") == 1, out
    assert out["results"].count("lost") == 5, out
