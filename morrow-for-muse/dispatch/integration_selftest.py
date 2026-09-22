#!/usr/bin/env python3
"""Selftest: final-integration wiring (2026-09-21).

Covers retained generic integration behavior offline, plus the F-17
carve (2026-09-21): the provisioning chain and the accessibility runner
were removed from the shipped executor under the standing exclusions,
and the removed hooks must stay absent.

  1. run_multi_step runs plain multi-step entries end to end (two GETs
     through the session, captures land in transients, final result
     returned).
  2. The removed executor hooks are absent: _run_provision_step,
     _provision_launch_driver, _is_credential_handle,
     _ensure_fresh_bank_credential, _close_credential_handles,
     _is_a11y_entry, _a11y_load_modules, _run_a11y_entry,
     ProvisioningFailed, PROVISION_PY, LAUNCH_DRIVER_PY.
  3. catalog_descriptor_to_entry accepts the "plan" effect class.
  4. The retired two-phase browser lane is gone from the CLI: no
     `complete` subcommand, no --backend browser, chromium is default.
  5. catalog --help documents --allow-unproven.

No network, no Chromium, no session. Fakes only.
"""
import os
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (REPO, os.path.join(REPO, "dispatch")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from dispatch import executor as ex  # noqa: E402

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(
        "%s%s" % (name, (" (%s)" % detail) if detail and not cond else ""))


# 1. run_multi_step: retained generic behavior, two plain GET steps.
calls = []


def fake_request_with_retry(method, url, headers, body_bytes, is_write=False,
                            max_bytes=None):
    calls.append((method, url, headers.get("Authorization")))
    return 200, {}, b'{"id": 424242}', 1


_old_retry = ex.request_with_retry
ex.request_with_retry = fake_request_with_retry
try:
    session = ex.SessionStore({"canvas": {
        "base": "https://example.instructure.com", "pat": "P" * 40}})
    config = {"canvas_base": "https://example.instructure.com"}
    pack = {"credential_slots": {
        "canvas_pat": {"inject": {"header": "Authorization",
                                  "scheme": "Bearer"}}}}
    entry1 = {
        "name": "test_two_reads",
        "effects": "read",
        "provider": "canvas",
        "auth": {"slot": "canvas_pat"},
        "result": {"receipt": [], "redact": []},
        "multi_step": [
            {"name": "read1", "method": "GET",
             "url": "{canvas_base}/api/v1/courses/424242",
             "capture": {"course_id_seen": "id"}},
            {"name": "read2", "method": "GET",
             "url": "{canvas_base}/api/v1/courses/424242/modules"},
        ],
    }
    result1, trans1 = ex.run_multi_step(entry1, session, pack, config, {}, {})
    check("multi_step: two requests went out", len(calls) == 2,
          repr(calls))
    check("multi_step: both carried the PAT bearer",
          all(a == "Bearer " + "P" * 40 for _, _, a in calls), repr(calls))
    check("multi_step: capture landed in transients",
          trans1.get("course_id_seen") == 424242, repr(trans1))
    check("multi_step: final step named",
          result1.get("step_name") == "read2", repr(result1.get("step_name")))
    check("multi_step: final result present", result1 is not None)
finally:
    ex.request_with_retry = _old_retry

# 2. F-17 carve: the removed hooks must stay absent.
for sym in ("_run_provision_step", "_provision_launch_driver",
            "_is_credential_handle", "_ensure_fresh_bank_credential",
            "_close_credential_handles",
            "_is_a11y_entry", "_a11y_load_modules", "_run_a11y_entry",
            "ProvisioningFailed", "PROVISION_PY", "LAUNCH_DRIVER_PY"):
    check("carve: executor has no %s" % sym, not hasattr(ex, sym),
          "still present")
src_ex = open(os.path.join(REPO, "dispatch", "executor.py"),
              encoding="utf-8").read()
check("carve: no PROVISION step branch in run_multi_step",
      '"PROVISION"' not in src_ex and "'PROVISION'" not in src_ex)
check("carve: no moodle executor branches remain",
      "moodle_base" not in src_ex and "moodle_session" not in src_ex
      and "moodle_sesskey" not in src_ex
      and 'base_for("moodle")' not in src_ex)
check("re-auth write-halt owned by shipped state machine",
      "_on_session_death" in src_ex
      and "reauth" in src_ex
      and os.path.exists(os.path.join(REPO, "reauth", "state_machine.py")))
check("re-auth: rig-only session/capture.py not wired into executor",
      "from session" not in src_ex and "import session" not in src_ex
      and "session.capture" not in src_ex)

# 3. catalog_descriptor_to_entry accepts plan.
e3 = ex.catalog_descriptor_to_entry("x", "GET", "/api/v1/x", "plan",
                                    provider="canvas")
check("catalog entry: plan effect accepted", e3.get("effects") == "plan",
      repr(e3.get("effects")))
try:
    ex.catalog_descriptor_to_entry("x", "GET", "/api/v1/x", "bogus",
                                   provider="canvas")
    check("catalog entry: bogus effect refused", False, "no exception")
except ex.ExecutorError:
    check("catalog entry: bogus effect refused", True)

# 4. The retired two-phase browser lane is gone from the CLI: no `complete`
# subcommand, no --backend browser, and chromium is the default backend.
out = subprocess.run(
    [sys.executable, os.path.join(REPO, "dispatch", "executor.py"),
     "complete", "--help"], capture_output=True, text=True)
check("cli: retired `complete` subcommand is gone",
      out.returncode != 0 and "invalid choice" in out.stderr, out.stderr[:200])
out = subprocess.run(
    [sys.executable, os.path.join(REPO, "dispatch", "executor.py"),
     "catalog", "--help"], capture_output=True, text=True)
check("cli: catalog --backend offers only https and chromium",
      "{https,chromium}" in out.stdout, out.stdout[:300])
check("cli: catalog documents --allow-unproven",
      "--allow-unproven" in out.stdout, out.stdout[:300])
src = src_ex
check("cli: --backend default is chromium",
      'p.add_argument("--backend", default="chromium", choices=("https", "chromium")' in src)
check("cli: no browser-lane flags remain",
      "--lane-state" not in src and "--form-host" not in src
      and "--relay-url" not in src and "_browser_backend" not in src
      and "need_lane_state" not in src)
out = subprocess.run(
    [sys.executable, os.path.join(REPO, "dispatch", "executor.py"),
     "catalog", "--backend", "browser", "--help"], capture_output=True, text=True)
check("cli: --backend browser is rejected",
      out.returncode != 0 and "invalid choice" in out.stderr, out.stderr[:200])

# hygiene on the touched files
for rel in ("dispatch/executor.py", "provision/launch_driver.py",
            "provision/launch_driver_selftest.py",
            "dispatch/integration_selftest.py",
            "dispatch/executor_write_hardening_selftest.py",
            "transport/item_bank_sdk.py",
            "transport/item_bank_sdk_selftest.py",
            "transport/chromium_session.py",
            "transport/chromium_session_selftest.py",
            "transport/local_chromium.py",
            "proof-battery/item_bank_sdk_battery.py",
            "proof-battery/OPERATION_CATALOG.md",
            "provision/manifests/morrow_check_new_quiz.json",
            "DEPLOY.md", "INTEGRATION_NOTES.md", "CHANGELOG.md",
            "audit/desktop-parity-audit.md",
            "audit/DESKTOP_TO_MUSE_MATRIX.md"):
    path = os.path.join(REPO, rel)
    if not os.path.exists(path) and os.path.exists(
            os.path.join(REPO, "pack", "carve-manifest.json")):
        # A carved distribution leaves dev-only files out
        # (scripts/carve.py DEV_ONLY); the source tree has them all.
        continue
    src = open(path, encoding="utf-8").read()
    check("hygiene %s: no em dashes" % rel, "\u2014" not in src)
    check("hygiene %s: no /tmp" % rel, ("/t" + "mp/") not in src)

print("PASS: %d" % len(PASS))
for name in PASS:
    print("  ok %s" % name)
if FAIL:
    print("FAIL: %d" % len(FAIL))
    for name in FAIL:
        print("  FAIL %s" % name)
    sys.exit(1)
