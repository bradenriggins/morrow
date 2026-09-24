# First-run checklist: brand-new educator, first hour

V1 (2026-09-22). The agent-facing checklist for taking an educator
from zero to their first real task. The educator does everything by
talking to Muse; shell commands below are operator diagnostics, never
educator homework.

## 1. Install

Run `install.sh` from the dist root. Expected:

- Integrity check against `pack/carve-manifest.json` passes.
- All 23 selftest suites pass (any failure fails the install and names
  the suite).
- Secrets deny-list gate passes before the helper launches.
- With no `CANVAS_BASE` set, the installer skips the helper launch and
  says so plainly; onboarding is reported incomplete until a real
  signed-in session exists.

## 2. Connect Canvas (conversational)

1. Educator says "Connect my Canvas account."
2. Agent shows `content/consent.md` and waits for agreement.
3. Agent asks for the school's Canvas URL only if it cannot determine
   it safely; confirms it with the educator otherwise.
4. Agent writes `CANVAS_BASE=<address>` to the tree's `helper/env`
   (plus `CANVAS_BASE_CUSTOM_DOMAIN_CONFIRMED=<exact host>` when the
   host does not end in `.instructure.com` and the educator confirmed
   it is their school's Canvas), then runs `bash install.sh` again.
   The installer probes the tenant before anything else: placeholder
   hosts (`your-school`, `example.com`, bare `instructure.com`),
   unreachable hosts, and Canvas error pages fail loudly here, not
   three minutes into a browser launch. Only then does it start the
   helper.

## 3. Sign in (educator's hands only)

1. The educator signs in on the login helper page, exactly as they
   normally would, including MFA. The agent never sees the password.
2. Agent verifies immediately and pins the account:
   `python3 reauth/state_machine.py pin --first-signin`. It checks the
   helper `/status` shows a live session, reads GET
   /api/v1/users/self, and pins that principal id and name into the
   lane state (`~/.morrow/browser_lane.json`). Confirm the printed
   name with the educator. (keepalive also runs this on its first
   healthy tick, so a pin exists even if this step is skipped.) A
   failure here means the sign-in did not stick: ask once more, then
   stop and report. Later re-sign-ins lift the pause on changes only
   for this pinned account.
3. The sign-in notice stops repeating only when a genuinely
   authenticated session with stored cookies is confirmed
   (`logged_in=true`, `profile_has_cookies=true`).

## 4. First real task (harmless read)

The educator's first request should be a read: "Show me my courses."
Expected behavior:

- Before setup: the request returns `setup-tenant-not-configured`
  with a warm, specific next step (connect Canvas, sign in, retry),
  never the generic unknown-failure message.
- After setup: the read succeeds and the educator sees their real
  courses.

## 5. Choose a mode (conversational)

- Plan mode is the default: reads need no approval, writes require
  approval of a validated plan.
- Edit mode is one blanket grant with no time limit: "use edit mode"
  turns it on, "turn off edit mode" puts the educator back in plan
  mode everywhere. Reads stay unrestricted; in edit mode writes stop
  surfacing per-change approval.
  That is the only difference between the two modes: reads never
  need approval in either one, and the agent confirms the course
  with you conversationally instead of guessing, in either mode.
- The agent states the current mode when it matters; the educator
  never hunts a settings page.

## 6. Setup failure states (what the educator sees)

| State | Educator hears |
|---|---|
| Canvas not connected yet | `setup-tenant-not-configured`: Morrow is not connected yet; tell me your school's Canvas URL, sign in on the helper page, I verify and retry. |
| Login helper not running | `helper-down`: the helper is asleep; I am waking it up, then checking your sign-in. |
| Signed out / session expired | Session-expired flow: your sign-in expired; sign in again on the helper page, and I check it is still you before I make any change again. A change I had not sent yet did not change anything in Canvas, and it waits for your OK. A change I was sending may already be in Canvas: I check the course first and ask for your OK before I prepare it again. |
| Bad school URL | Tenant probe failure at configure time: the address did not load; check it and try again. |

None of these may surface as the generic unknown-failure message.
That fallback is reserved for genuinely unclassified failures, and
every setup state above has a classified mode with a regression test.

## 7. Reinstall and idempotence

- Rerunning `install.sh` revalidates the installation, keeps keepalive
  entries for other installed trees, and never wipes the helper profile.
- Revocation: signing out in the helper browser ends the session.
  `bin/morrow disconnect --yes` disconnects fully: it stops the helper,
  stops the keepalive background loop and removes the keepalive cron
  entry (either would otherwise relaunch the
  signed-in helper within 5 minutes), deletes `<tree>/helper/profile/`
  and the pinned account, and verifies each step. Reconnecting is
  rerunning `install.sh`, then steps 2 to 4.

## Regression coverage

- `failures/test_error_translation.py`: every catalog mode (now 97)
  has a fixture; `setup-tenant-not-configured` and `helper-down`
  fixtures use evidence the producers actually emit.
- `failures/selftest_smoke.py` and `failures/selftest_wiring.py`:
  the funnel translates, raw text is never the message, secrets are
  scrubbed.
- Install suites (23) run from the carved dist on every install.
