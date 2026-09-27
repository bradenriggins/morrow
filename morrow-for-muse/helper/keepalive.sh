#!/bin/bash
# Keep-alive for the Morrow Canvas login helper (helper/server.py).
# Ensures exactly one healthy helper instance runs. Runs every five
# minutes, supervised by cron where the machine has it, otherwise by the
# background loop in helper/supervisor.py (install.sh picks; the Muse VM
# has no cron daemon). Self-heals after VM restarts: with cron,
# supervision resumes at the next five-minute tick; without cron, run
# `bin/morrow start` (the first morrow command also restarts the loop).
#
# Install: install.sh sets up supervision. By hand with cron:
#   */5 * * * * /path/to/tree/helper/keepalive.sh
#
# Uninstall: removing the supervision (cron entry or loop) is MANDATORY.
# If it survives, it will relaunch the helper within five minutes,
# resurrecting an "uninstalled" connector. Use scripts/uninstall.sh,
# which stops the loop and verifies the cron entry is gone.
#
# Configuration is TREE-SCOPED (W2-P1-27): ${HELPER_DIR}/env (this tree's
# own env file) is sourced with setdefault semantics (the real environment
# wins). The legacy global ~/.morrow/env is honored ONLY for CANVAS_BASE;
# profile/port/production vars found there are IGNORED with a loud
# warning, so one global file can never cross-configure every tree.
#   CANVAS_BASE=https://myschool.instructure.com
#
# Tree identity: every destructive decision is gated on THIS tree. The
# keepalive lock, the port-holder kill check, the Chromium reap, and the
# forwarder reap all resolve the tree from the script's own location and
# refuse to act on another tree's processes. Two trees on one VM never
# fight.
#
# Health model:
#  * The /status probe retries with backoff before any recovery. Each
#    attempt allows 20s: server.py's /status runs a CDP evaluate with a
#    15s timeout, so a healthy-but-slow helper can legitimately take
#    ~15s+ to answer. A probe budget shorter than that would
#    recover-against a healthy helper (W2-P1-7).
#  * When the port is OPEN but /status never answered inside the budget,
#    the server is treated as slow-but-alive: one full extra probe round
#    runs before any verdict. Recovery is never triggered on a timeout
#    alone.
#  * HTTP 200 alone is NOT healthy: the /status JSON is parsed and
#    logged_in:false with chromium_alive:false is RECOVERABLE (dead
#    Chromium; restart it), while logged_in:false with chromium_alive:true
#    and starting:false is a genuine signed-out session (exit 2; the
#    script never attempts a sign-in, it only reports). Exit 2 is emitted
#    ONLY for that exact state. A server that omits chromium_alive
#    (older server.py) reports unknown: a missing field never reads as
#    dead (no restart on a guess) and never reads as signed-out (no
#    exit 2 on a guess).
#  * A healthy /status whose helper_version differs from this tree's
#    VERSION is a stale pre-upgrade server squatting the port: it is
#    recycled (tree-gated kill + relaunch), never adopted (W2-P1-16).
#  * "starting" (chromium alive, tab not landed) is a slow boot, not a
#    sign-out: the probe window is extended before any verdict.
#  * The Chromium reap is scoped to helper-owned processes: a PID is only
#    killed after its exact --user-data-dir argv value resolves to this
#    tree's profile dir (exact argv-element match, never a substring).
#  * kill_helper_server verifies the port holder IS this tree's helper
#    server: one argv element must be exactly ${HELPER_DIR}/server.py
#    AND the process's cwd must resolve to ${HELPER_DIR} (W3-P0-20:
#    exact element match, never a substring; myserver.py, server.py.bak,
#    editors, and tail -f are all refused). A foreign tree's server is
#    never killed -- recovery aborts loudly instead (W2-P0-6, W2-P1-31).
#  * After a relaunch, the adopted browser's --user-data-dir is verified
#    against the pinned profile; a foreign browser on our CDP port is
#    never served under our /status (W2-P1-14).
#  * Overlapping runs are serialized with flock -n on a PER-TREE lock
#    under ~/.morrow/trees/<tree-id>/keepalive.lock (W2-P1-30): two trees
#    keepalives never contend, and no runtime residue lands in the
#    package tree.
#  * Logs live in the same per-tree state dir: keepalive.log (this
#    script) and server.log (the helper server's output), each with its
#    rotated archives. Never in the tree: install.sh's secrets gate and
#    integrity walk read the tree as release content.
#
# Exit codes:
#  * 0: healthy (helper responding, logged_in:true); a lock-contended run
#       that skipped itself also exits 0
#  * 1: unrecoverable (helper down and could not be recovered, recovery
#       aborted because the port holder is not this tree's helper server,
#       the /status JSON was unparseable, or the status was indeterminate:
#       logged_in=false but liveness/starting unproven, so not a
#       confirmed sign-out)
#  * 2: helper responding, Chromium alive, not starting, but logged_in:false
#       (genuine session signed out). Reported, no recovery attempted;
#       exit 2 means only this. Unknown liveness (legacy server),
#       malformed status, dead Chromium after recovery, or a still-starting
#       helper never exit 2.
set -u

HELPER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE_ROOT="$(cd "${HELPER_DIR}/.." && pwd)"

# --- tree-scoped configuration (W2-P1-27) ---------------------------------
_source_tree_env() {
  # $1 = env file. Parses KEY=VALUE lines (blanks/# comments skipped, one
  # optional leading "export " tolerated, one layer of matching quotes
  # stripped) with setdefault semantics: the real environment wins.
  local file="$1" line key val
  [ -f "${file}" ] || return 0
  while IFS= read -r line || [ -n "${line}" ]; do
    line="${line#"${line%%[![:space:]]*}"}"   # ltrim
    case "${line}" in ""|\#*) continue ;; esac
    line="${line#export }"
    line="${line#export	}"
    case "${line}" in *=*) ;; *) continue ;; esac
    key="${line%%=*}"; val="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"     # rtrim key
    case "${key}" in ""|*[!a-zA-Z0-9_]*|[0-9]*) continue ;; esac
    case "${val}" in
      \'*\') val="${val#\'}"; val="${val%\'}";;
      \"*\") val="${val#\"}"; val="${val%\"}";;
    esac
    if [ -z "${!key+x}" ]; then
      export "${key}=${val}"
    fi
  done < "${file}"
}

TREE_ENV_FILE="${HELPER_DIR}/env"
_source_tree_env "${TREE_ENV_FILE}"
if [ -n "${LOGIN_HELPER_PROFILE_DIR:-}" ] \
    && [ "${LOGIN_HELPER_PROFILE_DIR}" != "${HELPER_DIR}/profile" ]; then
  printf 'keepalive: WARNING: ignoring LOGIN_HELPER_PROFILE_DIR=%s; this tree'"'"'s helper profile is always %s\n' \
    "${LOGIN_HELPER_PROFILE_DIR}" "${HELPER_DIR}/profile" >&2
fi

# Legacy global env: CANVAS_BASE only. MORROW_LEGACY_ENV is the test seam
# (selftests point it at scratch); production reads <MORROW_HOME>/env
# (W4-P1-17: the legacy global env lives under the unified state root).
MORROW_LEGACY_ENV="${MORROW_LEGACY_ENV:-${MORROW_HOME:-${HOME}/.morrow}/env}"
if [ -f "${MORROW_LEGACY_ENV}" ]; then
  _legacy_canvas_base="$(sed -n 's/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}CANVAS_BASE=\(.*\)/\2/p' "${MORROW_LEGACY_ENV}" | tail -1)"
  _legacy_canvas_base="${_legacy_canvas_base#\'}"; _legacy_canvas_base="${_legacy_canvas_base%\'}"
  _legacy_canvas_base="${_legacy_canvas_base#\"}"; _legacy_canvas_base="${_legacy_canvas_base%\"}"
  if [ -z "${CANVAS_BASE:-}" ] && [ -n "${_legacy_canvas_base}" ]; then
    CANVAS_BASE="${_legacy_canvas_base}"
    export CANVAS_BASE
  fi
  for _k in LOGIN_HELPER_PROFILE_DIR LOGIN_HELPER_PORT LOGIN_HELPER_CDP_PORT \
           LOGIN_HELPER_BIND LOGIN_HELPER_PRODUCTION; do
    if grep -qE "^[[:space:]]*(export[[:space:]]+)?${_k}=" "${MORROW_LEGACY_ENV}" 2>/dev/null; then
      printf 'keepalive: WARNING: ignoring %s from the global %s (profile/port settings are tree-scoped now); move it to %s\n' \
        "${_k}" "${MORROW_LEGACY_ENV}" "${TREE_ENV_FILE}" >&2
    fi
  done
  unset _k _legacy_canvas_base
fi

