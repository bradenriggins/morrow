#!/bin/bash
# scripts/uninstall.sh: remove a Morrow for Muse install completely.
#
# Stops the helper, Chromium, and the proxy forwarder (if running),
# removes the keepalive cron entries, and deletes the tree, the state
# dir, the browser profile, the browser transient state (pending
# envelopes, briefs), and the learner source vault. Then verifies every
# removal.
#
# Usage: ./scripts/uninstall.sh [--yes] [--disconnect]
# Without --yes it prints what it will do and asks for confirmation.
#
# --disconnect (what `bin/morrow disconnect` runs): end the Canvas
# connection and keep the install. Stops the same processes and removes
# the same cron entries (so keepalive cannot relaunch the signed-in
# helper), then deletes only the session material: the helper browser
# profile, the pinned account (browser_lane.json), the rig session
# record, and the browser transient state. The tree, settings, audit
# journal, and learner vault stay. Reconnect by rerunning install.sh
# and signing in again.
#
# Safety: this script NEVER uses pkill, killall, or pgrep -f. Every
# process it stops is identified by exact PID: the PID holding the port
# is read from ss, the process's own /proc/PID/cmdline and /proc/PID/cwd
# are inspected to confirm it is really ours, and only then is that
# exact PID signaled. A process that fails to die makes the script fail
# loudly instead of guessing harder.
#
# Cron removal is NOT optional and NOT skippable: if the keepalive entry
# survives, it will resurrect the helper every 5 minutes. The script
# verifies no Morrow entry remains and fails loudly if one does. On a
# machine with no crontab, keepalive runs as a supervised background
# loop (helper/supervisor.py) instead; the script stops that loop first
# (exact PID, verified) and forgets it, so nothing restarts the helper.
set -u

TREE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TREE_REAL="$(readlink -f "${TREE}" 2>/dev/null || printf '%s' "${TREE}")"
HELPER_PORT="${LOGIN_HELPER_PORT:-8901}"
MORROW_HOME="${MORROW_HOME:-${HOME}/.morrow}"
# Round-4 L3: the profile is the one keepalive.sh always uses
# (<tree>/helper/profile; keepalive ignores LOGIN_HELPER_PROFILE_DIR).
# An env-supplied path is never deleted: a stray variable must not make
# disconnect remove an unrelated directory and keep the real session.
PROFILE_DIR="${TREE}/helper/profile"
# W4-P1-12: tree-specific cron marker (matches install.sh). Only this
# tree's marker and command are removed; other trees' entries survive.
CRON_MARKER="# morrow-muse-connector-keepalive"
if [ -f "${TREE}/.morrow-tree-id" ]; then
  _tid="$(tr -d '[:space:]' < "${TREE}/.morrow-tree-id" 2>/dev/null || true)"
  [ -n "${_tid}" ] && CRON_MARKER="# morrow-muse-connector-keepalive ${_tid}"
  unset _tid
fi

# W3-P2-4: the learner source vault honors MORROW_SOURCE_VAULT_PATH
# (same default/override logic as privacy/executor_wire.py:
# SOURCE_VAULT_ENV_VAR at line 40, _source_vault_path() at lines
# 60-67). A relocated vault must be deleted too, or it survives a
# "clean" uninstall with every issued label still resolvable. The
# vault's AES key sits at <vault path>.key.
if [ -n "${MORROW_SOURCE_VAULT_PATH:-}" ]; then
  VAULT_PATH="${MORROW_SOURCE_VAULT_PATH}"
else
  VAULT_PATH="${MORROW_HOME}/morrow_source_vault.json"
fi

CONFIRM=1
MODE=uninstall
for _a in "$@"; do
  case "${_a}" in
    --yes) CONFIRM=0 ;;
    --disconnect) MODE=disconnect ;;
    *) printf 'usage: %s [--yes] [--disconnect]\n' "$0" >&2; exit 2 ;;
  esac
done
unset _a
# Session material a disconnect removes (the educator's records stay).
DISCONNECT_PATHS="${PROFILE_DIR} ${MORROW_HOME}/browser_lane.json ${MORROW_HOME}/browser_lane.json.lock ${MORROW_HOME}/session.json ${MORROW_HOME}/session.json.prev ${MORROW_HOME}/principal_pin.json ${MORROW_HOME}/browser-pending ${MORROW_HOME}/browser-briefs"

