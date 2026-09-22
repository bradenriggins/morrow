#!/usr/bin/env python3
"""Browser-task transport for the Muse product: batch renderer and result parser.

The Muse product NEVER holds Canvas cookie values. API execution happens
inside the managed browser (which holds the educator's authenticated
session) via a browser task. This module renders the self-contained task
brief from a batch of ops and parses the task's structured report back into
per-op results.

TRANSPORT STATUS (honest, 2026-09-21): the form lane is RETIRED.
The first-party static relay page on meetmorrow.app (deployed 2026-09-20
with Braden's explicit approval, full battery passed live that night on
school.example.edu course 89585) was taken down 2026-09-21 and its
source removed from this tree: the live write path runs in the helper
Chromium's page context (dispatch/executor.py chromium backend), so the
relay workaround is dead code. render_brief now FAILS CLOSED on every
form write: FormTransportUnavailable, unconditionally. GET-only and
fetch-only batches still render: reads work through the browser task
today.

What is proven:
- GET reads work: direct navigation to API URLs, JSON read from the page.
- The form-POST mechanism works (proven twice live 2026-09-20 against
  school.example.edu, principal 28206): a cross-site top-level form POST
  from a rendered page carries the browser's session cookies and a
  page-harvested CSRF token, and Canvas honors it exactly like a
  same-origin API call. Evidence: proof-battery/editor-transport/ and
  proof-battery/live-product-proof/. The relay-page lane that proved this
  is RETIRED (taken down 2026-09-21); live writes now run in the helper
  Chromium's page context through dispatch/executor.py.
- Neither renderer is shippable. The Cloudflare worker violated Braden's
  ban on hosted infrastructure. The public editor violates his ban on
  third-party/neutral hosted pages as final architecture (external
  dependency not packed with the connector; user content pasted to a third
  party). The editor experiment is preserved as MECHANISM PROOF ONLY.

What is definitively unavailable (each proven 2026-09-20):
- Page-context JavaScript / fetch(): the browser task's tool policy
  explicitly prohibits JS execution and CDP. The fetch lane in this module
  is unit-proven scaffolding only and cannot run live.
  (proof-battery/js-execution-gate/RESULT-2026-09-20-negative.md)
- file:// URLs: crash the browser automation (twice).
- data: URLs: the goto tool crashes on them; Chromium blocks web-initiated
  top-frame data: navigation and https-to-data: redirects; the omnibox is
  unreachable headless. data: pages DO render and run scripts in subframes,
  but there is no shippable bootstrap.
  (proof-battery/data-url-diagnostic/RESULT-2026-09-20.md)
- Loopback: the managed browser runs on a separate VM; this VM's
  127.0.0.1 is unreachable from it.
  (proof-battery/localhost-proof/RESULT-2026-09-20-failed.md)
- Hosted helper pages: dynamic/third-party/neutral pages banned by Braden.
  UPDATE 2026-09-20: Braden himself proposed a first-party STATIC relay
  page on meetmorrow.app (single static file, no backend, no storage).
  UPDATE 2026-09-21: that page was taken down and the lane retired: the
  sanctioned exception is gone, and the ban stands with no exceptions.
- Canvas UI automation: banned by Braden (API-only law).

PLATFORM ASK: allow data: URL navigation in browser-task goto (or provide
a sanctioned way to open bundled page content). data: pages already render
in the managed browser's Chromium; only the bootstrap is missing. When
that lands, render_form_html below is the ready-made payload: the brief
packs the form HTML as a data: URL, the task fills the harvested CSRF
token and clicks Submit. Until then, and since the relay lane was retired
2026-09-21, form writes raise FormTransportUnavailable unconditionally;
the product must surface that as a blocked lane, not a silent failure.
Live writes run through the helper Chromium page context
(dispatch/executor.py chromium backend), not through this module.

Op shape:
    {"op_id": str, "method": "GET"|"POST"|"PUT"|"DELETE",
     "path": "/api/v1/...", "fields": {form fields for writes}}

Field values may be str or a list of str (a list renders as repeated inputs
with the same name, e.g. "ids[]" for Canvas array params).

Stdlib only.
"""

import html
import json
import re

