"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createUpdateAttemptStore, createUpdateController } = require("../shared/updates.cjs");

const ATTEMPT_SCHEMA = "morrow.desktop-update-attempt.v1";
const ATTEMPT_AT = "2026-01-01T00:00:00.000Z";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

function createAdapter(options = {}) {
  const listeners = new Map();
  const adapter = {
    identity: {
      currentVersion: options.currentVersion || "1.0.0",
      platform: options.platform || "darwin",
      arch: options.arch || "arm64",
      feedId: options.feedId || "morrow-desktop-stable"
    },
    checks: 0,
    downloads: 0,
    installs: 0,
    cancellations: 0,
    on(event, listener) {
      const values = listeners.get(event) || new Set();
      values.add(listener);
      listeners.set(event, values);
      return () => values.delete(listener);
    },
    emit(event, value) {
      for (const listener of listeners.get(event) || []) listener(value);
    },
    async checkForUpdates() {
      adapter.checks += 1;
      return options.check ? options.check(adapter) : { isUpdateAvailable: false };
    },
    async downloadUpdate() {
      adapter.downloads += 1;
      return options.download ? options.download(adapter) : ["private-updater-cache"];
    },
    cancelUpdate() {
      adapter.cancellations += 1;
      return options.cancel ? options.cancel(adapter) : undefined;
    },
    async quitAndInstall() {
      adapter.installs += 1;
      return options.install ? options.install(adapter) : undefined;
    }
  };
  // A real adapter always reports this; the stub reports it only where a test
  // measures the space, so every other test keeps the unmeasured path.
  if (options.freeCacheBytes) adapter.freeCacheBytes = options.freeCacheBytes;
  return adapter;
}

/**
 * The injected attempt store, held in memory. The record shape is the one the
 * real store on disk validates and returns.
 */
function memoryAttempts(record = null, { onWrite = () => {}, unreadable = false, damaged = false } = {}) {
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const store = {
    record,
    reads: 0,
    clears: 0,
    async read() {
      store.reads += 1;
      if (unreadable) throw new Error("update attempt record is unreadable");
      if (damaged) return { status: "damaged", record: null, reason: "update_attempt_invalid" };
      return store.record === null
        ? { status: "absent", record: null, reason: null }
        : { status: "valid", record: store.record, reason: null };
    },
    async write(attempt, options = {}) {
      onWrite();
      if (options.expected === undefined) {
        if (store.record !== null) throw new Error("update attempt already exists");
      } else if (!same(store.record, options.expected)) {
        throw new Error("update attempt ownership changed");
      }
      store.record = { schema: ATTEMPT_SCHEMA, ...attempt };
      return store.record;
    },
    async clear(expected) {
      store.clears += 1;
      if (!same(store.record, expected)) return false;
      store.record = null;
      return true;
    }
  };
  return store;
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

function enabledPolicy(extra = {}) {
  return { enabled: true, feed: { id: "morrow-desktop-stable" }, ...extra };
}

function grantedRestartLease(leaseId = "test-restart-lease") {
  return {
    acquireRestartLease: async () => ({ status: "granted", leaseId }),
    releaseRestartLease: async () => undefined,
    commitRestartLease: async () => ({ status: "closing" })
  };
}

function restartLeaseStatus(status) {
  return {
    acquireRestartLease: async () => ({ status }),
    releaseRestartLease: async () => undefined,
    commitRestartLease: async () => ({ status: "closing" })
  };
}

function testClock() {
  return {
    intervals: [],
    setInterval(callback, milliseconds) {
      const entry = { callback, milliseconds, cleared: false, unref() {} };
      this.intervals.push(entry);
      return entry;
    },
    clearInterval(entry) { entry.cleared = true; }
  };
}

test("the installed electron-updater exposes the adapter operations this controller uses", () => {
  const packagePath = require.resolve("electron-updater/package.json");
  const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  assert.match(manifest.version, /^6\.[0-9]+\.[0-9]+$/);
  const declaration = fs.readFileSync(path.join(path.dirname(packagePath), "out", "AppUpdater.d.ts"), "utf8");
  assert.match(declaration, /autoDownload: boolean/);
  assert.match(declaration, /autoInstallOnAppQuit: boolean/);
  assert.match(declaration, /allowPrerelease: boolean/);
  assert.match(declaration, /allowDowngrade: boolean/);
  assert.match(declaration, /disableWebInstaller: boolean/);
  assert.match(declaration, /checkForUpdates\(\): Promise<UpdateCheckResult \| null>/);
  assert.match(declaration, /downloadUpdate\(cancellationToken\?: CancellationToken\)/);
  assert.match(declaration, /quitAndInstall\(isSilent\?: boolean, isForceRunAfter\?: boolean\): void/);
});

test("disabled or unbound policies cannot initiate an update network check", async () => {
  const adapter = createAdapter();
  const disabled = createUpdateController({ adapter, ...grantedRestartLease() });
  assert.deepEqual(await disabled.start(), {
    schema: "morrow.desktop-update.v1",
    status: "unavailable",
    currentVersion: "1.0.0",
    availableVersion: null,
    automatic: false,
    reason: "updates_disabled"
  });
  assert.equal(adapter.checks, 0);
  adapter.emit("update-downloaded", { version: "1.0.1" });
  assert.equal(disabled.snapshot().status, "unavailable");
  assert.equal(disabled.snapshot().reason, "updates_disabled");

  const wrongFeed = createUpdateController({
    adapter,
    policy: { enabled: true, feed: { id: "unowned-route" } },
    ...grantedRestartLease()
  });
  assert.equal((await wrongFeed.start()).reason, "owned_feed_unavailable");
  assert.equal(adapter.checks, 0);
});

test("an enabled controller checks, downloads, and becomes ready without exposing updater paths", async () => {
  const adapter = createAdapter({ check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }) });
  const controller = createUpdateController({ adapter, policy: enabledPolicy(), ...grantedRestartLease(), clock: testClock() });
  await controller.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(adapter.checks, 1);
  assert.equal(adapter.downloads, 1);
  assert.deepEqual(controller.snapshot(), {
    schema: "morrow.desktop-update.v1",
    status: "ready",
    currentVersion: "1.0.0",
    availableVersion: "1.0.1",
    automatic: true,
    reason: null
  });
  assert.equal(Object.hasOwn(controller.snapshot(), "path"), false);
  controller.stop();
});

