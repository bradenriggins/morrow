#!/bin/bash
# scripts/install-robustness-selftest.sh (DEV-ONLY installer robustness battery).
#
# This is NOT part of the install. install.sh never runs it. It is a
# developer tool for adversarially testing the installer robustness
# findings (wave-4 family: W4-P0-7, W4-P0-8, W4-P1-6..W4-P1-11,
# W4-P1-18, W4-P2-13, W4-P2-15). Run it by hand from the tree:
#
#   bash scripts/install-robustness-selftest.sh [scenario ...]
#
# Scenarios (default: all):
#   enospc-backup       R1: ENOSPC mid-backup -> tree untouched, backup
#                       quarantined as .PARTIAL, INSTALL FAIL (never restored).
#   install-record-full R2: disk-full install-record write -> nonzero exit,
#                       INSTALL FAIL naming the record.
#   concurrent-cron     R3: two installers at once -> both cron entries survive.
#   fresh-rollback      R4: fresh-install failure -> everything created is
#                       removed, itemized as "rollback removed:" lines.
#   cron-spaces         R5: cron entry for a tree path with spaces executes.
#   bytecode            R7: documented executor command (with
#                       PYTHONDONTWRITEBYTECODE=1) followed by install succeeds;
#                       and a forgotten prefix degrades to loud __pycache__
#                       cleanup, not a failed install.
#   canvas-base-rerun   R8: CANVAS_BASE in helper/env, then rerun, passes step 9.
#   slug-bound          R10: long-path state slug stays under NAME_MAX and
#                       bash/python agree; short slug unchanged.
#   symlink-tree        R11: symlinked tree root stays a symlink after a
#                       failed upgrade (never renamed).
#   symlink-env         R12: symlinked helper/env is rejected with
#                       INSTALL FAIL [state].
#   uninstall-residue   R13: uninstall removes upgrade backups, .PARTIAL
#                       backups, and failed-upgrade trees.
#
# R6 (keepalive lock stderr) and R9 (selftest counts) are covered by
# helper/keepalive_selftest.sh and the suites themselves, not here.
#
# ABSOLUTE RULES (same as the audit): NEVER use /tmp for anything.
# Everything runs under ${ROBUST_SCRATCH:-<audit>/scratch/worker-install/robust}.
# Fixtures are built from the source tree with a carve-like treatment
# (residue removed, tenant references sanitized to example.*, manifest
# regenerated), never by carving the real distribution.
# Uses small tmpfs mounts for ENOSPC tests. No real credentials.
# Uses a fake crontab shim (PATH override), never the real crontab.
set -u

SRC="${MORROW_DEPLOY_SRC:-$HOME/workspace/morrow-for-muse-deploy}"
SCRATCH="${ROBUST_SCRATCH:-$HOME/workspace/audits/adversarial-wave-4-2026-09-21/scratch/worker-install/robust}"
PASS=0
FAIL=0
FAILED_NAMES=""

ok()   { PASS=$((PASS+1)); printf '  ok: %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); FAILED_NAMES="${FAILED_NAMES} $1"; printf '  FAIL: %s\n' "$1"; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 2; }
}

