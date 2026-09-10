# Desktop update maintainer guide

This guide defines the update boundary for the packaged Morrow desktop app. It
does not publish a release. The fixed future provider is GitHub repository
`bradenriggins/morrow`, channel `latest`, with feed ID
`morrow-github-stable`. The repository has no signed public release yet, so the
controller must stay disabled until the release owner provides one.

`shared/updates.cjs` is an Electron-independent controller. It accepts no
renderer data. `createUpdateController` opens no file of its own. It never reads
or writes the Bridge, `MorrowPayload`, or `Materials`, and it touches `State`
only through the injected update attempt store described below, which owns
exactly one file. The main process owns the `electron-updater` adapter, its
signed release configuration, and every IPC endpoint. User data stays under
Electron `userData`; the updater cache remains owned by `electron-updater`.

## Controller contract

Main creates the controller with:

```js
const updates = createUpdateController({
  adapter,
  policy: {
    enabled: true,
    automatic: true,
    feed: { id: "morrow-github-stable" },
    allowPrerelease: false,
    checkIntervalMs: 6 * 60 * 60 * 1000
  },
  acquireRestartLease: async () => await morrowAcquireRestartLease(),
  releaseRestartLease: async (leaseId) => await morrowReleaseRestartLease(leaseId),
  commitRestartLease: async (leaseId) => await morrowCommitRestartLease(leaseId),
  updateAttempts: createUpdateAttemptStore({ stateDirectory: morrowStateDirectory }),
  confirmUpdatedRuntime: async () => await morrowConfirmUpdatedRuntime()
});
```

The adapter has a fixed plain `identity` value:

```js
{
  currentVersion: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  feedId: "morrow-github-stable"
}
```

The adapter also reports `freeCacheBytes()`: the free space on the volume that
holds the `electron-updater` download cache, or `null` when this computer does
not report it. `null` means Morrow could not measure the space, not that space
is available.

It implements `on(event, listener)`, `checkForUpdates()`, `downloadUpdate()`,
and `quitAndInstall()`. `on` returns an unsubscribe function. The event names
are the maintained `electron-updater` events: `checking-for-update`,
`update-available`, `update-not-available`, `update-downloaded`,
`update-cancelled`, and `error`.

The controller exports `snapshot()`, `subscribe(listener)`, `start()`,
`check()`, `installWhenIdle()`, and `stop()`. It returns only this renderer-safe
shape:

```js
{
  schema: "morrow.desktop-update.v1",
  status: "unavailable" | "idle" | "checking" | "available" |
    "downloading" | "ready" | "installing" | "error",
  currentVersion: "1.2.3",
  availableVersion: null | "1.2.4",
  automatic: true | false,
  reason: null | "bounded_reason"
}
```

Do not include a feed URL, cache path, error text, release notes, account
information, payload paths, or Bridge data in this object. The only supported
restart request is `installWhenIdle()`. It calls the main-provided authoritative
restart-lease service. Acquisition returns either `{ status: "granted", leaseId }`,
`{ status: "busy" }`, or `{ status: "uncertain" }`. A busy, uncertain,
malformed, or failed acquisition leaves the already downloaded update in `ready`
with `active_or_uncertain_operations`; it does not quit the app. The controller
coalesces concurrent restart requests before it calls the lease service, so one
install attempt acquires at most one lease. After a grant it calls
`commitRestartLease(leaseId)`, which must return exactly `{ status: "closing" }`,
before it calls `quitAndInstall()`. A failed or malformed commit releases the
held lease. A confirmed release returns `ready` with `update_install_failed`; a
failed release returns `active_or_uncertain_operations`. After a committed
closing state, the controller never releases or retries the lease, including
when `quitAndInstall()` reports failure, because the owner can already be
closing.

`policy.enabled` defaults to `false`. An enabled policy must have the exact
opaque `feed.id` that matches the adapter identity. This is an admission check,
not a URL validator. Main must keep the real owned route in its signed release
configuration. The controller refuses unsupported platforms, a missing or
mismatched feed identity, malformed versions, prerelease channel entry from a
stable app unless explicitly allowed, equal versions, and downgrades before it
asks the adapter to download. It also refuses a candidate that names a platform
or an architecture other than the running build's (`update_platform_mismatch`,
`update_arch_mismatch`). Those two checks apply to what the feed reports:
`electron-updater` selects its own artifact by platform and architecture, and
this admission refuses a candidate whose own metadata disagrees with this build.

