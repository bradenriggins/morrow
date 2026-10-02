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
from dispatch import admission as adm  # noqa: E402

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
manifest = adm._seal_record({
    "format": sb._FORMAT_VERSION,
    "created_at": "2026-09-22T00:00:00Z",
    "tree_id": "selftest",
    "contains_secrets": True,
    "sets": {
        "journal": {"absent": False,
                    "files": {"../../pwned.txt": "0" * 64}},
    },
})
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

# 4. The manifest seal is mandatory: unsealed and tampered manifests
# are refused before any file check runs, so a manifest that silently
# omits files (or retargets hashes) never reaches verify/restore.
def _sealed_fixture(files):
    base = {
        "format": sb._FORMAT_VERSION,
        "created_at": "2026-09-22T00:00:00Z",
        "tree_id": "selftest",
        "contains_secrets": True,
        "sets": {"journal": {"absent": False, "files": dict(files)}},
    }
    return adm._seal_record(base)


def _write_fixture(manifest):
    root = os.path.join(REPO, "dispatch", ".selftest-state-backup-seal")
    shutil.rmtree(root, ignore_errors=True)
    os.makedirs(os.path.join(root, "journal"))
    with open(os.path.join(root, "manifest.json"), "w",
              encoding="utf-8") as fh:
        json.dump(manifest, fh)
    return root


# Unsealed: no "sig" at all.
root = _write_fixture({k: v for k, v in
                       _sealed_fixture({}).items() if k != "sig"})
try:
    sb.verify_backup(root)
    check("verify_backup refuses an unsealed manifest", False,
          "no exception")
except RuntimeError as exc:
    check("verify_backup refuses an unsealed manifest",
          "seal" in str(exc), str(exc)[:80])
finally:
    shutil.rmtree(root, ignore_errors=True)
# Tampered: sealed, then a file silently omitted from the manifest.
sealed = _sealed_fixture({"ops.jsonl": "0" * 64, "skipped.jsonl": "1" * 64})
del sealed["sets"]["journal"]["files"]["skipped.jsonl"]
root = _write_fixture(sealed)
try:
    sb.verify_backup(root)
    check("verify_backup refuses a manifest with omitted files", False,
          "no exception")
except RuntimeError as exc:
    check("verify_backup refuses a manifest with omitted files",
          "seal" in str(exc), str(exc)[:80])
finally:
    shutil.rmtree(root, ignore_errors=True)
# Tampered: sealed, then a hash retargeted.
sealed = _sealed_fixture({"ops.jsonl": "0" * 64})
sealed["sets"]["journal"]["files"]["ops.jsonl"] = "f" * 64
root = _write_fixture(sealed)
try:
    sb.verify_backup(root)
    check("verify_backup refuses a manifest with a retargeted hash",
          False, "no exception")
except RuntimeError as exc:
    check("verify_backup refuses a manifest with a retargeted hash",
          "seal" in str(exc), str(exc)[:80])
finally:
    shutil.rmtree(root, ignore_errors=True)

# 5. Disaster recovery: with the live signing key gone (the home this
# backup restores was lost), the manifest verifies against the keyring
# carried inside the backup; tampering is still refused.
_saved_key_path = adm.SIGNING_KEY_PATH
try:
    sealed = _sealed_fixture({"ops.jsonl": "0" * 64})
    root = _write_fixture(sealed)
    try:
        os.makedirs(os.path.join(root, "secrets"))
        shutil.copyfile(_saved_key_path,
                        os.path.join(root, "secrets",
                                     "approval-signing.key"))
        adm.SIGNING_KEY_PATH = os.path.join(
            root, "no-live-key", "approval-signing.key")
        try:
            loaded = sb._load_manifest(root)
            check("DR fallback verifies against the backup keyring",
                  loaded.get("sig") == sealed["sig"])
        except RuntimeError as exc:
            check("DR fallback verifies against the backup keyring", False,
                  str(exc)[:80])
        sealed["sets"]["journal"]["files"]["ops.jsonl"] = "f" * 64
        with open(os.path.join(root, "manifest.json"), "w",
                  encoding="utf-8") as fh:
            json.dump(sealed, fh)
        try:
            sb._load_manifest(root)
            check("DR fallback refuses a tampered manifest", False,
                  "no exception")
        except RuntimeError as exc:
            check("DR fallback refuses a tampered manifest",
                  "seal" in str(exc), str(exc)[:80])
    finally:
        shutil.rmtree(root, ignore_errors=True)
finally:
    adm.SIGNING_KEY_PATH = _saved_key_path

for name in PASS:
    print("  ok %s" % name)
if FAIL:
    print("FAIL: %d" % len(FAIL))
    for name in FAIL:
        print("  FAIL %s" % name)
    sys.exit(1)
print("all state_backup selftests passed")
