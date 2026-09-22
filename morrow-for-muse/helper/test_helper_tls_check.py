#!/usr/bin/env python3
"""The helper TLS selftest never fails an install on network timing.

Failure mode this suite pins down (written before the fix; round-4
audit 2026-09-22, L6, probe audit-muse4/tls/run.py): the check waited
about 10s for the helper to serve /status over TLS, but the helper
serves only after Chromium starts and the tenant page loads, which
needs live egress. With no egress (or a slow first boot) the install
failed. The outcome is now: pass when TLS served; fail when TLS setup
itself failed or plaintext was served; skip, with the reason, when the
helper enabled TLS but never reached serving.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
for _p in (TREE, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import helper_selftest as hs  # noqa: E402


def test_served_over_tls_passes():
    assert hs.tls_check_outcome(True, "TLS enabled on the helper "
                                "listener (cert x)\nserving")[0] == "pass"


def test_tls_setup_failure_fails():
    out = "FATAL: cannot load helper TLS cert/key (bad pem)"
    assert hs.tls_check_outcome(False, out)[0] == "fail"


def test_tls_never_enabled_fails():
    assert hs.tls_check_outcome(False, "starting\nprofile: x")[0] == "fail"


def test_chromium_missing_after_tls_enabled_skips():
    out = ("TLS enabled on the helper listener (cert x)\n"
           "FATAL: Chromium was not found at the probed locations\n")
    assert hs.tls_check_outcome(False, out)[0] == "skip"


def test_no_egress_before_serving_skips_with_reason():
    out = ("TLS enabled on the helper listener (cert x)\n"
           "egress probe: blocked (no usable egress)\n")
    verdict, reason = hs.tls_check_outcome(False, out)
    assert verdict == "skip"
    assert "egress" in reason or "never reached serving" in reason
