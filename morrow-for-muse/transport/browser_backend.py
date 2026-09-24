#!/usr/bin/env python3
"""Browser-lane backend for the Morrow Direct executor.

The educator's authenticated session lives in the managed browser profile,
which this product cannot read by construction. This module plans manifest
and catalog entries into browser-task ops, renders the self-contained task
brief (transport/batch.py), and ingests the task's structured report back
into the executor's governance: frozen plans, write halt, duplicate op-id
protection, verification, journaling, and uncertain-write handling.

Two-phase contract (the browser task runs OUTSIDE this process):

  phase 1 dispatch: dispatch_browser_entry() / dispatch_browser_undo() plan
      the request op(s), render a browser-task brief to a file, and return an
      "awaiting_browser_task" envelope. The orchestrator runs the browser
      task against that brief and saves the report text.
  phase 2 complete: complete_browser_request() re-plans deterministically,
      parses the report, applies result blocks, runs verification (or renders
      a verify-phase brief when verification needs result values), journals,
      and returns the receipt. complete_browser_verify() finishes a deferred
      verify phase.

Capability lanes (classified per request block):

  browser_form        ordinary GET. Form-encoded writes were once routed
                      through Braden's first-party static relay page; that
                      lane was retired 2026-09-21 (page taken down, source
                      removed). Form writes now fail closed with
                      FormTransportUnavailable, mapped to BrowserLaneBlocked
                      by _render_brief_or_blocked. Live writes run through
                      the helper Chromium page context
                      (dispatch/executor.py chromium backend), never here.
  browser_json        a block needing a JSON body or custom headers. BLOCKED:
                      the browser task cannot run page-context fetch, so
                      there is no honest execution primitive yet. Fail closed
                      with BrowserLaneBlocked until one exists.
  token_json_headers  calls needing caller-specified custom headers
                      (e.g. a quiz-API bearer token): planned as page-context
                      fetch ops when the lane can execute them, otherwise
                      BrowserLaneBlocked.

Secret rules: no cookie values, CSRF values, sesskeys, OTPs, PATs, or
provider tokens may appear in a plan, a brief, a pending file, or a report.
Anything that would need one is refused (SecretEgressRefused) before any
browser work is scheduled. The browser task harvests the CSRF field itself,
in-page, and is forbidden from reporting its value.

Session identity: lane state is metadata only (transport/state.py,
~/.morrow/browser_lane.json): base URL, provider, principal id/name, lane
state, verification timestamps. The live session check (users/self with the
pinned principal) runs inside every browser task, first step.

Transport hardening (P0-3/5/6/8/9, from the desktop Morrow analysis):

  P0-3 CSRF: every non-GET fetch op carries X-CSRF-Token (harvested fresh
      from the _csrf_token cookie in page context, per call) plus
      X-Requested-With: XMLHttpRequest. The csrf-token meta tag and
      authenticity_token hidden inputs are never accepted as token sources.
  P0-5 principal: writes require a pinned principal in lane state (fail
      closed at dispatch and at complete); a login redirect during an
      authenticated call maps to session-dead and is never followed;
      re-auth bumps the session generation and stale commands are refused.
  P0-6 outcomes: 408/429/5xx/timeout/transport loss/parse failure ->
      applied_or_unknown (journaled, never replayed, conflict lock held);
      other 4xx -> provider refusal (fail fast, lock released, op reusable).
      Unresolved creates get a parent-collection duplicate review
      (duplicate_effect_suspected deletes nothing); a person can close out
      an uncertain write with a fresh-read digest plus explicit
      confirmation (sends nothing, never reports verified).
  P0-8 verification: only provider readback maps to verified. A write that
      returned 2xx with no readback journals as unconfirmed, never as
      verified. Undo is a new planned and approved corrective operation,
      never an implicit inverse.
  P0-9 text transport: in-page request payloads travel as JSON text and
      are parsed in page context; object injection is refused (Chrome
      drops null-valued properties of injected objects).

Stdlib only.
"""

import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import threading
import time
import urllib.parse
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (_REPO, _HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from dispatch import executor as ex  # noqa: E402
from dispatch.admission import admit  # noqa: E402
from dispatch import admission as _admission  # noqa: E402
# W4-P1-17: single source of truth for the morrow state root.
from config.paths import morrow_home  # noqa: E402
# LANE2-D2: the shared tenant-bound quiz-api host check (the Item Banks
# SDK lane's API origin). The fetch lane reuses it so an absolute fetch
# URL can only aim at the tenant origin or the tenant's own quiz-api
# host, never an arbitrary https host.
from item_bank_sdk import _is_quiz_api_host  # noqa: E402


def _on_browser_session_death(op_id, entry_name, evidence, write_sent=False):
    """W4-P2-1: run the re-auth state machine when the browser lane
    detects session death: impose the write halt, quarantine the op,
    write the educator notification. Called after detection and before
    the BrowserSessionDead raise, so the run stops instead of writing
    through a half-dead session. Best effort: never masks the raise.
    write_sent is True when the write already reached Canvas.
    """
    try:
        from reauth import state_machine as _rsm
    except ImportError:
        return
    detection = {"provider": "browser_lane", "signal": "session_dead",
                 "evidence": str(evidence)[:500]}
    try:
        _rsm.on_expiry_detected(detection)
    except Exception:
        pass
    try:
        _rsm.quarantine_op(op_id, entry_name, str(evidence)[:200],
                           write_sent=write_sent)
    except Exception:
        pass
from privacy import learner_vault as _vault  # noqa: E402
import batch  # noqa: E402
import state  # noqa: E402


# --- Source privacy boundary -------------------------------------------
# Learner-data reads are projected through the faithful port of
# SourceMcpPrivacyBoundary (privacy/boundary.py). The boundary needs a
# verified binding: tenant origin, course id, principal, session
# generation, and a deterministic catalog digest. The roster is harvested
# from the receipt itself (the lane's only roster source) and registered
# before redaction runs; the binding is checked again after the provider
# result is in hand, so a lane that reconnected mid-op fails closed.

SOURCE_VAULT_ENV_VAR = "MORROW_SOURCE_VAULT_PATH"
SOURCE_VAULT_BASENAME = "morrow_source_vault.json"
_COURSE_ID_RE = re.compile(r"/courses/(\d+)", re.IGNORECASE)

# Fields that, together with an "id", mark a bare dict as a learner
# record. Plain "name" is deliberately excluded: assignments, courses,
# sections, and groups all have names; only user objects carry these
# (mirrors the legacy learner_vault.IDENTITY_FIELDS discriminator).
_ROSTER_IDENTITY_FIELDS = frozenset({
    "email", "login_id", "sis_user_id", "sis_login_id",
    "sortable_name", "short_name",
})
_ROSTER_USER_KEYS = frozenset({"user", "student", "author"})
_ROSTER_NAME_KEYS = ("name", "fullname", "display_name", "sortable_name",
                     "short_name")
_ROSTER_PASSTHROUGH_KEYS = ("email", "login_id", "sis_user_id", "sis_login_id",
                            "sortable_name", "short_name", "display_name",
                            "pronouns")


def _source_vault_path():
    """Educator-local source vault file. Labels persist here (0600), so
    Student A<n> labels stay stable across processes for a course scope.
    Tests point MORROW_SOURCE_VAULT_PATH at scratch."""
    override = os.environ.get(SOURCE_VAULT_ENV_VAR)
    if override:
        return override
    # W4-P1-17: single source of truth for the morrow state root.
    return os.path.join(morrow_home(), SOURCE_VAULT_BASENAME)


def _entry_course_id(entry):
    try:
        urls = _admission.extract_urls(entry)
    except Exception:
        urls = []
    for url in urls:
        match = _COURSE_ID_RE.search(url or "")
        if match:
            return match.group(1)
    return None


def _exact_origin(tenant_base):
    parts = urllib.parse.urlsplit(tenant_base or "")
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ex.ExecutorError(
            "learner-data read refused: the tenant base %r is not an exact "
            "http(s) origin, so no privacy binding can be built"
            % (tenant_base,))
    host = parts.hostname
    port = parts.port
    if port and port not in (80, 443):
        host = "%s:%d" % (host, port)
    return "%s://%s" % (parts.scheme, host)


def _harvest_roster(receipt):
    """Recursively harvest learner records from a receipt.

    A dict counts as a learner record when it carries a user_id, or when
    it sits under a user-ish key (user/student/author) or carries one of
    the identity fields and has an id. Records with an id but no name get
    a synthesized "Learner <id>" name: the id itself is still PII and
    must tokenize, and the synthesized name can never leak real PII.
    """
    found = []
    seen = set()

    def learner_id_of(node, in_user_key):
        uid = node.get("user_id")
        if isinstance(uid, (int, str)) and str(uid).strip() != "":
            return str(uid)
        if in_user_key or any(k in node for k in _ROSTER_IDENTITY_FIELDS):
            oid = node.get("id")
            if isinstance(oid, (int, str)) and str(oid).strip() != "":
                return str(oid)
        return None

    def visit(node, in_user_key=False):
        if isinstance(node, dict):
            lid = learner_id_of(node, in_user_key)
            if lid is not None and lid not in seen:
                entry = {"id": node.get("user_id", node.get("id"))}
                name = None
                for key in _ROSTER_NAME_KEYS:
                    value = node.get(key)
                    if isinstance(value, str) and value.strip() != "":
                        name = value
                        break
                entry["name"] = name if name else "Learner %s" % lid
                for key in _ROSTER_PASSTHROUGH_KEYS:
                    value = node.get(key)
                    if isinstance(value, str) and value.strip() != "" \
                            and key not in entry:
                        entry[key] = value
                seen.add(lid)
                found.append(entry)
            for key, value in node.items():
                visit(value, str(key).lower() in _ROSTER_USER_KEYS)
        elif isinstance(node, list):
            for value in node:
                visit(value, in_user_key)

    visit(receipt)
    return found


def _project_learner_result(entry, result, tenant_base, lane_context=None):
    """Project one applied result's receipt through the source privacy
    boundary when the entry touches learner data.

    Single implementation lives in privacy/executor_wire.py (shared with
    the live executor lane); this is a thin delegate so both lanes stay
    in lockstep.
    """
    from privacy import executor_wire as _wire
    return _wire.project_learner_result(
        entry, result, tenant_base, lane_context, error_cls=ex.ExecutorError)


def _project_verification_detail(entry, verification, raw_payload,
                                 tenant_base, lane_context=None):
    """W3-P2-5: project a verify detail through the learner privacy
    boundary before it is journaled.

    The write readback and the declared-verify assertions format raw
    provider values with %r into the detail; on a mismatch those values
    can be learner names or identifiers. Thin delegate to the executor's
    shared helper so both lanes stay in lockstep.
    """
    return ex._project_verification_detail(
        entry, verification, raw_payload, tenant_base, entry.get("name"),
        lane_context=lane_context)


def _admission_hard_checks(entry, params, tenant_base):
    """Re-run the admission gate's non-approval checks.

    Used at complete time: complete can be invoked without a prior dispatch,
    so the hard refusals (never-dispatch, unsupported, evidence-holds,
    learner-data) are enforced again. The per-action write approval was
    enforced at dispatch and is not re-demanded here. No check is
    tenant-dependent: nothing is ever gated by tenant.
    """
    policy = _admission.load_policy()
    _admission.check_never_dispatch(entry, policy)
    _admission.check_unsupported(entry, policy)
    _admission.check_evidence_holds(entry, policy)
    _admission.check_learner_data(entry, policy,
                                  vault_ready=_vault.vault_available())


class BrowserLaneBlocked(ex.ExecutorError):
    """The entry cannot run in the browser form lane (JSON bodies, custom
    headers, discovery pre-pass, chained multi-step)."""


class BrowserSessionDead(ex.ExecutorError):
    """The browser task reported session_dead: no provider call was attempted."""


class BrowserStaleCommand(BrowserSessionDead):
    """A command refused as stale: the lane re-authenticated since dispatch
    (session generation moved), so the command is refused rather than run
    against the new session. The session is NOT dead; it is fresh. Unlike
    genuine session death, this must never arm the re-auth machinery (no
    halt, no "re-sign in" notification): the educator just signed in, and
    the correct recovery is to re-dispatch the op against the fresh
    session."""


class SecretEgressRefused(ex.ExecutorError):
    """A plan would have carried credential material; refused before any
    browser work was scheduled."""


class BrowserOpFailed(ex.ExecutorError):
    """Fail-fast provider rejection (HTTP 4xx) on a browser-lane op. Nothing
    is journaled, so the op_id stays reusable."""


class BrowserCsrfTokenMissing(BrowserOpFailed):
    """LANE2-D4: the browser task refused to send a write because no
    _csrf_token could be harvested from the live document.cookie (the
    brief instructs the task to report CSRF_MISSING instead of sending
    the write unauthenticated). The provider never saw the write, so
    this fails fast like a refusal (nothing journaled, lock released,
    op_id reusable) and is never misdiagnosed as an uncertain write.
    Subclasses BrowserOpFailed so existing fail-fast handling applies,
    while the name stays matchable for the real diagnosis (the helper
    session, not the provider)."""


class BrowserPrincipalChanged(ex.ExecutorError):
    """The signed-in principal does not match the lane's pinned principal.
    Fail closed: nothing is journaled and the op_id stays reusable after
    re-authentication."""


class ConflictLockHeld(ex.ExecutorError):
    """A write with this op_id is in applied_or_unknown state and holds its
    provider-object conflict lock. It must never be replayed or
    re-dispatched until it settles (provider readback or person
    close-out)."""


class BrowserProfileInUse(ex.ExecutorError):
    """A profile-store purge was refused because a Chromium process is
    currently running against that profile. Deleting profile stores
    under a live browser can corrupt the profile: stop the helper (or
    the browser) first, then re-run."""


def default_form_host() -> str:
    """DEPRECATED. The ephemeral loopback form-host server is retired: the
    managed browser VM cannot reach this VM's loopback, and the form lane
    now packs its HTML in the brief (editor chain). Kept so old callers
    fail loudly instead of silently; do not use for new work.
    """
    raise RuntimeError(
        "default_form_host is retired; the form lane packs its HTML in the "
        "brief (see transport.batch.render_form_html)")


def _shutdown_form_host() -> None:
    """No-op. The ephemeral form-host server is retired; nothing to stop."""
    return


# --------------------------------------------------------------------------
# Brief rendering
# --------------------------------------------------------------------------


# form_host is accepted (and ignored) for signature compatibility; the
# form lane is retired (relay page taken down 2026-09-21), so no
# form-host page is ever resolved. _shutdown_form_host() is a no-op
# retained for the same reason. Do not reintroduce a form-host
# dependency.
_MORROW_DIR = morrow_home()
BRIEF_DIR = os.path.join(_MORROW_DIR, "browser-briefs")
PENDING_DIR = os.path.join(_MORROW_DIR, "browser-pending")

# Headers the form lane tolerates as literals. Content-Type is consumed by
# body classification and then dropped (the form host sets its own);
# Accept is harmless to drop (the browser sends its own). Anything else that
# would reach the wire as a header cannot be set by a form post, so the
# entry is blocked rather than silently downgraded.
_BENIGN_HEADERS = {"content-type", "accept"}
# Header names that only ever carry credential material.
_AUTH_HEADER_NAMES = {"authorization", "authtype", "cookie", "x-csrf-token",
                      "x-xsrf-token"}

# LANE2-D10: headers on which a {"transient": ...} (or "transient....")
# reference is refused at fetch-plan time. Resolving a transient-captured
# value here would render it literally into the persisted brief handed to
# the browser-task consumer (and briefs linger on session-dead retry
# paths); for authentication headers that is credential persistence,
# refused like credential/session_value refs. authtype is deliberately
# absent: the scheme marker ("Signature") is not authentication material.
_TRANSIENT_AUTH_REFUSAL = frozenset({
    "authorization", "proxy-authorization", "cookie",
    "x-csrf-token", "x-xsrf-token",
})


# --------------------------------------------------------------------------
# P0-3: CSRF contract. Desktop Morrow reads the _csrf_token cookie fresh in
# page context for EVERY write and sends it as X-CSRF-Token plus
# X-Requested-With: XMLHttpRequest. The csrf-token meta tag and
# authenticity_token hidden inputs are never accepted as token sources
# (the one live-verified working source is the _csrf_token cookie read
# from the live page context). The harvest marker below means exactly
# that: read the cookie fresh, in page, per call. The value never appears
# in a brief, a report, or a log.
# --------------------------------------------------------------------------

CSRF_COOKIE_NAME = "_csrf_token"
CSRF_TOKEN_HEADER = "X-CSRF-Token"
CSRF_XHR_HEADER = "X-Requested-With"
CSRF_XHR_VALUE = "XMLHttpRequest"
# Harvest source name understood by the brief renderer: read
# CSRF_COOKIE_NAME from document.cookie fresh in page context.
CSRF_HARVEST_SOURCE = "csrf_token"

# Exact substrings of the retired meta-tag / hidden-input fallback
# instructions. If any rendered brief still tells the browser task to
# source the token that way, the brief is refused rather than executed.
_RETIRED_CSRF_SOURCE_PHRASES = ("csrf-token <meta", "authenticity_token hidden input")


def csrf_header_contract():
    """The exact per-write header contract (P0-3): the token header whose
    value is harvested fresh in page context, plus the XHR marker header
    as a literal."""
    return {CSRF_TOKEN_HEADER: {"harvest": CSRF_HARVEST_SOURCE},
            CSRF_XHR_HEADER: CSRF_XHR_VALUE}


def _csrf_headers_for_method(method):
    """CSRF headers for one op: the full contract on writes, none on GET."""
    if str(method).upper() == "GET":
        return {}
    return csrf_header_contract()


def _assert_no_csrf_source_fallback(brief_text, batch_id):
    """Refuse a brief that still instructs the meta-tag or hidden-input
    token source (P0-3). Fail closed: a brief teaching the wrong harvest
    must never reach a browser task."""
    lowered = (brief_text or "").lower()
    for phrase in _RETIRED_CSRF_SOURCE_PHRASES:
        if phrase in lowered:
            raise BrowserLaneBlocked(
                "batch %r brief still instructs the retired CSRF source %r; "
                "the token must be read fresh from the %s cookie in page "
                "context" % (batch_id, phrase, CSRF_COOKIE_NAME))


# --------------------------------------------------------------------------
# Planning: entry block -> browser op
# --------------------------------------------------------------------------

def _scalar(value):
    # Booleans render 'true'/'false': Canvas boolean casting treats the
    # string 'False' as true, so str(value) would silently flip booleans.
    return batch.form_scalar(value)


def _flatten_fields(body):
    """Flatten a body dict into form fields with Canvas bracket names.

    {"assignment": {"name": "X"}} -> {"assignment[name]": "X"}.
    Lists stay lists (rendered as repeated inputs with the same name, so the
    key must already be in array form, e.g. "ids[]"). None values are
    dropped, mirroring the https backend.
    """
    fields = {}

    def rec(obj, prefix):
        if isinstance(obj, dict):
            for k, v in obj.items():
                key = "%s[%s]" % (prefix, k) if prefix else str(k)
                rec(v, key)
        elif isinstance(obj, list):
            vals = []
            for x in obj:
                if isinstance(x, (dict, list)):
                    raise BrowserLaneBlocked(
                        "nested structures inside a field list are not "
                        "representable as form fields")
                if x is None:
                    continue
                vals.append(_scalar(x))
            if vals:
                fields[prefix] = vals
        elif obj is None:
            return
        else:
            fields[prefix] = _scalar(obj)

    rec(body, "")
    return fields


def _classify_headers(entry, headers_spec, params, result_payload, transients):
    """Decide what the block's headers mean for the browser form lane.

    Returns None; raises SecretEgressRefused when a header would carry
    credential material, BrowserLaneBlocked when a header needs a wire
    capability the form lane does not have.
    """
    spec = headers_spec or {}
    name = entry.get("name")
    for hname, hval in spec.items():
        lname = str(hname).lower()
        if isinstance(hval, dict) and ("credential" in hval or "session_value" in hval):
            raise SecretEgressRefused(
                "entry %r header %r references credential material; the "
                "browser lane never carries secrets" % (name, hname))
        if isinstance(hval, dict) and "transient" in hval:
            raise BrowserLaneBlocked(
                "entry %r header %r needs a transient value; the browser form "
                "lane cannot set custom headers (pending page-context fetch "
                "primitive)" % (name, hname))
        if lname in _AUTH_HEADER_NAMES:
            raise BrowserLaneBlocked(
                "entry %r header %r is an auth header; the browser form lane "
                "cannot set auth headers (pending page-context fetch "
                "primitive)" % (name, hname))
        if lname not in _BENIGN_HEADERS:
            raise BrowserLaneBlocked(
                "entry %r header %r is a custom header; the browser form lane "
                "sends form-encoded bodies only and cannot set it (pending "
                "page-context fetch primitive)" % (name, hname))
    return None


def _classify_body(entry, block, params, result_payload, transients):
    """Return the form fields for a block, or raise when the body needs a
    capability the browser form lane does not have (JSON encoding)."""
    name = entry.get("name")
    body = ex.resolve_ref(block.get("body"), params, result_payload, transients)
    if body is None:
        return {}
    ctype = None
    for k, v in (block.get("headers") or {}).items():
        if str(k).lower() == "content-type" and not isinstance(v, dict):
            ctype = str(ex.resolve_ref(v, params, result_payload, transients)).lower()
    hint = (entry.get("transport") or {}).get("browser_encoding")
    if hint == "json" or (ctype and "application/json" in ctype):
        raise BrowserLaneBlocked(
            "entry %r requires a JSON body; the browser-task form lane sends "
            "form-encoded bodies only (pending page-context fetch primitive)"
            % name)
    if isinstance(body, dict):
        return _flatten_fields(body)
    raise BrowserLaneBlocked(
        "entry %r has a non-object body; the browser form lane only sends "
        "form fields" % name)


def _effective_port(parts):
    """The URL's effective https port (explicit, else 443). None when the
    port is malformed: the caller fails closed."""
    try:
        return parts.port or 443
    except ValueError:
        return None


def _has_userinfo(parts):
    """True when a parsed URL carries userinfo (user or password).

    Userinfo in a planned browser URL fails closed everywhere it is
    checked: it is credential material that would land in the brief, and
    hostname-only origin comparisons would otherwise accept
    https://user@legit-host/ as the legitimate host.
    """
    try:
        return bool(parts.username or parts.password)
    except ValueError:
        # Malformed userinfo: fail closed by treating it as present.
        return True


def _same_https_origin(parts, base_parts):
    """True when both parsed URLs share the https scheme, the same
    lowercase host, and the same effective port (explicit or 443).
    LANE2-D2: exact normalized-origin comparison, replacing the old
    startswith() prefix check (which let double-slash paths through
    and rejected case-variant hosts though hostnames are
    case-insensitive)."""
    if parts.scheme != "https" or base_parts.scheme != "https":
        return False
    host = (parts.hostname or "").lower()
    bhost = (base_parts.hostname or "").lower()
    if not host or host != bhost:
        return False
    port = _effective_port(parts)
    bport = _effective_port(base_parts)
    return port is not None and port == bport


def _split_op_url(url, base):
    """Return the path+query of a tenant-absolute URL, fail-closed.

    Both sides are parsed and the origin must match exactly: https
    scheme, same lowercase host, same effective port. A path starting
    with "//" is refused (scheme-relative confusion vector), as is any
    non-absolute URL or any URL carrying userinfo (credential material
    that hostname-only comparison would otherwise accept on the
    legitimate host).
    """
    parts = urllib.parse.urlsplit(url)
    bparts = urllib.parse.urlsplit(base or "")
    if parts.scheme != "https" or not parts.hostname:
        raise BrowserLaneBlocked(
            "planned URL %r is not an absolute https URL; refusing to aim "
            "a browser task at it" % (url,))
    if _has_userinfo(parts):
        raise BrowserLaneBlocked(
            "planned URL %r carries userinfo; refusing to aim a browser "
            "task at it" % (url,))
    if not _same_https_origin(parts, bparts):
        raise BrowserLaneBlocked(
            "planned URL %r is outside the tenant origin %r; refusing to "
            "aim a browser task at it" % (url, base))
    path = parts.path or "/"
    if path.startswith("//"):
        raise BrowserLaneBlocked(
            "planned URL %r has a scheme-relative path; refusing to aim "
            "a browser task at it" % (url,))
    return path + ("?" + parts.query if parts.query else "")


_URL_TOKEN = re.compile(r"\{([^{}]+)\}")


def _render_url(template, config, params, result_payload, transients):
    """Render a URL template with result/transient support.

    The shared render_template only resolves config and params.* tokens.
    The browser lane additionally resolves {result.<path>} against the
    result payload and {transient.<name>} against captured transients, so
    verify and undo blocks can address created objects. Error messages keep
    the substrings _plan_all matches to decide deferral ("has no result
    payload yet", "was never captured", "has no value").
    """
    def repl(match):
        token = match.group(1)
        if token.startswith("result."):
            if result_payload is None:
                raise ex.ExecutorError(
                    "template slot {%s} has no result payload yet" % token)
            value = ex.resolve_path(result_payload, token[len("result."):])
            if value is None:
                raise ex.ExecutorError(
                    "template slot {%s} has no value" % token)
            return str(value)
        if token.startswith("transient."):
            key = token[len("transient."):]
            if not transients or key not in transients:
                raise ex.ExecutorError(
                    "transient value %r was never captured" % key)
            return str(transients[key])
        return match.group(0)  # config/params token: render_template handles it

    staged = _URL_TOKEN.sub(repl, template)
    return ex.render_template(staged, config, params, result_payload, transients)


# --------------------------------------------------------------------------
# P0-9: in-page payloads travel as text, never as objects. Chrome's
# scripting.executeScript silently drops null-valued properties of object
# arguments, so any request carrying a null would reach the provider with
# fields missing. Every injection site serializes to canonical JSON text;
# the page parses it with JSON.parse in its own context.
# --------------------------------------------------------------------------

def serialize_inpage_payload(payload):
    """Serialize an in-page request payload to canonical JSON text.

    Asserts the null round-trip: nulls survive serialization byte-stable,
    so a payload the reviewer approved is the payload the page parses.
    """
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, default=str)
    _assert_null_round_trip(payload, text)
    return text