Before the download starts, the controller compares the largest artifact size
the feed reported for the candidate against the free space the adapter reports,
and refuses with `disk_space_unavailable` when the volume holds less than three
times that size. The multiple is headroom for the download plus the staged
install on the same volume; it is not a measurement of the library's peak
usage. A feed that reports no size, and a computer that does not report its free
space, leave the check unmeasured and the download proceeds. A download that
then fails for lack of space reports `disk_space_unavailable` rather than the
generic `update_download_failed`. Morrow adds no second hash or signature
implementation for either check.

Automatic mode checks once at startup and then every six hours by default. The
interval is bounded from 15 minutes to 24 hours. It downloads a valid newer
release. It does not install or restart until a restart lease is granted.
Applying the ready update is a separate user quit or restart
action. That action must obtain the restart lease; automatic checks and
downloads never interrupt the app.

## Electron adapter requirements

Use a current patched `electron-updater` release. Its `autoUpdater` must be
configured by main, never by renderer data:

1. Set `autoDownload = false`. The controller starts the download after it has
   accepted the signed updater result.
2. Set `autoInstallOnAppQuit = false`. Only `installWhenIdle()` can call
   `quitAndInstall()`.
3. Set `allowDowngrade = false` and `allowPrerelease = false` for the stable
   channel. A prerelease channel needs an explicit separate policy and feed ID.
4. Keep NSIS web installers disabled. Do not opt into a web installer that
   bypasses the normal signed installer flow.
5. Bind the adapter to the actual signed macOS and Windows release manifests
   generated with their matching artifacts. Never hand-write a manifest or mix
   an artifact from one build with metadata from another.
6. Set the Windows publisher identity in the updater configuration. Keep macOS
   code signing and notarization in the release build. Do not add a second hash
   or signature implementation: `electron-updater` validates the manifest
   checksum and Windows publisher signature, while the macOS updater uses the
   platform signing path.

The main adapter stores the cancellation token returned by
`checkForUpdates()` and passes it to `downloadUpdate()`. It forwards the six
documented updater events without adding remote error content. Cancellation
returns the controller to `available`; network errors become
`update_check_failed` or `update_download_failed`; checksum or signature
failures become `update_verification_failed`; a failure that names `ENOSPC`
becomes `disk_space_unavailable`. A corrupt release must never reach `ready` or
`quitAndInstall()`.

The controller's version, platform, and architecture checks are admission
checks. They do not replace `electron-updater` checksum or signature
verification. The adapter must not report `update-downloaded` until the library
download promise has resolved.

## The first start after an update

Immediately before `quitAndInstall()`, and after the restart lease is committed,
Morrow writes one record to `State/update-attempt.json`:

```js
{
  schema: "morrow.desktop-update-attempt.v1",
  fromVersion: "1.2.3",
  toVersion: "1.2.4",
  at: "2026-01-01T00:00:00.000Z"
}
```

The file is mode `0600` inside the `0700` state directory, holds no user data
and no updater path, and is written to a temporary name and renamed. If Morrow
cannot write it, it does not hand the update to the updater: the verified update
stays `ready` and reports `active_or_uncertain_operations`, because a new
version that never starts could not otherwise be told apart from an ordinary
start.

`start()` resolves that record once, before any check:

- The running version equals `toVersion`. Morrow asks main whether the runtime
  this version starts with is the verified one. Only `verified` completes the
  update: it requires both the sealed payload verification (`verifyMcpRuntime`)
  and a gateway that answered its health request, which is exactly the app's
  `ready` runtime status. On `verified` the record is removed and the update is
  reported complete (`idle`, `update_complete`). That reason is the snapshot the
  controller publishes at that moment; the ordinary check that follows replaces
  it, and no separate screen claims it. `unverified` and `unknown` both keep the
  record and report no success. A failed payload verification is already the
  app's `repair_required` state, which is the state that asks the person to
  repair; this controller adds no second claim and never reports the update
  finished without the proof.
- The running version equals `fromVersion`. The new version did not start.
  Morrow reports `error` with `update_rolled_back` and the exact state "The
  update did not start; Morrow is running version X", with a retry action. It
  does not check or download on its own on this start, and arms no scheduled
  check, so the same version is never replayed without the person asking. An
  explicit check is that retry and proceeds normally. The record stays until an
  attempt resolves it.
- The record names neither version. It cannot describe this installation, so it
  is removed rather than acted on.

An unreadable record leaves the update route working and makes no claim about
the last attempt.

