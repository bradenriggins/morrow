# Moodle session lane (Morrow Direct)

Live-proven against `https://sandbox.moodledemo.net` (Moodle 5.2, the
official public demo; teacher account, published demo credentials).
Proof: `../proof-battery/evidence/moodle-wave2/journal/moodle.jsonl`
(the wave-2 live journal) and `../proof-battery/LEDGER.md` (M-W1, M-W2).

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

- `login.py`: session bootstrap. Form login with the provider-published
  demo credentials (logintoken anti-CSRF handled), sesskey discovery
  from `M.cfg` on an authenticated page, sesskey stability check. The
  cookie jar lives in memory only; stdout carries names, lengths, and
  statuses, never values.
- `session.py`: `MoodleSession`: the session-authenticated dispatcher.
  Primary path `POST {base}/lib/ajax/service.php` with the
  `[{index, methodname, args}]` envelope; form-path fallback for
  functions the site does not AJAX-expose. Expiry classifier
  (`classify_signal`), journal (append-only JSONL), used-op-id set,
  frozen-plan writes with verify blocks, truncation caps.
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
- `proof_run.py`: the live write battery: reads, frozen plan, form-path
  discussion create, frozen readback, form-path undo, verify-gone, with
  before-state snapshot and leftover cleanup. Full cleanup verified.
  (Lives at `../proof-battery/evidence/moodle-wave2/proof_run2.py`; the
  name in this directory is historical.)
- `journal/` is NOT kept here: live JSONL receipts live at
  `../proof-battery/evidence/moodle-wave2/journal/moodle.jsonl`
  (append-only by convention). Shapes, statuses, lengths, IDs only:
  no cookie values, no sesskey values, no passwords, ever.
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