# --- tree identity (W2-P0-6, W2-P1-30) ------------------------------------
tree_id_legacy() {
  # W4-P2-13: the pre-bounding slug, unbounded. Only used for the
  # dual-lookup below so existing installs keep resolving their state
  # dir; never minted for new installs.
  # NOTE (W3-P1-19): the legacy slug is NOT injective (morrow-a_b,
  # morrow-a-b, morrow-a.b, MORROW_A_B all slug identically). Colliding
  # trees are detected at startup via ${TREE_STATE_DIR}/tree_path
  # (FATAL), never silently shared.
  ( cd "${TREE_ROOT}" && pwd -P ) \
    | sed -e 's/[^A-Za-z0-9][^A-Za-z0-9]*/_/g' -e 's/^_//' -e 's/_$//' \
    | tr 'A-Z' 'a-z'
}
tree_id_bounded() {
  # W4-P2-13: BOUNDED slug: <first 48 chars of the sanitized slug>-
  # <first 16 hex of sha256(canonical path)>. Max 65 chars, always
  # NAME_MAX-safe, human-recognizable, and the hash keeps distinct paths
  # distinct when the readable prefix collides. Same algorithm as
  # transport/local_chromium.py tree_id() and dispatch/executor.py
  # _tree_id(): every non-alphanumeric run becomes '_', lowercased, no
  # leading/trailing '_', then truncated+hashed.
  local _tp _san _prefix _digest
  _tp="$(cd "${TREE_ROOT}" && pwd -P)"
  _san="$(printf '%s' "${_tp}" \
    | sed -e 's/[^A-Za-z0-9][^A-Za-z0-9]*/_/g' -e 's/^_//' -e 's/_$//' \
    | tr 'A-Z' 'a-z')"
  _prefix="$(printf '%s' "${_san}" | cut -c1-48)"
  [ -n "${_prefix}" ] || _prefix="tree"
  # python3 (not sha256sum) for the digest: macOS ships no sha256sum,
  # and python3 is a hard requirement of this connector.
  _digest="$(printf '%s' "${_tp}" | python3 -c \
    'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest()[:16])')"
  printf '%s-%s' "${_prefix}" "${_digest}"
}
_tree_uuid() {
  # W4-P1-16: the install-time stable UUID from .morrow-tree-id, printed
  # only when it is UUID-shaped (32 hex chars after stripping dashes;
  # this normalization matches config/paths.py read_tree_uuid, so every
  # reader agrees on the same tree id). Empty otherwise.
  local _uf="${TREE_ROOT}/.morrow-tree-id" _u
  [ -f "${_uf}" ] || return 0
  _u="$(tr -d '[:space:]-' < "${_uf}" | tr 'A-Z' 'a-z')"
  case "${_u}" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
      printf '%s' "${_u}" ;;
  esac
  return 0
}
tree_id() {
  # W4-P1-16: prefer the install-time stable UUID in
  # ${TREE_ROOT}/.morrow-tree-id (minted by install.sh), so moving the
  # tree keeps the state dir, journal path, and op-id idempotency
  # instead of resetting them. Only a UUID-shaped (32 hex chars)
  # value is trusted from the file; anything else falls back to the
  # bounded path slug.
  local _uuid
  _uuid="$(_tree_uuid)"
  if [ -n "${_uuid}" ]; then
    printf '%s' "${_uuid}"
    return
  fi
  if [ -f "${TREE_ROOT}/.morrow-tree-id" ]; then
    printf 'keepalive: WARNING: %s/.morrow-tree-id is not a UUID; falling back to legacy path-slug tree id\n' \
      "${TREE_ROOT}" >&2
  fi
  tree_id_bounded
}
tree_version() {
  # This tree's VERSION marker, or "unknown" when the file is absent.
  if [ -f "${TREE_ROOT}/VERSION" ]; then
    awk 'NF{print $1; exit}' "${TREE_ROOT}/VERSION"
  else
    printf 'unknown'
  fi
}
TREE_ID="$(tree_id)"
[ -n "${TREE_ID}" ] || TREE_ID="tree"
TREE_VERSION="$(tree_version)"
# MORROW_HOME / MORROW_TREE_STATE_DIR are honored when set (tests, ops).
MORROW_HOME_DIR="${MORROW_HOME:-${HOME}/.morrow}"
_USING_LEGACY_SLUG=0
if [ -z "$(_tree_uuid)" ]; then
  # W4-P2-13: dual-lookup (only when the UUID fallback was NOT used).
  # An existing install keeps its legacy (unbounded) slug: when the
  # legacy state dir exists and the new bounded one does not, the
  # legacy slug still resolves, so nothing is orphaned. New installs
  # always mint the bounded slug.
  _TID_LEGACY="$(tree_id_legacy)"
  [ -n "${_TID_LEGACY}" ] || _TID_LEGACY="tree"
  if [ "${TREE_ID}" != "${_TID_LEGACY}" ] \
     && [ -z "${MORROW_TREE_STATE_DIR:-}" ] \
     && [ -d "${MORROW_HOME_DIR}/trees/${_TID_LEGACY}" ] \
     && [ ! -d "${MORROW_HOME_DIR}/trees/${TREE_ID}" ]; then
    TREE_ID="${_TID_LEGACY}"
    _USING_LEGACY_SLUG=1
  fi
  unset _TID_LEGACY
fi
TREE_STATE_DIR="${MORROW_TREE_STATE_DIR:-${MORROW_HOME_DIR}/trees/${TREE_ID}}"
LOCKFILE="${TREE_STATE_DIR}/keepalive.lock"

STATUS_URL="${STATUS_URL:-http://127.0.0.1:${LOGIN_HELPER_PORT:-8901}/status}"
# W6-P2-8: when the helper serves TLS (LOGIN_HELPER_TLS_CERT/KEY set),
# probe it over https. Verification pins to the configured cert file
# itself (--cacert): the loopback cert is typically self-signed, and
# trusting exactly that file is stronger than -k. -k only when the
# operator explicitly opts into insecure loopback bring-up via
# LOGIN_HELPER_TLS_INSECURE=1.
_HELPER_CURL_TLS_FLAG=""
case "${STATUS_URL}" in
  http://127.0.0.1:*|http://localhost:*)
    if [ -n "${LOGIN_HELPER_TLS_CERT:-}" ] \
       && [ -n "${LOGIN_HELPER_TLS_KEY:-}" ]; then
      STATUS_URL="https://${STATUS_URL#http://}"
      if [ "${LOGIN_HELPER_TLS_INSECURE:-}" = "1" ]; then
        _HELPER_CURL_TLS_FLAG="-k"
      elif [ -f "${LOGIN_HELPER_TLS_CERT:-}" ]; then
        _HELPER_CURL_TLS_FLAG="--cacert ${LOGIN_HELPER_TLS_CERT}"
      else
        _HELPER_CURL_TLS_FLAG="-k"
      fi
    fi
    ;;
esac
PROFILE_DIR="${HELPER_DIR}/profile"
KEEPALIVE_LOG="${TREE_STATE_DIR}/keepalive.log"
SERVER_LOG="${TREE_STATE_DIR}/server.log"
# W5-P2-2: keepalive.log rotation. Size-based, checked on every log()
# call: at 1 MiB the log shifts to keepalive.log.1 (..2, ..3, oldest
# dropped). Copy-truncate is unnecessary here (log() opens the file
# fresh per call), so plain renames are safe.
KEEPALIVE_LOG_MAX_BYTES=1048576
KEEPALIVE_LOG_KEEP=3
SERVER_PORT="${LOGIN_HELPER_PORT:-8901}"
# P2-7: the tree identity label is configurable (LOGIN_HELPER_CDP_PORT);
# the reap and restart paths below resolve it instead of a literal
# 19223. W4-P0-3: this number opens nothing; Chromium runs with
# --remote-debugging-pipe and has no TCP debug port. Process identity
# is the exact --remote-debugging-pipe argv element plus the
# --user-data-dir value.
CDP_PORT="${LOGIN_HELPER_CDP_PORT:-19223}"
# W2-P1-33: per-tree forwarder port, derived from the tree's CDP port
# (+10000). Explicit FORWARDER_PORT (or MORROW_FORWARDER_PORT, shared
# with the Python launcher) wins. Two trees never share an upstream
# forwarder.
# W3-P2-15 precondition: the +10000 derivation is only valid below the
# ephemeral range. A derived port >= 32768 (the Linux ephemeral range
# floor) would collide with outbound ephemeral ports: FATAL at startup
# with a clear message instead of supervising a collision-prone port.
# (An explicit FORWARDER_PORT/MORROW_FORWARDER_PORT pin is the
# operator's deliberate choice and bypasses this check.)
if [ -n "${FORWARDER_PORT:-}" ]; then
  : # explicit pin wins; the operator asked for it
elif [ -n "${MORROW_FORWARDER_PORT:-}" ]; then
  FORWARDER_PORT="${MORROW_FORWARDER_PORT}"