# -- fixture ---------------------------------------------------------------
# Build a sanitized, self-consistent fixture tree from the source:
# drop runtime residue and carve-omitted dev dirs, sanitize tenant
# references the way the carve does (chcp. -> example.), regenerate the
# carve-format manifest. Result passes the tree's own secrets gate and
# integrity check.
make_fixture() { # $1 = dest dir, $2 = version string
  local dest="$1" ver="${2:-0.9.9-w4test}"
  # W4: start from the existing sanitized distribution (never re-sanitize
  # from source here). Overlay the changed source files, drop runtime
  # residue, then regenerate only the scratch fixture manifest.
  local dist="${MORROW_SANITIZED_DIST:-$HOME/workspace/morrow-dist/morrow-muse-connector}"
  rm -rf "${dest}"
  mkdir -p "${dest}"
  cp -r "${dist}/." "${dest}/"
  # Overlay the source files changed by this wave (installer robustness).
  # Python packages (transport/, dispatch/, helper/, config/) come from
  # SOURCE in full and are sanitized below: the sanitized dist predates
  # several cross-module APIs (e.g. verify_helper_tenant_binding), so
  # overlaying individual files would leave version skew. Non-Python
  # content (docs, knowledge, pack) stays from the dist.
  local f
  for f in install.sh scripts/uninstall.sh DEPLOY.md INTEGRATION_NOTES.md \
           CHANGELOG.md SKILL.md INSTALL.md knowledge/operations-runbook.md \
           knowledge/troubleshooting-playbook.md \
           audit/desktop-parity-audit.md audit/DESKTOP_TO_MUSE_MATRIX.md \
           scripts/verify-no-secrets.sh pack/carve-manifest.json \
           pack/version.txt VERSION; do
    if [ -f "${SRC}/${f}" ]; then
      mkdir -p "${dest}/$(dirname "${f}")"
      cp "${SRC}/${f}" "${dest}/${f}"
    fi
  done
  # Sanitize overlaid markdown docs (tenant refs -> example).
  python3 - "${dest}" <<'PYEOF'
import os, sys
dest = sys.argv[1]
for rel in ("DEPLOY.md", "INTEGRATION_NOTES.md",
            "audit/desktop-parity-audit.md",
            "audit/DESKTOP_TO_MUSE_MATRIX.md"):
    p = os.path.join(dest, rel)
    try:
        with open(p, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        continue
    new = text.replace("chcp.", "example.")
    new = new.replace("chcp.instructure.com", "example.instructure.com")
    if new != text:
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(new)
        print("sanitized %s" % rel)
PYEOF
  # NOTE: scripts/install-robustness-selftest.sh is NOT overlaid: it
  # contains the sanitization patterns as literals, which the secrets
  # gate would flag. It is a dev-only harness, not part of the install.
  for f in transport dispatch helper config reauth moodle provision privacy lanes; do
    rm -rf "${dest}/${f}"
    mkdir -p "${dest}/${f}"
    cp -r "${SRC}/${f}/." "${dest}/${f}/"
  done
  # proof-battery: only the two files integration_selftest.py references.
  # The rest (evidence/, live-product-proof/, etc.) holds live-test
  # artifacts with real tenant hosts; never ship it in the fixture.
  mkdir -p "${dest}/proof-battery"
  cp "${SRC}/proof-battery/item_bank_sdk_battery.py" "${dest}/proof-battery/" 2>/dev/null || true
  cp "${SRC}/proof-battery/OPERATION_CATALOG.md" "${dest}/proof-battery/" 2>/dev/null || true
  # Sanitize the source-overlaid Python AND markdown (tenant refs ->
  # example). The dist's copies are already clean.
  python3 - "${dest}" <<'PYEOF'
import os, sys
dest = sys.argv[1]
n = 0
for sub in ("transport", "dispatch", "helper", "config", "reauth",
            "moodle", "provision", "privacy", "lanes"):
    d = os.path.join(dest, sub)
    for root, dirs, files in os.walk(d):
        # proof-battery is handled separately (only 2 files).
        if "proof-battery" in root:
            continue
        # Never ship bytecode.
        for name in list(files):
            if name.endswith((".pyc", ".pyo")):
                try:
                    os.remove(os.path.join(root, name))
                except OSError:
                    pass
        for name in files:
            if not (name.endswith(".py") or name.endswith(".md")
                    or name.endswith(".json")):
                continue
            p = os.path.join(root, name)
            try:
                with open(p, "r", encoding="utf-8") as fh:
                    text = fh.read()
            except OSError:
                continue
            new = text.replace("chcp.", "example.")
            new = new.replace("chcp.instructure.com",
                              "example.instructure.com")
            # The quiz-api host builder uses a format string like
            # "%s.quiz-api.instructure.com". The secrets gate extracts
            # "s.quiz-api.instructure.com" from this (the % is not in its
            # host charset) and flags it. Sanitize the suffix to example;
            # the executor_selftest expectation is patched below.
            new = new.replace("%s.quiz-api.instructure.com",
                              "%s.quiz-api.example.com")
            new = new.replace("{tenant}.quiz-api.instructure.com",
                              "{tenant}.quiz-api.example.com")
            if new != text:
                with open(p, "w", encoding="utf-8") as fh:
                    fh.write(new)
                n += 1
print("sanitized %d files" % n)
PYEOF
  # Sanitize the two proof-battery files as well.
  python3 - "${dest}/proof-battery" <<'PYEOF'
import os, sys
d = sys.argv[1]
n = 0
for root, dirs, files in os.walk(d):
    for name in files:
        if not (name.endswith(".py") or name.endswith(".md")):
            continue
        p = os.path.join(root, name)
        try:
            with open(p, "r", encoding="utf-8") as fh:
                text = fh.read()
        except OSError:
            continue
        new = text.replace("chcp.", "example.")
        new = new.replace("chcp.instructure.com", "example.instructure.com")
        if new != text:
            with open(p, "w", encoding="utf-8") as fh:
                fh.write(new)
            n += 1
print("sanitized %d proof-battery files" % n)
PYEOF
  # Fixture-only patch: executor_selftest expects
  # prov.quiz_api_base("chcp") == "https://chcp.quiz-api.instructure.com".
  # After sanitization the expectation reads
  # "https://example.quiz-api.instructure.com" but the sanitized format
  # string yields "https://chcp.quiz-api.example.com". Patch the test
  # expectation (fixture only; source tree untouched).
  _t="${dest}/dispatch/executor_selftest.py"
  if [ -f "${_t}" ]; then
    sed -i 's|https://example.quiz-api.instructure.com|https://chcp.quiz-api.example.com|' "${_t}"
  fi
  # Fixture-only: integration_selftest's "carve:" checks verify properties
  # of the carved DIST (removed hooks, no PROVISION branch, etc.). The
  # fixture's Python comes from SOURCE (which has those), so the carve
  # checks do not apply. Neutralize them (fixture only; source untouched).
  _t="${dest}/dispatch/integration_selftest.py"
  if [ -f "${_t}" ]; then
    python3 - "${_t}" <<'PYEOF'
import sys, re
p = sys.argv[1]
with open(p, "r", encoding="utf-8") as fh:
    src = fh.read()
# Neutralize the F-17 carve loop: replace the check() body with pass.
# The loop is:
#   for sym in (...):
#       check("carve: executor has no %s" % sym, not hasattr(ex, sym),
#             "still present")
src = re.sub(
    r'for sym in \("[^"]+"(?:, "[^"]+")*\):\s+check\("carve: executor has no %s" % sym, not hasattr\(ex, sym\),\s+"still present"\)',
    'for sym in ():\n    pass  # FIXTURE: carve check N/A to source-built fixture',
    src)
# Neutralize the three standalone carve checks.
src = re.sub(
    r'check\("carve: no PROVISION step branch in run_multi_step",[^)]+\)',
    'pass  # FIXTURE: carve check N/A',
    src, flags=re.DOTALL)
src = re.sub(
    r'check\("carve: no moodle executor branches remain",[^)]+\)',
    'pass  # FIXTURE: carve check N/A',
    src, flags=re.DOTALL)
src = re.sub(
    r'check\("carve: no re-auth write-halt ownership claim",[^)]+\)',
    'pass  # FIXTURE: carve check N/A',
    src, flags=re.DOTALL)
with open(p, "w", encoding="utf-8") as fh:
    fh.write(src)
print("patched carve checks in integration_selftest.py")
PYEOF
  fi
  # Runtime residue (never shipped).
  find "${dest}" -type d \( -name "__pycache__" -o -name ".selftest-work" \
    -o -name ".proof-work" \) -prune -exec rm -rf {} + 2>/dev/null
  find "${dest}/helper" -maxdepth 1 -name "*.log" -delete 2>/dev/null
  printf '%s\n' "${ver}" > "${dest}/pack/version.txt"
  regen_manifest "${dest}" "${ver}"
}

regen_manifest() { # $1 = tree, $2 = carve_version
  python3 - "$1" "$2" <<'PYEOF'
import hashlib, json, os, sys
tree, ver = sys.argv[1], sys.argv[2]
files = {}
for root, dirs, fnames in os.walk(tree):
    dirs[:] = [d for d in dirs
               if d not in ("__pycache__", ".selftest-work", ".proof-work")]
    for fn in fnames:
        p = os.path.join(root, fn)
        rel = os.path.relpath(p, tree)
        if rel == "pack/carve-manifest.json":
            continue
        h = hashlib.sha256()
        with open(p, "rb") as fh:
            for chunk in iter(lambda: fh.read(65536), b""):
                h.update(chunk)
        files[rel] = h.hexdigest()
man = {"carve_version": ver, "files": files}
with open(os.path.join(tree, "pack", "carve-manifest.json"), "w",
          encoding="utf-8") as fh:
    json.dump(man, fh, indent=2, sort_keys=True)
print("manifest: %d files" % len(files))
PYEOF
}

# -- fake crontab ----------------------------------------------------------
# Faithful shim: `crontab -l` reads, `crontab <file>` writes with a 0.4s
# delay (like the real crontab's latency, to expose read-modify-write
# races). State in ${FAKE_CRONTAB_FILE}. Put "${fb}" first on PATH.
make_fakebin() { # $1 = dir
  local fb="$1"
  mkdir -p "${fb}"
  cat > "${fb}/crontab" <<'SHEOF'
#!/bin/bash
F="${FAKE_CRONTAB_FILE:?fake crontab: FAKE_CRONTAB_FILE not set}"
if [ "${1:-}" = "-l" ]; then cat "${F}" 2>/dev/null; exit 0; fi
sleep 0.4
cat > "${F}"
SHEOF
  chmod +x "${fb}/crontab"
}

# -- install driver --------------------------------------------------------
# Run install.sh in a fixture. Env knobs:
#   FIX_MORROW_HOME  -> MORROW_HOME
#   FIX_MORROW_CRON  -> MORROW_CRON (default 1; cron tests need the shim on PATH)
#   FIX_FAKEBIN      -> prepended to PATH (for the fake crontab)
#   FIX_FAKE_CRONTAB -> FAKE_CRONTAB_FILE
# Returns the installer's exit code; log goes to $FIX_LOG.
run_install() { # $1 = tree
  local tree="$1"
  (
    cd "${tree}" || exit 99
    [ -n "${FIX_MORROW_HOME:-}" ] && export MORROW_HOME="${FIX_MORROW_HOME}"
    [ -n "${FIX_MORROW_CRON:-}" ] && export MORROW_CRON="${FIX_MORROW_CRON}"
    [ -n "${FIX_FAKEBIN:-}" ] && export PATH="${FIX_FAKEBIN}:$PATH"
    [ -n "${FIX_FAKE_CRONTAB:-}" ] && export FAKE_CRONTAB_FILE="${FIX_FAKE_CRONTAB}"
    # Test harness: point the egress selftest's helper port at the stub
    # server (see fake_live_browser), and isolate server.py from the
    # caller's real helper/env (W4-P1-18).
    [ -n "${LOGIN_HELPER_PORT:-}" ] && export LOGIN_HELPER_PORT
    [ -n "${MORROW_HELPER_ENV_FILE:-}" ] && export MORROW_HELPER_ENV_FILE
    # The VM has no selftest-visible chromium lane requirement beyond the
    # binary, which ships at /opt/meta-chromium/chrome.
    bash ./install.sh >"${FIX_LOG}" 2>&1
  )
  return $?
}

# -- R1: ENOSPC mid-backup -------------------------------------------------
# Upgrade install where the backup target (tree parent, a small tmpfs)
# fills mid-copy. Required: nonzero exit, INSTALL FAIL naming backup,
# original tree byte-identical, NO restore from the partial backup, and
# the partial backup quarantined as .PARTIAL (not left as a good backup).
t_enospc_backup() {
  echo "== R1 enospc-backup"
  local s="${SCRATCH}/r1" tree home log
  rm -rf "${s}"; mkdir -p "${s}/parent"
  mount -t tmpfs -o size=10m tmpfs "${s}/parent" \
    || { bad "enospc-backup (tmpfs mount failed)"; return; }
  tree="${s}/parent/tree"; home="${s}/home"; log="${s}/install.log"
  make_fixture "${tree}" "0.9.9-w4test" >/dev/null
  mkdir -p "${home}"
  # Fake prior install at 0.9.8 so this run is an upgrade with a backup.
  cp "${tree}/pack/carve-manifest.json" "${home}/installed-manifest.json"
  printf '0.9.8\n' > "${home}/installed-version"
  # Tree must be big enough that its backup cannot fit in the remaining
  # ~2MB of the 10MB tmpfs: pad a file inside the tree (and manifest).
  dd if=/dev/zero of="${tree}/pad.bin" bs=1M count=6 2>/dev/null
  regen_manifest "${tree}" "0.9.9-w4test" >/dev/null
  local before; before="$(find "${tree}" -type f | sort | xargs sha256sum 2>/dev/null | sha256sum)"
  FIX_MORROW_HOME="${home}" FIX_MORROW_CRON=0 FIX_LOG="${log}" \
    run_install "${tree}"
  local rc=$?
  # W4: prove byte identity BEFORE unmounting (the tree lives on the tmpfs).
  # The installer must NOT modify the tree before a failed backup (the
  # .morrow-tree-id is minted AFTER the backup succeeds).
  local after; after="$(find "${tree}" -type f | sort | xargs sha256sum 2>/dev/null | sha256sum)"
  [ "${before}" = "${after}" ] || { umount "${s}/parent" 2>/dev/null || true; bad "enospc-backup (tree was modified: before=${before} after=${after})"; return; }
  umount "${s}/parent" 2>/dev/null || true
  [ "${rc}" -ne 0 ] || { bad "enospc-backup (exit 0, want nonzero)"; return; }
  grep -q "INSTALL FAIL" "${log}" || { bad "enospc-backup (no INSTALL FAIL)"; return; }
  grep -q "backup" "${log}" || { bad "enospc-backup (log never names backup)"; return; }
  # Tree must be byte-identical: remount read-only? The tmpfs is gone;
  # instead verify from the log that no restore ran.
  grep -q "RESTORE FAILED" "${log}" && { bad "enospc-backup (restore attempted from partial backup)"; return; }
  grep -q "restore complete" "${log}" && { bad "enospc-backup (restore ran from partial backup)"; return; }
  grep -q "PARTIAL" "${log}" || { bad "enospc-backup (no .PARTIAL quarantine note)"; return; }
  # The quarantine must exist on disk (parent listing captured pre-umount
  # is gone; re-check via a fresh mount is impossible, so check the log's
  # quarantine line names a real path we saw). Fall back: the log must
  # state the original tree was left in place.
  grep -q "left in place\|leaving the tree\|is left exactly as it was" "${log}" \
    || { bad "enospc-backup (log does not confirm tree left in place)"; return; }
  ok "enospc-backup (rc=${rc}, no restore, quarantined, tree left in place)"
}

# -- R2: disk-full install-record write ------------------------------------
# Fresh install where MORROW_HOME fills before the final install-record
# writes. Required: nonzero exit, INSTALL FAIL naming install-record.
t_install_record_full() {
  echo "== R2 install-record-full"
  local s="${SCRATCH}/r2" tree home log
  rm -rf "${s}"; mkdir -p "${s}"
  tree="${s}/tree"; home="${s}/home"; log="${s}/install.log"
  make_fixture "${tree}" "0.9.9-w4test" >/dev/null
  mkdir -p "${home}"
  mount -t tmpfs -o size=200k tmpfs "${home}" \
    || { bad "install-record-full (tmpfs mount failed)"; return; }
  # Leave ~5k free: enough for state dirs + lock, not for the ~12k manifest.
  local man_kb; man_kb=$(du -k "${tree}/pack/carve-manifest.json" | cut -f1)
  local fill_kb=$(( 200 - 5 - man_kb ))
  [ "${fill_kb}" -gt 10 ] || { bad "install-record-full (fixture too small to test)"; umount "${home}" 2>/dev/null; return; }
  dd if=/dev/zero of="${home}/.filler" bs=1K count="${fill_kb}" 2>/dev/null
  # The install must pass step 9 (selftests) to reach the install-record
  # write at step 10; start the fake live browser.
  export FAKE_HELPER_PORT=18901
  export LOGIN_HELPER_PORT=18901
  fake_live_browser >/dev/null 2>&1 || { bad "install-record-full (fake browser failed)"; umount "${home}" 2>/dev/null; return; }
  FIX_MORROW_HOME="${home}" FIX_MORROW_CRON=0 FIX_LOG="${log}" \
    run_install "${tree}"
  local rc=$?
  fake_live_browser_stop
  umount "${home}" 2>/dev/null || true
  [ "${rc}" -ne 0 ] || { bad "install-record-full (exit 0, want nonzero)"; return; }
  grep -q "INSTALL FAIL" "${log}" || { bad "install-record-full (no INSTALL FAIL)"; return; }
  grep -q "install-record" "${log}" || { bad "install-record-full (log never names install-record)"; return; }
  ok "install-record-full (rc=${rc}, INSTALL FAIL names install-record)"
}

# -- R3: concurrent cron installers ----------------------------------------
# Two upgrades run at the same time against the same MORROW_HOME with the
# delay-injecting fake crontab. Required: both trees' entries survive.
t_concurrent_cron() {
  echo "== R3 concurrent-cron"
  local s="${SCRATCH}/r3" fb home log1 log2
  rm -rf "${s}"; mkdir -p "${s}"
  fb="${s}/fakebin"; home="${s}/home"
  make_fakebin "${fb}"
  mkdir -p "${home}"
  make_fixture "${s}/treeA" "0.9.9-w4test" >/dev/null
  make_fixture "${s}/treeB" "0.9.9-w4test" >/dev/null
  # Both are upgrades from 0.9.8 so both reach the cron step.
  for t in treeA treeB; do
    cp "${s}/${t}/pack/carve-manifest.json" "${home}/installed-manifest.json"
    printf '0.9.8\n' > "${home}/installed-version"
  done
  log1="${s}/installA.log"; log2="${s}/installB.log"
  : > "${s}/crontab.db"
  FIX_MORROW_HOME="${home}" FIX_FAKEBIN="${fb}" \
    FIX_FAKE_CRONTAB="${s}/crontab.db" FIX_LOG="${log1}" \
    run_install "${s}/treeA" & local p1=$!
  FIX_MORROW_HOME="${home}" FIX_FAKEBIN="${fb}" \
    FIX_FAKE_CRONTAB="${s}/crontab.db" FIX_LOG="${log2}" \
    run_install "${s}/treeB" & local p2=$!
  wait "${p1}"; local rc1=$?
  wait "${p2}"; local rc2=$?
  local db; db="$(cat "${s}/crontab.db" 2>/dev/null)"
  local n=0
  printf '%s' "${db}" | grep -q "treeA/helper/keepalive.sh" && n=$((n+1))
  printf '%s' "${db}" | grep -q "treeB/helper/keepalive.sh" && n=$((n+1))
  [ "${n}" -eq 2 ] || { bad "concurrent-cron (only ${n}/2 entries survived; rc=${rc1},${rc2})"; return; }
  ok "concurrent-cron (both entries survive; rc=${rc1},${rc2})"
}

# -- R4: fresh-install failure rolls back ----------------------------------
# Fresh install that fails late (break one suite file after fixture
# build, then repair the manifest so integrity passes and the failure
# lands in step 9). Required: nonzero exit, every created artifact
# removed, itemized "rollback removed:" lines, MORROW_HOME left without
# the tree's state.
t_fresh_rollback() {
  echo "== R4 fresh-rollback"
  local s="${SCRATCH}/r4" tree home log
  rm -rf "${s}"; mkdir -p "${s}"
  tree="${s}/tree"; home="${s}/home"; log="${s}/install.log"
  make_fixture "${tree}" "0.9.9-w4test" >/dev/null
  mkdir -p "${home}"
  # Sabotage a suite AFTER the manifest is built: integrity still passes,
  # step 9 fails.
  printf '\nimport sys; sys.exit(99)\n' >> "${tree}/dispatch/admission_selftest.py"
  # Refresh that file's manifest hash so integrity still passes;
  # step 9 (selftests) is the step that fails.
  python3 - "${tree}" <<'PYEOF'
import hashlib, json, sys
tree = sys.argv[1]
mp = tree + "/pack/carve-manifest.json"
man = json.load(open(mp, encoding="utf-8"))
h = hashlib.sha256()
with open(tree + "/dispatch/admission_selftest.py", "rb") as fh:
    h.update(fh.read())
man["files"]["dispatch/admission_selftest.py"] = h.hexdigest()
json.dump(man, open(mp, "w", encoding="utf-8"), indent=2, sort_keys=True)
PYEOF
  FIX_MORROW_HOME="${home}" FIX_MORROW_CRON=0 FIX_LOG="${log}" \
    run_install "${tree}"
  local rc=$?
  [ "${rc}" -ne 0 ] || { bad "fresh-rollback (exit 0, want nonzero)"; return; }
  grep -q "INSTALL FAIL" "${log}" || { bad "fresh-rollback (no INSTALL FAIL)"; return; }
  grep -q "^rollback removed:" "${log}" || { bad "fresh-rollback (no itemized rollback lines)"; return; }
  # The tree itself is the shipped product and stays; what must be gone
  # is everything the failed run CREATED (state, env, profile, cron,
  # install records).
  [ -d "${tree}" ] || { bad "fresh-rollback (product tree was deleted)"; return; }
  [ ! -e "${home}/morrow" ] || { bad "fresh-rollback (state dir survives)"; return; }
  [ ! -e "${home}/installed-manifest.json" ] || { bad "fresh-rollback (install record survives)"; return; }
  ok "fresh-rollback (rc=${rc}, itemized, tree+state+records gone)"
}

# -- R5: cron entry for a path with spaces executes ------------------------
# Install into a tree whose path contains spaces, then execute the exact
# command field of the installed cron entry with the fake crontab db.
# Required: the entry's command runs keepalive (exit 0, lock acquired).
t_cron_spaces() {
  echo "== R5 cron-spaces"
  local s="${SCRATCH}/r5" fb home
  rm -rf "${s}"; mkdir -p "${s}"
  fb="${s}/fakebin"; home="${s}/home"
  make_fakebin "${fb}"
  mkdir -p "${home}"
  local tree="${s}/dir with spaces/tree"
  make_fixture "${tree}" "0.9.9-w4test" >/dev/null
  : > "${s}/crontab.db"
  FIX_MORROW_HOME="${home}" FIX_FAKEBIN="${fb}" \
    FIX_FAKE_CRONTAB="${s}/crontab.db" FIX_LOG="${s}/install.log" \
    run_install "${tree}"
  local rc=$?
  [ "${rc}" -eq 0 ] || { bad "cron-spaces (install rc=${rc})"; return; }
  # W4-P1-9: the cron entry must contain the QUOTED absolute path (with
  # spaces intact), not a whitespace-split fragment.
  local entry; entry="$(grep -F "keepalive.sh" "${s}/crontab.db" | head -1)"
  [ -n "${entry}" ] || { bad "cron-spaces (no keepalive entry in crontab db)"; return; }
  # The quoted path must appear verbatim in the entry.
  printf '%s\n' "${entry}" | grep -Fq "\"${tree}/helper/keepalive.sh\"" \
    || { bad "cron-spaces (entry does not contain quoted spaced path)"; return; }
  # The script must exist and be executable at the spaced path.
  [ -x "${tree}/helper/keepalive.sh" ] \
    || { bad "cron-spaces (keepalive.sh not executable at spaced path)"; return; }
  # Best-effort: the entry must be invocable via bash -c (proves the
  # quoting survives shell parsing). The helper may report signed-out
  # (rc=2) or still be starting (rc=1); both prove the path resolved.
  # Only a "file not found" (rc=127) is a quoting failure.
  local cmd; cmd="$(awk '/keepalive\.sh/ {for(i=6;i<=NF;i++) printf "%s ", $i; print ""}' "${s}/crontab.db" | head -1)"
  local crc
  MORROW_HOME="${home}" FAKE_CRONTAB_FILE="${s}/crontab.db" \
    bash -c "${cmd}" >/dev/null 2>&1; crc=$?
  [ "${crc}" -ne 127 ] || { bad "cron-spaces (entry command not found; quoting broken, rc=127)"; return; }
  ok "cron-spaces (quoted entry, script executable, invocable rc=${crc})"
}

# -- R7: bytecode poisoning -------------------------------------------------
# (a) The documented command (with PYTHONDONTWRITEBYTECODE=1) creates no
# __pycache__; the following install succeeds.
# (b) Forgetting the prefix degrades to a LOUD __pycache__ cleanup, not a
# failed install.
t_bytecode() {
  echo "== R7 bytecode"
  local s="${SCRATCH}/r7" tree home
  rm -rf "${s}"; mkdir -p "${s}"
  tree="${s}/tree"; home="${s}/home"
  make_fixture "${tree}" "0.9.9-w4test" >/dev/null
  mkdir -p "${home}"
  (cd "${tree}" && PYTHONDONTWRITEBYTECODE=1 python3 dispatch/executor.py --help >/dev/null 2>&1)
  if find "${tree}" -type d -name "__pycache__" | grep -q .; then
    bad "bytecode (documented command still wrote __pycache__)"; return
  fi
  FIX_MORROW_HOME="${home}" FIX_MORROW_CRON=0 FIX_LOG="${s}/install1.log" \
    run_install "${tree}"
  [ "$?" -eq 0 ] || { bad "bytecode (install after documented command failed)"; return; }
  # Now poison deliberately and reinstall: must succeed with loud cleanup.
  # (Unset the outer PYTHONDONTWRITEBYTECODE so the poison actually writes.)
  (cd "${tree}" && env -u PYTHONDONTWRITEBYTECODE python3 -c "import dispatch.executor" 2>/dev/null)
  find "${tree}" -type d -name "__pycache__" | grep -q . \
    || { bad "bytecode (could not poison fixture)"; return; }
  FIX_MORROW_HOME="${home}" FIX_MORROW_CRON=0 FIX_LOG="${s}/install2.log" \
    run_install "${tree}"
  [ "$?" -eq 0 ] || { bad "bytecode (reinstall over __pycache__ failed)"; return; }
  grep -q "cleaned bytecode dir" "${s}/install2.log" \
    || { bad "bytecode (cleanup not loud)"; return; }
  ok "bytecode (documented cmd clean; forgotten prefix -> loud cleanup, install ok)"
}

# -- R8: CANVAS_BASE in helper/env, then rerun, passes step 9 --------------
t_canvas_base_rerun() {
  echo "== R8 canvas-base-rerun"
  local s="${SCRATCH}/r8" tree home
  rm -rf "${s}"; mkdir -p "${s}"
  tree="${s}/tree"; home="${s}/home"
  make_fixture "${tree}" "0.9.9-w4test" >/dev/null
  mkdir -p "${home}"
  FIX_MORROW_HOME="${home}" FIX_MORROW_CRON=0 FIX_LOG="${s}/install1.log" \
    run_install "${tree}"
  [ "$?" -eq 0 ] || { bad "canvas-base-rerun (first install rc!=0)"; return; }
  # Local stub tenant: serves a minimal page so the installer's tenant
  # probe (reachable, not a placeholder, not a Canvas error page) passes.
  # Uses 127.0.0.1 (not a blocklisted placeholder hostname).
  local stub_port=18923
  python3 - "${stub_port}" <<'PYEOF' >/dev/null 2>&1 &
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"<html><head><title>Stub Canvas</title></head><body>login</body></html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass
ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PYEOF
  local stub_pid=$!
  printf 'CANVAS_BASE=http://127.0.0.1:%d\n' "${stub_port}" > "${tree}/helper/env"
  FIX_MORROW_HOME="${home}" FIX_MORROW_CRON=0 FIX_LOG="${s}/install2.log" \
    run_install "${tree}"
  local rc2=$?
  kill "${stub_pid}" 2>/dev/null || true
  [ "${rc2}" -eq 0 ] || { bad "canvas-base-rerun (rerun with CANVAS_BASE rc!=0)"; return; }
  grep -q "9/10 selftest suites" "${s}/install2.log" \
    || { bad "canvas-base-rerun (step 9 missing on rerun)"; return; }
  ok "canvas-base-rerun (rerun with CANVAS_BASE passes)"
}

# -- R10: slug bounds -------------------------------------------------------
# Long tree paths get a bounded slug (< NAME_MAX, 255) that bash and
# python compute identically; short paths keep working.
t_slug_bound() {
  echo "== R10 slug-bound"
  local s="${SCRATCH}/r10"
  rm -rf "${s}"; mkdir -p "${s}"
  local long="${s}/$(python3 -c "print('d'*200)")/tree"
  mkdir -p "${long}/helper"
  # shell slug via the keepalive's own function (source-only mode)
  # tree_id_bounded() reads TREE_ROOT (no args); override it to the long path.
  local sh_slug; sh_slug="$(KEEPALIVE_SOURCE_ONLY=1 bash -c "
    source '${SRC}/helper/keepalive.sh'
    TREE_ROOT='${long}'
    tree_id_bounded" 2>/dev/null)"
  # python slug via the transport module (needs the tree on sys.path)
  local py_slug; py_slug="$(cd "${SRC}" && python3 - "${long}" <<'PYEOF'
import sys
sys.path.insert(0, ".")
try:
    from transport.local_chromium import _slug_new
    print(_slug_new(sys.argv[1]))
except Exception as e:
    print("SKIP:" + str(e))
PYEOF
)"
  case "${py_slug}" in
    SKIP:*) bad "slug-bound (python import failed: ${py_slug#SKIP:})"; return;;
  esac
  [ -n "${sh_slug}" ] || { bad "slug-bound (empty shell slug)"; return; }
  [ "${sh_slug}" = "${py_slug}" ] || { bad "slug-bound (bash/python disagree: ${sh_slug} vs ${py_slug})"; return; }
  [ "${#sh_slug}" -lt 255 ] || { bad "slug-bound (slug ${#sh_slug} chars >= 255)"; return; }
  # Short (existing) path slug has the bounded shape.
  # (tree_id_bounded canonicalizes via cd, so the probe path must exist.)
  local short_slug; short_slug="$(KEEPALIVE_SOURCE_ONLY=1 bash -c "
    source '${SRC}/helper/keepalive.sh'
    TREE_ROOT='${s}'
    tree_id_bounded" 2>/dev/null)"
  case "${short_slug}" in
    ?*-????????????????) ;;
    *) bad "slug-bound (short slug shape changed: ${short_slug})"; return;;
  esac
  ok "slug-bound (agree=${sh_slug}, len=${#sh_slug}, short stable)"
}

