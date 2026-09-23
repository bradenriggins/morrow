#!/usr/bin/env python3
"""Selftest: state_backup refuses manifest rel paths that escape their set.

Regression test for LANE2-D2: restore_backup() copied manifest-listed
`rel` paths into live state dirs with os.path.join, so a crafted backup
manifest containing absolute or ".." rel paths wrote outside the state
tree (path traversal on restore). verify_backup() had the same trust.
Both now fail closed via _check_rel_safe.
"""
import os as _home_os, sys as _home_sys  # noqa: E401
_home_sys.path.insert(0, _home_os.path.join(
    _home_os.path.dirname(_home_os.path.abspath(__file__)), '..'))
import config.selftest_home  # noqa: E402,F401  (scratch HOME/MORROW_HOME)
import json
import os
import shutil
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from dispatch import state_backup as sb  # noqa: E402

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(
        "%s%s" % (name, (" (%s)" % detail) if detail and not cond else ""))


# 1. _check_rel_safe: plain relative paths pass through, including the
# settings and mode-grant files named for a user id with a colon.
for good in ("journal.jsonl", "sub/dir/file.json", "a-b_c.json",
             "canvas:42@c.example.edu.json",
             "grants/canvas:42@c.example.edu.json"):
    try:
        check("accepts %r" % good, sb._check_rel_safe(good, "t") == good)
    except RuntimeError as exc:
        check("accepts %r" % good, False, str(exc)[:60])

# 2. _check_rel_safe: escaping / absolute / empty shapes are refused.
for bad in ("../evil", "sub/../../evil", "/abs/path", "", ".",
            "a/./b", "..\\evil", "C:\\evil", "C:evil", "C:/evil",
            "sub/D:evil"):
    try:
        sb._check_rel_safe(bad, "t")
        check("refuses %r" % bad, False, "no exception")
    except RuntimeError:
        check("refuses %r" % bad, True)
    except Exception as exc:  # noqa: BLE001
        check("refuses %r" % bad, False, "wrong exc %r" % exc)

# 3. verify_backup fails closed on a crafted manifest (no writes anywhere).
fixture = os.path.join(REPO, "dispatch", ".selftest-state-backup")
shutil.rmtree(fixture, ignore_errors=True)
os.makedirs(os.path.join(fixture, "journal"))
manifest = {
    "format": 1,
    "created_at": "2026-09-22T00:00:00Z",
    "tree_id": "selftest",
    "contains_secrets": True,
    "sets": {
        "journal": {"absent": False,
                    "files": {"../../pwned.txt": "0" * 64}},
    },
}
try:
    with open(os.path.join(fixture, "manifest.json"), "w",
              encoding="utf-8") as fh:
        json.dump(manifest, fh)
    try:
        sb.verify_backup(fixture)
        check("verify_backup refuses escaping manifest", False,
              "no exception")
    except RuntimeError as exc:
        check("verify_backup refuses escaping manifest",
              "escaping rel path" in str(exc), str(exc)[:80])
    # The escape target must not exist (nothing was written).
    check("no file written outside the fixture",
          not os.path.exists(os.path.join(REPO, "pwned.txt")))
finally:
    shutil.rmtree(fixture, ignore_errors=True)

for name in PASS:
    print("  ok %s" % name)
if FAIL:
    print("FAIL: %d" % len(FAIL))
    for name in FAIL:
        print("  FAIL %s" % name)
    sys.exit(1)
print("all state_backup selftests passed")