else
  _derived_fwd="$((CDP_PORT + 10000))"
  if [ "${_derived_fwd}" -ge 32768 ]; then
    printf 'keepalive: FATAL: derived forwarder port %s (CDP port %s + 10000) lands in the ephemeral range (>= 32768); pick a CDP port below 22768 or pin FORWARDER_PORT explicitly\n' \
      "${_derived_fwd}" "${CDP_PORT}" >&2
    exit 1
  fi
  FORWARDER_PORT="${_derived_fwd}"
fi
unset _derived_fwd
PROBE_ATTEMPTS=3
PROBE_BASE_DELAY=2   # seconds; doubles between attempts (2s, 4s)
# W2-P1-7: each probe attempt allows 20s. server.py's /status runs a CDP
# evaluate with timeout=15s, so a healthy-but-slow helper legitimately
# takes ~15s+ to answer; a shorter budget would recover-against a
# healthy helper.
PROBE_TIMEOUT="${PROBE_TIMEOUT:-20}"
# P2-6: RESTART_WAIT is a deliberate 25s default (the documented value):
# long enough for Chromium to relaunch and land on the tenant, short
# enough to keep recovery snappy. Slow VMs can export RESTART_WAIT=45.
RESTART_WAIT="${RESTART_WAIT:-25}"

# P2-5: soft prereq check (warn, not fatal): the probe/reap paths need
# curl (HTTP) and ss (port holder). Process scans enumerate
# /proc/[0-9]*/cmdline directly; pgrep is not used anywhere.
for _tool in curl ss; do
  command -v "${_tool}" >/dev/null 2>&1 \
    || printf 'keepalive: WARNING: %s not found on PATH; probe/reap may fail\n' \
         "${_tool}" >&2
done
unset _tool

_rotate_keepalive_log() {
  # W5-P2-2: rotate keepalive.log past 1 MiB, keeping 3 archives.
  # Best-effort: rotation must never break logging itself.
  local size i
  size="$(wc -c < "${KEEPALIVE_LOG}" 2>/dev/null | tr -d ' ' || echo 0)"
  case "${size}" in ''|*[!0-9]*) size=0 ;; esac
  [ "${size}" -le "${KEEPALIVE_LOG_MAX_BYTES}" ] && return 0
  rm -f "${KEEPALIVE_LOG}.${KEEPALIVE_LOG_KEEP}" 2>/dev/null || true
  i=$((KEEPALIVE_LOG_KEEP - 1))
  while [ "${i}" -ge 1 ]; do
    [ -f "${KEEPALIVE_LOG}.${i}" ] \
      && mv "${KEEPALIVE_LOG}.${i}" "${KEEPALIVE_LOG}.$((i + 1))" 2>/dev/null || true
    i=$((i - 1))
  done
  mv "${KEEPALIVE_LOG}" "${KEEPALIVE_LOG}.1" 2>/dev/null || true
}

log() { _rotate_keepalive_log; printf '%s %s\n' "$(date '+%F %T %Z')" "$*" >> "${KEEPALIVE_LOG}"; }

_helper_token_shape_ok() {
  # W6-P2-3: a helper token is exactly 64 hex chars. Anything else
  # (empty, truncated, non-hex) is malformed: a short token would be
  # brute-forceable inside the rate limit, so it must never be served.
  printf '%s' "${1:-}" | grep -qE '^[0-9a-f]{64}$' 2>/dev/null
}

_helper_token_minted_at() {
  # Echo the epoch the current helper token was minted, or nothing.
  # Prefers helper_token.meta (written at mint); falls back to the
  # token file's mtime for pre-upgrade tokens.
  local meta="${TREE_STATE_DIR}/helper_token.meta" minted
  minted="$(sed -n 's/^minted_at=//p' "${meta}" 2>/dev/null | head -n 1)"
  case "${minted}" in ''|*[!0-9]*) minted="" ;; esac
  if [ -z "${minted}" ]; then
    minted="$(stat -c '%Y' "${TREE_STATE_DIR}/helper_token" 2>/dev/null \
      || stat -f '%m' "${TREE_STATE_DIR}/helper_token" 2>/dev/null)"
    case "${minted}" in ''|*[!0-9]*) minted="" ;; esac
  fi
  printf '%s' "${minted}"
}

_helper_token_past_max_age() {
  # W6-P1-1: true when the current token is older than
  # HELPER_TOKEN_MAX_AGE_SECONDS (default 86400 = 24h). A
  # never-crashing server must not keep one bearer token forever;
  # main() rotates proactively through the normal recovery path.
  local max_age="${HELPER_TOKEN_MAX_AGE_SECONDS:-86400}" minted now
  case "${max_age}" in ''|*[!0-9]*) max_age=86400 ;; esac
  [ "${max_age}" -gt 0 ] || return 1
  minted="$(_helper_token_minted_at)"
  [ -n "${minted}" ] || return 1
  now="$(date +%s)"
  case "${now}" in ''|*[!0-9]*) return 1 ;; esac
  [ $((now - minted)) -ge "${max_age}" ]
}

# --- auth-aware status probe -----------------------------------------------
status_body=""
probe_status() {
  # $1 = attempts (default PROBE_ATTEMPTS). Sets status_body on success.
  # W2-P2-11: no sleep after the final attempt (nothing is retried after
  # it; sleeping just delays the verdict).
  local attempts="${1:-${PROBE_ATTEMPTS}}" delay="${PROBE_BASE_DELAY}" i
  for ((i = 1; i <= attempts; i++)); do
    if status_body="$(curl -sf -m "${PROBE_TIMEOUT}" ${_HELPER_CURL_TLS_FLAG} "${STATUS_URL}" 2>/dev/null)"; then
      return 0
    fi
    log "status probe attempt ${i}/${attempts} failed; retrying in ${delay}s"
    if [ "${i}" -lt "${attempts}" ]; then
      sleep "${delay}"
      delay=$((delay * 2))
    fi
  done
  status_body=""
  return 1
}

tcp_port_open() {
  # $1 = port. True when something on 127.0.0.1 accepts TCP there.
  # Used for the slow-but-alive grace: a listening port with a
  # never-answering /status is a slow server, not a dead one.
  (exec 3<>/dev/tcp/127.0.0.1/"$1") 2>/dev/null
}

logged_in_state() {
  # $1 = /status body. Prints true | false | parse_error.
  printf '%s' "$1" | python3 -c \
    'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("parse_error")
else:
    print("true" if d.get("logged_in") else "false")' 2>/dev/null \
    || echo parse_error
}

status_version() {
  # $1 = /status body. Prints the server's helper_version, or "unknown"
  # when the body is malformed or the server predates the marker.
  printf '%s' "$1" | python3 -c \
    'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("unknown")
else:
    print(d.get("helper_version") or "unknown")' 2>/dev/null \
    || echo unknown
}

status_fields() {
  # $1 = /status body. Prints "k=true/false/unknown" pairs for the fields
  # the keepalive reasons about ("unknown" when the server omits the key,
  # e.g. an older server.py), or "parse_error". A missing chromium_alive
  # must NEVER read as dead: with a legacy server the keepalive keeps the
  # old report-only behavior instead of restarting on a guess.
  printf '%s' "$1" | python3 -c \
    'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("parse_error")
    raise SystemExit
out = []
for k in ("logged_in", "chromium_alive", "starting", "profile_has_cookies"):
    v = d.get(k, "unknown")
    out.append("%s=%s" % (k, "true" if v is True else "false" if v is False else "unknown"))
print(" ".join(out))' 2>/dev/null \
    || echo parse_error
}

starting_state() {
  # $1 = /status body. Prints true only when the helper is mid-boot
  # (chromium alive, tab not landed yet).
  printf '%s' "$1" | python3 -c \
    'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("false")
else:
    print("true" if d.get("starting") else "false")' 2>/dev/null \
    || echo false
}

session_horizon() {
  # $1 = /status body. Prints the session cookie expiry horizon in whole
  # days (server.py's session_expiry_horizon_days), or "unknown" when the
  # server omits it (legacy server) or the body is malformed.
  printf '%s' "$1" | python3 -c \
    'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("unknown")
else:
    v = d.get("session_expiry_horizon_days")
    print(v if isinstance(v, int) and v >= 0 else "unknown")' 2>/dev/null \
    || echo unknown
}