test("an updater availability event cannot start a download before its matching check has supplied the cancellation token", async () => {
  let checkFinished = false;
  const adapter = createAdapter({
    async check(source) {
      source.emit("update-available", { version: "1.0.1" });
      await Promise.resolve();
      checkFinished = true;
      return { isUpdateAvailable: true, updateInfo: { version: "1.0.1" } };
    },
    download: () => {
      assert.equal(checkFinished, true);
      return [];
    }
  });
  const controller = createUpdateController({ adapter, policy: enabledPolicy(), ...grantedRestartLease() });
  await controller.check();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(adapter.downloads, 1);
  assert.equal(controller.snapshot().status, "ready");
});

test("a premature downloaded event cannot expose ready before updater staging succeeds", async () => {
  const staging = deferred();
  let controller;
  const adapter = createAdapter({
    check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }),
    download: (source) => {
      source.emit("update-downloaded", { version: "1.0.1" });
      return staging.promise;
    }
  });
  controller = createUpdateController({ adapter, policy: enabledPolicy(), ...grantedRestartLease() });
  await controller.check();
  await settle();
  assert.equal(controller.snapshot().status, "downloading");
  assert.equal((await controller.installWhenIdle()).status, "downloading");
  assert.equal(adapter.installs, 0);
  staging.reject(new Error("cache finalization failed"));
  await settle();
  assert.equal(controller.snapshot().status, "error");
  assert.equal(controller.snapshot().reason, "update_download_failed");
  assert.equal(adapter.installs, 0);
});

test("a downloaded event from another candidate generation is refused", async () => {
  const adapter = createAdapter({
    check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }),
    download: (source) => {
      source.emit("update-downloaded", { version: "1.0.2" });
      return ["private-updater-cache"];
    }
  });
  const controller = createUpdateController({ adapter, policy: enabledPolicy(), ...grantedRestartLease() });
  await controller.check();
  await settle();
  assert.equal(controller.snapshot().status, "error");
  assert.equal(controller.snapshot().reason, "update_generation_mismatch");
  assert.equal((await controller.installWhenIdle()).status, "error");
  assert.equal(adapter.installs, 0);
});

test("stop revokes a pending check before it can start a download", async () => {
  const discovery = deferred();
  const adapter = createAdapter({ check: () => discovery.promise });
  const controller = createUpdateController({ adapter, policy: enabledPolicy(), ...grantedRestartLease() });
  const pending = controller.check();
  await settle();
  assert.equal(adapter.checks, 1);
  controller.stop();
  discovery.resolve({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } });
  await pending;
  await settle();
  assert.equal(adapter.cancellations, 1);
  assert.equal(adapter.downloads, 0);
  assert.equal(controller.snapshot().status, "checking");
});

