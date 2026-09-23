#!/bin/bash
# install.sh: Morrow for Muse connector installer.
#
# Idempotent: safe to run twice. A second run converges to the same state
# without duplicating or destroying anything: the cron entry is never
# duplicated (stale entries from a previous tree are migrated, loudly),
# ~/.morrow/env is never overwritten, helper/profile/ is never wiped,
# and the installer writes no bytecode or residue into the tree
# (PYTHONDONTWRITEBYTECODE=1; the import probes run with cwd outside the
# tree). "Changes nothing" would be the wrong promise: a second run
# re-verifies every step and repairs drift (missing cron entry, missing
# profile dir), but it never duplicates and never deletes your state.
#
# Upgrade: two supported paths.
#   * New directory (recommended): unzip the new dist somewhere new and
#     run this installer there. Supervision (the keepalive cron entry) is
#     migrated from the old tree to this one, loudly; the old tree is
#     otherwise untouched.
#   * In place: unzip the new dist over the old tree and run this
#     installer. The installer backs the tree up to a timestamped
#     directory first, then removes files the new version no longer ships
#     (diffed against the previous install's manifest, loudly logged). If
#     the upgrade fails afterwards, the backup is restored automatically,
#     but ONLY from a verified-complete backup: the installer records
#     the backup's file count and byte total at backup time and
#     re-verifies them before any restore. A backup interrupted mid-write
#     (e.g. disk full) is NEVER restored over the tree; the tree is left
#     in place, the partial backup is quarantined as <tree>.bak-<ts>.PARTIAL,
#     and the failure names the recovery steps. (The backup covers the
#     installer's own in-place writes. If you unzipped over the old tree,
#     the pre-unzip tree is already gone; keep the previous release zip
#     for full rollback.)
#   A failed FRESH install (no backup) rolls back everything the run
#   created (state dirs, helper/env, helper/profile, the cron entry),
#   itemized, instead of leaving a half-install. Upgrade backups keep
#   a bounded retention: the 2 most recent are kept, older ones pruned.
#   scripts/uninstall.sh removes the tree, the state dir, backups
#   (<tree>.bak-* incl. .PARTIAL), and failed trees (<tree>.failed-*).
#
# What it does, in order:
#   1. python3 check (>= 3.11; 3.10 refused: security EOL Oct 2026).
#      Warns (here and in the closing summary) when the 'cryptography'
#      package the learner vault needs is missing or too old: student
#      data will not work until it is installed.
#   2. Integrity + upgrade: verify the tree against
#      pack/carve-manifest.json (sha256 per file; drift fails loudly
#      naming the files). Mint the stable tree id (.morrow-tree-id) on
#      the first install. Runtime files live in the tree's state dir
#      (${MORROW_HOME}/trees/<tree id>/); logs and loop state that an
#      older release wrote into helper/ are moved there, loudly. On a
#      version change: back up the tree, remove files the new version
#      no longer ships (manifest diff, logged).
#   3. Chromium locate (transport/chromium/chrome, vendor/chromium/chrome,
#      then /opt/meta-chromium/chrome)
#   4. Egress probe (transport/egress.py: authenticated proxy, bare proxy,
#      or direct; credentials are redacted in the output)
#   5. ~/.morrow state creation (0700 dirs; the tree env template
#      helper/env is written only if missing; an existing env file is
#      never overwritten; the legacy global ~/.morrow/env is read for
#      CANVAS_BASE only)
#   6. helper/profile creation (0700, first run only). An existing
#      profile is NEVER wiped, reset, or repackaged: it holds the
#      educator's authenticated Canvas session.
#   7. Keepalive supervision (helper/supervisor.py detects what the
#      machine has). No cron: a supervised background loop runs
#      keepalive.sh every 5 minutes (bin/morrow start, or the first
#      morrow command after a reboot, restarts it). With cron: the
#      keepalive cron install (serialized across concurrent installers
#      with a lock file; the entry shell-quotes the tree path so trees
#      under paths with spaces work; deduped by marker comment; stale
#      entries from a previous tree are migrated, loudly; orphaned
#      entries whose keepalive.sh no longer exists warn loudly (the
#      tree was probably moved/renamed: rerun install.sh from the new
#      location); MORROW_CRON=0 skips this if you arrange your own
#      scheduler)
#   8. Secrets gate: scripts/verify-no-secrets.sh against this tree.
#      Any deny-list violation fails the install. No runtime file is
#      ever written into the tree (logs and loop state live in the
#      state dir), so a rerun after the helper ran passes it too.
#   9. All 23 selftest suites from this tree, through
#      scripts/install-suites.sh. Any failure fails the install and
#      names each failed suite. Test scratch (.selftest-work) is
#      removed afterwards so it never lingers in the install.
#   10. Helper launch via helper/keepalive.sh (only when CANVAS_BASE is
#      set): the tenant is probed first (placeholders, unreachable hosts,
#      and Canvas error pages fail loudly), then the onboarding notice.
#      The notice repeats on every install until onboarding genuinely
#      completes; the onboarded sentinel is recorded only when the helper
#      reports both logged_in=true and session cookies stored in the
#      profile.
#
# It never writes secrets. Where a sign-in is needed it prints what you
# must do.
set -u

TREE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MORROW_HOME="${MORROW_HOME:-${HOME}/.morrow}"
# W2-P1-27: configuration is tree-scoped. The installer writes the env
# template to this tree's helper/env (never the global file). The legacy
# global ${MORROW_HOME}/env is still read for CANVAS_BASE only.
TREE_ENV_FILE="${TREE}/helper/env"
LEGACY_ENV_FILE="${MORROW_HOME}/env"
ENV_FILE="${TREE_ENV_FILE}"
ONBOARDED_SENTINEL="${MORROW_HOME}/onboarded"
INSTALLED_VERSION_FILE="${MORROW_HOME}/installed-version"
INSTALLED_MANIFEST_FILE="${MORROW_HOME}/installed-manifest.json"
CRON_MARKER="# morrow-muse-connector-keepalive"
HELPER_PORT="${LOGIN_HELPER_PORT:-8901}"

# P0-14: no Python step of this installer may write bytecode into the
# tree. The import probes (steps 3-4) also run with cwd outside the tree
# and an absolute sys.path entry, so even without this flag the tree
# stays clean; the flag is belt and braces for the selftests (step 9),
# which must run with cwd inside the tree.
export PYTHONDONTWRITEBYTECODE=1

# Set when an in-place upgrade backup exists: fail() restores it.
UPGRADE_BACKUP=""

# W4-P1-8: fresh-install rollback ledger. Every artifact this installer
# creates on a fresh install is recorded here (newest first) as
#   dir:<path>   a directory this run created      -> rm -rf
#   file:<path>  a file this run created           -> rm -f
#   cron         the keepalive cron entry installed -> removed from crontab
# fail() walks the ledger in reverse creation order, removing exactly
# what this run created and reporting each removal. Pre-existing
# artifacts are never recorded and never touched.
_CREATED=""

_track_created() {
  # $1 = ledger entry ("dir:<path>", "file:<path>", "cron", or
  # "supervisor").
  _CREATED="$1
${_CREATED}"
}

_backup_complete() {
  # W4: $1 = backup dir. True only when the SHA-256 manifest ($1.sha256,
  # recorded at backup time) exists and every file in the backup still
  # matches it. A backup interrupted mid-write (ENOSPC) fails here and
  # is NEVER restored over the tree. Count/byte totals are not sufficient:
  # they cannot detect a file with the right size but wrong content.
  local _mf="$1.sha256"
  [ -f "${_mf}" ] || return 1
  # Verify each file's SHA-256 matches the manifest.
  (cd "$1" && sha256sum -c --quiet "${_mf}" 2>/dev/null) || return 1
  # Verify no extra files were added (sha256sum -c doesn't check this).
  local _m_count _a_count
  _m_count="$(wc -l < "${_mf}" | tr -d ' ')"
  _a_count="$(cd "$1" && find . -type f | wc -l | tr -d ' ')"
  [ "${_m_count}" = "${_a_count}" ] || return 1
  return 0
}

