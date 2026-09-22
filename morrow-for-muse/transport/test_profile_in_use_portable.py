#!/usr/bin/env python3
"""_profile_in_use must fail closed where there is no /proc.

Failure mode this suite pins down (written before the fix; round-4
audit 2026-09-22, L7, probe audit-muse4/piu.py): with no /proc, the
comment said the fallback was fail-closed, but it returned False (not
in use) whenever no Chromium lock file existed, so a live browser
using the profile could have its stores purged. Without /proc the
process table is read with `ps`; when that is unreadable too, the
answer is "in use" (fail closed).
"""

import os
import sys

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (TREE, os.path.join(TREE, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import browser_backend as bb  # noqa: E402

_REAL_ISDIR = os.path.isdir


def _no_proc(monkeypatch):
    monkeypatch.setattr(os.path, "isdir",
                        lambda p: False if p == "/proc" else _REAL_ISDIR(p))


def test_no_proc_uses_the_process_table(tmp_path, monkeypatch):
    prof = tmp_path / "prof"
    prof.mkdir()
    _no_proc(monkeypatch)
    monkeypatch.setattr(bb, "_ps_argv_lines", lambda: [
        "/usr/bin/chrome --user-data-dir=%s --no-first-run" % prof])
    assert bb._profile_in_use(str(prof)) is True
    monkeypatch.setattr(bb, "_ps_argv_lines", lambda: [
        "/usr/bin/chrome --user-data-dir=%s-suffix" % prof,
        "/usr/bin/other --flag"])
    assert bb._profile_in_use(str(prof)) is False


def test_no_proc_and_no_process_table_fails_closed(tmp_path, monkeypatch):
    prof = tmp_path / "prof"
    prof.mkdir()
    _no_proc(monkeypatch)
    monkeypatch.setattr(bb, "_ps_argv_lines", lambda: None)
    assert bb._profile_in_use(str(prof)) is True


def test_real_process_table_is_readable_here(tmp_path):
    """On this machine (with or without /proc) the answer for an unused
    scratch profile is 'not in use', not a blanket fail-closed."""
    prof = tmp_path / "unused-prof"
    prof.mkdir()
    assert bb._profile_in_use(str(prof)) is False
