#!/usr/bin/env python3
"""Product-side lane state for the browser-task transport.

Metadata ONLY. This file never holds cookie values, CSRF tokens, PATs, or
any credential material. The authenticated session lives in the managed
browser profile, which the product cannot read by construction.

State shape (~/.morrow/browser_lane.json, mode 0600):
    {"canvas": {"base": "https://school.instructure.com",
                "principal": {"id": 28206, "name": "Braden Riggins"},
                "lane": "browser_task",
                "established_at": "<iso>",
                "last_verified_at": "<iso>"}}
"""

import fcntl
import json
import os
import stat
import sys
import threading
from contextlib import contextmanager
from datetime import datetime, timezone

# W4-P1-17: single source of truth for the morrow state root.
_TREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE_ROOT not in sys.path:
    sys.path.insert(0, _TREE_ROOT)
from config.paths import morrow_home  # noqa: E402

STORE_DIR = morrow_home()
STATE_PATH = os.path.join(STORE_DIR, "browser_lane.json")

_SECRET_KEYS = ("cookie", "token", "pat", "secret", "password", "session")


def _reject_secrets(obj, where="state"):
    """Refuse to persist anything that smells like credential material."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            kl = str(k).lower()
            if any(s in kl for s in _SECRET_KEYS):
                raise ValueError(
                    "refusing to persist %s: key %r looks like credential material"
                    % (where, k))
            _reject_secrets(v, where)
    elif isinstance(obj, list):
        for v in obj:
            _reject_secrets(v, where)


def _tmp_path():
    # W5-P2-2: pid-unique tmp name; two concurrent writers of the
    # same state file must not share one staging path.
    # LANE2-D5: threads of one process share a pid, so the name is
    # pid- AND thread-unique. Without the thread ident, two threads
    # open the same path with O_TRUNC on separate file offsets and
    # their JSON bytes interleave into a corrupt state file.
    return "%s.new.%d.%d" % (STATE_PATH, os.getpid(), threading.get_ident())


def _lock_path():
    # Derived from STATE_PATH (not STORE_DIR) so tests that redirect
    # STATE_PATH into scratch automatically redirect the lock too.
    return STATE_PATH + ".lock"


@contextmanager
def _state_locked():
    """Exclusive flock across every state mutation (LANE2-D13).

    mark_verified() is a load-modify-write: without this lock a
    concurrent save() loses (mark_verified loads the pre-save record
    and writes it back over the save, resurrecting the old principal
    and established_at). flock is held on an open fd for the whole
    critical section; a second flock(LOCK_EX) on another open() blocks
    even in the same process, so this serializes threads as well as
    processes. Never nested: locked sections call only the _unlocked
    helpers and load(), which take no lock.
    """
    os.makedirs(os.path.dirname(_lock_path()) or ".", mode=0o700,
                exist_ok=True)
    with open(_lock_path(), "a+", encoding="utf-8") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def _write_record_unlocked(record):
    """Write one complete state record atomically. Call with
    _state_locked() held."""
    _reject_secrets(record)
    # W5-P2-2 / LANE2-D5: pid- and thread-unique staging path; two
    # concurrent writers of the same state file must not share one
    # staging path.
    tmp = _tmp_path()
    # P2-10: atomic-permission creation (0600 at open), never
    # open()-then-chmod: the lane state is never group/other-readable,
    # even briefly.
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(record, fh, indent=2)
    os.replace(tmp, STATE_PATH)


def save(base, principal_id, principal_name):
    with _state_locked():
        record = {
            "canvas": {
                "base": base.rstrip("/"),
                "principal": {"id": principal_id, "name": principal_name},
                "lane": "browser_task",
                "established_at": datetime.now(timezone.utc).isoformat(),
                "last_verified_at": datetime.now(timezone.utc).isoformat(),
            }
        }
        _write_record_unlocked(record)
        return record


def load():
    if not os.path.exists(STATE_PATH):
        return None
    mode = stat.S_IMODE(os.stat(STATE_PATH).st_mode)
    if mode & 0o077:
        raise ValueError("lane state %s has mode %o; expected 0600" % (STATE_PATH, mode))
    with open(STATE_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def mark_verified():
    # LANE2-D13: the load-modify-write runs under _state_locked(); a
    # concurrent save() used to lose (this loaded the pre-save record
    # and wrote it back over the save).
    with _state_locked():
        record = load()
        if not record:
            raise ValueError("no lane state to mark verified")
        record["canvas"]["last_verified_at"] = datetime.now(timezone.utc).isoformat()
        _write_record_unlocked(record)
        return record