_build_backup_manifest() {
  # $1 = tree dir, $2 = output manifest file. Builds a per-path SHA-256
  # manifest of the tree, excluding helper/profile (runtime state).
  # The manifest is sorted for determinism.
  (cd "$1" && find . -type f -not -path './helper/profile/*' -not -path './helper/profile' | sort | xargs sha256sum) > "$2" \
    || return 1
}

_rollback_cron_entry() {
  # W4-P1-8: remove the keepalive cron entry this run installed. Only
  # called when the ledger holds a "cron" entry, i.e. this run actually
  # installed one. Comment lines that merely mention keepalive.sh are
  # never deleted (W3-P2-11); other trees' entries are never touched.
  local _rc_now _rc_new _rc_dropped _rc_after _rl
  command -v crontab >/dev/null 2>&1 || {
    printf 'rollback: crontab not found; cannot remove the installed keepalive entry (remove it by hand)\n' >&2
    return 1
  }
  _rc_now="$(crontab -l 2>/dev/null || true)"
  _rc_new=""; _rc_dropped=0
  while IFS= read -r _rl || [ -n "${_rl}" ]; do
    case "${_rl}" in
      *"${CRON_MARKER}"*) _rc_dropped=$((_rc_dropped + 1)) ;;
      ""|\#*) _rc_new="${_rc_new}${_rl}
" ;;
      *"${TREE}/helper/keepalive.sh"*) _rc_dropped=$((_rc_dropped + 1)) ;;
      *) _rc_new="${_rc_new}${_rl}
" ;;
    esac
  done <<_RC_EOF
${_rc_now}
_RC_EOF
  _rc_new="$(printf '%s' "${_rc_new}" | grep -v '^$' || true)"
  if [ -z "${_rc_new}" ]; then
    printf '' | crontab - 2>/dev/null || crontab -r 2>/dev/null || true
  else
    printf '%s\n' "${_rc_new}" | crontab - \
      || { printf 'rollback: could not rewrite the crontab\n' >&2; return 1; }
  fi
  _rc_after="$(crontab -l 2>/dev/null || true)"
  case "${_rc_after}" in
    *"${TREE}/helper/keepalive.sh"*)
      printf 'rollback: WARNING: a keepalive entry for this tree survived the rollback; remove it by hand\n' >&2
      return 1 ;;
  esac
  printf 'rollback: removed %d cron line(s) for this tree\n' "${_rc_dropped}" >&2
  return 0
}

_rollback_fresh_install() {
  # W4-P1-8: the ledger is newest-first, so a top-down walk removes in
  # reverse creation order. Reports exactly what was removed and anything
  # that could not be removed.
  local _item _rp _rb_removed _rb_failed
  printf 'fresh install failed: rolling back everything this run created...\n' >&2
  _rb_removed=""; _rb_failed=""
  while IFS= read -r _item || [ -n "${_item}" ]; do
    [ -n "${_item}" ] || continue
    case "${_item}" in
      dir:*|file:*)
        _rp="${_item#*:}"
        case "${_rp}" in
          ""|"/"|"${HOME}")
            _rb_failed="${_rb_failed}${_rp} (refused: unsafe)
" ;;
          *)
            if rm -rf "${_rp}" 2>/dev/null; then
              _rb_removed="${_rb_removed}${_rp}
"
            else
              _rb_failed="${_rb_failed}${_rp}
"
            fi ;;
        esac ;;
      supervisor)
        if python3 "${TREE}/helper/supervisor.py" uninstall >/dev/null 2>&1; then
          _rb_removed="${_rb_removed}keepalive background loop for this tree
"
        else
          _rb_failed="${_rb_failed}keepalive background loop for this tree
"
        fi ;;
      cron)
        if _rollback_cron_entry; then
          _rb_removed="${_rb_removed}keepalive cron entry for this tree
"
        else
          _rb_failed="${_rb_failed}keepalive cron entry for this tree
"
        fi ;;
    esac
  done <<_RB_EOF
${_CREATED}
_RB_EOF
  # Selftest scratch is regenerable residue: never leave it behind.
  find "${TREE}" -type d -name ".selftest-work" -prune \
    -exec rm -rf {} + 2>/dev/null || true
  if [ -n "${_rb_removed}" ]; then
    printf '%s' "${_rb_removed}" | sed 's/^/rollback removed: /' >&2
  fi
  if [ -n "${_rb_failed}" ]; then
    printf 'rollback INCOMPLETE; could not remove (remove by hand):\n' >&2
    printf '%s' "${_rb_failed}" | sed 's/^/  /' >&2
  fi
  if [ -n "${_MIGRATED_STALE:-}" ]; then
    printf 'note: this run had already migrated stale keepalive entries from other tree(s) away; restore them by rerunning the other tree'"'"'s installer if needed.\n' >&2
  fi
}

fail() {
  printf 'INSTALL FAIL [%s]: %s\n' "$1" "$2" >&2
  if [ -n "${UPGRADE_BACKUP}" ] && [ -d "${UPGRADE_BACKUP}" ]; then
    # W4-P0-7: the backup is restorable ONLY when its completeness
    # marker verifies. A partial backup (e.g. ENOSPC mid-write) is
    # NEVER restored over the tree: the tree is left in place, the
    # partial backup is quarantined, and the failure is loud. (The old
    # code restored any directory found here, destroying the good tree
    # with a partial backup while printing "restore complete".)
    if ! _backup_complete "${UPGRADE_BACKUP}"; then
      printf 'RESTORE REFUSED: the upgrade backup at %s is INCOMPLETE (the backup write was interrupted, e.g. disk full).\n' "${UPGRADE_BACKUP}" >&2
      printf 'The tree at %s was NOT modified by the restore and is left exactly as it was.\n' "${TREE}" >&2
      if mv "${UPGRADE_BACKUP}" "${UPGRADE_BACKUP}.PARTIAL" 2>/dev/null; then
        mv -f "${UPGRADE_BACKUP}.sha256" "${UPGRADE_BACKUP}.PARTIAL.sha256" 2>/dev/null || true
        mv -f "${UPGRADE_BACKUP}.meta" "${UPGRADE_BACKUP}.PARTIAL.meta" 2>/dev/null || true
        printf 'The partial backup was quarantined as %s.PARTIAL (forensics only; it is missing files, do NOT restore from it).\n' "${UPGRADE_BACKUP}" >&2
      else
        printf 'WARNING: could not quarantine the partial backup at %s; inspect it by hand (do NOT restore from it).\n' "${UPGRADE_BACKUP}" >&2
      fi
      printf 'RECOVERY: free disk space, then restore the tree from your previous release zip: the installer never completed a backup to restore from.\n' >&2
      exit 1
    fi
    # W4-P2-15: never rename a symlinked tree root aside: the rename
    # would silently convert the educator's symlink into a real
    # directory. Refuse loudly and leave the symlink alone.
    if [ -L "${TREE}" ]; then
      printf 'RESTORE REFUSED: %s is a symlink (to %s).\n' "${TREE}" "$(readlink "${TREE}")" >&2
      printf 'Renaming it aside would silently replace your symlink with a real directory, so the automatic restore is refused.\n' >&2
      printf 'The upgrade backup is intact at %s; restore it by hand (as the symlink target), then rerun the installer.\n' "${UPGRADE_BACKUP}" >&2
      exit 1
    fi
    _ts="$(date +%Y%m%d-%H%M%S)"
    _failed="${TREE}.failed-${_ts}"
    printf 'upgrade failed: preserving the failed tree at %s\n' "${_failed}" >&2
    printf 'restoring the pre-upgrade tree from the VERIFIED backup %s ...\n' "${UPGRADE_BACKUP}" >&2
    if mv "${TREE}" "${_failed}" 2>/dev/null \
       && mv "${UPGRADE_BACKUP}" "${TREE}" 2>/dev/null; then
      # The backup excluded the live profile (runtime state, 10s of MB);
      # move it back from the failed tree so the educator's session is
      # not stranded in the .failed directory.
      if [ -d "${_failed}/helper/profile" ] \
         && [ ! -d "${TREE}/helper/profile" ]; then
        mv "${_failed}/helper/profile" "${TREE}/helper/profile" \
          2>/dev/null || true
      fi
      printf 'restore complete: pre-upgrade tree is back at %s\n' "${TREE}" >&2
      printf 'failed attempt preserved at %s for forensics\n' "${_failed}" >&2
    else
      printf 'RESTORE FAILED: manual recovery needed.\n' >&2
      printf '  backup: %s\n  failed tree: %s\n' \
        "${UPGRADE_BACKUP}" "${_failed}" >&2
    fi
  elif [ -n "${_CREATED}" ]; then
    # W4-P1-8: no backup (fresh install or reinstall): remove everything
    # this run created rather than leaving a half-install behind.
    _rollback_fresh_install
  fi
  exit 1
}
step() { printf -- '--- %s\n' "$1"; }
note() { printf '%s\n' "$1"; }