die() { printf 'UNINSTALL FAIL: %s\n' "$1" >&2; exit 1; }
note() { printf '%s\n' "$1"; }

pid_holding_port() {
  # Print the PID listening on TCP 127.0.0.1:$1, or nothing.
  # (Parses ss output; no pgrep, no pattern matching on cmdlines.)
  ss -ltnp 2>/dev/null | awk -v port=":$1" '
    $0 ~ /127\.0\.0\.1/ && index($4, port) {
      if (match($0, /pid=[0-9]+/)) {
        pid = substr($0, RSTART + 4, RLENGTH - 4)
        print pid
        exit
      }
    }'
}

proc_is_ours() {
  # $1 = pid, $2 = description of what we expect. Returns 0 only if the
  # process exists AND its own cmdline/cwd tie it to this install.
  # W3-P1-18: no substring matches, no bare cwd prefixes. The cwd must
  # EQUAL the tree or sit UNDER it with a slash boundary
  # (/x/tree-backup is NOT under /x/tree); the cmdline must contain the
  # exact tree path as a PATH ELEMENT (an argv token equal to the tree
  # or starting with "<tree>/"). A token merely containing the tree
  # path as a substring never passes.
  _pid="$1"
  [ -d "/proc/${_pid}" ] || return 1
  _cwd="$(readlink -f "/proc/${_pid}/cwd" 2>/dev/null || true)"
  case "${_cwd}" in
    "${TREE}"|"${TREE}/"*|"${TREE_REAL}"|"${TREE_REAL}/"*) return 0 ;;
  esac
  while IFS= read -r _tok; do
    case "${_tok}" in
      "${TREE}"|"${TREE}/"*|"${TREE_REAL}"|"${TREE_REAL}/"*) return 0 ;;
    esac
  done < <(tr '\0' '\n' < "/proc/${_pid}/cmdline" 2>/dev/null || true)
  printf 'process %s does not look like ours (cmdline has no %s path element; cwd=%s); refusing to touch it\n' \
    "${_pid}" "${TREE}" "${_cwd}" >&2
  return 1
}

_chromium_user_data_dir() {
  # $1 = pid. Prints the process's exact --user-data-dir argv value, or
  # empty. Exact argv-element match (W3-P1-17): a profile dir that merely
  # contains ours as a substring (profile2, profile-backup) never
  # matches; the realpath comparison below settles the rest.
  _p="$1"; _arg=""; _val=""; _next=0
  while IFS= read -r _arg; do
    if [ "${_next}" = "1" ]; then _val="${_arg}"; _next=0; continue; fi
    case "${_arg}" in
      --user-data-dir=*) _val="${_arg#--user-data-dir=}" ;;
      --user-data-dir) _next=1 ;;
    esac
  done < <(tr '\0' '\n' < "/proc/${_p}/cmdline" 2>/dev/null || true)
  printf '%s' "${_val}"
}

_same_dir() {
  # True when both paths resolve (readlink -f) to the same dir.
  _a="$(readlink -f "$1" 2>/dev/null || printf '%s' "$1")"
  _b="$(readlink -f "$2" 2>/dev/null || printf '%s' "$2")"
  [ "${_a}" = "${_b}" ]
}

# W3-P2-14: true when a crontab line is a non-comment schedule entry
# whose command resolves (readlink -f) to this tree's keepalive.sh.
# Catches wrapper paths, symlinks, and bash -c indirection that a
# literal-string match misses. Never matches comment lines.
_KEEPALIVE_REAL="$(readlink -f "${TREE}/helper/keepalive.sh" 2>/dev/null \
  || printf '%s' "${TREE}/helper/keepalive.sh")"
