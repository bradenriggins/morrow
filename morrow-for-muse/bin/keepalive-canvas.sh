#!/usr/bin/env bash
# keepalive-canvas.sh: keep the Lane 2 (session, no-PAT) Canvas session alive.
#
# Canvas sessions roll on a 24-hour default: at least one authenticated
# request per day renews the rolling session. This script issues one cheap
# authenticated GET, /api/v1/users/self/profile, inside the
# already-authenticated rig browser tab via CDP. The in-tab route is
# deliberate: raw cookie replay from this host's egress IP is OTP-blocked on
# the tenant (302 to /login/otp), while the in-tab fetch rides the live session.
#
# On an expiry signal the script hands off to the re-auth state machine.
# Probe failures (CDP unreachable) are logged and exit nonzero WITHOUT
# tripping expiry: an unreachable browser is not a dead session.
#
# Nothing here signs in, logs out, or mutates session state. Read-only.
set -u

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# W4-P1-17: honor MORROW_HOME like every other runtime path.
MORROW_DIR="${MORROW_HOME:-${HOME}/.morrow}"
LOG="${DEPLOY_DIR}/logs/keepalive-canvas.log"
SESSION_JSON="${MORROW_DIR}/session.json"
STATE_MACHINE="${DEPLOY_DIR}/reauth/state_machine.py"
CDP_MOD_DIR="${DEPLOY_DIR}/session"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$1" >> "${LOG}"; }

if [ ! -f "${SESSION_JSON}" ]; then
    log "ERROR no session store at ${SESSION_JSON}; run capture.py first"
    exit 3
fi

BASE="$(python3 -c "import json; print(json.load(open('${SESSION_JSON}'))['canvas']['base'])")"

RESULT="$(python3 - "${BASE}" "${CDP_MOD_DIR}" <<'EOF'
import sys, json, os
sys.path.insert(0, sys.argv[2])
from cdp import tab_fetch
try:
    status, body = tab_fetch(sys.argv[1], "/api/v1/users/self/profile")
except Exception as e:
    print(f"PROBE_ERROR {type(e).__name__}: {e}")
    sys.exit(2)
pid = None
try:
    pid = json.loads(body).get("id") if body.strip().startswith("{") else None
except Exception:
    pid = None
head = body.replace("\n", " ")[:100]
print(f"RESULT status={status} principal_id={pid} body_head={head}")
EOF
)"
RC=$?

if [ "${RC}" -ne 0 ]; then
    log "ERROR probe failed: ${RESULT}"
    exit 2
fi

log "keepalive ${RESULT}"

STATUS="$(printf '%s' "${RESULT}" | sed -n 's/.*status=\([0-9]*\).*/\1/p')"
BODY_HEAD="$(printf '%s' "${RESULT}" | sed -n 's/.*body_head=//p')"

if [ "${STATUS}" = "401" ]; then
    log "EXPIRY 401 unauthenticated; handing to re-auth state machine"
    python3 "${STATE_MACHINE}" detect --status 401 \
        --body '{"status":"unauthenticated"}' --url "${BASE}/api/v1/users/self/profile"
    exit 1
fi

case "${BODY_HEAD}" in
    *'"status":"unauthenticated"'*)
        log "EXPIRY 401-shaped body on status ${STATUS}; handing to state machine"
        python3 "${STATE_MACHINE}" detect --status "${STATUS}" \
            --body '{"status":"unauthenticated"}'
        exit 1
        ;;
esac

if [ "${STATUS}" = "200" ]; then
    tail -n 500 "${LOG}" > "${LOG}.tmp" && mv "${LOG}.tmp" "${LOG}"
    exit 0
fi

log "WARN unexpected status ${STATUS}; no expiry signal, state unchanged"
exit 2