# -- 1. python3 -----------------------------------------------------------
step "1/10 python3 check"
command -v python3 >/dev/null 2>&1 \
  || fail "python3" "python3 not found on PATH"
# P2-5: prereqs the keepalive needs: curl (status probe), ss (port-holder
# lookup), pgrep (CDP-port process scan). Name the missing tool.
# W4-P1-7: flock serializes the keepalive cron install across
# concurrent installers; keepalive.sh needs it too. Fail fast here
# rather than mid-install.
for _tool in curl ss pgrep flock; do
  command -v "${_tool}" >/dev/null 2>&1 \
    || fail "prereq" "${_tool} not found on PATH"
done
unset _tool
# W4-P2-23: floor is 3.11, not 3.10. Python 3.10 reaches security
# end-of-life in October 2026 (PEP 619); a security-sensitive package
# fails closed on an EOL interpreter rather than warning. The tree
# has no 3.10-only need (match statements and stdlib use are 3.11+
# clean; verified on 3.12).
PY_VER="$(python3 --version 2>&1)"
PY_OK="$(python3 -c 'import sys; print("yes" if sys.version_info >= (3, 11) else "no")')"
[ "${PY_OK}" = "yes" ] \
  || fail "python3" "python3 >= 3.11 required (found: ${PY_VER}). Python 3.10 reaches security end-of-life in October 2026 (PEP 619) and will stop receiving security fixes; install Python 3.11 or newer and rerun."
note "ok: ${PY_VER}"
# All student-data work needs the encrypted learner vault, which needs
# the 'cryptography' package. Without it the install still works,
# Morrow refuses student data (fail closed), and student names in
# course content are hidden without labels, so this warns instead of
# failing, here and again in the closing summary.
VAULT_PROBLEM="$(cd / && python3 -c "
import sys
sys.path.insert(0, '${TREE}')
from privacy.core import learner_vault_problem
print(learner_vault_problem() or '')
" 2>&1)" || VAULT_PROBLEM="the learner vault check could not run: $(printf '%s' "${VAULT_PROBLEM}" | tail -1)"
vault_warning() {
  printf '%s\n' \
    "================================================================" \
    "WARNING: student data will not work until 'cryptography' is installed." \
    "" \
    "Morrow keeps student names and ids in an encrypted learner vault," \
    "and the vault needs the Python package 'cryptography'. Without it," \
    "Morrow refuses everything that touches student data: finding a" \
    "student by name, the failed-students question, rosters, grades," \
    "and submissions. Student names in course pages are hidden without" \
    "labels, so a change that would save one back is refused." \
    "Everything else works." \
    "" \
    "Reason: ${VAULT_PROBLEM}" \
    "" \
    "Install it (hash-pinned) from ${TREE}, then rerun this installer:" \
    "    python3 -m pip install --require-hashes -r requirements-optional.txt" \
    "================================================================"
}
if [ -n "${VAULT_PROBLEM}" ]; then
  vault_warning
else
  note "ok: learner vault ready (cryptography installed)"
fi

# -- 2. integrity + upgrade -----------------------------------------------
step "2/10 integrity and upgrade"
MANIFEST="${TREE}/pack/carve-manifest.json"
VERSION_FILE="${TREE}/pack/version.txt"
[ -f "${MANIFEST}" ] \
  || fail "integrity" "pack/carve-manifest.json is missing: this tree was not produced by the carve pipeline (or it was tampered with). Re-download the release."
[ -f "${VERSION_FILE}" ] \
  || fail "integrity" "pack/version.txt is missing: this tree was not produced by the carve pipeline (or it was tampered with). Re-download the release."
# P1-23: bind this tree to its carve. Every manifest-listed file must
# exist with the recorded sha256; anything else is drift and fails
# loudly, naming the files. Extra files (not in the manifest) are
# checked against an exact allowed set: runtime state the installer or
# helper creates. Anything else fails.
# P1-15 / P2-1: upgrade detection runs BEFORE the integrity walk, so the
# walk can tolerate known-stale files on the documented unzip-over
# upgrade path (they are removed loudly by the migration below;
# rejecting them here as "extras" made every real upgrade fail).
TREE_VERSION="$(tr -d '[:space:]' < "${VERSION_FILE}")"
_INSTALLED_VERSION=""
[ -f "${INSTALLED_VERSION_FILE}" ] \
  && _INSTALLED_VERSION="$(tr -d '[:space:]' < "${INSTALLED_VERSION_FILE}")"
_UPGRADE=0
if [ -n "${_INSTALLED_VERSION}" ] \
  && [ "${_INSTALLED_VERSION}" != "${TREE_VERSION}" ]; then
  _UPGRADE=1
fi
# W4-P1-11: bytecode poisoning. Running the documented executor command
# (or any python) from the tree without PYTHONDONTWRITEBYTECODE=1
# writes __pycache__/ dirs into the tree, which the integrity walk
# below would reject as unrecognized extras. That is correct for true
# drift, but bytecode is regenerable residue, not drift: find and
# remove it LOUDLY before the walk, so a forgotten env prefix degrades
# to a loud cleanup, not a failed install.
_PYCACHE_GONE="$(find "${TREE}" -type d -name "__pycache__" -print 2>/dev/null)"
if [ -n "${_PYCACHE_GONE}" ]; then
  printf '%s\n' "${_PYCACHE_GONE}" | sed 's/^/  cleaned bytecode dir: /'
  find "${TREE}" -type d -name "__pycache__" -prune \
    -exec rm -rf {} + 2>/dev/null || true
  note "W4-P1-11: removed __pycache__ residue before the integrity check (run python with PYTHONDONTWRITEBYTECODE=1 to avoid this)"
fi
unset _PYCACHE_GONE
python3 - "${TREE}" "${INSTALLED_MANIFEST_FILE}" "${_UPGRADE}" <<'PYEOF' || fail "integrity" "tree drifted from its carve manifest (see above)"
import hashlib, json, os, re, sys
tree = sys.argv[1]
# Same pattern as helper/supervisor.py _LEGACY_RUNTIME.
LEGACY_RUNTIME = re.compile(
    r"^(?:(?:keepalive|server|keepalive-supervisor)\.log(?:\.[0-9]+)?"
    r"|keepalive-supervisor\.json(?:\.lock)?)$")
# On a version change, files listed in the previous install's manifest
# but absent from the new one are known-stale, queued for the migration
# step's loud removal below. They are not drift.
old_files = set()
if sys.argv[3] == "1":
    try:
        with open(sys.argv[2], encoding="utf-8") as fh:
            old_files = set(json.load(fh).get("files", {}))
    except (OSError, ValueError):
        pass
with open(os.path.join(tree, "pack", "carve-manifest.json"),
          encoding="utf-8") as fh:
    man = json.load(fh)
if not isinstance(man.get("files"), dict) or not man["files"]:
    print("INTEGRITY FAIL: carve manifest has no file list")
    sys.exit(1)
manifest_files = set(man["files"])
bad = []
for rel in sorted(manifest_files):
    want = man["files"][rel]
    p = os.path.join(tree, rel)
    if not os.path.isfile(p):
        bad.append("missing: " + rel)
        continue
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    if h.hexdigest() != want:
        bad.append("modified: " + rel)
if bad:
    print("INTEGRITY FAIL: %d file(s) differ from the carve manifest:"
          % len(bad))
    for b in bad:
        print("  " + b)
    sys.exit(1)
