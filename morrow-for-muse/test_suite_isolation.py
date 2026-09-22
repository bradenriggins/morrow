#!/usr/bin/env python3
"""The test suite never resolves the educator's real ~/.morrow.

Failure mode pinned down: several modules freeze ~/.morrow paths at
import time (dispatch.admission's approvals and signing key, the tree
journal, the learner vault), so a suite run with the real HOME wrote
the real ~/.morrow (trees/<tree>/journal, secrets/approval-signing.key,
approvals/time.highwater, morrow_source_vault.json). conftest.py must
point HOME and MORROW_HOME at scratch before any of them import.
"""

import os
import pwd
import sys

TREE = os.path.dirname(os.path.abspath(__file__))
if TREE not in sys.path:
    sys.path.insert(0, TREE)

REAL = os.path.realpath(os.path.join(pwd.getpwuid(os.getuid()).pw_dir,
                                     ".morrow"))


def _outside_real(path):
    real = os.path.realpath(os.path.expanduser(str(path)))
    return not (real == REAL or real.startswith(REAL + os.sep))


def test_environment_points_at_scratch():
    assert _outside_real(os.environ["MORROW_HOME"])
    assert _outside_real(os.path.join(os.environ["HOME"], ".morrow"))


def test_import_time_paths_are_scratch():
    from config.paths import morrow_home
    from dispatch import admission, executor
    from privacy import executor_wire
    for path in (morrow_home(), admission.APPROVALS_DIR,
                 admission.SECRETS_DIR, admission.SIGNING_KEY_PATH,
                 admission.CONSUMED_PATH, executor.JOURNAL_PATH,
                 executor.MORROW_HOME, executor.WRITE_HALT_PATH,
                 executor_wire._source_vault_path(),
                 executor_wire._tree_state_dir()):
        assert _outside_real(path), path
