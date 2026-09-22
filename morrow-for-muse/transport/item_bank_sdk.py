#!/usr/bin/env python3
"""Item Banks SDK lane: Item Bank item CRUD through the quiz-api host.

Why this module exists: the public Canvas REST path
/api/quiz/v1/courses/:id/item_banks/:bank_id/items is not the working
surface for item CRUD (it 500s). The working surface is the private
Quizzes 2 Item Banks SDK on the tenant's quiz-api host
(https://<tenant>.quiz-api-<region>.instructure.com/api/banks/...),
authorized by the LTI-provisioned banks.build token. Meridian production
runs item CRUD through this surface daily; this module ports that
mechanism (not Meridian's code) into the Chromium lane.

Mechanism (all inside the educator's Chromium via CDP):

  1. Resolve the Item Banks LTI tool id dynamically:
     GET /api/v1/courses/{course_id}/external_tools, first tool whose
     name contains "Item Banks" (case-insensitive). Never hardcoded:
     the old 54065 id was one tenant's id, not a contract.
  2. Open one persistent CDP session on a dedicated tab, enable the
     Network domain, and navigate to
     {canvas_base}/courses/{course_id}/external_tools/{tool_id}
     (fallback: {canvas_base}/courses/{course_id}/banks, the route the
     2026-09-21 Chromium write battery proved on this tenant).
     The Item Banks app boots and issues API calls to the tenant's
     quiz-api host; the Authorization header of the first such request
     is captured through CDP Network interception (requestWillBeSent),
     together with its AuthType header. (The banks.build response body
     is not used: on the /banks route the app issues its calls from a
     Web Worker, and Network.getResponseBody cannot serve a
     worker-issued response to the page session.)
  3. Take the quiz-api origin from the captured request's own origin
     (per tenant, never hardcoded); the auth type comes from the
     request's AuthType header, default "Signature".
  4. Create an isolated world in the tab's root frame
     (Page.createIsolatedWorld); every item call runs as one fetch
     evaluated in that frame's execution context, with
     {Accept: application/json, Authorization: <captured value>,
      AuthType: <auth type>, Content-Type: application/json}.

Token hygiene: the captured token lives only in this object's memory,
bound to the course the LTI launch was made from. It is never logged,
never persisted, never returned from request() (only (status, body)
come back), and is wiped by close(). Cross-course reuse is a hard
failure, not a warning.

Item payload contract (ported from the proven disposable builder):
fields nest under top-level "item" (opposite of New Quiz items, which
nest under item.entry). Update is PATCH, never PUT. Delete is
attempted only against disposable objects in the live battery; until
proven it is not claimed.

Surfaces routed here (see is_sdk_item_path): every /api/banks/... path,
i.e. bank-level ops (create/rename/share/archive/list) and item-level
ops (create/get/update/delete). quiz_entries routes stay on their own
evidence-hold path and are never routed here.

Stdlib only.
"""

import json
import re
import time
import urllib.parse

# ---------------------------------------------------------------------------
# Pure helpers (unit-tested with a mocked CDP client)
# ---------------------------------------------------------------------------

SDK_TOKEN_URL_FRAGMENT = "/api/sdk_tokens/banks.build"
_DEFAULT_AUTH_TYPE = "Signature"

# Matches every quiz-api Item Banks path the catalog rows use, on any
# origin: /api/banks, /api/banks/{id}, /api/banks/{id}/items,
# /api/banks/{id}/items/{item}, /api/banks/{id}/bank_entries[/...],
# /api/banks/{id}/shared_banks[/...].
_SDK_ITEM_PATH_RE = re.compile(r"^/api/banks(?:/|$)", re.IGNORECASE)


def _remove_dot_segments(pure_path: str) -> str:
    """RFC 3986 dot-segment removal, mirroring what fetch() does to the
    concatenated api_origin + path in _ITEM_FETCH_JS. "." segments
    vanish; ".." pops the previous segment (never above the root).
    Percent-encoded dots (%2e, any case) count as dots because the URL
    parser decodes them before normalizing; other encoded characters
    (e.g. %2F) stay inside their segment, exactly as the parser treats
    them, so they can never pop a segment."""
    out = []
    for seg in pure_path.split("/"):
        decoded = urllib.parse.unquote(seg)
        if decoded == ".":
            continue
        if decoded == "..":
            # Never pop the leading "" that marks the root slash.
            if len(out) > 1 or (out and out[0] != ""):
                out.pop()
            continue
        out.append(seg)
    return "/".join(out)