print("integrity ok: %d files match the carve manifest "
      "(carve %s)" % (len(manifest_files), man.get("carve_version", "?")))
# Exact allowed-extra-file set: files the installer/helper/runtime may
# create that are NOT in the manifest. Anything else is drift.
def _is_allowed_extra(rel):
    # pack/carve-manifest.json: the integrity anchor itself. It cannot
    # appear in its own file set (a file cannot contain its own sha256);
    # it is the document every other entry is verified against, loaded
    # before this walk runs.
    if rel == "pack/carve-manifest.json":
        return True
    # helper/profile/ and everything under it: the live session.
    if rel == "helper/profile" or rel.startswith("helper/profile/"):
        return True
    # helper/env: installer-created config (if not shipped).
    if rel == "helper/env":
        return True
    # W4-P1-16: the stable tree id minted by the installer (or a prior
    # upgrade). It is runtime identity, not drift.
    if rel == ".morrow-tree-id":
        return True
    # Runtime files an older release wrote into helper/ (keepalive's
    # and the helper server's logs with their rotated archives, the
    # keepalive loop's state and log). They are moved to the tree's
    # state dir right after this walk, before any gate reads the tree.
    if rel.startswith("helper/") and LEGACY_RUNTIME.match(rel[7:]):
        return True
    # Test scratch: .selftest-* anywhere, .selftest-work/ dirs.
    parts = rel.split("/")
    if any(p.startswith(".selftest-") for p in parts):
        return True
    if ".selftest-work" in parts:
        return True
    return False
extras = []
for root, dirs, files in os.walk(tree):
    # Skip the profile dir walk for speed; it is allowed wholesale.
    rel_root = os.path.relpath(root, tree)
    if rel_root == "helper/profile" or rel_root.startswith("helper/profile/"):
        continue
    for name in files:
        rel = os.path.relpath(os.path.join(root, name), tree)
        if rel not in manifest_files and rel not in old_files \
                and not _is_allowed_extra(rel):
            extras.append(rel)
if extras:
    print("INTEGRITY FAIL: %d file(s) in the tree are not in the carve "
          "manifest and not in the allowed-extra set:" % len(extras))
    for rel in sorted(extras)[:20]:
        print("  extra: " + rel)
    if len(extras) > 20:
        print("  ... and %d more" % (len(extras) - 20))
    sys.exit(1)
print("integrity ok: no disallowed extra files")
PYEOF
note "tree version: ${TREE_VERSION}"
# P1-15 / P2-1: upgrade migration. The last successful install records
# its version and manifest under MORROW_HOME (outside the tree, so an
# unzip-over upgrade cannot destroy the record). _UPGRADE was decided
# above, before the integrity walk.
if [ "${_UPGRADE}" = "1" ]; then
  note "upgrade detected: ${_INSTALLED_VERSION} -> ${TREE_VERSION}"
  # P2-1: back up the tree BEFORE the installer's in-place writes
  # (stale-file removal below). The live profile is excluded: it is
  # runtime state, never touched by the migration, and can be 10s of MB.
  UPGRADE_BACKUP="${TREE}.bak-$(date +%Y%m%d-%H%M%S)"
  note "backing up the tree to ${UPGRADE_BACKUP} (excluding helper/profile)"
  mkdir -p "${UPGRADE_BACKUP}" \
    || fail "backup" "cannot create ${UPGRADE_BACKUP}"
  # pipefail: a producer-side tar failure must fail the pipeline, not
  # hide behind the consumer's exit status.
  set -o pipefail
  (cd "${TREE}" && tar cf - --exclude=helper/profile .) \
    | (cd "${UPGRADE_BACKUP}" && tar xf -) \
    || fail "backup" "tree backup failed; refusing to modify the tree"
  set +o pipefail
  # W4: per-path SHA-256 manifest for the restore gate in fail(). Built
  # from the TREE (excluding helper/profile) BEFORE the backup, then
  # verified against the backup immediately. A backup interrupted
  # mid-write (e.g. ENOSPC) fails verification and is NEVER restored
  # over the tree. Count/byte totals cannot detect wrong-content files.
  _build_backup_manifest "${TREE}" "${UPGRADE_BACKUP}.sha256" \
    || fail "backup" "cannot build the backup SHA-256 manifest"
  # Verify the backup matches the manifest immediately.
  _backup_complete "${UPGRADE_BACKUP}" \
    || fail "backup" "the backup at ${UPGRADE_BACKUP} does not match its SHA-256 manifest; refusing to modify the tree"
  note "backup complete and verified (${UPGRADE_BACKUP})"

  # W4: retention. Keep the 3 most recent upgrade backups (this run's
  # plus the two previous); prune older ones loudly so in-place
  # upgrades do not accumulate a full tree copy forever.
  _keep_n=3; _seen_n=0
  while IFS= read -r -d '' _old_bak; do
    _seen_n=$((_seen_n + 1))
    if [ "${_seen_n}" -gt "${_keep_n}" ] && [ -d "${_old_bak}" ]; then
      if rm -rf "${_old_bak}" 2>/dev/null; then
        rm -f "${_old_bak}.sha256" "${_old_bak}.meta" 2>/dev/null || true
        note "pruned old upgrade backup: ${_old_bak}"
      else
        note "WARNING: could not prune old upgrade backup ${_old_bak}; remove it by hand"
      fi
    fi
  done < <(find "$(dirname "${TREE}")" -maxdepth 1 \
    -name "$(basename "${TREE}").bak-*" -print0 2>/dev/null | sort -z -r)
  unset _keep_n _seen_n _old_bak
  # P1-15: remove files the new version no longer ships. Stale = in the
  # previous install's manifest but not in this tree's manifest. Each
  # removal is logged loudly. Stale directories are removed only when
  # empty afterwards (never nuke a dir the educator put files in).
  if [ -f "${INSTALLED_MANIFEST_FILE}" ]; then
    python3 - "${TREE}" "${INSTALLED_MANIFEST_FILE}" "${MANIFEST}" <<'PYEOF'
import json, os, sys
tree, old_path, new_path = sys.argv[1], sys.argv[2], sys.argv[3]
with open(old_path, encoding="utf-8") as fh:
    old_files = set(json.load(fh)["files"])
with open(new_path, encoding="utf-8") as fh:
    new_files = set(json.load(fh)["files"])
stale = sorted(old_files - new_files)
if not stale:
    print("migration: no stale files from the previous version")
    sys.exit(0)
removed, kept_dirs = [], []
for rel in stale:
    p = os.path.join(tree, rel)
    if os.path.isfile(p) and not os.path.islink(p):
        os.remove(p)
        removed.append(rel)
    elif os.path.isdir(p) and not os.path.islink(p):
        try:
            os.rmdir(p)
            removed.append(rel + "/")
        except OSError:
            kept_dirs.append(rel + "/")
print("migration: removed %d stale file(s) the new version no longer ships:"
      % len(removed))
for rel in removed:
    print("  removed: " + rel)
if kept_dirs:
    print("migration: kept %d non-empty directorie(s) (educator files? "
          "remove by hand if unwanted):" % len(kept_dirs))
    for rel in kept_dirs:
        print("  kept: " + rel)
PYEOF
    [ $? -eq 0 ] || fail "migration" "stale-file removal failed; the pre-upgrade tree was restored from ${UPGRADE_BACKUP}"
  else
    note "WARNING: no previous install manifest at ${INSTALLED_MANIFEST_FILE};"
    note "cannot determine which files the new version dropped. If this is an"
    note "in-place upgrade, check for leftover files from removed lanes by hand"
    note "(see INSTALL.md, 'Upgrading')."
  fi
elif [ -n "${_INSTALLED_VERSION}" ]; then
  note "same version as the last install (${_INSTALLED_VERSION}); reinstall path, no migration"
else
  note "no previous install record; fresh-install path"
