#!/bin/bash
# keepalive_selftest.sh: executable contract tests for helper/keepalive.sh.
#
# Tests ONLY the shipped copy in this tree (helper/keepalive.sh). It never
# reads, sources, or probes any live helper tree or profile: those are
# read-only and off-limits to this suite.
#
# P0-8: exit 2 is emitted ONLY for the exact genuine-sign-out state:
#   logged_in=false + chromium_alive=true + starting=false.
# Unknown liveness (a keyless status body, as a legacy server emits),
# malformed status, dead Chromium after recovery, or a still-starting
# helper must NEVER exit 2.
#
# Method: the shipped keepalive is sourced with KEEPALIVE_SOURCE_ONLY=1 in
# a subshell; the dangerous/external functions (kill, reap, curl probe,
# nohup launch) are stubbed, so nothing is killed, launched, or touched.
# Never touches ports 8901/19223 or any live profile.
#
# Run: ./helper/keepalive_selftest.sh   (exit 0 = all pass)

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Scratch lives under HOME/workspace (never /tmp): the carve smoke's
# sandbox HOME and an educator's fresh machine have no workspace dir yet.
mkdir -p "${HOME}/workspace" \
  || { printf 'keepalive_selftest: cannot create %s/workspace\n' "${HOME}" >&2; exit 1; }

# Shipped copy only. There is deliberately no discovery of any other
# keepalive copy: this suite must never read the live helper's tree.
KA_SHIPPED="${HERE}/keepalive.sh"

BODY_HEALTHY='{"logged_in": true, "chromium_alive": true, "starting": false}'
BODY_SIGNOUT='{"logged_in": false, "chromium_alive": true, "starting": false}'
BODY_DEAD='{"logged_in": false, "chromium_alive": false, "starting": false}'
BODY_STARTING='{"logged_in": false, "chromium_alive": true, "starting": true}'
BODY_LEGACY='{"logged_in": false}'
BODY_NO_STARTING='{"logged_in": false, "chromium_alive": true}'
BODY_MALFORMED='not-json{{{'

# RESULTS is (re)created per copy by the driver loop below (W3-P2-10);
# pass()/fail() append to whatever file it names at call time.
pass() { printf 'PASS\n' >> "${RESULTS}"; }
fail() { printf 'FAIL|%s|%s|%s|%s\n' "$1" "$2" "$3" "$4" >> "${RESULTS}"; }