def is_sdk_item_path(path: str) -> bool:
    """True when a request path belongs on the Item Banks SDK lane.

    The gate models what the browser's fetch() will do with
    api_origin + path, because the banks.build token rides along:
    - Absolute URLs are refused outright (LANE2-D14): the lane's
      contract is a relative path, and an absolute URL is URL/path
      confusion (the old code accepted one and only the JS string
      concatenation kept the token on-origin by accident).
    - ASCII tab/newline are stripped first: the URL parser removes
      them before parsing, so "/api/banks/\\n../admin" resolves to
      "/api/admin" while the raw string still matches ^/api/banks.
    - Backslashes become separators: for https URLs the parser treats
      "\\" as "/", so "/api/banks\\../admin" resolves to "/api/admin".
    - Dot segments are then removed the way fetch() removes them:
      percent-encoded dots count as dots; other encoded characters
      (e.g. %2F, %5C) stay inside their segment and can never pop one,
      exactly as the parser treats them.
    Only a normalized path still under /api/banks/ passes.
    """
    try:
        parsed = urllib.parse.urlparse(str(path or ""))
    except Exception:  # noqa: BLE001 - an unparsable path is not SDK
        return False
    if parsed.scheme or parsed.netloc:
        return False
    if parsed.fragment:
        # LANE2-D17: a fragment never reaches the server (fetch() strips
        # it, and the chromium backend drops it before routing), so a
        # fragment in an SDK path is meaningless. Refuse outright rather
        # than accepting a path-plus-fragment: the lane's contract is a
        # bare path, optionally with a query string. (Query strings stay
        # accepted: chromium_session reattaches parsed.query when routing
        # SDK paths, e.g. for pagination, and the gate validates the path
        # component, which is the confinement boundary.)
        return False
    pure = parsed.path or ""
    # WHATWG tab/newline stripping, then backslash-as-separator for the
    # https api_origin: both happen in the parser before dot-segment
    # removal, so the gate must apply them before _remove_dot_segments.
    pure = pure.replace("\t", "").replace("\n", "").replace("\r", "")
    pure = pure.replace("\\", "/")
    return bool(_SDK_ITEM_PATH_RE.match(_remove_dot_segments(pure)))


def derive_api_origin(quiz_lti_origin: str) -> str:
    """Derive the quiz-api origin from a quiz-lti origin.

    <tenant>.quiz-lti-<region>.instructure.com ->
    <tenant>.quiz-api-<region>.instructure.com (and the dotted variant).
    The rest of the origin is kept intact; a non-quiz-lti origin raises
    instead of guessing.
    """
    origin = str(quiz_lti_origin or "").strip().rstrip("/")
    if ".quiz-lti-" in origin:
        return origin.replace(".quiz-lti-", ".quiz-api-")
    if ".quiz-lti." in origin:
        return origin.replace(".quiz-lti.", ".quiz-api.")
    raise ItemBankSdkError(
        "cannot derive the quiz-api origin from %r: not a quiz-lti origin"
        % origin)


def origin_of(url: str) -> str:
    """Return the scheme://host origin of a URL."""
    parts = urllib.parse.urlparse(str(url or ""))
    if not parts.scheme or not parts.netloc:
        raise ItemBankSdkError(
            "cannot take the origin of %r" % str(url or ""))
    return "%s://%s" % (parts.scheme, parts.netloc)


def _is_quiz_lti_host(host: str, tenant_host=None) -> bool:
    """True when host is a quiz-lti host, optionally bound to a tenant.

    Structural check (always): one of the host's dot-separated labels is
    exactly "quiz-lti" or starts with "quiz-lti-". A bare substring match
    would trust "https://evil.example/?x=quiz-lti" or any page whose URL
    merely contains the fragment.
    Tenant binding (when tenant_host is known): the host must be the
    tenant's own quiz-lti host, "<first-label>.quiz-lti[-.]...<parent>",
    which defeats sibling hosts like
    "https://school.quiz-lti-iad-prod.example.com.evil.example/".
    """
    host = str(host or "").lower().rstrip(".")
    if not host:
        return False
    labels = host.split(".")
    if not any(label == "quiz-lti" or label.startswith("quiz-lti-")
               for label in labels):
        return False
    if tenant_host:
        tenant = str(tenant_host).lower().rstrip(".")
        first, dot, parent = tenant.partition(".")
        if not (host.startswith(first + ".quiz-lti-")
                or host.startswith(first + ".quiz-lti.")):
            return False
        if dot and not host.endswith("." + parent):
            return False
    return True