WRITE_METHODS = ("POST", "PUT", "PATCH", "DELETE")
MAX_OPS_PER_BATCH = 15  # long browser tasks are fragile; keep batches short


class FormTransportUnavailable(Exception):
    """A batch needs the form lane (a write op), but the form lane is
    retired: the first-party static relay page was taken down 2026-09-21
    and render_brief fails closed on every form write. Live writes run
    through the helper Chromium's page context (dispatch/executor.py
    chromium backend), never through this module.
    """


class SecretEgressRefused(Exception):
    """A fetch op would persist authentication material in the rendered
    brief. Briefs are persisted (0600) and linger on session-dead retry
    paths, so authentication headers (Authorization, Cookie, CSRF tokens)
    are never rendered into brief text, not as literals and not as
    transient/credential/session_value references. The only header
    placeholder a brief may carry is the CSRF harvest marker (read fresh
    from the live page at run time; the value never appears in the
    brief). browser_backend maps this to its own SecretEgressRefused.
    """


# LANE2-D10: authentication header names. A fetch op carrying one of
# these with a literal value (or a transient/credential/session_value
# reference) is refused at render time, independently of the planner.
_AUTH_HEADER_NAMES = frozenset({
    "authorization", "proxy-authorization", "cookie",
    "x-csrf-token", "x-xsrf-token",
})


# Literal placeholder for the harvested CSRF value inside packed form HTML.
# The brief instructs the task to substitute the token harvested in Step 2.
# The placeholder (never a real token) is what travels in briefs, logs,
# and reports.
CSRF_PLACEHOLDER = "HARVESTED_CSRF_TOKEN"


def render_form_html(action, fields, method, csrf_field):
    """Build the complete self-contained form HTML for one write op.

    This is the renderer-agnostic payload: the exact HTML a
    connector-contained renderer would load (kept for the data: URL
    platform ask and for documentation). The first-party static relay
    page that once built its form with createElement was retired
    2026-09-21; render_brief fails closed on every form write. This
    function stays unit-tested and ready.

    method POST renders a plain form; PUT/PATCH/DELETE add the hidden _method
    override the provider honors through a POST. fields is the validated
    {name: scalar-or-list} mapping; values are HTML-attribute-escaped.
    Booleans are normalized with form_scalar (defense in depth: the
    validated path already normalizes, but a raw True/False must never
    render as "True"/"False" because Canvas casts "False" as true).
    The CSRF field carries the literal CSRF_PLACEHOLDER; the eventual
    brief will instruct the task to substitute its harvested token.
    """
    parts = ["<!doctype html>", "<html><body>"]
    parts.append('<form method="POST" action="%s" target="_top">'
                 % html.escape(action, quote=True))
    if method in ("PUT", "PATCH", "DELETE"):
        parts.append('<input type="hidden" name="_method" value="%s">' % method)
    for name in sorted(fields):
        vals = fields[name]
        if not isinstance(vals, list):
            vals = [vals]
        for v in vals:
            parts.append('<input type="hidden" name="%s" value="%s">'
                         % (html.escape(str(name), quote=True),
                            html.escape(form_scalar(v), quote=True)))
    parts.append('<input type="hidden" name="%s" value="%s">'
                 % (html.escape(csrf_field, quote=True), CSRF_PLACEHOLDER))
    parts.append('<button type="submit">Submit</button>')
    parts.append("</form></body></html>")
    return "\n".join(parts)


def default_form_host():
    """DEPRECATED. The form-host page (bundled file:// asset and the
    ephemeral loopback server) is retired, and so is the first-party
    static relay page that replaced it (taken down 2026-09-21): the
    managed browser cannot load file:// URLs (automation crashes), data:
    URLs cannot be opened by the browser-task automation, and the browser
    VM cannot reach this VM's loopback. The form lane in this module is
    fail-closed on every write; live writes run through the helper
    Chromium's page context (dispatch/executor.py chromium backend).
    Kept only so old callers fail loudly instead of silently; do not use
    for new work.
    """
    raise RuntimeError(
        "default_form_host is retired; the form lane (form-host and the "
        "first-party static relay page) is retired 2026-09-21. Live "
        "writes run through the helper Chromium page context; see "
        "FormTransportUnavailable")