warn_on_session_horizon() {
  # $1 = /status body. W4-P2-3: a loud warning when the authenticated
  # session's cookie expiry is within 7 days, so the educator gets the
  # warning BEFORE the session dies and can re-sign in ahead of time.
  # W6-P2-S3: a failed metadata read (session_expiry_unknown=true)
  # also warns loudly: an unknown expiry must never read as all-clear.
  local unknown_flag
  unknown_flag="$(printf '%s' "$1" | python3 -c \
    'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("unknown")
else:
    v = d.get("session_expiry_unknown", "unknown")
    print("true" if v is True else "false" if v is False else "unknown")' \
    2>/dev/null || echo unknown)"
  if [ "${unknown_flag}" = "true" ]; then
    log "WARNING: the helper could not read the Canvas session cookie expiry metadata; the session may expire without the usual 7-day warning. Re-sign in through the login helper if writes start halting"
    return 0
  fi
  local days
  days="$(session_horizon "$1")"
  case "${days}" in
    unknown) return 0 ;;
    ''|*[!0-9]*) return 0 ;;
  esac
  if [ "${days}" -le 7 ]; then
    log "WARNING: the authenticated Canvas session's earliest cookie expires in ${days} day(s); re-sign in through the login helper soon or the next run may halt mid-operation"
  fi
}

genuine_signout() {
  # $1 = /status body. Prints "true" ONLY for the exact genuine-sign-out
  # state: logged_in=false, chromium_alive=true, starting=false.
  # P0-8: exit 2 is emitted only for this state. A legacy server that
  # omits chromium_alive (unknown), a malformed body, a dead Chromium, or
  # a still-starting helper must never read as signed-out.
  local fields kv logged_in="unknown" chromium_alive="unknown" starting="unknown"
  fields="$(status_fields "$1")"
  if [ "${fields}" = "parse_error" ] || [ -z "${fields}" ]; then
    echo false
    return
  fi
  for kv in ${fields}; do
    case "${kv}" in
      logged_in=*) logged_in="${kv#*=}" ;;
      chromium_alive=*) chromium_alive="${kv#*=}" ;;
      starting=*) starting="${kv#*=}" ;;
    esac
  done
  if [ "${logged_in}" = "false" ] && [ "${chromium_alive}" = "true" ] \
     && [ "${starting}" = "false" ]; then
    echo true
  else
    echo false
  fi
}

# --- /proc identity helpers (W2-P0-6, W2-P2-22) ---------------------------
# PROC_ROOT is the test seam (selftests point it at a fake /proc);
# production always reads /proc. All argv parsing uses exact argv-element
# matches, never substring matches.

proc_argv_lines() {
  # $1 = pid. Prints the process's argv, one arg per line. Silent when
  # the process exits mid-read: the subshell's 2>/dev/null covers the
  # "<" redirect failing before tr ever runs.
  local pid="$1" proot="${PROC_ROOT:-/proc}"
  ( tr '\0' '\n' < "${proot}/${pid}/cmdline" 2>/dev/null ) 2>/dev/null || true
}

proc_user_data_dir() {
  # $1 = pid. Prints the process's exact --user-data-dir argv value, or
  # empty. Exact element match: /profiles/a never matches /profiles/a2.
  local pid="$1" arg val="" next=0
  while IFS= read -r arg; do
    if [ "${next}" = 1 ]; then val="${arg}"; next=0; continue; fi
    case "${arg}" in
      --user-data-dir=*) val="${arg#--user-data-dir=}" ;;
      --user-data-dir) next=1 ;;
    esac
  done < <(proc_argv_lines "${pid}")
  printf '%s' "${val}"
}

proc_has_debug_pipe() {
  # $1 = pid. True when one of the process's argv ELEMENTS is exactly
  # --remote-debugging-pipe. Exact element equality: a hypothetical
  # --remote-debugging-pipe-for-test flag never matches (W4-P0-3: with
  # pipe CDP there is no --remote-debugging-port to match on).
  local pid="$1" arg
  while IFS= read -r arg; do
    [ "${arg}" = "--remote-debugging-pipe" ] && return 0
  done < <(proc_argv_lines "${pid}")
  return 1
}

_same_dir() {
  # $1 $2: true when both paths resolve (readlink -f) to the same dir.
  local a b
  a="$(readlink -f "$1" 2>/dev/null || printf '%s' "$1")"
  b="$(readlink -f "$2" 2>/dev/null || printf '%s' "$2")"
  [ "${a}" = "${b}" ]
}

holder_belongs_to_tree() {
  # $1 = pid. True ONLY when the process proves it is THIS tree's helper
  # server, with NO substring matching anywhere (W3-P0-20).
  #
  # Both conditions are required:
  #   1. one of the process's argv ELEMENTS is exactly
  #      "${HELPER_DIR}/server.py" (exact element equality: myserver.py,
  #      server.py.bak, an editor's "vim .../server.py", and
  #      "tail -f server.py.log" all fail this test);
  #   2. the process's /proc/<pid>/cwd resolves (readlink -f) to exactly
  #      ${HELPER_DIR}.
  #
  # The old cwd fallback for a bare relative "server.py" argv was the
  # hole: it judged myserver.py-with-our-cwd as ours. It is gone.
  # recover_helper always relaunches with the absolute
  # "${HELPER_DIR}/server.py" argv, so a genuine server always passes
  # both gates. Anything else returns false: a foreign or merely
  # similar process is never killed.
  local pid="$1" proot="${PROC_ROOT:-/proc}" arg helper_real cwd
  [ -d "${proot}/${pid}" ] || return 1
  helper_real="$(readlink -f "${HELPER_DIR}" 2>/dev/null || printf '%s' "${HELPER_DIR}")"
  local matched=0
  while IFS= read -r arg; do
    if [ "${arg}" = "${HELPER_DIR}/server.py" ]; then
      matched=1
      break
    fi
  done < <(proc_argv_lines "${pid}")
  [ "${matched}" = "1" ] || return 1
  cwd="$(readlink -f "${proot}/${pid}/cwd" 2>/dev/null || true)"
  [ -n "${cwd}" ] && [ "${cwd}" = "${helper_real}" ]
}

_chromium_pids_with_debug_pipe() {
  # Prints PIDs whose argv carries the EXACT --remote-debugging-pipe
  # element (W4-P0-3: pipe CDP replaced the TCP debug port; there is no
  # port to match on). Enumerates /proc/[0-9]*/cmdline directly;
  # proc_has_debug_pipe is the exact arbiter. No pgrep: its -f
  # substring match could sweep in unrelated processes.
  local pid proot="${PROC_ROOT:-/proc}" arg
  for proot_pid in "${proot}"/[0-9]*; do
    pid="${proot_pid##*/}"
    [ -d "${proot}/${pid}" ] || continue
    # Fast prefilter on the raw cmdline, then the exact-element arbiter.
    if ! tr '\0' '\n' < "${proot}/${pid}/cmdline" 2>/dev/null \
        | grep -qx -- "--remote-debugging-pipe"; then
      continue
    fi
    proc_has_debug_pipe "${pid}" || continue
    printf '%s\n' "${pid}"
  done
}

pipe_holder_pid_for_profile() {
  # $1 = profile dir. Prints the PID of a local Chromium carrying the
  # exact --remote-debugging-pipe element whose --user-data-dir
  # resolves (realpath) to exactly $1, or empty. Foreign profiles are
  # skipped, never returned: another tree's pipe Chromium must not
  # satisfy this tree's browser-identity check (a first-match scan
  # would false-abort when a second tree's browser enumerates first).
  local want="$1" pid udd
  for pid in $(_chromium_pids_with_debug_pipe); do
    udd="$(proc_user_data_dir "${pid}")"
    if [ -n "${udd}" ] && _same_dir "${udd}" "${want}"; then
      printf '%s\n' "${pid}"
      return 0
    fi
  done
  return 0
}

# --- /status verdict -------------------------------------------------------
# Evaluates the current status_body and exits. Never returns.
# Principal pinning: the first signed-in session pins the educator's
# Canvas account (reauth/state_machine.py pin --first-signin), so a later
# re-sign-in can resume paused work only for that same account. Runs
# only while nothing is pinned yet. The pin command itself refuses
# during a re-auth write halt: it never pins whoever signed back in.
pin_first_signin() {
  [ -f "${MORROW_HOME_DIR}/browser_lane.json" ] && return 0
  local out
  if out="$(PYTHONDONTWRITEBYTECODE=1 python3 \
        "${TREE_ROOT}/reauth/state_machine.py" pin --first-signin 2>&1)"; then
    log "${out}"
  else
    log "principal not pinned yet: ${out}"
  fi
  return 0
}