def _assert_null_round_trip(payload, text):
    """Fail closed unless the JSON text round-trips byte-stable with every
    null preserved. Raises BrowserLaneBlocked on any loss.

    Exact structural check: parsing the text must give back the payload
    value-for-value (a dropped null would compare unequal), and
    re-serializing the parsed value must reproduce the exact same bytes
    (proving the text on the wire is the canonical form, byte-stable).
    """
    try:
        back = json.loads(text)
    except ValueError as exc:
        raise BrowserLaneBlocked(
            "in-page payload is not valid JSON text: %s" % exc)
    if back != payload:
        raise BrowserLaneBlocked(
            "in-page payload did not survive JSON text serialization; "
            "refusing to inject a mutated request")
    if serialize_canonical(back) != text:
        raise BrowserLaneBlocked(
            "in-page payload serialization is not byte-stable; refusing to "
            "inject")


def serialize_canonical(payload):
    """Canonical JSON text form (no round-trip assertion; for comparisons)."""
    return json.dumps(payload, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, default=str)


def _assert_text_payload(value, what):
    """Refuse a non-text payload at an injection site (P0-9)."""
    if isinstance(value, (dict, list)):
        raise BrowserLaneBlocked(
            "%s must travel as JSON text for page-context injection; "
            "object injection silently drops null-valued properties" % what)
    return value


def _needs_fetch(entry, block):
    """Check if a block requires the page-context fetch primitive.

    Returns True when the block's headers include auth headers, custom
    headers, or transient references, which the form lane cannot send.
    An explicit "fetch": true on the block pins it to the fetch lane
    (used for JSON-body writes and any op the manifest author wants off
    the form lane).

    P0-3: every non-GET Canvas op routes to fetch. The HTML form lane
    cannot set X-CSRF-Token and X-Requested-With, so the exact CSRF
    header contract (fresh _csrf_token from document.cookie per call)
    is only enforceable through page-context fetch. Moodle GETs keep the
    legacy classification.
    """
    provider = (entry.get("provider") or "canvas").lower()
    method = str(block.get("method", "GET")).upper()
    if provider == "canvas" and method != "GET":
        return True
    if block.get("fetch") is True:
        return True
    headers_spec = block.get("headers") or {}
    for hname, hval in headers_spec.items():
        lname = str(hname).lower()
        if isinstance(hval, dict) and ("transient" in hval):
            return True
        if lname in _AUTH_HEADER_NAMES:
            return True
        if lname not in _BENIGN_HEADERS:
            return True
    return False


def _transient_ref_name(hval):
    """The transient name referenced by a header value, or None.

    Both manifest spellings resolve through ex.resolve_ref: the dict
    form {"transient": name} and the string form "transient.name".
    """
    if isinstance(hval, dict) and "transient" in hval:
        return hval.get("transient")
    if isinstance(hval, str) and hval.startswith("transient."):
        return hval[len("transient."):]
    return None


def _resolve_transient_header(hval, transients, entry_name, hname):
    """Resolve a {"transient": name} header value to the captured value."""
    tname = hval.get("transient")
    if not tname or tname not in transients:
        raise ex.ExecutorError(
            "entry %r header %r needs transient %r which was never captured"
            % (entry_name, hname, tname))
    return str(transients[tname])


def _confine_fetch_url(url, canvas_base):
    """Fail closed unless an absolute fetch URL stays on the tenant origin
    or the tenant-bound quiz-api host (LANE2-D2).

    The fetch lane renders the op URL verbatim into the browser-task brief
    and the op may carry literal header values, so an unconstrained
    absolute URL would let a manifest aim a page-context fetch() at an
    arbitrary host. Relative URLs are resolved
    against canvas_base by the caller and need no check here. Userinfo,
    scheme-relative ("//") paths, and non-443/malformed quiz-api ports are
    refused outright.
    """
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        raise BrowserLaneBlocked(
            "fetch op URL %r is not an absolute https URL; refusing to aim "
            "a browser task at it" % (url,))
    if _has_userinfo(parts):
        raise BrowserLaneBlocked(
            "fetch op URL %r carries userinfo; refusing to aim a browser "
            "task at it" % (url,))
    if (parts.path or "").startswith("//"):
        raise BrowserLaneBlocked(
            "fetch op URL %r has a scheme-relative path; refusing to aim "
            "a browser task at it" % (url,))
    tparts = urllib.parse.urlsplit(canvas_base or "")
    if _same_https_origin(parts, tparts):
        return
    # The tenant's own quiz-api host
    # (<first-label>.quiz-api[-<region>].instructure.com): the Item Banks
    # SDK lane's API origin. Tenant binding is mandatory:
    # without it any quiz-api-shaped host (including an attacker's) would
    # pass the structural check, so a missing tenant base fails closed.
    thost = (tparts.hostname or "").lower()
    if thost and _is_quiz_api_host(parts.hostname.lower(), thost):
        # LANE2-D11: _is_quiz_api_host checks only the hostname. Pin the
        # effective port to 443 (the derived quiz-api origin never carries
        # a port) and refuse malformed ports here.
        if _effective_port(parts) != 443:
            raise BrowserLaneBlocked(
                "fetch op URL %r targets the tenant quiz-api host on a "
                "non-443 or malformed port; refusing to aim a browser "
                "task at it" % (url,))
        return
    raise BrowserLaneBlocked(
        "fetch op URL %r escapes the tenant origin %r (and is not the "
        "tenant's quiz-api host); refusing to aim a browser task at it"
        % (url, canvas_base))


