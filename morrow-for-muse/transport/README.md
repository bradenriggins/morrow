# Browser-task transport lane

The Muse product executes Canvas REST calls inside the managed browser via
browser tasks. The educator signs in once through takeover; the browser
profile holds the session; the product NEVER holds cookie values, CSRF
tokens, PATs, or any credential material.

This lane replaces the old cookie-capture model (session/capture.py writing
raw cookie values to ~/.morrow/session.json, replayed over raw HTTPS). That
model is retired for the Muse product for two independent reasons:

1. The raw-HTTPS replay is OTP-walled on tenants like CHCP (302 to
   /login/otp), so it does not work where it is needed most.
2. Holding raw cookie values violates the no-exposure principle the product
   is built on.

Conflict resolved 2026-09-20: `session/capture.py` is retained as RIG/PROOF
infrastructure only (bannered in its docstring); the installed product never
runs it. The executor's `--backend https` lane is the same rig lane; the
installed product lane for Canvas/Item Banks reads and writes is
`--backend chromium` (synchronous, through the local Chromium's
authenticated tab via CDP), which supersedes `--backend browser` for
provider calls while reusing the same governance.

Removal completed 2026-09-20 (code now matches the decision above):

- `dispatch/executor.py::SessionStore.slot_secret` no longer implements the
  `canvas_session` or `moodle_session` cookie-jar branches. Requesting
  either slot raises a retired error pointing at the browser lane. No
  product path can replay raw cookie values anymore.
- `dispatch/executor.py` default slots: quiz_api and canvas now default to
  `canvas_pat` (express token lane); moodle defaults to `moodle_sesskey`
  (visible, non-secret). Nothing defaults to a cookie jar.
- The stale squarefree-era sample briefs (`transport/briefA.txt`,
  `transport/briefA2.txt`, `transport/briefB.txt`) were deleted. The only
  remaining "squarefree" mentions in the tree are selftest assertions that
  rendered briefs contain no third-party form builder, and the historical
  audit notes. The first-party form host is `transport/form-host/index.html`,
  bundled inside the connector. TRANSPORT STATUS 2026-09-20: the ephemeral
  localhost server (`transport/form_host_server.py`) was proven unreachable
  from the managed browser (the managed browser runs on a separate leased
  VM; loopback on the engineering VM is not its loopback), and file://
  navigation crashes the managed browser (proven twice 2026-09-20). A
  data: URL diagnostic completed 2026-09-20 with a negative verdict:
  data: content renders and scripts execute, but the browser-task
  automation crashes on data: URL navigation (goto) and Chromium blocks
  web-initiated top-frame data: navigation, so there is no shippable way
  to open the brief. Full evidence:
  proof-battery/data-url-diagnostic/RESULT-2026-09-20.md. The no-PAT lane
  currently has no viable transport; this is a managed-browser/platform
  launch blocker. Zero hosted dependencies either way: no Cloudflare,
  no remote server, nothing the user provisions. (A
  Cloudflare-hosted proof-of-concept at form-helper.meetmorrow.app existed
  briefly on 2026-09-20 and was removed the same day at Braden's direction;
  the deploy script is gone and the page must never be published to any
  hosted service.)
- `lanes/detect.py` (PAT-mintability prober) still accepts raw cookie input
  as a one-shot setup diagnostic; it is not a transport and is flagged for
  a browser-task-native rewrite. Out of scope for this decision.

## How it works

`transport/batch.py` renders a self-contained brief from a batch of ops:

    {"op_id", "method": GET|POST|PUT|DELETE, "path": "/api/v1/...",
     "fields": {form fields for writes}}

The Morrow agent spawns one browser task per batch with the rendered brief.
The task:

1. Checks the session: GET /api/v1/users/self, expects the principal.
   Login page or redirect means session_dead; the batch aborts.
2. Harvests the authenticity_token CSRF field from Canvas page HTML itself.
   The value is used inside its forms and NEVER reported.