fi
# W4-P1-16: stable tree identity, on every install (fresh, reinstall,
# and upgrade). Minted once (atomically: temp file + rename, so a
# crashed install can never leave a half-written id) and preserved
# verbatim afterwards: copies, moves, and upgrades keep the same id, so
# the state dir, the journal location, and op-id idempotency follow the
# tree instead of its path. Runs after the integrity walk so a minted id
# is never mistaken for drift; the allowlist above exempts it. (It runs
# after the upgrade backup, so a restored backup keeps the id too.)
TREE_ID_FILE="${TREE}/.morrow-tree-id"
if [ -f "${TREE_ID_FILE}" ]; then
  note "existing tree id kept at .morrow-tree-id (moves, copies, and upgrades preserve it)"
else
  python3 - "${TREE_ID_FILE}" <<'PYEOF' \
    || fail "tree-id" "cannot mint ${TREE_ID_FILE}"
import os, sys, uuid
# W4-P1-16: the canonical file form is the 32-hex-char uuid (no
# dashes), matching config/paths.py mint_tree_uuid and the
# 32-hex-only reader in helper/keepalive.sh _tree_uuid. Dashed ids
# would be rejected by keepalive and silently fall back to the
# legacy path slug, defeating the stable identity.
target = sys.argv[1]
tmp = target + ".tmp.%d" % os.getpid()
with open(tmp, "w", encoding="utf-8") as f:
    f.write(uuid.uuid4().hex + "\n")
os.chmod(tmp, 0o644)
os.replace(tmp, target)
PYEOF
  _track_created "file:${TREE_ID_FILE}"
  note "minted stable tree id at .morrow-tree-id (0644, non-secret; survives tree moves and renames)"
fi
# W4-P1-12: tree-specific cron marker. Each tree's keepalive entry carries
# its own tree ID, so concurrent installers for different trees preserve
# each other's entries (the old generic marker caused one installer to
# delete the other's entry as "stale").
TREE_ID="$(tr -d '[:space:]' < "${TREE_ID_FILE}" 2>/dev/null || true)"
if [ -n "${TREE_ID}" ]; then
  CRON_MARKER="# morrow-muse-connector-keepalive ${TREE_ID}"
fi
# Runtime files live in this tree's state dir, never in the tree: the
# secrets gate (step 8) and the integrity walk read the tree as release
# content. Same resolution as helper/keepalive.sh and the transport.
TREE_STATE_DIR="${MORROW_TREE_STATE_DIR:-${MORROW_HOME}/trees/${TREE_ID}}"
# An older release wrote keepalive's and the helper's logs (with their
# rotated archives) and the keepalive loop's state into helper/. Move
# them to the state dir, loudly, and stop a loop recorded there.
_retired="$(python3 "${TREE}/helper/supervisor.py" retire-legacy 2>&1)" \
  || fail "runtime-files" "could not move an older release's runtime files out of helper/: ${_retired}"
case "${_retired}" in
  *'"moved": []'*) ;;
  *) note "moved runtime files an older release left in helper/ to ${TREE_STATE_DIR}: ${_retired}" ;;
esac
unset _retired

# -- 3. Chromium ----------------------------------------------------------
step "3/10 chromium locate"
# P0-14: run with cwd OUTSIDE the tree and an absolute sys.path entry,
# so CPython never writes transport/__pycache__/ into the tree. (The
# exported PYTHONDONTWRITEBYTECODE=1 above is the second layer.)
CHROME_BIN="$(cd / && python3 -c "
import sys
sys.path.insert(0, '${TREE}/transport')
import local_chromium as lc
try:
    print(lc.default_binary())
except RuntimeError as exc:
    print('MISSING: ' + str(exc))
")"
case "${CHROME_BIN}" in
  MISSING*)
    fail "chromium" "no Chromium binary found. Checked, in order: transport/chromium/chrome, vendor/chromium/chrome, /opt/meta-chromium/chrome." ;;
esac
note "ok: ${CHROME_BIN}"

# -- 4. egress probe ------------------------------------------------------
step "4/10 egress probe"
EGRESS="$(cd / && python3 -c "
import sys
sys.path.insert(0, '${TREE}/transport')
import egress
p = egress.probe_egress()
print(p['mode'])
print(p['detail'])
")"
EGRESS_MODE="$(printf '%s' "${EGRESS}" | head -1)"
EGRESS_DETAIL="$(printf '%s' "${EGRESS}" | tail -n +2)"
[ "${EGRESS_MODE}" = "blocked" ] && fail "egress" "${EGRESS_DETAIL}"
note "ok: mode=${EGRESS_MODE}"
note "${EGRESS_DETAIL}"

# -- 5. ~/.morrow state ---------------------------------------------------
step "5/10 state layout"
# W4-P1-8: remember which layout dirs this run creates, for rollback.
_had_home=0; [ -d "${MORROW_HOME}" ] && _had_home=1
_had_journal=0; [ -d "${MORROW_HOME}/journal" ] && _had_journal=1
_had_approvals=0; [ -d "${MORROW_HOME}/approvals" ] && _had_approvals=1
mkdir -p -m 0700 "${MORROW_HOME}" "${MORROW_HOME}/journal" \
  "${MORROW_HOME}/approvals" \
  || fail "state" "cannot create ${MORROW_HOME}"
[ "${_had_home}" = "0" ] && _track_created "dir:${MORROW_HOME}"
[ "${_had_journal}" = "0" ] && _track_created "dir:${MORROW_HOME}/journal"
[ "${_had_approvals}" = "0" ] && _track_created "dir:${MORROW_HOME}/approvals"
unset _had_home _had_journal _had_approvals
# W4-P2-15: a symlinked helper/env makes selftests fail opaquely (the
# server follows the link while the tests isolate the file). Refuse
# early with a clear message instead.
if [ -L "${TREE_ENV_FILE}" ]; then
  fail "state" "${TREE_ENV_FILE} is a symlink to $(readlink "${TREE_ENV_FILE}"). A symlinked env file is not supported: replace it with a real file first (cp --remove-destination \"$(readlink "${TREE_ENV_FILE}")\" \"${TREE_ENV_FILE}\"), then rerun."
fi
if [ ! -f "${TREE_ENV_FILE}" ]; then
  # W4-P2-14: the write AND the chmod are checked; the "created" note
  # prints only when both succeeded. (The shell's own redirection error,
  # e.g. "Read-only file system", is printed above by the failing
  # redirection itself, so fail() names it precisely.)
  if cat > "${TREE_ENV_FILE}" <<'EOF'
# Morrow for Muse: educator config for THIS tree. Uncomment and set your tenant:
# CANVAS_BASE=https://myschool.instructure.com
# There is no default tenant; the login helper refuses to start without one.
#
# Tree-scoped: the helper profile is always <tree>/helper/profile
# (keepalive pins it). The ports can be pinned here:
# LOGIN_HELPER_PORT=8901                      (default 8901)
# LOGIN_HELPER_CDP_PORT=19223                 (default 19223)
# The legacy global ~/.morrow/env is honored for CANVAS_BASE only.
EOF
  then
    chmod 0600 "${TREE_ENV_FILE}" \
      || fail "state" "wrote ${TREE_ENV_FILE} but chmod 0600 failed"
    _track_created "file:${TREE_ENV_FILE}"
    note "created ${TREE_ENV_FILE} (0600) with a commented CANVAS_BASE template"
  else
    fail "state" "could not write ${TREE_ENV_FILE}"
  fi
else
  note "existing ${TREE_ENV_FILE} kept; never overwritten"
fi
if [ -f "${LEGACY_ENV_FILE}" ]; then
  note "legacy ${LEGACY_ENV_FILE} present; honored for CANVAS_BASE only (profile/port vars there are ignored)"