def _plan_fetch_block(entry, block, params, config, transients, op_id,
                      result_payload=None):
    """Plan a page-context fetch op for blocks needing custom headers.

    The fetch op runs fetch() in the page context of a Canvas page with
    caller-specified headers. Authentication material is never rendered
    into the persisted brief: {"transient": ...} / "transient...." refs on
    authentication headers (Authorization, Cookie, CSRF tokens, ...) raise
    SecretEgressRefused at plan time (LANE2-D10), like credential and
    session_value refs, and literal values on those headers are refused
    the same way. Page-collectible secrets use the harvest mechanism
    (read live in page context, never in the brief); provisioned API tokens
    travel via the ItemBankSdk lane (memory-only). The task is instructed
    never to report header values.
    """
    name = entry.get("name")
    method = str(block.get("method", "GET")).upper()
    if method not in ("GET", "POST", "PUT", "PATCH", "DELETE"):
        raise BrowserLaneBlocked(
            "entry %r uses HTTP %s; the fetch lane supports GET/POST/PUT/PATCH/DELETE"
            % (name, method))
    # URL: absolute https:// allowed only for the tenant origin or the
    # tenant-bound quiz-api host (LANE2-D2 confinement); relative resolved
    # against canvas_base.
    raw_url = block.get("url", "")
    if raw_url.startswith("https://"):
        # Absolute URL; render template slots (transients, params).
        url = ex.render_template(raw_url, config, params, result_payload,
                                 transients)
        _confine_fetch_url(url, config.get("canvas_base", ""))
    else:
        url = _render_url(raw_url, config, params, result_payload,
                          transients)
        if url.startswith("/"):
            base = config.get("canvas_base", "").rstrip("/")
            url = base + url
    # New Quiz write contract (P0-2, P0-7): same refusal set as the https
    # lane, enforced at plan time.
    ex.guard_new_quiz_request(entry, method, url, params)
    # Headers: resolve transient refs and other references.
    headers_spec = block.get("headers") or {}
    headers = {}
    for hname, hval in headers_spec.items():
        tref = _transient_ref_name(hval)
        if tref is not None:
            # LANE2-D10: a transient-captured value is never resolved
            # into literal brief text for an authentication header. The
            # brief is persisted (0600) and handed to the browser-task
            # consumer, and briefs linger on session-dead retry paths; a
            # bearer token rendered there is persisted authentication
            # material. Fail closed like credential/session_value refs.
            # Non-auth transient refs (captured ids, hosts) still resolve.
            # Provisioned API tokens travel via the ItemBankSdk lane
            # (memory-only, never persisted) or the harvest mechanism.
            if str(hname).lower() in _TRANSIENT_AUTH_REFUSAL:
                raise SecretEgressRefused(
                    "entry %r header %r references transient %r: "
                    "transient-captured values are never rendered into "
                    "brief text for authentication headers" % (name, hname, tref))
            headers[str(hname)] = _resolve_transient_header(
                {"transient": tref}, transients, name, hname)
        elif isinstance(hval, dict) and "harvest" in hval:
            # Page-harvested header: the browser task reads the value from
            # the live page (e.g. the CSRF token) and uses it in fetch().
            # The value never appears in the brief, report, or logs.
            source = hval.get("harvest")
            if source not in ("csrf_token",):
                raise BrowserLaneBlocked(
                    "entry %r header %r requests unsupported harvest source %r"
                    % (name, hname, source))
            headers[str(hname)] = {"harvest": source}
        elif isinstance(hval, dict) and ("credential" in hval or "session_value" in hval):
            raise SecretEgressRefused(
                "entry %r header %r references credential material; the "
                "browser lane never carries secrets" % (name, hname))
        else:
            # LANE2-D10: a literal authentication header would persist
            # credential material in the brief. The transient/credential/
            # session_value/harvest forms are handled above; anything
            # reaching here with an auth name is a literal value.
            if str(hname).lower() in _TRANSIENT_AUTH_REFUSAL:
                raise SecretEgressRefused(
                    "entry %r header %r is an authentication header with a "
                    "literal value; authentication material is never "
                    "rendered into the persisted brief" % (name, hname))
            resolved = ex.resolve_ref(hval, params, None, transients)
            headers[str(hname)] = str(resolved) if resolved is not None else ""
    # Body: resolve and serialize as TEXT (P0-9). The page parses the JSON
    # text in its own context; object injection would silently drop
    # null-valued properties.
    body_spec = block.get("body")
    body = None
    if body_spec is not None:
        resolved_body = ex.resolve_ref(body_spec, params, None, transients)
        if isinstance(resolved_body, (dict, list)):
            body = serialize_inpage_payload(resolved_body)
        elif resolved_body is not None:
            body = _assert_text_payload(str(resolved_body), "fetch op body")
    # P0-3: every non-GET fetch op carries the exact CSRF header contract.
    # The token header is harvested fresh from the _csrf_token cookie in
    # page context, per call; the XHR marker is a literal. Manifests that
    # already pin these headers keep their values.
    if method != "GET":
        present = {str(k).lower() for k in headers}
        for hk, hv in csrf_header_contract().items():
            if hk.lower() not in present:
                headers[hk] = hv
    # W5-P2-2: structural header validation at plan time (mirrors
    # build_headers on the HTTPS lane). Harvest placeholders carry no
    # value yet; the name is validated, the value at fill time.
    for _hn, _hv in headers.items():
        if isinstance(_hv, dict):
            ex.validate_http_header(_hn, "", where="browser fetch plan")
        else:
            ex.validate_http_header(_hn, _hv, where="browser fetch plan")
    _assert_text_payload(body, "fetch op body")
    return {"op_id": op_id, "kind": "fetch", "method": method, "url": url,
            "headers": headers, "body": body}


def _plan_block(entry, block, params, config, transients, result_payload, op_id):
    """Plan one request-shaped block into a single browser op.

    Raises BrowserLaneBlocked / SecretEgressRefused / LocalProcedureRefused.
    """
    name = entry.get("name")
    # Fetch lane: blocks needing custom/auth/transient headers go through
    # the page-context fetch primitive, not the form lane.
    if _needs_fetch(entry, block):
        return _plan_fetch_block(entry, block, params, config, transients,
                                 op_id, result_payload)
    method = str(block.get("method", "GET")).upper()
    if method == "LOCAL" or str(block.get("url", "")).startswith("local://"):
        raise ex.LocalProcedureRefused(
            "entry %r block is a VM-local procedure; the browser lane does "
            "not run it" % name)
    if method not in ("GET", "POST", "PUT", "PATCH", "DELETE"):
        raise BrowserLaneBlocked(
            "entry %r uses HTTP %s; the browser form lane supports "
            "GET/POST/PUT/PATCH/DELETE" % (name, method))
    if not block.get("url"):
        raise ex.UnsupportedEntry("entry %r block has no url" % name)
    url = _render_url(block["url"], config, params, result_payload, transients)
    # Query encoding mirrors the https backend (pairs, None dropped).
    query_spec = ex.resolve_ref(block.get("query") or {}, params,
                                result_payload, transients)
    pairs = []
    for key, value in query_spec.items():
        if value is None:
            continue
        if isinstance(value, list):
            for item in value:
                pairs.append((str(key), str(item)))
        else:
            pairs.append((str(key), str(value)))
    if pairs:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(pairs)
    # New Quiz write contract (P0-2, P0-7): same refusal set as the https
    # lane, enforced at plan time.
    ex.guard_new_quiz_request(entry, method, url, params)
    path = _split_op_url(url, config.get("canvas_base", ""))
    _classify_headers(entry, block.get("headers"), params, result_payload, transients)
    fields = _classify_body(entry, block, params, result_payload, transients)
    return {"op_id": op_id, "method": method, "path": path, "fields": fields}


def _plan_all(entry, params, config, op_id, result_payload=None):
    """Plan every browser op for one phase.

    Returns (items, defer_verify) where items is a list of
    (kind, op, block) with kind in {"request", "step", "verify"}.
    defer_verify is True when the verify block references result values and
    must run as its own phase after the request report is ingested.
    """
    name = entry.get("name")
    items = []
    if entry.get("discovery"):
        raise BrowserLaneBlocked(
            "entry %r uses a discovery pre-pass; the browser lane v1 does "
            "not chain a discovery round trip (run discovery as its own "
            "phase first)" % name)
    if entry.get("multi_step"):
        for i, step in enumerate(entry["multi_step"]):
            try:
                op = _plan_block(entry, step, params, config, {}, None,
                                 "%s-s%d" % (op_id, i))
            except ex.ExecutorError as exc:
                msg = str(exc)
                if ("was never captured" in msg or "has no result payload yet" in msg
                        or "has no value" in msg):
                    raise BrowserLaneBlocked(
                        "entry %r step %d depends on a previous step's "
                        "result; the browser lane v1 does not chain "
                        "multi-step round trips" % (name, i))
                raise
            items.append(("step", op, step))
    else:
        block = entry.get("request")
        if not block:
            raise ex.UnsupportedEntry(
                "entry %r has neither request nor multi_step" % name)
        items.append(("request", _plan_block(entry, block, params, config, {},
                                             None, op_id), block))
    defer_verify = False
    verify = entry.get("verify") if entry.get("effects", "read") == "write" else None
    if verify:
        try:
            vop = _plan_block(entry, verify, params, config, {}, result_payload,
                              op_id + "-verify")
            items.append(("verify", vop, verify))
        except ex.ExecutorError as exc:
            msg = str(exc)
            if "was never captured" in msg:
                raise BrowserLaneBlocked(
                    "entry %r verify block references an uncaptured "
                    "transient; the browser lane v1 cannot satisfy it" % name)
            if "has no result payload yet" in msg or "has no value" in msg:
                defer_verify = True
            else:
                raise
    return items, defer_verify


# --------------------------------------------------------------------------
# Lane state (metadata only) and file helpers
# --------------------------------------------------------------------------

def _lane_for(provider, lane_state):
    if provider != "canvas":
        raise BrowserLaneBlocked(
            "browser lane v1 serves canvas only, not %r" % provider)
    lane = (lane_state or {}).get("canvas") or {}
    base = (lane.get("base") or "").rstrip("/")
    if not base:
        raise BrowserLaneBlocked(
            "no browser lane state for canvas; onboard the educator's "
            "browser session before dispatching")
    return lane, base, lane.get("principal")


# --------------------------------------------------------------------------
# P0-5: principal verification and session generation. Desktop Morrow
# verifies the signed-in principal before writes and re-checks at guarded
# write stages; a mismatch fails closed. The in-page enforcement is the
# brief's session check (users/self against the pinned principal, with a
# mismatch reporting session_dead). This layer enforces the same rule at
# the phase boundaries it controls: dispatch and complete both refuse a
# write with no pinned principal, and an explicit principal attestation in
# a report that names the wrong id fails closed.
#
# Session generation: re-authentication bumps the generation (the
# orchestrator persists it via transport/state.py). A complete phase
# whose lane generation no longer matches the dispatch generation refuses
# the stale command instead of executing it against a new session.
# --------------------------------------------------------------------------

def _require_principal_for_write(entry, principal, phase):
    """Fail closed when a write has no pinned principal to verify against."""
    if entry.get("effects", "read") != "write":
        return
    pid = principal.get("id") if isinstance(principal, dict) else None
    if pid is None:
        raise BrowserLaneBlocked(
            "entry %r is a write but the lane has no pinned principal; "
            "refusing %s without principal verification"
            % (entry.get("name"), phase))


def _recheck_pinned_principal(pinned, current, op_id, phase):
    """P0-5: the complete phase runs only against the dispatch-time pinned
    principal. If the lane principal changed since dispatch (a different
    educator signed in), fail closed rather than run a write against the
    wrong identity."""
    if not isinstance(pinned, dict) or pinned.get("id") is None:
        return
    if not isinstance(current, dict) or current.get("id") is None:
        return
    if str(current["id"]) != str(pinned["id"]):
        raise BrowserPrincipalChanged(
            "op %s: lane principal is now %r but dispatch pinned %r; "
            "the educator changed since dispatch, refusing %s"
            % (op_id, current.get("id"), pinned.get("id"), phase))


_PRINCIPAL_ATTEST_RE = re.compile(r"^principal_ok\s+(\S+)\s*$",
                                  re.MULTILINE | re.IGNORECASE)


def check_principal_attestation(report_text, principal):
    """Fail closed on a principal attestation that names the wrong id.

    The brief's session check is the in-page enforcement; this is the
    report-side backstop for briefs that ask the task to attest the
    checked principal id explicitly. No attestation line means the
    session check alone applied; a mismatched one is a hard failure.
    """
    if not isinstance(principal, dict) or principal.get("id") is None:
        return
    match = _PRINCIPAL_ATTEST_RE.search(report_text or "")
    if not match:
        return
    if str(match.group(1)) != str(principal["id"]):
        raise BrowserPrincipalChanged(
            "report attests principal id %r but the lane is pinned to %r; "
            "failing closed" % (match.group(1), principal["id"]))


def next_session_generation(lane_state, provider="canvas"):
    """The generation the lane moves to on re-authentication.

    The orchestrator calls this when the educator re-authenticates and
    persists the result in lane state (transport/state.py). Complete
    phases compare against the dispatch generation and refuse stale
    commands.
    """
    lane = (lane_state or {}).get(provider) or {}
    try:
        current = int(lane.get("session_generation", 0) or 0)
    except (TypeError, ValueError):
        current = 0
    return current + 1


def _lane_generation(lane_state, provider="canvas"):
    lane = (lane_state or {}).get(provider) or {}
    try:
        return int(lane.get("session_generation", 0) or 0)
    except (TypeError, ValueError):
        return 0


def _check_session_generation(expected, lane_state, provider, op_id, phase):
    """Refuse a stale command: the lane reconnected since dispatch."""
    if expected is None:
        return
    current = _lane_generation(lane_state, provider)
    if current != int(expected):
        # W4-P2-1: a stale command is NOT session death. The session is
        # fresh (the educator re-authenticated); only the command is
        # stale. Raise the distinct subclass so the executor releases the
        # claim without arming the re-auth machinery.
        raise BrowserStaleCommand(
            "op %s: lane session generation moved %s -> %s since dispatch "
            "(%s phase); the educator re-authenticated, so this stale "
            "command is refused rather than run against the new session. "
            "No provider call was attempted; the op_id stays reusable. "
            "Remedy: re-dispatch the op against the fresh session."
            % (op_id, expected, current, phase))


def _ensure_dir(path):
    # makedirs(mode=) only applies at creation; a pre-existing loose
    # directory is tightened rather than trusted as-is.
    os.makedirs(path, mode=0o700, exist_ok=True)
    try:
        if stat.S_IMODE(os.stat(path).st_mode) != 0o700:
            os.chmod(path, 0o700)
    except OSError:
        pass


