# Moodle session lane (Morrow for Muse)

This lane ships in Morrow for Muse 0.4.5 as a
separate Moodle HTTPS module. The root `SKILL.md` routes Moodle requests
here; `INSTALL.md` explains the shared, hash-locked runtime dependencies.
The package does
not include a production VM-browser-to-Python session handoff command.

Live-proven against the official Moodle 5.2 public demo. Current
operation statuses are in `../proof-battery/OPERATION_CATALOG.md`.
Detailed sandbox journals and proof drivers stay in the source repository
and are not included in the educator package.

## What this lane is

The Moodle half of the two-lane architecture (architecture doc section
3.3): one session cookie plus the visible per-session sesskey, then pure
HTTPS from then on. No MCP, no bridge, no token minting.

HTTPS is mandatory: the lane refuses a plaintext `http://` base before
any session is created or any cookie attached (session cookies and
credentials would cross the network unencrypted). `MOODLE_BASE_ALLOW_HTTP=1`
overrides the refusal for test fixtures and LAN-only deployments only;
never for a real tenant.

## Files

- `login.py`: sandbox session bootstrap. Form login with the
  provider-published demo credentials (logintoken anti-CSRF handled),
  sesskey discovery from `M.cfg` on an authenticated page, and a
  sesskey stability check. The cookie jar lives in memory only; stdout
  carries names, lengths, and statuses, never values. Its standalone
  command is a demo check; exiting ends the session and does not start
  a scheduled keepalive.
- `keepalive.py`: one read-only `/my/` GET for a caller that already holds
  a live in-memory `MoodleSession`. It reports healthy only when the site,
  pinned principal id, and sesskey match. It never returns page content
  or session values. The legacy scheduled shell script cannot use this
  function because it has no live session object to pass.
- `session.py`: `MoodleSession`: a low-level session-authenticated dispatcher.
  Primary path `POST {base}/lib/ajax/service.php` with the
  `[{index, methodname, args}]` envelope; form-path fallback for
  functions the site does not AJAX-expose. Expiry classifier
  (`classify_signal`), journal (append-only JSONL), used-op-id set,
  frozen-plan writes with optional verify blocks, truncation caps. This
  module does not enforce the Canvas executor's catalog, mode, or approval
  gate; do not use its write method for production course changes.
- `probe.py`: connect-time capability probe (read-only): version,
  principal, per-function `allowed_from_ajax` classification by live
  behavioral probing, session cookie shape, sesskey stability, and the
  deployment killers that are config-gated (recorded as unobservable,
  not wished away).
- `reauth.py`: the Lane 2 re-authentication state machine
  (detect / halt / notify / re-sign-in / verified resume with principal
  pinning) plus a drill that runs it against simulated dead-session
  signals and receipts every transition. The principal pinning is
  non-vacuous: at least one non-empty field (id or username) must
  match, so an empty extraction can never approve resuming
  quarantined ops.

## Theme and version coupling (honest limits)

The lane is proven against the stock Moodle 5.2 theme on the sandbox.
The bootstrap/discovery layer couples to these deployment details:

- Sesskey shape: the regex accepts 10 or more alphanumerics (5.x uses
  exactly 10). A tenant with a different token shape still breaks
  discovery; the failure is a loud RuntimeError, not silent.
- `/my/` disabled: sesskey discovery and principal extraction try
  `/my/` first, then the site front page (`/`). A tenant where
  neither page carries M.cfg fails bootstrap loudly.
- Principal extraction: `extract_principal` scrapes one theme's
  user-menu markup (`class="usertext..."`, `class="userbutton"`) and
  returns `{}` when the markup misses. That empty result feeds the
  re-auth pinning, which treats it as zero evidence: a vacuous match
  can never approve resuming quarantined ops.
- Form login: the bootstrap requires a `logintoken` field on
  `/login/index.php`. SSO-first tenants (no password form) cannot
  bootstrap this way at all.
- `probe.py` behavioral-tests the function set per tenant, but these
  bootstrap assumptions still have to hold first.
- A simple Moodle base path such as `/moodle` stays attached to login,
  dispatch, and read-only health URLs. URL credentials, query, fragment,
  traversal, and encoded path segments are refused. This path handling
  has local regression coverage; a school path-prefix deployment has
  not been live-proven.
- The live write battery verifies reads, a frozen plan, a forum-discussion
  create, readback, undo, and absence. Its receipts stay in the source
  repository. Runtime journals are local to the configured journal
  directory and contain bounded receipts, not cookie or password values.
- The live write batteries live in
  `../proof-battery/evidence/moodle-wave2/` (`proof_run2.py`,
  `discover_wave2.py` and friends), not in this directory.

## Key mechanism findings (all live-verified 2026-09-20)

1. Moodle 5.2 renamed the AJAX gate: `allowed_from_ajax`, derived from
   `ajax => true` in `db/services.php` (via the legacy
   `*_is_allowed_from_ajax()` method). `lib/ajax/service.php` throws
   `servicenotavailable` for anything not allowed. Source:
   `evidence/moodle-502-external_api.php` (`call_external_function`).
2. On this sandbox (stock 5.2): `core_course_get_contents` is NOT
   ajax-exposed (confirms the DIVERGENCE report's dead-sample claim,
   with the mechanism). The form path is the required fallback.
3. `mod_forum_delete_discussion` is NOT REGISTERED in 5.2's forum
   `db/services.php` at all: calling it returns a top-level
   `invalidrecordunknown` dict, byte-identical to calling a nonexistent
   function. The classifier reports this as `not_registered`, never as
   a domain error. The undo for a discussion create is the form-path
   delete of its first post (deleting the first post deletes the whole
   discussion).
4. Dead-session signals on 5.2: AJAX `servicerequireslogin` (HTTP 200
   envelope); page requests 303 to `/login`. A garbled sesskey is
   `invalidsesskey` (refresh the visible value, retry once), NOT a
   re-auth event.
5. The sandbox resets hourly, which ends all sessions: the natural
   expiry story for the demo, and the reason keepalive design targets
   the 6-hour cadence against the 8-hour idle default on real sites.
6. Grade-item deletion on 5.2 (live-verified 2026-09-22): use the grade
   tree route `grade/report/grader/index.php` (course context) with
   `action=delete&confirm=1&eid=ig<N>`; `grade/edit/tree/action.php`
   with `action=delete` silently fails (200, nothing deleted). Always
   verify the item is gone from the grade report after the delete.
7. Sandbox provider change (live-verified 2026-09-22): AJAX webservices
   are disabled provider-wide on sandbox.moodledemo.net, including
   `core_webservice_get_site_info`. The page/form fallback path is the
   live-proven route there; if AJAX is ever re-enabled, the AJAX paths
   need a fresh live proof before they are trusted again.
