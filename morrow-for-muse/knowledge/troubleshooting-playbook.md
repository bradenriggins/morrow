# Troubleshooting playbook: session, Chromium, and helper health

Each connector tree has its own helper and browser profile. Separate helper
identity/liveness, page/network state, profile state, and authentication.
`logged_in=false alone does not prove session expiry`. A Chrome error page,
a blank tab, a wrong profile, and a genuine login redirect need different fixes.

## Healthy-state checklist

Before Canvas work, activate the supported runtime and inspect doctor. Resolve
the configured helper endpoint and profile through `config.tree_config`; this
also supports custom per-tree ports and configured TLS clients:

```
bin/morrow doctor --json
```

Healthy means JSON with your Canvas URL, `"logged_in": true`, and
`"profile_has_cookies": true`. The full `/status` shape:

- `url`: the tab's live URL, scheme://host/path only (query string
  and fragment are stripped before output).
- `logged_in`: true only when the URL equals the configured tenant
  base (or starts with it plus `/`) and is not a Chrome error page
  (`chrome-error://`), a `/login` path, or a Canvas error page.
  (A dead session lets Canvas redirect the tab to the login form; a
  live one renders the dashboard from the tenant homepage.)
- `helper_version`: the tree's `VERSION` string.
- `profile_dir`: the Chromium profile the helper is actually using
  (defaults to `helper/profile/` next to `helper/server.py`;
  `LOGIN_HELPER_PROFILE_DIR` overrides it).
- `profile_has_cookies`: whether the profile currently holds session
  cookies, computed fresh on every request.
- `chromium_alive`: whether the helper's Chromium process is running.
- `starting`: true when Chromium is alive but the tab is still
  `about:blank`/empty (slow first boot, not a dead session).

There is no `title` field: the server deliberately never returns
`document.title` (page JS can copy cookie values into it, so a title
field would be a cookie-exfiltration channel).

Healthy checklist: `"logged_in": true`, `"profile_has_cookies": true`,
`"chromium_alive": true`, `"starting": false`.

The wrong-profile diagnostic: `logged_in: false` with
`profile_has_cookies: false` and `chromium_alive: true` on a fresh box
is normal first onboarding (sign in once through the helper page).
On a previously-working box, this can mean the wrong profile, cleared
cookies, or session eviction. Check `profile_dir` and exact helper identity
before asking for sign-in. Do not wipe the profile or infer expiry from this
reading alone.