def _open_secret_tmp(tmp_path):
    """W6-P2-2: open a staging file for secret bytes, 0600 ATOMICALLY.

    Mirrors dispatch/executor._open_secret_tmp: os.open with an explicit
    0o600 mode never creates the file group/other-readable, closing the
    transient-0644 window of the old open-then-chmod pattern. O_EXCL
    keeps concurrent writers off one staging path; a stale tmp from a
    crashed pid-reuse is unlinked and retried once."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    try:
        return os.open(tmp_path, flags, 0o600)
    except FileExistsError:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        return os.open(tmp_path, flags, 0o600)


def _write_secret_file(path, text):
    _ensure_dir(os.path.dirname(path))
    # W5-P2-2: pid+thread-unique tmp name. The old fixed `path + ".new"`
    # was shared by concurrent writers of the same path (two completes
    # for one op_id): one process's open("w") truncated the other's
    # in-progress bytes, or one os.replace stole the tmp out from under
    # the other (FileNotFoundError). LANE2-D12: pid alone is not enough:
    # two threads of one process share a pid, and the O_EXCL retry in
    # _open_secret_tmp treats the other thread's live tmp as a stale
    # crash leftover, unlinks it, and the first thread's os.replace then
    # crashes. Thread identity keeps each writer's staging private;
    # os.replace keeps the swap atomic.
    tmp = "%s.new.%d.%d" % (path, os.getpid(), threading.get_ident())
    # W6-P2-2: 0600 at open, never open-then-chmod.
    fd = _open_secret_tmp(tmp)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)
    return path


def _checked_op_id(op_id) -> str:
    """W5-P2-1: op_ids interpolated into brief/pending filenames must be
    UUIDs; anything else fails closed here instead of becoming a path
    traversal primitive."""
    try:
        return ex.check_uuid(op_id)
    except ValueError:
        raise ex.ExecutorError(
            "refusing op_id %r: not a valid UUID" % (op_id,))


_BRIEF_PHASE_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")


def _brief_path(brief_dir, op_id, phase):
    op_id = _checked_op_id(op_id)
    phase = str(phase or "")
    if not _BRIEF_PHASE_RE.match(phase):
        raise ex.ExecutorError("refusing brief phase %r" % (phase,))
    return os.path.join(brief_dir or BRIEF_DIR, "%s-%s.txt" % (op_id, phase))


def _pending_path(pending_dir, op_id):
    op_id = _checked_op_id(op_id)
    return os.path.join(pending_dir or PENDING_DIR, "%s.json" % op_id)


# --------------------------------------------------------------------------
# P0-6: provider-object conflict locks. An uncertain (applied_or_unknown)
# write keeps its lock until it settles by provider readback or person
# close-out; the lock is what makes "never replay an uncertain write"
# enforceable at dispatch. A provider refusal (other 4xx) proves nothing
# was sent, so the lock is released and the op_id stays reusable.
# Locks are 0600 JSON, keyed by op_id, and go stale after
# PENDING_TTL_DAYS (the sweeper is the backstop for crashed dispatches).
# --------------------------------------------------------------------------

PENDING_TTL_DAYS = 7


def _locks_path(pending_dir):
    return os.path.join(pending_dir or PENDING_DIR, "conflict-locks.json")


def _locks_flock_path(pending_dir):
    return os.path.join(pending_dir or PENDING_DIR,
                        "conflict-locks.json.lock")


@contextmanager
def _locks_locked(pending_dir):
    """W5-P1-1: exclusive flock across every conflict-lock
    read-modify-write. Without it, two concurrent dispatches interleave
    load/mutate/save and the last writer silently discards the other's
    lock record (the P0-6 never-replay guard), or they share one tmp
    path and one crashes with FileNotFoundError. The lock file is
    separate from the data file so the data file stays a plain atomic
    rename target. Never nested: flock EX on a second open() in the
    same process blocks, so locked sections call only the _unlocked
    helpers below."""
    path = _locks_flock_path(pending_dir)
    _ensure_dir(os.path.dirname(path))
    with open(path, "a+", encoding="utf-8") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def _load_locks(pending_dir):
    # Unlocked read: _save_locks swaps the file atomically via
    # os.replace, so readers never see a torn write. Mutating callers
    # must hold _locks_locked().
    path = _locks_path(pending_dir)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_locks(pending_dir, locks):
    # Unlocked write: mutating callers must hold _locks_locked().
    path = _locks_path(pending_dir)
    _ensure_dir(os.path.dirname(path))
    # W5-P2-2: pid-unique tmp name (same rationale as
    # _write_secret_file: the old fixed `path + ".new"` let two
    # concurrent savers share one staging file).
    tmp = "%s.new.%d" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(locks, fh, indent=2, sort_keys=True)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _lock_held_unlocked(op_id, locks):
    """Freshness check against an already-loaded locks dict (call with
    _locks_locked held).

    W6-P2-3: wall-clock jumps must not age out conflict locks. A lock
    dated in the future (clock rolled back) is treated as fresh. When
    a monotonic creation mark is available and says the lock is fresh
    while the wall clock says it is stale, the wall clock jumped
    forward: trust monotonic and keep the lock (fail-safe for the
    never-replay guard)."""
    rec = locks.get(op_id)
    if not rec:
        return False
    now = time.time()
    try:
        created = float(rec.get("created_at_ts", 0))
    except (TypeError, ValueError):
        return True
    if created > now:
        return True
    try:
        created_mono = float(rec.get("created_mono", 0) or 0)
    except (TypeError, ValueError):
        created_mono = 0
    if created_mono > 0:
        mono_age = time.monotonic() - created_mono
        if 0 <= mono_age < PENDING_TTL_DAYS * 86400:
            return True
    return (now - created) < PENDING_TTL_DAYS * 86400


def conflict_lock_held(op_id, pending_dir=None):
    """True when op_id holds a fresh conflict lock.

    W6-P2-3: same clock-jump guards as _lock_held_unlocked (future-
    dated or monotonic-fresh locks are held even when the wall clock
    says otherwise)."""
    rec = _load_locks(pending_dir).get(op_id)
    if not rec:
        return False
    now = time.time()
    try:
        created = float(rec.get("created_at_ts", 0))
    except (TypeError, ValueError):
        return True
    if created > now:
        return True
    try:
        created_mono = float(rec.get("created_mono", 0) or 0)
    except (TypeError, ValueError):
        created_mono = 0
    if created_mono > 0:
        mono_age = time.monotonic() - created_mono
        if 0 <= mono_age < PENDING_TTL_DAYS * 86400:
            return True
    return (now - created) < PENDING_TTL_DAYS * 86400


def acquire_conflict_lock(op_id, entry_name, pending_dir=None):
    """Take the conflict lock for a write dispatch. Raises
    ConflictLockHeld when the op is already uncertain and unsettled:
    that write must never be replayed."""
    # W5-P1-1: the check-and-set runs under the locks flock; an
    # unlocked read-modify-write let concurrent dispatches silently
    # drop each other's lock records.
    with _locks_locked(pending_dir):
        locks = _load_locks(pending_dir)
        if _lock_held_unlocked(op_id, locks):
            raise ConflictLockHeld(
                "op %s (%r) is applied_or_unknown and holds its conflict lock; "
                "refusing to re-dispatch. Settle it by provider readback "
                "(complete_unresolved_create_review) or person close-out "
                "(close_out_by_person), never by replay." % (op_id, entry_name))
        locks[op_id] = {"entry_name": entry_name,
                        "created_at_ts": time.time(),
                        # W6-P2-3: monotonic creation mark, immune to
                        # wall-clock jumps; used as a cross-check in
                        # _lock_held_unlocked.
                        "created_mono": time.monotonic(),
                        "created_at": datetime.now(timezone.utc).isoformat()}
        _save_locks(pending_dir, locks)


def release_conflict_lock(op_id, pending_dir=None):
    """Release op_id's conflict lock. Best-effort; never raises."""
    try:
        # W5-P1-1: under the locks flock, like every other mutation.
        with _locks_locked(pending_dir):
            locks = _load_locks(pending_dir)
            if op_id in locks:
                del locks[op_id]
                _save_locks(pending_dir, locks)
    except OSError:
        pass


# W6-P2-3: sweep circuit breaker. A forward wall-clock jump would
# otherwise mass-age every envelope/lock into staleness; if one sweep
# would remove more than this many, it refuses and warns instead of
# destroying all in-flight state (the operator investigates the clock).
_SWEEP_CIRCUIT_BREAKER = 10


def sweep_stale_locks(pending_dir=None, max_age_days=PENDING_TTL_DAYS):
    """Drop conflict locks older than max_age_days. Returns the count
    removed. Best-effort; never raises.

    W6-P2-3: future-dated locks (clock rolled back) are never swept,
    and the circuit breaker refuses a mass sweep (forward clock jump).
    """
    removed = 0
    # W5-P1-1: the filter-and-save runs under the locks flock so a
    # concurrent acquire cannot lose its record to this sweep.
    try:
        with _locks_locked(pending_dir):
            try:
                locks = _load_locks(pending_dir)
            except OSError:
                return 0
            now = time.time()
            cutoff = now - max_age_days * 86400
            candidates = []
            for op_id in list(locks):
                try:
                    created = float(locks[op_id].get("created_at_ts", 0))
                except (TypeError, ValueError):
                    continue
                if created > now:
                    continue  # clock rolled back; keep
                if created < cutoff:
                    candidates.append(op_id)
            if len(candidates) > _SWEEP_CIRCUIT_BREAKER:
                sys.stderr.write(
                    "morrow: WARNING: sweep_stale_locks would remove %d "
                    "conflict locks (limit %d): refusing; the system "
                    "clock may have jumped forward. Investigate before "
                    "sweeping.\n" % (len(candidates),
                                      _SWEEP_CIRCUIT_BREAKER))
                return 0
            for op_id in candidates:
                del locks[op_id]
                removed += 1
            if removed:
                try:
                    _save_locks(pending_dir, locks)
                except OSError:
                    pass
    except OSError:
        pass
    return removed


# Pending envelopes hold the RAW provider payload (see the learner-data
# boundary in complete_browser_request). Retention contract: an envelope
# lives only from the request phase until its op reaches a terminal state
# (journaled complete/failed). Brief files (the rendered form spec) live
# from dispatch until the same terminal point; the complete phase
# re-renders the request brief deterministically, so deleting at terminal
# never strands a retry. Every terminal path below deletes the envelope
# via _delete_pending_file and the briefs via _delete_brief_files;
# sweep_stale_pending is the backstop for orphans left by crashes between
# phases. Session-dead paths intentionally keep both for the retry.
# Uninstall/support wipe: purge_transient_state().


def _delete_pending_file(pending_file):
    """Best-effort delete of a pending envelope. Terminal cleanup must
    never fail the op it follows (journaling already happened), so a
    deletion failure is swallowed; the TTL sweeper is the backstop."""
    try:
        if pending_file and os.path.exists(pending_file):
            os.remove(pending_file)
    except OSError:
        pass


def _delete_brief_files(brief_dir, op_id):
    """Best-effort delete of an op's browser brief files (request, verify,
    and duplicate_check phases). Briefs carry the rendered form spec, so
    they are transient: they live only from dispatch until the op reaches
    a terminal state. Terminal cleanup must never fail the op it follows;
    deletion failures are swallowed and the TTL sweeper is the backstop.
    Session-dead paths intentionally keep the brief for the retry."""
    for phase in ("request", "verify", "dupcheck"):
        try:
            path = _brief_path(brief_dir, op_id, phase)
            if os.path.exists(path):
                os.remove(path)
        except (OSError, ex.ExecutorError):
            # Best-effort: a refused op_id (W5-P2-1: non-UUID ids fail
            # closed in the path builders) must not fail the cleanup.
            pass


