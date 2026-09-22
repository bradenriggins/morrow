#!/usr/bin/env python3
"""Selftest: frame-bound launch/capture provisioner (provision.py).

No live network calls. All driver interactions use in-memory fakes; token
material below is synthetic test fixture data, never sent anywhere.

Covers:
  1.  Binding metadata is required: each missing key raises BindingMismatch.
  2.  Token length bounds 51..8192 are enforced.
  3.  The nonce must be UUIDv4.
  4.  The capture window (45 s) is enforced.
  5.  Single-operation use: the second headers() raises CredentialConsumed.
  6.  close() clears the material: headers() then raises CredentialClosed,
      the bytearray is zeroed, and no token value appears in summaries.
  7.  Expiry: an already-expired binding raises at construction; a stale
      handle raises CredentialExpired on headers().
  8.  assert_binding_for refuses a wrong course or tenant.
  9.  The stale item-bank route constant is absent from the module source.
  10. No mint-chain remnants: old code identifiers are gone, and the old
      provision_build_token_memory entry always raises ProvisionFailed.
  11. No launch driver wired: fails closed with NoLaunchDriver.
  12. No course_id: fails closed with ProvisionFailed (never a default course).
  13. CLI exit codes: no --course-id -> 2; course id with no driver -> 3;
      stdout never contains a token value.
  14. quiz_api_base validates the tenant label.
  15. The module source references no /tmp path.
"""
import io
import json
import os
import sys
from contextlib import redirect_stdout

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (REPO, os.path.join(REPO, "provision")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import importlib.util as _ilu  # noqa: E402
_prov_spec = _ilu.spec_from_file_location(
    "morrow_provision_selftest",
    os.path.join(REPO, "provision", "provision.py"))
prov = _ilu.module_from_spec(_prov_spec)
_prov_spec.loader.exec_module(prov)

PROV_SRC_PATH = os.path.join(REPO, "provision", "provision.py")
with open(PROV_SRC_PATH, "r", encoding="utf-8") as _f:
    PROV_SRC = _f.read()

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(
        "%s%s" % (name, (" (%s)" % detail) if detail and not cond else ""))


def expect(name, exc_type, fn, detail=""):
    try:
        fn()
    except exc_type:
        check(name, True)
        return
    except Exception as e:  # noqa: BLE001
        check(name, False, "%swrong exception: %r" % (detail + " " if detail else "", e))
        return
    check(name, False, "%sno exception raised" % (detail + " " if detail else ""))


# Synthetic fixture token: clearly test-only, never sent anywhere.
FIXTURE_TOKEN = "synthetic-test-token-" + "x" * 48  # len 69
assert 51 <= len(FIXTURE_TOKEN) <= 8192

FIXTURE_NONCE = "123e4567-e89b-42d3-a456-426614174000"  # UUIDv4-shaped


def good_binding(**over):
    t = prov.now()
    b = {
        "nonce": FIXTURE_NONCE,
        "tab_id": "tab-1",
        "frame_id": "frame-1",
        "launch_url": "https://chcp.instructure.com/courses/89585/external_tools/7",
        "tenant": "chcp",
        "course_id": "89585",
        "course_uuid": "123e4567-e89b-12d3-a456-426614174999",
        "external_tool_id": "7",
        "api_origin": "https://chcp.quiz-api.instructure.com",
        "launched_at": t - 10,
        "captured_at": t,
        "expires_at": t + 600,
    }
    b.update(over)
    return b


# 1. Binding metadata required
for key in prov.ItemBankCredential.REQUIRED_BINDING:
    b = good_binding()
    del b[key]
    expect("missing binding key %s raises" % key, prov.BindingMismatch,
           lambda b=b: prov.ItemBankCredential(FIXTURE_TOKEN, b))
expect("non-dict binding raises", prov.BindingMismatch,
       lambda: prov.ItemBankCredential(FIXTURE_TOKEN, ["nope"]))

# 2. Token length bounds
expect("50-char token raises", prov.BindingMismatch,
       lambda: prov.ItemBankCredential("y" * 50, good_binding()))
prov.ItemBankCredential("y" * 51, good_binding())
check("51-char token accepted", True)
prov.ItemBankCredential("y" * 8192, good_binding())
check("8192-char token accepted", True)
expect("8193-char token raises", prov.BindingMismatch,
       lambda: prov.ItemBankCredential("y" * 8193, good_binding()))

# 3. Nonce must be UUIDv4
expect("non-uuid nonce raises", prov.BindingMismatch,
       lambda: prov.ItemBankCredential(FIXTURE_TOKEN, good_binding(nonce="not-a-uuid")))
expect("uuidv1-shaped nonce raises", prov.BindingMismatch,
       lambda: prov.ItemBankCredential(
           FIXTURE_TOKEN,
           good_binding(nonce="123e4567-e89b-12d3-a456-426614174000")))

# 4. Capture window
t = prov.now()
expect("46 s capture window raises", prov.BindingMismatch,
       lambda: prov.ItemBankCredential(
           FIXTURE_TOKEN, good_binding(launched_at=t - 46, captured_at=t)))
prov.ItemBankCredential(FIXTURE_TOKEN, good_binding(launched_at=t - 45, captured_at=t))
check("45 s capture window accepted", True)
expect("capture before launch raises", prov.BindingMismatch,
       lambda: prov.ItemBankCredential(
           FIXTURE_TOKEN, good_binding(launched_at=t, captured_at=t - 1)))

# 5. Single-operation use
cred = prov.ItemBankCredential(FIXTURE_TOKEN, good_binding())
hdrs = cred.headers()
check("headers() returns Authorization and AuthType",
      hdrs.get("Authorization") == FIXTURE_TOKEN
      and hdrs.get("AuthType") == "Signature", hdrs.keys())
expect("second headers() raises CredentialConsumed", prov.CredentialConsumed, cred.headers)
check("raw token recoverable in memory exactly once", True)
cred.close()

# 6. close() clears the material
cred2 = prov.ItemBankCredential(FIXTURE_TOKEN, good_binding())
cred2.close()
cred2.close()  # idempotent
check("close() is idempotent", True)
expect("headers() after close raises CredentialClosed", prov.CredentialClosed, cred2.headers)
check("bytearray zeroed after close",
      len(cred2._token) == 0 or all(c == 0 for c in cred2._token))
summary_text = json.dumps(cred2.binding_summary())
check("token value absent from binding summary", FIXTURE_TOKEN not in summary_text)
check("summary reports closed", cred2.binding_summary().get("closed") is True)

# 7. Expiry
t = prov.now()
expect("already-expired binding raises at construction", prov.CredentialExpired,
       lambda: prov.ItemBankCredential(
           FIXTURE_TOKEN,
           good_binding(launched_at=t - 610, captured_at=t - 605,
                        expires_at=t - 5)))
cred5 = prov.ItemBankCredential(FIXTURE_TOKEN, good_binding(expires_at=t + 600))
cred5._binding["expires_at"] = t - 1  # white-box: expire after construction
expect("headers() on a stale handle raises CredentialExpired", prov.CredentialExpired,
       cred5.headers)
cred5.close()
expect("ttl longer than max age raises", prov.BindingMismatch,
       lambda: prov.ItemBankCredential(
           FIXTURE_TOKEN, good_binding(expires_at=t + 601)))

# 8. assert_binding_for
cred4 = prov.ItemBankCredential(FIXTURE_TOKEN, good_binding())
cred4.assert_binding_for("89585", "chcp")
check("matching course/tenant passes binding assertion", True)
expect("wrong course raises BindingMismatch", prov.BindingMismatch,
       lambda: cred4.assert_binding_for("12345", "chcp"))
expect("wrong tenant raises BindingMismatch", prov.BindingMismatch,
       lambda: cred4.assert_binding_for("89585", "other"))
cred4.close()

# 9. Stale item-bank route constant absent
check("stale route literal absent from module source",
      "item_banks" not in PROV_SRC)

# 10. No mint-chain remnants
REMNANT_IDS = [
    "mint_service_jwt", "sdk_tokens", "STEP12_JS", "STEP1_JS",
    "def step1_mint_only", "def step12_session_bound_reads",
    "def step3_native_launch", "def step4_build_token_mint",
    "def step5_verify_quiz_api", "cdp_list_tabs", "find_banks_tab",
    "cached_pair_fresh", "merge_quiz_material", "quiz-lti-",
    "/api/v1/jwts", "native/launch", "session.json", "PARAMS_TTL",
    "jwt_outer", "JWT outer",
]
for rid in REMNANT_IDS:
    check("mint-chain remnant absent: %s" % rid, rid not in PROV_SRC)
expect("old provision_build_token_memory always raises",
       prov.ProvisionFailed,
       lambda: prov.provision_build_token_memory(course_id="89585"))
try:
    prov.provision_build_token_memory(course_id="89585")
except prov.ProvisionFailed as e:
    check("deleted-chain error names the replacement",
          "provision_item_bank_credential_memory" in str(e), str(e)[:120])
expect("old entry with no course_id raises ProvisionFailed",
       prov.ProvisionFailed,
       lambda: prov.provision_build_token_memory())

# 11. No launch driver wired: fail closed
expect("no driver raises NoLaunchDriver", prov.NoLaunchDriver,
       lambda: prov.provision_item_bank_credential_memory(course_id="89585"))
try:
    prov.provision_item_bank_credential_memory(course_id="89585")
except prov.NoLaunchDriver as e:
    check("no-driver error refuses to synthesize material",
          "synthesize" in str(e), str(e)[:120])

# 12. No course_id: fail closed, never a default course
expect("no course_id raises ProvisionFailed", prov.ProvisionFailed,
       lambda: prov.provision_item_bank_credential_memory())
try:
    prov.provision_item_bank_credential_memory()
except prov.ProvisionFailed as e:
    check("error refuses a default course",
          "default course" in str(e), str(e)[:120])

# 13. CLI exit codes and stdout hygiene
buf = io.StringIO()
with redirect_stdout(buf):
    rc = prov.main([])
check("CLI with no --course-id exits 2", rc == 2, "rc=%r" % rc)
buf = io.StringIO()
with redirect_stdout(buf):
    rc = prov.main(["--course-id", "89585"])
check("CLI with course id but no driver exits 3", rc == 3, "rc=%r" % rc)
out = buf.getvalue()
rep = json.loads(out)
check("CLI report names the blocker",
      "no_launch_driver" in rep.get("blocker", "").lower()
      or "NoLaunchDriver" in rep.get("blocker", ""), rep.get("blocker"))
check("CLI stdout carries no token-shaped secret",
      FIXTURE_TOKEN not in out and "synthetic-test-token" not in out)

# Full fake-driver run: proves the happy path without any network.
class FakeDriver(prov.ManagedBrowserLaunchDriver):
    def probe_session(self):
        return {"session_ok": True, "login_redirect": False,
                "canvas_base": "https://chcp.instructure.com",
                "principal_ref": "user-28206"}
    def resolve_placement(self, course_id):
        return {"tool_id": "7",
                "launch_url": "https://chcp.instructure.com/courses/%s/external_tools/7"
                              % course_id,
                "match_count": 1, "tabs_checked": 12}
    def launch_and_capture(self, spec, timeout_s):
        t = prov.now()
        return {"authorization": FIXTURE_TOKEN, "nonce": FIXTURE_NONCE,
                "tab_id": "tab-9", "frame_id": "frame-9",
                "launch_url": spec["launch_url"], "external_tool_id": "7",
                "api_origin": "https://chcp.quiz-api.instructure.com",
                "launched_at": t - 5, "captured_at": t}
    def close_tab(self, tab_id):
        self.closed = tab_id

driver = FakeDriver()
handle, steps = prov.provision_item_bank_credential_memory(
    course_id="89585", course_uuid="123e4567-e89b-12d3-a456-426614174999",
    launch_driver=driver)
check("happy path returns a handle and steps",
      isinstance(handle, prov.ItemBankCredential) and len(steps) == 6, len(steps))
check("temp tab closed", getattr(driver, "closed", None) == "tab-9")
hdrs = handle.headers()
check("captured headers use raw token plus AuthType: Signature",
      hdrs["Authorization"] == FIXTURE_TOKEN and hdrs["AuthType"] == "Signature")
expect("handle reuse raises CredentialConsumed", prov.CredentialConsumed, handle.headers)
handle.close()
buf = io.StringIO()
with redirect_stdout(buf):
    print(json.dumps({"binding": handle.binding_summary()}))
check("receipt output carries no token value", FIXTURE_TOKEN not in buf.getvalue())

# Driver-side blockers propagate with the right exit mapping
class DeadSessionDriver(FakeDriver):
    def probe_session(self):
        return {"session_ok": False, "login_redirect": True,
                "canvas_base": "https://chcp.instructure.com", "principal_ref": ""}
expect("dead session raises SessionDead", prov.SessionDead,
       lambda: prov.provision_item_bank_credential_memory(
           course_id="89585", launch_driver=DeadSessionDriver(),
           course_uuid="123e4567-e89b-12d3-a456-426614174999"))

class NoPlacementDriver(FakeDriver):
    def resolve_placement(self, course_id):
        return {"tool_id": "", "launch_url": "", "match_count": 0, "tabs_checked": 12}
expect("zero placement matches raises PlacementUnresolved", prov.PlacementUnresolved,
       lambda: prov.provision_item_bank_credential_memory(
           course_id="89585", launch_driver=NoPlacementDriver(),
           course_uuid="123e4567-e89b-12d3-a456-426614174999"))

class MultiPlacementDriver(FakeDriver):
    def resolve_placement(self, course_id):
        return {"tool_id": "7", "launch_url": "x", "match_count": 2, "tabs_checked": 12}
expect("multiple placement matches raise PlacementUnresolved", prov.PlacementUnresolved,
       lambda: prov.provision_item_bank_credential_memory(
           course_id="89585", launch_driver=MultiPlacementDriver(),
           course_uuid="123e4567-e89b-12d3-a456-426614174999"))

class SlowCaptureDriver(FakeDriver):
    def launch_and_capture(self, spec, timeout_s):
        return None
expect("no capture raises CaptureTimeout", prov.CaptureTimeout,
       lambda: prov.provision_item_bank_credential_memory(
           course_id="89585", launch_driver=SlowCaptureDriver(),
           course_uuid="123e4567-e89b-12d3-a456-426614174999"))

# 14. quiz_api_base validates the tenant label
check("quiz_api_base builds the tenant host",
      prov.quiz_api_base("chcp") == "https://chcp.quiz-api.instructure.com")
expect("bad tenant label raises", prov.ProvisionFailed,
       lambda: prov.quiz_api_base("evil.example.com/x"))
expect("empty tenant raises", prov.ProvisionFailed, lambda: prov.quiz_api_base(""))

# 15. No /tmp references in the module source
check("no /tmp references in module source", "/tmp" not in PROV_SRC)

# Course UUID resolution
check("explicit UUID accepted",
      prov.resolve_course_uuid(course_uuid="123e4567-e89b-12d3-a456-426614174999")
      == "123e4567-e89b-12d3-a456-426614174999")
expect("malformed UUID raises", prov.CourseUuidUnresolved,
       lambda: prov.resolve_course_uuid(course_uuid="nope"))
expect("no UUID and no fetcher raises", prov.CourseUuidUnresolved,
       lambda: prov.resolve_course_uuid())
check("fetcher-supplied UUID accepted",
      prov.resolve_course_uuid(course_fetcher=lambda: {"uuid": "123e4567-e89b-12d3-a456-426614174999"})
      == "123e4567-e89b-12d3-a456-426614174999")
expect("fetcher record without uuid raises", prov.CourseUuidUnresolved,
       lambda: prov.resolve_course_uuid(course_fetcher=lambda: {"id": 1}))

print("pass: %d" % len(PASS))
for name in PASS:
    print("  ok %s" % name)
if FAIL:
    print("FAIL: %d" % len(FAIL))
    for name in FAIL:
        print("  FAIL %s" % name)
    sys.exit(1)
print("all provision selftests passed")
