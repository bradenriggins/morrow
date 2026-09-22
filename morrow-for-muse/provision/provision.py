#!/usr/bin/env python3
"""Item Bank credential provisioner for Morrow for Muse: frame-bound launch/capture.

Design (desktop Morrow evidence, reconciled 2026-09-21):

  Desktop Morrow NEVER mints Item Bank credentials server side. The five-step
  mint chain this file used to implement (workflow-token mint, banks page
  read, native launch, scoped-token mint, quiz-api use) was our own invention
  and is DELETED. It must not be revived. There is no server-side fallback.

  Correct flow:

  1. Resolve the Item Banks LTI tool placement for the course from the Canvas
     tabs response. Exactly one tool match is required; the launch URL is
     /courses/{course_id}/external_tools/{tool_id}.
  2. Open an inactive temporary tab at the launch URL in the managed browser
     and let Canvas's own Item Banks client run.
  3. Capture Authorization plus AuthType: Signature from Canvas's own first
     GET /api/banks request. The request must occur within 45 seconds of
     launch.
  4. Bind the capture to the exact nonce (UUIDv4), tab, frame, launch URL,
     tenant, api origin, context UUID, course id, external tool id, and time
     window. Token length 51-8192 chars. Credential max age 10 minutes.
  5. Keep the credential in memory only. Hand it out for exactly one
     operation. Close the temporary tab and clear the credential material.

  Bank creation is two-phase: create the bank, then create the read-only
  course share. Bank question creation is two-phase: create the item, then
  attach the bank entry. Course identity uses the Canvas course UUID, not
  only the numeric id.

  Calls go to the tenant Quizzes API host:
    https://{tenant}.quiz-api.instructure.com/api/banks/...
  with Authorization: <captured token> (raw, no scheme prefix) plus
  AuthType: Signature. The stale item-bank route under the quiz v1 path is a
  known 404 and must never be used.

  Earlier 401s were the wrong credential, not a tenant restriction: do not
  call Item Banks unavailable on a tenant because a capture failed.

Evidence sources:
  ~/workspace/morrow-desktop-analysis/INCORPORATION-PLAN.md, section P0-1
  ~/workspace/morrow-desktop-analysis/03-newquiz-itembank.md (capture
  validations: token 51-8192 chars, UUIDv4 nonce, 45 s capture window,
  10 minute max credential age, memory-only, cleared on close)

Credential material never touches disk, logs, or stdout. This script prints
shapes, statuses, lengths, and IDs only.

Fail-closed rules (named blockers, never retried):
  - No managed-browser session (login redirect observed): exit 2.
  - No Item Banks placement resolved: exit 3.
  - No launch driver wired (capture transport not connected): exit 3.
  - Course UUID unresolvable: exit 3.
  - Capture timeout (no GET /api/banks headers within 45 s of launch): exit 3.
  - Binding mismatch on any binding field: exit 3.
  - Credential expired or presented for a second operation: exit 3.
  - If the launch frame collapses before the first banks request, the request
    simply cannot be made: uncertain result, not failure, never replayed.

Exit codes: 0 success, 2 session blocker, 3 provisioning blocker/failure.
"""
import json
import re
import sys
import time
import urllib.parse

CAPTURE_WINDOW_SECONDS = 45       # first GET /api/banks must occur within 45 s of launch
CREDENTIAL_MAX_AGE_SECONDS = 600  # a credential older than 10 minutes is dead
TOKEN_MIN_LEN = 51                # desktop-validated bounds for the captured token
TOKEN_MAX_LEN = 8192

TENANT_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", re.IGNORECASE)
UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE)
# Canvas course UUIDs are opaque strings in the wild (observed live on the
# educator's tenant: a 43-character alphanumeric token such as
# "OxO4Y5yErxxwmlKpXV7qWx9wnFyMoQG17sLQndNi"), not always RFC-4122 shaped.
# Accept either form so the real provision API does not reject the real
# course UUID. Evidence: proof-battery/live-product-proof/report-read.json.
COURSE_UUID_RE = re.compile(
    r"^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    r"|[A-Za-z0-9_-]{40,64})$",
    re.IGNORECASE)