test("a controller rejects malformed, prerelease, stale, downgraded, and wrong-platform candidates before download", async (t) => {
  const cases = [
    ["1.0", "update_version_invalid"],
    ["1.0.0-beta.1", "update_prerelease_unavailable"],
    ["1.0.0", "update_version_not_newer"],
    ["0.9.9", "update_version_not_newer"]
  ];
  for (const [version, reason] of cases) {
    await t.test(version, async () => {
      const adapter = createAdapter({ check: () => ({ isUpdateAvailable: true, updateInfo: { version } }) });
      const controller = createUpdateController({ adapter, policy: enabledPolicy(), ...grantedRestartLease() });
      const result = await controller.check();
      assert.equal(result.status, "error");
      assert.equal(result.reason, reason);
      assert.equal(adapter.downloads, 0);
    });
  }
  const adapter = createAdapter({ check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1", platform: "win32" } }) });
  const controller = createUpdateController({ adapter, policy: enabledPolicy(), ...grantedRestartLease() });
  assert.equal((await controller.check()).reason, "update_platform_mismatch");
  assert.equal(adapter.downloads, 0);
});

test("a prerelease build can advance on its own channel but a stable build cannot enter it by default", async () => {
  const adapter = createAdapter({
    currentVersion: "1.0.0-rc.0",
    check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.0-rc.1" } })
  });
  const controller = createUpdateController({ adapter, policy: enabledPolicy({ automatic: false }), ...grantedRestartLease() });
  assert.deepEqual(await controller.check(), {
    schema: "morrow.desktop-update.v1",
    status: "available",
    currentVersion: "1.0.0-rc.0",
    availableVersion: "1.0.0-rc.1",
    automatic: false,
    reason: null
  });
});

test("corrupt, signature, cancellation, and offline failures use bounded states and never install", async () => {
  const corruptAdapter = createAdapter({
    check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }),
    download: () => Promise.reject(Object.assign(new Error("sha512 checksum mismatch"), { code: "ERR_CHECKSUM_MISMATCH" }))
  });
  const corrupt = createUpdateController({ adapter: corruptAdapter, policy: enabledPolicy(), ...grantedRestartLease() });
  await corrupt.check();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(corrupt.snapshot().reason, "update_verification_failed");
  assert.equal(corruptAdapter.installs, 0);

  const pendingDownload = deferred();
  const cancelledAdapter = createAdapter({
    check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }),
    download: () => pendingDownload.promise
  });
  const cancelled = createUpdateController({ adapter: cancelledAdapter, policy: enabledPolicy(), ...grantedRestartLease() });
  await cancelled.check();
  cancelledAdapter.emit("update-cancelled");
  pendingDownload.resolve([]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled.snapshot().status, "available");
  assert.equal(cancelled.snapshot().reason, "download_cancelled");
  assert.equal(cancelledAdapter.installs, 0);

  const offlineAdapter = createAdapter({ check: () => Promise.reject(new Error("network unreachable")) });
  const offline = createUpdateController({ adapter: offlineAdapter, policy: enabledPolicy(), ...grantedRestartLease() });
  assert.equal((await offline.check()).reason, "update_check_failed");
  assert.equal(offlineAdapter.installs, 0);
});

test("install commits an authoritative lease before it can hand off to the updater", async () => {
  const adapter = createAdapter({ check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }) });
  let leaseStatus = "busy";
  const releases = [];
  const commits = [];
  const controller = createUpdateController({
    adapter,
    policy: enabledPolicy(),
    acquireRestartLease: async () => leaseStatus === "granted"
      ? { status: "granted", leaseId: "known-idle-lease" }
      : { status: leaseStatus },
    releaseRestartLease: async (leaseId) => { releases.push(leaseId); },
    commitRestartLease: async (leaseId) => { commits.push(leaseId); return { status: "closing" }; }
  });
  await controller.check();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await controller.installWhenIdle()).reason, "active_or_uncertain_operations");
  assert.equal(controller.snapshot().status, "ready");
  assert.equal(adapter.installs, 0);
  leaseStatus = "uncertain";
  assert.equal((await controller.installWhenIdle()).reason, "active_or_uncertain_operations");
  assert.equal(adapter.installs, 0);
  leaseStatus = "granted";
  assert.equal((await controller.installWhenIdle()).status, "installing");
  assert.equal(adapter.installs, 1);
  assert.deepEqual(releases, []);
  assert.deepEqual(commits, ["known-idle-lease"]);
});

