#!/usr/bin/env python3
"""Morrow state backup and verified restore (W6-P1-1).

Every integrity finding in the Wave 6 audit assumes the operator can
get back to a known-good state; before this module there was no
backup tool at all (W6-P1-1). This module backs up the full Morrow
state set and restores it with verification:

  python3 -m dispatch.state_backup create <dest-dir>
  python3 -m dispatch.state_backup verify <backup-dir>
  python3 -m dispatch.state_backup restore <backup-dir> --yes

Backed-up state sets:
  journal        <tree-state>/journal/  (live journal, sealed sidecar
                 index, archives, retired set + seal, ops.secret keyring)
  tree-binding   <tree-state>/.morrow-tree-binding (W6-P2-7 marker)
  approvals      <morrow-home>/approvals/ (approval records, consumed set)
  vault          <morrow-home>/learner_vault/ (map, seals, secret.key)
  reauth         <morrow-home>/{session.json, reauth_state.json,
                 quarantine.jsonl, quarantine.secret} (W6-P0-1)
  tree-id        <tree>/.morrow-tree-id (W6-P2-6)
  tree-registry  <morrow-home>/trees/.tree-id-registry.json (W6-P2-6)

Deliberately EXCLUDED (never backed up, never restored):
  <tree-state>/journal.generation.highwater
The high-water mark is the anti-stale-restore anchor (W6-P1-2): a
restore must never roll it back, or a stale backup's index would
verify as current. The restore writes journal/restored_from.json
instead, which keeps the journal fail-closed until the operator runs
`journal-reconcile`.

SECURITY: the backup contains every HMAC/AES secret (journal secret,
vault secret, quarantine secret). It is written in plaintext and MUST
be stored encrypted (the manifest says so, and create prints a loud
warning). Never store state-tree backups unencrypted.

Restore is fail-closed by design: it verifies the backup (manifest +
sha256 of every file) BEFORE copying anything, preserves the
generation high-water mark, writes the restore marker, and prints the
ordered recovery steps (journal-reconcile, retired-seal if needed).
"""

import argparse
import hashlib
import json
import os
import shutil
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))))

from config.paths import morrow_home  # noqa: E402

_MANIFEST_NAME = "manifest.json"
_BACKUP_PREFIX = "morrow-backup-"
_FORMAT_VERSION = 1

# The anti-stale anchor: never backed up, never restored (W6-P1-2).
_HIGHWATER_NAME = "journal.generation.highwater"
# The restore marker, written by restore (W6-P1-2).
_RESTORED_MARKER = "restored_from.json"


def _check_rel_safe(rel, where):
    """LANE2-D2: fail closed on manifest rel paths that escape their set
    dir. restore_backup copies manifest-listed rel paths into live state
    dirs; a crafted manifest with absolute or ".." rel paths would write
    outside the state tree (path traversal). create_backup only ever
    emits plain relative paths, so anything else is refused."""
    if not isinstance(rel, str) or not rel or os.path.isabs(rel):
        raise RuntimeError(
            "backup %s lists unsafe rel path %r: refusing" % (where, rel))
    # Backslashes and colons never appear in create_backup output (posix
    # tree); refusing them closes Windows drive-letter / ADS shapes too.
    if "\\" in rel or ":" in rel:
        raise RuntimeError(
            "backup %s lists unsafe rel path %r: refusing" % (where, rel))
    parts = rel.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise RuntimeError(
            "backup %s lists escaping rel path %r: refusing" % (where, rel))
    return rel


def _utc_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _tree_state_dir():
    from dispatch import executor as _ex
    return _ex._tree_state_dir()


def _tree_root():
    return os.path.realpath(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__))))


def _tree_id():
    from dispatch import executor as _ex
    try:
        return _ex._tree_id()
    except RuntimeError:
        return None


def _state_sets():
    """[(name, kind, spec)] describing the backup set.

    kind is "dir" (copy the whole dir), "file" (copy one file), or
    "files" (copy the listed files, skipping missing ones).
    """
    home = morrow_home()
    tsd = _tree_state_dir()
    return [
        ("journal", "dir", os.path.join(tsd, "journal")),
        ("tree-binding", "file", os.path.join(tsd, ".morrow-tree-binding")),
        ("approvals", "dir", os.path.join(home, "approvals")),
        ("vault", "dir", os.path.join(home, "learner_vault")),
        ("reauth", "files", [os.path.join(home, n) for n in (
            "session.json", "reauth_state.json",
            "quarantine.jsonl", "quarantine.secret")]),
        ("tree-id", "file", os.path.join(_tree_root(), ".morrow-tree-id")),
        ("tree-registry", "file",
         os.path.join(home, "trees", ".tree-id-registry.json")),
    ]


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _copy_one(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)
    os.chmod(dst, 0o600)