_resolves_to_keepalive() {
  # $1 = path-ish token. True when readlink -f lands on our
  # keepalive.sh, or when it names a wrapper *script* whose text names
  # a path resolving to our keepalive.sh (bounded: first 40 lines;
  # read-only). A symlink wrapper is caught by the readlink leg; an
  # exec-wrapper script by the content leg.
  _rt="$(readlink -f "$1" 2>/dev/null || true)"
  if [ -n "${_rt}" ] && [ "${_rt}" = "${_KEEPALIVE_REAL}" ]; then
    return 0
  fi
  if [ -n "${_rt}" ] && [ -f "${_rt}" ]; then
    while IFS= read -r _wl; do
      for _wtok in ${_wl}; do
        case "${_wtok}" in
          *keepalive.sh*)
            _wt="$(printf '%s' "${_wtok}" | tr -d "\"'();")"
            case "${_wt}" in
              */*)
                _wr="$(readlink -f "${_wt}" 2>/dev/null || true)"
                if [ -n "${_wr}" ] && [ "${_wr}" = "${_KEEPALIVE_REAL}" ]; then
                  return 0
                fi
                ;;
            esac
            ;;
        esac
      done
    done < <(head -40 "${_rt}" 2>/dev/null || true)
  fi
  return 1
}
_cron_line_is_ours() {
  _l="$1"
  case "${_l}" in ""|\#*) return 1 ;; esac
  # Strip the five schedule fields; the rest is the command.
  _cmd="$(printf '%s' "${_l}" | awk '{for(i=6;i<=NF;i++) printf "%s%s", $i, (i<NF ? " " : "\n")}')"
  [ -n "${_cmd}" ] || return 1
  case "${_cmd}" in *"${TREE}/helper/keepalive.sh"*) return 0 ;; esac
  for _tok in ${_cmd}; do
    case "${_tok}" in -*|*=*) continue ;; esac
    _t="$(printf '%s' "${_tok}" | tr -d "\"'")"
    case "${_t}" in
      */*) _resolves_to_keepalive "${_t}" && return 0 ;;
      *)   _v="$(command -v "${_t}" 2>/dev/null || true)"
           [ -n "${_v}" ] && _resolves_to_keepalive "${_v}" && return 0 ;;
    esac
  done
  return 1
}
_is_removal_target() {
  # Our keepalive entries plus our own marker comment line.
  _cron_line_is_ours "$1" && return 0
  case "$1" in *"${CRON_MARKER}"*) return 0 ;; esac
  return 1
}

stop_port_holder() {
  # $1 = port, $2 = human label. Stops the exact PID holding the port
  # after confirming it belongs to this install, then verifies the
  # port is free.
  _port="$1"; _label="$2"
  _pid="$(pid_holding_port "${_port}")"
  [ -z "${_pid}" ] && { note "${_label}: port ${_port} is free; nothing to stop"; return 0; }
  proc_is_ours "${_pid}" "${_label}" \
    || die "${_label}: port ${_port} is held by PID ${_pid}, which is not this install's process; refusing to kill it"
  note "${_label}: stopping PID ${_pid} (port ${_port})"
  kill "${_pid}" 2>/dev/null \
    || die "${_label}: could not signal PID ${_pid}"
  for _i in $(seq 1 20); do
    [ -d "/proc/${_pid}" ] || break
    sleep 0.5
  done
  if [ -d "/proc/${_pid}" ]; then
    kill -9 "${_pid}" 2>/dev/null || true
    sleep 1
  fi
  [ -d "/proc/${_pid}" ] \
    && die "${_label}: PID ${_pid} would not die; refusing to continue while it holds port ${_port}"
  [ -z "$(pid_holding_port "${_port}")" ] \
    || die "${_label}: port ${_port} is still held after stopping PID ${_pid}"
  note "${_label}: stopped; port ${_port} is free"
}

if [ "${MODE}" = "disconnect" ]; then
note "Morrow for Muse disconnect. This will:"
note "  1. stop the helper (port ${HELPER_PORT}) and its Chromium, if running"
note "  2. stop the keepalive background loop and remove the keepalive cron entries (otherwise keepalive relaunches the signed-in helper within 5 minutes)"
note "  3. delete the Canvas session material:"
for _p in ${DISCONNECT_PATHS}; do note "          ${_p}"; done
note "  It keeps this install, your settings, the audit journal, and the learner vault."
note ""
else
note "Morrow for Muse uninstall. This will:"
note "  1. stop the helper (port ${HELPER_PORT}), Chromium (CDP port from helper config), and the proxy forwarder, if running"
note "  2. stop the keepalive background loop and remove the keepalive cron entries (REQUIRED: a surviving entry resurrects the helper every 5 minutes)"
note "  3. delete: ${TREE}"
note "          ${MORROW_HOME}"
note "          ${PROFILE_DIR}"
note "          ${VAULT_PATH} (+ .key; the learner source vault, honoring MORROW_SOURCE_VAULT_PATH)"
note "          upgrade backups ${TREE}.bak-* (incl. .PARTIAL) and failed trees ${TREE}.failed-*"
# W6-P2-D3: the open-file-descriptor caveat must be acted on BEFORE the
# destructive step, so it prints here (ahead of confirmation, and
# ahead of the --yes bypass), not at the end after deletion.
note ""
note "W4-P2-12 caveat (OS-inherent, outside this script's control): bytes"
note "already held open by other processes (for example a long-lived agent"
note "python with the vault or journal open) cannot be revoked by"
note "unlinking. Close agent sessions BEFORE uninstalling; after the"
note "files are gone, their open file descriptors still readable via"
note "/proc/<pid>/fd keep the old bytes alive in that process until it"
note "exits."
note ""
fi
if [ "${CONFIRM}" = "1" ]; then
  if [ ! -t 0 ]; then
    # No terminal (an agent run): there is nobody to answer the prompt.
    # The educator confirms in chat; the agent then passes --yes.
    if [ "${MODE}" = "disconnect" ]; then
      _yes_cmd="bin/morrow disconnect --yes"
    else
      _yes_cmd="scripts/uninstall.sh --yes"
    fi
    die "nothing was changed: there is no terminal to type \"yes\" in. Ask the educator to confirm, then run ${_yes_cmd}"
  fi
  printf 'Type "yes" to continue: '
  read -r _ans
  [ "${_ans}" = "yes" ] || die "aborted by user"