fi
# W4-P1-2: tighten permissions on state the installer ADOPTS but did not
# create. Mode bits protect against different-UID attackers only; they
# do not isolate the tree from another process under the same UID (see
# INSTALL.md, same-UID limits). A loud note is printed every time we
# change permissions on something pre-existing.
_tighten() { # _tighten <path> <mode> <dir|file>
  _p="$1"; _m="$2"; _kind="$3"; _want="${2#0}"
  [ -e "${_p}" ] || return 0
  _cur="$(stat -c '%a' "${_p}" 2>/dev/null || stat -f '%Lp' "${_p}" 2>/dev/null || echo ?)"
  if [ "${_cur}" = "?" ]; then
    # W4-P1-2: mode inspection failed; do not silently skip. Warn loudly
    # so the educator knows this path was NOT verified tight.
    note "WARNING: could not inspect mode of ${_kind} ${_p}; leaving it unchanged (verify by hand)"
  elif [ "${_cur}" != "${_want}" ]; then
    chmod "${_m}" "${_p}" \
      || fail "state" "cannot tighten ${_kind} ${_p} to ${_m}"
    note "tightened pre-existing ${_kind} ${_p}: ${_cur} -> ${_m} (not created by this install; changed for safety)"
  fi
  unset _p _m _kind _want _cur
}
for _d in "${MORROW_HOME}" "${MORROW_HOME}/journal" "${MORROW_HOME}/approvals" "${MORROW_HOME}/trees"; do
  _tighten "${_d}" 0700 dir
done
unset _d
for _td in "${MORROW_HOME}/trees"/*/; do
  [ -d "${_td}" ] || continue
  _tighten "${_td%/}" 0700 dir
  _tighten "${_td}helper_token" 0600 file
done
unset _td
_tighten "${TREE_ENV_FILE}" 0600 file
_tighten "${LEGACY_ENV_FILE}" 0600 file
_tighten "${MORROW_HOME}/privacy_salt" 0600 file
_tighten "${MORROW_HOME}/privacy_map.jsonl" 0600 file
_tighten "${MORROW_HOME}/session.json" 0600 file
_tighten "${MORROW_HOME}/quarantine.jsonl" 0600 file

# -- 6. helper/profile: create once, NEVER wipe ----------------------------
step "6/10 helper profile"
PROFILE_DIR="${TREE}/helper/profile"
if [ -d "${PROFILE_DIR}" ]; then
  NFILES="$(find "${PROFILE_DIR}" -type f 2>/dev/null | wc -l | tr -d ' ')"
  note "existing profile kept at helper/profile (${NFILES} files)."
  note "The installer never wipes, resets, or repackages it: your Canvas session survives reinstalls and updates."
  # W4-P1-2: tighten an adopted profile dir (the 0700 dir bit is what
  # blocks other-UID traversal; no need to recurse the profile).
  _tighten "${PROFILE_DIR}" 0700 dir
else
  mkdir -p -m 0700 "${PROFILE_DIR}" \
    || fail "profile" "cannot create ${PROFILE_DIR}"
  _track_created "dir:${PROFILE_DIR}"
  note "created helper/profile (0700). Your Canvas session will live here after the one-time sign-in."
fi

# -- 7. keepalive supervision -----------------------------------------------
# Round-4 M5: supervision does not depend on cron. helper/supervisor.py
# detects what this machine has: cron (crontab installed and a cron
# daemon running) gets the per-tree cron entry below; no cron gets a
# supervised background loop that runs keepalive.sh every 5 minutes,
# restarted by `bin/morrow start` and by the first morrow command
# after a reboot.
step "7/10 keepalive supervision"
_SUPERVISION="$(python3 "${TREE}/helper/supervisor.py" detect 2>/dev/null || printf 'loop')"
if [ "${MORROW_CRON:-1}" = "0" ]; then
  note "MORROW_CRON=0: skipping keepalive supervision (you arrange your own scheduler)"
elif [ "${_SUPERVISION}" = "cron" ]; then
  # W4-P1-7: serialize the crontab read-modify-write across concurrent
  # installers with a lock file under MORROW_HOME. Two installers
  # racing used to silently drop one tree's supervision entry; the loser
  # never knew. A concurrent installer for a DIFFERENT tree now waits
  # here and its entry survives.
  _cron_lock="${MORROW_HOME}/.cron-install.lock"
  if ! exec 8>"${_cron_lock}"; then
    fail "cron" "cannot open the cron lock file ${_cron_lock}"
  fi
  _lock_tries=0
  while ! flock -n 8; do
    _lock_tries=$((_lock_tries + 1))
    if [ "${_lock_tries}" -ge 60 ]; then
      exec 8>&- 2>/dev/null || true
      fail "cron" "timed out after 60s waiting for the cron install lock (another installer running?)"
    fi
    sleep 1
  done
  unset _lock_tries
  _cron_now="$(crontab -l 2>/dev/null || true)"
  # P0-15: migrate supervision from a previous tree. Any morrow keepalive
  # entry pointing at a DIFFERENT tree is stale: the old tree's keepalive
  # would keep running and can SIGKILL this tree's server every 5
  # minutes. Stale entries are removed loudly; this tree's entry is
  # (re)installed below. (Multi-tree supervision on one machine is not
  # supported: entries are per-machine, not per-tree. Use MORROW_CRON=0
  # and schedule keepalive.sh yourself if you run two trees.)
  #
  # W3-P2-11: classify each line honestly. A line is one of OURS only
  # when it is an actual schedule entry (never a comment, never blank)
  # naming this tree's keepalive.sh. Comment lines that merely MENTION
  # keepalive.sh (e.g. "# disabled: helper/keepalive.sh was too noisy")
  # are never deleted. Our own marker line is dropped and re-added
  # below so reinstalls stay idempotent. A legacy/marker-less entry for
  # this tree on a non-*/5 schedule is NORMALIZED to */5 (an hourly
  # entry must not linger forever); hand-duplicated entries for this
  # tree are deduped to one, loudly.
  # W4-P1-12: per-tree coexistence. Each tree's entry carries its own
  # tree ID in the marker. Entries for OTHER trees (their marker, or a
  # legacy marker-less keepalive.sh entry) are PRESERVED, never removed.
  # Only this tree's marker and command are updated. The old "stale
  # entry" removal (which deleted other trees' supervision) is gone.
  _mine=""; _mine_first=""; _mine_n=0; _other=""; _cron_base=""
  while IFS= read -r _line || [ -n "${_line}" ]; do
    case "${_line}" in
      "") continue ;;
      *"${CRON_MARKER}"*) continue ;;   # our own marker: re-added below
      \#*) _cron_base="${_cron_base}${_line}
" ;;                  # other comments: never touched
      *"morrow-muse-connector-keepalive "*)
        # Another tree's marker (different tree ID): preserve.
        _other="${_other}${_line}
"
        _cron_base="${_cron_base}${_line}
" ;;
      *"${TREE}/helper/keepalive.sh"*)
        [ "${_mine_n}" -eq 0 ] && _mine_first="${_line}"
        _mine="${_mine}${_line}
"; _mine_n=$((_mine_n + 1)) ;;
      *helper/keepalive.sh*)
        # Legacy marker-less entry (possibly another tree's, installed
        # before tree-specific markers): preserve, warn loudly.
        _other="${_other}${_line}
"
        _cron_base="${_cron_base}${_line}
" ;;
      *) _cron_base="${_cron_base}${_line}
" ;;
    esac
  done <<_CRON_EOF
${_cron_now}
_CRON_EOF
  # W4-P1-9: the tree path is shell-QUOTED in the entry, so a tree
  # under a path with spaces works. (An old unquoted entry is treated
  # as non-canonical and normalized below, loudly.)
  _canonical="*/5 * * * * \"${TREE}/helper/keepalive.sh\""
  # W4-P1-12: other trees' entries are preserved, not removed. Warn
  # loudly about them so the operator knows multiple trees are supervised.
  [ -n "${_other}" ] && {
    note "keeping keepalive cron entries for other tree(s) (per-tree coexistence):"
    printf '%s' "${_other}" | sed 's/^/  kept: /'
  }
  # W4-P1-9: orphaned entries whose keepalive.sh no longer exists: the
  # tree was probably moved or renamed without rerunning the installer
  # (cron has been failing "not found" every 5 minutes). Warn loudly;
  # INSTALL.md says to rerun install.sh from the new location instead.
  _dead=""
  while IFS= read -r _sline || [ -n "${_sline}" ]; do
    [ -n "${_sline}" ] || continue
    _spath=""
    case "${_sline}" in
      *\"*keepalive.sh*\")
        _spath="$(printf '%s' "${_sline}" \
          | sed -n 's/[^"]*"\([^"]*keepalive\.sh\)".*/\1/p')" ;;
      *keepalive.sh*)
        # Unquoted entry: the path may contain spaces, so do NOT split
        # on whitespace. Take everything up to the last keepalive.sh.
        _spath="$(printf '%s' "${_sline}" \
          | sed -n 's/^\(.*keepalive\.sh\).*/\1/p')" ;;
    esac
    if [ -n "${_spath}" ] && [ ! -e "${_spath}" ]; then
      _dead="${_dead}${_sline}