# Runs the full matrix against the shipped keepalive, inside a subshell
# so its function definitions never leak into this script.
test_shipped() {
  local ka="${KA_SHIPPED}" label="[shipped] helper/keepalive.sh"
  (
    SCRATCH="$(mktemp -d "${HOME}/workspace/.keepalive-selftest-XXXXXX")"
    # W3-P1-14/W3-P2-13: every tree-state path the keepalive touches
    # (journal, cooldown stamp, token file) resolves under a scratch
    # state dir for the suite, never the real ~/.morrow. Exported
    # BEFORE sourcing so every (re)source of the keepalive under test
    # inherits it; the memory-watch cases below assert against
    # ${TREE_STATE_DIR}, which the keepalive itself computes from this.
    export MORROW_TREE_STATE_DIR="${SCRATCH}/tree-state"
    # Everything else under MORROW_HOME (the legacy env, lane state)
    # resolves under scratch too, never the real ~/.morrow.
    export MORROW_HOME="${SCRATCH}/morrow-home"
    mkdir -p "${MORROW_HOME}"
    export KEEPALIVE_SOURCE_ONLY=1
    # shellcheck disable=SC1090
    . "${ka}"

    # --- stub the dangerous / external surface -------------------------
    CASE_LOG="$(mktemp "${HOME}/workspace/.keepalive-selftest-log-XXXXXX")"
    log() { printf '%s\n' "$*" >> "${CASE_LOG}"; }
    sleep() { :; }
    nohup() { :; }
    disown() { :; }
    kill_helper_server() { return 0; }
    reap_helper_chromium() { :; }
    wait_for_chromium_exit() { return 0; }
    ensure_forwarder() { return 0; }   # stubbed: never launched for real
    # W2-P1-14: the foreign-browser check scans the real CDP port. Without
    # this stub the suite's outcome depends on whether a real Chromium
    # holds the port on the test machine (it does here: the live helper).
    # Default: no holder. One case below redefines it to a foreign dir.
    cdp_holder_profile_dir() { return 0; }
    # W4-P0-3 (pipe edition): the shipped recover_helper verifies after
    # a restart that a pipe-Chromium holds THIS tree's pinned profile.
    # The real scan enumerates /proc, which would make the suite depend
    # on the test machine's browsers (and must never touch the live
    # helper's browser). Default: our browser holds the profile (a fake
    # pid); cases below redefine these for the ABORT paths.
    pipe_holder_pid_for_profile() { printf '%s\n' "424242"; }
    _chromium_pids_with_debug_pipe() { return 0; }
    # W2-P1-16: healthy bodies must carry this tree's helper_version, else
    # the deploy copy's skew check recycles instead of adopting. The live
    # copy predates the marker, so the extra field is harmless there.
    BODY_HEALTHY_V="{\"logged_in\": true, \"chromium_alive\": true, \"starting\": false, \"helper_version\": \"${TREE_VERSION:-unknown}\"}"
    # Runtime logs resolve under the tree state dir, never the tree
    # (install.sh's secrets gate and integrity walk read the tree).
    _ka_log_real="${KEEPALIVE_LOG}"; _srv_log_real="${SERVER_LOG}"
    HELPER_DIR="${SCRATCH}"           # recover_helper's cd lands here
    CANVAS_BASE="https://example.instructure.com"
    PROBE_BODY=""
    probe_status() { status_body="${PROBE_BODY}"; return 0; }

    local got rc
    t() { # $1=name $2=expected $3=actual
      if [ "$2" = "$3" ]; then pass; else fail "${label}" "$1" "$2" "$3"; fi
    }

    t "keepalive.log lives in the tree state dir" \
      "${TREE_STATE_DIR}/keepalive.log" "${_ka_log_real}"
    t "server.log lives in the tree state dir" \
      "${TREE_STATE_DIR}/server.log" "${_srv_log_real}"

    # --- genuine_signout(): true only for the exact sign-out state ------
    got="$(genuine_signout "${BODY_SIGNOUT}")"
    t "genuine_signout: exact sign-out state -> true" "true" "${got}"
    got="$(genuine_signout "${BODY_DEAD}")"
    t "genuine_signout: dead chromium -> false" "false" "${got}"
    got="$(genuine_signout "${BODY_STARTING}")"
    t "genuine_signout: still starting -> false" "false" "${got}"
    got="$(genuine_signout "${BODY_LEGACY}")"
    t "genuine_signout: unknown liveness (keyless body) -> false" "false" "${got}"
    got="$(genuine_signout "${BODY_NO_STARTING}")"
    t "genuine_signout: starting unknown -> false" "false" "${got}"
    got="$(genuine_signout "${BODY_HEALTHY}")"
    t "genuine_signout: healthy -> false" "false" "${got}"
    got="$(genuine_signout "${BODY_MALFORMED}")"
    t "genuine_signout: malformed body -> false" "false" "${got}"

    # --- evaluate_status(): exit codes ----------------------------------
    # (evaluate_status calls exit, so each case runs in a subshell.)
    status_body="${BODY_HEALTHY_V}"; ( evaluate_status ); rc=$?
    t "evaluate_status: healthy -> exit 0" "0" "${rc}"
    status_body="${BODY_SIGNOUT}"; ( evaluate_status ); rc=$?
    t "evaluate_status: genuine sign-out -> exit 2" "2" "${rc}"
    status_body="${BODY_LEGACY}"; ( evaluate_status ); rc=$?
    t "evaluate_status: unknown liveness (keyless body) -> exit 1 (never 2)" "1" "${rc}"
    status_body="${BODY_MALFORMED}"; ( evaluate_status ); rc=$?
    t "evaluate_status: malformed body -> exit 1 (never 2)" "1" "${rc}"
    status_body="${BODY_STARTING}"; ( evaluate_status ); rc=$?
    t "evaluate_status: still starting -> exit 1 (never 2)" "1" "${rc}"
    status_body="${BODY_NO_STARTING}"; ( evaluate_status ); rc=$?
    t "evaluate_status: starting unknown -> exit 1 (never 2)" "1" "${rc}"

    # Dead Chromium must take the recovery path (exact log line), not exit 2.
    : > "${CASE_LOG}"
    PROBE_BODY="${BODY_HEALTHY_V}"
    status_body="${BODY_DEAD}"; ( evaluate_status ); rc=$?
    t "evaluate_status: dead chromium recovers -> exit 0 via recovery" "0" "${rc}"
    if grep -qF "chromium dead, restarting (not a sign-out)" "${CASE_LOG}"; then
      pass
    else
      fail "${label}" "evaluate_status: dead chromium logs exact line" \
        "chromium dead, restarting (not a sign-out)" "(missing from log)"
    fi

    # --- recover_helper(): post-restart verdict --------------------------
    PROBE_BODY="${BODY_HEALTHY_V}"; ( recover_helper ); rc=$?
    t "recover_helper: healthy after restart -> return 0" "0" "${rc}"
    # W2-P1-14: a foreign browser holding our CDP port aborts the
    # recovery (return 1, exact ABORT line) instead of serving it. The
    # case only runs where the feature exists.
    if grep -qF "FOREIGN browser" "${ka}"; then
      : > "${CASE_LOG}"
      cdp_holder_profile_dir() { printf '%s' "/some/foreign/profile"; }
      PROBE_BODY="${BODY_HEALTHY_V}"; ( recover_helper ); rc=$?
      t "recover_helper: foreign browser on CDP port -> return 1 (never 0)" \
        "1" "${rc}"
      if grep -qF "FOREIGN browser" "${CASE_LOG}"; then
        pass
      else
        fail "${label}" "recover_helper logs the FOREIGN browser ABORT" \
          "ABORT line" "(missing from log)"
      fi
      cdp_holder_profile_dir() { return 0; }   # restore the no-holder stub
    fi
    # W4-P0-3 (pipe edition): no pipe-Chromium holds our profile after
    # the restart -> the recovery ABORTS (return 1, exact ABORT line),
    # never a false-healthy 0. Only the shipped copy has this check,
    # so the cases are feature-gated.
    if grep -qF "pipe_holder_pid_for_profile" "${ka}"; then
      : > "${CASE_LOG}"
      pipe_holder_pid_for_profile() { return 0; }
      PROBE_BODY="${BODY_HEALTHY_V}"; ( recover_helper ); rc=$?
      t "recover_helper: no pipe holder for our profile -> return 1" \
        "1" "${rc}"
      if grep -qF "ABORT: no pipe-Chromium holds this tree's profile" \
          "${CASE_LOG}"; then
        pass
      else
        fail "${label}" "recover_helper logs the no-pipe-holder ABORT" \
          "ABORT line" "(missing from log)"
      fi
      # A foreign tree's pipe-Chromium enumerating must not satisfy our
      # profile check either (first-match scans would false-pass here).
      : > "${CASE_LOG}"
      _chromium_pids_with_debug_pipe() { printf '%s\n' "999999"; }
      PROBE_BODY="${BODY_HEALTHY_V}"; ( recover_helper ); rc=$?
      t "recover_helper: only a foreign pipe holder -> return 1" \
        "1" "${rc}"
      if grep -qF "ABORT: pipe-Chromium processes exist but none holds this tree's profile" \
          "${CASE_LOG}"; then
        pass
      else
        fail "${label}" \
          "recover_helper logs the foreign-pipe-holder ABORT" \
          "ABORT line" "(missing from log)"
      fi
      pipe_holder_pid_for_profile() { printf '%s\n' "424242"; }
      _chromium_pids_with_debug_pipe() { return 0; }   # restore stubs
    fi
    PROBE_BODY="${BODY_SIGNOUT}"; ( recover_helper ); rc=$?
    t "recover_helper: confirmed sign-out after restart -> return 2" "2" "${rc}"
    PROBE_BODY="${BODY_LEGACY}"; ( recover_helper ); rc=$?
    t "recover_helper: unknown liveness after restart -> return 1 (never 2)" "1" "${rc}"
    PROBE_BODY="${BODY_DEAD}"; ( recover_helper ); rc=$?
    t "recover_helper: still-dead chromium after restart -> return 1 (never 2)" "1" "${rc}"
    PROBE_BODY="${BODY_STARTING}"; ( recover_helper ); rc=$?
    t "recover_helper: still starting after restart -> return 1 (never 2)" "1" "${rc}"
    PROBE_BODY="${BODY_MALFORMED}"; ( recover_helper ); rc=$?
    t "recover_helper: malformed status after restart -> return 1 (never 2)" "1" "${rc}"

    # --- helper auth token ------------------------------------------------
    # recover_helper mints a per-tree token (0600) when missing; the
    # value is never logged and reaches the server via HELPER_AUTH_TOKEN.
    # Runs where the feature exists (both copies, after the live repair).
    if grep -qF 'helper_token' "${ka}"; then
      _tokfile=""
      if [ -n "${TREE_STATE_DIR:-}" ] && [ -f "${TREE_STATE_DIR}/helper_token" ]; then
        _tokfile="${TREE_STATE_DIR}/helper_token"
      fi
      if [ -z "${_tokfile}" ]; then
        fail "${label}" "helper auth token file minted" \
          "a helper_token file" "none found"
      else
        t "helper auth token file is mode 0600" "600" \
          "$(python3 -c 'import os, sys; print("%o" % (os.stat(sys.argv[1]).st_mode & 0o777))' "${_tokfile}" 2>/dev/null)"
        if grep -qE '^[0-9a-f]{64}$' "${_tokfile}"; then pass; else
          fail "${label}" "helper auth token is 64 hex chars" \
            "64 hex" "malformed"; fi
        if grep -qF "$(cat "${_tokfile}")" "${CASE_LOG}"; then
          fail "${label}" "helper auth token never logged" \
            "absent from log" "LEAKED into log"
        else pass; fi
      fi
    fi

    # --- W2-P1-33: per-tree forwarder port --------------------------------
    # Derived from the tree's CDP port (+10000); two trees never share
    # an upstream forwarder. An explicit FORWARDER_PORT still wins.
    # Older copies predate the derivation, so these cases only run
    # where the feature exists.
    if grep -qF 'CDP_PORT + 10000' "${ka}"; then
    (
      unset FORWARDER_PORT MORROW_FORWARDER_PORT
      LOGIN_HELPER_CDP_PORT=19299
      # shellcheck disable=SC1090
      . "${ka}"
      t "FORWARDER_PORT defaults to CDP_PORT+10000" "29299" "${FORWARDER_PORT}"
    )
    (
      FORWARDER_PORT=18811
      LOGIN_HELPER_CDP_PORT=19299
      # shellcheck disable=SC1090
      . "${ka}"
      t "explicit FORWARDER_PORT wins over the derivation" "18811" "${FORWARDER_PORT}"
    )
    fi

    # --- W3-P2-38: daemon spawns must not inherit the keepalive lock ------
    # The lock is held via fd 9 for the whole run. A nohup'd daemon inherits
    # fd 9 by default; the inherited flock then wedges every future keepalive
    # run ("another keepalive run holds the lock; skipping") forever, leaving
    # the supervisor permanently blind. Every nohup spawn line must carry
    # 9>&- (applies to the child only; the parent keeps the lock).
    _nohup_total="$(grep -c 'nohup ' "${ka}" || true)"
    _nohup_closed="$(grep -c 'nohup .*9>&-' "${ka}" || true)"
    t "all nohup daemon spawns close the lock fd (${_nohup_closed}/${_nohup_total})" \
      "${_nohup_total}" "${_nohup_closed}"

    # --- W2-P0-6 / W2-P1-31: tree-gated kill ------------------------------
    # B's keepalive must refuse to kill A's server. Exercises the REAL
    # kill_helper_server (re-sourced in a nested subshell without the
    # suite's stub) with stubbed ss/kill and real background processes
    # whose argv[0] is faked via `exec -a`. Cleanup kills by exact PID.
    if grep -qF "holder_belongs_to_tree" "${ka}"; then
      (
        unset -f kill_helper_server
        # shellcheck disable=SC1090
        . "${ka}"   # KEEPALIVE_SOURCE_ONLY=1 inherited; real fns return
        log() { printf '%s\n' "$*" >> "${CASE_LOG}"; }
        sleep() { :; }
        # W3-P0-20: the exact gate needs an argv ELEMENT exactly equal
        # to ${HELPER_DIR}/server.py AND a cwd exactly ${HELPER_DIR}.
        # exec -a sets argv[0] to the whole string, so the own-tree fake
        # is argv[0]="${HELPER_DIR}/server.py" with NO "python3 " prefix
        # (that prefix would make it one element "python3 /path/server.py"
        # and fail the exact-element match, exactly as the real gate
        # demands of myserver.py-style decoys). The subshell cds into
        # HELPER_DIR so the fake's cwd passes the second gate.
        cd "${HELPER_DIR}" || exit 1
        bash -c 'exec -a "/other/tree/helper/server.py" sleep 60' &
        FOREIGN_PID=$!
        bash -c 'exec -a "'"${HELPER_DIR}"'/server.py" sleep 60' &
        OWN_PID=$!
        sleep 60 &
        OTHER_PID=$!
        # A host without /proc (macOS) would refuse all three for lack of
        # /proc, not because of the gate. The gate reads only
        # PROC_ROOT/<pid>/cmdline and PROC_ROOT/<pid>/cwd, so describe
        # the same three processes there.
        if [ ! -d /proc/self ]; then
          PROC_ROOT="${SCRATCH}/proc-kill-gate"
          _fake_proc() {  # pid cwd argv...
            local _p="$1" _c="$2"
            shift 2
            mkdir -p "${PROC_ROOT}/${_p}"
            printf '%s\0' "$@" > "${PROC_ROOT}/${_p}/cmdline"
            ln -s "${_c}" "${PROC_ROOT}/${_p}/cwd"
          }
          _fake_proc "${FOREIGN_PID}" "${HELPER_DIR}" \
            "/other/tree/helper/server.py" 60
          _fake_proc "${OWN_PID}" "${HELPER_DIR}" "${HELPER_DIR}/server.py" 60
          _fake_proc "${OTHER_PID}" "${HELPER_DIR}" sleep 60
        fi
        SS_PID="${FOREIGN_PID}"
        ss() { printf 'tcp LISTEN 0 127.0.0.1:%s *:* users:(("python3",pid=%s,fd=3))\n' \
          "${SERVER_PORT}" "${SS_PID}"; }
        kill() {
          if [ "${1:-}" = "-0" ]; then return 1; fi   # nothing stays alive
          printf 'KILL %s\n' "$*" >> "${CASE_LOG}"
          return 0
        }
        : > "${CASE_LOG}"
        kill_helper_server; rc=$?
        t "kill_helper_server: foreign-tree server -> return 1 (refuse)" \
          "1" "${rc}"
        if grep -qF "did not prove it is this tree's helper server" "${CASE_LOG}"; then pass; else
          fail "${label}" "kill_helper_server logs the exact-gate ABORT" \
            "ABORT line" "(missing from log)"; fi
        if grep -q "^KILL" "${CASE_LOG}"; then
          fail "${label}" "kill_helper_server never signals a foreign tree server" \
            "no kill" "KILL recorded"; else pass; fi
        : > "${CASE_LOG}"
        SS_PID="${OWN_PID}"
        kill_helper_server; rc=$?
        t "kill_helper_server: own-tree server -> return 0 (kill)" "0" "${rc}"
        if grep -q "^KILL ${OWN_PID}$" "${CASE_LOG}"; then pass; else
          fail "${label}" "kill_helper_server kills its own tree server by exact PID" \
            "KILL ${OWN_PID}" "(missing from log)"; fi
        : > "${CASE_LOG}"
        SS_PID="${OTHER_PID}"
        kill_helper_server; rc=$?
        t "kill_helper_server: non-server port holder -> return 1 (refuse)" \
          "1" "${rc}"
        if grep -q "^KILL" "${CASE_LOG}"; then
          fail "${label}" "kill_helper_server never signals a non-server holder" \
            "no kill" "KILL recorded"; else pass; fi
        command kill "${FOREIGN_PID}" "${OWN_PID}" "${OTHER_PID}" 2>/dev/null || true
      )
    fi

    # --- W2-P2-11: no sleep after the final probe --------------------------
    # Real probe_status with a failing curl and a recording sleep stub:
    # exactly 2 sleeps for 3 attempts (after attempts 1 and 2; never
    # after the final one). The case only runs where the feature
    # exists.
    if grep -qF "no sleep after the final attempt" "${ka}"; then
    (
      unset -f probe_status
      # shellcheck disable=SC1090
      . "${ka}"
      log() { printf '%s\n' "$*" >> "${CASE_LOG}"; }
      sleep() { printf 'SLEEP %s\n' "$*" >> "${CASE_LOG}"; }
      curl() { return 1; }
      : > "${CASE_LOG}"
      if probe_status 3; then rc=0; else rc=1; fi
      t "probe_status: all attempts fail -> return 1" "1" "${rc}"
      SLEEPS="$(grep -c "^SLEEP" "${CASE_LOG}")"
      t "probe_status: no sleep after the final attempt (2 sleeps, 3 attempts)" \
        "2" "${SLEEPS}"
    )
    fi

    # --- W2-P1-7: slow healthy /status never triggers recovery ------------
    # Real probe_status with a curl that takes 9s (>8s, within the 20s
    # budget) then answers healthy: must succeed, so the main flow
    # never reaches recovery. `command sleep` bypasses the suite's
    # sleep stub.
    (
      unset -f probe_status
      # shellcheck disable=SC1090
      . "${ka}"
      log() { printf '%s\n' "$*" >> "${CASE_LOG}"; }
      sleep() { :; }
      curl() { command sleep 9; printf '%s' "${BODY_HEALTHY_V}"; return 0; }
      : > "${CASE_LOG}"
      if probe_status 3; then rc=0; else rc=1; fi
      t "probe_status: 9s healthy /status (within 20s timeout) -> success" \
        "0" "${rc}"
    )

    # --- memory_watch_check(): W2-P2-6 -----------------------------------
    # Feature-detected: these cases only run where the function exists.
    if declare -F memory_watch_check >/dev/null; then
      (
        # State assertions target ${TREE_STATE_DIR} (scratch, exported
        # above): the journal gate reads
        # ${TREE_STATE_DIR}/journal/ops.jsonl (W3-P1-14) and the cooldown
        # stamp lives at ${TREE_STATE_DIR}/last-memory-restart (W3-P2-13).
        mkdir -p "${TREE_STATE_DIR}"
        WATCH_OUT="memory_watch: rss=3000MB(max 2048) verdict=rss"
        WATCH_RC=3
        RECOVER_RC=0
        # Intercept only the memory_watch.py probe; every other python3
        # use inside keepalive.sh (status_fields, status_version, ...)
        # must reach the real binary.
        python3() {
          if [ "${1:-}" = "${HELPER_DIR}/memory_watch.py" ]; then
            printf '%s\n' "${WATCH_OUT}"
            return "${WATCH_RC}"
          fi
          command python3 "$@"
        }
        recover_helper() {
          printf 'RECOVER_CALLED\n' >> "${CASE_LOG}"
          return "${RECOVER_RC}"
        }
        recovered() { grep -qF "RECOVER_CALLED" "${CASE_LOG}"; }

        : > "${CASE_LOG}"
        memory_watch_check; rc=$?
        t "memory_watch_check: verdict 3 + quiet journal -> restarts" "0" "${rc}"
        if recovered; then pass; else
          fail "${label}" "memory_watch_check restarts on verdict 3" \
            "RECOVER_CALLED" "(missing from log)"; fi
        if [ -f "${TREE_STATE_DIR}/last-memory-restart" ]; then pass; else
          fail "${label}" "memory_watch_check writes the cooldown stamp" \
            "stamp file" "missing"; fi

        # A crashing probe (rc 1) must never trigger a restart.
        : > "${CASE_LOG}"
        WATCH_RC=1; WATCH_OUT="Traceback (most recent call last): boom"
        rm -f "${TREE_STATE_DIR}/last-memory-restart"
        memory_watch_check; rc=$?
        t "memory_watch_check: probe crash -> no restart" "0" "${rc}"
        if recovered; then
          fail "${label}" "memory_watch_check never restarts on probe crash" \
            "no restart" "RECOVER_CALLED"; else pass; fi

        # A fresh journal (dispatch in flight) defers the restart.
        : > "${CASE_LOG}"
        WATCH_RC=3; WATCH_OUT="memory_watch: rss=3000MB(max 2048) verdict=rss"
        mkdir -p "${TREE_STATE_DIR}/journal"
        touch "${TREE_STATE_DIR}/journal/ops.jsonl"
        memory_watch_check; rc=$?
        t "memory_watch_check: fresh journal defers restart" "0" "${rc}"
        if recovered; then
          fail "${label}" "memory_watch_check defers on active journal" \
            "no restart" "RECOVER_CALLED"; else pass; fi
        if grep -qF "journal active" "${CASE_LOG}"; then pass; else
          fail "${label}" "memory_watch_check logs the deferral" \
            "journal active" "(missing from log)"; fi

        # A recent memory restart (cooldown) defers the restart.
        : > "${CASE_LOG}"
        rm -f "${TREE_STATE_DIR}/journal/ops.jsonl"
        date +%s > "${TREE_STATE_DIR}/last-memory-restart"
        memory_watch_check; rc=$?
        t "memory_watch_check: cooldown defers restart" "0" "${rc}"
        if recovered; then
          fail "${label}" "memory_watch_check honors the restart cooldown" \
            "no restart" "RECOVER_CALLED"; else pass; fi

        # Verdict ok (rc 0) never restarts.
        : > "${CASE_LOG}"
        WATCH_RC=0; WATCH_OUT="memory_watch: rss=400MB(max 2048) verdict=ok"
        rm -f "${TREE_STATE_DIR}/last-memory-restart"
        memory_watch_check; rc=$?
        t "memory_watch_check: verdict ok -> no restart" "0" "${rc}"
        if recovered; then
          fail "${label}" "memory_watch_check never restarts on verdict ok" \
            "no restart" "RECOVER_CALLED"; else pass; fi

        # End to end: the healthy branch runs the watch and a verdict-3
        # restart propagates recover_helper's code. The body carries this
        # tree's helper_version so the W2-P1-16 skew check passes and the
        # flow reaches the memory hook.
        : > "${CASE_LOG}"
        WATCH_RC=3; WATCH_OUT="memory_watch: rss=3000MB(max 2048) verdict=rss"
        RECOVER_RC=0
        status_body="{\"logged_in\": true, \"chromium_alive\": true, \"starting\": false, \"helper_version\": \"${TREE_VERSION}\"}"
        ( evaluate_status ); rc=$?
        t "evaluate_status: healthy + memory verdict 3 -> restart, exit 0" \
          "0" "${rc}"
        if recovered; then pass; else
          fail "${label}" "healthy branch runs the memory watch" \
            "RECOVER_CALLED" "(missing from log)"; fi
      )
    fi

    # --- W4-P2-13: bounded tree_id --------------------------------------
    # Feature-detected: these cases only run where the function exists.
    if declare -F tree_id_bounded >/dev/null 2>&1; then
      (
        _btid="$(tree_id_bounded)"
        _blen="${#_btid}"
        if [ "${_blen}" -le 65 ] && [ "${_blen}" -ge 18 ]; then pass; else
          fail "${label}" "tree_id_bounded is bounded (18..65 chars)" \
            "18..65" "${_blen} (${_btid})"; fi
        case "${_btid}" in
          *[!a-z0-9_-]*)
            fail "${label}" "tree_id_bounded is filesystem-safe" \
              "only [a-z0-9_-]" "${_btid}" ;;
          *) pass ;;
        esac
        case "${_btid}" in
          *-????????????????)
            _bsuf="${_btid##*-}"
            case "${_bsuf}" in
              [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
                pass ;;
              *) fail "${label}" "tree_id_bounded ends with 16-hex sha256" \
                   "16 hex chars" "${_bsuf}" ;;
            esac ;;
          *) fail "${label}" "tree_id_bounded ends with -<16hex>" \
               "-<16hex>" "${_btid}" ;;
        esac
        # bash/python agreement: the same path slugs identically in
        # transport/local_chromium.py (the keepalive is the spec; the
        # python copies must match it byte for byte).
        _pyslugs="$(PYTHONDONTWRITEBYTECODE=1 python3 -c '
