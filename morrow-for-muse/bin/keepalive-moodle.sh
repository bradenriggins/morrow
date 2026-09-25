#!/usr/bin/env bash
# Compatibility entrypoint for the retired persisted Moodle keepalive.
# A scheduled process cannot restore the browser-owned session from JSON.
# The read-only probe in moodle/keepalive.py runs only in a process that
# already owns a live in-memory MoodleSession.
set -u

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="${DEPLOY_DIR}/logs/keepalive-moodle.log"
BUNDLE="${MORROW_HOME:-${HOME}/.morrow}/moodle-session.json"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$1" >> "${LOG}"; }

if [ -e "${BUNDLE}" ] || [ -L "${BUNDLE}" ]; then
    log "BLOCKED legacy Moodle bundle present; persisted session state is unsupported and was not opened"
    exit 2
fi

log "IDLE no live in-memory Moodle session in this scheduled process; login.py does not persist one"
exit 0