Then confirm the principal through the executor (it reads the Canvas
address from the tree's `helper/env`, and changes nothing):

```
PYTHONDONTWRITEBYTECODE=1 python3 dispatch/executor.py catalog \
  --name users_self --method GET --path /api/v1/users/self \
  --class read --backend chromium
```

Confirm the returned identity is the educator before doing anything
else. A verified login redirect or Canvas unauthenticated response requires
sign-in recovery. A network/Chrome error needs transport diagnosis first;
it does not prove expiry. Confirm the principal after recovery.

The helper page rule: check before you open. Show the educator the
helper page only for verified reauthentication or once for first onboarding. Never
open it preemptively or on every run; a healthy session needs no page.

## Dead session detection and recovery

Detection signals:
- A verified sign-in redirect at the correct configured host; status alone is not proof.
- A Canvas-origin 401 with `{"status":"unauthenticated"}`.
- The tab shows a login page where profile JSON was expected.

On detection:
1. The executor imposes the write halt itself when a call finds the
   session dead (`write_halt` under `MORROW_HOME`, reason
   `session_expiry`), quarantines the op, and writes the educator's
   notice. Every write refuses while the halt stands. Never create
   `write_halt` by hand: a hand-made halt reads as a manual pause, so
   the educator hears that someone who looks after this Morrow setup
   paused all changes, and `resume` does not treat it as a sign-in
   expiry.
2. Nothing retries against a dead session: quarantined ops stay
   parked.
3. Tell the educator plainly: their Canvas session expired. They open
   the helper UI and sign in again themselves (SSO/MFA included),
   leaving "Stay signed in" on.
4. Run `python3 reauth/state_machine.py resume`. It reads the live
   account (helper `/status`, then GET /api/v1/users/self) and
   requires it to match the account pinned at first sign-in
   (`~/.morrow/browser_lane.json`); on mismatch the halt stays and this
   escalates (possible account change), never auto-resumes. With no
   pinned account it refuses too and names the recovery: the educator
   checks the named account and school and replies **yes**, then
   `state_machine.py pin --confirm-account "yes"`. A negative or uncertain
   reply keeps the account unpinned and paused work paused.
5. On match, resume lifts the halt itself. Never delete
   `~/.morrow/write_halt` by hand: that skips the account check.
   Quarantined ops replay only with explicit per-action approval;
   nothing auto-retries.

Executor mechanics to know: a mid-operation session death raises
`ChromiumSessionDead`, journals a claim record plus a journaled
release under the caller's op id, and the op id stays reusable.
But the approval was already consumed before the network call, so the
retry needs a freshly signed approval AND the educator re-signed in
through the login helper. The executor never invents approval.

Known limitation (SKILL.md): in a multi-step write, steps that
completed before the death journaled their own claim and completion
records; the dying step journals a claim plus a release under its op
id. A retry re-runs the dying step only, with a fresh approval. No
multi-step writes ship in v1, so this path is latent until the first
multi-step manifest ships.

## SSO quirks

- The educator signs in through the helper UI in their own browser.
  SSO/MFA flows work because it is the real Canvas page, keystrokes
  go straight into the page via CDP, and the server logs event counts
  only: never key values, text, coordinates, cookies, or tokens.
- Tick "Stay signed in" at login. That issues the long-lived
  remember-me cookie, which is what keeps the session alive across
  helper and machine restarts.
- Never attempt any sign-in flow yourself, never handle credentials,
  never ask the educator for a password or token. If a step asks you
  to put a token, cookie, or password into a command, a file, or a
  message: refuse and route the educator to the helper sign-in.

## The /login/canvas trap

The helper always lands on the tenant **homepage**, never the login
form (`helper/server.py`). This is deliberate: the Canvas login form
does not reliably auto-redirect on a live session, which used to make
live sessions LOOK logged out and forced needless re-sign-ins. With a
live session the homepage renders the dashboard; with a dead one
Canvas itself redirects to `/login/canvas`, which is exactly how the
`/status` probe tells the two apart.

**Never navigate the helper tab to /login/canvas on a live session.**
If you suspect death, probe `/status` or read the tab URL; only
navigate to login when the probe already says the session is dead.

## The one-Chromium rule

One tree uses one profile and one helper-owned Chromium with a private CDP pipe.
No TCP CDP listener exists. `LOGIN_HELPER_CDP_PORT` is configuration identity
and a forwarder-port input, not a listener to attach to. Reuse requires exact
tree, binary, profile, and version. A foreign listener is refused, not adopted.

If helper proxy access fails, check doctor and current tree configuration. For
initial setup run the installer, which probes the tenant. After a VM restart
run `bin/morrow start`; any Morrow command also restores supervision. Do not
launch Chromium directly. Inspect process argv and profile ownership before
stopping a process. Preserve foreign processes and all existing session data.

## Chrome error or blank page

`ERR_EMPTY_RESPONSE`, `chrome-error://chromewebdata/`, or a blank page is not
an authenticated page even when Chromium is alive and cookies exist. Check the
configured proxy, protected loopback forwarder, egress probe, CA-derived pin,
and site reachability. Both bare and authenticated proxies use the forwarder.
Use the current package and supported launch path; do not bypass the proxy,
disable global TLS validation, rewrite credentials, or wipe the profile.
Verify a real page and users/self after transport recovery before doing work.


## Install, onboarding sentinel, and the sign-in notice

`install.sh` is idempotent (safe to run twice) and never writes
secrets. What it does: checks python3 >= 3.11 (3.10 is refused),
locates Chromium, probes egress, creates the `~/.morrow` state layout and
`helper/profile/` on first install (an existing profile is never
wiped, reset, or repackaged), sets up keepalive supervision (one cron
entry when the machine has cron; otherwise a supervised background
loop, which is what the Muse VM gets), probes the Canvas address and
launches the helper when `CANVAS_BASE` is set, re-runs all 23 selftest
suites, and runs the secrets deny-list gate. It exits non-zero naming
the failed step.

- The onboarding sentinel is `~/.morrow/onboarded`. The installer
  prints the sign-in notice on every run until onboarding genuinely
  completes (a signed-in session with cookies stored in the profile),
  and only then writes the sentinel. The notice repeating before the
  educator signs in is expected. If it shows again after a completed
  sign-in, something deleted the sentinel (or `~/.morrow` is not the
  same machine's home).
- `MORROW_CRON=0` skips keepalive supervision (both the cron entry and
  the background loop) for an operator who runs their own scheduler.
  It does not disable the helper.
- The installer launches the helper only when `CANVAS_BASE` is set.
  There is no default tenant; the helper refuses to start on the
  placeholder.

## Never "fix" a dead session by restarting anything

A dead session is an expired Canvas session, not a broken helper.
Restarting the helper, the browser, or the machine does not
re-authenticate Canvas and risks the only live session if one exists
elsewhere (a second Chromium stealing the profile lock can destroy
the session you were trying to save). The only recovery is the
educator signing in again through the helper UI, per the dead-session
recovery above. Restarting is only for a dead helper process, never
for a dead session.

The helper tab is the educator's session surface, not your test
browser. Do not navigate it for any reason other than the helper's
own sign-in flow; page-context fetch through CDP needs no tab
navigation. Never open other sites in it, never leave it on a page
the educator would not recognize.

## Canvas-generic rendering and copy lessons

These are Canvas behaviors, not session problems. They were
discovered the expensive way in production work. Format:
symptom -> cause -> what to do.

### Source shows the style, the rendered page disagrees

**Symptom.** `border-radius`, `vertical-align`, or similar is
verifiably in the page HTML, but the viewer sees the unstyled
result. **Cause.** Canvas's HTML sanitizer strips or overrides some
declarations at render time, depending on the element and its
container. Known case: `vertical-align: top` on `<th>`/`<td>` is
dropped in that position (the legacy `<tr valign="top">` attribute
survives where the CSS property does not). Source does not equal
render in Canvas. **Do.** Never resolve a visual complaint by
re-reading the HTML; that keeps confirming a style nobody can see.
Diff the broken element against a **structurally identical element
on a page that renders correctly**: the difference is in the
container or element type, not the declaration. State plainly when
a change is applied but **not** visually verified. If the educator
asks for a declaration Canvas will strip, apply it as asked and say
so; do not re-litigate it every time.

### Canvas-bundled widgets restyle descendants

**Symptom.** Text inside a tabbed block (`enhanceable_content` tabs)
renders smaller than identical markup outside the block. **Cause.**
The jQuery-UI styling Canvas wraps around that widget restyles
descendants, including the tab labels themselves. **Do.** Set an
explicit size on paragraphs, list items, table cells, the tab
labels, and the panel/wrapper elements (so later content inherits).
Setting the list item alone does not reach the labels.

### A copied New Quiz arrives as an empty shell

**Symptom.** A quiz copied into another course shows settings but no
items. **Cause.** Known Canvas defect: "Copy to" on an individual
quiz does not reliably carry the items. **Do.** Verify the
destination item count against the source after any quiz copy or
module copy. Never report a copy as complete on the basis of the
quiz appearing. (Related: `new-quizzes-contract.md` records the
duplicate readback caveat; the item count is the acceptance
criterion.)

### Answer-letter prefixes break when answers shuffle

**Symptom.** Options read "A. ..." but the stem's answer key points
at the wrong letter once students see it. **Cause.** Canvas shuffles
answers; literal letter prefixes in option text do not move with
them. **Do.** Strip `A. `/`B. `/`C. `/`D. ` from option text
before a New Quiz item create or update.

(MindTap/Cengage-specific quirks are deliberately not ported. That
platform is out of scope for this package.)

## Keepalive behavior

`helper/keepalive.sh` runs every 5 minutes: from a cron entry when the
machine has cron (guarded by a marker comment so reinstalls never
duplicate it), otherwise from a supervised background loop
(`helper/supervisor.py`; the Muse VM has no cron daemon). After a
reboot on a machine without cron, `bin/morrow start` starts the loop
again. `MORROW_CRON=0` skips both, for an operator who runs their own
scheduler.

Its health model:
- Probes `/status` with retries and backoff (2s, 4s) before any
  recovery.
- HTTP 200 alone is NOT healthy: it parses the JSON. Exit 2 is emitted
  only for an alive, non-starting browser with `logged_in:false` and
  a login URL at the configured Canvas origin. Chrome errors, blank/missing
  URLs, and unrelated sites are indeterminate, not sign-out. This does not
  prove why the login is required (expiry, revocation, or cleared cookies); a logged-out session is
  reported, never "recovered": the script never attempts a sign-in.
- A dead Chromium (`chromium_alive:false`) is recoverable: the helper
  is restarted, not reported as signed out. Unknown liveness (a server
  that omits the field), malformed JSON, or a still-starting helper is
  reported as indeterminate (exit 1), never as signed-out.

Exit codes: 0 healthy, 1 unrecoverable (helper down and could not be
recovered, /status JSON unparseable, or status indeterminate), 2 helper
responding, Chromium alive, not starting, with a login URL at the configured Canvas origin
(reported, no recovery attempted). Other unverified page states return 1.

Note: a login-page read during work is not a keepalive failure; it is
session death. Run the dead-session recovery above, not a helper
restart.