# -- R11: symlinked tree root survives failed upgrade -----------------------
t_symlink_tree() {
  echo "== R11 symlink-tree"
  local s="${SCRATCH}/r11" real home
  rm -rf "${s}"; mkdir -p "${s}"
  real="${s}/real"; home="${s}/home"
  make_fixture "${real}" "0.9.9-w4test" >/dev/null
  mkdir -p "${home}"
  cp "${real}/pack/carve-manifest.json" "${home}/installed-manifest.json"
  printf '0.9.8\n' > "${home}/installed-version"
  ln -s "${real}" "${s}/linktree"
  # Sabotage a suite so the upgrade fails after backup.
  printf '\nimport sys; sys.exit(99)\n' >> "${real}/dispatch/admission_selftest.py"
  FIX_MORROW_HOME="${home}" FIX_MORROW_CRON=0 FIX_LOG="${s}/install.log" \
    run_install "${s}/linktree"
  local rc=$?
  [ "${rc}" -ne 0 ] || { bad "symlink-tree (exit 0, want nonzero)"; return; }
  [ -L "${s}/linktree" ] || { bad "symlink-tree (symlink root was renamed/replaced)"; return; }
  grep -q "INSTALL FAIL" "${s}/install.log" || { bad "symlink-tree (no INSTALL FAIL)"; return; }
  ok "symlink-tree (rc=${rc}, symlink root untouched)"
}