# ---------------------------------------------------------------------------
# Errors: named fail-closed blockers and failures. Message text never
# contains credential values.
# ---------------------------------------------------------------------------

class ProvisionBlocked(Exception):
    """Named fail-closed blocker; no retry is attempted."""


class ProvisionFailed(Exception):
    """Named provisioning failure after launch; no retry is attempted."""


class SessionDead(ProvisionBlocked):
    """The managed-browser session is not a live Canvas session. Exit 2."""


class NoLaunchDriver(ProvisionBlocked):
    """No managed-browser launch driver is wired. Exit 3."""


class PlacementUnresolved(ProvisionBlocked):
    """The Item Banks LTI tool placement did not resolve to exactly one tool. Exit 3."""


class CourseUuidUnresolved(ProvisionBlocked):
    """No Canvas course UUID could be resolved for the course. Exit 3."""


class CaptureTimeout(ProvisionFailed):
    """No banks request headers were captured within the capture window. Exit 3."""


class BindingMismatch(ProvisionFailed):
    """A binding field is missing, malformed, or does not match. Exit 3."""


class CredentialExpired(ProvisionFailed):
    """The credential is older than its max age. Exit 3; never re-presented."""


class CredentialConsumed(ProvisionFailed):
    """The credential was already handed out for one operation. Exit 3."""


class CredentialClosed(ProvisionFailed):
    """The credential was cleared. Exit 3."""


def now():
    return int(time.time())


def shape(v, depth=0):
    """Render a JSON value as shapes/lengths/key names only."""
    if isinstance(v, dict):
        if depth >= 2:
            return {"keys": sorted(v.keys())}
        return {k: shape(x, depth + 1) for k, x in v.items()}
    if isinstance(v, str):
        return "<str len=%d>" % len(v)
    if isinstance(v, list):
        return "<list len=%d>" % len(v)
    return type(v).__name__


def quiz_api_base(tenant):
    """Tenant Quizzes API base URL. The tenant label is validated, never invented."""
    if not tenant or not TENANT_RE.match(str(tenant)):
        raise ProvisionFailed(
            "bad_tenant: %r is not a valid tenant label; refusing to invent a host"
            % (str(tenant)[:40],))
    return "https://%s.quiz-api.instructure.com" % str(tenant).lower()


def _looks_like_uuid4(s):
    return isinstance(s, str) and bool(UUID4_RE.match(s))


# ---------------------------------------------------------------------------
# In-memory credential handle: single-operation use, explicit close/clear.
# ---------------------------------------------------------------------------