test("concurrent restart requests acquire one lease and install once", async () => {
  const pendingLease = deferred();
  let acquisitionCount = 0;
  let commitCount = 0;
  const adapter = createAdapter({ check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }) });
  const controller = createUpdateController({
    adapter,
    policy: enabledPolicy(),
    acquireRestartLease: () => {
      acquisitionCount += 1;
      return pendingLease.promise;
    },
    releaseRestartLease: async () => undefined,
    commitRestartLease: async () => { commitCount += 1; return { status: "closing" }; }
  });
  await controller.check();
  await new Promise((resolve) => setImmediate(resolve));
  const first = controller.installWhenIdle();
  const second = controller.installWhenIdle();
  assert.strictEqual(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(acquisitionCount, 1);
  assert.equal(adapter.installs, 0);
  pendingLease.resolve({ status: "granted", leaseId: "single-acquisition" });
  await Promise.all([first, second]);
  assert.equal(adapter.installs, 1);
  assert.equal(commitCount, 1);
});

test("a scheduled check never replaces a verified ready update with an offline or no-update result", async () => {
  let checkCount = 0;
  const clock = testClock();
  const adapter = createAdapter({
    check: () => {
      checkCount += 1;
      return checkCount === 1
        ? { isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }
        : { isUpdateAvailable: false };
    }
  });
  const controller = createUpdateController({ adapter, policy: enabledPolicy(), ...restartLeaseStatus("busy"), clock });
  await controller.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.snapshot().status, "ready");
  assert.equal(controller.snapshot().availableVersion, "1.0.1");
  clock.intervals[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(adapter.checks, 1);
  assert.equal(controller.snapshot().status, "ready");
  assert.equal(controller.snapshot().availableVersion, "1.0.1");
  controller.stop();
});

test("a failed commit releases the held lease and preserves the downloaded version for a later safe retry", async () => {
  const released = [];
  const attempts = memoryAttempts();
  const adapter = createAdapter({
    check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }),
    install: () => { throw new Error("updater must not run before a committed lease"); }
  });
  const controller = createUpdateController({
    adapter,
    policy: enabledPolicy(),
    acquireRestartLease: async () => ({ status: "granted", leaseId: "failed-install-lease" }),
    releaseRestartLease: async (leaseId) => { released.push(leaseId); },
    commitRestartLease: async () => ({ status: "busy" }),
    updateAttempts: attempts,
    confirmUpdatedRuntime: async () => ({ status: "verified" })
  });
  await controller.check();
  await new Promise((resolve) => setImmediate(resolve));
  const result = await controller.installWhenIdle();
  assert.equal(result.status, "ready");
  assert.equal(result.reason, "update_install_failed");
  assert.equal(result.availableVersion, "1.0.1");
  assert.equal(adapter.installs, 0);
  assert.deepEqual(released, ["failed-install-lease"]);
  assert.equal(attempts.record, null);
});

test("a failed release after a failed commit leaves the verified update deferred without an automatic retry", async () => {
  const adapter = createAdapter({
    check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }),
    install: () => { throw new Error("updater must not run before a committed lease"); }
  });
  const controller = createUpdateController({
    adapter,
    policy: enabledPolicy(),
    acquireRestartLease: async () => ({ status: "granted", leaseId: "release-failure-lease" }),
    releaseRestartLease: async () => { throw new Error("lease service unavailable"); },
    commitRestartLease: async () => { throw new Error("owner did not enter closing state"); }
  });
  await controller.check();
  await new Promise((resolve) => setImmediate(resolve));
  const result = await controller.installWhenIdle();
  assert.deepEqual(result, {
    schema: "morrow.desktop-update.v1",
    status: "ready",
    currentVersion: "1.0.0",
    availableVersion: "1.0.1",
    automatic: true,
    reason: "active_or_uncertain_operations"
  });
  assert.equal(adapter.installs, 0);
});

test("a failed updater handoff after commit retains the closing lease and refuses an automatic retry", async () => {
  const released = [];
  const adapter = createAdapter({
    check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }),
    install: () => Promise.reject(new Error("updater refused after closing"))
  });
  const controller = createUpdateController({
    adapter,
    policy: enabledPolicy(),
    acquireRestartLease: async () => ({ status: "granted", leaseId: "committed-lease" }),
    releaseRestartLease: async (leaseId) => { released.push(leaseId); },
    commitRestartLease: async () => ({ status: "closing" })
  });
  await controller.check();
  await new Promise((resolve) => setImmediate(resolve));
  const result = await controller.installWhenIdle();
  assert.equal(result.status, "installing");
  assert.equal(result.reason, "update_install_failed");
  assert.equal(adapter.installs, 1);
  assert.deepEqual(released, []);
});