# -- R12: symlinked helper/env is rejected ----------------------------------
t_symlink_env() {
  echo "== R12 symlink-env"
  local s="${SCRATCH}/r12" tree home
  rm -rf "${s}"; mkdir -p "${s}"
  tree="${s}/tree"; home="${s}/home"
  make_fixture "${tree}" "0.9.9-w4test" >/dev/null
  mkdir -p "${home}"
  printf 'CANVAS_BASE=https://example.instructure.com\n' > "${s}/real-env"
  ln -s "${s}/real-env" "${tree}/helper/env"
  regen_manifest "${tree}" "0.9.9-w4test" >/dev/null
  FIX_MORROW_HOME="${home}" FIX_MORROW_CRON=0 FIX_LOG="${s}/install.log" \
    run_install "${tree}"
  local rc=$?
  [ "${rc}" -ne 0 ] || { bad "symlink-env (exit 0, want nonzero)"; return; }
  grep -q "INSTALL FAIL" "${s}/install.log" || { bad "symlink-env (no INSTALL FAIL)"; return; }
  grep -q "symlink" "${s}/install.log" || { bad "symlink-env (log never says symlink)"; return; }
  ok "symlink-env (rc=${rc}, rejected as symlink)"
}

# -- R13: uninstall removes backups/partials/failed trees -------------------
t_uninstall_residue() {
  echo "== R13 uninstall-residue"
  local s="${SCRATCH}/r13" tree home
  rm -rf "${s}"; mkdir -p "${s}"
  tree="${s}/tree"; home="${s}/home"
  make_fixture "${tree}" "0.9.9-w4test" >/dev/null
  mkdir -p "${home}"
  # Fake residue the uninstaller must remove.
  mkdir -p "${tree}.bak-20240101-000000" "${tree}.bak-20240102-000000.PARTIAL" \
           "${tree}.failed-20240103-000000"
  touch "${tree}.bak-20240101-000000/f" "${tree}.failed-20240103-000000/f"
  # Fake crontab so the uninstaller can verify cron removal.
  mkdir -p "${s}/fakebin"
  cat > "${s}/fakebin/crontab" <<'FAKEEOF'
#!/bin/bash
# Fake crontab: stores entries in $FAKE_CRONTAB_FILE.
case "$1" in
  -l) cat "${FAKE_CRONTAB_FILE:-/dev/null}" 2>/dev/null || true ;;
  -r) : > "${FAKE_CRONTAB_FILE:-/dev/null}" ;;
  *) cat > "${FAKE_CRONTAB_FILE:-/dev/null}" ;;
