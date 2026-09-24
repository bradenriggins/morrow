#!/usr/bin/env python3
"""Every selftest suite runs somewhere, and the release ships only
suites the install runs.

Failure modes this suite pins down (written before the fix; final sweep
2026-09-23):
  1. About 22 selftest suites ran in no CI job and not at install:
     pytest collects no *_selftest.py file, and scripts/install-suites.sh
     lists only the 23 install suites. They include suites shipped docs
     cite as proof (transport/README.md "Coverage:" lines) and suites
     edited in this sweep, so a change that broke one still passed CI.
     scripts/dev-suites.sh now runs every selftest that is not an
     install suite, through the install runner's isolation, and CI
     runs it after pytest.
  2. Every git-tracked selftest is in exactly one of the two runner
     lists, so no suite can be orphaned again.
  3. 15 of the orphaned suites shipped in the release, where nothing
     ran them (and local_chromium_selftest.py failed there, because it
     reads session/capture.py, which does not ship). A selftest ships
     only when the install runs it.
"""

import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
REPO = os.path.dirname(TREE)
sys.path.insert(0, HERE)

import carve  # noqa: E402
from test_install_suites import LIVE, _fake_tree  # noqa: E402

DEV_RUNNER = os.path.join(HERE, "dev-suites.sh")
SELFTEST = re.compile(r"(^|/)([^/]*_selftest|selftest_[^/]*|selftest)\.py$")
# A shared helper the suites import, not a suite.
NOT_SUITES = {"config/selftest_home.py"}


def dev_suites():
    with open(DEV_RUNNER, encoding="utf-8") as fh:
        text = fh.read()
    return text.split('SUITES="', 1)[1].split('"', 1)[0].split()


def _tracked_selftests():
    out = subprocess.run(["git", "-C", TREE, "ls-files", "--", "."],
                         capture_output=True, text=True, check=True).stdout
    return sorted(rel for rel in out.split()
                  if SELFTEST.search(rel) and rel not in NOT_SUITES)


def test_every_selftest_is_in_exactly_one_runner():
    install, dev = carve.install_suites(), dev_suites()
    assert len(dev) == len(set(dev))
    for suite in dev:
        assert os.path.isfile(os.path.join(TREE, suite)), suite
    tracked = _tracked_selftests()
    assert len(tracked) >= 20
    wrong = [s for s in tracked if (s in install) + (s in dev) != 1]
    assert wrong == []
    assert set(install) & set(dev) == set()


def test_the_release_ships_only_the_suites_install_runs():
    install = set(carve.install_suites())
    shipped = [rel for rel in carve.shipped_files()
               if SELFTEST.search(rel) and rel not in NOT_SUITES]
    assert [rel for rel in shipped if rel not in install] == []
    assert "scripts/dev-suites.sh" not in carve.shipped_files()


def test_ci_runs_the_dev_suites_after_pytest():
    with open(os.path.join(REPO, ".github", "workflows", "ci.yml"),
              encoding="utf-8") as fh:
        text = fh.read()
    job = text[text.index("\n  check-muse:"):text.index("\n  check:")]
    pytest_at = job.index("python -m pytest")
    dev_at = job.index("bash scripts/dev-suites.sh --show-failures")
    assert pytest_at < dev_at


def _fake_dev_tree(tmp_path):
    tree = _fake_tree(tmp_path)
    fake = (tree / carve.install_suites()[0]).read_text()
    with open(DEV_RUNNER, encoding="utf-8") as fh:
        (tree / "scripts" / "dev-suites.sh").write_text(fh.read())
    for suite in dev_suites():
        path = tree / suite
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(fake)
    return tree


def _run_dev(tree, *args, fail=None):
    env = dict(os.environ, HOME=str(tree.parent / "live-home"), **LIVE)
    if fail:
        env["FAIL_SUITE_NAME"] = os.path.basename(fail)
    return subprocess.run(["bash", str(tree / "scripts" / "dev-suites.sh")]
                          + list(args), capture_output=True, text=True,
                          env=env)


def test_every_dev_suite_runs_isolated_from_live_state(tmp_path):
    import json
    tree = _fake_dev_tree(tmp_path)
    proc = _run_dev(tree)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    dev = dev_suites()
    assert proc.stdout.splitlines()[-1] == \
        "%d/%d selftest suites pass" % (len(dev), len(dev))
    homes = set()
    for suite in dev:
        with open(str(tree / suite) + ".seen.json") as fh:
            seen = json.load(fh)
        assert os.path.realpath(seen["cwd"]) == os.path.realpath(str(tree))
        home = os.path.realpath(seen["env"]["HOME"])
        assert home.startswith(os.path.realpath(
            str(tree / ".selftest-work")) + os.sep), home
        homes.add(home)
        assert [v for v in LIVE if v in seen["env"]] == [], suite
    assert len(homes) == len(dev)
    for suite in carve.install_suites():
        assert not os.path.exists(str(tree / suite) + ".seen.json"), suite


def test_a_failed_dev_suite_is_named_with_its_output(tmp_path):
    tree = _fake_dev_tree(tmp_path)
    dev = dev_suites()
    proc = _run_dev(tree, "--show-failures", fail=dev[0])
    assert proc.returncode != 0
    lines = proc.stdout.splitlines()
    assert "FAIL %s" % dev[0] in lines
    assert "suite output: boom" in proc.stdout
    assert lines[-1] == "%d/%d selftest suites pass" % (len(dev) - 1,
                                                        len(dev))