fi

# -- 1. stop the processes -------------------------------------------------
step_n=1
note "--- ${step_n}. stopping processes"
# The keepalive background loop goes first, so it cannot relaunch the
# helper while the helper is being stopped.
if [ -f "${TREE}/helper/supervisor.py" ]; then
  if _sup_out="$(PYTHONDONTWRITEBYTECODE=1 python3 "${TREE}/helper/supervisor.py" uninstall --tree "${TREE}" 2>&1)"; then
    note "keepalive background loop: ${_sup_out}"
  else
    die "could not stop the keepalive background loop: ${_sup_out}"
  fi
  unset _sup_out
fi
stop_port_holder "${HELPER_PORT}" "helper"

# CDP port: read it from this tree's helper/env (LOGIN_HELPER_CDP_PORT)
# if present, else fall back to the product default 19223. Chromium is
# identified by its exact --user-data-dir (helper profile chromium),
# never by a literal port.
_CDP_PORT="19223"
_cfg="${TREE}/helper/env"
if [ -f "${_cfg}" ]; then
  _found="$(grep -E '^[[:space:]]*LOGIN_HELPER_CDP_PORT=' "${_cfg}" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d "[:space:]\"'")" \
    && [ -n "${_found}" ] && _CDP_PORT="${_found}"
fi
unset _cfg _found
_CDP_PID="$(pid_holding_port "${_CDP_PORT}")"
if [ -n "${_CDP_PID}" ]; then
  # W3-P1-17: Chromium is identified by its EXACT --user-data-dir argv
  # value resolving to this install's profile dir (realpath compare, as
  # in keepalive.sh's reap_helper_chromium), never by a substring.
  # <tree>/helper/profile2 or profile-backup must not match.
  _udd="$(_chromium_user_data_dir "${_CDP_PID}")"
  if [ -n "${_udd}" ] && _same_dir "${_udd}" "${PROFILE_DIR}"; then
    note "chromium: stopping PID ${_CDP_PID} (exact --user-data-dir match: ${PROFILE_DIR})"
    kill "${_CDP_PID}" 2>/dev/null || die "chromium: could not signal PID ${_CDP_PID}"
    for _i in $(seq 1 20); do
      [ -d "/proc/${_CDP_PID}" ] || break
      sleep 0.5
    done
    [ -d "/proc/${_CDP_PID}" ] && die "chromium: PID ${_CDP_PID} would not die"
  else
    die "chromium: port ${_CDP_PORT} is held by PID ${_CDP_PID}, whose --user-data-dir '${_udd}' is not this install's profile; refusing to kill it"
  fi
else
  note "chromium: CDP port ${_CDP_PORT} is free; nothing to stop"
fi