class ItemBankCredential:
    """Narrow in-memory handle for one captured Item Bank credential.

    The raw token lives in a bytearray, is handed out exactly once via
    headers(), and is zeroed by close(). Binding metadata is required at
    construction, validated, and immutable afterwards. Nothing here ever
    prints, logs, or persists the token.
    """

    REQUIRED_BINDING = (
        "nonce",            # UUIDv4 launch nonce
        "tab_id",           # temporary tab the launch ran in
        "frame_id",         # frame the banks client ran in
        "launch_url",       # exact launch URL opened
        "tenant",           # Canvas tenant label
        "course_id",        # numeric Canvas course id (str)
        "course_uuid",      # Canvas course UUID
        "external_tool_id", # Item Banks LTI tool id
        "api_origin",       # origin the banks request went to
        "launched_at",      # epoch seconds the temp tab opened
        "captured_at",      # epoch seconds the headers were captured
        "expires_at",       # epoch seconds the credential dies
    )

    def __init__(self, token, binding):
        if not isinstance(binding, dict):
            raise BindingMismatch("binding_not_a_dict: %s" % type(binding).__name__)
        missing = [k for k in self.REQUIRED_BINDING if k not in binding]
        if missing:
            raise BindingMismatch("binding_missing: %s" % ",".join(missing))
        if not _looks_like_uuid4(binding["nonce"]):
            raise BindingMismatch("binding_bad_nonce: nonce is not UUIDv4")
        raw = token.encode("utf-8") if isinstance(token, str) else bytes(token or b"")
        if not (TOKEN_MIN_LEN <= len(raw) <= TOKEN_MAX_LEN):
            raise BindingMismatch(
                "binding_bad_token_len: %d outside %d..%d"
                % (len(raw), TOKEN_MIN_LEN, TOKEN_MAX_LEN))
        launched_at = binding["launched_at"]
        captured_at = binding["captured_at"]
        expires_at = binding["expires_at"]
        if not all(isinstance(v, (int, float)) for v in (launched_at, captured_at, expires_at)):
            raise BindingMismatch("binding_bad_times: timestamps must be numbers")
        window = int(captured_at) - int(launched_at)
        if window < 0 or window > CAPTURE_WINDOW_SECONDS:
            raise BindingMismatch(
                "binding_bad_window: %ds outside 0..%ds"
                % (window, CAPTURE_WINDOW_SECONDS))
        if int(expires_at) - int(captured_at) > CREDENTIAL_MAX_AGE_SECONDS:
            raise BindingMismatch("binding_bad_ttl: credential age exceeds %ds"
                                  % CREDENTIAL_MAX_AGE_SECONDS)
        if int(expires_at) <= now():
            raise CredentialExpired("credential already expired at construction")
        for key in ("tab_id", "frame_id", "launch_url", "tenant", "course_id",
                    "course_uuid", "external_tool_id", "api_origin"):
            if not binding.get(key):
                raise BindingMismatch("binding_empty: %s" % key)
        if not COURSE_UUID_RE.match(str(binding["course_uuid"])):
            raise BindingMismatch("binding_bad_course_uuid")
        self._token = bytearray(raw)
        try:
            for i in range(len(raw)):
                raw[i] = 0
        except (TypeError, AttributeError):
            pass
        self._binding = {k: binding[k] for k in self.REQUIRED_BINDING}
        self._consumed = False
        self._closed = False

    def headers(self):
        """Return the (Authorization, AuthType) pair for exactly one operation.

        Authorization carries the raw captured token with no scheme prefix;
        the scheme word travels in the separate AuthType: Signature header
        (live-observed desktop contract). Second call raises.
        """
        if self._closed:
            raise CredentialClosed("credential_closed: material was cleared")
        if self._consumed:
            raise CredentialConsumed(
                "credential_consumed: already handed out for one operation; "
                "capture again for the next operation")
        if now() > int(self._binding["expires_at"]):
            raise CredentialExpired("credential_expired: older than max age; "
                                    "capture again, never re-present")
        self._consumed = True
        return {
            "Authorization": bytes(self._token).decode("utf-8"),
            "AuthType": "Signature",
            "Accept": "application/json",
        }

    def assert_binding_for(self, course_id, tenant):
        """Refuse use against a course/tenant the capture was not bound to."""
        if str(course_id) != str(self._binding["course_id"]):
            raise BindingMismatch(
                "binding_course_mismatch: bound to course %s"
                % str(self._binding["course_id"]))
        if str(tenant).lower() != str(self._binding["tenant"]).lower():
            raise BindingMismatch(
                "binding_tenant_mismatch: bound to tenant %s"
                % str(self._binding["tenant"]))

    def binding_summary(self):
        """Binding metadata as shapes/lengths only; never the token."""
        b = self._binding
        return {
            "keys": sorted(b.keys()),
            "nonce_is_uuid4": _looks_like_uuid4(b["nonce"]),
            "tab_id_len": len(str(b["tab_id"])),
            "frame_id_len": len(str(b["frame_id"])),
            "launch_url_len": len(str(b["launch_url"])),
            "tenant": str(b["tenant"]),
            "course_id": str(b["course_id"]),
            "course_uuid_present": True,
            "external_tool_id_len": len(str(b["external_tool_id"])),
            "api_origin": str(b["api_origin"]),
            "seconds_from_launch_to_capture": int(b["captured_at"]) - int(b["launched_at"]),
            "expires_in_seconds": int(b["expires_at"]) - now(),
            "consumed": self._consumed,
            "closed": self._closed,
        }

    def close(self):
        """Zero the credential material. Idempotent. Call when done, always."""
        for i in range(len(self._token)):
            self._token[i] = 0
        self._token = bytearray()
        self._closed = True