test("late updater events cannot invalidate an already verified ready update", async () => {
  const adapter = createAdapter({ check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }) });
  const controller = createUpdateController({ adapter, policy: enabledPolicy(), ...grantedRestartLease() });
  await controller.start();
  await settle();
  assert.equal(controller.snapshot().status, "ready");
  adapter.emit("update-downloaded", { version: "1.0.1" });
  assert.equal(controller.snapshot().status, "ready");
  adapter.emit("error", Object.assign(new Error("publisher signature invalid"), { code: "ERR_UPDATER_INVALID_SIGNATURE" }));
  assert.equal(controller.snapshot().status, "ready");
  assert.equal(controller.snapshot().reason, null);
  adapter.emit("update-downloaded", { version: "1.0.2" });
  assert.equal(controller.snapshot().availableVersion, "1.0.1");
  controller.stop();
});

test("concurrent checks share one network action and subscription data is the fixed public snapshot", async () => {
  const pendingCheck = deferred();
  const adapter = createAdapter({ check: () => pendingCheck.promise });
  const controller = createUpdateController({ adapter, policy: enabledPolicy({ automatic: false }), ...grantedRestartLease() });
  const values = [];
  const unsubscribe = controller.subscribe((snapshot) => values.push(snapshot));
  const first = controller.check();
  const second = controller.check();
  pendingCheck.resolve({ isUpdateAvailable: false });
  await Promise.all([first, second]);
  assert.equal(adapter.checks, 1);
  assert.deepEqual(Object.keys(values.at(-1)).sort(), ["automatic", "availableVersion", "currentVersion", "reason", "schema", "status"]);
  unsubscribe();
});

test("an arm64 app refuses an x64 candidate before it downloads anything", async () => {
  const adapter = createAdapter({
    arch: "arm64",
    check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1", platform: "darwin", arch: "x64" } })
  });
  const controller = createUpdateController({ adapter, policy: enabledPolicy(), ...grantedRestartLease() });
  const result = await controller.check();
  assert.equal(result.status, "error");
  assert.equal(result.reason, "update_arch_mismatch");
  assert.equal(result.availableVersion, null);
  assert.equal(adapter.downloads, 0);
  // A downloaded event naming the same wrong architecture cannot promote it.
  adapter.emit("update-downloaded", { version: "1.0.1", arch: "x64" });
  assert.equal(controller.snapshot().status, "error");
  assert.equal(adapter.installs, 0);

  const matching = createAdapter({
    arch: "x64",
    check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1", platform: "darwin", arch: "x64" } })
  });
  const admitted = createUpdateController({ adapter: matching, policy: enabledPolicy({ automatic: false }), ...grantedRestartLease() });
  assert.equal((await admitted.check()).status, "available");
});

test("a candidate the updater cache volume cannot hold is refused before the download and never reaches ready", async () => {
  const megabyte = 1024 * 1024;
  const candidate = () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1", files: [{ url: "Morrow-1.0.1-arm64.zip", size: 90 * megabyte }] } });
  const full = createAdapter({ check: candidate, freeCacheBytes: async () => 100 * megabyte });
  const refused = createUpdateController({ adapter: full, policy: enabledPolicy(), ...grantedRestartLease() });
  await refused.check();
  await settle();
  assert.deepEqual(refused.snapshot(), {
    schema: "morrow.desktop-update.v1",
    status: "error",
    currentVersion: "1.0.0",
    availableVersion: null,
    automatic: true,
    reason: "disk_space_unavailable"
  });
  assert.equal(full.downloads, 0);
  assert.equal(full.installs, 0);

  const roomy = createAdapter({ check: candidate, freeCacheBytes: async () => 1024 * megabyte });
  const admitted = createUpdateController({ adapter: roomy, policy: enabledPolicy(), ...grantedRestartLease() });
  await admitted.check();
  await settle();
  assert.equal(roomy.downloads, 1);
  assert.equal(admitted.snapshot().status, "ready");

  // A computer that does not report its free space does not block the download.
  const unmeasured = createAdapter({ check: candidate, freeCacheBytes: async () => null });
  const proceeds = createUpdateController({ adapter: unmeasured, policy: enabledPolicy(), ...grantedRestartLease() });
  await proceeds.check();
  await settle();
  assert.equal(unmeasured.downloads, 1);
  assert.equal(proceeds.snapshot().status, "ready");
});

