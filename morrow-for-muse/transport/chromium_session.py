#!/usr/bin/env python3
"""ChromiumSession: executor session adapter for the --backend chromium lane.

Exposes exactly what dispatch_entry / dispatch_catalog_op / dispatch_undo
expect of a session object, with egress through the local Chromium's
authenticated tab (transport/local_chromium.py) via CDP on this tree's
configured CDP port (LOGIN_HELPER_CDP_PORT, default 19223).

Session contract parity with dispatch.executor.SessionStore:

  base_for(provider)   Canvas base URL from the explicit base_url
                       override, CANVAS_BASE (the environment, then the
                       tree's helper/env), or the browser lane state. Any
                       other provider raises SessionMissing: this lane serves
                       the Canvas tenant only.
  slot_secret(slot)    Always raises SessionMissing. The educator's browser
                       owns the authenticated session; no credential material
                       (PAT, cookie, token) is ever read, logged, echoed, or
                       persisted here. build_headers skips credential
                       injection for sessions with browser_owned_auth set.
  raw_request(...)     (status, resp_headers, raw, attempts) with the exact
                       retry discipline of executor.request_with_retry:
                       reads retry transport errors and 408/429/500/502/503/
                       504 (4 attempts max, honoring Retry-After on 429);
                       writes retry ONLY on transport failures that prove the
                       request never reached the provider (DNS failure,
                       connection refused), and raise UncertainWrite
                       otherwise; other 4xx fail fast. GET reads follow
                       Canvas Link rel="next" pagination up to
                       CHROMIUM_MAX_PAGES pages (W2-P1-6); response bodies
                       are truncated at max_bytes in page context so Python
                       never holds more than the cap (W2-P2-8).

Laziness: constructing or loading a ChromiumSession never touches the
browser. The first raw_request attaches to the already-running helper
Chromium on this tree's CDP port when present (never a second browser),
after verifying the holder's --user-data-dir is this tree's profile
(foreign browsers are refused, never adopted); only when nothing listens
there does it launch its own instance on this tree's profile
(local_chromium.tree_helper_profile_dir()). The https and browser
backends never construct this class, so they never launch Chromium.

Session death (W4-P2-2): local_chromium.SessionDead at attach/probe
time, during pagination, or mid-operation maps to ChromiumSessionDead, an
ExecutorError that dispatch_entry does not catch, so nothing is journaled
and the op_id stays reusable (same shape as the browser lane's
BrowserSessionDead). Death is STICKY per session object: the first
SessionDead marks the session dead for good and every later call on it
raises ChromiumSessionDead immediately without calling the provider, so a
half-dead session is never written through. A SessionDead DURING a write
provider call is ambiguous (the page may have executed the write before
the socket died), so it becomes UncertainWrite with per-attempt evidence
and is journaled, never silently retried (W2-P0-4).

Session death is WIRED into the re-auth state machine (W4-P2-1): the
first SessionDead on a session object calls reauth.state_machine's
impose_halt() (the executor's write gates refuse every later write),
quarantine_session() (the death is parked in the quarantine ledger as a
session_death record), and write_notify_expired() (notify.txt). The
machine is the source of truth; the session only triggers it, exactly
once per death, and a broken re-auth store never breaks the session
contract (failures are swallowed: the ChromiumSessionDead /
UncertainWrite the caller already got is the loud signal).

Cause taxonomy (W4-P2-4): classify_auth_death() is evidence-graded. It
distinguishes "no live session was ever observed" from "a live session
ended", names natural expiry / password change / admin revocation as
the candidate causes without overclaiming which fired, and pairs each
cause key with per-cause remediation in AUTH_DEATH_REMEDIES (including
the operational test that separates plain expiry from the other two:
a fresh sign-in that dies again immediately). The token (HTTPS/PAT)
lane's 401 taxonomy is dispatch.executor._pat_401_detail: re-signing in
cannot fix a rejected token, mint a fresh one.

Pre-expiry awareness (W4-P2-3): after a successful attach the session
reads the helper /status session_expiry_horizon_days (cookie metadata
only) and warns once on stderr when the horizon is within ~24h, so the
educator can re-sign in before the first failed op.

Stdlib only.
"""