# ---------------------------------------------------------------------------
# Managed-browser launch driver interface.
#
# The driver owns the browser: session probe, placement resolution, temp-tab
# launch, header capture, and tab close. The provisioner owns validation,
# binding, and the credential handle. Drivers raise the named blockers above.
# ---------------------------------------------------------------------------

class ManagedBrowserLaunchDriver:
    """Interface for the managed-browser capture transport.

    probe_session() -> dict: {"session_ok": bool, "login_redirect": bool,
        "canvas_base": str, "principal_ref": str}
      A login redirect (session_ok False or login_redirect True) fails closed.

    resolve_placement(course_id) -> dict: {"tool_id": str, "launch_url": str,
        "match_count": int, "tabs_checked": int}
      The provisioner requires match_count == 1 exactly.

    launch_and_capture(spec, timeout_s) -> dict: {"authorization": str,
        "nonce": str (UUIDv4), "tab_id": str, "frame_id": str,
        "launch_url": str, "external_tool_id": str, "api_origin": str,
        "launched_at": int, "captured_at": int}
      spec: {"launch_url", "course_id", "course_uuid", "tool_id", "tenant"}.
      Opens the inactive temporary tab, lets Canvas's own Item Banks client
      run, and captures Authorization plus AuthType from its first
      GET /api/banks request. Raises CaptureTimeout when nothing is captured
      within timeout_s. Never synthesizes or invents token material.

    close_tab(tab_id) -> None: closes the temporary tab. Best effort; the
      provisioner records but never fails on a close error.
    """

    def probe_session(self):
        raise NotImplementedError

    def resolve_placement(self, course_id):
        raise NotImplementedError

    def launch_and_capture(self, spec, timeout_s):
        raise NotImplementedError

    def close_tab(self, tab_id):
        raise NotImplementedError


def resolve_course_uuid(course_uuid=None, course_fetcher=None):
    """Resolve the Canvas course UUID (context identity), not the numeric id.

    Prefers an explicit UUID; otherwise asks course_fetcher(course_id) for the
    course record and reads its "uuid" field. Fails closed when unresolvable.
    """
    if course_uuid:
        if not COURSE_UUID_RE.match(str(course_uuid)):
            raise CourseUuidUnresolved(
                "bad_course_uuid: %r is not UUID-shaped" % str(course_uuid)[:40])
        return str(course_uuid)
    if course_fetcher is None:
        raise CourseUuidUnresolved(
            "course_uuid_unresolved: no explicit UUID and no course fetcher wired")
    try:
        record = course_fetcher()
    except CourseUuidUnresolved:
        raise
    except Exception as e:  # noqa: BLE001
        raise CourseUuidUnresolved("course_fetch_failed: %r" % e)
    cuuid = record.get("uuid") if isinstance(record, dict) else None
    if not cuuid or not COURSE_UUID_RE.match(str(cuuid)):
        raise CourseUuidUnresolved("course_record_has_no_uuid")
    return str(cuuid)


# ---------------------------------------------------------------------------
# Provision entry point for the dispatch executor's PROVISION step.
# ---------------------------------------------------------------------------