test("a download that fails for lack of space reports the volume instead of a generic download failure", async () => {
  const adapter = createAdapter({
    check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }),
    download: () => Promise.reject(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }))
  });
  const controller = createUpdateController({ adapter, policy: enabledPolicy(), ...grantedRestartLease() });
  await controller.check();
  await settle();
  assert.equal(adapter.downloads, 1);
  assert.equal(controller.snapshot().status, "error");
  assert.equal(controller.snapshot().reason, "disk_space_unavailable");
  assert.equal(controller.snapshot().availableVersion, null);
  assert.equal((await controller.installWhenIdle()).status, "error");
  assert.equal(adapter.installs, 0);
});

test("the update attempt store owns one private record it can write, read back, and prove removed", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "morrow-update-attempt-"));
  const stateDirectory = path.join(root, "State");
  const store = createUpdateAttemptStore({ stateDirectory });
  const file = path.join(stateDirectory, "update-attempt.json");
  assert.deepEqual(await store.read(), { status: "absent", record: null, reason: null });

  const first = await store.write({ fromVersion: "1.0.0", toVersion: "1.0.1", at: ATTEMPT_AT });
  assert.deepEqual(await store.read(), { status: "valid", record: first, reason: null });
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(stateDirectory).mode & 0o777, 0o700);
  }

  // A record that names one version twice, or that carries no usable time,
  // describes no attempt this app can act on.
  await assert.rejects(() => store.write({ fromVersion: "1.0.1", toVersion: "1.0.1", at: ATTEMPT_AT }), /invalid/);
  await assert.rejects(() => store.write({ fromVersion: "1.0.0", toVersion: "1.0.1", at: "whenever" }), /invalid/);
  await assert.rejects(
    () => store.write({ fromVersion: "1.0.1", toVersion: "1.0.2", at: "2026-01-02T00:00:00.000Z" }),
    /EEXIST/
  );
  assert.deepEqual(await store.read(), { status: "valid", record: first, reason: null });
  const retried = await store.write(
    { fromVersion: "1.0.0", toVersion: "1.0.1", at: "2026-01-02T00:00:00.000Z" },
    { expected: first }
  );
  assert.deepEqual(await store.read(), { status: "valid", record: retried, reason: null });
  assert.equal(await store.clear(first), false);
  assert.deepEqual(await store.read(), { status: "valid", record: retried, reason: null });
  assert.equal(await store.clear(retried), true);
  assert.equal(fs.existsSync(file), false);

  fs.writeFileSync(file, "{ not json");
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  assert.equal((await store.read()).status, "damaged");
  await assert.rejects(
    () => store.write({ fromVersion: "1.0.1", toVersion: "1.0.2", at: "2026-01-02T00:00:00.000Z" }),
    /EEXIST/
  );
  fs.rmSync(file);

  fs.writeFileSync(file, Buffer.alloc(4 * 1024 + 1, 0x20));
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  assert.deepEqual(await store.read(), { status: "damaged", record: null, reason: "update_attempt_too_large" });
  fs.rmSync(file);

  if (process.platform !== "win32") {
    const external = path.join(root, "external-attempt.json");
    fs.writeFileSync(external, `${JSON.stringify(first)}\n`, { mode: 0o600 });
    fs.symlinkSync(external, file);
    assert.equal((await store.read()).status, "damaged");
    fs.rmSync(file);

    fs.writeFileSync(file, `${JSON.stringify(first)}\n`, { mode: 0o644 });
    assert.equal((await store.read()).status, "damaged");
    fs.rmSync(file);

    fs.chmodSync(stateDirectory, 0o755);
    assert.deepEqual(await store.read(), { status: "damaged", record: null, reason: "update_attempt_state_not_private" });
    fs.chmodSync(stateDirectory, 0o700);
  }
  assert.throws(() => createUpdateAttemptStore({ stateDirectory: "State" }), /absolute/);
});

test("a recorded update whose new version never started reports the rollback and waits for the person to retry", async () => {
  const attempts = memoryAttempts({ schema: ATTEMPT_SCHEMA, fromVersion: "1.0.0", toVersion: "1.0.1", at: ATTEMPT_AT });
  let runtimeChecks = 0;
  const clock = testClock();
  const adapter = createAdapter({ check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }) });
  const controller = createUpdateController({
    adapter,
    policy: enabledPolicy(),
    updateAttempts: attempts,
    confirmUpdatedRuntime: async () => { runtimeChecks += 1; return { status: "verified" }; },
    ...grantedRestartLease(),
    clock
  });
  const started = await controller.start();
  assert.equal(started.status, "error");
  assert.equal(started.reason, "update_rolled_back");
  assert.equal(started.currentVersion, "1.0.0");
  // The version that failed to start is never re-downloaded on its own, on this
  // start or on a schedule, and the runtime question belongs to the new version.
  assert.equal(adapter.checks, 0);
  assert.equal(adapter.downloads, 0);
  assert.equal(clock.intervals.length, 0);
  assert.equal(runtimeChecks, 0);
  assert.notEqual(attempts.record, null);

  // Retry is an explicit check. It proceeds and downloads the update again.
  await controller.check();
  await settle();
  assert.equal(adapter.checks, 1);
  assert.equal(controller.snapshot().status, "ready");
  assert.equal(controller.snapshot().availableVersion, "1.0.1");
  controller.stop();
});

