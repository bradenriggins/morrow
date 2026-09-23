#!/bin/bash
# install-suites.sh [--show-failures] [suite ...]
#
# Runs the install selftest suites of the tree this script ships in.
# install.sh runs it at step 9, and CI runs it on the carved release
# tree, so the list below is the one list both use. Suites named on the
# command line (tree-relative paths) run instead of that list, with the
# same isolation: scripts/dev-suites.sh uses this for the source
# repository's other selftests.
#
# Each suite runs with python3 from the tree root, in its own fresh
# scratch HOME under the tree's .selftest-work/, with every variable
# that names live state removed (round-4 H2): the educator's
# MORROW_HOME (even ~/.morrow), tree state dir, vault, signing key,
# identity, and helper profile never reach a suite, and never make one
# refuse to run.
#
# Prints "FAIL <suite>" for each failed suite, then
# "<passed>/<total> selftest suites pass", and exits non-zero when any
# suite failed. Suite output is kept quiet unless --show-failures is
# given, which prints a failed suite's output under its FAIL line.
set -u

TREE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHOW_FAILURES=0
NAMED=""
for _arg in "$@"; do
  case "${_arg}" in
    --show-failures) SHOW_FAILURES=1 ;;
    -*) echo "usage: $0 [--show-failures] [suite ...]" >&2; exit 2 ;;
    *) NAMED="${NAMED} ${_arg}" ;;
  esac
done
unset _arg

SUITES="transport/chromium_session_selftest.py
transport/egress_selftest.py
dispatch/executor_selftest.py
dispatch/admission_selftest.py
dispatch/executor_write_hardening_selftest.py
dispatch/journal_integrity_selftest.py
dispatch/wave4_dispatch_integrity_selftest.py
dispatch/integration_selftest.py
privacy/source_privacy_selftest.py
privacy/deidentif_selftest.py
privacy/learner_vault_selftest.py
helper/helper_selftest.py
helper/cdp_http_auth_selftest.py
reauth/session_lifecycle_selftest.py
helper/cookie_expiry_selftest.py
modes/test_modes_integration.py
settings/test_settings.py
failures/selftest_smoke.py
failures/selftest_wiring.py
failures/test_error_translation.py
learners/test_resolve_student.py
query/selftest_query.py
catalog/a11y/runner_selftest.py"
[ -n "${NAMED}" ] && SUITES="${NAMED}"
SELFTEST_UNSET="MORROW_HOME MORROW_TREE_STATE_DIR MORROW_SOURCE_VAULT_PATH MORROW_APPROVAL_SIGNING_KEY MORROW_USER_ID MORROW_CONVERSATION_ID MORROW_HELPER_ENV_FILE MORROW_PRIVACY_MAP MORROW_PRIVACY_SALT MORROW_SELFTEST_HOME LOGIN_HELPER_PROFILE_DIR LOGIN_HELPER_PORT LOGIN_HELPER_CDP_PORT"

WORK="${TREE}/.selftest-work"
mkdir -p "${WORK}" || exit 2
selftest_env() {
  # Runs "$@" with the live state variables removed and HOME pointed at
  # a fresh scratch dir under the tree's .selftest-work/.
  _st_home="$(mktemp -d "${WORK}/install-home.XXXXXX")" || return 1
  _st_args=""
  for _v in ${SELFTEST_UNSET}; do
    _st_args="${_st_args} -u ${_v}"
  done
  # shellcheck disable=SC2086
  env ${_st_args} HOME="${_st_home}" PYTHONDONTWRITEBYTECODE=1 "$@"
}

PASS=0
TOTAL=0
for suite in ${SUITES}; do
  TOTAL=$((TOTAL + 1))
  _log="$(mktemp "${WORK}/suite-log.XXXXXX")" || exit 2
  if (cd "${TREE}" && selftest_env python3 "${suite}" >"${_log}" 2>&1); then
    PASS=$((PASS + 1))
  else
    printf 'FAIL %s\n' "${suite}"
    [ "${SHOW_FAILURES}" = 1 ] && sed 's/^/    /' "${_log}"
  fi
  rm -f "${_log}"
done
printf '%s/%s selftest suites pass\n' "${PASS}" "${TOTAL}"
[ "${PASS}" -eq "${TOTAL}" ]