def _is_quiz_api_host(host: str, tenant_host=None) -> bool:
    """True when host is a quiz-api host, optionally bound to a tenant.

    Mirrors _is_quiz_lti_host for the sibling API origin
    (<tenant>.quiz-api-<region>.instructure.com): one dot-separated label
    is exactly "quiz-api" or starts with "quiz-api-", and with a tenant
    the host must be "<first-label>.quiz-api[-.]...<parent>". The SDK's
    item calls go to this origin, so the launch credential is captured
    from requests to exactly this host shape.
    """
    host = str(host or "").lower().rstrip(".")
    if not host:
        return False
    labels = host.split(".")
    if not any(label == "quiz-api" or label.startswith("quiz-api-")
               for label in labels):
        return False
    if tenant_host:
        tenant = str(tenant_host).lower().rstrip(".")
        first, dot, parent = tenant.partition(".")
        if not (host.startswith(first + ".quiz-api-")
                or host.startswith(first + ".quiz-api.")):
            return False
        if dot and not host.endswith("." + parent):
            return False
    return True


def _quiz_lti_frame(frame_tree, tenant_host=None):
    """(frame_id, frame_url) of the validated quiz-lti frame, or (None, None).

    The whole tree (root included) is walked; the /banks fallback route
    may host the app top-level. The frame URL must be https on a host
    that passes _is_quiz_lti_host: the old substring match trusted any
    URL containing "quiz-lti", including query strings and sibling hosts.
    """
    def _walk(node):
        if not isinstance(node, dict):
            return None, None
        frame = node.get("frame") or {}
        url = str(frame.get("url") or "")
        try:
            parts = urllib.parse.urlparse(url)
        except Exception:  # noqa: BLE001 - unparsable URL is not the frame
            parts = None
        if parts is not None and parts.scheme == "https" \
                and _is_quiz_lti_host(parts.hostname or "", tenant_host):
            return frame.get("id"), url
        for child in node.get("childFrames") or []:
            found = _walk(child)
            if found[0] is not None:
                return found
        return None, None

    if not isinstance(frame_tree, dict):
        return None, None
    return _walk(frame_tree.get("frameTree"))


def find_quiz_lti_frame_id(frame_tree, tenant_host=None) -> object:
    """First frame id in a Page.getFrameTree result whose URL is a
    validated quiz-lti origin, or None. The whole tree (root included)
    is walked; the /banks fallback route may host the app top-level."""
    frame_id, _url = _quiz_lti_frame(frame_tree, tenant_host)
    return frame_id