# Proxy forwarder: same resolution as helper/keepalive.sh. The tree's
# helper/env may pin FORWARDER_PORT (or MORROW_FORWARDER_PORT); exported
# env vars win the same way; otherwise it is derived as CDP port + 10000
# (below the ephemeral range), so two trees never share a forwarder.
# Identified by its real argv (the forwarder module path under this
# tree); never by name pattern.
_FWD_PORT=""
_cfg="${TREE}/helper/env"
if [ -f "${_cfg}" ]; then
  _found="$(grep -E '^[[:space:]]*FORWARDER_PORT=' "${_cfg}" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d "[:space:]\"'")"
  [ -z "${_found}" ] && _found="$(grep -E '^[[:space:]]*MORROW_FORWARDER_PORT=' "${_cfg}" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d "[:space:]\"'")"
  [ -n "${_found}" ] && _FWD_PORT="${_found}"
fi
unset _cfg _found
if [ -z "${_FWD_PORT}" ]; then
  if [ -n "${FORWARDER_PORT:-}" ]; then
    _FWD_PORT="${FORWARDER_PORT}"
  elif [ -n "${MORROW_FORWARDER_PORT:-}" ]; then
    _FWD_PORT="${MORROW_FORWARDER_PORT}"
  elif [[ "${_CDP_PORT}" =~ ^[0-9]+$ ]]; then
    _FWD_PORT="$((_CDP_PORT + 10000))"
  else
    note "forwarder: CDP port '${_CDP_PORT}' is not numeric; cannot derive the forwarder port, skipping"
  fi
fi
if [ -n "${_FWD_PORT}" ]; then
  _FWD_PID="$(pid_holding_port "${_FWD_PORT}")"
  if [ -n "${_FWD_PID}" ]; then
    _cmd="$(tr '\0' ' ' < "/proc/${_FWD_PID}/cmdline" 2>/dev/null || true)"
    case "${_cmd}" in
      *"${TREE}"*proxy*|*proxy*"${TREE}"*)
        note "forwarder: stopping PID ${_FWD_PID} (argv ties it to this tree)"
        kill "${_FWD_PID}" 2>/dev/null || die "forwarder: could not signal PID ${_FWD_PID}"
        for _i in $(seq 1 20); do
          [ -d "/proc/${_FWD_PID}" ] || break
          sleep 0.5
        done
        [ -d "/proc/${_FWD_PID}" ] && die "forwarder: PID ${_FWD_PID} would not die"
        ;;
      *)
        die "forwarder: port ${_FWD_PORT} is held by PID ${_FWD_PID}, which does not look like this install's forwarder; refusing to kill it"
        ;;
    esac
  else
    note "forwarder: port ${_FWD_PORT} is free; nothing to stop"
  fi
else
  note "forwarder: no forwarder port could be resolved; skipping"
fi

# -- 2. cron removal (REQUIRED, verified) ----------------------------------
step_n=2
note "--- ${step_n}. removing keepalive cron entries"
if command -v crontab >/dev/null 2>&1; then
  _cron_now="$(crontab -l 2>/dev/null || true)"
else
  # No crontab on this machine means no cron entry can exist; the
  # background loop (the supervision used instead) was stopped above.
  note "no crontab on this machine: there are no cron entries to remove (the keepalive background loop was stopped above)"
  _cron_now=""
fi
# W3-P2-14: find this tree's keepalive entries by RESOLVING each entry's
# command target (readlink -f), not by literal string match. A wrapper
# path (/usr/local/bin/morrow-keepalive), a symlink, or a
# bash -c indirection all resolve to this tree's keepalive.sh and are
# removed; and "verified" is only printed when the re-scan truly finds
# nothing (a surviving entry would resurrect the helper every 5 min).
_mine=""
while IFS= read -r _l || [ -n "${_l}" ]; do
  if _is_removal_target "${_l}"; then
    _mine="${_mine}${_l}
"
  fi
done <<_CRON_EOF
${_cron_now}
_CRON_EOF
if [ -z "${_mine}" ]; then
  note "no morrow keepalive cron entries found"
else
  note "found morrow keepalive cron entries; removing:"
  printf '%s' "${_mine}" | sed 's/^/  removing: /'
  _cron_new=""
  while IFS= read -r _l || [ -n "${_l}" ]; do
    if _is_removal_target "${_l}"; then continue; fi
    _cron_new="${_cron_new}${_l}
"
  done <<_CRON_EOF
${_cron_now}
_CRON_EOF
  _cron_new="$(printf '%s' "${_cron_new}" | grep -v '^$' || true)"
  if [ -z "${_cron_new}" ]; then
    crontab -r 2>/dev/null || printf '' | crontab -
  else
    printf '%s\n' "${_cron_new}" | crontab -
  fi
  _after="$(crontab -l 2>/dev/null || true)"
  _leftover=""
  while IFS= read -r _l || [ -n "${_l}" ]; do
    if _is_removal_target "${_l}"; then
      _leftover="${_leftover}${_l}
