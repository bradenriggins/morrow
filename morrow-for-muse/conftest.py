"""Pytest isolation for the whole muse suite.

Runs before pytest imports any test module, so every module that
resolves ~/.morrow at import time (dispatch.admission's approval and
secrets paths, the re-auth state machine, the learner vault) sees a
per-session scratch HOME and MORROW_HOME, never the educator's real
home. Scratch lives under .selftest-work/ (never /tmp) and is removed
when the session ends.
"""

import importlib.util
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


def missing_cryptography_warning():
    """The end-of-run warning when 'cryptography' is not installed, else
    None. Without it every learner-privacy test skips, and a bare
    "skipped" count is easy to miss (final muse audit M4)."""
    if importlib.util.find_spec("cryptography") is not None:
        return None
    return ("WARNING: the optional 'cryptography' package is not installed, "
            "so the learner-privacy tests were SKIPPED, not run. Install "
            "it with 'pip install -r requirements-optional.txt' (or point "
            "MORROW_MUSE_PYTHON at a python that has it) and run again.")


def pytest_terminal_summary(terminalreporter, exitstatus, config):
    warning = missing_cryptography_warning()
    if warning:
        terminalreporter.write_sep("!", "learner-privacy tests skipped")
        terminalreporter.write_line(warning)

