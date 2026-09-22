# Canvas Login Helper (packaged)

The sign-in companion for Morrow's local-Chromium lane. The educator signs
into Canvas **once** in the helper's browser; the persistent profile
keeps the authenticated session across helper and machine restarts, so
nobody signs in again unless Canvas itself expires the session.

## Profile design

- The default profile is derived from the server's own location:
  `helper/profile/` next to `helper/server.py`. It is not derived from
  the working directory, and there are no hardcoded machine paths
  anywhere.
- `LOGIN_HELPER_PROFILE_DIR` overrides the default (tests and special
  setups). The override is expanded (`~` etc.) at startup.
- **Production-port guard:** requesting EITHER production port
  (HTTP 8901 OR CDP 19223) without `LOGIN_HELPER_PROFILE_DIR` set is a
  FATAL error (exit 3), regardless of which profile would be used. This
  keeps a stray bare launch from ever squatting the production ports.
  (`LOGIN_HELPER_PRODUCTION=1` is the explicit escape hatch; it exists so
  tooling can bind the production ports deliberately. The helper itself
  never needs it, because keepalive.sh always exports the profile var.)
  A scratch profile on production ports is allowed here only when the
  profile is explicitly pinned; the CDP attach check (a foreign browser
  on the port is refused, never adopted) is the backstop.
- **Bind guard:** `LOGIN_HELPER_BIND` defaults to `127.0.0.1`. Binding a
  non-loopback address (e.g. `0.0.0.0`) without `LOGIN_HELPER_BIND_PUBLIC=1`
  is a FATAL error (exit 1) at startup. Publishing the helper's
  session-driving API to the network requires the explicit opt-in.
- **Public-bind cleartext warning (W5-P2-3):** the helper has NO TLS
  mode. With `LOGIN_HELPER_BIND_PUBLIC=1` the launch token, `/screenshot`
  bytes, and the `/cdp/*` proxy cross the LAN in cleartext; anyone able to
  observe LAN traffic can steal the token and drive the session-bearing
  browser. Startup prints a loud WARNING to stderr on every launch with
  the opt-in set. Keep the loopback bind unless remote access is genuinely
  required; there is currently no TLS mode to choose instead.
- **Host-header validation (W5-P0-1, DNS-rebinding defense):** every
  request's `Host` header must name this listener: `127.0.0.1`,
  `localhost`, `::1`, or the configured `LOGIN_HELPER_BIND`. A hostile
  page in the helper's own Chromium can rebind its DNS to 127.0.0.1 and
  become same-origin with the helper; without this gate it could fetch
  the open `GET /` page, steal the injected token, and drive the full
  browser API. The gate runs before rate limiting, routing, and auth on
  every method; a foreign Host gets `403` JSON with a generic body (no
  token material), and the offending host is logged.
- **Tree-default-profile guard:** when the resolved profile is this
  tree's own `helper/profile/` default AND the ports are not the
  production pair, startup is refused (exit 3) unless the profile was
  explicitly pinned via `LOGIN_HELPER_PROFILE_DIR` (an explicit pin,
  even to the default path, proves intent: this is what keepalive.sh
  and multi-tree deployments do) or
  `LOGIN_HELPER_ALLOW_TEST_ON_LIVE_PROFILE=1` is set. Bare test
  launches must pass an explicit scratch profile; they can never
  silently use the tree's real profile.
- **The only supported launch path is `helper/keepalive.sh`**, which
  sources the tree's own `helper/env` (not the global `~/.morrow/env`;
  the global file is honored for `CANVAS_BASE` only), pins
  `LOGIN_HELPER_PROFILE_DIR` to the tree's `helper/profile/` and
  `LOGIN_HELPER_CDP_PORT` to the tree's CDP port, then starts the
  server with an absolute path. Do not hand-launch `server.py` without
  `CANVAS_BASE` exported: `server.py` sources `<tree>/helper/env`
  itself (real environment wins), and the guard treats a bare launch
  on the production ports with the live profile as a config error.
- Port escape hatches: `LOGIN_HELPER_PORT` (default 8901) and
  `LOGIN_HELPER_CDP_PORT` (default 19223). Ephemeral ports plus a
  scratch `LOGIN_HELPER_PROFILE_DIR` are how the selftests boot the
  server without touching anything live.
