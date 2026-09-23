#!/bin/bash
# dev-suites.sh [--show-failures]
#
# Runs every selftest suite of the source repository that is not an
# install suite (scripts/install-suites.sh lists those), with the same
# isolation: each suite runs from the tree root in its own scratch HOME
# with every live-state variable removed. CI runs it after pytest.
# scripts/test_dev_suites.py checks that every git-tracked selftest is
# in exactly one of the two lists. Source repository only: carve leaves
# this script and these suites out of the release.
set -u

TREE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "${1:-}" in
  "" | --show-failures) ;;
  *) echo "usage: $0 [--show-failures]" >&2; exit 2 ;;
esac

SUITES="bin/scheduler_selftest.py
catalog/a11y/a11y_parity_selftest.py
catalog/a11y/a11y_selftest.py
dispatch/approval_display_selftest.py
dispatch/catalog_gate_selftest.py
dispatch/state_backup_selftest.py
dispatch/wave3_hardening_selftest.py
dispatch/wave5_concurrency_selftest.py
dispatch/wave5_injection_selftest.py
dispatch/wave6_crypto_selftest.py
helper/educator_surface_selftest.py
moodle/session_selftest.py
provision/launch_driver_selftest.py
provision/provision_selftest.py
reauth/wave5_resource_selftest.py
session/cdp_selftest.py
transport/browser_backend_selftest.py
transport/chromium_memory_selftest.py
transport/item_bank_sdk_selftest.py
transport/local_chromium_selftest.py
transport/selftest.py
transport/wave5_injection_selftest.py"

# shellcheck disable=SC2086
exec bash "${TREE}/scripts/install-suites.sh" "$@" ${SUITES}