# Destination confinement: every form action the product renders MUST
# stay on the educator's own tenant origin. Op paths are relative (they must
# start with "/"), the tenant base comes from lane state (never from an
# entry or pack), and render_brief refuses anything else. Confinement is
# enforced here, where the form HTML is built.

_ORIGIN_RE = re.compile(r"^(https?)://([^/:?#\s]+)(?::(\d+))?", re.IGNORECASE)


def _origin_of(url):
    """(scheme, host, port) of a URL, or None when it does not parse."""
    m = _ORIGIN_RE.match(str(url))
    if not m:
        return None
    return (m.group(1).lower(), m.group(2).lower(), m.group(3) or "")


def _check_base(base):
    """Fail closed unless base is an https URL with a real host."""
    origin = _origin_of(base)
    if not origin or origin[0] != "https" or not origin[1]:
        raise ValueError(
            "tenant base must be an https URL with a host: %r" % (base,))
    return base.rstrip("/")


def _confine_action(action, base_origin):
    """Fail closed unless the rendered spec action stays on the tenant
    origin. Guards against any future path-handling change that could let
    an op escape to another origin."""
    if _origin_of(action) != base_origin:
        raise ValueError(
            "form spec action escapes the tenant origin: %r" % (action,))
    return action


def form_scalar(v):
    """Encode one scalar form value.

    Booleans become 'true'/'false': Canvas/Rails boolean casting does not
    treat 'True'/'False' as false, so str(True/False) would silently flip a
    boolean field. Everything else renders with str().
    """
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def _validate_op(op):
    if not isinstance(op, dict):
        raise ValueError("op must be a dict")
    if op.get("kind") == "fetch":
        return _validate_fetch_op(op)
    for key in ("op_id", "method", "path"):
        if key not in op:
            raise ValueError("op missing %r: %r" % (key, op))
    method = str(op["method"]).upper()
    if method not in ("GET", "POST", "PUT", "DELETE"):
        raise ValueError("unsupported method %r" % op["method"])
    path = str(op["path"])
    if not path.startswith("/"):
        raise ValueError("op path must start with '/': %r" % path)
    fields = op.get("fields") or {}
    if not isinstance(fields, dict):
        raise ValueError("op fields must be a dict")

    def clean_value(v):
        if isinstance(v, list):
            if not v:
                raise ValueError("op field list must not be empty")
            return [form_scalar(x) for x in v]
        return form_scalar(v)

    return {"op_id": str(op["op_id"]), "method": method, "path": path,
            "fields": {str(k): clean_value(v) for k, v in fields.items()}}