"
    fi
  done <<_DEAD_EOF
${_other}
_DEAD_EOF
  if [ -n "${_dead}" ]; then
    note "WARNING: some kept entries point at keepalive.sh paths that no longer exist:"
    printf '%s' "${_dead}" | sed 's/^/  dead entry: /'
    note "That usually means a tree was moved or renamed without rerunning its installer."
    note "Do NOT move or rename an installed tree: rerun install.sh from the new location instead (INSTALL.md, 'Upgrading')."
  fi
  unset _dead _spath _sline _stok
  if [ "${_mine_n}" -eq 1 ] && [ "${_mine_first}" = "${_canonical}" ]; then
    note "keepalive cron already installed for this tree (*/5); not duplicated"
  else
    if [ "${_mine_n}" -gt 1 ]; then
      note "W3-P2-11: found ${_mine_n} keepalive entries for this tree; deduping to one:"
      printf '%s' "${_mine}" | sed 's/^/  removed duplicate: /'
    elif [ "${_mine_n}" -eq 1 ]; then
      note "W3-P2-11: normalizing this tree's keepalive entry to the */5 schedule:"
      printf '%s' "${_mine}" | sed 's/^/  replaced: /'
    fi
    if [ -n "${_cron_base}" ]; then
      _cron_new="$(printf '%s%s\n%s\n' "${_cron_base}" "${CRON_MARKER}" \
        "${_canonical}")"
    else
      _cron_new="$(printf '%s\n%s\n' "${CRON_MARKER}" \
        "${_canonical}")"
    fi
    # The command substitution above strips the trailing newline, and
    # cron's crontab refuses a file whose last line has none.
    printf '%s\n' "${_cron_new}" | crontab - \
      || { flock -u 8; exec 8>&-; fail "cron" "could not install the keepalive cron entry"; }
    _track_created "cron"
    # W4-P1-12: per-tree coexistence; no migration, just installation.
    note "installed keepalive cron for this tree (every 5 minutes)"
  fi
  # W4-P1-7: release the cron lock.
  flock -u 8
  exec 8>&-
  unset _cron_lock _cron_now _cron_base _cron_new _other _mine _mine_first _mine_n _line _canonical
else
  # No cron on this machine: the supervised background loop. Its first
  # keepalive run comes one interval after start (step 10 launches the
  # helper now). Its state and log live in the tree's state dir. A
  # rerun keeps a loop that already runs, and a failed rerun leaves it
  # running.
  _had_state_dir=0; [ -d "${TREE_STATE_DIR}" ] && _had_state_dir=1
  if _loop_out="$(python3 "${TREE}/helper/supervisor.py" install-loop 2>&1)"; then
    [ "${_had_state_dir}" = "0" ] && _track_created "dir:${TREE_STATE_DIR}"
    case "${_loop_out}" in
      *'"started": true'*) _track_created "supervisor" ;;
    esac
    note "no cron on this machine: keepalive runs as a supervised background loop every 5 minutes (${_loop_out})"
    note "after a reboot, run 'bin/morrow start' (the first morrow command also restarts it)"
  else
    fail "supervision" "could not start the keepalive background loop: ${_loop_out}"
  fi
  unset _loop_out _had_state_dir
fi
unset _SUPERVISION

# -- 8. secrets gate -----------------------------------------------------------
step "8/10 secrets gate"
# P0-12: the gate runs BEFORE the helper launch, so a dirty tree never
# starts a browser. Runtime logs and the keepalive loop's state live in
# the tree's state dir, never in the tree, so they cannot trip it on a
# fresh install or on a rerun after the helper ran.
# The gate runs against the installed tree, excluding the runtime
# helper/profile the installer itself just created (it is empty on
# first install and holds the educator's live session on reinstalls;
# neither may fail an install). The carve-time gate runs without
# exclusions, so a dist shipping a profile is rejected before install.
VERIFY_EXCLUDE="helper/profile" "${TREE}/scripts/verify-no-secrets.sh" "${TREE}" \
  || fail "secrets" "scripts/verify-no-secrets.sh reported violations (see above)"

# -- 9. selftests ------------------------------------------------------------
step "9/10 selftest suites"
# scripts/install-suites.sh holds the suite list and runs each suite in
# a scratch home with every live state path removed (round-4 H2). CI
# runs the same script on the carved release tree. Its scratch lives
# under .selftest-work/, which is removed below (and by rollback on
# failure).
_SUITES_OUT="$(bash "${TREE}/scripts/install-suites.sh")"
_SUITES_RC=$?
if [ "${_SUITES_RC}" -ne 0 ]; then
  _FAILED="$(printf '%s\n' "${_SUITES_OUT}" | sed -n 's/^FAIL //p' \
    | tr '\n' ' ')"
  [ -n "${_FAILED}" ] || _FAILED="scripts/install-suites.sh (exit ${_SUITES_RC}) "
  fail "selftest" "${_FAILED}failed; run 'bash scripts/install-suites.sh --show-failures' from ${TREE} for details"
fi
note "ok: ${_SUITES_OUT##*$'\n'}"
unset _SUITES_OUT _SUITES_RC _FAILED
# Test scratch is regenerable residue: remove it so it never lingers in
# the install. (The secrets gate ran above, before the suites; this just
# keeps the tree clean.)
find "${TREE}" -type d -name ".selftest-work" -prune \
  -exec rm -rf {} + 2>/dev/null || true
note "removed .selftest-work scratch dirs"

# -- 10. helper launch + onboarding-once --------------------------------------
step "10/10 helper launch"
# P1-22: capture the shell's CANVAS_BASE before sourcing the env files:
# the keepalive cron sources ONLY the tree env file, so a shell-only
# value would work at install and then fail weeks later at recovery time.
_SHELL_CANVAS_BASE="${CANVAS_BASE:-}"
if [ -f "${TREE_ENV_FILE}" ]; then
  # shellcheck disable=SC1090
  . "${TREE_ENV_FILE}"
fi
if [ -z "${CANVAS_BASE:-}" ] && [ -f "${LEGACY_ENV_FILE}" ]; then
  # Legacy global env: CANVAS_BASE only (W2-P1-27).
  _LEGACY_CB="$(sed -n 's/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}CANVAS_BASE=\(.*\)/\2/p' "${LEGACY_ENV_FILE}" | tail -1)"
  _LEGACY_CB="${_LEGACY_CB#\'}"; _LEGACY_CB="${_LEGACY_CB%\'}"
  _LEGACY_CB="${_LEGACY_CB#\"}"; _LEGACY_CB="${_LEGACY_CB%\"}"
  if [ -n "${_LEGACY_CB}" ]; then
    CANVAS_BASE="${_LEGACY_CB}"
    note "CANVAS_BASE read from legacy ${LEGACY_ENV_FILE}; consider moving it to ${TREE_ENV_FILE}"
  fi
  unset _LEGACY_CB
fi
if [ -z "${CANVAS_BASE:-}" ]; then
  note "CANVAS_BASE is not set yet: skipping the helper launch."
  note "Set it in ${ENV_FILE}, then rerun this installer (or wait for the next keepalive run). The one-time sign-in comes after."