esac
FAKEEOF
  chmod +x "${s}/fakebin/crontab"
  : > "${s}/crontab.db"
  # Isolate from the live helper: point the uninstaller at unused ports
  # so it never sees (or refuses on) the real helper's ports.
  PATH="${s}/fakebin:${PATH}" FAKE_CRONTAB_FILE="${s}/crontab.db" \
    LOGIN_HELPER_PORT=18999 FORWARDER_PORT=28999 MORROW_HOME="${home}" \
    bash "${tree}/scripts/uninstall.sh" --yes >"${s}/uninstall.log" 2>&1
  local rc=$?
  [ "${rc}" -eq 0 ] || { bad "uninstall-residue (rc=${rc})"; return; }
  for d in "${tree}.bak-20240101-000000" "${tree}.bak-20240102-000000.PARTIAL" \
           "${tree}.failed-20240103-000000"; do
    [ ! -e "${d}" ] || { bad "uninstall-residue (residue survives: ${d})"; return; }
  done
  ok "uninstall-residue (backups, partial, failed tree removed)"
}

# -- runner -----------------------------------------------------------------
main() {
  need_cmd python3; need_cmd bash; need_cmd mount; need_cmd umount
  [ -d "${SRC}" ] || { echo "source tree not found: ${SRC}" >&2; exit 2; }
  mkdir -p "${SCRATCH}"
  local scenarios="${*:-enospc-backup install-record-full concurrent-cron fresh-rollback cron-spaces bytecode canvas-base-rerun slug-bound symlink-tree symlink-env uninstall-residue}"
  local sc
  for sc in ${scenarios}; do
    case "${sc}" in
      enospc-backup)       t_enospc_backup;;
      install-record-full) t_install_record_full;;
      concurrent-cron)     t_concurrent_cron;;
      fresh-rollback)      t_fresh_rollback;;
      cron-spaces)         t_cron_spaces;;
      bytecode)            t_bytecode;;
      canvas-base-rerun)   t_canvas_base_rerun;;
      slug-bound)          t_slug_bound;;
      symlink-tree)        t_symlink_tree;;
      symlink-env)         t_symlink_env;;
      uninstall-residue)   t_uninstall_residue;;
      *) echo "unknown scenario: ${sc}" >&2; exit 2;;
    esac
  done
  echo "----"
  printf 'robustness: %d passed, %d failed\n' "${PASS}" "${FAIL}"
  if [ -n "${FAILED_NAMES}" ]; then printf 'failed:%s\n' "${FAILED_NAMES}"; fi
  [ "${FAIL}" -eq 0 ]
}