def _validate_fetch_op(op):
    """Validate a page-context fetch op.

    A fetch op runs fetch() in the page context of a Canvas page with
    caller-specified headers. Authentication headers (Authorization,
    Cookie, CSRF tokens, ...) are refused at validation: the brief is
    persisted and authentication material is never rendered into it, not
    as a literal and not as a transient/credential/session_value
    reference. The only secret-adjacent header a fetch op may carry is
    the {"harvest": "csrf_token"} placeholder (read fresh from the live
    page at run time; the value never appears in the brief). Provisioned
    API tokens travel memory-only via the ItemBankSdk lane. The task must
    never report header values.
    """
    for key in ("op_id", "method", "url"):
        if key not in op:
            raise ValueError("fetch op missing %r: %r" % (key, op))
    method = str(op["method"]).upper()
    if method not in ("GET", "POST", "PUT", "PATCH", "DELETE"):
        raise ValueError("fetch op unsupported method %r" % op["method"])
    url = str(op["url"])
    if not url.startswith("https://"):
        raise ValueError("fetch op url must be https://: %r" % url)
    headers = op.get("headers") or {}
    if not isinstance(headers, dict):
        raise ValueError("fetch op headers must be a dict")
    clean_headers = {}
    for k, v in headers.items():
        k = str(k)
        if not k:
            raise ValueError("fetch op header name must not be empty")
        lname = k.lower()
        if isinstance(v, dict) and "harvest" in v:
            # Page-harvested header: the task reads the value from the live
            # page at run time; the value never appears in the brief.
            if v.get("harvest") not in ("csrf_token",):
                raise ValueError("fetch op unsupported harvest source %r" % (v,))
            clean_headers[k] = {"harvest": v["harvest"]}
            continue
        if isinstance(v, dict):
            # LANE2-D10: no reference dict survives into the brief except
            # the harvest placeholder. transient/credential/session_value
            # refs would either persist captured material or resolve to a
            # literal the task cannot compute; both fail closed here.
            raise SecretEgressRefused(
                "fetch op %r header %r carries a %r reference; reference "
                "headers are never rendered into the persisted brief"
                % (op.get("op_id"), k,
                   next((t for t in ("transient", "credential",
                                     "session_value") if t in v), "dict")))
        v = str(v)
        if not v:
            raise ValueError("fetch op header value must not be empty")
        if lname in _AUTH_HEADER_NAMES:
            # LANE2-D10: a literal authentication header would persist
            # credential material in the brief (0600, lingers on
            # session-dead retry paths). Refused independently of the
            # planner; provisioned tokens travel memory-only via the
            # ItemBankSdk lane, and CSRF tokens via the harvest marker.
            raise SecretEgressRefused(
                "fetch op %r header %r is an authentication header with a "
                "literal value; authentication material is never rendered "
                "into the persisted brief" % (op.get("op_id"), k))
        if v.startswith("transient."):
            # An unresolved transient reference reaching the renderer is a
            # planning bypass: the browser task cannot resolve it, so the
            # old code rendered the reference string itself as the header
            # value. Fail closed instead of persisting the garbage.
            raise ValueError(
                "fetch op %r header %r carries an unresolved transient "
                "reference; ops reaching render_brief must be fully planned"
                % (op.get("op_id"), k))
        clean_headers[k] = v
    body = op.get("body")
    if body is not None:
        body = str(body)
    return {"op_id": str(op["op_id"]), "kind": "fetch", "method": method,
            "url": url, "headers": clean_headers, "body": body}


def _session_check_lines(base, principal, provider):
    """The STEP 1 session-check block, shared by the GET and fetch briefs."""
    lines = []
    lines.append("STEP 1, SESSION CHECK (always first):")
    if provider == "canvas":
        lines.append("Navigate to %s/api/v1/users/self and read the JSON body." % base)
        if principal:
            lines.append("Session is alive only if the JSON shows id %s and name \"%s\"."
                         % (principal["id"], principal["name"]))
        else:
            lines.append("Session is alive only if the JSON looks like a user profile "
                         "(it has an id and a name).")
    else:
        # Moodle's webservice REST endpoint needs a token; the session lane
        # proves liveness through the logged-in web UI instead.
        lines.append("Navigate to %s/my/ and read the page." % base)
        if principal:
            lines.append("Session is alive only if the page shows you logged in as \"%s\" "
                         "(user menu), with no login form visible."
                         % principal["name"])
        else:
            lines.append("Session is alive only if the page shows a logged-in user "
                         "menu, with no login form visible.")
    lines.append("If you see a login page, a login redirect, or an error instead: "
                 "STOP the whole batch immediately and report session_dead. "
                 "Attempt nothing further.")
    return lines


# --------------------------------------------------------------------------
# W5-P2-4: plain-text brief sanitization.
#
# Briefs are instruction text for the downstream browser-task agent ("execute
# the operations in the exact order listed"), and provider/agent-controlled
# strings (params-derived URLs, bodies, header names) are interpolated into
# them with %s. A raw \n in one of those strings renders as a real line
# break and can forge STEP n: / op_id | / RESULTS_JSON lines; RTL
# overrides, zero-width chars, and ANSI escapes can reorder or hide text
# from a human reading the brief during debugging. sanitize_for_text_render
# keeps every interpolated value on its own line and strips the
# concealment characters. (JSON surfaces, journal records, approval files,
# stay on json.dumps/ensure_ascii and need no change.)
# --------------------------------------------------------------------------
_BIDI_ZW_RE = re.compile("[\u200b-\u200d\u202a-\u202e\u2066-\u2069\ufeff]")
_ANSI_CSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
_C0_DEL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")