# W2-P2-6: Chromium memory policy. Runs only on a healthy helper
# (logged_in=true). helper/memory_watch.py is a read-only probe: it
# exits 3 when the Chromium tree's RSS exceeds CHROMIUM_MAX_RSS_MB (or
# the browser is older than CHROMIUM_MAX_BROWSER_AGE_H). W4-P2-16: tab
# reaping moved in-process to the helper server (the browser's owner);
# no other process can reach CDP anymore. A 3 becomes a loud
# recover_helper (the
# browser is recycled; the session survives on the persistent profile)
# ONLY when the executor journal is quiet (no dispatch in flight) and
# outside the restart cooldown, so a restart can never interrupt a run
# or loop. Returns 0 when no restart was needed.
memory_watch_check() {
  local out rc
  out="$(MEMORY_WATCH_PROFILE_DIR="${PROFILE_DIR}" \
         MEMORY_WATCH_CDP_PORT="${CDP_PORT}" \
         python3 "${HELPER_DIR}/memory_watch.py" 2>&1)"
  rc=$?
  log "memory watch: ${out}"
  [ "${rc}" = "3" ] || return 0
  local journal="${TREE_STATE_DIR}/journal/ops.jsonl"
  local quiet_min="${CHROMIUM_RESTART_QUIET_MINUTES:-10}"
  if [ -f "${journal}" ]; then
    local age_min now_j
    now_j="$(date +%s)"
    age_min=$(( (now_j - $(stat -c %Y "${journal}" 2>/dev/null || echo "${now_j}")) / 60 ))
    if [ "${age_min}" -lt "${quiet_min}" ]; then
      log "memory restart deferred: journal active ${age_min}m ago (< ${quiet_min}m)"
      return 0
    fi
  fi
  local cooldown_min="${CHROMIUM_RESTART_COOLDOWN_MINUTES:-60}"
  # W3-P2-13: the cooldown stamp is per-tree (under TREE_STATE_DIR), not
  # the old global ${HOME}/.morrow/last-memory-restart: tree A's memory
  # restart must not suppress tree B's.
  local stamp="${TREE_STATE_DIR}/last-memory-restart"
  if [ -f "${stamp}" ]; then
    local last now_s
    last="$(cat "${stamp}" 2>/dev/null || echo 0)"
    now_s="$(date +%s)"
    case "${last}" in ''|*[!0-9]*) last=0 ;; esac
    if [ $(( (now_s - last) / 60 )) -lt "${cooldown_min}" ]; then
      log "memory restart deferred: last memory restart $(( (now_s - last) / 60 ))m ago (< ${cooldown_min}m cooldown)"
      return 0
    fi
  fi
  # W3-P1-15: the stamp is armed ONLY after a successful recovery. A
  # failed recovery must not buy an hour of no retries: on failure the
  # stamp is removed (or never written), so the next tick retries.
  log "MEMORY POLICY: ${out}; recycling the browser (session preserved on the persistent profile)"
  if circuit_guard_recover; then
    date +%s > "${stamp}" 2>/dev/null || true
    return 0
  else
    # NOTE: $? must be captured HERE, in the else branch. Reading it
    # after the "fi" would yield the if-statement's own status (0 when
    # the condition was false), silently swallowing the failure.
    rc=$?
    rm -f "${stamp}" 2>/dev/null || true
    return "${rc}"
  fi
}

evaluate_status() {
  local fields kv logged_in="unknown" chromium_alive="unknown" starting="unknown"
  fields="$(status_fields "${status_body}")"
  if [ "${fields}" = "parse_error" ] || [ -z "${fields}" ]; then
    # P0-8: exit 2 is reserved for a genuine signed-out session. An
    # unparseable /status is a different failure: exit 1, no recovery.
    log "UNHEALTHY: /status JSON unparseable; no recovery attempted"
    exit 1
  fi
  for kv in ${fields}; do
    case "${kv}" in
      logged_in=*) logged_in="${kv#*=}" ;;
      chromium_alive=*) chromium_alive="${kv#*=}" ;;
      starting=*) starting="${kv#*=}" ;;
    esac
  done
  if [ "${logged_in}" = "true" ]; then
    # W2-P1-16: version-skew detection. A healthy /status from a server
    # whose helper_version differs from this tree's VERSION is a stale
    # pre-upgrade server squatting the port: recycle it (tree-gated)
    # instead of adopting it. "unknown" on either side (legacy server,
    # or a tree without a VERSION file) counts as skew: adopting an
    # unidentified server is never safe. The tree gate inside
    # kill_helper_server protects a foreign tree's server from the kill.
    local running_version
    running_version="$(status_version "${status_body}")"
    if [ "${running_version}" != "${TREE_VERSION}" ]; then
      log "version skew: running helper_version=${running_version}, tree VERSION=${TREE_VERSION}; recycling the stale server instead of adopting it"
      circuit_guard_recover
      exit $?
    fi
    log "helper healthy: logged_in=true"
    # W5-P2-7: a genuinely healthy helper resets the relaunch circuit
    # breaker (whatever was failing recoveries is no longer the state
    # of the world). No-op when the circuit is already closed.
    circuit_note_healthy
    # W4-P2-3: near-expiry session warning, every healthy tick.
    warn_on_session_horizon "${status_body}"
    pin_first_signin
    # W2-P2-6: memory policy runs on healthy ticks only. It may recycle
    # the browser (recover_helper, loud log); on return evaluate the
    # fresh status instead of exiting on the pre-restart verdict.
    if memory_watch_check; then
      exit 0
    fi
    exit $?
  fi
  if [ "${chromium_alive}" = "false" ]; then
    # P0-8: a dead Chromium is RECOVERABLE, not a signed-out session:
    # restart the helper instead of reporting exit 2.
    log "chromium dead, restarting (not a sign-out)"
    circuit_guard_recover
    exit $?
  fi
  # P0-8: exit 2 ONLY for the exact genuine-sign-out state
  # (logged_in=false, chromium_alive=true, starting=false). A legacy
  # server that omits chromium_alive (unknown), a still-starting helper,
  # or any other indeterminate state is NOT a sign-out: exit 1, and never
  # recover on a guess.
  if [ "$(genuine_signout "${status_body}")" = "true" ]; then
    log "UNHEALTHY: helper reports logged_in=false (signed out); no sign-in attempted"
    exit 2
  fi
  log "UNHEALTHY: indeterminate status (logged_in=${logged_in} chromium_alive=${chromium_alive} starting=${starting}); not a confirmed sign-out, no recovery attempted"
  exit 1
}

# --- scoped Chromium reap --------------------------------------------------
reap_helper_chromium() {
  # $1 = mode: kill (default) or dryrun (log verdicts, kill nothing).
  # Only PIDs carrying the exact --remote-debugging-pipe element whose
  # EXACT --user-data-dir argv value resolves to this tree's profile
  # dir are killed (W2-P2-22: exact argv-element match and
  # path-boundary-safe realpath comparison; /profiles/a never matches
  # /profiles/a2). Any other Chromium is left alone.
  local mode="${1:-kill}" pid udd
  for pid in $(_chromium_pids_with_debug_pipe); do
    udd="$(proc_user_data_dir "${pid}")"
    if [ -n "${udd}" ] && _same_dir "${udd}" "${PROFILE_DIR}"; then
      if [ "${mode}" = "dryrun" ]; then
        log "DRYRUN: would reap helper-owned chromium pid ${pid}"
      else
        log "reaping helper-owned chromium pid ${pid}"
        kill "${pid}" 2>/dev/null || true
      fi
    else
      log "skipping chromium pid ${pid}: --user-data-dir '${udd}' is not this tree's profile"
    fi
  done
}

# --- helper recovery -------------------------------------------------------
# Kill whoever actually holds the helper's port (exact, PID-based).
# W3-P0-20: the holder must PROVE it is this tree's helper server with
# one exact check, holder_belongs_to_tree: an argv ELEMENT exactly
# equal to ${HELPER_DIR}/server.py AND /proc/<pid>/cwd exactly equal
# to ${HELPER_DIR}. No substring matching anywhere on the kill path.
# Anything else (a foreign tree's server, an editor, tail -f,
# myserver.py, a non-server squatter) fails the proof: log and ABORT
# recovery, never SIGKILL an unknown process. A foreign tree's server
# is never killed: recovery aborts loudly instead of staging a
# cross-tree takeover.
kill_helper_server() {
  local pid cmdline
  pid="$(ss -ltnp 2>/dev/null | grep ":${SERVER_PORT} " | grep -o 'pid=[0-9]*' \
    | head -1 | cut -d= -f2)"
  if [ -z "${pid}" ]; then
    log "no process holds port ${SERVER_PORT}"
    return 0
  fi
  cmdline="$(proc_argv_lines "${pid}" | tr '\n' ' ')"
  # W3-P0-20: the ONLY gate on this kill path is the exact
  # holder_belongs_to_tree check (exact ${HELPER_DIR}/server.py argv
  # element + exact ${HELPER_DIR} cwd). No substring matching anywhere:
  # a refusal filter that only ever refused (grep -qF "server.py") was
  # removed so the kill decision rests on one exact proof. A foreign
  # tree's server, an editor, tail -f, myserver.py, and any non-server
  # squatter all fail the exact proof and are never killed.
  if ! holder_belongs_to_tree "${pid}"; then
    log "ABORT: pid ${pid} holds port ${SERVER_PORT} but did not prove it is this tree's helper server (exact ${HELPER_DIR}/server.py argv element + cwd ${HELPER_DIR} required; cmdline: ${cmdline}); refusing to kill. A foreign tree's server is never killed by this tree: stop that tree's own keepalive/server first, then rerun."
    return 1
  fi
  log "killing helper server pid ${pid} (holds port ${SERVER_PORT})"
  kill "${pid}" 2>/dev/null || true
  sleep 2
  if kill -0 "${pid}" 2>/dev/null; then
    log "server pid ${pid} still alive; sending SIGKILL"
    kill -9 "${pid}" 2>/dev/null || true
  fi
}