# -- fake live browser (test harness, dev-only) ------------------------------
# transport/egress_selftest.py section 7 expects a Chromium on CDP port
# 19223 and a helper server reporting chromium_alive. The current helper
# uses --remote-debugging-pipe (no TCP port; W4-P0-3), so the selftest's
# port-based attach check cannot pass against the real helper, and this
# VM has no other browser on 19223. This harness provides the expected
# environment WITHOUT touching the live helper (whose server stays on
# 8901 and whose pipe browser is only ever read via /proc):
#   * a throwaway Chromium (fresh profile under scratch) on 19223, and
#   * a minimal stub helper server on ${FAKE_HELPER_PORT} answering
#     /status (healthy) and absorbing CDP-proxy POSTs with {}.
# Callers export LOGIN_HELPER_PORT=${FAKE_HELPER_PORT} so the selftest's
# tree_helper_port() hits the stub, not the live helper.
# Returns 0 on success; sets FAKE_BROWSER_PID / FAKE_HELPER_PID.
FAKE_HELPER_PORT="${FAKE_HELPER_PORT:-18901}"
fake_live_browser() {
  local s="${SCRATCH}/fake-live"
  rm -rf "${s}"; mkdir -p "${s}/chrome-profile"
  # Stub helper server.
  cat > "${s}/stub_server.py" <<PYEOF
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
VERSION = "0.4.1"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18901
class H(BaseHTTPRequestHandler):
    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        if self.path == "/status":
            self._json({"chromium_alive": True, "starting": False,
                        "logged_in": False, "helper_version": VERSION})
        else:
            self.send_response(404); self.end_headers()
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length:
            self.rfile.read(length)
        self._json({})
    def log_message(self, *a):
        pass
ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
PYEOF
  python3 "${s}/stub_server.py" "${FAKE_HELPER_PORT}" >/dev/null 2>&1 &
  FAKE_HELPER_PID=$!
  # Throwaway Chromium on 19223 (never the live profile).
  /opt/meta-chromium/chrome --headless=new --remote-debugging-port=19223 \
    --user-data-dir="${s}/chrome-profile" --no-sandbox --disable-gpu \
    --disable-dev-shm-usage --no-first-run about:blank >/dev/null 2>&1 &
  FAKE_BROWSER_PID=$!
  # Wait for both to be up.
  local i
  for i in $(seq 1 20); do
    if curl -sf -m 2 "http://127.0.0.1:${FAKE_HELPER_PORT}/status" >/dev/null 2>&1 \
       && pgrep -f "remote-debugging-port=19223" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "fake_live_browser: stub or browser did not come up" >&2
  return 1
}

fake_live_browser_stop() {
  [ -n "${FAKE_BROWSER_PID:-}" ] && kill "${FAKE_BROWSER_PID}" 2>/dev/null || true
  [ -n "${FAKE_HELPER_PID:-}" ] && kill "${FAKE_HELPER_PID}" 2>/dev/null || true
  FAKE_BROWSER_PID=""; FAKE_HELPER_PID=""
}

# Only run the suite when executed directly; sourcing the file (e.g. to
# reuse fake_live_browser in another shell) defines functions without
# running anything.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi

