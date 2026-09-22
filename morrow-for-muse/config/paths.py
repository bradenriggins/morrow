#!/usr/bin/env python3
"""Single source of truth for Morrow state-root resolution (W4-P1-17).

Every module that resolves the educator's Morrow state dir MUST go
through morrow_home() here, never os.path.expanduser("~/.morrow")
directly. An educator who sets MORROW_HOME and backs up that dir gets
the journal, approvals, the approval signing key, lane state, the
learner vault, and the re-auth machinery together: before this module
existed, dispatch/admission.py, transport/state.py,
transport/browser_backend.py, privacy/learner_vault.py,
privacy/pseudonym.py, privacy/executor_wire.py, session/capture.py,
and reauth/state_machine.py each hardcoded ~/.morrow, so the override
moved the journal while the approvals stayed behind (W4-P1-17).

Stdlib only.
"""

import os
import uuid as _uuid

TREE_UUID_FILE = ".morrow-tree-id"


def morrow_home():
    """The educator's Morrow state root.

    Honors the MORROW_HOME env var when set; defaults to ~/.morrow.
    Call this at use time (not at import time) so tests can point
    MORROW_HOME at scratch.
    """
    return os.path.expanduser(os.environ.get("MORROW_HOME", "~/.morrow"))


def read_tree_uuid(tree_root):
    """The stable tree UUID from <tree>/.morrow-tree-id, or None.

    Returns the 32-hex-char uuid (no dashes), or None when the file is
    missing or malformed. The file is minted by install.sh on install
    and upgrade; a missing file means "pre-UUID tree" and callers fall
    back to the legacy path-slug with a warning (W4-P1-16).
    """
    path = os.path.join(tree_root, TREE_UUID_FILE)
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read().strip().lower()
    except OSError:
        return None
    try:
        return str(_uuid.UUID(raw)).replace("-", "")
    except ValueError:
        return None


def mint_tree_uuid(tree_root):
    """Mint and persist a stable tree UUID for tree_root.

    Writes <tree>/.morrow-tree-id atomically (mode 0644: the UUID is an
    identifier, not a secret). Returns the 32-hex-char uuid. Migration
    keeps the journal, op-id idempotency, and approvals intact because
    the tree's state dir is keyed by this UUID instead of the tree's
    path slug (W4-P1-16).
    """
    val = _uuid.uuid4().hex
    path = os.path.join(tree_root, TREE_UUID_FILE)
    # W5-P2-2: pid-unique tmp name; two concurrent writers of the
    # same file must not share one staging path.
    tmp = "%s.new.%d" % (path, os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    with os.fdopen(fd, "w") as f:
        f.write(val + "\n")
    # Explicit chmod: os.open's mode is umask-masked, and the file must
    # be exactly 0644 (deterministic, matching the install.sh mint;
    # the UUID is an identifier, not a secret).
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)
    return val
