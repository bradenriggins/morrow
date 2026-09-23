"""Keep selftests out of the educator's real home and live state.

Imported first by every *_selftest.py and every test_*.py that runs as
a script (before any module that resolves ~/.morrow at import time).
HOME and MORROW_HOME are ALWAYS pointed at a fresh scratch dir under
the tree's .selftest-work/ (never /tmp), and every variable that names
live state (the tree state dir, the learner vault, the approval
signing key, the educator identity, the helper env file and profile)
is removed, whatever the caller exported. A selftest can never write
the educator's journal, approvals, or settings. MORROW_HELPER_ENV_FILE
then names an empty file in the scratch home: the tree's helper/env
(the educator's tenant, ports, and TLS files) is what agent-side code
reads when the environment has no value, and it never reaches a
selftest.

Round-4 audit H2: this module used to adopt any MORROW_HOME the caller
set (and refuse MORROW_HOME=~/.morrow with exit 2). With MORROW_HOME
set, a selftest journaled into the live tree state dir and moved the
generation high-water past the live journal, which then failed closed
as a STALE restore; and an educator who exported the default path
could not install at all.

The one MORROW_HOME a selftest adopts is a scratch home this module
made for a parent selftest (MORROW_SELFTEST_HOME names it), so child
processes share their parent's scratch state.

Stdlib only.
"""

import atexit
import os
import pwd
import shutil
import tempfile

_TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SCRATCH_MARKER_ENV = "MORROW_SELFTEST_HOME"

# Every variable that points a selftest at live state or identity.
LIVE_STATE_ENV = (
    "MORROW_TREE_STATE_DIR",
    "MORROW_SOURCE_VAULT_PATH",
    "MORROW_APPROVAL_SIGNING_KEY",
    "MORROW_USER_ID",
    "MORROW_CONVERSATION_ID",
    "MORROW_HELPER_ENV_FILE",
    "MORROW_PRIVACY_MAP",
    "MORROW_PRIVACY_SALT",
    "LOGIN_HELPER_PROFILE_DIR",
)


def real_morrow_home():
    """The account's real ~/.morrow, whatever HOME currently says."""
    return os.path.realpath(os.path.join(pwd.getpwuid(os.getuid()).pw_dir,
                                         ".morrow"))


def _adoptable(configured):
    marker = os.environ.get(SCRATCH_MARKER_ENV)
    if not configured or not marker:
        return False
    same = os.path.realpath(os.path.expanduser(configured)) \
        == os.path.realpath(os.path.expanduser(marker))
    return same and os.path.realpath(os.path.expanduser(configured)) \
        != real_morrow_home()


def _scratch_helper_env(morrow_home):
    os.environ["MORROW_HELPER_ENV_FILE"] = os.path.join(morrow_home,
                                                        "helper-env")


def ensure_scratch_home():
    configured = os.environ.get("MORROW_HOME")
    for name in LIVE_STATE_ENV:
        os.environ.pop(name, None)
    if _adoptable(configured):
        _scratch_helper_env(configured)
        return configured
    base = os.path.join(_TREE, ".selftest-work")
    os.makedirs(base, exist_ok=True)
    home = tempfile.mkdtemp(prefix="home-", dir=base)
    atexit.register(shutil.rmtree, home, True)
    os.environ["HOME"] = home
    os.environ["MORROW_HOME"] = os.path.join(home, ".morrow")
    os.environ[SCRATCH_MARKER_ENV] = os.environ["MORROW_HOME"]
    _scratch_helper_env(os.environ["MORROW_HOME"])
    return os.environ["MORROW_HOME"]


ensure_scratch_home()
