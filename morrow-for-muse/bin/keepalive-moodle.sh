#!/usr/bin/env bash
# keepalive-moodle.sh: keep the Moodle session alive (every 6 hours).
#
# Issues one cheap authenticated GET to the Moodle site's session API via
# the persisted MoodleSession bundle. If no session bundle exists yet, the
# script logs that fact and exits 0: the keepalive is installed and
# scheduled, but dormant until Braden bootstraps a Moodle session with
# moodle/login.py. A missing session is not an error and must not page
# anyone.
#
# On an expiry signal (401/403 or a login redirect) the script hands off to
# moodle/reauth.py. Nothing here signs in or mutates session state beyond
# the read-only probe.
set -u

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="${DEPLOY_DIR}/logs/keepalive-moodle.log"
# W4-P1-17: honor MORROW_HOME like every other runtime path.
BUNDLE="${MORROW_HOME:-${HOME}/.morrow}/moodle-session.json"
REAUTH_PY="${DEPLOY_DIR}/moodle/reauth.py"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$1" >> "${LOG}"; }

if [ ! -f "${BUNDLE}" ]; then
    log "IDLE no Moodle session bundle at ${BUNDLE}; bootstrap with moodle/login.py first"
    exit 0
fi

RESULT="$(python3 - "${BUNDLE}" "${DEPLOY_DIR}" <<'EOF'
import sys, json, os
sys.path.insert(0, os.path.join(sys.argv[2], "moodle"))
from session import MoodleSession
try:
    bundle = json.load(open(sys.argv[1], encoding="utf-8"))
    ms = MoodleSession.from_bundle(bundle)
    status, body = ms.get("/lib/ajax/service.php", timeout=30)
except Exception as e:
    print(f"PROBE_ERROR {type(e).__name__}: {e}")
    sys.exit(2)
head = (body if isinstance(body, str) else json.dumps(body))[:100].replace("\n", " ")
print(f"RESULT status={status} body_head={head}")
EOF
)"
RC=$?

if [ "${RC}" -ne 0 ]; then
    log "ERROR probe failed: ${RESULT}"
    exit 2
fi

log "keepalive ${RESULT}"

STATUS="$(printf '%s' "${RESULT}" | sed -n 's/.*status=\([0-9]*\).*/\1/p')"

if [ "${STATUS}" = "401" ] || [ "${STATUS}" = "403" ]; then
    log "EXPIRY status ${STATUS}; handing to Moodle re-auth"
    python3 "${REAUTH_PY}" --bundle "${BUNDLE}" 2>&1 | head -5 >> "${LOG}"
    exit 1
fi

if [ "${STATUS}" = "200" ]; then
    tail -n 500 "${LOG}" > "${LOG}.tmp" && mv "${LOG}.tmp" "${LOG}"
    exit 0
fi

log "WARN unexpected status ${STATUS}; no expiry signal, state unchanged"
exit 2