import os, sys
sys.path.insert(0, os.path.join(sys.argv[1], "transport"))
import local_chromium as lc
print(lc._slug_new(sys.argv[2]))
print(lc._slug_old(sys.argv[2]))
' "${TREE_ROOT}" "${TREE_ROOT}" 2>/dev/null)"
        _py_new="$(printf '%s' "${_pyslugs}" | sed -n '1p')"
        _py_old="$(printf '%s' "${_pyslugs}" | sed -n '2p')"
        t "bash tree_id_bounded agrees with python _slug_new" \
          "${_py_new}" "${_btid}"
        t "bash tree_id_legacy agrees with python _slug_old" \
          "${_py_old}" "$(tree_id_legacy)"
        # dual-lookup: an existing legacy state dir keeps resolving to
        # the legacy slug; with no legacy dir the bounded slug wins.
        # Re-source without MORROW_TREE_STATE_DIR (the suite exports it)
        # so the dual-lookup condition is live. Skipped when the UUID
        # fallback is active (dual-lookup does not apply then).
        if [ -z "$(_tree_uuid)" ]; then
          _leg="$(tree_id_legacy)"
          _new="$(tree_id_bounded)"
          if [ "${_leg}" != "${_new}" ]; then
            (
              unset MORROW_TREE_STATE_DIR
              export MORROW_HOME="${SCRATCH}/mhome"
              mkdir -p "${MORROW_HOME}/trees/${_leg}"
              # shellcheck disable=SC1090
              . "${ka}"
              t "dual-lookup: existing legacy state dir keeps the legacy slug" \
                "${_leg}" "${TREE_ID}"
              t "dual-lookup: legacy slug use is flagged" \
                "1" "${_USING_LEGACY_SLUG}"
              rm -rf "${MORROW_HOME}/trees/${_leg}"
              # shellcheck disable=SC1090
              . "${ka}"
              t "dual-lookup: no legacy state dir -> bounded slug" \
                "${_new}" "${TREE_ID}"
            )
          else
            # Cannot happen: the bounded form always appends -<16hex>
            # and the legacy form never contains '-'.
            fail "${label}" "dual-lookup precondition" "differ" "equal"
          fi
        fi
      )
    fi

    # --- W4-P1-10: lock open must not discard stderr ----------------------
    # Feature-detected: these cases only run where the function exists.
    if declare -F acquire_keepalive_lock >/dev/null 2>&1; then
      (
        _lockdir="$(mktemp -d "${HOME}/workspace/.keepalive-locktest-XXXXXX")"
        # A host without flock (macOS; the Muse VM has it, and install
        # step 1 requires it) could never take the lock. What is under
        # test is that opening the lockfile keeps stderr, so a stand-in
        # grants the lock there.
        if ! command -v flock >/dev/null 2>&1; then
          flock() { return 0; }
        fi
        # Success path: fd 9 is held AND later stderr is intact.
        (
          LOCKFILE="${_lockdir}/keepalive.lock"
          acquire_keepalive_lock || exit 99
          printf 'AFTER-LOCK-STDERR\n' >&2
        ) 2>"${_lockdir}/err.cap"
        if grep -q "AFTER-LOCK-STDERR" "${_lockdir}/err.cap"; then pass; else
          fail "${label}" "stderr works after lock acquisition" \
            "AFTER-LOCK-STDERR" "(missing from stderr)"; fi
        # Failure path: unopenable lockfile -> rc 1 AND a visible
        # diagnostic, with stderr still working afterwards.
        LOCKFILE="${_lockdir}" acquire_keepalive_lock \
          2>"${_lockdir}/err2.cap"; _lrc=$?
        t "acquire_keepalive_lock: unopenable lockfile -> rc 1" "1" "${_lrc}"
        if grep -q "cannot open lockfile" "${_lockdir}/err2.cap"; then pass; else
          fail "${label}" "lock-open failure diagnostic reaches stderr" \
            "cannot open lockfile ..." "(missing)"; fi
        rm -rf "${_lockdir}"
      )
    fi

    # --- W4-P1-9: moved-tree cron warning ---------------------------------
    # Feature-detected: these cases only run where the function exists.
    if declare -F _warn_on_moved_tree_cron >/dev/null 2>&1; then
      (
        # A stub crontab: scenario-driven via _CRON_STUB_CONTENT.
        crontab() {
          case "${1:-}" in
            -l) printf '%s\n' "${_CRON_STUB_CONTENT}" ;;
          esac
        }
        # Dead entry: keepalive.sh path that does not exist.
        _CRON_STUB_CONTENT='*/5 * * * * /old/location/helper/keepalive.sh'
        _wout="$(_warn_on_moved_tree_cron 2>&1)"
        case "${_wout}" in
          *"moved or renamed"*) pass ;;
          *) fail "${label}" "dead cron entry warns loudly" \
               "moved-or-renamed warning" "${_wout:-<silent>}" ;;
        esac
        # Mismatched entry: a different live tree's keepalive.sh.
        mkdir -p "${SCRATCH}/othertree/helper"
        touch "${SCRATCH}/othertree/helper/keepalive.sh"
        _CRON_STUB_CONTENT="*/5 * * * * \"${SCRATCH}/othertree/helper/keepalive.sh\""
        _wout="$(_warn_on_moved_tree_cron 2>&1)"
        case "${_wout}" in
          *"moved or renamed"*) pass ;;
          *) fail "${label}" "mismatched cron entry warns loudly" \
               "moved-or-renamed warning" "${_wout:-<silent>}" ;;
        esac
        # Healthy entry: this script's own path (quoted and unquoted).
        _self_ka="$(readlink -f "${ka}")"
        _CRON_STUB_CONTENT="*/5 * * * * \"${_self_ka}\"
