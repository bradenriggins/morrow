"""Pytest isolation for the whole muse suite.

Runs before pytest imports any test module, so every module that
resolves ~/.morrow at import time (dispatch.admission's approval and
secrets paths, the re-auth state machine, the learner vault) sees a
per-session scratch HOME and MORROW_HOME, never the educator's real
home. Scratch lives under .selftest-work/ (never /tmp) and is removed
when the session ends.
"""

import os
import shutil
import tempfile

_TREE = os.path.dirname(os.path.abspath(__file__))
_BASE = os.path.join(_TREE, ".selftest-work")
os.makedirs(_BASE, exist_ok=True)
_SESSION_HOME = tempfile.mkdtemp(prefix="pytest-home-", dir=_BASE)

os.environ["HOME"] = _SESSION_HOME
os.environ["MORROW_HOME"] = os.path.join(_SESSION_HOME, ".morrow")
# config.selftest_home adopts this scratch home (and no other) when a
# test module imports it, so the whole session shares one home.
os.environ["MORROW_SELFTEST_HOME"] = os.environ["MORROW_HOME"]
for _name in ("MORROW_TREE_STATE_DIR", "MORROW_SOURCE_VAULT_PATH",
              "MORROW_APPROVAL_SIGNING_KEY", "MORROW_USER_ID",
              "MORROW_CONVERSATION_ID", "MORROW_HELPER_ENV_FILE",
              "MORROW_PRIVACY_MAP", "MORROW_PRIVACY_SALT",
              "LOGIN_HELPER_PROFILE_DIR"):
    os.environ.pop(_name, None)


def pytest_unconfigure(config):
    shutil.rmtree(_SESSION_HOME, ignore_errors=True)