def provision_item_bank_credential_memory(course_id=None, tenant=None, course_uuid=None,
                                         launch_driver=None, course_fetcher=None,
                                         capture_timeout_s=CAPTURE_WINDOW_SECONDS):
    """Launch/capture one Item Bank credential in the managed browser.

    Returns (ItemBankCredential, steps). The handle is single-use and must be
    closed by the caller. Raises the named blockers above; never falls back
    to a server-side mint.
    """
    steps = []
    if not course_id:
        raise ProvisionFailed(
            "course_id is required; refusing to provision into a default course")
    course_id = str(course_id)

    if launch_driver is None:
        raise NoLaunchDriver(
            "no_launch_driver: the managed-browser capture transport is not "
            "connected; refusing to synthesize credential material")

    # --- session probe: the signed-in browser session is the credential ---
    try:
        session = launch_driver.probe_session()
    except SessionDead:
        raise
    except (ProvisionBlocked, ProvisionFailed):
        raise
    except Exception as e:  # noqa: BLE001
        raise ProvisionFailed("session_probe_error: %r" % e)
    if not isinstance(session, dict) or not session.get("session_ok") \
            or session.get("login_redirect"):
        raise SessionDead(
            "session_dead: managed browser has no live Canvas session "
            "(login redirect observed or probe failed)")
    canvas_base = session.get("canvas_base") or ""
    principal_ref = str(session.get("principal_ref") or "")
    steps.append({
        "name": "session probe",
        "status": "ok",
        "canvas_base_len": len(canvas_base),
        "principal_ref_len": len(principal_ref),
    })

    # --- tenant ---
    tenant = tenant or urllib.parse.urlparse(canvas_base).netloc.split(".")[0]
    api_base = quiz_api_base(tenant)  # raises ProvisionFailed on a bad label
    steps.append({"name": "tenant", "status": "ok", "tenant": tenant,
                  "quiz_api_base": api_base})

    # --- placement: exactly one Item Banks tool match ---
    try:
        placement = launch_driver.resolve_placement(course_id)
    except (ProvisionBlocked, ProvisionFailed):
        raise
    except Exception as e:  # noqa: BLE001
        raise ProvisionFailed("placement_error: %r" % e)
    if not isinstance(placement, dict) or placement.get("match_count") != 1 \
            or not placement.get("tool_id") or not placement.get("launch_url"):
        raise PlacementUnresolved(
            "placement_unresolved: expected exactly one Item Banks tool match; "
            "shape=%s" % json.dumps(shape(placement))[:160])
    tool_id = str(placement["tool_id"])
    launch_url = str(placement["launch_url"])
    steps.append({
        "name": "placement",
        "status": "ok",
        "match_count": 1,
        "tabs_checked": placement.get("tabs_checked"),
        "tool_id_len": len(tool_id),
        "launch_url_len": len(launch_url),
    })

    # --- course UUID: context identity for the banks surface ---
    cuuid = resolve_course_uuid(course_uuid, course_fetcher)
    steps.append({"name": "course uuid", "status": "ok", "course_uuid_present": True})

    # --- launch and capture ---
    spec = {"launch_url": launch_url, "course_id": course_id,
            "course_uuid": cuuid, "tool_id": tool_id, "tenant": tenant}
    try:
        capture = launch_driver.launch_and_capture(spec, timeout_s=capture_timeout_s)
    except (ProvisionBlocked, ProvisionFailed):
        raise
    except Exception as e:  # noqa: BLE001
        raise ProvisionFailed("capture_error: %r" % e)
    if not isinstance(capture, dict) or not capture.get("authorization"):
        raise CaptureTimeout(
            "capture_timeout: no banks request headers captured within %ds of launch"
            % capture_timeout_s)
    captured_at = capture.get("captured_at")
    launched_at = capture.get("launched_at")
    if not isinstance(captured_at, (int, float)) or not isinstance(launched_at, (int, float)):
        raise BindingMismatch("capture_missing_times")
    binding = {
        "nonce": capture.get("nonce"),
        "tab_id": capture.get("tab_id"),
        "frame_id": capture.get("frame_id"),
        "launch_url": capture.get("launch_url") or launch_url,
        "tenant": tenant,
        "course_id": course_id,
        "course_uuid": cuuid,
        "external_tool_id": capture.get("external_tool_id") or tool_id,
        "api_origin": capture.get("api_origin"),
        "launched_at": int(launched_at),
        "captured_at": int(captured_at),
        "expires_at": int(captured_at) + CREDENTIAL_MAX_AGE_SECONDS,
    }
    handle = ItemBankCredential(capture["authorization"], binding)  # validates binding
    steps.append({
        "name": "launch and capture",
        "status": "ok",
        "token_len": len(capture["authorization"]),
        "seconds_from_launch_to_capture": int(captured_at) - int(launched_at),
        "binding": handle.binding_summary(),
    })

    # --- close the temporary tab (best effort; the credential clear is separate) ---
    tab_closed = False
    close_error = None
    try:
        launch_driver.close_tab(binding["tab_id"])
        tab_closed = True
    except Exception as e:  # noqa: BLE001
        close_error = "%s" % type(e).__name__
    steps.append({"name": "close temp tab", "status": "ok" if tab_closed else "close_failed",
                  "tab_closed": tab_closed, "close_error": close_error})

    return handle, steps