*/5 * * * * ${_self_ka}"
        _wout="$(_warn_on_moved_tree_cron 2>&1)"
        if [ -z "${_wout}" ]; then pass; else
          fail "${label}" "matching cron entry stays silent" \
            "<silent>" "${_wout}"; fi
      )
    fi

    # --- W5-P2-2: keepalive.log rotation --------------------------------
    # _rotate_keepalive_log is the real function (log() itself is
    # stubbed above); point KEEPALIVE_LOG at scratch.
    KEEPALIVE_LOG="${SCRATCH}/keepalive.log"
    KEEPALIVE_LOG_MAX_BYTES=100
    KEEPALIVE_LOG_KEEP=3
    printf 'small\n' > "${KEEPALIVE_LOG}"
    _rotate_keepalive_log
    t "W5-P2-2: under-cap log is not rotated" "small" \
      "$(cat "${KEEPALIVE_LOG}")"
    # Over cap: content moves to .1, log starts fresh.
    head -c 200 /dev/zero | tr '\0' 'x' > "${KEEPALIVE_LOG}"
    printf 'older1\n' > "${KEEPALIVE_LOG}.1"
    printf 'older2\n' > "${KEEPALIVE_LOG}.2"
    _rotate_keepalive_log
    t "W5-P2-2: rotated log restarts empty" "" \
      "$(cat "${KEEPALIVE_LOG}")"
    t "W5-P2-2: previous .1 shifts to .2" "older1" \
      "$(cat "${KEEPALIVE_LOG}.2")"
    t "W5-P2-2: previous .2 shifts to .3" "older2" \
      "$(cat "${KEEPALIVE_LOG}.3")"
    # The over-cap content is now in .1 (200 x's).
    _sz="$(wc -c < "${KEEPALIVE_LOG}.1" | tr -d ' ')"
    t "W5-P2-2: over-cap content archived to .1" "200" "${_sz}"
    # Fourth rotation drops the oldest: only .1..3 survive.
    head -c 200 /dev/zero | tr '\0' 'y' > "${KEEPALIVE_LOG}"
    _rotate_keepalive_log
    t "W5-P2-2: only KEEP archives survive" "3" \
      "$(ls "${KEEPALIVE_LOG}".[0-9] 2>/dev/null | wc -l | tr -d ' ')"
    [ -f "${KEEPALIVE_LOG}.4" ] && \
      fail "${label}" "W5-P2-2: .4 must not exist" "absent" "present" || pass

    # --- W5-P2-7: relaunch circuit breaker -------------------------------
    # The breaker state lives under TREE_STATE_DIR (already scratch).
    # Stub recover_helper to fail or succeed on demand.
    RECOVER_RC=1
    recover_helper() { return "${RECOVER_RC}"; }
    rm -f "${CIRCUIT_FILE}" "${CIRCUIT_FILE}.tmp"
    circuit_guard_recover; rc=$?
    t "W5-P2-7: first failure keeps circuit closed (rc=1)" "1" "${rc}"
    t "W5-P2-7: failure counted" "1" \
      "$(grep '^failures=' "${CIRCUIT_FILE}" | cut -d= -f2)"
    circuit_guard_recover; rc=$?
    circuit_guard_recover; rc=$?
    t "W5-P2-7: third consecutive failure trips (rc=1)" "1" "${rc}"
    t "W5-P2-7: trip counted" "3" \
      "$(grep '^failures=' "${CIRCUIT_FILE}" | cut -d= -f2)"
    _remaining="$(_circuit_open_remaining)"
    case "${_remaining}" in ''|*[!0-9]*|0)
      fail "${label}" "W5-P2-7: circuit open after trip" ">0" "${_remaining}" ;;
    *) pass ;; esac
    # Open circuit: recover_helper must NOT run (no relaunch).
    RECOVER_CALLED=0
    recover_helper() { RECOVER_CALLED=1; return 1; }
    circuit_guard_recover; rc=$?
    t "W5-P2-7: open circuit skips relaunch (rc=1)" "1" "${rc}"
    t "W5-P2-7: open circuit never calls recover_helper" "0" "${RECOVER_CALLED}"
    # Backoff grows exponentially and caps at CIRCUIT_MAX_S.
    # failures=3 written, then one more failure -> failures=4,
    # backoff = 600 * 2^(4-3) = 1200s.
    _circuit_write 3 0
    RECOVER_RC=1
    recover_helper() { return 1; }
    circuit_guard_recover >/dev/null 2>&1
    _next="$(grep '^next_allowed=' "${CIRCUIT_FILE}" | cut -d= -f2)"
    _now="$(date +%s)"
    _backoff=$((_next - _now))
    if [ "${_backoff}" -ge 1100 ] && [ "${_backoff}" -le 1300 ]; then pass;
    else fail "${label}" "W5-P2-7: backoff doubles after trip (1200s)" \
      "1100..1300" "${_backoff}"; fi
    # Cap: failures=99 -> backoff capped at CIRCUIT_MAX_S.
    _circuit_write 99 0
    circuit_guard_recover >/dev/null 2>&1
    _next="$(grep '^next_allowed=' "${CIRCUIT_FILE}" | cut -d= -f2)"
    _now="$(date +%s)"
    _backoff=$((_next - _now))
    if [ "${_backoff}" -le "${CIRCUIT_MAX_S}" ] \
       && [ "${_backoff}" -ge "$((CIRCUIT_MAX_S - 60))" ]; then pass;
    else fail "${label}" "W5-P2-7: backoff capped at CIRCUIT_MAX_S" \
      "${CIRCUIT_MAX_S}" "${_backoff}"; fi
    # Healthy recovery resets the breaker. Start from a closed circuit
    # with a prior failure count (an open circuit would skip the
    # recovery entirely, which the earlier case already covers).
    _circuit_write 2 0
    RECOVER_RC=0
    recover_helper() { return 0; }
    circuit_guard_recover >/dev/null 2>&1; rc=$?
    t "W5-P2-7: healthy recovery returns 0" "0" "${rc}"
    t "W5-P2-7: healthy recovery resets failures" "0" \
      "$(grep '^failures=' "${CIRCUIT_FILE}" | cut -d= -f2)"
    t "W5-P2-7: healthy recovery clears next_allowed" "0" \
      "$(grep '^next_allowed=' "${CIRCUIT_FILE}" | cut -d= -f2)"
    # Confirmed sign-out (rc=2) also resets: the relaunch worked.
    _circuit_write 2 0
    recover_helper() { return 2; }
    circuit_guard_recover >/dev/null 2>&1; rc=$?
    t "W5-P2-7: sign-out (rc=2) passes through" "2" "${rc}"
    t "W5-P2-7: sign-out resets failures" "0" \
      "$(grep '^failures=' "${CIRCUIT_FILE}" | cut -d= -f2)"
    # Persistence: state survives a re-read (new shell, same file).
    _circuit_write 2 0
    ( _circuit_read; [ "${_circuit_failures}" = "2" ] ) && pass || \
      fail "${label}" "W5-P2-7: state persists across runs" "2" \
        "${_circuit_failures:-?}"
    # Malformed circuit file reads as closed (fail-safe).
    printf 'garbage{{{\n' > "${CIRCUIT_FILE}"
    _remaining="$(_circuit_open_remaining)"
    t "W5-P2-7: malformed state reads as closed" "0" "${_remaining}"

    rm -rf "${SCRATCH}" "${CASE_LOG}"
  )
}

# W3-P2-10: the headline reports exactly what ran: the shipped copy's
# checks, nothing else. Exit 0 only when every check passes.
if [ ! -f "${KA_SHIPPED}" ]; then
  printf 'FAIL [setup] shipped keepalive present: %s\n  expected: present\n  actual:   missing\n' \
    "${KA_SHIPPED}"
  exit 1
fi
RESULTS="$(mktemp "${HOME}/workspace/.keepalive-selftest-results-XXXXXX")"
test_shipped
_p="$(grep -c '^PASS$' "${RESULTS}")"
_f="$(grep -c '^FAIL|' "${RESULTS}")"
printf '\nkeepalive_selftest [shipped] helper/keepalive.sh results:\n'
grep '^FAIL|' "${RESULTS}" | while IFS='|' read -r _ flabel name expected actual; do
  printf 'FAIL %s %s\n  expected: %s\n  actual:   %s\n' \
    "${flabel}" "${name}" "${expected}" "${actual}"
done
printf 'keepalive_selftest [shipped]: %d passed, %d failed\n' "${_p}" "${_f}"
rm -f "${RESULTS}"
[ "${_f}" -eq 0 ]