- **CDP attach check:** when a CDP port is already held, the server
  verifies the holder's `--user-data-dir` resolves to its own profile
  before attaching. A foreign browser is refused loudly, never
  adopted, never killed.
- **Version identity:** `/status` reports `helper_version` (the tree's
  `VERSION` file). keepalive.sh recycles a server whose version differs
  from the tree's instead of adopting it (stale pre-upgrade servers
  never coexist with the new keepalive).

## Files

- `server.py` - the helper: launches headless Chromium with the persistent
  profile, serves the sign-in UI, and exposes `/status`, `/screenshot`,
  `/input/*`, `/navigate` on `127.0.0.1:8901` (override with
  `LOGIN_HELPER_PORT` / `LOGIN_HELPER_BIND`). Needs `CANVAS_BASE` (env or
  first argument); refuses to start without a tenant. Every
  POST/PUT/DELETE/PATCH endpoint and `GET /screenshot` require the
  `X-Helper-Token` header (see "Token auth" below); `GET /status`,
  `GET /`, and `GET /logo.png` are open.
- `index.html` - the sign-in UI served by the server.
- `logo.png` - the Morrow logo used by the UI.
- `keepalive.sh` - cron supervision (every 5 min). Sources the tree's
  own `helper/env` for `CANVAS_BASE` (the legacy global `~/.morrow/env`
  is honored for `CANVAS_BASE` only), pins `LOGIN_HELPER_PROFILE_DIR`
  (the tree's `helper/profile/`) and `LOGIN_HELPER_CDP_PORT`, then
  starts the server. Tree-gated recovery: it only ever kills this
  tree's server (verified by cmdline), reaps only this tree's Chromium
  (verified by exact `--user-data-dir`), reaps only this tree's
  orphaned egress forwarders (verified by exact forwarder port), and
  serializes on a per-tree lock under `~/.morrow/trees/<tree-id>/`.
  Never attempts a sign-in; a logged-out session is reported, not
  "recovered". A `/status` whose `helper_version` differs from the
  tree's `VERSION` is recycled, never adopted.
- `helper_selftest.py` - the offline packaging-contract suite (no live
  browser needed): installer contract, deny-list enforcement, endpoint
  agreement, startup behavior.
- `live_behavior_check.py` - the manual live proof (needs the running
  helper on this VM; never run by install.sh or any suite): session
  persistence across a real restart, exactly-one-Chromium, dead-session
  redirect with a throwaway profile, and the plugin-attachment proof
  (`GET /api/v1/users/self` through the attached CDP session).

## Why sessions survive restarts

1. One profile, never wiped: Chromium's `--user-data-dir` is always
   the resolved profile (`helper/profile/` by default, or the
   `LOGIN_HELPER_PROFILE_DIR` override).
2. The helper lands on the tenant **homepage**, never the login form. The
   login form does not reliably auto-redirect on a live session, which
   used to make live sessions look logged out and forced needless
   re-sign-ins. With a live session the homepage renders the dashboard;
   with a dead one Canvas redirects to the login form itself.
3. The educator ticks "Stay signed in" at login, so Canvas issues the
   long-lived remember-me cookie.

## Chromium memory policy (W2-P2-6)

Headless Chromium runs for days and its process tree's memory grows.
keepalive enforces this policy on every healthy tick
(`logged_in=true` in `/status`):

1. **Measure the whole tree.** `helper/memory_watch.py` totals RSS
   over the Chromium main process plus all descendants, identified by
   the exact profile-dir + CDP-port pair (never a port-only or
   substring match, so another tree's or the live helper's browser is
   never touched).
2. **Reap idle tabs.** Tabs this tree opened are tracked in
   `morrow-tab-registry.json` inside the profile dir (shared across
   processes). A tab is closed only when it is registry-owned, not
   protected (the helper's primary tab is protected), has had no CDP
   activity for `CHROMIUM_IDLE_TAB_MINUTES` (default 30), and shows
   nothing (`about:blank`, empty, or a Chrome error page). A tab
   showing real content is never reaped. The SDK's temp tabs
   unregister themselves on close.
3. **Restart over threshold.** When the tree's RSS exceeds
   `CHROMIUM_MAX_RSS_MB` (default 2048) or the browser is older than
   `CHROMIUM_MAX_BROWSER_AGE_H` (default 0, disabled), memory_watch
   exits 3 and keepalive recycles the browser with a loud
   `MEMORY POLICY` log line. The session survives: cookies live in the
   persistent profile, so the relaunch re-reads them.
4. **Safety gates.** A restart happens only when the executor journal
   is quiet (no journal write in `CHROMIUM_RESTART_QUIET_MINUTES`,
   default 10, so a run is never interrupted) and outside the restart
   cooldown (`CHROMIUM_RESTART_COOLDOWN_MINUTES`, default 60, so a
   restart can never loop). After the restart keepalive re-probes and
   reports the fresh status rather than the pre-restart verdict.

## Token auth

The helper's session-driving API is protected by a launch token
(W3-P0-7/W3-P0-8). Without it, any local process (or anything a port
forward/tunnel exposes the port to) could type into the live Canvas
session, click, navigate it anywhere, or watch the page (including
password entry) through `/screenshot`.

- **Minting:** `keepalive.sh` mints a 64-hex token at launch, writes it
  to `${TREE_STATE_DIR}/helper_token` (mode 0600), and exports
  `HELPER_AUTH_TOKEN` into the server's environment. The file persists
  across restarts, so the token is stable per tree.
- **Rotation:** delete `${TREE_STATE_DIR}/helper_token` and relaunch the
  helper; a fresh token is minted.
- **Dev/bare launches:** with `HELPER_AUTH_TOKEN` unset the server mints
  an ephemeral token at startup and prints it to the live console only
  (never to `server.log`); it dies with the process.
- **Protected:** every POST/PUT/DELETE/PATCH endpoint on any path, plus
  `GET /screenshot`. They require the `X-Helper-Token` header to equal
  the token; anything else gets `403` JSON `{"error":"forbidden"}`.
- **Open:** `GET /status` (health only), `GET /` (the sign-in UI),
  `GET /logo.png`. The server injects the token into a
  `__HELPER_TOKEN__` placeholder when serving the UI, so the page's own
  fetch calls carry the header.
- **Python consumers:** `transport/local_chromium.py` reads the token
  from `${TREE_STATE_DIR}/helper_token` and sends `X-Helper-Token` on
  every helper request through the single `_helper_request` path
  (`helper_status`, `helper_screenshot`, `helper_input_key`,
  `helper_input_mouse`, `helper_navigate`).
- **Method routing:** a wrong method on a known path is `405` JSON
  (e.g. `POST /status`); an unknown path is `404` JSON. Oversized bodies
  are `413` JSON, malformed JSON bodies are `400` JSON.

Honest statement of the security property: the token stops
blind/off-origin API use and port-forward exposure (the unauthenticated
tunnel scenario). It does not stop a party that can already read the
locally served page, since the token is injected into that page.

## Hardening (W3-P2-7)

Four mechanisms bound what a misbehaving or abusive local client can do
to the helper process. Check order per request: 503 (thread cap, at
accept) -> 403 (Host gate, W5-P0-1) -> 429 (rate limit) -> 403 (auth) ->
404/405 -> 400/413 -> handler. The 503, Host gate, and 429 answers
precede auth deliberately: load shedding and the rebinding defense run
before anything else, and under the limits the auth matrix is unchanged.

- **Rate limiting:** per-IP token bucket, checked before auth and
  routing. Defaults: burst **120**, sustained **20 requests/second** per
  IP. On the loopback bind this is effectively one shared bucket, which
  is the intent: it bounds total load on the helper process. Past the
  limit the server answers `429` JSON `{"error": "rate limit exceeded"}`
  with a `Retry-After: 1` header. Rejected requests are not logged
  per-request (that would reintroduce the log-write amplification this
  fixes); at most one summary line per minute reaches the log.
  Why these numbers are safe for the real clients: the sign-in UI polls
  `/status` every 2s and streams `/screenshot` every 500ms (about 2.5
  rps steady state); the Python transport makes sequential helper calls
  with 10-20s client timeouts; frantic typing bursts (a POST per
  key-down/up) fit inside the 120 burst. A tight abuse loop at tens of
  requests per second exhausts the burst in seconds and then gets 429s.
- **Thread bound:** at most **16** concurrent request-handler threads
  (up from the old unbounded growth: one thread per connection, no
  ceiling). Past the cap, connections are rejected inline on the accept
  thread with `503` JSON `{"error": "service unavailable"}` and
  `Retry-After: 1`; no worker thread is spent on a shed request (also
  logged as a per-minute summary, never per-request). Handler threads
  are daemons, so a hung worker can never wedge process shutdown.
  Sixteen is several times the real concurrency (one UI tab plus the
  transport plus keepalive's probe).
- **Request timeouts:** every socket I/O operation must make progress
  within **30s** (a stalled client cannot hold a worker thread on
  recv/send), and the whole request (read + handler) has a **60s**
  deadline. A watchdog closes the connection at the deadline and
  reclaims the worker slot immediately. Python cannot kill a thread, so
  a truly deadlocked worker may linger until its own blocking call
  returns, but it no longer counts against the thread cap and the
  client never waits past the deadline. In practice every BROWSER CDP
  call carries its own shorter timeout (10-20s), so a stuck handler is
  released when its CDP call times out. Each connection serves exactly
  one request, so the deadline is per-request.
- **Log rotation:** `server.log` rotates when it passes **1 MiB**,
  keeping **4** archives (`server.log.1` newest through `server.log.4`),
  so the log can never grow past about 5 MiB. Rotation is copytruncate
  against the file stdout is appended to (discovered via
  `/proc/self/fd/1`, which is how keepalive.sh launches the server):
  the live file is copied to `server.log.1` and truncated in place, so
  keepalive's open append descriptor keeps working and no log line is
  reformatted (the `[login-helper] ...` format is unchanged). The server
  forces O_APPEND on its own stdout at startup, so the in-place
  truncate stays correct even if stdout was redirected with `>` instead
  of `>>`. A write
  racing the copy/truncate window can be lost; that is acceptable for a
  diagnostic log. When stdout is not a regular file (console or pipe,
  e.g. a dev run), rotation is skipped.

Tuning knobs (env, all optional; the selftest pins them small):

| Variable | Default | Meaning |
|---|---|---|
| `LOGIN_HELPER_RATE_LIMIT_BURST` | 120 | token bucket capacity per IP |
| `LOGIN_HELPER_RATE_LIMIT_RPS` | 20 | sustained requests/sec per IP |
| `LOGIN_HELPER_MAX_WORKERS` | 16 | max concurrent handler threads |
| `LOGIN_HELPER_REQUEST_TIMEOUT` | 60 | total seconds per request |
| `LOGIN_HELPER_SOCKET_TIMEOUT` | 30 | seconds per socket I/O op |
| `LOGIN_HELPER_LOG_ROTATE_BYTES` | 1048576 | rotate server.log past this size |
| `LOGIN_HELPER_LOG_ROTATE_KEEP` | 4 | rotated archives to keep |

## /status

`GET /status` returns `url`, `logged_in`, `profile_dir`,
`profile_has_cookies` (computed fresh on every request),
`chromium_alive`, and `starting` (true when Chromium is alive but the
tab is still `about:blank`/empty). `url` is scheme://host/path only:
the query string and fragment are stripped for output (the `logged_in`
check keeps using the full href internally). `profile_dir` abbreviates
`$HOME` as `~`, so the account name never leaves the box. The page title is deliberately not
returned: `document.title` is page-controlled text and page JS can copy
cookie values into it, so echoing it would let a hostile page
exfiltrate session material through `/status` (fixed 2026-09-21 after a
live synthetic-cookie proof). `logged_in` is true only when the
URL equals the configured tenant base (or starts with it plus `/`)
and is not a Chrome error page, a `/login` path, or a Canvas error
page. Diagnostic: `logged_in: false` with
`profile_has_cookies: false` and `chromium_alive: true` on a fresh box
is normal first onboarding (sign in once); the same on a
previously-working box is a config error (wrong profile path), never a
dead session.

## Privacy

Keystrokes go straight into the Canvas page via CDP. The server logs event
counts and types only: never key values, text, coordinates, cookies, or
tokens. The profile directory holds the session and is never part of the
download.