3. Executes the ops in order. GETs are plain navigations. Writes are
   form-encoded POSTs (session cookies ride along, even cross-origin).
   PUT and DELETE use the _method form-field override, which Canvas honors.
4. Reports per-op {op_id, status, body} plus a RESULTS_JSON array, which
   `transport/batch.py::parse_results` parses back into structured results.

`transport/state.py` persists lane metadata ONLY (base URL, principal
id/name, timestamps). It refuses to persist anything shaped like credential
material.

## Proven live 2026-09-20 (chcp.instructure.com, principal 28206)

- GET /api/v1/users/self by navigation: 200, principal JSON.
- Form POST through the browser: 200 with echoed fields (httpbin control).
- Full write cycle in course 89585: POST created assignment 4045367,
  _method=PUT renamed it, _method=DELETE deleted it, GET verified gone.
  Nothing left behind.
- Mechanism notes: cross-origin form POSTs carry the Canvas session cookies;
  Canvas requires the authenticity_token CSRF field on session-authenticated
  writes (422 unprocessable_content without it; the task re-harvests on 422);
  data: URLs crash the browser backend, so the task builds its forms on a
  scratch form page.

## Limits

- No JavaScript execution in the browser task (documented platform rule,
  verified by probe). Everything is navigation + form POST.
- Batches capped at 15 ops; long browser tasks are fragile. Dependent ops
  (create, then use the id) span two batches: parse batch N, render batch N+1.
- Each batch is one browser task; per-call cost is an agent turn. Batch
  aggressively. The filed platform request (consented session-bound fetch)
  remains the speed upgrade; the transport interface is unchanged when it lands.
- Sentinel watches browser-task egress; batches stay idempotent and resumable
  so an approval pause cannot corrupt a multi-step job.

## What the old code is now

