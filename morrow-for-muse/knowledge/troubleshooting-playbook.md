# Troubleshooting playbook: session, Chromium, and helper health

The connector has exactly one session, one browser, and one helper.
Almost every operational failure is one of: dead session, dead helper,
or a second Chromium. Diagnose in that order before ever blaming the
tenant, the network, or the educator.

## Healthy-state checklist

Before any Canvas work, probe the helper:

```
curl -sf http://127.0.0.1:8901/status
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
The same reading on a previously-working box is a config error (wrong
profile path, e.g. `LOGIN_HELPER_PROFILE_DIR` pointing at a fresh
profile): check `profile_dir` in the JSON, never a dead session, never
a re-sign-in case.

Then confirm the principal through the executor:

```
PYTHONDONTWRITEBYTECODE=1 python3 dispatch/executor.py catalog \
  --name <a live-proven read row> --method GET --path <its path> \
  --class read --backend chromium --canvas-base "$CANVAS_BASE"
```

Confirm the returned identity is the educator before doing anything
else. If the probe shows a login page or an error instead of profile
JSON, the session did not stick: re-sign-in, verify again, then stop
and report if it still fails.

The helper page rule: check before you open. Show the educator the
helper page only when `/status` reports `"logged_in": false` (a
genuine reauthentication need) or once for first onboarding. Never
open it preemptively or on every run; a healthy session needs no page.

## Dead session detection and recovery

Detection signals:
- `/status` reports `"logged_in": false`.
- A Canvas-origin 401 with `{"status":"unauthenticated"}`.
- The tab shows a login page where profile JSON was expected.

On detection:
1. Activate the write halt: create `~/.morrow/write_halt`. The
   executor refuses all writes while it exists.
2. Quarantine in-flight ops. Nothing retries against a dead session.
3. Tell the educator plainly: their Canvas session expired. They open
   the helper UI and sign in again themselves (SSO/MFA included),
   leaving "Stay signed in" on.
4. Re-run the session check (`users/self`-equivalent through the
   executor). The principal id MUST match the pinned id from before;
   on mismatch the halt stays and this escalates (possible account
   change), never auto-resumes.
5. On match, lift the halt (remove `~/.morrow/write_halt`).
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

The connector's Chromium IS the helper's Chromium: one profile
(`helper/profile/`), one browser, one CDP port (127.0.0.1:19223).
**Never launch a second Chromium on 19223.** A launcher that finds
19223 live attaches to it (`launcher.attached`, no new process), which
is the plugin-attachment proof in `helper/live_behavior_check.py`.

If CDP attach fails:
1. Check something is actually listening: a launcher that finds 19223
   live attaches; a second launcher binding 19223 fails or steals the
   port. Do not start another browser process.
2. Check the helper is up: `curl -sf http://127.0.0.1:8901/status`.
   If the helper is down, restart it via `helper/keepalive.sh` (which
   sources the tree's `helper/env` for `CANVAS_BASE`), never by launching
   Chromium directly.
3. After any machine restart: the keepalive cron (every 5 minutes)
   self-heals the helper. The profile is never wiped on restart, so
   the session survives if "Stay signed in" was left on.
4. Never kill a Chromium process unless its exact `--user-data-dir`
   argv value resolves to this tree's helper profile dir (the keepalive
   reap is scoped that way), and never kill a helper server unless its
   cmdline proves it belongs to this tree. A foreign tree's processes
   are refused, never killed.

## Install, onboarding sentinel, and the one-time sign-in notice

`install.sh` is idempotent (safe to run twice) and never writes
secrets. What it does: checks python3 >= 3.10, locates Chromium,
probes egress, creates the `~/.morrow` state layout and
`helper/profile/` on first install (an existing profile is never
wiped, reset, or repackaged), installs the keepalive cron without
duplicating it, launches the helper when `CANVAS_BASE` is set,
re-runs all 23 selftest suites, and runs the secrets deny-list gate.
It exits non-zero naming the failed step.

- The onboarding sentinel is `~/.morrow/onboarded`. The installer
  prints the one-time sign-in notice once ever and then writes the
  sentinel. If the notice shows again, something deleted the
  sentinel (or `~/.morrow` is not the same machine's home).
- `MORROW_CRON=0` skips cron install (the educator runs their own
  scheduler). It does not disable the helper; it only skips the
  5-minute keepalive install.
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
them. **Do.** Strip `A. `/`B. `/`C. `/`D. ` from option text.
PENDING: question items are not a v1 claim in this package, so this
is doctrine for the day they are, not an active operation.

(MindTap/Cengage-specific quirks are deliberately not ported. That
platform is out of scope for this package.)

## Keepalive behavior

`helper/keepalive.sh` runs every 5 minutes from cron (guarded by a
marker comment so reinstalls never duplicate it; skip with
`MORROW_CRON=0` if the educator runs their own scheduler).

Its health model:
- Probes `/status` with retries and backoff (2s, 4s) before any
  recovery.
- HTTP 200 alone is NOT healthy: it parses the JSON. Exit 2 is emitted
  ONLY for a genuine signed-out session (`logged_in:false` with
  `chromium_alive:true` and `starting:false`); a logged-out session is
  reported, never "recovered": the script never attempts a sign-in.
- A dead Chromium (`chromium_alive:false`) is recoverable: the helper
  is restarted, not reported as signed out. Unknown liveness (a server
  that omits the field), malformed JSON, or a still-starting helper is
  reported as indeterminate (exit 1), never as signed-out.

Exit codes: 0 healthy, 1 unrecoverable (helper down and could not be
recovered, /status JSON unparseable, or status indeterminate), 2 helper
responding, Chromium alive, not starting, but genuinely signed out
(reported, no recovery attempted).

Note: a login-page read during work is not a keepalive failure; it is
session death. Run the dead-session recovery above, not a helper
restart.
