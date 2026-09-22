"""Keep selftests out of the educator's real home.

Imported first by every *_selftest.py and every test_*.py that runs as
a script (before any module that resolves ~/.morrow at import time).
When MORROW_HOME is unset, HOME and MORROW_HOME are pointed at a fresh
scratch dir under the tree's .selftest-work/ (never /tmp), so a
selftest can never write the real ~/.morrow. A MORROW_HOME that names
the real ~/.morrow is refused.

Stdlib only.
"""

import atexit
import os
import pwd
import shutil
import sys
import tempfile

_TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def real_morrow_home():
    """The account's real ~/.morrow, whatever HOME currently says."""
    return os.path.realpath(os.path.join(pwd.getpwuid(os.getuid()).pw_dir,
                                         ".morrow"))


def ensure_scratch_home():
    configured = os.environ.get("MORROW_HOME")
    if configured:
        if os.path.realpath(os.path.expanduser(configured)) \
                == real_morrow_home():
            sys.stderr.write(
                "selftest refused: MORROW_HOME points at the real %s. "
                "Unset MORROW_HOME (a scratch home is used) or point it at "
                "a scratch dir.\n" % real_morrow_home())
            raise SystemExit(2)
        return configured
    base = os.path.join(_TREE, ".selftest-work")
    os.makedirs(base, exist_ok=True)
    home = tempfile.mkdtemp(prefix="home-", dir=base)
    atexit.register(shutil.rmtree, home, True)
    os.environ["HOME"] = home
    os.environ["MORROW_HOME"] = os.path.join(home, ".morrow")
    for name in ("MORROW_TREE_STATE_DIR", "MORROW_SOURCE_VAULT_PATH",
                 "MORROW_APPROVAL_SIGNING_KEY"):
        os.environ.pop(name, None)
    return os.environ["MORROW_HOME"]


ensure_scratch_home()