else
  if [ -n "${_SHELL_CANVAS_BASE}" ] \
    && ! grep -qE '^[[:space:]]*(export[[:space:]]+)?CANVAS_BASE=' "${ENV_FILE}" 2>/dev/null; then
    fail "env" "CANVAS_BASE is set in this shell but absent from ${ENV_FILE}; the keepalive cron sources only that file, so helper recovery would fail later. Add CANVAS_BASE=${_SHELL_CANVAS_BASE} to ${ENV_FILE} and rerun."
  fi
  # P1-26: probe the tenant before launching the helper against it.
  # (The error-title match is apostrophe-agnostic: Canvas renders the
  # apostrophe as U+2019, so match "find your login page" bare.)
  # The probe body lives under MORROW_HOME (never the package tree) with
  # a PID suffix, and is removed on every path below.
  _TENANT_HOST="$(printf '%s' "${CANVAS_BASE}" | python3 -c 'import sys,urllib.parse; print(urllib.parse.urlparse(sys.stdin.read().strip()).hostname or "")')"
  case "${_TENANT_HOST}" in
    ""|instructure.com|example.com|example.instructure.com|myschool.instructure.com|canvas.instructure.com|your-school.*|yourschool.*|your_school.*)
      fail "tenant" "CANVAS_BASE=${CANVAS_BASE} looks like a placeholder; set your real tenant in ${ENV_FILE}."
      ;;
  esac
  # No -f: an HTTP error status (e.g. 404) still fetches the body, so a
  # Canvas error page is reported as an error page, not as unreachable.
  # Only network/DNS failures exit non-zero here.
  _PROBE_BODY="${MORROW_HOME}/.tenant-probe.$$.body"
  if ! curl -s -m 15 -L --max-redirs 3 "${CANVAS_BASE}" -o "${_PROBE_BODY}" 2>/dev/null; then
    rm -f "${_PROBE_BODY}"
    fail "tenant" "CANVAS_BASE=${CANVAS_BASE} is unreachable; check the URL and your network, then rerun."
  fi
  if grep -qi "find your login page\|Page Not Found" "${_PROBE_BODY}" 2>/dev/null; then
    rm -f "${_PROBE_BODY}"
    fail "tenant" "CANVAS_BASE=${CANVAS_BASE} serves a Canvas error page; fix it in ${ENV_FILE} and rerun."
  fi
  rm -f "${_PROBE_BODY}"
  note "ok: tenant reachable, no Canvas error page"
  "${TREE}/helper/keepalive.sh" >/dev/null 2>&1
  KEEP_RC=$?
  case "${KEEP_RC}" in
    0)
      STATUS="$(curl -sf -m 8 "http://127.0.0.1:${HELPER_PORT}/status" 2>/dev/null || true)"
      note "helper healthy: ${STATUS}"
      # P0-7: the onboarded sentinel is a real authenticated signal only:
      # keepalive exit 0 already implies logged_in=true, and the profile
      # must actually hold session cookies. Both fields are parsed
      # explicitly; the signed-out branch below never touches the
      # sentinel, so onboarding cannot be recorded for a dead session.
      _ONBOARD_FIELDS="$(printf '%s' "${STATUS}" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("logged_in=false profile_has_cookies=false")
else:
    print("logged_in=%s profile_has_cookies=%s" % (
        "true" if d.get("logged_in") else "false",
        "true" if d.get("profile_has_cookies") else "false"))' 2>/dev/null || echo "logged_in=false profile_has_cookies=false")"
      if [ "${_ONBOARD_FIELDS}" = "logged_in=true profile_has_cookies=true" ]; then
        if [ ! -f "${ONBOARDED_SENTINEL}" ]; then
          note "already signed in (session cookies stored); recording onboarding as complete"
          touch "${ONBOARDED_SENTINEL}"
          _track_created "file:${ONBOARDED_SENTINEL}"
        fi
      else
        note "helper is up but the session is not fully authenticated yet; onboarding not recorded"
      fi
      ;;
    2)
      note "helper is up but the Canvas session is signed out."
      if [ ! -f "${ONBOARDED_SENTINEL}" ]; then
        # P0-7: onboarding is NOT recorded here. This notice repeats on
        # every install until the session is genuinely live; the sentinel
        # is only touched when /status confirms both logged_in=true and
        # session cookies stored.
        printf '%s\n' \
          "================================================================" \
          "SIGN-IN NEEDED (this notice repeats until you are signed in)" \
          "" \
          "The helper is running. Open the helper page your agent points" \
          "you to (it reaches http://127.0.0.1:${HELPER_PORT}/) and sign" \
          "in to Canvas yourself, SSO and MFA included." \
          "" \
          "Leave Canvas's \"Stay signed in\" (or \"Remember me\") ON: that" \
          "is what keeps your session alive across helper and machine" \
          "restarts, so this is the only sign-in. Your agent never sees" \
          "your password: keystrokes go straight into the page." \
          "================================================================"
      else
        note "Sign in again through the helper page when you are ready; your agent will point you to it only when the session is actually dead."
      fi
      ;;
    *)
      note "WARNING: the helper did not come up (keepalive exit ${KEEP_RC})."
      note "Check ${TREE_STATE_DIR}/keepalive.log and ${TREE_STATE_DIR}/server.log, then run ${TREE}/helper/keepalive.sh by hand."
      ;;
  esac
fi

# Record this install: version + manifest under MORROW_HOME (outside the
# tree, so an unzip-over upgrade cannot destroy the record). The next
# install diffs against these for upgrade migration (P1-15).
# W4: atomic install records. Write to temp files under MORROW_HOME,
# validate, then atomic rename. A disk-full failure leaves the old
# records intact (or no records for a fresh install), never torn.
_track_created "file:${INSTALLED_MANIFEST_FILE}"
_track_created "file:${INSTALLED_VERSION_FILE}"
_manifest_tmp="${INSTALLED_MANIFEST_FILE}.tmp.$$"
_version_tmp="${INSTALLED_VERSION_FILE}.tmp.$$"
# Preserve preexisting records so they can be restored on failure.
_had_manifest=0; _had_version=0
[ -f "${INSTALLED_MANIFEST_FILE}" ] && _had_manifest=1
[ -f "${INSTALLED_VERSION_FILE}" ] && _had_version=1
cp "${MANIFEST}" "${_manifest_tmp}" \
  || fail "install-record" "could not write the install manifest temp file ${_manifest_tmp}"
# Validate: must parse as JSON and have a nonempty "files" object.
python3 - "${_manifest_tmp}" <<'PYEOF' \
  || { rm -f "${_manifest_tmp}" "${_version_tmp}"; fail "install-record" "the install manifest temp file does not have a nonempty 'files' object (disk full?)"; }
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    m = json.load(f)
files = m.get("files")
if not isinstance(files, dict) or not files:
    sys.exit(1)
PYEOF
# Validate version is nonempty.
[ -n "${TREE_VERSION}" ] || { rm -f "${_manifest_tmp}" "${_version_tmp}"; fail "install-record" "TREE_VERSION is empty; refusing to write an empty version record"; }
printf '%s\n' "${TREE_VERSION}" > "${_version_tmp}" \
  || { rm -f "${_manifest_tmp}" "${_version_tmp}"; fail "install-record" "could not write the installed version temp file ${_version_tmp}"; }
[ -s "${_version_tmp}" ] \
  || { rm -f "${_manifest_tmp}" "${_version_tmp}"; fail "install-record" "the installed-version temp file is empty after the write"; }
# Atomic rename only after validation.
mv -f "${_manifest_tmp}" "${INSTALLED_MANIFEST_FILE}" \
  || { rm -f "${_manifest_tmp}" "${_version_tmp}"; fail "install-record" "could not atomically install the manifest record"; }
mv -f "${_version_tmp}" "${INSTALLED_VERSION_FILE}" \
  || { rm -f "${_version_tmp}"; fail "install-record" "could not atomically install the version record"; }
unset _manifest_tmp _version_tmp _had_manifest _had_version

note ""
if [ -n "${VAULT_PROBLEM}" ]; then
  vault_warning
fi
note "Install complete. What is next for you:"
note "  1. If CANVAS_BASE is still unset, set it in ${ENV_FILE} and rerun this installer."
note "  2. Sign in once through the helper page (the notice above repeats until you are signed in)."
note "  3. Operator check: PYTHONDONTWRITEBYTECODE=1 python3 dispatch/executor.py catalog --name users_self --method GET --path /api/v1/users/self --class read --backend chromium"
note "  4. Educator path: in Muse, say \"Connect my Canvas account\" and follow the conversation (FIRST_RUN.md has the full checklist)."