def sanitize_for_text_render(value) -> str:
    """Render-safe form of a provider/agent-controlled string for
    plain-text briefs: newlines/tabs (including Unicode line/paragraph
    separators) become visible escapes (the value stays on one line, so
    no STEP/RESULTS_JSON line can be forged), ANSI escape sequences,
    bidi overrides, zero-width chars, and other C0/C1 controls/DEL are
    stripped. Printable Unicode (emoji, CJK, ...) passes through
    unchanged."""
    text = str(value)
    text = _ANSI_CSI_RE.sub("", text)
    text = (text.replace("\r\n", "\\n").replace("\n", "\\n")
            .replace("\r", "\\r").replace("\t", "\\t")
            .replace(" ", "\\u2028").replace(" ", "\\u2029"))
    text = _C0_DEL_RE.sub("", text)
    text = _BIDI_ZW_RE.sub("", text)
    return text


def render_brief(ops, base, principal=None, batch_id="batch-1",
                 form_host=None, provider="canvas"):
    """Render the self-contained browser-task brief for one batch of ops.

    principal: {"id": int, "name": str} or None. When None, the task treats
    any user-profile JSON from /api/v1/users/self as a live session.

    form_host: DEPRECATED and ignored. Kept in the signature so old callers
    keep working.

    provider: "canvas" or "moodle". Other providers are rejected.

    The form lane is RETIRED (the first-party static relay page was taken
    down 2026-09-21): any batch containing a form write (POST/PUT/DELETE)
    raises FormTransportUnavailable unconditionally, and the product must
    surface that as a blocked lane. Live writes run through the helper
    Chromium's page context (dispatch/executor.py chromium backend).
    GET-only and fetch-only batches render normally: reads work through
    the browser task today.

    A batch containing only FETCH ops renders a fetch-only brief: no CSRF
    harvest step is included (fetch ops carry their own Authorization
    headers), and the task is told to stay on the provider page and never
    use a form. (The fetch lane itself is unit-proven scaffolding only;
    the browser task cannot execute page-context fetch() live.)
    """
    if provider not in ("canvas", "moodle"):
        raise ValueError("browser form lane supports canvas/moodle, not %r"
                         % provider)
    clean = [_validate_op(o) for o in ops]
    if not clean:
        raise ValueError("batch is empty")
    if len(clean) > MAX_OPS_PER_BATCH:
        raise ValueError("batch of %d exceeds max %d; split it"
                         % (len(clean), MAX_OPS_PER_BATCH))
    fetch_only = all(o.get("kind") == "fetch" for o in clean)
    has_form_write = any(o.get("kind") != "fetch" and o["method"] != "GET"
                         for o in clean)
    if has_form_write:
        raise FormTransportUnavailable(
            "batch %r contains a form write, but the form lane is retired "
            "(the first-party static relay page was taken down 2026-09-21): "
            "the write lane stays fail-closed. Live writes run through the "
            "helper Chromium's page context (dispatch/executor.py chromium "
            "backend)." % batch_id)
    base = _check_base(base)
    base_origin = _origin_of(base)
    prov_name = "Canvas" if provider == "canvas" else "Moodle"
    lines = []
    lines.append(
        "You are executing a batch of %s REST API calls inside this "
        "browser's authenticated %s session. Read every rule before acting."
        % (prov_name, prov_name))
    lines.append("")
    lines.append("HARD RULES:")
    lines.append("- Do not sign in. Do not enter any credentials. Do not fill any login form.")
    if fetch_only:
        lines.append("- Visit no site other than %s. Do all work from the %s page "
                     "you land on after the session check; never navigate away "
                     "to perform an op." % (base, prov_name))
    else:
        lines.append("- Visit no site other than %s." % base)
    lines.append("- NEVER report cookie values, CSRF token values, or any credential "
                 "material." +
                 (" Use them in fetch() only." if fetch_only else ""))
    lines.append("- Work only with the API URLs below. Never click through the %s "
                 "web UI; this is API work, not UI automation." % prov_name)
    lines.append("- Execute the operations in the exact order listed.")
    lines.append("")
    lines.append("BATCH %s: %d operation(s)." % (batch_id, len(clean)))
    lines.append("")
    lines.extend(_session_check_lines(base, principal, provider))
    lines.append("")
    lines.append("STEPS 3..N, THE OPERATIONS (in order):")
    if fetch_only:
        lines.append("Every op below is a FETCH op. Run each one with fetch() in "
                     "the page context of the %s page you are on after the session "
                     "check. Do NOT navigate away. Do NOT use any form, helper page, "
                     "or UI flow." % prov_name)
        lines.append("Execute: fetch(url, {method, headers, body}) with the exact values listed.")
        # LANE2-D10: no rendered op can carry an Authorization header (or
        # any authentication header): _validate_fetch_op refuses them, so
        # the brief never describes a provisioned token. Provisioned API
        # tokens travel memory-only via the ItemBankSdk lane; the only
        # per-call secret a fetch op uses is the CSRF harvest placeholder.
        lines.append("HARD RULES for fetch ops:")
        lines.append("- NEVER write any header name or value into your report. Not the token, "
                     "not the scheme, not even the header names. Report only the op_id, "
                     "HTTP status, and response body.")
        lines.append("- If fetch throws (network error, CORS), report the op as failed with "
                     "the error message. Do not retry with a form.")
        lines.append("- The response body is returned as text; report the first 2000 chars.")
        lines.append("- Pace yourself: about one op every two seconds.")
        lines.append("- NEVER retry a write op (POST/PUT/PATCH/DELETE): each write sends "
                     "exactly once; report the status and move on. A GET op may retry "
                     "once on HTTP 429 after waiting the Retry-After seconds.")
        lines.append("")
    else:
        # GET-only batch (form writes fail closed above, so no FORM ops can
        # reach here). Reads work through the browser task today.
        lines.append("All ops in this batch are GET navigations: navigate to "
                     "each URL in order and report the JSON body. No forms, "
                     "no helper pages.")
        lines.append("Pace yourself: about one op every two seconds. On HTTP 429, wait the "
                     "Retry-After seconds and retry that op once.")
        lines.append("")
        lines.append("FETCH OPS (page-context fetch):")
        lines.append("A FETCH op runs fetch() in the page context of the current %s page "
                     "(you are on one after the session check). Do NOT navigate away." % prov_name)
        lines.append("Execute: fetch(url, {method, headers, body}) with the exact values listed.")
        # LANE2-D10: no rendered op can carry an Authorization header (or
        # any authentication header): _validate_fetch_op refuses them, so
        # the brief never describes a provisioned token. Provisioned API
        # tokens travel memory-only via the ItemBankSdk lane; the only
        # per-call secret a fetch op uses is the CSRF harvest placeholder.
        lines.append("HARD RULES for fetch ops:")
        lines.append("- NEVER write any header name or value into your report. Not the token, "
                     "not the scheme, not even the header names. Report only the op_id, "
                     "HTTP status, and response body.")
        lines.append("- If fetch throws (network error, CORS), report the op as failed with "
                     "the error message. Do not retry with a form.")
        lines.append("- The response body is returned as text; report the first 2000 chars.")
        lines.append("")
    for i, op in enumerate(clean, start=3):
        lines.append("STEP %d:" % i)
        # W5-P2-4: op fields carry provider/agent-controlled strings;
        # sanitize_for_text_render() keeps each on its own line (a raw
        # \n could forge STEP/RESULTS_JSON lines) and strips bidi/ANSI
        # games that reorder or hide text from a human reader.
        lines.append("  op_id: %s" % sanitize_for_text_render(op["op_id"]))
        lines.append("  method: %s" % sanitize_for_text_render(op["method"]))
        if op.get("kind") == "fetch":
            lines.append("  kind: fetch (page-context fetch, do NOT use a form)")
            lines.append("  url: %s" % sanitize_for_text_render(op["url"]))
            literal = {k: v for k, v in op["headers"].items()
                       if not (isinstance(v, dict) and "harvest" in v)}
            harvested = {k: v for k, v in op["headers"].items()
                         if isinstance(v, dict) and "harvest" in v}
            lines.append("  headers: %s" % json.dumps(literal, sort_keys=True))
            for hk, hv in sorted(harvested.items()):
                lines.append("  header %s: HARVEST from the current page at run time "
                             "(read the _csrf_token cookie fresh from document.cookie "
                             "in the page context of the %s page you are on, once per "
                             "op, immediately before the fetch); use it as this "
                             "header's value in fetch(). NEVER read a meta tag and "
                             "NEVER use hidden form inputs as token sources. "
                             "NEVER write the harvested value into your report. "
                             "If the _csrf_token cookie is absent, do NOT send the "
                             "write; report the op as: op_id | 000 | CSRF_MISSING "
                             "(exactly that body, no other text)."
                             % (sanitize_for_text_render(hk), prov_name))
            lines.append("  (NEVER report these header values; use them in fetch() only)")
            lines.append("  body: %s" % (sanitize_for_text_render(op["body"])
                                         if op.get("body") else "(none)"))
            lines.append("")
            continue
        action = _confine_action(base + op["path"], base_origin)
        lines.append("  url: %s" % sanitize_for_text_render(action))
        # Only GET ops can reach here: form writes fail closed at the top of
        # render_brief, so there is no FORM branch.
        lines.append("  action: navigate (GET), report the JSON body")
        lines.append("")
    lines.append("REPORT FORMAT (follow exactly):")
    lines.append("First, one line per op in order:")
    lines.append("  op_id | http_status | first_500_chars_of_body")
    lines.append("Then a final section starting with the literal line RESULTS_JSON")
    lines.append("followed by a JSON array, one object per op, in order:")
    lines.append('  [{"op_id": "...", "status": 200, "body": "<JSON-escaped, max 2000 chars>"}, ...]')
    lines.append("If the session check failed, the whole report is the single line: session_dead")
    lines.append("If an op fails for any other reason, report it and continue with the next op.")
    return "\n".join(lines)