- session/capture.py, session/cdp.py: the rig capture path (the educator
  signs in through the login helper page; capture.py reaches the helper's
  browser through its token-authenticated /cdp/* proxy, W4-P0-3). Not
  used by this lane. Left in place until Braden retires it.
- dispatch/executor.py: the manifest pipeline with raw-HTTPS egress. Its
  governance (frozen plans, journal, verify blocks, retry discipline) is
  sound and reusable; its egress layer needs a browser-task backend, which
  is the next build step (executor calls render_brief, the agent runs the
  task, results feed back into apply_result_block).
- lanes/detect.py: lane prober built on raw cookie input. Needs a
  browser-task-native rewrite (probe via the browser, no cookie values).
- reauth/state_machine.py: halt/quarantine/notify mechanics are reusable;
  the "re-run capture.py" re-sign-in step becomes takeover sign-in plus
  browser-task verification.

## Wave 4 adversarial audit decisions (2026-09-22)

This section is the decision record for the Wave 4 browser/CDP/transport
findings. (The audit asked for some of these to be written into
INSTALL.md; INSTALL.md sits outside the in-scope tree for this
remediation, so they live here instead and the gap is reported with the
fix.)

### No TCP CDP: pipe only (W4-P0-3, W4-P2-16)

Chromium launches with `--remote-debugging-pipe`, never
`--remote-debugging-port`. CDP frames travel over the anonymous pipe
between the launcher and its own Chromium; there is no TCP listener, so
no cross-process CDP surface exists to authenticate. Direct CDP(port)
construction without a launcher owner is refused. The only
cross-process CDP path is the helper's /cdp/* proxy, which requires the
per-launch HELPER_AUTH_TOKEN (verified by
helper/cdp_http_auth_selftest.py). Coverage: local_chromium_selftest.py
(no-debugging-port-flag, cdp-ownerless-refused, no-tcp-probe-helpers).

### Cross-tree isolation (W4-P2-16)

The launcher verifies, via /proc argv inspection, that the process
holding the helper status port and the Chromium profile belongs to the
same tree (exact binary, exact profile dir, exact helper version). A
foreign browser behind the same port is refused with a fail-closed
RuntimeError rather than adopted. Same for the egress forwarder port
(W3-P2-12): exact proxy_forwarder.py argv + exact port.

### Authenticated egress forwarder (W4-P2-9)

The loopback CONNECT forwarder (proxy_forwarder.py) refuses to start
without MORROW_FORWARDER_LAUNCHER_PID in its environment (fail closed,
exit 2). Every CONNECT is authorized by client-process ancestry:
the client socket's owner is resolved through /proc/net/tcp ->
socket inode -> /proc/<pid>/fd, and the owner must be a strict
descendant of the launcher PID (PID-reuse-safe via starttime-keyed
cache). Non-descendants get HTTP 403 before any request byte is
processed. The launcher passes its PID via the forwarder's child
environment (never argv) and adopts a listening forwarder port only
when the holder's environ names the current launcher PID
(_verify_forwarder_holder); a forwarder owned by another launcher is
refused, not adopted. Coverage: egress_selftest.py sections (c)/(d),
local_chromium_selftest.py verify-forwarder-holder-*.

### HTTPS upstream proxy: TLS before auth (W4-P1-3)

An https:// upstream proxy scheme gets a real TLS handshake before any
CONNECT or Proxy-Authorization byte is written; Proxy-Authorization
travels inside the tunnel, never in plaintext. Verified end-to-end in
egress_selftest.py section (e) with a throwaway self-signed TLS proxy:
the fake proxy asserts the first bytes are a TLS ClientHello and that
CONNECT + Proxy-Authorization arrive inside the encrypted channel.

### HTTPS-only navigation (W4-P1-12, W4-P2-8)

Both transport/_assert_https_nav_url and helper _cdp_proxy_nav_ok
permit https:// only (about:blank narrowly allowed for new tabs, where
no credentialed traffic flows). http:// is refused so session cookies
can never cross the wire in cleartext. The old document.title-based
logged_in check is gone; login state comes from the document URL.
Coverage: local_chromium_selftest.py (https-nav-guard) and
helper_selftest.py section 14 (W4-P2-8 navigation URL policy probe).

### Isolated-world API fetches (W4-P1-13)

API fetches run inside a Page.createIsolatedWorld context: the fetch
JavaScript executes in an isolated realm whose objects cannot be
reached by page scripts, so a compromised page cannot exfiltrate or
rewrite the requests. The trust boundary: the isolated world trusts
Chromium's world isolation, not page content; responses are still
validated as JSON before use. Coverage: local_chromium_selftest.py
(isolated-world checks).

### Downloads denied, fail closed (W4-P2-18)

Browser.setDownloadBehavior({"behavior":"deny"}) is set on every
session; there is no download-accept path. Any page that triggers a
download fails closed (the download is dropped, the op errors) rather
than writing untrusted bytes to disk. Coverage:
local_chromium_selftest.py.

### Root / --no-sandbox decision (W4-P0-9)

Sandbox status: --no-sandbox is appended only when euid == 0, at the
single launch site, with a loud WARNING log line (W4-P0-9).
Alternatives assessed on 2026-09-22 on this VM (root, unprivileged
user namespaces available): Chromium refuses to run as root without
--no-sandbox (crbug.com/638180, exit 1); dropping to a non-root user
via setpriv crashed the sandbox host (exit 133, crashpad
--database errors) even with --no-sandbox, because the sandbox
subprocesses need a writable HOME/XDG runtime dir that was not
provided. The pragmatic resolution for this agent-VM environment is
root + --no-sandbox + the rest of this hardening stack (private pipe
CDP, token-authed helper proxy, https-only navigation, denied
downloads, authenticated egress forwarder). The flag remains a loud,
single-site, root-only exception, not a default. If a future
deployment runs as non-root with a writable runtime dir, re-probe
non-root launch and drop the exception.