"
    fi
  done <<_CRON_EOF
${_after}
_CRON_EOF
  [ -n "${_leftover}" ] \
    && die "cron entries still present after removal; the helper would resurrect every 5 minutes. Remove them by hand with 'crontab -e':$(printf '\n%s' "${_leftover}" | sed 's/^/  /')"
  note "cron removal verified: no morrow entries remain."
  note "WARNING: if you skip this step on a future manual uninstall, the keepalive WILL resurrect the helper every 5 minutes."
fi
unset _l _cmd _tok _t _v _mine _cron_new _after _leftover

if [ "${MODE}" = "disconnect" ]; then
  note "--- 3. deleting the Canvas session material"
  for _p in ${DISCONNECT_PATHS}; do
    case "${_p}" in
      ""|"/"|"${HOME}"|"${HOME}/."|"${MORROW_HOME}"|"${TREE}") die "refusing to delete unsafe path: ${_p}" ;;
    esac
  done
  _DISC_FAILED=0
  for _p in ${DISCONNECT_PATHS}; do
    if [ -e "${_p}" ] || [ -L "${_p}" ]; then
      if rm -rf "${_p}" 2>/dev/null; then
        note "deleted: ${_p}"
      else
        printf 'FAILED to delete: %s\n' "${_p}" >&2
        _DISC_FAILED=1
      fi
    fi
  done
  [ "${_DISC_FAILED}" = "0" ] || die "one or more session paths could not be deleted; see above"
  note "--- 4. verifying"
  for _p in ${DISCONNECT_PATHS}; do
    if [ -e "${_p}" ] || [ -L "${_p}" ]; then
      printf 'STILL PRESENT: %s\n' "${_p}" >&2
      _DISC_FAILED=1
    fi
  done
  for _port in "${HELPER_PORT}" "${_CDP_PORT:-19223}"; do
    [ -n "$(pid_holding_port "${_port}")" ] \
      && { printf 'PORT STILL HELD: %s\n' "${_port}" >&2; _DISC_FAILED=1; }
  done
  _after="$(crontab -l 2>/dev/null || true)"
  while IFS= read -r _l || [ -n "${_l}" ]; do
    _is_removal_target "${_l}" && { printf 'CRON ENTRY STILL PRESENT: %s\n' "${_l}" >&2; _DISC_FAILED=1; }
  done <<_CRON_EOF
${_after}
_CRON_EOF
  [ "${_DISC_FAILED}" = "0" ] || die "disconnect verification failed (see above)"
  note ""
  note "Disconnected. The helper is stopped, keepalive will not restart it, and the"
  note "Canvas sign-in on this machine is deleted. Morrow can no longer reach Canvas."
  note "To reconnect: run 'bash install.sh' from ${TREE}, then sign in on the helper page."
  exit 0
fi

# -- 3. delete the paths ---------------------------------------------------
step_n=3
note "--- ${step_n}. deleting install paths"
# W4-P0-4/W4-P0-5/W4-P2-11: purge browser transient state (pending
# envelopes holding raw provider payloads, brief files) through the
# package's own purge_transient_state() before the blunt rm, so
# envelope/brief deletion runs through the audited code path. The
# function hardcodes ~/.morrow; the rm loop below additionally covers
# a MORROW_HOME-override split (W4-P1-17). W5-P1-2: force=True because
# this uninstall deletes the journal tree immediately after (nothing
# can dangle); the privacy CLIs use the safe default that skips
# in-flight envelopes.
_TRANSIENT_DIRS="${MORROW_HOME}/browser-pending ${MORROW_HOME}/browser-briefs"
if [ -d "${MORROW_HOME}/browser-pending" ] || [ -d "${MORROW_HOME}/browser-briefs" ]; then
  if _purge_out="$(PYTHONDONTWRITEBYTECODE=1 python3 -c \
      'import sys; sys.path.insert(0, sys.argv[1]); from transport.browser_backend import purge_transient_state; print(purge_transient_state(force=True))' \
      "${TREE}" 2>&1)"; then
    note "purged transient browser state (pending, briefs): ${_purge_out}"
  else
    note "WARNING: package purge_transient_state() failed; falling back to rm:"
    note "${_purge_out}"
  fi