import json
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (_REPO, _HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from dispatch import executor as ex  # noqa: E402
import local_chromium as lc  # noqa: E402
import item_bank_sdk as ibsdk  # noqa: E402


class ChromiumSessionDead(ex.ExecutorError):
    """The local Chromium holds no live Canvas session: no provider call was
    attempted. Nothing is journaled, so the op_id stays reusable."""


class PrincipalMismatch(ex.ExecutorError):
    """The Canvas account signed in to the helper browser is not the
    pinned account. Nothing was sent; the re-auth write halt stands
    until the pinned account signs back in (reauth resume)."""


class PrincipalNotPinned(ex.ExecutorError):
    """No Canvas account is pinned (or the pin store cannot be trusted),
    so a write cannot prove it runs as the educator. Nothing was sent."""


# Final muse audit M3: the signed-in account is compared with the pinned
# principal (reauth/state_machine.pin_principal) before every write and
# once per session object for reads. The users/self read that makes the
# comparison (and that pinning itself uses) is exempt.
_PRINCIPAL_PATH = "/api/v1/users/self"


# W4-P2-4: auth-death taxonomy. The browser lane proves only that the
# session is dead; on the wire, natural expiry, a password change, and a
# tenant-admin revocation all present identically (a rejected session, a
# login redirect, a login page served with 200). The classifier is
# therefore evidence-graded: it names the proven fact first, lists the
# candidate causes honestly instead of claiming one, and gives
# per-cause remediation including the operational test that separates
# them (a fresh sign-in that dies again immediately is not plain
# expiry). The token (HTTPS/PAT) lane's 401 taxonomy is the executor's
# _pat_401_detail: re-signing in cannot fix a rejected token, mint a
# fresh one instead. Cause keys are logged (and recorded in the
# re-auth ledger's session_death entry) so auth deaths are countable
# by cause.

AUTH_DEATH_NO_LIVE_SESSION = "no_live_session"
AUTH_DEATH_SESSION_ENDED = "session_ended"

AUTH_DEATH_REMEDIES = {
    AUTH_DEATH_NO_LIVE_SESSION: (
        "Remedy: sign in to Canvas through the login helper, then retry. "
        "No live session was found in the helper browser, so there is "
        "nothing to resume."),
    AUTH_DEATH_SESSION_ENDED: (
        "Remedy: sign in again through the login helper. The dead "
        "session presents as one of (a) natural session expiry, (b) "
        "your Canvas password changed, or (c) a Canvas admin revoked "
        "the session; the dead session alone does not prove which. "
        "Operational test: if a fresh sign-in dies again immediately, "
        "it is not plain expiry. For (b), sign in with the new "
        "password; for (c), ask your Canvas admin / IT help desk "
        "whether the session was revoked."),
}


def classify_auth_death(exc, had_live_session):
    """W4-P2-4: classify a dead browser session from the evidence.

    Returns (cause_key, message). had_live_session is True when this
    session object previously observed a live session (a verified
    ensure_session or a completed provider call); without it the honest
    claim is only "no live session found", never "your session expired".
    The message names the candidate causes without overclaiming which
    one fired; pair it with AUTH_DEATH_REMEDIES[cause_key] for the
    per-cause guidance.
    """
    msg = str(exc or "")
    login_evidence = "login" in msg.lower()
    if not had_live_session:
        detail = "the browser holds no live Canvas session"
        if login_evidence:
            detail += " (the last probe was redirected to a login page)"
        return (AUTH_DEATH_NO_LIVE_SESSION,
                "%s; no live session was ever observed on this session "
                "object" % detail)
    candidates = ("natural expiry, a password change, or an admin "
                  "revocation")
    if login_evidence:
        return (AUTH_DEATH_SESSION_ENDED,
                "the Canvas session ended: the browser was redirected to, "
                "or served, a login page (%s; the dead session alone "
                "does not prove which)" % candidates)
    return (AUTH_DEATH_SESSION_ENDED,
            "the Canvas session is no longer valid (%s; the signal does "
            "not prove which)" % candidates)


def _lane_state_base():
    """Canvas base URL from the browser lane state (metadata only)."""
    try:
        import state as lane_state_mod
    except ImportError:
        return None
    try:
        record = lane_state_mod.load()
    except Exception:
        return None
    if not record:
        return None
    base = ((record.get("canvas") or {}).get("base") or "").strip().rstrip("/")
    return base or None


def _normalize_tenant_base(base: str) -> str:
    """Normalize a tenant base URL for comparison: lowercase scheme and
    host, drop default ports, strip trailing slashes.

    W5-P2-3: NFKC-normalize host and path so compatibility-equivalent
    spellings compare equal."""
    parsed = urllib.parse.urlparse(str(base or "").strip())
    host = unicodedata.normalize("NFKC", (parsed.hostname or "").lower())
    port = parsed.port
    scheme = (parsed.scheme or "").lower()
    if port and not ((scheme == "https" and port == 443)
                     or (scheme == "http" and port == 80)):
        host = "%s:%d" % (host, port)
    path = unicodedata.normalize("NFKC", parsed.path or "").rstrip("/")
    return "%s://%s%s" % (scheme, host, path)


def verify_helper_tenant_binding(base_url: str) -> str | None:
    """W4-P1-14 / W4-P2-27: bind the dispatch tenant to the helper's
    configured tenant.

    Compares the resolved dispatch tenant against the tenant the
    browser is actually signed into (the browser lane state store).
    Refuses loudly with TenantBindingMismatch, naming both tenants,
    when they differ: a globally-wrong tenant (mint-wrong-A +
    dispatch-wrong-A) is self-consistent at the approval layer, so only
    this binding catches it. Returns the helper tenant when they agree,
    None when no lane state exists (nothing to compare against; the
    check cannot run and does not block)."""
    helper_base = _lane_state_base()
    if not helper_base:
        return None
    if _normalize_tenant_base(base_url) != _normalize_tenant_base(helper_base):
        raise ex.TenantBindingMismatch(
            "dispatch tenant %s differs from helper tenant %s (the tenant "
            "the browser is actually signed into, per the lane state "
            "store). Refusing: the educator's browser session cannot act "
            "on a different tenant." % (base_url, helper_base))
    return helper_base


def _decode_body(body_bytes, headers):
    """Recover the transport-level body from the executor's body_bytes.

    Returns (data, as_json). The executor JSON-encodes dict bodies by
    default, so JSON objects round-trip as JSON, and so does the bulk
    date update's array of objects; explicit form-encoded bodies decode
    back to a flat field dict. A body the lane cannot encode raises
    WriteNotAttempted: it is refused before anything is sent.
    """
    if body_bytes is None:
        return None, False
    ctype = ""
    for key, value in (headers or {}).items():
        if key.lower() == "content-type":
            ctype = value.split(";")[0].strip().lower()
            break
    if ctype == "application/x-www-form-urlencoded":
        pairs = urllib.parse.parse_qsl(
            body_bytes.decode("utf-8"), keep_blank_values=True)
        return dict(pairs), False
    try:
        obj = json.loads(body_bytes.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise ex.WriteNotAttempted(
            "chromium backend cannot encode a non-JSON request body; "
            "nothing was sent") from None
    if isinstance(obj, dict):
        return obj, True
    if isinstance(obj, list) and obj and all(
            isinstance(item, dict) for item in obj):
        return obj, True
    raise ex.WriteNotAttempted(
        "chromium backend sends a JSON object or a JSON array of objects "
        "as the request body; nothing was sent")


class ChromiumSession:
    """SessionStore-compatible session; egress is the local Chromium tab."""

    # Marker read by executor.build_headers: skip credential injection at
    # egress, because the browser owns the authenticated session.
    browser_owned_auth = True

    def __init__(self, base_url, launcher=None, transport=None):
        self._base = base_url.rstrip("/")
        self._launcher = launcher
        self._transport = transport
        # Item Banks SDK lane: course scope for the LTI launch, bound by
        # the executor from params.course_id (set_sdk_course). One cached
        # SDK object per course so the LTI surface is launched once per
        # session, not once per request.
        self._sdk_course_id = None
        self._sdk_sessions = {}
        # W4-P2-2: sticky session death. The first lc.SessionDead (or
        # ItemBankSdkSessionDead) marks this session dead for good;
        # every later call on it raises ChromiumSessionDead immediately
        # without touching the provider and without journaling another
        # uncertain write. The educator must re-sign in; a fresh session
        # object is required.
        self._session_dead = False
        self._dead_cause = None
        self._dead_cause_key = None
        # W4-P2-1: the re-auth machinery fires exactly once per death.
        self._death_notified = False
        # W4-P2-4: True once this object has observed a live session
        # (verified ensure_session or a completed provider call); the
        # taxonomy refuses to claim "expired" for a session never seen
        # live.
        self._had_live_session = False
        # W4-P2-3: the near-expiry warning is emitted once per object.
        self._expiry_warned = False
        # Final muse audit M3: reads compare the signed-in account with
        # the pin once per object; writes compare before every write.
        self._principal_checked = False

    # -- sticky session death (W4-P2-2) ------------------------------------

    def _mark_session_dead(self, exc):
        """Record that this session is dead (evidence: the SessionDead
        message). Idempotent.

        W4-P2-1: the FIRST mark also wires the death into the re-auth
        state machine (the source of truth): impose the write halt,
        quarantine the session, and notify. Later marks are silent:
        the sticky flag already stopped this object, and the machine
        must not get a second halt/notify per death.
        """
        first = not self._session_dead
        self._session_dead = True
        if self._dead_cause_key is None:
            key, msg = classify_auth_death(exc, self._had_live_session)
            self._dead_cause_key = key
            self._dead_cause = msg
        if first:
            self._notify_reauth_machine(exc)

    def _notify_reauth_machine(self, exc):
        """W4-P2-1: halt writes, quarantine the session, notify.

        The re-auth state machine owns this lifecycle; the session only
        triggers it. Detection metadata carries the taxonomy cause key
        so the ledger records WHY the session died (W4-P2-4). This must
        never break the session contract: every failure mode here is
        swallowed, because the ChromiumSessionDead / UncertainWrite
        the caller already got is the loud signal.
        """
        if self._death_notified:
            return
        self._death_notified = True
        try:
            from reauth import state_machine as rsm
        except Exception:
            return
        try:
            detection = {"signal": "chromium_session_dead",
                         "cause": self._dead_cause_key,
                         "evidence": str(exc or "")[:200]}
            rsm.impose_halt(
                detection,
                reason="chromium session death (%s)"
                % (self._dead_cause_key or "unknown"),
                cause="session_expired")
            rsm.quarantine_session(self._dead_cause_key, detection)
            rsm.write_notify_expired(len(rsm.paused_ops()))
        except Exception:
            pass

    def _dead_exc(self, during):
        remedy = AUTH_DEATH_REMEDIES.get(
            self._dead_cause_key,
            "Remedy: sign in again through the login helper.")
        return ChromiumSessionDead(
            "chromium backend: %s (%s). %s No provider call was "
            "attempted; the op_id stays reusable."
            % (self._dead_cause or "session known dead", during, remedy))

    def _raise_if_session_dead(self):
        """Refuse immediately when this session is known dead: never call
        the provider on a half-dead session (W4-P2-2)."""
        if self._session_dead:
            raise self._dead_exc("session already known dead")

    @classmethod
    def load(cls, base_url=None):
        """Resolve the tenant base without touching the browser.

        Precedence: explicit base_url, CANVAS_BASE (the environment, then
        this tree's helper/env, as config/tree_config resolves it for
        every agent command), browser lane state. Fails closed when none
        is configured; the tenant is never hardcoded.

        W4-P2-27: the resolved dispatch tenant is bound to the helper's
        configured tenant here, in the session-load path: when the lane
        state records the tenant the browser is actually signed into and
        the resolved base differs from it, the load is refused loudly
        (TenantBindingMismatch naming both tenants).
        """
        from config import tree_config
        base = (base_url or tree_config.canvas_base()
                or _lane_state_base())
        if not base:
            raise ex.SessionMissing(
                "chromium backend needs a Canvas base URL: pass base_url, "
                "set CANVAS_BASE in this tree's helper/env, or onboard the "
                "browser lane state (~/.morrow/browser_lane.json)")
        verify_helper_tenant_binding(base)
        return cls(base)

    # -- SessionStore-compatible surface ---------------------------------

    def base_for(self, provider: str) -> str:
        if provider == "canvas":
            return self._base
        raise ex.SessionMissing(
            "chromium backend serves the Canvas tenant only; no base URL "
            "for provider %r" % provider)

    def slot_secret(self, slot: str):
        raise ex.SessionMissing(
            "chromium backend holds no credential material for slot %r: "
            "the educator's browser owns the authenticated session" % slot)

    # -- lazy browser lifecycle -------------------------------------------

    def _build_launcher(self):
        proxy = (os.environ.get("https_proxy")
                 or os.environ.get("HTTPS_PROXY")
                 or os.environ.get("http_proxy")
                 or os.environ.get("HTTP_PROXY"))
        # W2-P0-5: the launcher is derived from THIS tree (explicit env
        # override, else the tree-relative default), never the hardcoded
        # live profile/CDP port. A copied tree points at its own
        # helper/profile and its own ports.
        return lc.ChromiumLauncher(
            lc.default_binary(),
            lc.tree_helper_profile_dir(),
            cdp_port=lc.tree_cdp_port(),
            proxy=proxy)

    def _helper_http_up(self, timeout=3):
        """True when the login helper's HTTP endpoint answers /status.

        P1-24: the browser lane normally rides the helper's Chromium; a
        failed launch with the endpoint down means the helper itself is
        down, and the remedy is helper/keepalive.sh. Goes through
        local_chromium's single authenticated helper-request path
        (W3-P0-7); /status is the open endpoint, so no token is needed.
        """
        try:
            st = lc.helper_status(timeout=timeout)
            return isinstance(st, dict)
        except Exception:
            return False

    def _ensure_transport(self):
        """Attach to (or launch) the browser and verify the session.

        Runs once per session object, on the first provider call. Attaching
        to the helper Chromium on this tree's CDP port never starts a
        second browser; only when nothing listens there does start()
        launch its own instance on this tree's profile (the self-launch
        fallback).
        """
        # W4-P2-2: a known-dead session never touches the provider again.
        self._raise_if_session_dead()
        if self._transport is None:
            launcher = self._launcher or self._build_launcher()
            try:
                launcher.start()
            except Exception as exc:
                # P1-24: name the real remedy when the helper endpoint is
                # down too. The self-launch fallback above already ran;
                # this only changes what the failure says.
                if not self._helper_http_up():
                    raise ex.ExecutorError(
                        "chromium backend: browser unavailable (%s); the "
                        "login helper endpoint is down too -- start it with "
                        "helper/keepalive.sh, then retry" % exc)
                raise ex.ExecutorError(
                    "chromium backend: browser unavailable (%s)" % exc)
            self._launcher = launcher
            transport = lc.LocalChromiumTransport(self._base, launcher)
            try:
                transport.ensure_session()
            except lc.SessionDead as exc:
                # P1-24: the browser launched but the session is dead; stop
                # the launcher we started so a broken instance is not left
                # behind (same defensive getattr pattern as below: test
                # doubles may define only start()).
                self._mark_session_dead(exc)
                stop = getattr(launcher, "stop", None)
                if stop is not None:
                    try:
                        stop()
                    except Exception:
                        pass
                raise self._dead_exc("no live session at attach/probe time")
            except Exception:
                # P1-24: start() succeeded but the session never verified:
                # stop the browser we may have launched so a broken
                # instance is not left behind. stop() is safe on attached
                # launchers (it only kills the owned proc). Defensive
                # getattr: test doubles may define only start().
                stop = getattr(launcher, "stop", None)
                if stop is not None:
                    try:
                        stop()
                    except Exception:
                        pass
                raise
            self._transport = transport
            # ensure_session() verified a live session: the taxonomy may
            # now honestly say "was live, then died" (W4-P2-4).
            self._had_live_session = True
            # W4-P2-3: warn once when the helper reports the session
            # cookie expiring within ~24h.
            self._check_expiry_warning()
        return self._transport

    def _verify_principal(self, transport, is_write):
        """Refuse unless the helper browser is signed in as the pinned
        account. Writes: every time, and a pin is required. Reads: once
        per session object; with no pin yet, reads run (nothing to
        compare against) and the educator is asked to pin before any
        write. A mismatch imposes the re-auth write halt."""
        if not is_write and self._principal_checked:
            return
        try:
            from reauth import state_machine as rsm
        except Exception as exc:
            raise PrincipalNotPinned(
                "chromium backend: the pinned-account check could not run "
                "(%s); nothing was sent" % type(exc).__name__)
        try:
            pin = rsm.pinned_principal()
        except rsm.PrincipalPinError as exc:
            raise PrincipalNotPinned(
                "chromium backend: the record of the pinned Canvas account "
                "cannot be trusted (%s), so this lane cannot prove it runs "
                "as the educator. Nothing was sent. Recovery: disconnect "
                "(bin/morrow disconnect) and sign in fresh, then pin the "
                "account with reauth/state_machine.py pin --first-signin."
                % exc)
        if pin is None:
            if is_write:
                raise PrincipalNotPinned(
                    "chromium backend: no Canvas account is pinned yet, so "
                    "this write cannot prove it runs as the educator. "
                    "Nothing was sent. Run reauth/state_machine.py pin "
                    "--first-signin, confirm with the educator that the "
                    "name it prints is theirs, then retry.")
            self._principal_checked = True
            return
        try:
            status, _hdrs, body = transport.api(
                "GET", _PRINCIPAL_PATH, None, as_json=False,
                timeout=ex.REQUEST_TIMEOUT_S, max_bytes=65536)
            self._had_live_session = True
        except lc.SessionDead as exc:
            self._mark_session_dead(exc)
            raise self._dead_exc("no live session when checking the "
                                 "signed-in account")
        except Exception as exc:
            raise ex.ExecutorError(
                "chromium backend: could not confirm which Canvas account "
                "is signed in (%s); nothing was sent" % type(exc).__name__)
        try:
            me = json.loads(body) if status == 200 else None
        except (TypeError, ValueError):
            me = None
        live_id = me.get("id") if isinstance(me, dict) else None
        if live_id in (None, ""):
            raise ex.ExecutorError(
                "chromium backend: GET %s did not return the signed-in "
                "account (HTTP %s); nothing was sent"
                % (_PRINCIPAL_PATH, status))
        if str(live_id) != str(pin.get("id")):
            try:
                rsm.impose_halt({"signal": "principal_mismatch",
                                 "cause": "different_account_signed_in"},
                                reason="a different Canvas account is "
                                       "signed in to the helper",
                                cause="account_mismatch")
            except Exception:
                pass
            name = str(pin.get("name") or "").strip() or "the pinned account"
            raise PrincipalMismatch(
                "The Canvas account signed in to the login helper is not "
                "the account this connector is pinned to (%s). Nothing was "
                "sent, and writes are paused. Sign out in the helper page "
                "and sign back in as %s, then run reauth/state_machine.py "
                "resume. To use a different account, disconnect "
                "(bin/morrow disconnect) and sign in fresh." % (name, name))
        self._principal_checked = True

    def _check_expiry_warning(self):
        """W4-P2-3: warn once per session object when the helper's
        /status reports the session cookie expiring within ~24h.

        Reads cookie METADATA only (whole days, never names/values).
        Never fails the session: any helper problem means "unknown",
        not an error.
        """
        if self._expiry_warned:
            return
        self._expiry_warned = True
        try:
            st = lc.helper_status(timeout=5)
            days = (st or {}).get("session_expiry_horizon_days")
        except Exception:
            return
        if (isinstance(days, int) and not isinstance(days, bool)
                and 0 <= days <= 1):
            print("WARNING: chromium backend: the Canvas session cookie "
                  "expires within ~24h (horizon %d day(s) per helper "
                  "/status); re-sign in through the login helper soon, "
                  "or writes will halt mid-run" % days,
                  file=sys.stderr)

    def close(self):
        """Close this session's Item Banks tabs, then stop the Chromium
        this session launched, if it launched one.

        Every cached SDK session is closed first, whatever the launcher:
        on the helper browser (which is never stopped) its tab would
        otherwise stay open running the Item Banks app, which the
        idle-tab reaper does not close, and its credential would stay in
        memory.

        P2-12: stops ONLY launchers this process started itself. An attached
        launcher (this tree's helper browser, launcher.attached is
        True) is never stopped: launcher.stop() only terminates the owned
        proc, which is None when start() attached to the running helper.
        Defensive getattr: test doubles may define only start().
        """
        sdk_sessions, self._sdk_sessions = self._sdk_sessions, {}
        for sdk in sdk_sessions.values():
            try:
                sdk.close()
            except Exception:
                pass
        launcher = self._launcher
        if launcher is None:
            return
        if getattr(launcher, "attached", False):
            return
        if getattr(launcher, "proc", None) is None:
            return
        stop = getattr(launcher, "stop", None)
        if stop is not None:
            try:
                stop()
            except Exception:
                pass

    def set_sdk_course(self, course_id):
        """Bind the Item Banks SDK lane's course scope.

        Called by the executor from params.course_id before dispatch.
        The banks.build token is minted by a course-scoped LTI launch;
        a None course refuses SDK-lane dispatch fail-closed at call time.
        """
        if course_id is not None and str(course_id).strip() == "":
            course_id = None
        if course_id is not None:
            course_id = str(course_id)
        if course_id != self._sdk_course_id:
            # LANE6-3: close the old course's cached SDK sessions before
            # dropping them. The cached tabs hold the old course's
            # quiz-lti frame and the captured banks.build credential is
            # course-bound, so reusing them after a rebind would silently
            # run the new course's operations against the old course's
            # tabs. Fail closed: sessions die, credentials go with them.
            old = self._sdk_sessions
            self._sdk_sessions = {}
            self._sdk_course_id = course_id
            for sdk in old.values():
                try:
                    sdk.close()
                except Exception:
                    pass

    def _sdk_for_course(self, course_id):
        sdk = self._sdk_sessions.get(course_id)
        if sdk is None:
            sdk = ibsdk.ItemBankSdk(self._launcher.cdp, self._base,
                                    course_id)
            self._sdk_sessions[course_id] = sdk
        return sdk

    def _sdk_item_request(self, method: str, path: str, body_bytes,
                          headers: dict, is_write: bool, max_bytes=None):
        """Egress an /api/banks/... call through the Item Banks SDK lane.

        Same retry discipline as the canvas-origin path: reads retry
        transport errors and 408/429/500/502/503/504; writes retry ONLY on
        transport failures that prove the provider never saw the request
        (W2-P0-1) and raise UncertainWrite otherwise; other 4xx fail fast.
        Launch/token failures mean no provider call was attempted, so they
        are hard failures, never uncertain writes (the op_id stays
        meaningful, like SessionDead). A dead SDK session is sticky and
        never an uncertain write either: ItemBankSdkSessionDead fires
        only in launch(), before any provider activity. Conversely, a
        page-context call that may already have issued its fetch
        (ItemBankSdkMaybeAttempted) is UncertainWrite for writes. The
        SDK lane returns no response headers, so Retry-After cannot be
        honored here; reads use the standard backoff.
        """
        course_id = self._sdk_course_id
        if course_id is None:
            raise ex.ExecutorError(
                "Item Banks SDK lane needs params.course_id: the LTI "
                "launch that mints the banks.build token is course-scoped; "
                "refusing rather than launching in the wrong course")
        data, _as_json = _decode_body(body_bytes, headers)
        sdk = self._sdk_for_course(course_id)
        attempts = 0
        last_exc = None
        while attempts < ex.MAX_ATTEMPTS:
            attempts += 1
            try:
                status, body_text = sdk.request(method, path, data,
                                               course_id=course_id)
            except ibsdk.ItemBankSdkMaybeAttempted as exc:
                # LANE6-8: the page-context program may already have
                # issued its fetch when the outcome was lost (context
                # death, post-dispatch CDP failure, or a page-level
                # fetch that threw). A write here is genuinely
                # uncertain; a read is a hard failure the caller retries
                # with a fresh op.
                if is_write:
                    raise ex.UncertainWrite(
                        "SDK write may have executed before its outcome "
                        "was lost (%s); effect state unknown, not retried"
                        % type(exc).__name__,
                        attempts=attempts,
                        evidence=[{"method": method, "url": path,
                                   "status": "uncertain",
                                   "attempts": attempts,
                                   "detail": str(exc)[:200]}])
                raise ex.ExecutorError(
                    "Item Banks SDK read failed after a possibly-attempted "
                    "provider call (%s)" % exc)
            except ibsdk.ItemBankSdkSessionDead as exc:
                # LANE6-7: sticky, same as lc.SessionDead. SessionDead
                # fires only in launch(), before any provider activity
                # (see ItemBankSdkSessionDead), so it is never an
                # uncertain write: mark the session dead and raise the
                # sticky session-dead error. The op_id stays reusable.
                self._mark_session_dead(exc)
                raise self._dead_exc("Item Banks SDK session died")
            except ibsdk.ItemBankSdkError as exc:
                raise ex.ExecutorError(
                    "Item Banks SDK lane failed (%s); no provider call "
                    "was attempted" % exc)
            except Exception as exc:  # noqa: BLE001 - transport-level failure
                last_exc = exc
                if is_write:
                    if ex._is_write_safe_retry(exc):
                        if attempts < ex.MAX_ATTEMPTS:
                            ex._backoff_sleep(attempts - 1)
                            continue
                        raise ex.WriteNotAttempted(
                            "SDK write transport failed on every attempt "
                            "(%s); the provider never saw the request"
                            % type(exc).__name__)
                    raise ex.UncertainWrite(
                        "SDK write transport failed (%s); effect state "
                        "unknown, not retried" % type(exc).__name__,
                        attempts=attempts,
                        evidence=[{"method": method, "url": path,
                                   "status": "uncertain",
                                   "attempts": attempts,
                                   "detail": type(exc).__name__}])
                else:
                    # LANE2-D1 (parity with dispatch/executor.py): retry ONLY
                    # transport-retryable failures. The old condition OR-ed
                    # `"timed out" not in str(exc).lower()`, which is
                    # inverted: every exception whose message lacked
                    # "timed out" was retried (programming errors, cert
                    # failures, ...). _is_transport_retryable already
                    # covers TimeoutError and the "timed out" substring.
                    if ex._is_transport_retryable(exc):
                        if attempts < ex.MAX_ATTEMPTS:
                            ex._backoff_sleep(attempts - 1)
                            continue
                    raise ex.ExecutorError(
                        "SDK read transport failed: %s" % exc)
            if status in ex.RETRYABLE_STATUSES:
                if is_write:
                    raise ex.UncertainWrite(
                        "SDK write returned HTTP %s; effect state unknown, "
                        "not retried" % status,
                        attempts=attempts,
                        evidence=[{"method": method, "url": path,
                                   "status": status, "attempts": attempts}])
                if attempts < ex.MAX_ATTEMPTS:
                    ex._backoff_sleep(attempts - 1)
                    continue
                raise ex.ProviderHttpError(
                    status, "retryable status persisted after %d attempts"
                    % ex.MAX_ATTEMPTS, body=body_text)
            if 400 <= status < 500:
                if status == 401:
                    # LANE6-5: the captured credential is rejected by the
                    # provider (rotated or expired). Drop it now so the
                    # NEXT call relaunches and recaptures instead of
                    # failing identically on the stale token forever.
                    sdk.drop_credential()
                raise ex.ProviderHttpError(
                    status, "fail fast on 4xx", body=body_text)
            if status == 0 or 300 <= status < 400:
                # W3-P2-19: status 0 (no HTTP response was produced) and
                # 3xx (a redirect fetch did not follow) are never
                # successful API responses. Writes are uncertain (the
                # provider may have seen the request); reads retry a
                # status-0 like a transport failure and fail fast on 3xx.
                if is_write:
                    raise ex.UncertainWrite(
                        "SDK write returned HTTP %s; not a successful API "
                        "response, effect state unknown, not retried"
                        % status,
                        attempts=attempts,
                        evidence=[{"method": method, "url": path,
                                   "status": status,
                                   "attempts": attempts}])
                if status == 0:
                    if attempts < ex.MAX_ATTEMPTS:
                        ex._backoff_sleep(attempts - 1)
                        continue
                    raise ex.ExecutorError(
                        "SDK read produced no HTTP response (status 0) "
                        "after %d attempts" % ex.MAX_ATTEMPTS)
                raise ex.ProviderHttpError(
                    status, "redirect (3xx) is never a successful API "
                    "response; not followed, not retried", body=body_text)
            # LANE6-2: bound the retained response like the Canvas lane
            # does (W2-P2-8). The SDK fetch crosses into Python memory
            # through CDP evaluate, so this is a retention bound rather
            # than a pre-read bound, and it carries the same
            # x-morrow-truncated flag.
            if max_bytes is None:
                max_bytes = ex.DEFAULT_MAX_BYTES
            body_bytes = body_text.encode("utf-8")
            sdk_headers = {"Content-Type": "application/json"}
            if len(body_bytes) > max_bytes:
                body_bytes = body_bytes[:max_bytes]
                sdk_headers["x-morrow-truncated"] = \
                    "body truncated at %s bytes" % max_bytes
            return (status, sdk_headers, body_bytes, attempts)

        if last_exc:
            raise ex.ExecutorError(
                "SDK transport failed after %d attempts: %s"
                % (ex.MAX_ATTEMPTS, last_exc))
        raise ex.ExecutorError("unreachable SDK retry state")

    # -- egress with the executor's retry discipline -----------------------

    # W2-P1-6: Canvas paginates collection endpoints via Link headers.
    # The Chromium lane follows rel="next" up to this many pages per
    # read; when more pages remain the response is marked truncated and
    # the journal records the partial-collection notice loudly instead
    # of silently returning an incomplete list.
    CHROMIUM_MAX_PAGES = 10

    @staticmethod
    def _parse_next_link(link_header):
        """Extract the rel="next" URL from a Link header, or None."""
        if not link_header:
            return None
        for part in str(link_header).split(","):
            segments = part.split(";")
            if len(segments) < 2:
                continue
            url_part = segments[0].strip()
            # Strip quotes anywhere (rel="next" is the standard form;
            # a naive end-strip leaves rel="next behind and never matches).
            rels = [s.strip().lower().replace('"', "").replace("'", "")
                    for s in segments[1:]]
            if "rel=next" in rels:
                m = re.match(r"<([^>]+)>", url_part)
                if m:
                    return m.group(1)
        return None

    def _paginated_get(self, transport, first_path, max_bytes, status,
                       api_headers, body_text, attempts):
        """Follow Canvas Link rel="next" for a GET read (W2-P1-6).

        Merges JSON-array pages into one list. Returns
        (status, headers, raw_bytes, attempts). When the page bound is
        hit with pages still remaining, or a page is not a mergeable
        JSON array, the x-morrow-pagination header says so loudly and
        the journal records it; the read never silently returns a
        partial collection as if it were complete.
        """
        headers = dict(api_headers)
        headers.pop("link", None)
        pages = [body_text]
        page_count = 1
        next_url = self._parse_next_link(api_headers.get("link"))
        truncated = False
        note = None
        # W2-P2-8: bound the aggregate, not just each page. Ten pages at
        # max_bytes each is ten times the per-response bound.
        aggregate_cap = self.CHROMIUM_MAX_PAGES * max_bytes
        aggregate_bytes = len(body_text.encode("utf-8"))
        if api_headers.get("x-morrow-truncated"):
            # The first page itself was cut at max_bytes: merging more
            # pages onto a partial first page would silently corrupt the
            # collection. Stop and say so loudly.
            truncated = True
            note = ("first page truncated at %s bytes; collection is "
                    "partial" % max_bytes)
            next_url = None
        while next_url and page_count < self.CHROMIUM_MAX_PAGES:
            if not lc.is_tenant_url(next_url, self._base):
                # A next-link off the tenant origin is not followed;
                # stop and say so rather than leaking the read.
                truncated = True
                note = ("stopped: next page left the tenant origin "
                        "(%s)" % next_url[:80])
                break
            nparsed = urllib.parse.urlsplit(next_url)
            npath = nparsed.path or "/"
            if nparsed.query:
                npath = npath + "?" + nparsed.query
            attempts += 1
            try:
                nstatus, nheaders, nbody = transport.api(
                    "GET", npath, None, as_json=True,
                    timeout=ex.REQUEST_TIMEOUT_S, max_bytes=max_bytes)
            except lc.SessionDead as exc:
                # W4-P2-2: sticky. A read that died mid-pagination never
                # touches the provider again on this session object.
                self._mark_session_dead(exc)
                raise self._dead_exc("Canvas session died while following "
                                     "pagination")
            except Exception as exc:
                raise ex.ExecutorError(
                    "paginated read failed on page %d: %s"
                    % (page_count + 1, exc))
            if nstatus != 200:
                truncated = True
                note = ("stopped: page %d returned HTTP %s"
                        % (page_count + 1, nstatus))
                break
            if nheaders.get("x-morrow-truncated"):
                truncated = True
                note = ((note or "") + ("; " if note else "") +
                        "page %d truncated at %s bytes; collection is "
                        "partial" % (page_count + 1, max_bytes))
                break
            aggregate_bytes += len(nbody.encode("utf-8"))
            if aggregate_bytes > aggregate_cap:
                truncated = True
                note = ((note or "") + ("; " if note else "") +
                        "aggregate byte cap reached (%s bytes); "
                        "collection is partial" % aggregate_cap)
                break
            pages.append(nbody)
            page_count += 1
            next_url = self._parse_next_link(nheaders.get("link"))
        if next_url and page_count >= self.CHROMIUM_MAX_PAGES:
            truncated = True
            note = ("page bound reached: followed %d pages, more remain; "
                    "collection is partial" % page_count)
        merged = None
        try:
            lists = [json.loads(p) for p in pages]
        except ValueError:
            lists = None
        if lists is not None and all(isinstance(l, list) for l in lists):
            merged = []
            for l in lists:
                merged.extend(l)
        if merged is None and page_count > 1:
            # Pages are not mergeable JSON arrays: keep the first page
            # and say so loudly rather than concatenating blindly.
            truncated = True
            note = (note or "") + ("; " if note else "") + \
                "pages are not JSON arrays; returned first page only"
        raw_text = json.dumps(merged) if merged is not None else pages[0]
        if truncated:
            headers["x-morrow-pagination"] = note or "truncated"
            headers["x-morrow-pagination-partial"] = "true"
            if next_url and lc.is_tenant_url(next_url, self._base):
                nparsed = urllib.parse.urlsplit(next_url)
                headers["x-morrow-next-page"] = (
                    (nparsed.path or "/")
                    + ("?" + nparsed.query if nparsed.query else ""))
        elif page_count > 1:
            headers["x-morrow-pagination"] = (
                "complete: followed %d pages" % page_count)
        return (status, headers, raw_text.encode("utf-8"), attempts)

    def raw_request(self, method: str, url: str, headers: dict, body_bytes,
                    is_write: bool = False, max_bytes: int = None):
        """One provider call through the Chromium tab.

        Returns (status, resp_headers, raw, attempts), mirroring
        executor.request_with_retry exactly, including uncertain-write
        classification. Cross-origin URLs are refused: this lane serves the
        tenant origin only. GET reads follow Canvas Link pagination
        (W2-P1-6); bodies are truncated at max_bytes in page context
        (W2-P2-8); 429s honor Retry-After on reads (W2-P2-7).
        """
        transport = self._ensure_transport()
        base = self._base
        # W2-P0-9: exact-origin check, never a prefix match. The old
        # url.startswith(base) let a sibling host (tenant.evil.com)
        # pass as same-origin as the tenant.
        if not lc.is_tenant_url(url, base):
            host = urllib.parse.urlparse(url).netloc or url
            raise ex.ExecutorError(
                "chromium backend serves the tenant origin only; refusing "
                "cross-origin request to %s" % host)
        parsed = urllib.parse.urlsplit(url)
        path = parsed.path or "/"
        if parsed.query:
            path = path + "?" + parsed.query
        if not (method.upper() == "GET" and not is_write
                and parsed.path == _PRINCIPAL_PATH):
            self._verify_principal(transport, is_write)
        # Item Banks SDK lane: every /api/banks/... path egresses through
        # the quiz-api host with the LTI-provisioned banks.build token,
        # not through the canvas-origin fetch (which 500s/404s there).
        if ibsdk.is_sdk_item_path(path):
            return self._sdk_item_request(method, path, body_bytes,
                                          headers, is_write,
                                          max_bytes=max_bytes)
        data, as_json = _decode_body(body_bytes, headers)
        if max_bytes is None:
            max_bytes = ex.DEFAULT_MAX_BYTES

        attempts = 0
        last_exc = None
        while attempts < ex.MAX_ATTEMPTS:
            attempts += 1
            try:
                status, api_headers, body_text = transport.api(
                    method, path, data, as_json=as_json,
                    timeout=ex.REQUEST_TIMEOUT_S, max_bytes=max_bytes)
                # A completed provider call proves the session was live
                # (W4-P2-4 taxonomy evidence).
                self._had_live_session = True
            except lc.SessionDead as exc:
                # W2-P0-4: a dead session DURING a write is ambiguous --
                # the page may have executed the write before the socket
                # died. Journaled as uncertain, never silently retried.
                # At probe/attach time this never fires (that path raises
                # ChromiumSessionDead from _ensure_transport instead).
                # W4-P2-2: sticky -- mark before raising so a retry of
                # THIS session never touches the provider again.
                self._mark_session_dead(exc)
                if is_write and not isinstance(exc, lc.SessionRejected):
                    raise ex.UncertainWrite(
                        "chromium write hit a dead session (%s); the write "
                        "may have executed before the session died; not "
                        "retried" % self._dead_cause,
                        attempts=attempts,
                        evidence=[{"method": method, "url": path,
                                   "status": "uncertain",
                                   "attempts": attempts,
                                   "detail": "SessionDead mid-write"}])
                raise self._dead_exc("Canvas session died mid-operation")
            except Exception as exc:
                last_exc = exc
                if is_write:
                    # W2-P0-1: writes retry ONLY on transport failures
                    # that prove the request never reached the provider.
                    if ex._is_write_safe_retry(exc):
                        if attempts < ex.MAX_ATTEMPTS:
                            ex._backoff_sleep(attempts - 1)
                            continue
                        raise ex.WriteNotAttempted(
                            "chromium write transport failed on every "
                            "attempt (%s); the provider never saw the "
                            "request" % type(exc).__name__)
                    raise ex.UncertainWrite(
                        "chromium write transport failed (%s); effect "
                        "state unknown, not retried"
                        % type(exc).__name__,
                        attempts=attempts,
                        evidence=[{"method": method, "url": path,
                                   "status": "uncertain",
                                   "attempts": attempts,
                                   "detail": type(exc).__name__}])
                else:
                    # LANE2-D1 (parity with dispatch/executor.py): retry ONLY
                    # transport-retryable failures. The old condition OR-ed
                    # `"timed out" not in str(exc).lower()`, which is
                    # inverted: every exception whose message lacked
                    # "timed out" was retried (programming errors, cert
                    # failures, ...). _is_transport_retryable already
                    # covers TimeoutError and the "timed out" substring.
                    if ex._is_transport_retryable(exc):
                        if attempts < ex.MAX_ATTEMPTS:
                            ex._backoff_sleep(attempts - 1)
                            continue
                    raise ex.ExecutorError("read transport failed: %s" % exc)
            if status in ex.RETRYABLE_STATUSES:
                if is_write:
                    # W2-P0-1: a 429/5xx WITH a response is uncertain for
                    # a write (the provider may have applied it before
                    # answering). The Retry-After value is reported for
                    # reconciliation; it is NOT slept and retried.
                    detail = ("chromium write returned HTTP %s; effect "
                              "state unknown, not retried" % status)
                    if status == 429:
                        delay = ex._retry_after_delay(api_headers)
                        if delay is not None:
                            detail += (" (provider asked to wait %ss "
                                       "before retrying)" % delay)
                    raise ex.UncertainWrite(
                        detail, attempts=attempts,
                        evidence=[{"method": method, "url": path,
                                   "status": status, "attempts": attempts}])
                if attempts < ex.MAX_ATTEMPTS:
                    # W2-P2-7: honor the provider's Retry-After on 429.
                    delay = ex._retry_after_delay(api_headers) \
                        if status == 429 else None
                    if delay is not None:
                        time.sleep(delay)
                    else:
                        ex._backoff_sleep(attempts - 1)
                    continue
                raise ex.ProviderHttpError(
                    status, "retryable status persisted after %d attempts"
                    % ex.MAX_ATTEMPTS, body=body_text)
            if 400 <= status < 500:
                raise ex.ProviderHttpError(
                    status, "fail fast on 4xx", body=body_text)
            resp_headers = {"Content-Type": "application/json"}
            resp_headers.update(api_headers)
            if (not is_write and method.upper() == "GET"
                    and api_headers.get("link")):
                return self._paginated_get(transport, path, max_bytes,
                                           status, resp_headers, body_text,
                                           attempts)
            return (status, resp_headers, body_text.encode("utf-8"),
                    attempts)
        if last_exc:
            raise ex.ExecutorError(
                "transport failed after %d attempts: %s"
                % (ex.MAX_ATTEMPTS, last_exc))
        raise ex.ExecutorError("unreachable retry state")