def create_backup(dest_dir):
    """Create a verified backup under dest_dir. Returns the backup dir."""
    from dispatch import executor as _ex
    ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    backup_dir = os.path.join(os.path.abspath(dest_dir),
                              _BACKUP_PREFIX + ts)
    if os.path.exists(backup_dir):
        raise RuntimeError("backup dir %s already exists" % backup_dir)
    os.makedirs(backup_dir, mode=0o700)
    # os.makedirs honors umask; enforce 0700 explicitly (the backup
    # holds every Morrow secret).
    os.chmod(backup_dir, 0o700)
    manifest = {
        "format": _FORMAT_VERSION,
        "created_at": _utc_now(),
        "tree_id": _tree_id(),
        "tree_root": _tree_root(),
        "contains_secrets": True,
        "excludes": [_HIGHWATER_NAME],
        "sets": {},
    }
    # Hold the journal lock so the journal set is a consistent snapshot.
    with _ex._journal_locked():
        for name, kind, spec in _state_sets():
            files = {}
            if kind == "dir":
                if not os.path.isdir(spec):
                    manifest["sets"][name] = {"absent": True, "files": {}}
                    continue
                for root, dirs, filenames in os.walk(spec):
                    # Never back up the high-water mark (W6-P1-2).
                    if _HIGHWATER_NAME in filenames:
                        filenames.remove(_HIGHWATER_NAME)
                    # Skip the restore marker's parent? No: the marker
                    # ships inside backups so a manual cp restore stays
                    # fail-closed (W6-P1-2).
                    for fn in sorted(filenames):
                        src = os.path.join(root, fn)
                        rel = os.path.relpath(src, spec)
                        dst = os.path.join(backup_dir, name, rel)
                        _copy_one(src, dst)
                        files[rel] = _sha256(dst)
            elif kind == "file":
                if not os.path.isfile(spec):
                    manifest["sets"][name] = {"absent": True, "files": {}}
                    continue
                dst = os.path.join(backup_dir, name,
                                   os.path.basename(spec))
                _copy_one(spec, dst)
                files[os.path.basename(spec)] = _sha256(dst)
            elif kind == "files":
                for src in spec:
                    if not os.path.isfile(src):
                        continue
                    dst = os.path.join(backup_dir, name,
                                       os.path.basename(src))
                    _copy_one(src, dst)
                    files[os.path.basename(src)] = _sha256(dst)
                if not files:
                    manifest["sets"][name] = {"absent": True, "files": {}}
                    continue
            manifest["sets"][name] = {"absent": False, "files": files}
    man_path = os.path.join(backup_dir, _MANIFEST_NAME)
    with open(man_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    # Verify what we wrote before reporting success.
    verify_backup(backup_dir)
    total_files = sum(len(s.get("files", {}))
                      for s in manifest["sets"].values())
    sys.stderr.write(
        "morrow: backup created at %s (%d files).\n"
        "morrow: WARNING: this backup contains every Morrow secret "
        "(journal HMAC key, vault key, quarantine key) in PLAINTEXT. "
        "Store it ENCRYPTED; never leave it unencrypted.\n"
        "morrow: the generation high-water mark was deliberately "
        "excluded (anti-stale-restore anchor, W6-P1-2).\n"
        % (backup_dir, total_files))
    return backup_dir


def _load_manifest(backup_dir):
    man_path = os.path.join(backup_dir, _MANIFEST_NAME)
    with open(man_path, "r", encoding="utf-8") as fh:
        manifest = json.load(fh)
    if manifest.get("format") != _FORMAT_VERSION:
        raise RuntimeError(
            "backup %s has unsupported format %r" %
            (backup_dir, manifest.get("format")))
    return manifest


def verify_backup(backup_dir):
    """Verify a backup: manifest + sha256 of every file. Raises on failure."""
    manifest = _load_manifest(backup_dir)
    if manifest.get("contains_secrets") is not True:
        raise RuntimeError("backup manifest is missing the "
                           "contains_secrets flag: refusing to trust it")
    checked = 0
    for name, meta in manifest["sets"].items():
        for rel, expect in (meta.get("files") or {}).items():
            _check_rel_safe(rel, "verify %s/%s" % (backup_dir, name))
            path = os.path.join(backup_dir, name, rel)
            if not os.path.isfile(path):
                raise RuntimeError(
                    "backup %s is incomplete: %s/%s is missing" %
                    (backup_dir, name, rel))
            actual = _sha256(path)
            if actual != expect:
                raise RuntimeError(
                    "backup %s is CORRUPT: %s/%s sha256 mismatch "
                    "(manifest %s, actual %s)" %
                    (backup_dir, name, rel, expect[:16], actual[:16]))
            checked += 1
    # The high-water mark must never appear in a backup.
    for _root, _dirs, _files in os.walk(backup_dir):
        if _HIGHWATER_NAME in _files:
            raise RuntimeError(
                "backup %s illegally contains %s: it must never be "
                "backed up (W6-P1-2)" % (backup_dir, _HIGHWATER_NAME))
    return {"verified": True, "files": checked,
            "created_at": manifest.get("created_at"),
            "tree_id": manifest.get("tree_id")}


def restore_backup(backup_dir, yes=False):
    """Verified restore of a backup. Fail-closed by design."""
    if not yes:
        raise RuntimeError("restore requires --yes: it overwrites live state")
    backup_dir = os.path.abspath(backup_dir)
    manifest = _load_manifest(backup_dir)
    # Verify BEFORE touching live state.
    verify_backup(backup_dir)
    from dispatch import executor as _ex
    home = morrow_home()
    tsd = _tree_state_dir()
    journal_dir = os.path.join(tsd, "journal")
    with _ex._journal_locked():
        for name, meta in manifest["sets"].items():
            for rel in (meta.get("files") or {}):
                _check_rel_safe(rel, "restore %s/%s" % (backup_dir, name))
                src = os.path.join(backup_dir, name, rel)
                if name == "journal":
                    dst = os.path.join(journal_dir, rel)
                elif name == "tree-binding":
                    dst = os.path.join(tsd, rel)
                elif name == "approvals":
                    dst = os.path.join(home, "approvals", rel)
                elif name == "vault":
                    dst = os.path.join(home, "learner_vault", rel)
                elif name == "reauth":
                    dst = os.path.join(home, rel)
                elif name == "tree-id":
                    dst = os.path.join(_tree_root(), rel)
                elif name == "tree-registry":
                    dst = os.path.join(home, "trees", rel)
                else:
                    raise RuntimeError(
                        "backup set %r is not a known set: refusing to "
                        "restore unknown state" % name)
                # Never restore over the high-water mark (belt and
                # suspenders: create_backup never writes it, but a
                # hand-edited backup must not roll it back either).
                if os.path.basename(dst) == _HIGHWATER_NAME:
                    raise RuntimeError(
                        "backup tries to restore %s: refusing (W6-P1-2)"
                        % _HIGHWATER_NAME)
                _copy_one(src, dst)
        # The restore marker keeps the journal fail-closed until the
        # operator reconciles (W6-P1-2). It ships inside backups too,
        # so even a manual cp restore carries it.
        marker = os.path.join(journal_dir, _RESTORED_MARKER)
        os.makedirs(journal_dir, exist_ok=True)
        with open(marker, "w", encoding="utf-8") as fh:
            fh.write(json.dumps({
                "restored_at": _utc_now(),
                "backup_dir": backup_dir,
                "backup_created_at": manifest.get("created_at"),
                "backup_tree_id": manifest.get("tree_id"),
            }, indent=2, sort_keys=True) + "\n")
    sys.stderr.write(
        "morrow: restored backup %s (created %s).\n"
        "morrow: the journal is FAIL-CLOSED until you reconcile. In order:\n"
        "morrow:   1. Reconcile in-flight ops against the provider.\n"
        "morrow:   2. python3 dispatch/executor.py journal-reconcile --yes\n"
        "morrow:      (refuses a stale restore; restores the newest backup\n"
        "morrow:       instead if it does)\n"
        "morrow:   3. If the retired set predates its seal:\n"
        "morrow:      python3 dispatch/executor.py retired-seal --yes\n"
        "morrow:   4. If the journal secret was lost:\n"
        "morrow:      python3 dispatch/executor.py journal-recover-secret \\\n"
        "morrow:        --yes --reason '...'\n"
        "morrow: The generation high-water mark was preserved (never rolled\n"
        "morrow: back), so a stale restore is detected, not silently\n"
        "morrow: re-admitted.\n"
        % (backup_dir, manifest.get("created_at")))
    return {"restored": True, "backup_dir": backup_dir}


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Morrow state backup and verified restore (W6-P1-1)")
    sub = ap.add_subparsers(dest="command", required=True)
    p_create = sub.add_parser("create", help="create a verified backup")
    p_create.add_argument("dest_dir", help="directory to create the backup in")
    p_verify = sub.add_parser("verify", help="verify a backup")
    p_verify.add_argument("backup_dir", help="backup directory to verify")
    p_restore = sub.add_parser("restore", help="verified restore of a backup")
    p_restore.add_argument("backup_dir", help="backup directory to restore")
    p_restore.add_argument("--yes", action="store_true",
                           help="confirm overwriting live state")
    args = ap.parse_args(argv)
    if args.command == "create":
        path = create_backup(args.dest_dir)
        print(json.dumps({"backup": path, "verified": True}))
    elif args.command == "verify":
        print(json.dumps(verify_backup(args.backup_dir), sort_keys=True))
    elif args.command == "restore":
        print(json.dumps(restore_backup(args.backup_dir, yes=args.yes),
                         sort_keys=True))


if __name__ == "__main__":
    main()