Reacquiring the previous signed desktop artifact is **not implemented**. Morrow
keeps no copy of the version it replaced, and the `electron-updater` cache holds
only the update it is downloading or has staged (`cacheDirForPendingUpdate`),
not the version that was replaced. A new version that starts but is unusable is
therefore recovered by repair, or by installing the previous signed release from
the publisher by hand. Do not describe an in-app downgrade or automatic
reinstall of the previous version as available: nothing implements it and no
test proves it.

## MCP runtime update boundary

The signed desktop artifact includes the MCP runtime under `MorrowPayload`.
MCP code therefore advances atomically with the desktop version; it is not
downloaded from a separate mutable route. The payload manifest must bind the
MCP package version, entrypoint, production dependency tree and every shipped
file hash. Startup refuses a missing or mismatched manifest.

Assistant configurations must continue to point at the stable installed app
path. Executable code stays in the signed application resources. Keys, journals,
learner mappings, course bindings, materials, and granted authority stay in the
private user-data directory and are never replaced by an app update. Before
restart, the update controller must hold the authoritative maintenance lease so
pending or uncertain operations cannot be interrupted or replayed.

After the updated app starts, the gateway reports the MCP package version and
the SHA-256 it computes from the sealed runtime manifest beside the payload it
is running from. The app sends neither value to the gateway. It compares that
health response with the version and digest bound in its own signed metadata,
which it has already verified against the installed payload on disk, and it
reports the runtime ready only when both match. A gateway that started from a
different or altered payload therefore reports a different digest and the
runtime status stays uncertain. A startup failure, old version, mismatched
digest, or stale assistant path must enter repair/recovery. A new version that
never starts is detected by the attempt record described above; reacquiring the
previous signed desktop version is not implemented and stays a release-owner
step.

## Required release inputs and proof

Before enabling policy in a released desktop build, the release owner must
provide all of these inputs:

- A public GitHub release in `bradenriggins/morrow`, with the fixed
  `morrow-github-stable` identity for the stable channel.
- Signed and notarized macOS artifacts, and signed Windows artifacts whose
  publisher matches the updater configuration.
- The generated `latest-mac.yml` and `latest.yml` from the same build as their
  artifacts, with current SHA-512 metadata.
- A current supported `electron-updater` version that includes the Windows
  signature verification fix. Do not use a version affected by
  GHSA-9jxc-qjr9-vjx.
- A fresh installed-app proof on each target platform: no update, newer update,
  offline check, cancelled download, corrupt checksum, invalid publisher,
  downgrade, wrong architecture, a volume without room for the artifact, active
  operation deferral, uncertain operation deferral, idle restart, a new version
  that starts and reports its runtime ready, a new version that does not start,
  and preserved `userData/State` and `Materials`.

The admission, disk-space, and attempt-record behavior above is proven here by
`installer/test/updates.test.cjs` and
`installer/test/electron-updater-adapter.test.cjs` against a stub updater and a
real state directory.

`scripts/test/desktop-update-harness.test.mjs` proves the same contract against
the real library. It runs as `pnpm test:desktop:update`, and `pnpm test:desktop`
runs it after the installer suites. It builds the adapter with
`createElectronUpdaterAdapter` and the controller with `createUpdateController`,
exactly as `installer/main.cjs` does, and drives the real `electron-updater`
`AppUpdater` through a real `generic` provider against a static feed served from
a temporary directory on `http://127.0.0.1:<port>`. It reaches no other host.
Each case generates a `latest-mac.yml` or `latest.yml` and the one artifact that
channel file names, so the library performs its own SHA-512 check over the bytes
it downloads. The cases are: a feed that reports the running version and
downloads nothing; a newer release that downloads, reaches `ready`, and then
calls `quitAndInstall()` once, after the restart lease is committed and the
attempt record is written; a corrupted artifact, whose bytes do not match the
SHA-512 its own channel file declares, which reports
`update_verification_failed`, reaches neither `ready` nor `quitAndInstall()`,
and leaves nothing staged; a cancelled download, which returns to `available`
with `download_cancelled` and stages nothing; a feed that does not answer, which
reports `update_check_failed`; a downgrade, which is refused before the artifact
is ever requested, both by the adapter's `allowDowngrade = false` and by the
controller's own admission check; and the Windows channel file driving the same
flow.

