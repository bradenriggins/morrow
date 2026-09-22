#!/usr/bin/env python3
"""Moodle session-authenticated dispatcher for Morrow Direct.

Implements the Moodle lane of the two-lane architecture (section 3.3 of
the architecture doc): one session cookie plus the visible sesskey, then
pure HTTPS from then on. Primary path is lib/ajax/service.php; the
form-path fallback covers AJAX functions the site does not expose
(the `ajax => true` flag is per-function data and drifts per version).

Rules from the architecture, enforced here:
  - Receipts: every op produces a bounded receipt with identifying
    fields only (id, name), no raw payloads, no learner data beyond
    what the op needs.
  - Verification: writes carry a frozen readback; the readback digest
    goes in the journal entry.
  - Single-use op ids: dispatch refuses an op id already in the used
    set (best-effort client-side guard, documented as weaker than the
    server-side set). The set is rehydrated from the append-only
    journal at startup, so a process restart cannot replay an op id
    that was already journaled as dispatched.
  - Truncation: any result over the byte cap is truncated head with a
    flag; payloads never land whole in the journal.
  - Expiry classification (see reauth.py): requireloginerror and
    login-page redirects are re-authentication events; a 30x whose
    Location header targets /login is reauth on every path; an HTTP
    200 carrying a non-JSON body on the AJAX path (dead session
    serving the login page) is reauth, never "ok"; invalidsesskey
    is a sesskey refresh; everything else is a plain error, never a
    silent retry.

The cookie jar lives in the requests.Session held in memory; nothing
in this module writes cookie values or the sesskey to disk or stdout.

Contract:
  sess = MoodleSession.from_bundle(login.bootstrap(...))
  sess.ajax("core_course_get_contents", {"courseid": 2}, op_id=...)
  sess.write(op)            # frozen plan dict -> dispatch -> verify -> journal
  sess.journal_path         # JSONL path (append-only by convention)

Frozen plan shape (writer-side):
  {"op_id": uuid, "tool": "mod_forum_add_discussion",
   "args": {...}, "verify": {"method": "mod_forum_get_forum_discussions",
                             "args": {...}, "match": {"field": "subject",
                                                      "value": "..."}},
   "undo": {"method": "mod_forum_delete_discussion",
            "args_from_verify": {"discussionid": "id"}}}
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urljoin, urlparse

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None  # type: ignore

USER_AGENT = "morrow-moodle-lane/0.1 (session-authenticated dispatch)"
DEFAULT_TIMEOUT = 25
RESULT_MAX_BYTES = 2048  # receipt-bounding cap; payloads truncated head

SERVICE_URL_TMPL = "{base}/lib/ajax/service.php"

# Moodle WS error codes that mean "this session is dead / gone".
# Source-grounded (Moodle 5.2, public/lib/external/classes/external_api.php,
# call_external_function): service.php answers HTTP 200 with an error
# envelope. Live-observed on sandbox.moodledemo.net 2026-09-20:
#   servicerequireslogin -> thrown when loginrequired && !isloggedin()
#   requireloginerror    -> kept for older branches / page flows
#   sessionerror         -> kept for older branches
# An invalid sesskey is NOT a dead session (session fine, visible value
# stale): the classifier separates it into "sesskey" -> refresh and retry.
REAUTH_ERRORCODES = {"servicerequireslogin", "requireloginerror",
                     "sessionerror"}
# A bad sesskey is NOT a dead session: the session is fine, the visible
# value was stale. Refresh it from a live page and retry once.
SESSKEY_ERRORCODES = {"invalidsesskey"}


def normalize_moodle_base(raw):
    """W4-P1-5: Moodle bases must be HTTPS unless explicitly overridden.

    The lane carries the educator's session cookies, credentials, and
    sesskey, so a plaintext base would ship them unencrypted. An
    http:// base is refused loudly unless the educator explicitly sets
    MOODLE_BASE_ALLOW_HTTP=1 (test fixtures and LAN-only deployments
    only; never for a real tenant). Call this BEFORE any session is
    created or any cookie is attached, so no secret ever touches
    plaintext.
    """
    raw = (raw or "").strip().rstrip("/")
    if not raw:
        raise ValueError("Moodle base URL is empty")
    parsed = urlparse(raw if "://" in raw else "https://" + raw)
    if parsed.scheme == "http" and os.environ.get(
            "MOODLE_BASE_ALLOW_HTTP") != "1":
        raise ValueError(
            "refusing plaintext http:// Moodle base %r: session cookies "
            "and credentials would cross the network unencrypted. Use "
            "https://, or set MOODLE_BASE_ALLOW_HTTP=1 to acknowledge "
            "the risk (test fixtures and LAN-only deployments only)."
            % raw)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("could not parse Moodle base URL: %r" % raw)
    return parsed.scheme + "://" + parsed.netloc


class MoodleLaneError(Exception):
    """Base lane error. Carries a machine-readable class and the raw signal."""

    def __init__(self, kind: str, detail: str, signal: Optional[Dict] = None):
        super().__init__("%s: %s" % (kind, detail))
        self.kind = kind          # "reauth" | "sesskey" | "provider" | "network"
        self.detail = detail
        self.signal = signal or {}


class SafeRedirectSession(requests.Session if requests is not None else object):
    """requests.Session with redirect-downgrade refusal (W4-P2-7).

    The moodle lane follows redirects in the page-format paths
    (login bootstrap, sesskey/principal discovery, lane detect).
    Stock requests strips the Authorization header only when the
    redirect target's HOST changes: a same-host https:// -> http://
    downgrade keeps session cookies and any Authorization header,
    crossing plaintext. This subclass:

    - REFUSES an https->http downgrade loudly on every redirect hop
      (fail closed): raises MoodleLaneError("network", ...) naming
      the downgrade BEFORE the downgraded request is sent. The
      refusal lives in get_redirect_target(), which requests calls
      to resolve the Location header before building the next
      request: no request bytes ever reach the plaintext target.
      (An earlier draft overrode resolve_redirects() and iterated
      the generator, which only sees each hop AFTER requests has
      already sent it: the downgraded request would already be on
      the wire. Never check post-send.)
    - REFUSES a redirect to another host or port (a 307/308 would
      re-send the body, e.g. the login form with the password).
    - STRIPS Authorization and Proxy-Authorization on any scheme
      change, even same-host (stricter than stock requests). The
      stripping lives in rebuild_auth(), which requests calls
      before sending each redirected request.

    Use this class for every requests.Session() in the moodle lane
    and lanes/detect.py. The AJAX/form API paths already use
    allow_redirects=False and are unaffected.
    """

    def rebuild_auth(self, prepared_request, response):
        url = prepared_request.url or ""
        previous = (response.request.url or "") if response is not None \
            and response.request is not None else ""
        if urlparse(url).scheme != urlparse(previous).scheme:
            # Scheme changed (e.g. https -> http on the same host):
            # strip credential headers even though the host matches.
            # (On same-scheme redirects, fall through to requests'
            # stock host-change stripping.)
            prepared_request.headers.pop("Authorization", None)
            prepared_request.headers.pop("Proxy-Authorization", None)
        else:
            super().rebuild_auth(prepared_request, response)

    def get_redirect_target(self, resp):
        target = super().get_redirect_target(resp)
        if target is None:
            return None
        prev = resp.request if resp is not None else None
        prev_url = (prev.url or "") if prev is not None else ""
        prev_scheme = urlparse(prev_url).scheme
        # Location may be relative ("/foo"); resolve it against the
        # URL that produced the redirect before judging the scheme.
        resolved = urlparse(urljoin(resp.url or prev_url, target))
        new_scheme = resolved.scheme
        prev_parts = urlparse(prev_url)
        if (resolved.hostname or "").lower() != \
                (prev_parts.hostname or "").lower() \
                or resolved.port != prev_parts.port:
            # A 307/308 re-sends the body (the login form carries the
            # password), so the lane never follows a redirect off the
            # Moodle host.
            raise MoodleLaneError(
                "network",
                "refused redirect off the Moodle host: %s -> %s (no "
                "request was sent to the other host)" % (prev_url, target))
        if prev_scheme == "https" and new_scheme == "http":
            raise MoodleLaneError(
                "network",
                "refused https->http redirect downgrade: %s -> %s "
                "(session credentials would cross plaintext; no "
                "request was sent to the http target)"
                % (prev_url, target))
        return target


def classify_signal(http_status: int, final_url: str,
                    envelope: Optional[Dict[str, Any]],
                    expect_envelope: bool = True,
                    location: Optional[str] = None) -> Tuple[str, str]:
    """Classify a response into reauth / sesskey / provider / ok.

    Returns (kind, detail). This is the Moodle half of the Lane 2
    re-authentication state machine (architecture section 3.2):
      - detect: HTTP-level (a 30x whose Location header targets
        /login) or envelope-level (errorcode requireloginerror /
        sessionerror / servicerequireslogin), or an HTTP 200 with a
        non-JSON body on the AJAX path (dead session serving the
        login page instead of the AJAX envelope).
      - everything else is NOT a re-auth event; invalidsesskey means
        refresh the visible value, provider errors halt the op.

    expect_envelope: True on the AJAX path (service.php always
    answers with the JSON envelope list, so a 200 without one means
    the session is dead and the site served a page instead). False
    on the form path (forms legitimately answer with HTML pages).
    location: the Location response header when redirects were not
    followed (the AJAX and form paths use allow_redirects=False, so
    resp.url is the REQUEST url, which never contains /login; the
    redirect target lives in the header).
    """
    if http_status in (301, 302, 303, 307, 308):
        if "/login" in (location or "") or "/login" in (final_url or ""):
            return "reauth", "redirected to the login page (HTTP %d)" % http_status
    if http_status == 403 and envelope is None:
        # Moodle serves the login page as 403-with-body on some setups;
        # without an envelope we cannot classify further: treat as reauth
        # only when the URL or the redirect target proves it.
        if "/login" in (final_url or "") or "/login" in (location or ""):
            return "reauth", "HTTP 403 at the login page"
        return "provider", "HTTP 403 without an error envelope"
    if envelope and envelope.get("error"):
        exc = envelope.get("exception") or {}
        code = exc.get("errorcode", "")
        msg = exc.get("message", "") or code
        if code in REAUTH_ERRORCODES:
            return "reauth", "errorcode %s: %s" % (code, _clip(msg))
        if code in SESSKEY_ERRORCODES:
            return "sesskey", "errorcode %s: refresh the sesskey and retry once" % code
        return "provider", "errorcode %s: %s" % (code, _clip(msg))
    if http_status != 200:
        return "network", "HTTP %d without a Moodle error envelope" % http_status
    if envelope is None and expect_envelope:
        # A 200 with a non-JSON body on the AJAX path: the session is
        # dead and the site served the login page instead of the AJAX
        # envelope. This is a re-auth event, never "ok" (the old "ok"
        # verdict fell through to env.get("data") and died as an
        # unhandled AttributeError instead of engaging the state
        # machine).
        return "reauth", ("HTTP 200 without a Moodle AJAX envelope: "
                          "login page served on the AJAX path, session dead")
    return "ok", "no error signal"


def _clip(text: str, n: int = 220) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[:n] + "..."


def _digest(obj: Any) -> str:
    return hashlib.sha256(
        json.dumps(obj, sort_keys=True, default=str).encode("utf-8")).hexdigest()


def _receipt(data: Any, fields: List[str]) -> Dict[str, Any]:
    """Extract the minimal identifying fields for the journal receipt."""
    if isinstance(data, dict):
        return {f: data.get(f) for f in fields if f in data}
    if isinstance(data, list) and data:
        return {"count": len(data),
                "first": {f: data[0].get(f) for f in fields
                          if isinstance(data[0], dict) and f in data[0]}}
    return {"count": 0 if data is None else 1}


class MoodleSession:
    """An authenticated Moodle session: cookie jar + sesskey + dispatch."""

    def __init__(self, base: str, session: "requests.Session", sesskey: str,
                 principal: Optional[Dict[str, Any]] = None,
                 journal_dir: Optional[str] = None,
                 timeout: int = DEFAULT_TIMEOUT):
        # W4-P1-5: normalize (and HTTPS-enforce) the base BEFORE any
        # session or cookie is used, so no secret ever touches plaintext.
        self.base = normalize_moodle_base(base)
        self.session = session
        self.sesskey = sesskey
        self.principal = principal or {}
        self.timeout = timeout
        self.journal_dir = journal_dir or os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "..", "journal", "moodle")
        os.makedirs(self.journal_dir, exist_ok=True)
        self.journal_path = os.path.join(self.journal_dir, "moodle.jsonl")
        # The journal is the durable record; rehydrate the used-op-id
        # set from it so a process restart cannot replay an op id that
        # was already journaled as dispatched (the in-memory set alone
        # evaporates on restart, and Moodle AJAX calls are not
        # idempotent server-side, so this guard is the only replay
        # protection the lane has).
        self.used_op_ids: set = self._rehydrate_op_ids()
        self._refresh_sesskey_tried = False
        # W4-P2-1: the Moodle lane's re-auth machine (same lifecycle
        # requirements as the Chromium lane). Created on the first
        # classified reauth signal; while it holds the halt, write()
        # refuses loudly and nothing retries against the dead session.
        self._reauth_machine = None

    # -- re-auth lifecycle (W4-P2-1) --------------------------------------

    def _check_reauth_halt(self):
        """Refuse writes while the re-auth machine holds the halt.

        Recovery is verified resume (ReauthMachine.reauthenticate, with
        non-vacuous principal pinning) plus fresh per-op approval of the
        quarantined ops (ReauthMachine.resume); nothing auto-resumes.
        """
        if (self._reauth_machine is not None
                and self._reauth_machine.state not in ("healthy",)):
            raise MoodleLaneError(
                "reauth",
                "Moodle writes are halted: the session died (state=%s) "
                "and the educator has not re-authenticated with a pinned "
                "principal and re-approved the quarantined ops. Sign in "
                "again; nothing was retried against the dead session."
                % self._reauth_machine.state)

    def engage_reauth_machine(self, op_id, tool, args, detail):
        """W4-P2-1: run the re-auth lifecycle on a classified reauth signal.

        Detect -> halt writes -> quarantine (park) the in-flight op ->
        notify the educator -> raise loudly. Nothing is retried against
        the dead session; the op's id reservation is released so the
        educator can re-dispatch the same op_id after verified resume
        and fresh per-op approval (the reauth signal proves the response
        came from the login path, not from an applied write).
        """
        try:
            from .reauth import ReauthMachine
        except ImportError:  # script usage: python3 moodle/session.py
            from reauth import ReauthMachine
        if self._reauth_machine is None:
            self._reauth_machine = ReauthMachine(self)
        machine = self._reauth_machine
        machine.on_signal({"classified_as": "reauth", "detail": detail})
        machine.park_inflight({"op_id": op_id, "tool": tool, "args": args})
        note = machine.notify()
        self.used_op_ids.discard(op_id)
        raise MoodleLaneError("reauth", note,
                              {"op_id": op_id, "tool": tool,
                               "quarantined": True})

    @classmethod
    def from_bundle(cls, bundle: Dict[str, Any],
                    **kw: Any) -> "MoodleSession":
        return cls(bundle["base"], bundle["session"], bundle["sesskey"],
                   principal=bundle.get("principal", {}), **kw)

    # -- low-level paths ------------------------------------------------

    def _ajax_call(self, methodname: str, args: Dict[str, Any]) -> Dict[str, Any]:
        """One AJAX envelope call. Returns the envelope dict (error or data)."""
        url = SERVICE_URL_TMPL.format(base=self.base)
        body = json.dumps([{"index": 0, "methodname": methodname,
                            "args": args}])
        resp = self.session.post(
            url,
            params={"sesskey": self.sesskey, "info": methodname},
            data=body,
            headers={"Content-Type": "application/json",
                     "User-Agent": USER_AGENT},
            timeout=self.timeout,
            allow_redirects=False,
        )
        try:
            payload = resp.json()
        except Exception:
            payload = None
        # Live-observed on 5.2: most errors arrive as the [ {error, exception} ]
        # envelope, but a call to a function that is NOT REGISTERED in the
        # external_functions table (e.g. mod_forum_delete_discussion, which
        # 5.2's forum db/services.php does not list) throws in
        # external_function_info, OUTSIDE the try block, and arrives as a
        # top-level {"error": "...", "errorcode": "invalidrecordunknown"}
        # dict. Verified identical to a totally nonexistent function name
        # 2026-09-20. Normalize both into one envelope shape, but flag the
        # top-level case: it means "no such function", not a domain error.
        envelope: Optional[Dict[str, Any]]
        top_level_error = False
        if isinstance(payload, list) and payload:
            envelope = payload[0]
        elif isinstance(payload, dict) and payload.get("errorcode"):
            top_level_error = True
            envelope = {"error": True,
                        "exception": {"errorcode": payload.get("errorcode"),
                                      "message": payload.get("error")}}
        else:
            envelope = None
        kind, detail = classify_signal(resp.status_code, resp.url, envelope,
                                        location=resp.headers.get("Location"))
        if top_level_error and kind == "provider":
            kind = "not_registered"
            detail = ("no such webservice function on this deployment "
                      "(%s)" % detail)
        if kind == "sesskey" and not self._refresh_sesskey_tried:
            self._refresh_sesskey_tried = True
            self.refresh_sesskey()
            return self._ajax_call(methodname, args)
        if kind != "ok":
            raise MoodleLaneError(kind, detail,
                                  {"method": methodname, "http": resp.status_code})
        self._refresh_sesskey_tried = False
        return envelope

    def ajax(self, methodname: str, args: Dict[str, Any],
             receipt_fields: Optional[List[str]] = None) -> Dict[str, Any]:
        """Session-authenticated AJAX read. Raises MoodleLaneError on failure.

        W4-P2-1: a reauth signal on a read also engages the re-auth
        lifecycle (halt + quarantine + notify), so a session death
        discovered by a read still stops subsequent writes.
        """
        try:
            env = self._ajax_call(methodname, args)
        except MoodleLaneError as exc:
            if exc.kind == "reauth":
                self.engage_reauth_machine(
                    "read-%s" % uuid.uuid4().hex[:12], methodname, args,
                    exc.detail)
            raise
        data = env.get("data")
        raw = json.dumps(data, default=str)
        truncated = len(raw) > RESULT_MAX_BYTES
        if truncated:
            raw = raw[:RESULT_MAX_BYTES]
        return {
            "data": data,
            "truncated": truncated,
            "receipt": _receipt(data, receipt_fields or ["id", "name"]),
            "http": 200,
        }

    def refresh_sesskey(self) -> None:
        """Re-discover the visible sesskey from a live authenticated page."""
        try:
            from .login import discover_sesskey
        except ImportError:
            # Script usage (python3 session.py helpers with moodle/ on
            # sys.path): the package-relative import fails, fall back.
            from login import discover_sesskey
        self.sesskey = discover_sesskey(self.session, self.base, self.timeout)
        self.journal("sesskey.refresh", {},
                     {"sesskey_len": len(self.sesskey), "status": "refreshed"})

    # -- governance: journal + used-op-id set ----------------------------

    def _rehydrate_op_ids(self) -> set:
        """Rebuild the used-op-id set from the append-only journal.

        Every journal line carries its op_id, so every id ever
        journaled is refused again after a restart. Corrupt lines are
        skipped (a bad line must never kill startup); a missing
        journal means a fresh set.
        """
        ids = set()
        try:
            with open(self.journal_path, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except ValueError:
                        continue
                    op_id = rec.get("op_id") if isinstance(rec, dict) else None
                    if op_id:
                        ids.add(str(op_id))
        except OSError:
            pass
        return ids

    def journal(self, tool: str, args: Dict[str, Any],
                receipt: Dict[str, Any],
                op_id: Optional[str] = None,
                verify: Optional[Dict[str, Any]] = None) -> str:
        """Append one receipted journal line. Append-only by convention."""
        op_id = op_id or str(uuid.uuid4())
        line = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "op_id": op_id,
            "tool": tool,
            "args_digest": _digest(args),
            "receipt": receipt,
            "verify": verify or {"status": "n/a"},
            # Shapes only: lengths and IDs, never cookie/sesskey values.
            "session": {"sesskey_len": len(self.sesskey),
                        "principal": self.principal},
        }
        with open(self.journal_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(line, default=str) + "\n")
        return op_id

    def _reserve(self, op_id: str) -> None:
        if op_id in self.used_op_ids:
            raise MoodleLaneError("provider",
                                  "op id %s already used; refusing double dispatch"
                                  % op_id)
        self.used_op_ids.add(op_id)

    # -- write path: frozen plan -> dispatch -> verify -> journal --------

    def write(self, plan: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a frozen write plan: dispatch, verify, journal.

        plan = {"op_id", "tool" (AJAX methodname or "form:<url>"),
                "args", "verify": {...}, "receipt_fields": [...]}
        """
        op_id = plan.get("op_id") or str(uuid.uuid4())
        tool = plan["tool"]
        args = plan.get("args", {})
        self._reserve(op_id)
        # W4-P2-1: refuse loudly while the re-auth halt stands; the
        # reservation is released so the op_id stays reusable after
        # verified resume and fresh per-op approval.
        try:
            self._check_reauth_halt()
        except MoodleLaneError:
            self.used_op_ids.discard(op_id)
            raise

        try:
            if tool.startswith("form:"):
                env = self.form_write(tool[5:], args)
                data = env
            else:
                env = self._ajax_call(tool, args)
                data = env.get("data")
        except MoodleLaneError as exc:
            if exc.kind == "reauth":
                # W4-P2-1: never write through a dead session. Engage
                # the re-auth lifecycle (halt + quarantine + notify);
                # engage_reauth_machine raises, so this never falls
                # through to the journal below.
                self.used_op_ids.discard(op_id)
                self.engage_reauth_machine(op_id, tool, args, exc.detail)
            raise

        receipt = _receipt(data, plan.get("receipt_fields", ["id", "name"]))
        verify_block = plan.get("verify")
        verify_result: Dict[str, Any] = {"status": "n/a"}
        if verify_block:
            verify_result = self._run_verify(verify_block)

        self.journal(tool, args, receipt, op_id=op_id, verify=verify_result)
        return {"op_id": op_id, "receipt": receipt, "verify": verify_result}

    def _run_verify(self, verify: Dict[str, Any]) -> Dict[str, Any]:
        """Run the frozen readback and assert the expected fields."""
        method = verify["method"]
        args = verify.get("args", {})
        env = self._ajax_call(method, args)
        data = env.get("data")
        match = verify.get("match", {})
        field, value = match.get("field"), match.get("value")
        found = None
        items = data if isinstance(data, list) else (
            data.get("discussions", []) if isinstance(data, dict) else [])
        for item in items if isinstance(items, list) else []:
            if isinstance(item, dict) and str(item.get(field)) == str(value):
                found = item
                break
        ok = found is not None
        return {
            "status": "verified" if ok else "FAILED",
            "method": method,
            "matched_id": found.get("id") if isinstance(found, dict) else None,
            "match_field": field,
        }

    def form_write(self, path: str, fields: Dict[str, Any]) -> Dict[str, Any]:
        """Form-path fallback for functions the site does not AJAX-expose.

        path is relative, e.g. "/mod/forum/post.php". The sesskey goes in
        the form body as required by stock Moodle forms.
        """
        fields = dict(fields)
        fields.setdefault("sesskey", self.sesskey)
        resp = self.session.post(self.base + path, data=fields,
                                 headers={"User-Agent": USER_AGENT},
                                 timeout=self.timeout,
                                 allow_redirects=False)
        # Form posts legitimately answer with HTML pages, so the
        # envelope is not expected here; a 30x to /login (read from
        # the Location header, since redirects are not followed) is
        # still a re-auth event.
        kind, detail = classify_signal(resp.status_code, resp.url, None,
                                       expect_envelope=False,
                                       location=resp.headers.get("Location"))
        if kind != "ok":
            raise MoodleLaneError(kind, detail,
                                  {"form": path, "http": resp.status_code})
        return {"form_posted": path, "http": resp.status_code}