# Wait until no helper-owned Chromium remains, so the relaunched server
# never shares the profile with a dying browser.
wait_for_chromium_exit() {
  local i pids
  for ((i = 0; i < 20; i++)); do
    pids="$(_chromium_pids_with_debug_pipe)"
    pids="$(for pid in ${pids}; do
              udd="$(proc_user_data_dir "${pid}")"
              if [ -n "${udd}" ] && _same_dir "${udd}" "${PROFILE_DIR}"; then
                printf '%s ' "${pid}"
              fi
            done)"
    [ -z "${pids}" ] && return 0
    sleep 1
  done
  log "WARN: helper chromium still alive after 20s:${pids}"
  return 1
}

reap_tree_forwarders() {
  # W2-P1-34: reap orphaned egress forwarders of THIS tree. A forwarder
  # is ours when one of its argv elements is EXACTLY this tree's
  # forwarder port AND its cmdline names proxy_forwarder.py. Exact
  # element match (grep -xF): port 29223 never matches 292231. No pkill,
  # no substring kills, no other tree's forwarders.
  local d pid
  for d in "${PROC_ROOT:-/proc}"/[0-9]*; do
    pid="${d##*/}"
    [ "${pid}" != "$$" ] || continue
    proc_argv_lines "${pid}" | grep -qxF "${FORWARDER_PORT}" || continue
    tr '\0' ' ' < "${d}/cmdline" 2>/dev/null | grep -qF "proxy_forwarder.py" || continue
    log "reaping orphaned tree forwarder pid ${pid} (forwarder port ${FORWARDER_PORT})"
    kill "${pid}" 2>/dev/null || true
  done
}

recover_helper() {
  log "helper unreachable at ${STATUS_URL}; recovering"
  if ! kill_helper_server; then
    log "ERROR: recovery aborted (the port holder is not this tree's helper server)"
    return 1
  fi
  reap_helper_chromium kill
  wait_for_chromium_exit || true
  # W2-P1-34: reap this tree's orphaned forwarders (exact port + script
  # match). A SIGKILLed server never ran its signal-handler cleanup, so
  # its forwarder may still hold the port with proxy creds in memory.
  reap_tree_forwarders
  sleep 1
  cd "${HELPER_DIR}"
  if [ -z "${CANVAS_BASE:-}" ]; then
    log "ERROR: CANVAS_BASE not set (set it in ${TREE_ENV_FILE}, or the legacy ${MORROW_LEGACY_ENV}); cannot relaunch"
    return 1
  fi
  # W3-P0-7/W3-P0-8, W6-P1-1: helper auth token lifecycle. The token
  # is a 64-hex bearer minted per tree at ${TREE_STATE_DIR}/helper_token
  # (0600). ROTATION: every server (re)launch mints a FRESH token; the
  # replaced token is staged at helper_token.prev ("<hex>:<epoch>") and
  # the new server honors it for HELPER_TOKEN_PREV_GRACE_SECONDS
  # (default 300s) so in-flight clients (a sign-in UI page loaded just
  # before the relaunch) are not cut off mid-flow. A captured token is
  # therefore valid at most until the next rotation, never forever;
  # main() additionally forces a proactive rotate+relaunch past
  # HELPER_TOKEN_MAX_AGE_SECONDS (default 24h). The token value NEVER
  # enters the server's environment: server.py reads it from
  # HELPER_AUTH_TOKEN_FILE (the 0600 path), so the secret never appears
  # in /proc/<pid>/environ (W6-P2-7). The token is NEVER logged. (The
  # older live server.py predates the token check and ignores these
  # variables harmlessly; the new server.py enforces the token.)
  TOKEN_FILE="${TREE_STATE_DIR}/helper_token"
  TOKEN_PREV_FILE="${TOKEN_FILE}.prev"
  TOKEN_META_FILE="${TOKEN_FILE}.meta"
  ( umask 077 && mkdir -p -m 0700 "${TREE_STATE_DIR}" ) 2>/dev/null || true
  _mint_helper_token() {
    ( umask 077 && python3 -c "import secrets;print(secrets.token_hex(32))" > "${TOKEN_FILE}" ) 2>/dev/null \
      || { log "ERROR: could not mint the helper auth token"; return 1; }
    chmod 0600 "${TOKEN_FILE}" 2>/dev/null || true
    printf 'minted_at=%s\n' "$(date +%s)" > "${TOKEN_META_FILE}" 2>/dev/null || true
    chmod 0600 "${TOKEN_META_FILE}" 2>/dev/null || true
  }
  if [ ! -s "${TOKEN_FILE}" ] \
      || ! _helper_token_shape_ok "$(cat "${TOKEN_FILE}" 2>/dev/null)"; then
    # Missing, empty, or malformed (W6-P2-3: exactly 64 hex chars, so a
    # truncated token can never be served): mint fresh, no predecessor.
    rm -f "${TOKEN_PREV_FILE}" 2>/dev/null || true
    _mint_helper_token || return 1
    log "minted a new helper auth token at ${TOKEN_FILE} (0600)"
  else
    # Rotate: the live token becomes the grace-window predecessor.
    printf '%s:%s\n' "$(cat "${TOKEN_FILE}")" "$(date +%s)" \
        > "${TOKEN_PREV_FILE}" 2>/dev/null \
      || { log "ERROR: could not stage the previous helper token"; return 1; }
    chmod 0600 "${TOKEN_PREV_FILE}" 2>/dev/null || true
    _mint_helper_token || return 1
    log "rotated the helper auth token (previous token honored for the grace window)"
  fi
  # Pass PATHS, not values, into the server's environment (W6-P2-7):
  # the token file is 0600 and this tree's processes already read it.
  unset HELPER_AUTH_TOKEN
  HELPER_AUTH_TOKEN_FILE="${TOKEN_FILE}"
  export HELPER_AUTH_TOKEN_FILE
  HELPER_AUTH_TOKEN_PREV_FILE="${TOKEN_PREV_FILE}"
  export HELPER_AUTH_TOKEN_PREV_FILE
  # Pin the tree's profile explicitly (absolute server path, so the
  # cmdline is tree-identifying for the next keepalive run's holder
  # check): server.py must never derive the profile from its launch
  # directory (2026-09-21 wrong-profile incident).
  export LOGIN_HELPER_PROFILE_DIR="${HELPER_DIR}/profile"
  # W2-P1-17: revalidate identity at relaunch: the pinned profile and the
  # configured tree identity label travel in the child's environment,
  # so the new server cannot come up as another tree's profile by
  # misconfiguration.
  export LOGIN_HELPER_CDP_PORT="${CDP_PORT}"
  # W3-P2-38: close the keepalive lock fd (9) in the server child. The lock
  # is held via fd 9 for the whole run; a nohup'd daemon inherits it by
  # default, and the inherited flock then wedges every future keepalive run
  # ("another keepalive run holds the lock; skipping") forever, leaving the
  # supervisor permanently blind. 9>&- applies to the child only.
  nohup python3 "${HELPER_DIR}/server.py" >> "${SERVER_LOG}" 2>&1 9>&- &
  _server_pid=$!
  disown 2>/dev/null || true
  log "helper relaunched (pid ${_server_pid}); waiting ${RESTART_WAIT}s"
  sleep "${RESTART_WAIT}"
  if probe_status 2; then
    local state holder_profile
    state="$(logged_in_state "${status_body}")"
    log "helper responding after restart; logged_in=${state}"
    # W2-P1-14 (pipe edition): verify a pipe-Chromium holding THIS
    # tree's pinned profile is up after the restart. The server always
    # launches its own browser now (adoption is impossible with
    # --remote-debugging-pipe), so the check is "our browser exists",
    # not "the first browser found is ours": another tree's pipe
    # Chromium enumerating first must never false-abort this recovery.
    holder_pid="$(pipe_holder_pid_for_profile "${LOGIN_HELPER_PROFILE_DIR}")"
    if [ -z "${holder_pid}" ]; then
      if [ -n "$(_chromium_pids_with_debug_pipe | head -n 1)" ]; then
        log "ABORT: pipe-Chromium processes exist but none holds this tree's profile ${LOGIN_HELPER_PROFILE_DIR}; our browser failed to launch; stopping our server pid ${_server_pid}, no further recovery"
      else
        log "ABORT: no pipe-Chromium holds this tree's profile ${LOGIN_HELPER_PROFILE_DIR} after restart; our browser failed to launch; stopping our server pid ${_server_pid}, no further recovery"
      fi
      kill "${_server_pid}" 2>/dev/null || true
      return 1
    fi
    log "helper browser verified: pipe-Chromium pid ${holder_pid} holds this tree's profile"
    [ "${state}" = "true" ] && return 0
    # P0-8: after a restart, exit 2 only for a CONFIRMED genuine sign-out
    # (alive, not starting, logged_in=false). Malformed status, missing
    # liveness, a still-dead Chromium, or a still-starting helper is a
    # failed recovery: return 1, never 2 on a guess.
    [ "$(genuine_signout "${status_body}")" = "true" ] && return 2
    log "ERROR: helper unhealthy after restart and not a confirmed sign-out; no further recovery attempted"
    return 1
  fi
  log "ERROR: helper did not come back after restart"
  return 1
}