test("a recorded update whose new version started completes only against a proven runtime", async (t) => {
  const record = { schema: ATTEMPT_SCHEMA, fromVersion: "1.0.0", toVersion: "1.0.1", at: ATTEMPT_AT };
  for (const initialStatus of ["unverified", "unknown"]) {
    await t.test(`a runtime reported ${initialStatus} can complete after repair in the same process`, async () => {
      const attempts = memoryAttempts({ ...record });
      const adapter = createAdapter({ currentVersion: "1.0.1" });
      const clock = testClock();
      let status = initialStatus;
      let runtimeChecks = 0;
      const controller = createUpdateController({
        adapter,
        policy: enabledPolicy(),
        updateAttempts: attempts,
        confirmUpdatedRuntime: async () => { runtimeChecks += 1; return { status }; },
        ...grantedRestartLease(),
        clock
      });
      const published = [];
      controller.subscribe((snapshot) => published.push(snapshot));
      await controller.start();
      await settle();
      assert.deepEqual(attempts.record, record);
      assert.equal(adapter.checks, 0);
      assert.equal(adapter.downloads, 0);
      assert.equal(clock.intervals.length, 0);
      assert.equal(controller.snapshot().availableVersion, null);
      assert.equal(published.some((snapshot) => snapshot.reason === "update_complete"), false);
      await controller.check();
      assert.equal(adapter.checks, 0);
      assert.equal(runtimeChecks, 2);

      status = "verified";
      const recovered = await controller.reconcileAfterRepair();
      assert.equal(recovered.status, "idle");
      assert.equal(recovered.reason, "update_complete");
      assert.equal(attempts.record, null);
      assert.equal(runtimeChecks, 3);
      assert.equal(adapter.checks, 0);
      controller.stop();
    });
  }

  const attempts = memoryAttempts({ ...record });
  const adapter = createAdapter({ currentVersion: "1.0.1" });
  const controller = createUpdateController({
    adapter,
    policy: enabledPolicy(),
    updateAttempts: attempts,
    confirmUpdatedRuntime: async () => ({ status: "verified" }),
    ...grantedRestartLease(),
    clock: testClock()
  });
  const published = [];
  controller.subscribe((snapshot) => published.push(snapshot));
  await controller.start();
  await settle();
  assert.equal(attempts.record, null);
  assert.equal(published.some((snapshot) => snapshot.status === "idle" && snapshot.reason === "update_complete"), true);
  assert.equal(adapter.checks, 1);
  controller.stop();
});

test("concurrent post-repair reconciliation shares one runtime confirmation and terminal result", async () => {
  const record = { schema: ATTEMPT_SCHEMA, fromVersion: "1.0.0", toVersion: "1.0.1", at: ATTEMPT_AT };
  const attempts = memoryAttempts({ ...record });
  const confirmation = deferred();
  let runtimeChecks = 0;
  const controller = createUpdateController({
    adapter: createAdapter({ currentVersion: "1.0.1" }),
    policy: enabledPolicy(),
    updateAttempts: attempts,
    confirmUpdatedRuntime: async () => {
      runtimeChecks += 1;
      return runtimeChecks === 1 ? { status: "unknown" } : confirmation.promise;
    },
    ...grantedRestartLease(),
    clock: testClock()
  });
  await controller.start();
  assert.equal(runtimeChecks, 1);

  const first = controller.reconcileAfterRepair();
  const second = controller.reconcileAfterRepair();
  assert.strictEqual(first, second);
  await settle();
  assert.equal(runtimeChecks, 2);
  confirmation.resolve({ status: "verified" });
  const [left, right] = await Promise.all([first, second]);
  assert.deepEqual(left, right);
  assert.equal(left.reason, "update_complete");
  assert.equal(attempts.clears, 1);
  assert.equal(attempts.record, null);

  await controller.reconcileAfterRepair();
  assert.equal(runtimeChecks, 2, "a terminal reconciliation repeated runtime confirmation");
  assert.equal(attempts.clears, 1, "a terminal reconciliation repeated the exact clear");
  controller.stop();
});