def _envelope_created_at(path):
    """The envelope's internal creation time (W6-P2-4).

    Returns epoch seconds, or None when the envelope cannot be read or
    its created_at does not parse. The file mtime is NOT used: it is
    attacker-editable (touch) without modifying content, while the
    internal timestamp travels with the envelope bytes.
    """
    try:
        with open(path, encoding="utf-8") as fh:
            envelope = json.load(fh)
        created = envelope.get("created_at")
        if not created:
            return None
        dt = datetime.fromisoformat(str(created).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except (OSError, ValueError, TypeError):
        return None


def sweep_stale_pending(pending_dir=None, max_age_days=PENDING_TTL_DAYS):
    """Delete pending envelopes older than max_age_days. Orphans
    come from crashes between the request and verify phases. Each swept
    envelope's brief files go with it (the envelope records brief_dir).
    Best-effort: never raises. Returns the number of envelopes removed.

    W6-P2-4: staleness uses the envelope's internal created_at, never
    the file mtime. W6-P2-3: envelopes dated in the future (clock
    rolled back) or unparseable are never swept, and the circuit
    breaker refuses a mass sweep (forward clock jump)."""
    removed = 0
    target = pending_dir or PENDING_DIR
    try:
        names = os.listdir(target)
    except OSError:
        return 0
    now = time.time()
    cutoff = now - max_age_days * 86400
    candidates = []
    for name in names:
        if not name.endswith(".json"):
            continue
        path = os.path.join(target, name)
        if not os.path.isfile(path):
            continue
        created = _envelope_created_at(path)
        if created is None:
            continue  # cannot date it; never sweep blind (W6-P2-4)
        if created > now:
            continue  # clock rolled back; keep (W6-P2-3)
        if created < cutoff:
            candidates.append((path, name))
    if len(candidates) > _SWEEP_CIRCUIT_BREAKER:
        sys.stderr.write(
            "morrow: WARNING: sweep_stale_pending would remove %d "
            "pending envelopes (limit %d): refusing; the system clock "
            "may have jumped forward. Investigate before sweeping.\n"
            % (len(candidates), _SWEEP_CIRCUIT_BREAKER))
        return 0
    for path, name in candidates:
        try:
            try:
                with open(path, encoding="utf-8") as fh:
                    envelope = json.load(fh)
                op_id = envelope.get("op_id") or name[:-5]
                _delete_brief_files(envelope.get("brief_dir"), op_id)
                # W2-P0-2: a swept orphan's journal claim goes with
                # it, so journal_status() does not list phantom
                # pendings forever. W5-P0-1: the envelope never
                # yields a raw claim token (new envelopes store only
                # the hash); the sweep releases via the system-only
                # forced release, which journals forced=true for the
                # TTL-expired orphan (outcome unknown). No
                # disk-derived token is honored anywhere on this
                # path.
                if op_id:
                    try:
                        ex.release_op_id_forced(
                            op_id,
                            "stale pending envelope swept after "
                            "TTL; outcome unknown")
                    except Exception:
                        pass
            except (OSError, ValueError):
                pass
            os.remove(path)
            removed += 1
        except OSError:
            continue
    # Stale conflict locks (crashed dispatches) are swept with the same TTL.
    try:
        sweep_stale_locks(target, max_age_days)
    except OSError:
        pass
    return removed


def purge_transient_state(pending_dir=None, brief_dir=None, force=False):
    """Uninstall/support path: delete pending envelopes and browser
    brief files. Returns (pending_removed, briefs_removed,
    inflight_skipped).

    W4-P0-4/W4-P0-5: pending envelopes hold RAW provider payloads
    (including learner PII) for internal verify/undo resolution, and
    brief files render op params (learner names). Neither the legacy
    purge/wipe CLIs nor the shipped deletion path covered them. This
    function is now wired into every purge/wipe path (privacy/pseudonym,
    privacy/learner_vault, privacy/executor_wire) and scripts/uninstall.sh.

    W5-P1-2: in-flight state is never silently destroyed. An envelope
    is in-flight when it is younger than PENDING_TTL_DAYS (by mtime) OR
    its op_id still holds a live journal claim: it belongs to an op
    parked between its request and verify phases, and deleting it would
    wedge the op permanently (no verify, no claim release, op_id
    bricked, journal claim dangling). Such envelopes are SKIPPED
    (counted in inflight_skipped), and their brief files are kept with
    them. Only envelopes with no live claim that are older than the TTL
    are removed, and their journal claims are released via
    ex.release_op_id_forced so no phantom pendings
    linger. conflict-locks.json (and the *.lock / *.new.* machinery
    files) are never deleted: live locks are the P0-6
    never-replay-an-uncertain-write guard, they carry no learner PII,
    and stale ones are TTL-swept by sweep_stale_locks instead.
    force=True restores the old delete-everything behavior for callers
    that own the whole tree (uninstall deletes the journal right after,
    so nothing can dangle).
    """
    pending_target = pending_dir or PENDING_DIR
    brief_target = brief_dir or BRIEF_DIR
    pending_removed = 0
    briefs_removed = 0
    inflight_skipped = 0
    cutoff = time.time() - PENDING_TTL_DAYS * 86400

    # W5-P1-2: journal liveness is the in-flight signal, not just mtime.
    # An envelope older than the TTL whose op_id still has a LIVE journal
    # claim belongs to an op the orchestrator may yet complete (the token
    # lives in the orchestrator's memory); purging it would wedge the
    # verify phase. Such envelopes are preserved like fresh ones. Only
    # envelopes with no live claim are stale enough to purge (their
    # claims are forced-released below, so nothing dangles).
    try:
        live_op_ids = {p["op_id"] for p in ex.journal_pending_ops()}
    except Exception:
        live_op_ids = set()

    # Envelopes first, so the in-flight set is known before briefs.
    inflight_op_ids = set()
    try:
        names = os.listdir(pending_target)
    except OSError:
        names = []
    for name in names:
        path = os.path.join(pending_target, name)
        try:
            if not os.path.isfile(path):
                continue
            base = os.path.basename(path)
            # W5-P1-2: lock machinery is never purged.
            if base == os.path.basename(_locks_path(pending_target)) \
                    or base.endswith(".lock") or ".new." in base \
                    or base.endswith(".new"):
                continue
            if not name.endswith(".json"):
                continue
            # W6-P2-4: freshness uses the envelope's internal
            # created_at, never the file mtime. An undatable envelope
            # is treated as in-flight (never purged blind).
            created = _envelope_created_at(path)
            op_id = name[:-5]
            if not force and (created is None or created >= cutoff
                              or op_id in live_op_ids):
                # In-flight: parked between request and verify phases
                # (fresh by age, or still holding a live journal claim).
                inflight_op_ids.add(op_id)
                inflight_skipped += 1
                continue
            # Stale (or forced): release the journal claim before
            # deleting, so the op does not linger in
            # journal_pending_ops forever. W5-P0-1: the envelope never
            # yields a raw claim token; release via the system-only
            # forced release (forced=true is the truthful record for a
            # purged in-flight op whose outcome is unknown).
            try:
                with open(path, encoding="utf-8") as fh:
                    envelope = json.load(fh)
                _op = envelope.get("op_id") or op_id
                _delete_brief_files(envelope.get("brief_dir"), _op)
                if _op:
                    try:
                        ex.release_op_id_forced(
                            _op,
                            "pending envelope purged after TTL; "
                            "outcome unknown")
                    except Exception:
                        pass
            except (OSError, ValueError):
                pass
            try:
                os.remove(path)
                pending_removed += 1
            except OSError:
                continue
        except OSError:
            continue

    # Briefs: keep the ones belonging to skipped in-flight envelopes
    # (the verify phase re-renders deterministically, but the request
    # brief on disk is the retry's input; deleting it strands nothing
    # only when the envelope is gone too).
    try:
        names = os.listdir(brief_target)
    except OSError:
        names = []
    for name in names:
        path = os.path.join(brief_target, name)
        try:
            if not os.path.isfile(path):
                continue
            if not force and any(
                    name.startswith(op_id + "-")
                    for op_id in inflight_op_ids):
                continue
            os.remove(path)
            briefs_removed += 1
        except OSError:
            continue
    return pending_removed, briefs_removed, inflight_skipped


# --------------------------------------------------------------------------
# W4-P0-6: browser-profile learner-data purge.
#
# purge/wipe historically left the entire Chromium profile on disk; only
# full uninstall removed it, so History, Cookies, Cache, Local Storage,
# IndexedDB, Session Storage, Service Workers, and Crash Reports kept a
# full session's worth of learner data after the documented deletion.
# purge_browser_profile() deletes the learner-data-carrying stores while
# keeping the session cookies (Cookies, Login Data) so the educator
# stays signed in; full=True wipes the whole profile (same effect as
# uninstall's profile deletion, usable without uninstalling the tree).
# --------------------------------------------------------------------------

# Relative to the Chromium user-data dir. Trailing "/" marks a directory
# tree to remove wholesale; anything else is a file (plus its -journal
# and -wal companions for sqlite stores).
_PROFILE_LEARNER_STORES = (
    # Browsing history and its derivatives (visited URLs, page titles,
    # e.g. "Zeldana Fakeington - People - <course>").
    "Default/History",
    "Default/History Provider Cache",
    "Default/Top Sites",
    "Default/Visited Links",
    # Open-tab session state (tab URLs carry course/user paths).
    "Default/Sessions/",
    "Default/Current Session",
    "Default/Current Tabs",
    "Default/Last Session",
    "Default/Last Tabs",
    # Caches that persist fetched page bodies (roster pages, etc.).
    "Default/Cache/",
    "Default/Code Cache/",
    "Default/GPUCache/",
    "Default/Service Worker/",
    # DOM storage: lastViewedStudent-style keys live here.
    "Default/Local Storage/",
    "Default/Session Storage/",
    "Default/IndexedDB/",
    "Default/Storage/",
    # Crash dumps can embed page text.
    "Crash Reports/",
)

# Stores the selective wipe deliberately KEEPS so the educator stays
# signed in: Cookies (+ journal/wal), Login Data, Preferences, Web Data,
# TransportSecurity, and the profile's key material. Named explicitly so
# the FERPA residue inventory can state exactly what survives a purge.
_PROFILE_SESSION_STORES_KEPT = (
    "Default/Cookies",
    "Default/Login Data",
    "Default/Preferences",
    "Default/Web Data",
)


def _default_profile_dir():
    """The helper's Chromium profile: LOGIN_HELPER_PROFILE_DIR wins,
    otherwise <tree>/helper/profile (this file lives two levels under
    the tree root)."""
    override = os.environ.get("LOGIN_HELPER_PROFILE_DIR")
    if override:
        return override
    tree = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(tree, "helper", "profile")


def _ps_argv_lines():
    """Every process's command line from `ps`, or None when the process
    table cannot be read."""
    try:
        proc = subprocess.run(["ps", "-axww", "-o", "args="],
                              capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout.splitlines()


def _ps_line_names_profile(line, want):
    """True when a ps command line carries --user-data-dir=<want> (or
    the two-token form) as a whole argument. ps joins argv with
    spaces, so a value runs to the next " --" flag or the line end."""
    for marker in ("--user-data-dir=", "--user-data-dir "):
        start = 0
        while True:
            at = line.find(marker, start)
            if at < 0:
                break
            if at > 0 and not line[at - 1].isspace():
                start = at + 1
                continue
            value = line[at + len(marker):]
            end = value.find(" --")
            if end >= 0:
                value = value[:end]
            try:
                if os.path.realpath(value.rstrip()) == want:
                    return True
            except OSError:
                pass
            start = at + 1
    return False


def _profile_in_use(profile_dir):
    """True when a live process's argv carries an exact
    --user-data-dir=<profile_dir> element. Mirrors the argv matching in
    scripts/uninstall.sh (_chromium_user_data_dir): a profile dir that
    merely contains ours as a substring never matches."""
    try:
        want = os.path.realpath(profile_dir)
    except OSError:
        return False
    if not os.path.isdir("/proc"):
        # No /proc (macOS, some sandboxes): read the process table with
        # ps instead. When that is unreadable too, fail closed: answer
        # "in use", so a live browser's stores are never purged on a
        # guess. (Round-4 L7: this branch used to answer "not in use"
        # whenever no Chromium lock file existed.)
        lines = _ps_argv_lines()
        if lines is None:
            return True
        return any(_ps_line_names_profile(line, want) for line in lines)
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open("/proc/%s/cmdline" % pid, "rb") as fh:
                argv = fh.read().split(b"\0")
        except OSError:
            continue
        for arg in argv:
            try:
                text = arg.decode("utf-8", "replace")
            except Exception:
                continue
            value = None
            if text.startswith("--user-data-dir="):
                value = text[len("--user-data-dir="):]
            elif text == "--user-data-dir":
                continue  # two-token form needs lookahead; exact-match
                # argv elements are scanned individually below instead.
            if value is not None:
                try:
                    if os.path.realpath(value) == want:
                        return True
                except OSError:
                    continue
        # Two-token form: --user-data-dir <dir>.
        try:
            texts = [a.decode("utf-8", "replace") for a in argv]
        except Exception:
            continue
        for i, text in enumerate(texts[:-1]):
            if text == "--user-data-dir":
                try:
                    if os.path.realpath(texts[i + 1]) == want:
                        return True
                except OSError:
                    continue
    return False


def purge_browser_profile(profile_dir=None, full=False):
    """W4-P0-6: purge the Chromium profile's learner-data-carrying stores.

    Selective mode (default) deletes _PROFILE_LEARNER_STORES (History,
    Top Sites, Visited Links, Sessions, Cache, Code Cache, Service
    Worker, Local Storage, Session Storage, IndexedDB, Storage, Crash
    Reports) while keeping the session stores in
    _PROFILE_SESSION_STORES_KEPT (Cookies, Login Data), so the educator
    stays signed in. full=True removes the whole profile directory
    (the educator signs in again on next launch).

    Refuses loudly with BrowserProfileInUse when a Chromium process is
    running against the profile: deleting stores under a live browser
    can corrupt it. Stop the helper (or the browser) first, then re-run.

    Returns a report dict: {"profile_dir", "mode", "removed": [...],
    "failed": [...], "kept_session": [...]}. A missing profile dir is
    not an error (nothing to purge).
    """
    import shutil
    target = profile_dir or _default_profile_dir()
    mode = "full" if full else "selective"
    report = {"profile_dir": target, "mode": mode, "removed": [],
              "failed": [], "kept_session": list(_PROFILE_SESSION_STORES_KEPT)}
    if not os.path.isdir(target):
        report["profile_missing"] = True
        return report
    if _profile_in_use(target):
        raise BrowserProfileInUse(
            "Chromium is running against profile %s; refusing to delete "
            "profile stores under a live browser (profile corruption "
            "risk). Stop the helper (or the browser) first, then re-run "
            "the purge." % target)
    if full:
        try:
            shutil.rmtree(target)
            report["removed"].append(target + "/")
        except OSError as exc:
            report["failed"].append("%s: %s" % (target, exc))
        return report
    for rel in _PROFILE_LEARNER_STORES:
        path = os.path.join(target, rel.rstrip("/"))
        candidates = [path] if rel.endswith("/") else [
            path, path + "-journal", path + "-wal"]
        for cand in candidates:
            try:
                if os.path.isdir(cand) and not os.path.islink(cand):
                    shutil.rmtree(cand)
                    report["removed"].append(
                        os.path.relpath(cand, target) + "/")
                elif os.path.isfile(cand) or os.path.islink(cand):
                    os.remove(cand)
                    report["removed"].append(
                        os.path.relpath(cand, target))
            except OSError as exc:
                report["failed"].append(
                    "%s: %s" % (os.path.relpath(cand, target), exc))
    return report


def _render_brief_or_blocked(*args, **kwargs):
    """Render a brief, mapping a retired form lane to BrowserLaneBlocked.

    batch.render_brief raises FormTransportUnavailable for every form
    write: the relay lane was retired 2026-09-21, so that is a blocked
    lane, not a crash. Surface it so the executor reports the lane as
    blocked with the accurate reason.

    P0-3 backstop: refuse any brief that still teaches the retired
    meta-tag / hidden-input CSRF source. P0-9 backstop: fetch op bodies
    must already be text by the time they reach the renderer.
    LANE2-D10: batch.render_brief refuses authentication headers
    independently of the planner; map its refusal to this module's
    SecretEgressRefused so callers see one credential-egress signal.
    """
    ops = args[0] if args else kwargs.get("ops") or []
    for op in ops:
        if isinstance(op, dict) and op.get("kind") == "fetch":
            _assert_text_payload(op.get("body"), "fetch op body")
    try:
        brief = batch.render_brief(*args, **kwargs)
    except batch.FormTransportUnavailable as exc:
        raise BrowserLaneBlocked(str(exc))
    except batch.SecretEgressRefused as exc:
        raise SecretEgressRefused(str(exc))
    _assert_no_csrf_source_fallback(brief, kwargs.get("batch_id", "?"))
    return brief


def _render_request_brief(entry, params, config, op_id, base, principal,
                          provider, form_host, brief_dir):
    items, defer_verify = _plan_all(entry, params, config, op_id)
    ops = [op for kind, op, _ in items if kind != "verify"]
    if len(ops) > batch.MAX_OPS_PER_BATCH:
        raise BrowserLaneBlocked(
            "entry %r plans %d browser ops; max %d per batch"
            % (entry.get("name"), len(ops), batch.MAX_OPS_PER_BATCH))
    # The form lane is retired (relay page taken down 2026-09-21):
    # batch.render_brief raises FormTransportUnavailable for any form
    # write, mapped to BrowserLaneBlocked by _render_brief_or_blocked.
    # form_host is accepted for signature compatibility and ignored.
    brief = _render_brief_or_blocked(
        ops, base, principal=principal,
        batch_id="batch-%s-request" % op_id[:8],
        form_host=form_host,
        provider=provider)
    brief_file = _write_secret_file(_brief_path(brief_dir, op_id, "request"), brief)
    return items, defer_verify, brief_file


# --------------------------------------------------------------------------
# Phase 1: dispatch (plan + render brief, no browser contact)
# --------------------------------------------------------------------------

def dispatch_browser_entry(entry, params, lane_state, pack, plan=None,
                           op_id=None, form_host=None, brief_dir=None,
                           kind="dispatch", approval=None,
                           pending_dir=None):
    """Plan an entry for the browser lane and render its task brief.

    Returns an awaiting_browser_task envelope; the orchestrator runs the
    browser task and later calls complete_browser_request with the report.
    """
    # W4-P0-10 parity with the raw lane: the effect class is derived from
    # the entry's blocks before admit() or any effects=="write" comparison
    # trusts the manifest's "effects" field. A write block declared as
    # effects="read" is refused here, not downgraded to a read.
    ex.enforce_effect_class(entry)
    ex.live_proven_gate(entry)
    entry_name = entry.get("name")
    provider = entry.get("provider") or "canvas"
    # Best-effort TTL sweep of orphaned pending envelopes (crashes between
    # phases); never blocks a dispatch.
    try:
        sweep_stale_pending(pending_dir)
    except Exception:
        pass
    _, base, _principal0 = _lane_for(provider, lane_state)
    # Admission gate: never-dispatch, unsupported, tenant-restricted,
    # learner-data, per-action write approval. Runs before planning.
    ex._check_auxiliary_learner_data(entry, _vault.vault_available())
    _, _approval_record = admit(
        entry, params, tenant_base=base, approval=approval, op_id=op_id,
        vault_ready=_vault.vault_available())
    op_id, claim_token = ex._check_write_gates(entry, params, plan, op_id,
                                               kind)
    lock_dir = pending_dir or PENDING_DIR
    try:
        _admission.persist_signed_record(_approval_record, op_id)
        _admission.consume_approval(_approval_record)
        _, base, principal = _lane_for(provider, lane_state)
        # P0-5: a write with no pinned principal is refused before planning.
        _require_principal_for_write(entry, principal, "dispatch")
        # P0-6: a write dispatch takes the provider-object conflict lock. An
        # op_id that is already applied_or_unknown raises ConflictLockHeld:
        # uncertain writes are never replayed.
        if entry.get("effects", "read") == "write":
            acquire_conflict_lock(op_id, entry_name, lock_dir)
        config = {"canvas_base": base}
        items, defer_verify, _brief_file = _render_request_brief(
            entry, params, config, op_id, base, principal, provider,
            form_host, brief_dir)
    except Exception as exc:
        # W2-P0-18: planning failed before anything was sent: release the
        # conflict lock AND the journal claim so the op_id is reusable.
        # ConflictLockHeld means applied_or_unknown: the claim stays for
        # reconciliation and is never released here.
        if isinstance(exc, ConflictLockHeld):
            raise
        if entry.get("effects", "read") == "write":
            release_conflict_lock(op_id, lock_dir)
        try:
            ex.release_op_id(
                op_id, claim_token,
                "browser dispatch planning failed pre-send: %s"
                % type(exc).__name__)
        except Exception:
            pass
        raise
    ops = [op for k, op, _ in items if k != "verify"]
    return {
        "status": "awaiting_browser_task",
        "phase": "request",
        "op_id": op_id,
        "entry_name": entry_name,
        "kind": kind,
        "batch_id": "batch-%s-request" % op_id[:8],
        "brief_file": _brief_path(brief_dir, op_id, "request"),
        "ops": [op["op_id"] for op in ops],
        "defer_verify": defer_verify,
        "principal": principal,
        "base": base,
        # P0-5: the lane generation this dispatch was planned against. The
        # complete phase refuses the command if the lane reconnected since.
        "session_generation": _lane_generation(lane_state, provider),
        # P0-6: the lock directory, so complete/release paths use the same
        # directory the lock was acquired in.
        "pending_dir": lock_dir,
        # W2-P0-18: the journal claim token. The complete phase
        # re-validates it (resume=True) instead of claiming twice; the
        # orchestrator passes it through to complete_browser_request.
        "claim_token": claim_token,
    }


def dispatch_browser_undo(entry, params, result_payload, of_op_id, lane_state,
                          pack, form_host=None, brief_dir=None, approval=None,
                          pending_dir=None):
    """Plan an entry's undo block for the browser lane (two-phase like dispatch).
    """
    # W4-P0-10 parity with the raw lane (see dispatch_browser_entry): the
    # effect class is derived from the entry's blocks before admit() or
    # any later effects=="write" comparison trusts the manifest.
    ex.enforce_effect_class(entry)
    entry_name = entry.get("name")
    undo = entry.get("undo")
    if not undo:
        raise ex.ExecutorError(
            "entry %r declares no undo block; the effect is non-undoable and "
            "the governance layer must disclose that to the educator before "
            "dispatch" % entry_name)
    ex.live_proven_gate({"name": "%s#undo" % entry_name, "request": undo})
    provider = entry.get("provider") or "canvas"
    _, base, _principal0 = _lane_for(provider, lane_state)
    # Admission gate: undo is a write; it needs its own educator approval,
    # bound to the undo action and its target (never the forward write's).
    ex._check_auxiliary_learner_data(entry, _vault.vault_available())
    _admission.check_policy_gates(entry, _vault.vault_available())
    # The undo target comes ONLY from the original op's journaled
    # receipt; a caller payload that disagrees is refused.
    result_payload = ex.journaled_undo_result(entry, params, of_op_id,
                                              result_payload)
    undo_entry, undo_params = ex.undo_approval_subject(
        entry, params, of_op_id, result_payload)
    _, _approval_record = admit(
        undo_entry, undo_params, tenant_base=base, approval=approval,
        vault_ready=_vault.vault_available())
    undo_op_id = str(uuid.uuid4())
    op_id, claim_token = ex._check_write_gates(entry, params, None,
                                               undo_op_id, kind="undo")
    lock_dir = pending_dir or PENDING_DIR
    try:
        _admission.persist_signed_record(_approval_record, op_id)
        _admission.consume_approval(_approval_record)
        _, base, principal = _lane_for(provider, lane_state)
        # P0-5/P0-6: undo is a write: it needs a pinned principal and takes
        # the conflict lock like any other write dispatch.
        _require_principal_for_write(entry, principal, "undo dispatch")
        acquire_conflict_lock(op_id, entry_name, lock_dir)
        config = {"canvas_base": base}
        op = _plan_block(entry, undo, params, config, {}, result_payload, op_id)
        brief = _render_brief_or_blocked(
            [op], base, principal=principal,
            batch_id="batch-%s-undo" % op_id[:8],
            form_host=form_host,
            provider=provider)
    except Exception as exc:
        # W2-P0-18: like dispatch_browser_entry: a pre-send planning
        # failure releases the lock and the journal claim; ConflictLockHeld
        # keeps the claim for reconciliation.
        if isinstance(exc, ConflictLockHeld):
            raise
        release_conflict_lock(op_id, lock_dir)
        try:
            ex.release_op_id(
                op_id, claim_token,
                "browser undo planning failed pre-send: %s"
                % type(exc).__name__)
        except Exception:
            pass
        raise
    brief_file = _write_secret_file(_brief_path(brief_dir, op_id, "request"), brief)
    return {
        "status": "awaiting_browser_task",
        "phase": "request",
        "op_id": op_id,
        "undo_of": str(of_op_id),
        # The approval subject the undo was admitted under; the complete
        # phase re-verifies the persisted approval against it.
        "undo_params": undo_params,
        "entry_name": entry_name,
        "kind": "undo",
        "batch_id": "batch-%s-undo" % op_id[:8],
        "brief_file": brief_file,
        "ops": [op["op_id"]],
        "defer_verify": False,
        "principal": principal,
        "base": base,
        # P0-5: the lane generation this undo was planned against.
        "session_generation": _lane_generation(lane_state, provider),
        # P0-6: the lock directory, so complete/release paths use the same
        # directory the lock was acquired in.
        "pending_dir": lock_dir,
        # W2-P0-18: the journal claim token for the complete phase.
        "claim_token": claim_token,
    }


# --------------------------------------------------------------------------
# Phase 2: complete (ingest the browser task report)
# --------------------------------------------------------------------------

# --------------------------------------------------------------------------
# P0-6 / P0-8: write-outcome classification and canonical verification
# states. One dispatch is not one network request (a reused connection
# can resend before response headers arrive), so there is no exactly-once
# guarantee and the status code alone never proves an effect:
#
#   2xx              -> "ok" (still needs provider readback to be verified)
#   3xx              -> "redirect" (login redirect = session-dead, never followed)
#   408, 429, 5xx,
#   0 / transport loss -> "uncertain" (applied_or_unknown; never replayed)
#   other 4xx        -> "refused" (provider refused before saving; fail fast)
#
# Canonical verification states journaled and returned by the complete
# phase: verified (provider readback determined success), unconfirmed
# (2xx but no readback; HTTP success alone is never verification),
# failed, applied_or_unknown, skipped (reads), closed_by_person.
# --------------------------------------------------------------------------

OUTCOME_OK = "ok"
OUTCOME_REDIRECT = "redirect"
OUTCOME_UNCERTAIN = "uncertain"
OUTCOME_REFUSED = "refused"

_UNCERTAIN_STATUSES = {408, 429}


def classify_provider_status(status):
    """Map a provider HTTP status (0 = transport loss/timeout/parse
    failure) to a write-outcome class (P0-6)."""
    try:
        code = int(status)
    except (TypeError, ValueError):
        return OUTCOME_UNCERTAIN
    if code == 0:
        return OUTCOME_UNCERTAIN
    if 200 <= code < 300:
        return OUTCOME_OK
    if 300 <= code < 400:
        return OUTCOME_REDIRECT
    if code in _UNCERTAIN_STATUSES or code >= 500:
        return OUTCOME_UNCERTAIN
    return OUTCOME_REFUSED


_CANONICAL_VERIFICATION = {
    "pass": "verified",
    "fail": "failed",
    "uncertain": "applied_or_unknown",
    "skipped": "skipped",
    "verified": "verified",
    "failed": "failed",
    "applied_or_unknown": "applied_or_unknown",
    "unconfirmed": "unconfirmed",
    # A verify block whose values may be the LMS's own normalization.
    "unverified": "unconfirmed",
    "closed_by_person": "closed_by_person",
}


def canonical_verification(verification):
    """Translate a verification dict to the canonical four-plus states.
    Pass-through for dicts; returns a new dict (input is not mutated)."""
    mapped = dict(verification or {})
    mapped["status"] = _CANONICAL_VERIFICATION.get(mapped.get("status"),
                                                   mapped.get("status"))
    return mapped


def _raise_on_redirect(results, op_id, phase):
    """A redirect during an authenticated call is session death (P0-5).
    Login redirects are never followed; the browser task reports them and
    this layer maps them to session-dead."""
    hits = [r["op_id"] for r in results.get("results", [])
            if 300 <= r.get("status", 0) < 400]
    if hits:
        # W4-P2-1: a login redirect during an authenticated call is
        # session death and is never followed; arm the re-auth machinery
        # before raising.
        _on_browser_session_death(
            op_id, "%s-phase" % phase,
            "browser op(s) %s reported HTTP redirect during an "
            "authenticated call; login redirect is session death and is "
            "never followed" % ", ".join(hits))
        raise BrowserSessionDead(
            "browser op(s) %s reported HTTP redirect during an authenticated "
            "call (op %s, %s phase); a login redirect is session death and "
            "is never followed" % (", ".join(hits), op_id, phase))


def _journal_uncertain_and_raise(entry_name, kind, effects, params, plan,
                                 op_id, detail, approval_audit=None,
                                 pending_dir=None, claim_token=None,
                                 undo_available=None):
    uncertain_result = {"payload": {"uncertain": True},
                        "receipt": {"uncertain": True,
                                    "detail": "effect state unknown; not retried"},
                        "truncated": False, "bytes_received": 0}
    verification = {"status": "applied_or_unknown", "detail": detail}
    record = ex._journal_record(entry_name, kind, effects, params, plan,
                                op_id, None, verification,
                                uncertain_result, 0, uncertain=True,
                                approval_audit=approval_audit,
                                # W6-P1-H1: undoability even on unknown outcomes.
                                undo_available=undo_available)
    # W5-P1-4: the uncertain outcome completes the request-phase claim
    # atomically (single journal-lock hold), so two concurrent
    # request-phase completes cannot journal two outcomes.
    ex.journal_claimed_outcome(op_id, record, claim_token)
    raise ex.UncertainWrite(detail)


def _retryable(op_id, phase, reason, brief_file, batch_id):
    return {
        "status": "retryable",
        "phase": phase,
        "op_id": op_id,
        "reason": reason,
        "brief_file": brief_file,
        "batch_id": batch_id,
    }


def _apply_op_result(entry, op, body_text):
    # resp_headers are unknown in the browser lane; apply_result_block sniffs
    # the body prefix for JSON, which is what the report carries.
    return ex.apply_result_block(entry, body_text.encode("utf-8"), {})


def _untrusted_provider_text(text, limit=300):
    """W2-P2-5: label provider-carried Canvas text explicitly as
    untrusted data before it reaches an agent-visible error string."""
    return "[untrusted provider data follows] %s" % (text[:limit],)


def complete_browser_request(op_id, entry, params, plan, report_text,
                             lane_state, pack, form_host=None, brief_dir=None,
                             pending_dir=None, kind="dispatch", of_op_id=None,
                             expected_generation=None,
                             pinned_principal=None, claim_token=None,
                             undo_params=None):
    """Ingest a request-phase browser report; journal or park for verify.

    Returns the executor receipt on completion, or an awaiting_browser_task
    envelope for a verify phase (deferred verify, or the verify op's result
    was missing from the report).

    expected_generation: the session_generation the dispatch envelope
    recorded. When given and the lane generation moved since (the educator
    re-authenticated), the stale command is refused with
    BrowserSessionDead instead of running against the new session.
    pinned_principal: the principal the dispatch envelope pinned. When
    given for a write and the lane principal changed since dispatch (a
    different educator signed in), the command is refused with
    BrowserPrincipalChanged.
    claim_token: the journal claim token from the dispatch envelope. When
    given, the claim is re-validated (resume=True) instead of claimed
    twice; when absent, the op_id is claimed fresh (W2-P0-18).
    undo_params: for kind="undo", the dispatch envelope's "undo_params"
    (the undo's approval subject). An undo is approved as its own write,
    so its persisted approval is re-verified against that subject.
    """
    entry_name = entry.get("name")
    effects = entry.get("effects", "read")
    is_write = effects == "write"
    provider = entry.get("provider") or "canvas"
    _, base, _principal0 = _lane_for(provider, lane_state)
    # Admission gate, hard refusals only: complete can be invoked without a
    # prior dispatch, so the never-dispatch / unsupported / tenant-restricted /
    # learner-data checks re-run here. The per-action write approval was
    # enforced at dispatch time and is not re-demanded, but it IS
    # re-verified: the persisted record must match this complete's
    # entry/params/tenant and be in the consumed set.
    _admission_hard_checks(entry, params, base)
    if kind == "undo":
        if not isinstance(undo_params, dict):
            raise _admission.ApprovalMismatch(
                "undo complete needs the dispatch envelope's undo_params: "
                "an undo is approved as its own write, never under the "
                "forward write's approval")
        approval_audit = _admission.reverify_approval(
            ex.undo_admission_entry(entry), undo_params, base, op_id)
    else:
        approval_audit = _admission.reverify_approval(entry, params, base,
                                                      op_id)
    # W2-P0-18: the complete phase never claims twice. With the
    # dispatch envelope's claim token it re-validates ownership
    # (resume=True); without one (complete invoked without a prior
    # dispatch) it claims the op_id fresh under the journal lock.
    if claim_token:
        op_id, claim_token = ex._check_write_gates(
            entry, params, plan, op_id, kind, resume=True,
            claim_token=claim_token)
    else:
        op_id, claim_token = ex._check_write_gates(
            entry, params, plan, op_id, kind)
    _, base, principal = _lane_for(provider, lane_state)
    # P0-5: guarded write stage. A write completes only against a pinned
    # principal, and never against a lane that reconnected since dispatch.
    _require_principal_for_write(entry, principal, "complete")
    _recheck_pinned_principal(pinned_principal, principal, op_id, "request")
    _check_session_generation(expected_generation, lane_state, provider,
                              op_id, "request")
    config = {"canvas_base": base}

    # Re-render the request brief deterministically so a retry always has a
    # brief file to run, even if the dispatch-time file was lost.
    items, defer_verify, _brief_file = _render_request_brief(
        entry, params, config, op_id, base, principal, provider,
        form_host, brief_dir)
    brief_file = _brief_path(brief_dir, op_id, "request")
    batch_id = "batch-%s-request" % op_id[:8]

    results = batch.parse_results(report_text)
    # P0-5: the report-side principal backstop. A mismatched attestation
    # fails closed before any result is trusted.
    check_principal_attestation(report_text, principal)
    # Session death is authoritative per the brief contract (the session
    # check is always first, so no op was attempted). Like the raw HTTPS
    # backend's ReauthRequired, this journals nothing and consumes nothing:
    # re-authenticate, then retry with the same op_id and the same brief.
    # The conflict lock is released: nothing was attempted, so there is
    # nothing uncertain to protect.
    if results.get("session_dead"):
        release_conflict_lock(op_id, pending_dir)
        # W4-P2-1: arm the re-auth machinery before raising.
        _on_browser_session_death(op_id, entry_name,
                                 "browser task reported session_dead in "
                                 "the request phase; conflict lock released")
        raise BrowserSessionDead(
            "browser session is dead; re-authenticate, then retry with the "
            "same op_id and brief (no provider call was attempted)")

    by_id = {r["op_id"]: r for r in results.get("results", [])}
    transients = {}
    last_result = None
    last_payload = None
    verify_item = None

    for item_kind, op, block in items:
        if item_kind == "verify":
            verify_item = (op, block)
            continue
        r = by_id.get(op["op_id"])
        op_write = op["method"] != "GET"
        status = r["status"] if r else 0
        body = r["body"] if r else ""
        if r and r.get("csrf_missing"):
            # LANE2-D4: the task refused to send the op because the
            # _csrf_token cookie was absent. The provider never saw the
            # write, so this fails fast like a refusal (nothing
            # journaled, lock released, op_id reusable) and is never
            # misdiagnosed as an uncertain write.
            _shutdown_form_host()
            release_conflict_lock(op_id, pending_dir)
            if claim_token is not None:
                ex.release_op_id(op_id, claim_token,
                                 "browser op not sent: CSRF token missing")
            raise BrowserCsrfTokenMissing(
                "browser op %s not sent: no _csrf_token in the live "
                "document.cookie, so the browser task refused to send the "
                "write (check the helper session, not the provider); the "
                "op_id stays reusable" % op["op_id"])
        outcome = classify_provider_status(status)
        detail = "browser op %s: %s" % (
            op["op_id"],
            "missing from report" if not r else "transport failure"
            if status == 0 else "HTTP %d" % status)
        if outcome == OUTCOME_REDIRECT:
            # P0-5/P0-6: a redirect during the call is never followed. On
            # a write the effect is unknown (applied_or_unknown, lock
            # kept); on a read the session is dead for lane purposes.
            if op_write:
                _shutdown_form_host()
                _journal_uncertain_and_raise(
                    entry_name, kind, effects, params, plan, op_id,
                    detail + "; login redirect during the write, never "
                    "followed",
                    approval_audit=approval_audit, pending_dir=pending_dir,
                    claim_token=claim_token,
                    # W6-P1-H1: undoability even on unknown outcomes.
                    undo_available=bool(entry.get("undo")))
            release_conflict_lock(op_id, pending_dir)
            # W4-P2-1: a login redirect during an authenticated call is
            # session death; arm the re-auth machinery before raising.
            _on_browser_session_death(op_id, entry_name,
                                     "login redirect during an authenticated "
                                     "browser read; redirects never followed")
            raise BrowserSessionDead(
                "browser op %s hit a login redirect during an authenticated "
                "read; redirects are never followed" % op["op_id"])
        if outcome == OUTCOME_UNCERTAIN:
            # 408, 429, 5xx, timeout, transport loss: the write may or may
            # not have applied. Journal applied_or_unknown, keep the
            # conflict lock, never retry blind. Reads stay retryable.
            if op_write:
                _shutdown_form_host()
                _journal_uncertain_and_raise(
                    entry_name, kind, effects, params, plan, op_id, detail,
                    approval_audit=approval_audit, pending_dir=pending_dir,
                    claim_token=claim_token,
                    # W6-P1-H1: undoability even on unknown outcomes.
                    undo_available=bool(entry.get("undo")))
            return _retryable(op_id, "request",
                              detail + "; re-run the browser task with the saved brief",
                              brief_file, batch_id)
        if outcome == OUTCOME_REFUSED:
            # Fail-fast: the provider refused before saving (ordinary 4xx
            # except 408/429). The journal claim is released and the
            # conflict lock freed, so the op_id stays reusable for a
            # corrected retry; no outcome is journaled.
            _shutdown_form_host()
            release_conflict_lock(op_id, pending_dir)
            if claim_token is not None:
                ex.release_op_id(op_id, claim_token,
                                 "browser write refused pre-effect (HTTP %d)" %
                                 status)
            raise BrowserOpFailed(
                "browser op %s failed fast with HTTP %d: %s"
                % (op["op_id"], status,
                   _untrusted_provider_text(body)))
        try:
            result = _apply_op_result(entry, op, body)
        except Exception as exc:
            # Parse failure on a 2xx write: the provider answered success
            # but the body is unreadable, so the effect is unknown.
            if op_write:
                _shutdown_form_host()
                _journal_uncertain_and_raise(
                    entry_name, kind, effects, params, plan, op_id,
                    "browser op %s returned 2xx but the response body "
                    "failed to parse: %s" % (op["op_id"], exc),
                    approval_audit=approval_audit, pending_dir=pending_dir,
                    claim_token=claim_token,
                    # W6-P1-H1: undoability even on unknown outcomes.
                    undo_available=bool(entry.get("undo")))
            raise
        payload = result["payload"]
        capture = block.get("capture")
        if capture:
            for tkey, tpath in capture.items():
                transients[tkey] = ex.resolve_path(payload, tpath)
        last_result = result
        last_payload = payload

    if last_result is None:
        _shutdown_form_host()
        raise BrowserLaneBlocked(
            "entry %r planned no executable ops" % entry_name)

    # Learner-data boundary: the raw payload stays in the pending envelope
    # (0600) for internal verify/undo resolution, but the receipt that gets
    # journaled and returned is projected through the vault first, so no
    # learner PII is ever agent-visible or journal-visible.
    # Secret-material boundary (audit item 15): secret-ish response keys
    # are masked even inside the pending envelope. Verify expect
    # assertions and {result.*} URL templating use non-secret fields
    # (id, name, workflow_state); a manifest asserting on a secret-named
    # key fails loudly instead of persisting the secret.
    last_payload = ex.redact_payload(last_payload, ex.DEFAULT_REDACT_PATTERNS)
    last_result = _project_learner_result(
        entry, last_result, base,
        {"principal": principal, "session_generation": expected_generation,
         "lane_state": lane_state, "provider": provider})

    pending = {
        "op_id": op_id,
        "entry_name": entry_name,
        "kind": kind,
        "of_op_id": of_op_id,
        "entry": entry,
        "params": params,
        "plan_path": getattr(plan, "path", None),
        "transients": transients,
        "result_payload": last_payload,
        "result_receipt": last_result["receipt"],
        "verify_deferred": bool(defer_verify and verify_item is None and is_write
                                and entry.get("verify")),
        "lane": {"base": base, "principal": principal, "provider": provider},
        "brief_dir": brief_dir,
        "created_at": datetime.now(timezone.utc).isoformat(),
        # P0-5: the dispatch generation, so the verify phase can refuse a
        # stale command if the lane reconnected between phases.
        "session_generation": expected_generation,
        # P0-6: the lock directory, so the verify phase releases the lock
        # from the same directory the dispatch acquired it in.
        "pending_dir": pending_dir or PENDING_DIR,
        # W5-P0-1 (bypass of the W4-P0-2 journal fix): the persisted
        # envelope keeps only the claim token HASH, never the raw token.
        # The raw token was the sole authorization for release_op_id and
        # recheck_claim, so any same-uid reader of this 0600 file could
        # free or adopt the victim's in-flight claim. The orchestrator
        # threads the raw token to the verify phase through its own
        # memory (complete_browser_verify's claim_token parameter); the
        # hash here is for forensics only.
        "claim_token_hash": ex._claim_token_hash(claim_token),
    }
    pending_file = _write_secret_file(
        _pending_path(pending_dir, op_id),
        json.dumps(pending, indent=2, sort_keys=True, default=str))

    verify = entry.get("verify") if (is_write and kind != "undo") else None
    if verify and not defer_verify and verify_item is not None:
        vop, vblock = verify_item
        r = by_id.get(vop["op_id"])
        if r and 200 <= r["status"] < 300:
            vresult = _apply_op_result(entry, vop, r["body"])
            try:
                verification = ex._assert_verify_expect(
                    entry, vblock, vresult["payload"], params, last_payload,
                    transients)
            except ex.VerificationFailed as vexc:
                # P0-8: the readback did not confirm the write. Journaled
                # as failed with uncertain=True: the write may still have
                # applied, so the conflict lock is kept, never replayed.
                # W3-P2-5: the failure detail formats raw readback values
                # with %r; project it through the learner boundary before
                # it is journaled.
                after = ex.digest_of(last_result["receipt"])
                verification = canonical_verification(
                    _project_verification_detail(
                        entry, {"status": "fail", "detail": str(vexc)},
                        vresult["payload"], base,
                        {"principal": principal,
                         "session_generation": expected_generation,
                         "lane_state": lane_state, "provider": provider}))
                # W5-P1-4: atomic claim-recheck-and-journal (single
                # journal-lock hold): two concurrent request completes
                # cannot journal two outcomes for one op_id.
                ex.journal_claimed_outcome(
                    op_id,
                    ex._journal_record(
                        entry_name, kind, effects, params, plan, op_id, after,
                        verification,
                        last_result, 1, uncertain=True,
                        approval_audit=approval_audit,
                        undo_available=bool(entry.get("undo"))),
                    claim_token)
                _delete_pending_file(pending_file)
                _delete_brief_files(pending.get("brief_dir"), op_id)
                _shutdown_form_host()
                raise ex.VerificationFailed(
                    "verify block failed for op %s: %s (journaled as failed)"
                    % (op_id, vexc))
            # P0-8: provider readback determined success. This is the only
            # path that journals a write as verified; the conflict lock is
            # released because the effect is settled.
            verification = canonical_verification(verification)
            after = ex.digest_of(last_result["receipt"])
            # W5-P1-4: atomic claim-recheck-and-journal (see above).
            ex.journal_claimed_outcome(
                op_id,
                ex._journal_record(
                    entry_name, kind, effects, params, plan, op_id, after,
                    verification, last_result, 1,
                    approval_audit=approval_audit,
                    undo_available=bool(entry.get("undo"))),
                claim_token)
            release_conflict_lock(op_id, pending_dir)
            _delete_pending_file(pending_file)
            _delete_brief_files(pending.get("brief_dir"), op_id)
            _shutdown_form_host()
            return {
                "op_id": op_id,
                "entry_name": entry_name,
                "verification": verification,
                "receipt": last_result["receipt"],
                "truncated": last_result["truncated"],
                "bytes_received": last_result["bytes_received"],
                "attempts": 1,
                # W6-P1-H1: per-change undoability disclosure on the receipt.
                "undo_available": bool(entry.get("undo")),
            }
        # The write itself returned 2xx, but its verify read is missing from
        # the report. Do not journal yet; run verify as its own phase.
        return _start_verify_phase(
            pending, pending_file, vblock, vop, form_host, brief_dir,
            reason="write returned 2xx but the verify op result was missing "
                   "from the report; running verify as its own phase")

    if verify and (defer_verify or verify_item is None):
        # Verify needs result values: plan it now that the payload exists.
        vblock = verify
        vop = _plan_block(entry, vblock, params, config, transients,
                          last_payload, op_id + "-verify")
        return _start_verify_phase(
            pending, pending_file, vblock, vop, form_host, brief_dir,
            reason="verify block references result values; running verify "
                   "as its own phase")

    # P0-8: read effect journals as skipped. A write with no verify block
    # journals as unconfirmed: the provider answered 2xx but no readback
    # ran, and HTTP success alone is never verification. The conflict lock
    # is released: the op reached a terminal journaled state.
    if is_write:
        verification = {"status": "unconfirmed",
                        "detail": "write returned 2xx but no provider "
                        "readback was run; HTTP success alone is not "
                        "verification"}
    else:
        verification = {"status": "skipped",
                        "detail": "read effect; no verify block run"}
    if kind == "undo":
        record = {
            "op_id": op_id,
            "entry_name": entry_name,
            "kind": "undo",
            "undo_of": str(of_op_id),
            "effect": "write",
            "params_digest": ex.digest_of(params),
            "plan_digest": None,
            "before_state_digest": None,
            "after_state_digest": ex.digest_of(last_result["receipt"]),
            "verification": verification["status"],
            "verification_detail": verification.get("detail"),
            "receipt": last_result["receipt"],
            "truncated": last_result["truncated"],
            "bytes_received": last_result["bytes_received"],
            "attempts": 1,
            "uncertain": False,
            "approval": approval_audit,
        }
        # W5-P1-4: atomic claim-recheck-and-journal (single journal-lock
        # hold): the request-phase claim is consumed by this undo
        # outcome, so two concurrent completes cannot journal two
        # outcomes for one op_id.
        ex.journal_claimed_outcome(op_id, record, claim_token)
        release_conflict_lock(op_id, pending_dir)
        _delete_pending_file(pending_file)
        _delete_brief_files(pending.get("brief_dir"), op_id)
        _shutdown_form_host()
        return {"op_id": op_id, "undo_of": str(of_op_id),
                "entry_name": entry_name,
                "receipt": last_result["receipt"]}
    after = ex.digest_of(last_result["receipt"])
    # W5-P1-4: atomic claim-recheck-and-journal (single journal-lock
    # hold): the request-phase claim is consumed by this outcome, so
    # two concurrent request completes cannot journal two outcomes for
    # one op_id.
    ex.journal_claimed_outcome(
        op_id,
        ex._journal_record(
            entry_name, kind, effects, params, plan, op_id, after,
            verification, last_result, 1,
            approval_audit=approval_audit,
            undo_available=bool(entry.get("undo"))),
        claim_token)
    release_conflict_lock(op_id, pending_dir)
    _delete_pending_file(pending_file)
    _delete_brief_files(pending.get("brief_dir"), op_id)
    _shutdown_form_host()
    return {
        "op_id": op_id,
        "entry_name": entry_name,
        "verification": verification,
        "receipt": last_result["receipt"],
        "truncated": last_result["truncated"],
        "bytes_received": last_result["bytes_received"],
        "attempts": 1,
        # W6-P1-H1: per-change undoability disclosure on the receipt.
        "undo_available": bool(entry.get("undo")),
    }


def _start_verify_phase(pending, pending_file, vblock, vop, form_host,
                        brief_dir, reason):
    op_id = pending["op_id"]
    lane = pending["lane"]
    brief = _render_brief_or_blocked(
        [vop], lane["base"], principal=lane.get("principal"),
        batch_id="batch-%s-verify" % op_id[:8],
        form_host=form_host,
        provider=lane["provider"])
    brief_file = _write_secret_file(
        _brief_path(brief_dir, op_id, "verify"), brief)
    pending["verify_op_id"] = vop["op_id"]
    _write_secret_file(pending_file, json.dumps(pending, indent=2,
                                                sort_keys=True, default=str))
    return {
        "status": "awaiting_browser_task",
        "phase": "verify",
        "op_id": op_id,
        "entry_name": pending["entry_name"],
        "kind": pending["kind"],
        "batch_id": "batch-%s-verify" % op_id[:8],
        "brief_file": brief_file,
        "pending_file": pending_file,
        "ops": [vop["op_id"]],
        "reason": reason,
    }


def complete_browser_verify(op_id, report_text, lane_state=None,
                            pending_dir=None, form_host=None, pending_file=None,
                            claim_token=None):
    """Finish a verify phase parked by complete_browser_request.

    Journals the op (pass or fail, mirroring the https backend) and returns
    the receipt. Raises VerificationFailed on assertion failure, and
    UncertainWrite (journaled as uncertain) when the verify readback did
    not complete.

    claim_token: the dispatch-time journal claim token, threaded through
    the orchestrator's own memory (W5-P0-1). The persisted envelope no
    longer stores the raw token, only its hash, so the verify phase
    cannot recover it from disk: without the explicit token argument
    the claim cannot be re-validated and the verify is refused with
    DuplicateOpId (recover via the claim-release CLI, then re-dispatch).
    No disk-derived token is ever honored: a token read from the
    envelope would be observable by any same-uid process and would
    reintroduce the W4-P0-2 bypass the envelope fix closed.
    """
    op_id = ex.check_uuid(op_id)
    pending_file = pending_file or _pending_path(pending_dir, op_id)
    if not os.path.exists(pending_file):
        raise ex.ExecutorError(
            "no pending browser op %s; the request phase was never completed "
            "or was already finished" % op_id)
    with open(pending_file, "r", encoding="utf-8") as fh:
        pending = json.load(fh)
    # P0-6: resolve the lock directory from the request-phase envelope when
    # the caller did not pass one explicitly.
    pending_dir = pending_dir or pending.get("pending_dir")
    entry = pending["entry"]
    params = pending["params"]
    plan = None
    if pending.get("plan_path"):
        plan = ex.load_frozen_plan(pending["plan_path"], entry.get("name"))
    entry_name = pending["entry_name"]
    kind = pending.get("kind", "dispatch")
    effects = entry.get("effects", "read")
    # The op is not journaled yet, so the duplicate check passes; the write
    # halt is re-checked because re-auth may have intervened between phases.
    # The frozen plan was already enforced by the request phase (resume=True).
    # W2-P0-18: re-validate the dispatch-time journal claim via its token
    # instead of claiming twice. W5-P0-1: liveness alone is NOT
    # authorization (any same-uid process can observe a live claim), so
    # the old tokenless claim_is_live fallback is gone, and so is the
    # pre-fix fallback that read the raw token back out of the pending
    # envelope: a disk token is observable by any same-uid process, so
    # honoring it would reintroduce the W4-P0-2 bypass the envelope fix
    # closed. The verify phase must carry the token the orchestrator
    # received from the dispatch envelope through its own memory; the
    # explicit argument is always required.
    _vtoken = claim_token
    if _vtoken:
        ex._check_write_gates(entry, params, plan, op_id, kind, resume=True,
                              claim_token=_vtoken)
    else:
        raise ex.DuplicateOpId(
            "verify for op %s carries no claim token; refusing to adopt "
            "an unowned claim (W5-P0-1: the pending envelope no longer "
            "stores the raw token; the orchestrator must pass the "
            "dispatch claim token)" % op_id)
    claim_token = _vtoken
    # Re-verify the write approval against the pending envelope's
    # entry/params/tenant before anything is journaled.
    approval_audit = _admission.reverify_approval(
        entry, params, pending.get("lane", {}).get("base"), op_id)
    # P0-5: guarded write stage. The verify phase also requires the pinned
    # principal, refuses a lane that reconnected since dispatch, and fails
    # closed on a mismatched principal attestation.
    _require_principal_for_write(
        entry, pending.get("lane", {}).get("principal"), "verify")
    if lane_state is not None:
        _, _, _verify_principal = _lane_for(
            pending.get("lane", {}).get("provider", "canvas"), lane_state)
        _recheck_pinned_principal(pending.get("lane", {}).get("principal"),
                                  _verify_principal, op_id, "verify")
    _check_session_generation(pending.get("session_generation"), lane_state,
                              pending.get("lane", {}).get("provider", "canvas"),
                              op_id, "verify")

    results = batch.parse_results(report_text)
    check_principal_attestation(
        report_text, pending.get("lane", {}).get("principal"))
    if results.get("session_dead"):
        # W4-P2-1: arm the re-auth machinery before raising. The write
        # itself already returned 2xx and was journaled by the request
        # phase; the quarantine metadata records that this op still
        # needs its verify decision after re-authentication.
        _on_browser_session_death(
            op_id, (entry or {}).get("name", "browser_verify"),
            "browser session died during the verify phase; the write "
            "itself already returned 2xx (see the pending file)",
            write_sent=True)
        raise BrowserSessionDead(
            "browser session died during the verify phase; the write itself "
            "already returned 2xx (see the pending file), re-run verify with "
            "a fresh browser task after re-authenticating")

    vop_id = pending.get("verify_op_id", op_id + "-verify")
    by_id = {r["op_id"]: r for r in results.get("results", [])}
    r = by_id.get(vop_id)
    last_payload = pending["result_payload"]
    transients = pending.get("transients") or {}
    last_result = {"payload": last_payload,
                   "receipt": pending["result_receipt"],
                   "truncated": False,
                   "bytes_received": 0}
    # Defensive: a pending file written before the vault landed (or by an
    # older build) could carry a raw receipt. Project again here; it is a
    # no-op for receipts that are already projected.
    _verify_lane = pending.get("lane", {}) or {}
    last_result = _project_learner_result(
        entry, last_result, _verify_lane.get("base"),
        {"principal": _verify_lane.get("principal"),
         "session_generation": pending.get("session_generation"),
         "lane_state": lane_state,
         "provider": _verify_lane.get("provider")})

    verify = entry.get("verify") or {}
    # P0-5: a redirect during the verify read is never followed. The write
    # already returned 2xx, so a readback that did not complete (redirect,
    # non-2xx, or missing from the report) journals as uncertain, never
    # failed: the write keeps uncertain=True and its conflict lock, and
    # UncertainWrite surfaces it for reconciliation by readback.
    vstatus = r["status"] if r else 0
    if r and 300 <= vstatus < 400:
        detail = ("verify op %s hit a login redirect during the readback; "
                  "redirects are never followed" % vop_id)
        verification = _project_verification_detail(
            entry, {"status": "uncertain", "detail": detail}, last_payload,
            _verify_lane.get("base"),
            {"principal": _verify_lane.get("principal"),
             "session_generation": pending.get("session_generation"),
             "lane_state": lane_state,
             "provider": _verify_lane.get("provider")})
        after = ex.digest_of(last_result["receipt"])
        # W5-P1-4: atomic claim-recheck-and-journal (single
        # journal-lock hold): the request-phase claim is consumed by
        # this outcome, so two concurrent verify completes cannot
        # journal two outcomes for one op_id.
        ex.journal_claimed_outcome(
            op_id,
            ex._journal_record(
                entry_name, kind, effects, params, plan, op_id, after,
                verification, last_result, 1, uncertain=True,
                approval_audit=approval_audit,
                undo_available=bool(entry.get("undo"))),
            _vtoken)
        _delete_pending_file(pending_file)
        _delete_brief_files(pending.get("brief_dir"), op_id)
        _shutdown_form_host()
        raise ex.UncertainWrite(
            "write op %s returned success, but the readback could not "
            "confirm it: %s (journaled as uncertain, not failed)"
            % (op_id, detail))
    if not r or not (200 <= r["status"] < 300):
        detail = ("verify op %s %s" % (
            vop_id, "missing from report" if not r
            else "returned HTTP %d" % r["status"]))
        verification = _project_verification_detail(
            entry, {"status": "uncertain", "detail": detail}, last_payload,
            _verify_lane.get("base"),
            {"principal": _verify_lane.get("principal"),
             "session_generation": pending.get("session_generation"),
             "lane_state": lane_state,
             "provider": _verify_lane.get("provider")})
        after = ex.digest_of(last_result["receipt"])
        # W5-P1-4: atomic claim-recheck-and-journal (single
        # journal-lock hold): the request-phase claim is consumed by
        # this outcome, so two concurrent verify completes cannot
        # journal two outcomes for one op_id.
        ex.journal_claimed_outcome(
            op_id,
            ex._journal_record(
                entry_name, kind, effects, params, plan, op_id, after,
                verification, last_result, 1, uncertain=True,
                approval_audit=approval_audit,
                undo_available=bool(entry.get("undo"))),
            _vtoken)
        _delete_pending_file(pending_file)
        _delete_brief_files(pending.get("brief_dir"), op_id)
        _shutdown_form_host()
        raise ex.UncertainWrite(
            "write op %s returned success, but the readback could not "
            "confirm it: %s (journaled as uncertain, not failed)"
            % (op_id, detail))

    vresult = ex.apply_result_block(entry, r["body"].encode("utf-8"), {})
    try:
        verification = ex._assert_verify_expect(
            entry, verify, vresult["payload"], params, last_payload, transients)
    except ex.VerificationFailed as exc:
        # W3-P2-5: the assertion failure formats expected/read-back values
        # with %r; project the detail before journaling so learner names
        # or identifiers never reach the journal.
        after = ex.digest_of(last_result["receipt"])
        # W5-P1-4: atomic claim-recheck-and-journal (see above).
        ex.journal_claimed_outcome(
            op_id,
            ex._journal_record(
                entry_name, kind, effects, params, plan, op_id, after,
                _project_verification_detail(
                    entry, {"status": "failed", "detail": str(exc)},
                    vresult["payload"], _verify_lane.get("base"),
                    {"principal": _verify_lane.get("principal"),
                     "session_generation": pending.get("session_generation"),
                     "lane_state": lane_state,
                     "provider": _verify_lane.get("provider")}),
                last_result, 1,
                approval_audit=approval_audit,
                undo_available=bool(entry.get("undo"))),
            _vtoken)
        _delete_pending_file(pending_file)
        _delete_brief_files(pending.get("brief_dir"), op_id)
        _shutdown_form_host()
        raise ex.VerificationFailed(
            "verify block failed for op %s: %s (journaled as failed)"
            % (op_id, exc))

    # P0-8: provider readback determined success. Canonical "verified".
    verification = canonical_verification(verification)
    after = ex.digest_of(last_result["receipt"])
    # W5-P1-4: atomic claim-recheck-and-journal (single journal-lock
    # hold): the request-phase claim is consumed by this outcome, so
    # two concurrent verify completes cannot journal two outcomes for
    # one op_id.
    ex.journal_claimed_outcome(
        op_id,
        ex._journal_record(
            entry_name, kind, effects, params, plan, op_id, after,
            verification, last_result, 1,
            approval_audit=approval_audit,
            undo_available=bool(entry.get("undo"))),
        _vtoken)
    release_conflict_lock(op_id, pending_dir)
    _delete_pending_file(pending_file)
    _delete_brief_files(pending.get("brief_dir"), op_id)
    _shutdown_form_host()
    return {
        "op_id": op_id,
        "entry_name": entry_name,
        "verification": verification,
        "receipt": last_result["receipt"],
        "truncated": last_result["truncated"],
        "bytes_received": last_result["bytes_received"],
        "attempts": 1,
        # W6-P1-H1: per-change undoability disclosure on the receipt.
        "undo_available": bool(entry.get("undo")),
    }


# --------------------------------------------------------------------------
# P0-6: unresolved-create review and person close-out. An uncertain
# (applied_or_unknown) write is never replayed. It settles by provider
# readback (this review, for creates) or by the person closing it out.
# The review reads the parent collection and classifies:
#   no match        -> still applied_or_unknown; conflict lock held
#   exactly one    -> verified by provider readback; lock released
#   more than one  -> duplicate_effect_suspected; lock held; NOTHING deleted
# The person close-out sends nothing and never reports verified.
# --------------------------------------------------------------------------

def _parse_iso_ts(value):
    """Parse an ISO-8601 timestamp to epoch seconds; None when unparseable."""
    if not value or not isinstance(value, str):
        return None
    text = value.strip()
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def match_duplicate_candidates(records, field_values, created_field="created_at",
                               window_seconds=600, now=None):
    """Return records matching all field_values created inside the window.

    Pure helper (unit-testable): records is a list of dicts, field_values
    maps record field -> expected value (compared as strings), and a record
    only counts when its created_field timestamp parses and falls within
    window_seconds of now.
    """
    now_ts = (now or datetime.now(timezone.utc)).timestamp()
    matches = []
    for rec in records or []:
        if not isinstance(rec, dict):
            continue
        if any(str(rec.get(k)) != str(v) for k, v in field_values.items()):
            continue
        ts = _parse_iso_ts(rec.get(created_field))
        if ts is None:
            continue
        if abs(now_ts - ts) <= window_seconds:
            matches.append(rec)
    return matches


def _latest_journal_record(op_id):
    """Newest journal record for op_id, or None."""
    path = ex.JOURNAL_PATH
    latest = None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if rec.get("op_id") == op_id:
                    latest = rec
    except OSError:
        return None
    return latest


def begin_unresolved_create_review(op_id, entry, params, lane_state,
                                   brief_dir=None, pending_dir=None):
    """Render a browser-task brief that reads the parent collection for an
    uncertain create (P0-6).

    The entry must declare a duplicate_check spec:
      {"collection_url": "/api/v1/... (may use {canvas_base}/{params.*})",
       "match_fields": ["name", ...],        # params keys compared as strings
       "created_field": "created_at",        # optional, default shown
       "window_seconds": 600}                # optional, default shown
    Without the spec the review cannot run honestly and is refused.
    """
    entry_name = entry.get("name")
    spec = entry.get("duplicate_check") or {}
    collection_url = spec.get("collection_url")
    match_fields = spec.get("match_fields")
    if not collection_url or not match_fields:
        raise BrowserLaneBlocked(
            "entry %r declares no duplicate_check spec (collection_url and "
            "match_fields); an unresolved create cannot be reviewed without "
            "it" % entry_name)
    provider = entry.get("provider") or "canvas"
    _, base, principal = _lane_for(provider, lane_state)
    config = {"canvas_base": base}
    url = _render_url(collection_url, config, params, None, {})
    if url.startswith("/"):
        url = base + url
    _split_op_url(url, base)
    op = {"op_id": op_id + "-dupcheck", "kind": "fetch", "method": "GET",
          "url": url, "headers": {}, "body": None}
    brief = batch.render_brief(
        [op], base, principal=principal,
        batch_id="batch-%s-dupcheck" % op_id[:8], provider=provider)
    brief_file = _write_secret_file(
        _brief_path(brief_dir, op_id, "dupcheck"), brief)
    return {
        "status": "awaiting_browser_task",
        "phase": "duplicate_check",
        "op_id": op_id,
        "entry_name": entry_name,
        "batch_id": "batch-%s-dupcheck" % op_id[:8],
        "brief_file": brief_file,
        "ops": [op["op_id"]],
    }


def complete_unresolved_create_review(op_id, report_text, entry, params,
                                      pending_dir=None, brief_dir=None):
    """Classify an unresolved create from its parent-collection readback.

    Returns {"op_id", "classification", "detail", "matches"}. Classifications:
      verified                  exactly one record matched: provider readback
                                determined success; journaled, lock released.
      applied_or_unknown        zero matches (still unknown) or a failed
                                collection read; lock held.
      duplicate_effect_suspected more than one record matched: journaled as
                                applied_or_unknown with the duplicate detail;
                                lock held; nothing is deleted, ever.

    brief_dir: when given, the dupcheck brief is deleted on every terminal
    outcome (the brief retention contract). The session-dead path keeps it
    for the retry.
    """
    entry_name = entry.get("name")
    spec = entry.get("duplicate_check") or {}
    match_fields = spec.get("match_fields") or []
    created_field = spec.get("created_field", "created_at")
    window_seconds = int(spec.get("window_seconds", 600))

    def _unresolved(detail):
        return {"op_id": op_id, "classification": "applied_or_unknown",
                # W6-P1-H1: undoability disclosure on the close-out.
                "undo_available": bool(entry.get("undo")),
                "detail": detail, "matches": []}

    results = batch.parse_results(report_text)
    if results.get("session_dead"):
        raise BrowserSessionDead(
            "browser session died during the duplicate review; re-authenticate "
            "and re-run the review (the uncertain write keeps its lock)")

    def _done(result):
        # LANE2-D3: the dupcheck brief is transient like every other
        # brief: delete it on every terminal outcome. (The session-dead
        # path above keeps it for the retry, per the retention contract.)
        _delete_brief_files(brief_dir, op_id)
        return result

    found = [r for r in results.get("results", []) if r["op_id"].endswith("-dupcheck")]
    r = found[0] if found else None
    if not r or not (200 <= r["status"] < 300):
        return _done(_unresolved(
            "parent collection read %s; write stays applied_or_unknown, "
            "conflict lock held"
            % ("missing from report" if not r else "returned HTTP %d" % r["status"])))
    try:
        payload = json.loads(r["body"])
    except ValueError as exc:
        return _done(_unresolved(
            "parent collection body failed to parse (%s); write stays "
            "applied_or_unknown, conflict lock held" % exc))
    if isinstance(payload, dict):
        records = payload.get("records", payload.get("data", []))
    else:
        records = payload
    if not isinstance(records, list):
        return _done(_unresolved(
            "parent collection readback was not a record list; write stays "
            "applied_or_unknown, conflict lock held"))
    field_values = {f: params.get(f) for f in match_fields}
    matches = match_duplicate_candidates(records, field_values,
                                         created_field=created_field,
                                         window_seconds=window_seconds)
    if len(matches) == 1:
        matched = matches[0]
        verification = {"status": "verified",
                        "detail": "unresolved-create review: exactly one "
                        "record matched the requested fields inside the time "
                        "window; provider readback determines verified"}
        result = {"receipt": {"id": matched.get("id"),
                              "verified_by": "duplicate_check_readback"},
                  "truncated": False, "bytes_received": len(r["body"])}
        record = ex._journal_record(
            entry_name, "dispatch", entry.get("effects", "write"), params,
            None, op_id, ex.digest_of(matched), verification, result, 1,
            uncertain=False, undo_available=bool(entry.get("undo")))
        ex.journal_append(record)
        release_conflict_lock(op_id, pending_dir)
        _delete_pending_file(_pending_path(pending_dir, op_id))
        return _done({"op_id": op_id, "classification": "verified",
                      # W6-P1-H1: undoability disclosure on the close-out.
                      "undo_available": bool(entry.get("undo")),
                      "detail": verification["detail"], "matches": matches})
    if len(matches) > 1:
        detail = ("duplicate_effect_suspected: %d records match the "
                  "requested fields inside the time window; deleted nothing; "
                  "conflict lock held" % len(matches))
        verification = {"status": "applied_or_unknown", "detail": detail}
        result = {"payload": {"uncertain": True},
                  "receipt": {"uncertain": True, "detail": detail},
                  "truncated": False, "bytes_received": len(r["body"])}
        record = ex._journal_record(
            entry_name, "dispatch", entry.get("effects", "write"), params,
            None, op_id, None, verification, result, 1, uncertain=True,
            undo_available=bool(entry.get("undo")))
        ex.journal_append(record)
        return _done({"op_id": op_id, "classification": "duplicate_effect_suspected",
                      # W6-P1-H1: undoability disclosure on the close-out.
                      "undo_available": bool(entry.get("undo")),
                      "detail": detail, "matches": matches})
    return _done(_unresolved(
        "no record matched the requested fields inside the time window; "
        "write stays applied_or_unknown, conflict lock held"))


def close_out_by_person(op_id, fresh_read_digest, person_confirmation,
                        pending_dir=None):
    """Person close-out ceremony for an uncertain write (P0-6).

    Requires: the op's latest journal record exists and is uncertain
    (applied_or_unknown); fresh_read_digest is the exact hex digest of a
    fresh read the person performed themselves; person_confirmation is
    their explicit confirmation text. Sends nothing to the provider and
    never reports verified: the terminal state is closed_by_person. The
    conflict lock is released because the person took responsibility.
    Returns the journal record.
    """
    latest = _latest_journal_record(op_id)
    if latest is None:
        raise ex.ExecutorError(
            "op %s has no journal record; nothing to close out" % op_id)
    if not latest.get("uncertain"):
        raise ex.ExecutorError(
            "op %s is not uncertain (verification=%r); person close-out "
            "applies only to applied_or_unknown writes"
            % (op_id, latest.get("verification")))
    digest = (fresh_read_digest or "").strip()
    if len(digest) < 16 or any(c not in "0123456789abcdefABCDEF" for c in digest):
        raise ex.ExecutorError(
            "person close-out requires the exact hex digest of a fresh read; "
            "got %r" % (fresh_read_digest,))
    confirmation = (person_confirmation or "").strip()
    if not confirmation:
        raise ex.ExecutorError(
            "person close-out requires explicit person confirmation text")
    verification = {
        "status": "closed_by_person",
        "detail": ("person close-out: the educator confirmed the outcome "
                   "after their own fresh read (digest %s); the transport "
                   "sent nothing and reports verified for nothing"
                   % digest),
    }
    record = {
        "op_id": op_id,
        "entry_name": latest.get("entry_name"),
        "kind": latest.get("kind"),
        "effect": latest.get("effect"),
        "params_digest": latest.get("params_digest"),
        "plan_digest": latest.get("plan_digest"),
        "before_state_digest": latest.get("before_state_digest"),
        "after_state_digest": latest.get("after_state_digest"),
        "verification": verification["status"],
        "verification_detail": verification["detail"],
        "receipt": {"closed_by_person": True,
                    "fresh_read_digest": digest,
                    "person_confirmation": confirmation},
        "truncated": False,
        "bytes_received": 0,
        "attempts": int(latest.get("attempts", 1) or 1),
        "uncertain": False,
        "approval": latest.get("approval"),
    }
    ex.journal_append(record)
    release_conflict_lock(op_id, pending_dir)
    _delete_pending_file(_pending_path(pending_dir, op_id))
    return record