# --- W5-P2-7: helper-relaunch circuit breaker --------------------------------
# recover_helper() relaunches Chromium+server on every unhealthy tick. When
# the underlying fault is persistent (bad profile, broken binary, a port
# squatter), keepalive would relaunch every 5 minutes forever: log spam,
# CPU churn, and a hot crash loop. The breaker counts CONSECUTIVE failed
# recoveries in ${TREE_STATE_DIR}/keepalive_circuit (0600). Past
# CIRCUIT_FAIL_THRESHOLD failures the circuit OPENS: relaunch attempts are
# skipped (with a loud log line on every run) until the backoff elapses.
# The breaker resets only on a genuinely healthy helper: a successful
# recovery, or a later keepalive tick that finds the helper healthy
# (circuit_note_healthy). It never resets on the passage of time alone.
CIRCUIT_FILE="${TREE_STATE_DIR}/keepalive_circuit"
CIRCUIT_FAIL_THRESHOLD=3
CIRCUIT_BASE_S=600
CIRCUIT_MAX_S=14400

_circuit_read() {
  # Sets _circuit_failures and _circuit_next_allowed (epoch). Missing or
  # malformed file reads as a closed circuit.
  _circuit_failures=0 _circuit_next_allowed=0
  [ -f "${CIRCUIT_FILE}" ] || return 0
  local _k _v
  while IFS='=' read -r _k _v; do
    case "${_k}" in
      failures) _circuit_failures="${_v:-0}" ;;
      next_allowed) _circuit_next_allowed="${_v:-0}" ;;
    esac
  done < "${CIRCUIT_FILE}" 2>/dev/null || true
  case "${_circuit_failures}" in ''|*[!0-9]*) _circuit_failures=0 ;; esac
  case "${_circuit_next_allowed}" in ''|*[!0-9]*) _circuit_next_allowed=0 ;; esac
}

_circuit_write() {
  # $1 = failures, $2 = next_allowed epoch. Atomic-ish (tmp + mv), 0600.
  ( umask 077 && mkdir -p -m 0700 "${TREE_STATE_DIR}" ) 2>/dev/null || true
  printf 'failures=%s\nnext_allowed=%s\n' "${1:-0}" "${2:-0}" \
    > "${CIRCUIT_FILE}.tmp" 2>/dev/null \
    && mv "${CIRCUIT_FILE}.tmp" "${CIRCUIT_FILE}" 2>/dev/null || true
  chmod 0600 "${CIRCUIT_FILE}" 2>/dev/null || true
}

_circuit_open_remaining() {
  # Echo seconds until a relaunch is allowed again, or 0 when closed.
  _circuit_read
  local _now
  _now="$(date +%s)"
  case "${_now}" in ''|*[!0-9]*) _now=0 ;; esac
  if [ "${_circuit_failures}" -ge "${CIRCUIT_FAIL_THRESHOLD}" ] \
     && [ "${_now}" -lt "${_circuit_next_allowed}" ]; then
    printf '%s' "$((_circuit_next_allowed - _now))"
  else
    printf '0'
  fi
}

circuit_guard_recover() {
  # Drop-in wrapper around recover_helper with the circuit breaker.
  # Returns the recovery's own exit code; returns 1 WITHOUT relaunching
  # when the circuit is open.
  local _remaining _rc _failures _backoff _now _i _when
  _remaining="$(_circuit_open_remaining)"
  case "${_remaining}" in ''|*[!0-9]*) _remaining=0 ;; esac
  if [ "${_remaining}" -gt 0 ]; then
    log "CIRCUIT OPEN: skipping helper relaunch for ${_remaining}s after repeated failed recoveries (state: ${CIRCUIT_FILE}); the helper stays down until the backoff elapses or an operator intervenes"
    printf 'keepalive: CIRCUIT OPEN: not relaunching a repeatedly-failing helper for %ss\n' "${_remaining}" >&2
    return 1
  fi
  recover_helper
  _rc=$?
  if [ "${_rc}" -eq 0 ] || [ "${_rc}" -eq 2 ]; then
    # 0 = helper back and healthy; 2 = confirmed genuine sign-out (the
    # relaunch itself worked; the educator must sign in). Neither is a
    # recovery failure: reset the breaker.
    _circuit_write 0 0
  else
    _circuit_read
    _failures=$((_circuit_failures + 1))
    if [ "${_failures}" -ge "${CIRCUIT_FAIL_THRESHOLD}" ]; then
      # Exponential backoff from the trip point, capped.
      _backoff=${CIRCUIT_BASE_S}
      _i=${CIRCUIT_FAIL_THRESHOLD}
      while [ "${_i}" -lt "${_failures}" ]; do
        _backoff=$((_backoff * 2))
        if [ "${_backoff}" -gt "${CIRCUIT_MAX_S}" ]; then
          _backoff=${CIRCUIT_MAX_S}
          break
        fi
        _i=$((_i + 1))
      done
      _now="$(date +%s)"
      case "${_now}" in ''|*[!0-9]*) _now=0 ;; esac
      _circuit_write "${_failures}" "$((_now + _backoff))"
      _when="$(date -d "@$((_now + _backoff))" '+%F %T %Z' 2>/dev/null \
        || printf '%s' "$((_now + _backoff))")"
      log "CIRCUIT: ${_failures} consecutive failed recoveries; circuit OPEN for ${_backoff}s (relaunches allowed again after ${_when})"
    else
      _circuit_write "${_failures}" 0
      log "recovery failed (${_failures}/${CIRCUIT_FAIL_THRESHOLD} consecutive); circuit still closed"
    fi
  fi
  return "${_rc}"
}

circuit_note_healthy() {
  # A genuinely healthy helper (probe OK, logged_in=true) resets the
  # breaker: whatever was failing recoveries is no longer the state of
  # the world (operator fixed it, or the fault cleared). No-op when the
  # circuit is already closed so healthy trees never touch the file.
  [ -f "${CIRCUIT_FILE}" ] || return 0
  _circuit_read
  if [ "${_circuit_failures}" = "0" ] \
     && [ "${_circuit_next_allowed}" = "0" ]; then
    return 0
  fi
  log "helper healthy again; resetting the relaunch circuit breaker"
  _circuit_write 0 0
}

# --- startup lock -----------------------------------------------------------
acquire_keepalive_lock() {
  # W2-P1-1: open the lockfile, then take it non-blocking. Opening the
  # lockfile must not discard stderr on failure (W4-P1-10): the OLD
  # inline form `exec 9>"${LOCKFILE}" 2>/dev/null || {...}` swallowed the
  # shell's own "cannot open" diagnostic (permission denied, missing
  # dir, lockfile path a directory) AND permanently suppressed stderr
  # for the rest of the shell on every later code path. The
  # `{ exec 9>...; } 2>/dev/null` group form limits the suppression to
  # the open attempt itself; the fallback message then says exactly
  # what failed.
  if ! { exec 9>"${LOCKFILE}"; } 2>/dev/null; then
    printf 'keepalive: cannot open lockfile %s\n' "${LOCKFILE}" >&2
    return 1
  fi
  if ! flock -n 9; then
    log "another keepalive run holds the lock; skipping this run"
    return 2
  fi
  return 0
}