def parse_sdk_token_payload(payload) -> tuple:
    """Extract (token, auth_type) from a banks.build token payload.

    Accepts the raw JSON object or its string form; the token may sit
    under token / access_token / jwt / value, the auth type under
    auth_type / authType / authTypeHeader, defaulting to "Signature".
    Raises when no token field is present.
    """
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except ValueError:
            raise ItemBankSdkError(
                "banks.build payload is not JSON; cannot extract the token")
    if not isinstance(payload, dict):
        raise ItemBankSdkError(
            "banks.build payload is %s, not an object; cannot extract the token"
            % type(payload).__name__)
    token = None
    for key in ("token", "access_token", "jwt", "value"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            token = value
            break
    if token is None:
        raise ItemBankSdkError(
            "banks.build payload carries no token field "
            "(looked for token/access_token/jwt/value)")
    auth_type = payload.get("auth_type") or payload.get("authType") \
        or payload.get("authTypeHeader") or _DEFAULT_AUTH_TYPE
    return token, str(auth_type)


def find_item_banks_tool_id(tools, tenant_host=None) -> object:
    """The external tool id of the Item Banks tool, or None.

    The match is case-insensitive on the tool name; the id is never
    hardcoded (54065 was one tenant's id, not a contract). Refuses
    (raises ItemBankSdkError) when more than one tool matches: an
    ambiguous name match must never silently pick the first lookalike.
    When a matched tool carries a url/domain and the tenant host is
    known, the tool's host must belong to the tenant's domain family;
    a foreign-hosted "Item Banks" tool is refused rather than launched.
    """
    matches = []
    for tool in tools or []:
        if not isinstance(tool, dict):
            continue
        name = str(tool.get("name") or "")
        if "item banks" not in name.lower():
            continue
        tool_id = tool.get("id")
        if tool_id is None or str(tool_id).strip() == "":
            continue
        matches.append(tool)
    if len(matches) > 1:
        raise ItemBankSdkError(
            "refusing ambiguous Item Banks launch: %d external tools "
            "match 'Item Banks' (ids %s); resolve the duplicate before "
            "launching" % (len(matches),
                           [m.get("id") for m in matches]))
    if not matches:
        return None
    tool = matches[0]
    if tenant_host:
        tenant = str(tenant_host).lower().rstrip(".")
        _first, dot, parent = tenant.partition(".")
        for key in ("url", "domain"):
            raw = str(tool.get(key) or "").strip()
            if not raw:
                continue
            host = (urllib.parse.urlparse(
                raw if "://" in raw else "https://" + raw).hostname
                or "").lower().rstrip(".")
            if not host:
                raise ItemBankSdkError(
                    "refusing Item Banks tool %r: its %s %r has no "
                    "parseable host" % (tool.get("id"), key, raw))
            in_family = (host == tenant) or (
                bool(dot) and host.endswith("." + parent))
            if not in_family:
                raise ItemBankSdkError(
                    "refusing Item Banks tool %r: its %s host %r is "
                    "outside the tenant domain family (%r); not launching "
                    "a foreign tool" % (tool.get("id"), key, host, tenant))
    return tool.get("id")


def check_course_scope(bound_course_id, requested_course_id) -> None:
    """Refuse cross-course reuse of an SDK session's credential scope."""
    if requested_course_id is None:
        return
    if str(requested_course_id) != str(bound_course_id):
        raise ItemBankSdkError(
            "SDK session is scoped to course %s; refusing a request naming "
            "course %s (cross-course token reuse is forbidden)"
            % (bound_course_id, requested_course_id))


def build_disposable_choice_item(question_html: str) -> dict:
    """Minimal proven item payload for the live battery's disposable item.

    Ported from Meridian's build_disposable_choice_item (mechanism, not
    code): a two-choice Equivalence-scored question nested under "item".
    """
    return {
        "item": {
            "feedback": {},
            "interaction_data": {
                "choices": [
                    {"id": "c-1", "position": 1,
                     "item_body": "<p>Yes</p>"},
                    {"id": "c-2", "position": 2,
                     "item_body": "<p>No</p>"},
                ]
            },
            "interaction_type_id": "1",
            "item_body": "<p>%s</p>" % str(question_html or "Disposable?"),
            "properties": {
                "shuffle_rules": {"choices": {"to_lock": [],
                                              "shuffled": False}},
                "vary_points_by_answer": False,
            },
            "scoring_algorithm": "Equivalence",
            "scoring_data": {"value": "c-1"},
            "title": None,
            "points_possible": 1,
            "calculator_type": "none",
            "answer_feedback": {},
        }
    }


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class ItemBankSdkError(Exception):
    """The SDK lane failed before or during a provider call."""


class ItemBankSdkSessionDead(ItemBankSdkError):
    """No live Canvas session in the browser: no provider call attempted."""


class ItemBankSdkMaybeAttempted(ItemBankSdkError):
    """The page-context call may have reached the provider.

    Raised when the SDK's fetch program was dispatched to the page but
    its outcome is unknown: the frame's execution context died while
    the program was running, the CDP evaluate itself failed after
    dispatch, or the page-level fetch threw (a fetch that throws may
    still have hit the network). Callers must treat writes as
    uncertain, never as not-attempted.
    """


# ---------------------------------------------------------------------------
# Page-context programs
# ---------------------------------------------------------------------------

# course_id is json.dumps-encoded at format time (a double-quoted JS string
# constant), exactly like _ITEM_FETCH_JS encodes its params: the value is
# educator-supplied and must never break out of the string literal.
_LAUNCH_TOOLS_JS = """(async () => {
  const r = await fetch('/api/v1/courses/' + %(course_id)s + '/external_tools',
    {headers: {'Accept': 'application/json'}, credentials: 'same-origin'});
  if (r.status !== 200) return {ok: false, status: r.status};
  const tools = await r.json();
  return {ok: true, tools: tools};
})()"""

# One page-context program per item call, evaluated in the quiz-lti
# frame's isolated world. The token, auth type, and api origin are the
# values captured at launch, embedded as JS string constants; nothing
# credential-bearing is discovered at call time.
_ITEM_FETCH_JS = """(async () => {
  const headers = {'Accept': 'application/json',
                   'Authorization': %(token)s,
                   'AuthType': %(auth_type)s,
                   'Content-Type': 'application/json'};
  const init = {method: %(method)s, headers: headers};
  if (%(body)s !== null) init.body = %(body)s;
  let status = 0, text = '';
  try {
    const r = await fetch(%(api_origin)s + %(path)s, init);
    status = r.status; text = await r.text();
  } catch (e) { return {ok: false, error: 'fetch_error:' + (e && e.message)}; }
  return {ok: true, status: status, body: text};
})()"""

_ME_JS = ("fetch('/api/v1/users/self', {credentials: 'same-origin'})"
          ".then(function (r) { return r.status; })"
          ".catch(function () { return -1; })")


# ---------------------------------------------------------------------------
# SDK session
# ---------------------------------------------------------------------------

def _require_single_segment(kind: str, value) -> str:
    """Validate an id interpolated into a URL path at the SDK boundary.

    None, empty, and whitespace-only ids are refused instead of being
    interpolated into a path (bank_id=None built "/api/banks/None/items").
    An id is a single path segment, never a traversal: literal separators
    ("/" and backslash, which the URL parser treats as a separator for
    https), query/fragment markers, and ASCII controls are refused. Tab
    and newline are the sharpest controls: the parser strips them before
    parsing, so "1\\n../admin" would resolve to a traversal. Percent-
    encoded separators (%2f, %5c, any case) are refused too: the browser
    keeps them encoded, but a server may decode them, and a legitimate id
    is numeric and never needs them.
    """
    text = "" if value is None else str(value).strip()
    if not text:
        raise ItemBankSdkError(
            "refusing to build a path with an empty %s" % kind)
    if ("?" in text or "#" in text or "/" in text or "\\" in text
            or any(ord(c) < 0x20 for c in text)):
        raise ItemBankSdkError(
            "refusing to build a path with %s %r: not a single path "
            "segment" % (kind, text))
    lowered = text.lower()
    if "%2f" in lowered or "%5c" in lowered:
        raise ItemBankSdkError(
            "refusing to build a path with %s %r: encoded separator" % (kind, text))
    return text


class ItemBankSdk:
    """One course-scoped Item Banks SDK session in the educator's Chromium.

    cdp is a local_chromium.CDP bound to the helper's CDP port;
    canvas_base is the tenant origin; course_id scopes the credential.
    The tab is dedicated to the SDK so the tenant tab is never disturbed.
    """

    def __init__(self, cdp, canvas_base: str, course_id, token_wait_s: int = 180):
        # LANE2-D14: the course_id is interpolated into URL paths (the
        # external-tools lookup and the LTI launch URL), so it must be a
        # single path segment, never empty or a traversal. The validator
        # also covers the old None/empty refusal.
        course_id = _require_single_segment("course_id", course_id)
        self._cdp = cdp
        self._base = str(canvas_base or "").rstrip("/")
        try:
            self._base_origin = origin_of(self._base)
        except ItemBankSdkError:
            raise ItemBankSdkError(
                "the Item Banks SDK lane needs a valid canvas_base origin, "
                "got %r" % (canvas_base,))
        self._course_id = course_id
        self._token_wait_s = int(token_wait_s)
        self._tab = None
        self._launched = False
        # Captured credential material: memory only, course-bound, wiped
        # by close(). Never logged, never persisted, never returned.
        self._token = None
        self._auth_type = _DEFAULT_AUTH_TYPE
        self._api_origin = None
        self._context_id = None

    @property
    def course_id(self):
        return self._course_id

    # -- tab lifecycle ----------------------------------------------------

    def _get_tab(self):
        # W4 fix: this method was named _tab, colliding with the
        # self._tab instance attribute (the cached tab dict). The
        # attribute shadows the method, so the old self._tab() call
        # raised TypeError. Method is _get_tab now; attribute unchanged.
        if self._tab is not None:
            return self._tab
        tab = self._cdp.new_tab("about:blank")
        self._tab = tab
        return self._tab

    def _probe_world(self, tab):
        """W4-P1-12: isolated world for session/tool probes. The default
        page realm is untrusted: page JS can replace window.fetch, so
        probes that decide session liveness must not run there."""
        try:
            return self._cdp.create_isolated_world(
                tab, "morrow_item_bank_sdk_probe")
        except Exception as exc:
            raise ItemBankSdkError(
                "could not create the SDK probe's isolated world: %s"
                % exc)

    def close(self):
        """Close the SDK tab and wipe captured credential material."""
        tab = self._tab
        self._tab = None
        self._launched = False
        self._token = None
        self._auth_type = _DEFAULT_AUTH_TYPE
        self._api_origin = None
        self._context_id = None
        if tab is None:
            return
        # W4-P0-3: no /json/close anymore; close through the owned CDP
        # client (pipe or helper proxy). Best effort; the tab is
        # disposable.
        try:
            self._cdp.close_tab(tab)
        except Exception:  # noqa: BLE001
            pass

    def drop_credential(self):
        """Drop the captured credential without closing the tab.

        LANE6-5: the SDK lane used to keep a 401'd token cached until the
        whole session dropped. A 401 means the captured banks.build
        credential is rejected by the provider (rotated or expired), so
        keeping it only guarantees the next call fails identically.
        Dropping is fail-closed: the next request() relaunches and
        recaptures a fresh credential before touching the provider again.
        """
        self._launched = False
        self._api_origin = None
        self._context_id = None
        self._token = None
        self._auth_type = None

    # -- launch -----------------------------------------------------------

    def _session_alive(self, tab) -> bool:
        try:
            self._cdp.navigate(tab, self._base + "/")
        except Exception:  # noqa: BLE001 - navigate races are retried below
            pass
        deadline = time.time() + 25
        while time.time() < deadline:
            try:
                href = self._cdp.evaluate(tab, "location.href", timeout=15)
            except Exception:  # noqa: BLE001
                href = ""
            # Origin comparison, not a prefix match: a sibling host such as
            # https://school.example.com.evil.example/ passes startswith()
            # but has a different origin and must not count as alive.
            try:
                same_origin = (isinstance(href, str)
                               and origin_of(href) == self._base_origin)
            except ItemBankSdkError:
                same_origin = False
            if same_origin:
                break
            time.sleep(1)
        # W4-P1-12: the session probe runs in an isolated world, never
        # the page's default realm (page JS can replace window.fetch).
        try:
            context_id = self._probe_world(tab)
            status = self._cdp.evaluate(tab, _ME_JS, await_promise=True,
                                        timeout=30, context_id=context_id)
        except Exception:  # noqa: BLE001
            status = -1
        return status == 200

    def launch(self) -> bool:
        """Boot the Item Banks surface and capture the app's API credential.

        One persistent CDP session navigates to the launch URL and watches
        the app's own network traffic; the Authorization header of the
        first request to the tenant-bound quiz-api host is captured,
        together with its AuthType header, and an isolated world is
        created in the tab's root frame for item calls.

        Why request headers, not the banks.build response body: on the
        /banks route the app issues its API calls from a Web Worker, and
        Network.getResponseBody cannot serve a worker-issued response to
        the page target's session (CDP -32000 "No resource with given
        identifier found"). The request headers carry the same credential
        the app's real item calls use, and they are visible on the page
        session. Trust: this tab is navigated by us to the tenant's own
        page, and only the tenant-bound quiz-api host is accepted, so a
        foreign page echoing a URL fragment cannot supply the credential.

        Raises ItemBankSdkSessionDead when the browser holds no live
        Canvas session, ItemBankSdkError when no authorized quiz-api
        request is observed. Idempotent: a launched session is not
        relaunched.
        """
        if self._launched:
            return True
        tab = self._get_tab()
        if not self._session_alive(tab):
            raise ItemBankSdkSessionDead(
                "no live Canvas session in the local browser; sign in again "
                "through the login helper")
        tool_id = None
        tenant_host = urllib.parse.urlparse(self._base).hostname or ""
        # W4-P1-12: the external-tools lookup runs in an isolated
        # world, never the page's default realm.
        try:
            probe_world = self._probe_world(tab)
            found = self._cdp.evaluate(
                tab, _LAUNCH_TOOLS_JS % {"course_id": json.dumps(
                    self._course_id)},
                await_promise=True, timeout=60, context_id=probe_world)
        except Exception:  # noqa: BLE001 - fall through to the /banks route
            found = None
        if isinstance(found, dict) and found.get("ok"):
            tool_id = find_item_banks_tool_id(found.get("tools"),
                                              tenant_host or None)
        if tool_id is not None:
            launch_url = ("%s/courses/%s/external_tools/%s"
                          % (self._base, self._course_id, tool_id))
        else:
            # Fallback: the /banks route the 2026-09-21 Chromium write
            # battery proved on this tenant.
            launch_url = ("%s/courses/%s/banks"
                          % (self._base, self._course_id))

        def _want_api_auth(request_url, headers):
            try:
                host = urllib.parse.urlparse(
                    str(request_url)).hostname or ""
            except Exception:  # noqa: BLE001 - unparsable URL never matches
                return False
            if not _is_quiz_api_host(host, tenant_host or None):
                return False
            lowered = {str(k).lower(): v
                       for k, v in (headers or {}).items()}
            return "authorization" in lowered

        # LANE6-9: one retry on token-capture timeout. The /banks page is
        # a JS SPA whose boot depends on a clean page load; a transient
        # stall (observed live 2026-09-22: the tab sat on
        # chrome-error://chromewebdata/ for ~30s, then loaded fine) means
        # the app never issues quiz-api traffic inside the window, which
        # is not a provider refusal. capture_request_headers navigates
        # itself, so the retry is a fresh page load. Exactly one retry:
        # two consecutive full-window timeouts are treated as the app
        # genuinely not booting, and the failure stays a hard
        # not-attempted error (fail closed, op_id reusable).
        request_url = headers = None
        attempts = 0
        while True:
            attempts += 1
            try:
                request_url, headers = self._cdp.capture_request_headers(
                    tab, launch_url, _want_api_auth,
                    timeout=self._token_wait_s)
                break
            except TimeoutError as exc:
                if attempts >= 2:
                    raise ItemBankSdkError(
                        "no authorized quiz-api request was issued within "
                        "%ds of navigating to %s on two attempts; the "
                        "Item Banks app did not boot there (%s)"
                        % (self._token_wait_s, launch_url, exc))
        lowered = {str(k).lower(): v for k, v in headers.items()}
        token = lowered.get("authorization")
        if not token or not str(token).strip():
            raise ItemBankSdkError(
                "the matched quiz-api request carried an empty "
                "Authorization header; refusing to launch without a "
                "credential")
        auth_type = str(lowered.get("authtype") or _DEFAULT_AUTH_TYPE)
        api_origin = origin_of(request_url)
        try:
            frame_tree = self._cdp.call(tab, "Page.getFrameTree", {},
                                        timeout=30)
        except Exception as exc:
            raise ItemBankSdkError(
                "could not read the CDP frame tree: %s" % exc)
        root = ((frame_tree or {}).get("frameTree") or {}).get("frame") or {}
        root_id = root.get("id")
        if not root_id:
            raise ItemBankSdkError(
                "the CDP frame tree has no root frame id; cannot create "
                "the SDK execution world")
        try:
            world = self._cdp.call(
                tab, "Page.createIsolatedWorld",
                {"frameId": root_id,
                 "worldName": "morrow_item_bank_sdk"}, timeout=30)
        except Exception as exc:
            raise ItemBankSdkError(
                "could not create the SDK execution world in the tab's "
                "root frame: %s" % exc)
        context_id = (world or {}).get("executionContextId")
        if context_id is None:
            raise ItemBankSdkError(
                "Page.createIsolatedWorld returned no executionContextId")
        self._token = str(token)
        self._auth_type = auth_type
        self._api_origin = api_origin
        self._context_id = context_id
        self._launched = True
        return True

    # -- item calls --------------------------------------------------------

    def request(self, method: str, path: str, body=None, course_id=None):
        """One SDK call, evaluated in the tab root frame's isolated
        execution context. Returns (status, body_text).

        method is GET/POST/PATCH/DELETE; path is the quiz-api path
        (/api/banks/...). The captured token/auth type/api origin are
        embedded as JS constants; only (status, body) return to Python.
        """
        check_course_scope(self._course_id, course_id)
        if not is_sdk_item_path(path):
            raise ItemBankSdkError(
                "refusing non-SDK path %r on the Item Banks SDK lane" % path)
        method = str(method or "GET").upper()
        if method not in ("GET", "POST", "PATCH", "DELETE"):
            # LANE6-4: the method is boundary-validated to the Item Bank
            # contract. In particular PUT is refused here: item updates
            # are PATCH-only, and an accidental PUT would silently change
            # the write's semantics on a backend that treats them
            # differently.
            raise ItemBankSdkError(
                "refusing unsupported SDK method %r: Item Bank operations "
                "use GET, POST, PATCH, or DELETE only" % method)
        self.launch()
        tab = self._get_tab()
        body_json = json.dumps(body) if body is not None else None
        program = _ITEM_FETCH_JS % {
            "token": json.dumps(self._token),
            "auth_type": json.dumps(str(self._auth_type)),
            "api_origin": json.dumps(self._api_origin),
            "method": json.dumps(method),
            "path": json.dumps(str(path)),
            "body": json.dumps(body_json),
        }
        try:
            outcome = self._cdp.evaluate(tab, program, await_promise=True,
                                         timeout=120,
                                         context_id=self._context_id)
        except Exception as exc:
            message = str(exc)
            # LANE6-8: once the program is dispatched to the page, any
            # evaluate failure leaves the provider effect unknown. The
            # fetch may already have executed, so this is MaybeAttempted,
            # never a not-attempted failure.
            self._launched = False
            self._token = None
            self._context_id = None
            if "context" in message.lower() or "target" in message.lower():
                # The frame's execution context died (navigation, crash):
                # drop the launch so the next call recaptures cleanly.
                raise ItemBankSdkMaybeAttempted(
                    "the quiz-lti frame's execution context was lost; "
                    "the SDK session was reset, retry the call (%s)"
                    % message)
            raise ItemBankSdkMaybeAttempted(
                "SDK page-context call failed after dispatch: %s" % exc)
        if not isinstance(outcome, dict) or not outcome.get("ok"):
            error = (outcome or {}).get("error", "unknown") \
                if isinstance(outcome, dict) else "non-object outcome"
            if isinstance(error, str) and error.startswith("fetch_error:"):
                # LANE6-8: the page-level fetch threw. A fetch that
                # throws may still have reached the provider (e.g. the
                # connection dropped after the request was sent).
                raise ItemBankSdkMaybeAttempted(
                    "SDK page-context call failed: %s" % error)
            raise ItemBankSdkError("SDK page-context call failed: %s" % error)
        return int(outcome.get("status", 0)), str(outcome.get("body", ""))

    # -- convenience item operations ---------------------------------------

    def create_item(self, bank_id, item_body: dict, course_id=None):
        """POST /api/banks/{bank}/items with fields nested under "item"."""
        bank_id = _require_single_segment("bank_id", bank_id)
        if not isinstance(item_body, dict) or "item" not in item_body:
            raise ItemBankSdkError(
                "item create requires the body nested under top-level "
                "\"item\"; refusing to send a differently shaped payload")
        return self.request("POST", "/api/banks/%s/items" % bank_id,
                            item_body, course_id=course_id)

    def get_item(self, bank_id, item_id, course_id=None):
        """GET /api/banks/{bank}/items/{item} (provider-anomalous on some
        tenants: entry GET is the proven read path)."""
        bank_id = _require_single_segment("bank_id", bank_id)
        item_id = _require_single_segment("item_id", item_id)
        return self.request("GET", "/api/banks/%s/items/%s" % (bank_id,
                                                                item_id),
                            None, course_id=course_id)

    def update_item(self, bank_id, item_id, item_body: dict, course_id=None):
        """PATCH /api/banks/{bank}/items/{item}; never PUT."""
        bank_id = _require_single_segment("bank_id", bank_id)
        item_id = _require_single_segment("item_id", item_id)
        if not isinstance(item_body, dict) or "item" not in item_body:
            raise ItemBankSdkError(
                "item update requires the body nested under top-level "
                "\"item\"; refusing to send a differently shaped payload")
        return self.request("PATCH", "/api/banks/%s/items/%s" % (bank_id,
                                                                  item_id),
                            item_body, course_id=course_id)

    def delete_item(self, bank_id, item_id, course_id=None):
        """DELETE /api/banks/{bank}/items/{item}. Provider-unserved:
        exhaustively probed 2026-09-22 (404 in all three attachment
        states on a live bank, 404 on three archived-bank residue
        items, and the /items list route also 404s), so the route stays
        unproven and unclaimed. The supported item-removal lifecycle is
        bank-entry DELETE (204) plus bank archive (204)."""
        bank_id = _require_single_segment("bank_id", bank_id)
        item_id = _require_single_segment("item_id", item_id)
        return self.request("DELETE", "/api/banks/%s/items/%s" % (bank_id,
                                                                   item_id),
                            None, course_id=course_id)
