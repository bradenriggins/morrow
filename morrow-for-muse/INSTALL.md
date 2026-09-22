# Installing the Morrow for Muse connector

This document is for the operator installing the connector on a Muse
VM. If you are an educator who wants to use Morrow, you do not install
anything: open Muse and say "Connect my Canvas account", then follow
the conversation (`content/setup-guide.md` is the educator walkthrough
and `FIRST_RUN.md` is the agent's first-hour checklist).

This document takes you from a fresh Muse VM to a verified Canvas
connection. Every step is executable as written; nothing here assumes
prior knowledge of the project.

## Prerequisites

- A Muse VM (the connector runs on the VM Meta provisions for you).
- The platform Chromium present. The installer looks for it at
  `/opt/meta-chromium/chrome`, which ships in the Muse VM image. If your
  VM does not provide it, place a Chromium binary at
  `transport/chromium/chrome` inside this tree before installing.
- Python 3.11 or newer (`python3 --version`). The tree is stdlib-only;
  nothing needs pip. (Python 3.10 is refused: it reached security
  end-of-life in October 2026 per PEP 619.)
- Network egress from the VM to your Canvas tenant: direct, or via the
  VM's `https_proxy`/`HTTPS_PROXY` (authenticated or not). The installer
  probes this and tells you which mode it found.
- Your Canvas tenant URL (e.g. `https://myschool.instructure.com`) and
  the ability to sign in to it yourself (your SSO/MFA, on your phone).

## Step 1: unzip

Unzip the release into the skills directory:

```
mkdir -p ~/workspace/skills
unzip morrow-muse-connector-0.3.0.zip -d ~/workspace/skills/
mv ~/workspace/skills/morrow-muse-connector ~/workspace/skills/morrow-canvas
cd ~/workspace/skills/morrow-canvas
```

Everything below assumes you are in the tree root
(`~/workspace/skills/morrow-canvas/`).

## Step 2: run install.sh

```
bash install.sh
```

Safe to run twice; a second run revalidates every step and repairs any
drift (it does not claim "changes nothing": it reconciles state). What
it does, in order:

1. **python3 check.** Verifies `python3` exists and is >= 3.11. Fails
   with a diagnostic naming this step if not (3.10 is refused outright:
   security EOL October 2026, PEP 619). Sets
   `PYTHONDONTWRITEBYTECODE=1` so no `__pycache__/` is written into
   the tree.
2. **Integrity and upgrade.** Verifies the tree against
   `pack/carve-manifest.json` (every shipped file's SHA-256). On a
   version change (see `pack/version.txt`), backs up the existing tree
   (excluding `helper/profile/`) to a timestamped directory outside
   the tree, then removes stale files from the old version that the new
   manifest no longer lists (loudly logged). Migrates keepalive cron
   entries from other trees so exactly one entry (this tree's) remains.
   Records the installed version and manifest under the effective
   `MORROW_HOME`.
3. **Chromium locate.** Checks `/opt/meta-chromium/chrome` (ships in
   the Muse VM image), then `transport/chromium/chrome`. Fails with a
   diagnostic if none is executable.
4. **Egress probe.** Runs the egress probe: an authenticated proxy from
   the environment, else a bare proxy, else one quick direct TLS
   handshake to your tenant host (or `example.com` when `CANVAS_BASE`
   is not set yet). Prints the detected mode with credentials redacted.
   If nothing works it fails and names everything it tried.
5. **State layout.** Creates the effective `MORROW_HOME` (`~/.morrow/`
   by default, overridable) with `journal/` and `approvals/`
   subdirectories (0700), and the tree's own `helper/env` (0600, only
   if missing; it is a commented template for `CANVAS_BASE`). Your
   existing `env` file is never overwritten. No secrets are written,
   ever.
6. **Helper profile creation.** Creates `helper/profile/` (0700) on
   first install. An existing profile is never wiped, reset, or
   repackaged: your authenticated Canvas session survives reinstalls
   and updates.
7. **Keepalive cron install.** Ensures this tree has its own cron entry (every 5
   minutes) running this tree's `helper/keepalive.sh`, guarded by a
   tree-specific marker comment. Entries belonging to other installed
   trees are preserved, so two trees on one machine each keep their
   own supervision. Skip with `MORROW_CRON=0` if you arrange your own scheduler.
   Reboot note: after a VM reboot, supervision resumes at the next
   five-minute cron tick, so expect up to five minutes of downtime
   before the helper is back.
8. **Secrets gate.** Runs `scripts/verify-no-secrets.sh` against the
   tree, enforcing `pack/deny-list.txt` (no profiles, logs, session
   material, secret-shaped content, or non-example tenant hostnames).
   Runs BEFORE the helper launches, so a dirty tree never starts a
   browser. Any violation fails the install.
9. **Selftest suites.** Runs all 23 selftest suites from this tree
   (transport, dispatch, privacy, helper, reauth). Any failure fails the
   install and names the suite. Test scratch is removed afterwards.
10. **Helper launch and onboarding notice.** When `CANVAS_BASE` is
    set, runs `helper/keepalive.sh` so the helper is up immediately,
    then prints the sign-in notice. The notice repeats on every
    install until onboarding genuinely completes (a signed-in session
    with stored cookies); it is not shown once ever. When
    `CANVAS_BASE` is not set yet, the launch is skipped and the
    installer tells you to set it and rerun.

On success it prints the four first-run steps below.

### Platform trust notes (read before you install)

**Egress TLS inspection (W4-P1-4).** On VMs where the file
`/etc/ssl/certs/hatch-egress-ca.pem` exists (or the
`MORROW_EGRESS_CA_PEM` environment variable points at a PEM file),
the platform's egress proxy terminates and re-encrypts outbound TLS:
it performs TLS inspection (a man-in-the-middle) on traffic leaving
the VM. The connector detects that CA at launch and starts Chromium
with `--ignore-certificate-errors-spki-list=<pin>`, where the pin is
`base64(sha256(SubjectPublicKeyInfo))` derived from the on-disk CA at
launch time (no pin value is hardcoded anywhere). Consequence, stated
plainly: on a CA-present VM the egress proxy operator can read the
plaintext of your TLS traffic, including Canvas session cookies,
pages you load, and API request/response payloads. The connector
cannot prevent this; the platform controls egress. Installing and
running the connector on such a VM means consenting to that
inspection. On VMs with no such CA file, Chromium launches with no
spki-list flag and nothing changes about normal TLS verification.

**Loopback CONNECT relay (W4-P2-9).** When the VM needs an upstream
proxy, the launcher runs `transport/proxy_forwarder.py`, which
listens on `127.0.0.1` (loopback only) and accepts CONNECT requests
without authentication, injecting the upstream `Proxy-Authorization`
credential itself (Chrome cannot take proxy credentials on its
command line). Threat model, stated plainly: any process running as
the same user on this VM can connect to that loopback relay and send
traffic through the upstream proxy under your proxy credentials.
The loopback binding is the design boundary: it keeps other
machines and other users off the relay, but it is not
authentication. A compromised or malicious process running as your
user is equivalent to use of the proxy credential. Do not run
untrusted code as the same user on the install VM.

Optional dependency: the learner-privacy vault's file-backed
encryption needs the `cryptography` package, installed hash-pinned:

    pip install -r requirements-optional.txt

The file pins `cryptography==50.0.1` (plus its `cffi`/`pycparser`
closure) with `--require-hashes`, so pip verifies every downloaded
artifact against the published SHA-256 hashes before installing;
a tampered mirror fails the install loudly instead of silently.
Without the package, file-backed vault operations refuse with a
clear error; in-memory vaults, redaction, and all other privacy
features work normally.

## Step 3: set your tenant

```
nano helper/env
```

Uncomment and set the line:

```
CANVAS_BASE=https://myschool.instructure.com
```

Use your real Canvas host. There is no default tenant; the login helper
refuses to start without one.

Tenant rules (W2-P0-11, enforced by both the installer and the helper
before any network probe):

- HTTPS is required. Plain HTTP is refused unless you explicitly set
  `CANVAS_BASE_ALLOW_HTTP=1` for documented local development use.
- The host must be a real Canvas tenant: a `*.instructure.com`
  subdomain, or a custom Canvas domain you confirm explicitly with
  `CANVAS_BASE_CUSTOM_DOMAIN_CONFIRMED=<exact host>`.
- Anything else is refused: IP literals (including loopback,
  private, link-local, and reserved ranges), hosts with userinfo
  (`user@host`), and unparseable values. Paths, query strings, and
  fragments are stripped to the origin root.

## Step 4: confirm the login helper is running

The installer started the helper in step 2 (when `CANVAS_BASE` was
set). Confirm it:

```
curl -sf http://127.0.0.1:8901/status
```

You should see JSON with your Canvas URL and `"logged_in": true` once
you have signed in (step 5).

If `CANVAS_BASE` was not set during the install, start the helper now:

```
cd ~/workspace/skills/morrow-canvas
bash helper/keepalive.sh
```

(If you set `CANVAS_BASE` in `helper/env`, keepalive.sh sources
that file (the legacy global `~/.morrow/env` is honored for
`CANVAS_BASE` only). Do not hand-launch `helper/server.py` directly: it
sources `<tree>/helper/env` itself, so it fails without `CANVAS_BASE`
exported in the shell or the tree env file, and the production-port
guard treats a bare launch on the production ports with the live
profile as a config error; keepalive.sh always exports
`LOGIN_HELPER_PROFILE_DIR` first.)

What runs: the helper UI on `http://127.0.0.1:8901/` and a headless
Chromium on CDP port `127.0.0.1:19223` with its profile at
`helper/profile/` inside this tree. The profile was created by the
installer and holds your authenticated session; it is never part of the
download, and reinstalls never wipe it.

The `/status` endpoint returns `url`, `logged_in`,
`profile_dir`, `profile_has_cookies` (computed fresh per request),
`chromium_alive`, and `starting` (true while Chromium is alive but the
tab is still `about:blank`). Healthy means `"logged_in": true`,
`"profile_has_cookies": true`, `"chromium_alive": true`,
`"starting": false`. Diagnostic: `logged_in: false` with
`profile_has_cookies: false` and `chromium_alive: true` on a fresh box
is normal first onboarding (sign in once); the same on a
previously-working box is a config error (wrong profile path), never a
dead session. See `SKILL.md` and `knowledge/troubleshooting-playbook.md`
for the full field guide.

## Step 5: sign in (you, not the agent)

Open the helper UI in your phone's browser (the artifact or page your
agent points you to reaches the VM's `127.0.0.1:8901`). The UI shows the
live Canvas login page. Sign in exactly as you normally would, including
SSO and MFA, and leave Canvas's "Stay signed in" (or "Remember me") option
on: that is what keeps you signed in across helper and machine restarts.
If Canvas or your SSO provider expires the session anyway (expiry,
password change, admin revocation), the helper reports logged out and
you sign in again through the helper UI; nothing here needs
reinstalling. Your agent never sees your password:
keystrokes go straight into the page through the helper, and the server logs
event counts only.

Check the helper is healthy:

```
curl -sf http://127.0.0.1:8901/status
```

You should see JSON with your Canvas URL and `"logged_in": true`.

## Step 6: verify with a users/self readback

```
cd ~/workspace/skills/morrow-canvas
PYTHONDONTWRITEBYTECODE=1 python3 dispatch/executor.py catalog \
  --name users_self --method GET --path /api/v1/users/self \
  --class read --backend chromium --canvas-base "$CANVAS_BASE"
```

(The `PYTHONDONTWRITEBYTECODE=1` prefix keeps Python from writing
`__pycache__` into the tree, which the installer's integrity gate
would reject on the next install.)

Expect a JSON result naming you (id, name, email). This tenant's
`/users/self` response carries no `login_id` field; email is the
account identifier. Confirm the principal
is you before asking for anything else. This proves the full path:
executor governance, the Chromium lane, your session, your tenant.

## Dispatching real work

Reads need nothing further. Writes need a frozen plan (`--plan`) and an
educator-signed approval (`--approval`); see `SKILL.md` for the
governance rules. The v1 capability scope is declared in `SCOPE.md`:
the live-proven Canvas core only.

## Disconnect (keep the install)

```
bin/morrow disconnect          # prompts before it deletes anything
bin/morrow disconnect --yes
```

Stops the helper and its Chromium (exact-PID signaling only), removes
this tree's keepalive cron entry, and deletes the Canvas session
material: `<tree>/helper/profile/` (or `LOGIN_HELPER_PROFILE_DIR`), the
pinned account (`MORROW_HOME/browser_lane.json`), the rig session
record, and the browser transient state. It verifies each removal and
exits non-zero if anything survived. The tree, settings, audit journal,
and learner vault stay. Reconnect by rerunning `install.sh` and signing
in again.

## Clean uninstall

```
bash scripts/uninstall.sh      # from the tree root
```

The uninstall script stops the helper (exact-PID signaling only, never
`pkill`), removes the keepalive cron entry, and deletes the tree, the
effective `MORROW_HOME` state, the browser profile, the learner source
vault, the upgrade backups (`<tree>.bak-*`, including partial
`.PARTIAL` backups), and any failed-upgrade trees (`<tree>.failed-*`).
It verifies each step and reports what was actually removed.

Cron removal is mandatory: if the keepalive entry survives, it will
relaunch the helper (and its Chromium) within five minutes, resurrecting
the "uninstalled" connector. Both disconnect and uninstall refuse to
finish until the cron entry is gone.

Deleting the profile removes the session from this machine. Canvas may
still consider that session valid on its side until it expires. To end
it on the Canvas side too, change your Canvas password or ask your
Canvas admin to end your sessions. Signing out on your laptop does not
reliably end the helper's separate session.

## Upgrading

Unzip the new release over the tree (or into a fresh directory) and
rerun `install.sh`. The installer:

- Verifies the tree against `pack/carve-manifest.json` (SHA-256 of
  every shipped file) before touching anything.
- On a version change (see `pack/version.txt`), backs up the existing
  tree to a timestamped directory outside the tree (excluding
  `helper/profile/`), then removes stale files the new version no
  longer ships (loudly logged). If the install fails midway, it
  restores from the backup, but ONLY from a verified-complete backup:
  the installer records a per-path SHA-256 manifest of the backup at
  backup time and re-verifies it with `sha256sum -c` before any
  restore. A backup
  interrupted mid-write (e.g. disk full) is NEVER restored over the
  tree; the tree is left in place, the partial backup is quarantined
  as `<tree>.bak-<ts>.PARTIAL`, and the failure names the recovery
  steps. Only the 3 most recent backups are kept; older ones are
  pruned. A failed fresh install (no backup) rolls back everything the
  run created (state dirs, `helper/env`, `helper/profile`, the cron
  entry), itemized, instead of leaving a half-install.
- Never overwrites `helper/env` or wipes `helper/profile/`: your
  tenant config and authenticated session survive.
- Migrates keepalive cron entries from old trees so exactly one entry
  (the new tree's) remains. The old tree's keepalive can no longer
  SIGKILL the new server. The cron entry shell-quotes the tree path,
  so trees under paths with spaces work. Two installers running at
  once serialize their cron updates, so neither tree's entry is lost.

Do NOT move or rename an installed tree without rerunning `install.sh`
from the new location: the keepalive cron entry points at the install
location, and a moved tree fails its cron supervision silently (or
supervises a stale copy). The keepalive warns loudly when it sees a
mismatched or dead cron entry. Since the stable tree id
(`.morrow-tree-id`, minted by the installer), moving the directory is
otherwise safe: the journal location, op-id idempotency, and approvals
follow the tree instead of its path. To relocate: move the directory,
rerun `install.sh` from the new location (the existing tree id is kept
verbatim; the cron entry is re-established for the new path).
- Records the installed version and manifest under the effective
  `MORROW_HOME` for the next upgrade's comparison.

Pack note: `pack/pack.json` ships with an empty entry list. The
unverifiable external pins from earlier releases were removed rather
than shipped on trust; the manifest (`pack/carve-manifest.json`) is the
integrity source of truth.

Tree-scoping: configuration lives in the tree's own `helper/env`
(`CANVAS_BASE` and optional profile/port/production pins); runtime
state (keepalive lock, op journal, version marker) lives under the
effective `MORROW_HOME`. The legacy global `~/.morrow/env` is honored
for `CANVAS_BASE` only. After upgrading from a pre-tree-scoping
release, move any `LOGIN_HELPER_*` vars from `~/.morrow/env` into
`helper/env`.

## Backup, restore, and migration

Everything the educator would need to restore lives in two places:

1. The tree directory itself: `helper/env` (tenant config),
   `helper/profile/` (the authenticated browser session), and
   `.morrow-tree-id` (the stable tree identity).
2. The effective `MORROW_HOME` (default `~/.morrow`, or wherever
   `MORROW_HOME` points): the op journal, approvals, the re-auth
   ledger, the learner vault, and lane state, all together.

Back up both. To migrate to a new machine: copy the tree and the
`MORROW_HOME` directory, then rerun `install.sh` from the tree's new
location. The existing `.morrow-tree-id` is preserved verbatim, so the
journal path and op-id idempotency survive the move; the installer
re-establishes the keepalive cron entry for the new path (cron entries
are path-bound, so this step is mandatory after any move). Copies also
keep the same tree id: two live copies of one tree share one journal
location, so do not run two copies against the same `MORROW_HOME`.

Limitation: trees installed before the stable tree id existed have no
`.morrow-tree-id`; their tree id derives from the tree path, so moving
such a tree orphans the old journal and resets op-id idempotency (the
executor prints a loud warning naming this when it happens). Run
`install.sh` once before migrating to mint the id; `install.sh` never
overwrites an existing one.

## Permissions and the same-UID limit

`install.sh` creates state dirs `0700` and secret/config files `0600`
(`helper/env`, the legacy `<MORROW_HOME>/env`, the helper token,
privacy salt/map, session records). When it adopts pre-existing files
or dirs with looser permissions, it tightens them and prints a loud
note naming what changed. Plainly: mode bits protect against
different-UID attackers only. There is no isolation from another
process running under the same UID: such a process can read the
journal, the vault key, the helper token, the env files, and the
browser profile. Do not run untrusted code as the same user on a
machine holding an educator's Morrow state.

## Moodle lane: HTTPS is mandatory

The Moodle lane refuses a plaintext `http://` base before any session
or cookie is created: session cookies and credentials would otherwise
cross the network unencrypted. Use `https://`. The escape hatch
`MOODLE_BASE_ALLOW_HTTP=1` exists for test fixtures and LAN-only
deployments only; never set it for a real tenant.

## Troubleshooting

- `install.sh` fails at **egress probe**: the VM cannot reach any tenant.
  Check `https_proxy`/`HTTPS_PROXY`, or ask your admin about egress.
- Helper exits with "no Canvas tenant configured": `CANVAS_BASE` is unset
  or still the `example.instructure.com` placeholder. Set it in
  `helper/env` (or the legacy `~/.morrow/env`, or the environment).
- `users/self` fails with a session error: the helper's Chromium holds no
  live session. Re-run step 5 (sign in again through the helper).
- The executor refuses a write: expected without `--plan` and
  `--approval`, or while `~/.morrow/write_halt` exists. That is the
  governance working; see `SKILL.md`.

## Recovery runbooks (W6-P2-9)

These are the tested recovery procedures for integrity failures. Each
one is fail-closed: it refuses to proceed when it cannot verify what
it needs, and it tells you exactly what to do instead.

### Backup and restore (W6-P1-1)

Create a backup before any risky operation:

```
python3 -m dispatch.state_backup create /path/to/backup-dir
```

The backup contains every HMAC/AES secret in plaintext. Store it
encrypted. Never store backups unencrypted.

Verify a backup (checks manifest + sha256 of every file):

```
python3 -m dispatch.state_backup verify /path/to/backup-dir
```

Restore (fail-closed: verifies first, preserves the generation
high-water mark, writes the restore marker):

```
python3 -m dispatch.state_backup restore /path/to/backup-dir --yes
```

After a restore, the journal is fail-closed until you reconcile:

```
python3 -m dispatch.executor journal-reconcile
```

### Journal secret lost or corrupted (W6-P1-3)

If `journal/ops.secret` is lost or corrupted, sealed records can never
verify again. Do NOT delete the journal (that resets all op-id replay
protection to zero). Instead:

1. Reconcile in-flight ops against the provider FIRST. Without the old
   secret, a planted record is indistinguishable from a legitimate one;
   re-sealing blesses whatever bytes exist.
2. Run the re-key ceremony (requires --yes and a --reason of at least
   20 characters, journaled in the audit record):

```
python3 -m dispatch.executor journal-recover-secret --yes \
  --reason "operator attestation: secret lost, in-flight ops reconciled"
```

This quarantines the corrupt secret, mints a new one, re-seals every
record (provenance downgraded to operator attestation), rebuilds the
index, and preserves every op_id's replay protection.

### Missing archives (W6-P1-4)

If the sealed index lists an archive that is missing from disk, the
executor fails closed with `JournalIntegrityError` and names the
missing archives. Do NOT re-claim op_ids meanwhile. Restore the
archives from backup, then run:

```
python3 -m dispatch.executor journal-reconcile
```

### Retired set seal (W6-P1-5)

If `journal/retired_opids.jsonl` exists without a valid seal
(pre-seal legacy file, or the seal was stripped), the executor fails
closed. Adopt it explicitly:

```
python3 -m dispatch.executor retired-seal --yes
```

This verifies what it can, seals the set, and journals the adoption.