fi
for _p in "${TREE}" "${MORROW_HOME}" "${PROFILE_DIR}" "${VAULT_PATH}" "${VAULT_PATH}.key" ${_TRANSIENT_DIRS}; do
  case "${_p}" in
    ""|"/"|"${HOME}"|"${HOME}/.") die "refusing to delete unsafe path: ${_p}" ;;
  esac
done
# W4-P1-6: every deleted path is recorded in _REMOVED so the final
# summary enumerates what was ACTUALLY removed (not what was planned).
_delete_path() {
  # $1 = path to delete. Records removals in _REMOVED, failures in
  # _DELETE_FAILED.
  if [ -e "$1" ] || [ -L "$1" ]; then
    if rm -rf "$1" 2>/dev/null; then
      rm -f "$1.meta" 2>/dev/null || true
      note "deleted: $1"
      _REMOVED="${_REMOVED}$1
"
    else
      printf 'FAILED to delete: %s\n' "$1" >&2
      _DELETE_FAILED=1
    fi
  else
    note "already gone: $1"
  fi
}
_REMOVED=""; _DELETE_FAILED=0
for _p in "${TREE}" "${MORROW_HOME}" "${PROFILE_DIR}" "${VAULT_PATH}" "${VAULT_PATH}.key" ${_TRANSIENT_DIRS}; do
  _delete_path "${_p}"
done
# W4-P1-6: the installer leaves upgrade backups behind
# (${TREE}.bak-<ts> [+ .meta], ${TREE}.bak-<ts>.PARTIAL) and failed-upgrade
# trees (${TREE}.failed-<ts>); uninstall must remove those too, or
# "Gone: the tree" is false while they survive.
while IFS= read -r -d '' _b; do
  _delete_path "${_b}"
done < <(find "$(dirname "${TREE}")" -maxdepth 1 \
  \( -name "$(basename "${TREE}").bak-*" \
     -o -name "$(basename "${TREE}").failed-*" \) \
  -print0 2>/dev/null)
unset _b _p
[ "${_DELETE_FAILED}" = "0" ] || die "one or more paths could not be deleted; see above"

# -- 4. verify --------------------------------------------------------------
step_n=4
note "--- ${step_n}. verifying removal"
_FAILED=0
for _p in "${TREE}" "${MORROW_HOME}" "${PROFILE_DIR}" "${VAULT_PATH}" "${VAULT_PATH}.key" ${_TRANSIENT_DIRS}; do
  if [ -e "${_p}" ] || [ -L "${_p}" ]; then
    printf 'STILL PRESENT: %s\n' "${_p}" >&2
    _FAILED=1
  else
    note "verified gone: ${_p}"
  fi
done
for _port in "${HELPER_PORT}" "${_CDP_PORT:-19223}" ${_FWD_PORT:-}; do
  [ -z "${_port}" ] && continue
  [ -n "$(pid_holding_port "${_port}")" ] \
    && { printf 'PORT STILL HELD: %s\n' "${_port}" >&2; _FAILED=1; } \
    || note "verified free: port ${_port}"
done
# W4-P1-6: no upgrade backup / failed-tree residue may survive either.
_leftover_bak="$(find "$(dirname "${TREE}")" -maxdepth 1 \
  \( -name "$(basename "${TREE}").bak-*" \
     -o -name "$(basename "${TREE}").failed-*" \) 2>/dev/null)"
if [ -n "${_leftover_bak}" ]; then
  printf 'STILL PRESENT (backup residue):\n%s\n' "${_leftover_bak}" >&2
  _FAILED=1
fi
unset _leftover_bak
[ "${_FAILED}" = "1" ] && die "verification failed (see above)"
note ""
# W4-P1-6: the final summary enumerates what was ACTUALLY removed.
note "Uninstall complete. Removed:"
printf '%s' "${_REMOVED}" | sed 's/^/  /'
note "Gone: the tree, the state dir, the profile, upgrade backups, and failed trees."
note "Uninstall complete. Gone: the tree, ${MORROW_HOME}, the browser profile, the learner source vault (${VAULT_PATH} + .key), browser transient state (pending envelopes, briefs), the cron entries, and the running processes."
note ""
note "(The W4-P2-12 open-file-descriptor caveat printed before confirmation"
note "still applies: the 'verified gone' checks above cover the filesystem,"
note "not other processes' memory. Close any agent sessions you left open.)"