_warn_on_moved_tree_cron() {
  # W4-P1-9: the tree may have been moved or renamed without rerunning
  # the installer: then the crontab still invokes keepalive.sh at the
  # OLD path (cron fails "not found" every 5 minutes, silently except
  # for cron mail) or supervises a stale copy. Compare every
  # keepalive.sh path named in this user's crontab against this
  # script's own resolved path and warn LOUDLY (log + stderr) on any
  # mismatch or dead path. Never fatal: cron, not the educator, is the
  # broken one.
  command -v crontab >/dev/null 2>&1 || return 0
  local _self_real _cron_all _cl _cmd _hit _stok _seen _hit_real _msg
  _self_real="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null \
    || printf '%s' "${BASH_SOURCE[0]}")"
  _cron_all="$(crontab -l 2>/dev/null || true)"
  [ -n "${_cron_all}" ] || return 0
  _seen=""
  while IFS= read -r _cl || [ -n "${_cl}" ]; do
    case "${_cl}" in ""|\#*) continue ;; esac
    _cmd="$(printf '%s' "${_cl}" | awk \
      '{for(i=6;i<=NF;i++) printf "%s%s",$i,(i<NF?" ":"\n")}')"
    _hit=""
    case "${_cmd}" in
      *\"*keepalive.sh*\")
        _hit="$(printf '%s' "${_cmd}" \
          | sed -n 's/[^"]*"\([^"]*keepalive\.sh\)".*/\1/p')" ;;
      *keepalive.sh*)
        # Unquoted entry: the path may contain spaces, so do NOT split
        # on whitespace. Take everything up to the last keepalive.sh.
        _hit="$(printf '%s' "${_cmd}" \
          | sed -n 's/^\(.*keepalive\.sh\).*/\1/p')" ;;
    esac
    [ -n "${_hit}" ] || continue
    case "${_seen}" in *"|${_hit}|"*) continue ;; esac
    _seen="${_seen}|${_hit}|"
    _msg=""
    if [ ! -e "${_hit}" ]; then
      _msg="keepalive: WARNING: a crontab entry invokes ${_hit}, which does not exist. The tree was probably moved or renamed without rerunning install.sh; rerun it from the tree's new location (or remove the dead entry)."
    else
      _hit_real="$(readlink -f "${_hit}" 2>/dev/null || printf '%s' "${_hit}")"
      if [ "${_hit_real}" != "${_self_real}" ]; then
        _msg="keepalive: WARNING: a crontab entry invokes ${_hit}, but this keepalive is ${_self_real}. The tree was probably moved or renamed without rerunning install.sh; supervision may be split. Rerun install.sh from the intended tree."
      fi
    fi
    if [ -n "${_msg}" ]; then
      log "${_msg}"
      printf '%s\n' "${_msg}" >&2
    fi
  done <<_CRON_EOF
${_cron_all}
_CRON_EOF
  return 0
}

# --- main ------------------------------------------------------------------
main() {
  # W2-P1-30: mutual exclusion on a PER-TREE lock. Overlapping runs of
  # THIS tree's keepalive serialize; another tree's keepalive uses its
  # own lock and never contends. The lock lives under
  # ~/.morrow/trees/<tree-id>/, not the package tree, so no runtime
  # residue lands in the install. Restrictive perms throughout.
  ( umask 077 && mkdir -p -m 0700 "${MORROW_HOME_DIR}" "${TREE_STATE_DIR}" ) 2>/dev/null || true
  # W3-P1-19: tree_id slug collisions (e.g. morrow-a_b vs morrow-a-b vs
  # MORROW_A_B all slug identically) would share one lockfile and one
  # state dir. Detect, do not re-slug: re-slugging would orphan the
  # existing tree's state. The canonical tree path is recorded in the
  # state dir; a different recorded path is a FATAL collision.
  #
  # The first claim is ATOMIC (noclobber = O_CREAT|O_EXCL): two
  # colliding trees starting in the same instant cannot both observe
  # "no file" and both write. Exactly one wins the claim; the loser
  # reads the winner's path below and exits FATAL. (The flock on
  # LOCKFILE, taken immediately after, serializes the two trees
  # regardless; this record names the owner for the FATAL message.)
  _tree_path_file="${TREE_STATE_DIR}/tree_path"
  _canonical_tree="$(cd "${TREE_ROOT}" && pwd -P)"
  if ( set -o noclobber; printf '%s\n' "${_canonical_tree}" > "${_tree_path_file}" ) 2>/dev/null; then
    _recorded_tree="${_canonical_tree}"
  else
    _recorded_tree="$(cat "${_tree_path_file}" 2>/dev/null || true)"
    if [ -z "${_recorded_tree}" ]; then
      # Present but unclaimable/empty (e.g. killed mid-write): remove
      # and reclaim once, still atomically.
      rm -f "${_tree_path_file}" 2>/dev/null || true
      if ( set -o noclobber; printf '%s\n' "${_canonical_tree}" > "${_tree_path_file}" ) 2>/dev/null; then
        _recorded_tree="${_canonical_tree}"
      else
        _recorded_tree="$(cat "${_tree_path_file}" 2>/dev/null || true)"
      fi
    fi
  fi
  if [ -n "${_recorded_tree}" ] && [ "${_recorded_tree}" != "${_canonical_tree}" ]; then
    printf 'keepalive: FATAL: tree_id collision: state dir %s belongs to tree %s, but this tree is %s (both slug to "%s").\n' \
      "${TREE_STATE_DIR}" "${_recorded_tree}" "${_canonical_tree}" "${TREE_ID}" >&2
    printf 'keepalive: FATAL: rename one tree so the slugs differ, or point one tree at its own state dir with MORROW_TREE_STATE_DIR.\n' >&2
    exit 1
  fi
  unset _tree_path_file _canonical_tree _recorded_tree
  # W2-P1-1: take the per-tree lock (only fd 9 is held during the run,
  # not the global lock). Opening the lockfile must not discard stderr
  # on failure (W4-P1-10); the contention path exits 0 (a skip), the
  # open-failure path exits 1.
  _lock_rc=0
  acquire_keepalive_lock || _lock_rc=$?
  case "${_lock_rc}" in
    0) ;;
    2) exit 0 ;;
    *) exit 1 ;;
  esac
  unset _lock_rc
  # W4-P2-13: say which slug form the state dir resolves to.
  if [ "${_USING_LEGACY_SLUG:-0}" = "1" ]; then
    log "using the legacy (pre-W4-P2-13) tree slug ${TREE_ID} for the existing state dir; new installs use the bounded slug form"
  fi
  # W4-P1-9: a moved/renamed tree leaves cron pointing at the old path;
  # warn loudly (log + stderr) instead of failing silently.
  _warn_on_moved_tree_cron
  log "--- keepalive run (tree ${TREE_ID}, version ${TREE_VERSION})"
  # W6-P1-1: proactive rotation. A never-crashing server would otherwise
  # keep one bearer token forever; past HELPER_TOKEN_MAX_AGE_SECONDS
  # (default 24h) rotate through the normal recovery path. The Chromium
  # profile preserves the educator's session across the restart, so this
  # is a brief helper outage, not a sign-out.
  if _helper_token_past_max_age; then
    log "helper auth token past max age (${HELPER_TOKEN_MAX_AGE_SECONDS:-86400}s); proactive rotation via recovery"
    circuit_guard_recover
    exit $?
  fi
  if ! probe_status "${PROBE_ATTEMPTS}"; then
    # W2-P1-7: the port is OPEN but /status never answered inside the
    # (generous) probe budget: the server is slow-but-alive, not dead.
    # Its CDP evaluate alone allows 15s, so a timeout is not a death
    # certificate. Grant one full extra probe round before any verdict;
    # never recover-against a slow-but-listening helper on a timeout.
    if tcp_port_open "${SERVER_PORT}"; then
      log "port ${SERVER_PORT} is listening but /status exceeded the probe budget; treating as slow-but-alive: one more probe round before any verdict"
      if probe_status "${PROBE_ATTEMPTS}"; then
        : # fell through with a fresh status_body: judge it normally
      else
        log "slow helper still not answering after the grace round; triggering recovery"
        circuit_guard_recover
        exit $?
      fi
    else
      log "status probe failed after ${PROBE_ATTEMPTS} attempts; triggering recovery"
      circuit_guard_recover
      exit $?
    fi
  fi
  # P1-25: "starting" (chromium alive, tab still at about:blank) is a
  # slow boot, not a signed-out session. Keep probing through the backoff
  # window; only after the wait do we judge. Never exit 2 here.
  local starting_rounds=0
  while [ "$(starting_state "${status_body}")" = "true" ]; do
    starting_rounds=$((starting_rounds + 1))
    if [ "${starting_rounds}" -gt "${STARTING_MAX_ROUNDS:-3}" ]; then
      break
    fi
    log "helper starting (round ${starting_rounds}); waiting ${RESTART_WAIT}s before judging"
    sleep "${RESTART_WAIT}"
    if ! probe_status "${PROBE_ATTEMPTS}"; then
      break
    fi
  done
  if [ "$(starting_state "${status_body}")" = "true" ]; then
    log "UNHEALTHY: helper stuck in 'starting' after ${starting_rounds} waits; attempting recovery"
    circuit_guard_recover
    exit $?
  fi
  evaluate_status
}

if [ -z "${KEEPALIVE_SOURCE_ONLY:-}" ]; then
  main "$@"
fi