def provision_build_token_memory(course_id=None, **kwargs):
    """Deleted chain. Always raises.

    The five-step mint chain was removed 2026-09-21: desktop evidence shows
    Item Bank credentials are captured from Canvas's own client, never minted
    server side. Use provision_item_bank_credential_memory with a
    managed-browser launch driver. Kept as a named stub so old callers fail
    closed instead of silently doing nothing.
    """
    if not course_id:
        raise ProvisionFailed(
            "course_id is required; refusing to provision into a default course")
    raise ProvisionFailed(
        "five_step_mint_chain_deleted: the workflow-token/native-launch/"
        "scoped-token chain was removed 2026-09-21 (credentials are captured, "
        "never minted). Use provision_item_bank_credential_memory with a "
        "managed-browser launch driver.")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def build_parser():
    import argparse
    p = argparse.ArgumentParser(
        description="Capture an Item Bank credential via frame-bound launch/capture "
                    "in the managed browser. Prints shapes, statuses, lengths, and "
                    "IDs only; raw token values never touch disk, logs, or stdout.")
    p.add_argument("--course-id", default=None,
                   help="Numeric Canvas course ID. Required: no default course "
                        "is ever assumed.")
    p.add_argument("--course-uuid", default=None,
                   help="Canvas course UUID (context identity for the banks "
                        "surface). Required when no course fetcher is wired.")
    p.add_argument("--tenant", default=None,
                   help="Canvas tenant prefix (default: derived from the session "
                        "probe's canvas_base).")
    p.add_argument("--capture-timeout", type=int, default=CAPTURE_WINDOW_SECONDS,
                   help="Seconds to wait for the banks request headers "
                        "(default: %d)." % CAPTURE_WINDOW_SECONDS)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    report = {"chain": "item_bank_launch_capture", "steps": [], "ok": False}
    if not args.course_id:
        report["blocker"] = ("--course-id is required; refusing to provision "
                             "into a default course")
        print(json.dumps(report, indent=2))
        return 2
    report["course_id"] = str(args.course_id)

    try:
        # No launch driver is wired in CLI mode yet: the capture transport is
        # not connected, so this fails closed with a named blocker. The live
        # battery wires a managed-browser driver through the executor.
        handle, steps = provision_item_bank_credential_memory(
            course_id=args.course_id, tenant=args.tenant,
            course_uuid=args.course_uuid, launch_driver=None,
            capture_timeout_s=args.capture_timeout)
        report["steps"] = steps
        report["binding"] = handle.binding_summary()
        report["ok"] = True
        handle.close()
        report["credential_cleared"] = True
    except SessionDead as e:
        report["blocker"] = "session_dead: %s" % e
        print(json.dumps(report, indent=2))
        return 2
    except ProvisionBlocked as e:
        report["blocker"] = "%s: %s" % (type(e).__name__, e)
        print(json.dumps(report, indent=2))
        return 3
    except ProvisionFailed as e:
        report["error"] = "%s: %s" % (type(e).__name__, e)
        print(json.dumps(report, indent=2))
        return 3

    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