_RESULTS_RE = re.compile(r"^RESULTS_JSON\s*\n(\[.*\])\s*$", re.MULTILINE | re.DOTALL)
_LINE_RE = re.compile(r"^\s*([A-Za-z0-9_.\-]+)\s*\|\s*(\d{3})\s*\|\s*(.*)$")


def _is_csrf_missing_body(body):
    """LANE2-D4: the browser task reports an absent _csrf_token with the
    sentinel body CSRF_MISSING (status 000) instead of sending the write
    unauthenticated. Recognizing the sentinel keeps the missing token
    from being misdiagnosed as transport loss (an uncertain write)."""
    return str(body or "").strip().upper() == "CSRF_MISSING"


def parse_results(report_text):
    """Parse a task report into {"session_dead": bool, "results": [...]}.

    Prefers the RESULTS_JSON array; falls back to the per-op lines.
    Never raises on messy input: unparseable reports yield results == [] and
    raw_head for inspection. Each result carries "csrf_missing" (True when
    the task refused to send the op for lack of a _csrf_token).
    """
    text = report_text or ""
    if text.strip() == "session_dead":
        return {"session_dead": True, "results": [], "raw_head": text[:500]}
    m = _RESULTS_RE.search(text)
    if m:
        try:
            arr = json.loads(m.group(1))
            results = []
            for item in arr:
                if not isinstance(item, dict):
                    continue
                _body = str(item.get("body", ""))[:4000]
                results.append({
                    "op_id": str(item.get("op_id", "")),
                    "status": int(item.get("status", 0)),
                    "body": _body,
                    "csrf_missing": _is_csrf_missing_body(_body),
                })
            return {"session_dead": False, "results": results,
                    "raw_head": text[:500]}
        except (ValueError, TypeError):
            pass
    results = []
    for line in text.splitlines():
        lm = _LINE_RE.match(line)
        if lm:
            _body = lm.group(3).strip()[:4000]
            results.append({"op_id": lm.group(1), "status": int(lm.group(2)),
                            "body": _body,
                            "csrf_missing": _is_csrf_missing_body(_body)})
    return {"session_dead": False, "results": results, "raw_head": text[:500]}


def split_batches(ops, max_ops=MAX_OPS_PER_BATCH):
    """Split an op list into batch-sized chunks."""
    clean = [_validate_op(o) for o in ops]
    return [clean[i:i + max_ops] for i in range(0, len(clean), max_ops)]