`electron-updater` 6.8.9 runs outside Electron when an app adapter is passed as
the second `AppUpdater` argument, so that harness drives the library itself, not
a stub or a fake provider. Two boundaries stay outside it. The install step
lives in `MacUpdater` and `NsisUpdater`, which both require Electron, so the
harness records the `quitAndInstall()` call instead of performing it. macOS
notarized update verification and Windows publisher-signature verification live
in those same two classes and are **live-unverified**. A signed old-to-new
update on either platform is **live-unverified** for the same reason: it needs a
macOS Developer ID identity with notarization, a Windows publisher certificate,
and a Windows host.

The desktop updater does not modify Morrow Bridge as part of an app update.
Bridge maintenance uses the separate contract below. It changes only the
app-owned unpacked Bridge directory and refuses a Chrome Web Store installation.

## Morrow Bridge update boundary

The temporary unpacked Bridge procedure remains developer-only. The desktop app
now maintains one app-owned stable Bridge directory. Chrome must load that exact
directory. A challenge marker lets the paired Bridge prove its extension ID,
version, and active folder without returning the folder path.

The implemented app-assisted Developer mode update contract:

1. The existing manifest key and its expected extension ID
   `abeloclekioohahgedmjcdbpllfjfhko`, plus the exact selected unpacked
   app-owned stable directory. The Bridge reads a private challenge marker from
   its active extension URL and returns a digest-bound proof.
2. A versioned, signed bundled Bridge asset manifest. The app must verify this
   before replacing files and retain a private rollback copy until Chrome
   confirms the expected extension version.
3. An authenticated local Bridge control channel that proves the exact
   extension ID and requests quiescence. It must refuse a pending review,
   approval, browser POST, active content mutation, or uncertain outcome.
4. An atomic file swap only after quiescence. The app retains a rollback copy
   and asks the person to reload the unpacked extension in Chrome. It does not
   automate Chrome's extension page. After reload, the paired Bridge must return
   the exact new version and challenge proof. Only then does the app clear the
   pending update, remove the rollback copy, and prove with a fresh `lstat` that
   the copy is gone. A removal it cannot prove is reported as
   `rollback_copy_retained` instead of being reported as done. The app releases
   the maintenance lease after that result, and the next start removes every
   rollback copy the current installation record does not reference. Missing or
   mismatched readback stays unconfirmed.
5. A hard Store boundary: a Chrome Web Store installation is never replaced,
   reloaded, or given permissions by the desktop app.

Bridge maintenance is serialized by one lock file in the app's private state
directory. The lock records the process ID and start time of the app that holds
it. A lock whose process is still running is never removed. A lock whose process
is gone and that started more than ten minutes ago is reclaimed once, so an
interrupted update cannot block every later Bridge update. A lock file written
by an earlier app version records no process; its own modification time bounds
it instead.

The source contract and failure/rollback tests are implemented. Focused tests
cover release-manifest and file hashes, fixed extension identity, permission
drift, Store-install refusal, downgrade refusal, pending and unknown write
fences, atomic replacement, rollback retention until exact readback, proven
rollback-copy removal after it, stale-lock recovery bounded by a live-process
check and a ten-minute window, startup pruning of unreferenced rollback copies,
stale challenge refusal, and lease release only after exact readback. A local Chrome-for-Testing check proves
the active-folder challenge on an isolated unpacked Bridge. A complete update
through a normal signed-in Chrome profile still needs manual reload and live
readback proof before the flow can be advertised as verified.

For a Chrome Web Store Bridge, Chrome owns distribution and update checking.
Chrome normally checks on startup and every few hours, then waits until the MV3
extension is idle before installing the update. The extension can observe
`chrome.runtime.onUpdateAvailable` and call `chrome.runtime.reload()` only when
its own operation state proves that it is safe. Do not call
`requestUpdateCheck()` on a timer; Chrome throttles it. Any reload design must
first prove that it does not interrupt a pending review, an approval page, a
browser POST, or an uncertain outcome.

Chrome Web Store publication owns the Store package, version increase, review,
permission acceptance, staged rollout, and rollback. A permission change needs
Store review and user acceptance. Morrow Desktop must not bypass that process or
claim that it updated the Bridge. The Store account must also complete the
required privacy and permission review before the temporary developer mode
instructions can be retired.

Maintainers should verify current behavior against the official sources before
changing this contract: [electron-updater API source](https://github.com/electron-userland/electron-builder/blob/master/packages/electron-updater/src/AppUpdater.ts), [electron-builder troubleshooting](https://www.electron.build/troubleshooting), [Chrome extension update lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/extensions-update-lifecycle), and [Chrome Web Store update process](https://developer.chrome.com/docs/webstore/update).