test("a record that describes neither the running version nor its update is removed instead of acted on", async () => {
  const attempts = memoryAttempts({ schema: ATTEMPT_SCHEMA, fromVersion: "0.9.0", toVersion: "0.9.1", at: ATTEMPT_AT });
  const adapter = createAdapter();
  const controller = createUpdateController({
    adapter,
    policy: enabledPolicy(),
    updateAttempts: attempts,
    confirmUpdatedRuntime: async () => ({ status: "verified" }),
    ...grantedRestartLease(),
    clock: testClock()
  });
  const result = await controller.start();
  assert.equal(attempts.record, null);
  assert.equal(result.status, "idle");
  assert.equal(result.reason, "up_to_date");
  controller.stop();
});

test("a restart records the attempt before it hands the update to the updater and refuses an unrecorded handoff", async () => {
  const order = [];
  const attempts = memoryAttempts(null, { onWrite: () => order.push("record") });
  const adapter = createAdapter({
    check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }),
    install: () => { order.push("install"); }
  });
  const controller = createUpdateController({
    adapter,
    policy: enabledPolicy(),
    updateAttempts: attempts,
    confirmUpdatedRuntime: async () => ({ status: "verified" }),
    acquireRestartLease: async () => ({ status: "granted", leaseId: "ordered-lease" }),
    releaseRestartLease: async () => undefined,
    commitRestartLease: async () => { order.push("commit"); return { status: "closing" }; }
  });
  await controller.check();
  await settle();
  assert.equal((await controller.installWhenIdle()).status, "installing");
  assert.deepEqual(order, ["record", "commit", "install"]);
  assert.equal(attempts.record.fromVersion, "1.0.0");
  assert.equal(attempts.record.toVersion, "1.0.1");
  assert.equal(Number.isFinite(Date.parse(attempts.record.at)), true);

  const unwritable = {
    read: async () => ({ status: "absent", record: null, reason: null }),
    write: async () => { throw new Error("state directory is unwritable"); },
    clear: async () => false
  };
  const leaseOrder = [];
  const secondAdapter = createAdapter({ check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }) });
  const second = createUpdateController({
    adapter: secondAdapter,
    policy: enabledPolicy(),
    updateAttempts: unwritable,
    confirmUpdatedRuntime: async () => ({ status: "verified" }),
    acquireRestartLease: async () => ({ status: "granted", leaseId: "unrecorded-lease" }),
    releaseRestartLease: async (leaseId) => { leaseOrder.push(`release:${leaseId}`); },
    commitRestartLease: async () => { leaseOrder.push("commit"); return { status: "closing" }; }
  });
  await second.check();
  await settle();
  const deferredResult = await second.installWhenIdle();
  assert.equal(deferredResult.status, "ready");
  assert.equal(deferredResult.reason, "active_or_uncertain_operations");
  assert.equal(deferredResult.availableVersion, "1.0.1");
  assert.equal(secondAdapter.installs, 0);
  assert.deepEqual(leaseOrder, ["release:unrecorded-lease"]);
});

test("an attempt store without a runtime check, or missing an operation, is refused at construction", () => {
  const adapter = createAdapter();
  assert.throws(() => createUpdateController({
    adapter,
    policy: enabledPolicy(),
    updateAttempts: memoryAttempts(),
    ...grantedRestartLease()
  }), /confirmUpdatedRuntime/);
  assert.throws(() => createUpdateController({
    adapter,
    policy: enabledPolicy(),
    updateAttempts: { read: async () => null },
    confirmUpdatedRuntime: async () => ({ status: "verified" }),
    ...grantedRestartLease()
  }), /update attempt store is incomplete/);
});

test("an unreadable attempt record blocks checks and downloads with an explicit repair state", async () => {
  const attempts = memoryAttempts(null, { unreadable: true });
  const adapter = createAdapter();
  const clock = testClock();
  const controller = createUpdateController({
    adapter,
    policy: enabledPolicy(),
    updateAttempts: attempts,
    confirmUpdatedRuntime: async () => ({ status: "verified" }),
    ...grantedRestartLease(),
    clock
  });
  const result = await controller.start();
  assert.equal(attempts.reads, 1);
  assert.equal(result.status, "error");
  assert.equal(result.reason, "update_attempt_repair_required");
  assert.equal(adapter.checks, 0);
  assert.equal(adapter.downloads, 0);
  assert.equal(clock.intervals.length, 0);
  assert.equal((await controller.check()).reason, "update_attempt_repair_required");
  assert.equal(attempts.reads, 2);
  assert.equal(adapter.checks, 0);
  controller.stop();
});
