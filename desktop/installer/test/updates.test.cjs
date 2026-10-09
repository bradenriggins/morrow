"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  INSTALL_LEASE_ACQUIRE_TIMEOUT_MS,
  INSTALL_LEASE_COMMIT_TIMEOUT_MS,
  INSTALL_QUIT_TIMEOUT_MS,
  STALE_TEMP_SWEEP_MS,
  UPDATE_ATTEMPT_LOCK_FILE,
  UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_DOWNLOAD_TIMEOUT_MS,
  createUpdateAttemptStore,
  createUpdateController
} = require("../shared/updates.cjs");

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

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
    timeouts: [],
    setInterval(callback, milliseconds) {
      const entry = { callback, milliseconds, cleared: false, unref() {} };
      this.intervals.push(entry);
      return entry;
    },
    clearInterval(entry) { entry.cleared = true; },
    setTimeout(callback, milliseconds) {
      const entry = { callback, milliseconds, cleared: false, unref() {} };
      this.timeouts.push(entry);
      return entry;
    },
    clearTimeout(entry) { entry.cleared = true; },
    fireTimeout(milliseconds) {
      const entry = this.timeouts.find((candidate) => !candidate.cleared && candidate.milliseconds === milliseconds);
      assert.ok(entry, `no active ${milliseconds} ms timeout`);
      entry.cleared = true;
      entry.callback();
    }
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
    revision: 1,
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
    revision: 4,
    status: "ready",
    currentVersion: "1.0.0",
    availableVersion: "1.0.1",
    automatic: true,
    reason: null
  });
  assert.equal(Object.hasOwn(controller.snapshot(), "path"), false);
  controller.stop();
});

test("every update snapshot carries the controller's monotonic revision", async () => {
  const adapter = createAdapter({ check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }) });
  const controller = createUpdateController({
    adapter,
    policy: enabledPolicy({ automatic: false }),
    ...grantedRestartLease(),
    clock: testClock()
  });
  const snapshots = [];
  controller.subscribe((snapshot) => snapshots.push(snapshot));

  const available = await controller.check();

  assert.deepEqual(snapshots.map((snapshot) => snapshot.revision), [0, 1, 2]);
  assert.equal(available.revision, 2);
  assert.equal(controller.snapshot().revision, 2);
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
  await pending;
  assert.equal(adapter.cancellations, 1);
  assert.equal(adapter.downloads, 0);
  assert.equal(controller.snapshot().status, "checking");
  discovery.resolve({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } });
  await settle();
  assert.equal(adapter.downloads, 0);
  assert.equal(controller.snapshot().status, "checking");
});

test("a never-settling update check times out, releases ownership, and ignores its late result", async () => {
  const firstCheck = deferred();
  const clock = testClock();
  const adapter = createAdapter({
    check: (source) => source.checks === 1 ? firstCheck.promise : { isUpdateAvailable: false }
  });
  const controller = createUpdateController({
    adapter,
    policy: enabledPolicy({ automatic: false }),
    ...grantedRestartLease(),
    clock
  });

  const pending = controller.check();
  await settle();
  clock.fireTimeout(UPDATE_CHECK_TIMEOUT_MS);
  assert.deepEqual(await pending, {
    schema: "morrow.desktop-update.v1",
    revision: 2,
    status: "error",
    currentVersion: "1.0.0",
    availableVersion: null,
    automatic: false,
    reason: "update_check_timeout"
  });
  assert.equal(adapter.cancellations, 1);

  const recovered = await controller.check();
  assert.equal(recovered.status, "idle");
  assert.equal(recovered.reason, "up_to_date");
  assert.equal(adapter.checks, 2, "the timed-out shared promise still owned later checks");
  firstCheck.resolve({ isUpdateAvailable: true, updateInfo: { version: "9.0.0" } });
  await settle();
  assert.equal(controller.snapshot().status, "idle");
  assert.equal(controller.snapshot().availableVersion, null);
  assert.equal(adapter.downloads, 0);
});

test("a never-settling download times out to a retryable candidate and ignores its late result", async () => {
  const firstDownload = deferred();
  const clock = testClock();
  const adapter = createAdapter({
    check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }),
    download: (source) => source.downloads === 1 ? firstDownload.promise : ["private-updater-cache"]
  });
  const controller = createUpdateController({ adapter, policy: enabledPolicy(), ...grantedRestartLease(), clock });

  await controller.check();
  await settle();
  assert.equal(controller.snapshot().status, "downloading");
  const pending = controller.check();
  clock.fireTimeout(UPDATE_DOWNLOAD_TIMEOUT_MS);
  assert.deepEqual(await pending, {
    schema: "morrow.desktop-update.v1",
    revision: 4,
    status: "available",
    currentVersion: "1.0.0",
    availableVersion: "1.0.1",
    automatic: true,
    reason: "update_download_timeout"
  });
  assert.equal(adapter.cancellations, 1);

  await controller.check();
  await settle();
  assert.equal(adapter.downloads, 2, "the timed-out shared promise still owned the retry");
  assert.equal(controller.snapshot().status, "ready");
  firstDownload.resolve(["late-private-updater-cache"]);
  await settle();
  assert.equal(controller.snapshot().status, "ready");
  assert.equal(controller.snapshot().availableVersion, "1.0.1");
});

test("a download timeout does not replace an updater verification failure", async () => {
  const staging = deferred();
  const clock = testClock();
  const adapter = createAdapter({
    check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }),
    download: () => staging.promise
  });
  const controller = createUpdateController({ adapter, policy: enabledPolicy(), ...grantedRestartLease(), clock });

  await controller.check();
  await settle();
  const pending = controller.check();
  adapter.emit("error", Object.assign(new Error("sha512 checksum mismatch"), { code: "ERR_CHECKSUM_MISMATCH" }));
  assert.equal(controller.snapshot().reason, "update_verification_failed");
  clock.fireTimeout(UPDATE_DOWNLOAD_TIMEOUT_MS);
  const result = await pending;
  assert.equal(result.status, "error");
  assert.equal(result.reason, "update_verification_failed");
  assert.equal(result.availableVersion, null);
  assert.equal(adapter.cancellations, 1);
});

test("stop promptly settles an active download and permits a clean restart", async () => {
  const firstDownload = deferred();
  const adapter = createAdapter({
    check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }),
    download: (source) => source.downloads === 1 ? firstDownload.promise : ["private-updater-cache"]
  });
  const controller = createUpdateController({ adapter, policy: enabledPolicy(), ...grantedRestartLease() });

  await controller.check();
  await settle();
  const pending = controller.check();
  controller.stop();
  await pending;
  assert.equal(adapter.cancellations, 1);
  assert.equal(controller.snapshot().status, "downloading");

  await controller.start();
  await settle();
  assert.equal(adapter.downloads, 2);
  assert.equal(controller.snapshot().status, "ready");
  firstDownload.resolve(["late-private-updater-cache"]);
  await settle();
  assert.equal(controller.snapshot().status, "ready");
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
    revision: 2,
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

test("a missing attempt store does not commit the restart lease or hand off the install", async () => {
  const adapter = createAdapter({ check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }) });
  const commits = [];
  const releases = [];
  const controller = createUpdateController({
    adapter,
    policy: enabledPolicy(),
    acquireRestartLease: async () => ({ status: "granted", leaseId: "unrecorded-lease" }),
    releaseRestartLease: async (leaseId) => { releases.push(leaseId); },
    commitRestartLease: async (leaseId) => { commits.push(leaseId); return { status: "closing" }; },
  });
  await controller.check();
  await new Promise((resolve) => setImmediate(resolve));
  const result = await controller.installWhenIdle();
  assert.equal(result.status, "error");
  assert.equal(result.reason, "update_runtime_unverified");
  assert.equal(adapter.installs, 0);
  assert.deepEqual(commits, []);
  assert.deepEqual(releases, ["unrecorded-lease"]);
});

test("install commits an authoritative lease before it can hand off to the updater", async () => {
  const adapter = createAdapter({ check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }) });
  let leaseStatus = "busy";
  const releases = [];
  const commits = [];
  const controller = createUpdateController({
    adapter,
    policy: enabledPolicy(),
    updateAttempts: memoryAttempts(),
    confirmUpdatedRuntime: async () => ({ status: "verified" }),
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
    updateAttempts: memoryAttempts(),
    confirmUpdatedRuntime: async () => ({ status: "verified" }),
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
    releaseRestartLease: async (leaseId) => { assert.notEqual(attempts.record, null); released.push(leaseId); },
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
    updateAttempts: memoryAttempts(),
    confirmUpdatedRuntime: async () => ({ status: "verified" }),
    acquireRestartLease: async () => ({ status: "granted", leaseId: "release-failure-lease" }),
    releaseRestartLease: async () => { throw new Error("lease service unavailable"); },
    commitRestartLease: async () => { throw new Error("owner did not enter closing state"); }
  });
  await controller.check();
  await new Promise((resolve) => setImmediate(resolve));
  const result = await controller.installWhenIdle();
  assert.deepEqual(result, {
    schema: "morrow.desktop-update.v1",
    revision: 5,
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
    updateAttempts: memoryAttempts(),
    confirmUpdatedRuntime: async () => ({ status: "verified" }),
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
  assert.deepEqual(Object.keys(values.at(-1)).sort(), ["automatic", "availableVersion", "currentVersion", "reason", "revision", "schema", "status"]);
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
    revision: 3,
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
  const store = createUpdateAttemptStore({ stateDirectory, ...hostStoreOptions(root) });
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

test("repair removes a damaged attempt record so checks work again", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "morrow-update-attempt-repair-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, "State");
  await fs.promises.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const file = path.join(stateDirectory, "update-attempt.json");
  fs.writeFileSync(file, "{ not json");
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  const attempts = createUpdateAttemptStore({ stateDirectory, ...hostStoreOptions(root) });
  assert.equal((await attempts.read()).status, "damaged");

  const adapter = createAdapter();
  const controller = createUpdateController({
    adapter,
    policy: enabledPolicy(),
    updateAttempts: attempts,
    confirmUpdatedRuntime: async () => ({ status: "verified" }),
    ...grantedRestartLease(),
    clock: testClock()
  });
  const blocked = await controller.start();
  assert.equal(blocked.status, "error");
  assert.equal(blocked.reason, "update_attempt_repair_required");
  assert.equal(adapter.checks, 0);

  const recovered = await controller.reconcileAfterRepair();
  assert.equal(recovered.status, "idle");
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(await attempts.read(), { status: "absent", record: null, reason: null });

  await controller.check();
  assert.equal(adapter.checks, 1);
  controller.stop();
});

test("repair keeps a damaged attempt record it cannot remove blocked", async () => {
  const attempts = memoryAttempts(null, { unreadable: true });
  const adapter = createAdapter();
  const controller = createUpdateController({
    adapter,
    policy: enabledPolicy(),
    updateAttempts: attempts,
    confirmUpdatedRuntime: async () => ({ status: "verified" }),
    ...grantedRestartLease(),
    clock: testClock()
  });
  await controller.start();
  assert.equal(typeof attempts.clearDamaged, "undefined");
  const recovered = await controller.reconcileAfterRepair();
  assert.equal(recovered.status, "error");
  assert.equal(recovered.reason, "update_attempt_repair_required");
  assert.equal(adapter.checks, 0);
  controller.stop();
});

test("the attempt store removes only a damaged record through clearDamaged", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "morrow-update-attempt-clear-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, "State");
  const store = createUpdateAttemptStore({ stateDirectory, ...hostStoreOptions(root) });
  const file = path.join(stateDirectory, "update-attempt.json");
  assert.equal(await store.clearDamaged(), true);

  const written = await store.write({ fromVersion: "1.0.0", toVersion: "1.0.1", at: ATTEMPT_AT });
  assert.equal(await store.clearDamaged(), false);
  assert.deepEqual(await store.read(), { status: "valid", record: written, reason: null });

  fs.writeFileSync(file, "{ not json");
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  assert.equal((await store.read()).status, "damaged");
  assert.equal(await store.clearDamaged(), true);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(await store.read(), { status: "absent", record: null, reason: null });
});

function hostStoreOptions(root) {
  if (process.platform !== "win32") return {};
  return { platform: "win32", trustedRoot: root, windowsPrivateAccess: windowsAccessStub().access };
}

function windowsAccessStub({ directory = true, file = true, harden = true } = {}) {
  const calls = { directory: 0, file: 0, harden: 0, options: [] };
  return {
    calls,
    access: {
      privateDirectoryAccessAccepted: (_directoryPath, options) => { calls.directory += 1; calls.options.push(options); return directory; },
      privateFileAccessAccepted: (_filePath, _mode, options) => { calls.file += 1; calls.options.push(options); return file; },
      hardenPrivateDirectory: (_directoryPath, options) => { calls.harden += 1; calls.options.push(options); return harden; }
    }
  };
}

test("the attempt store enforces Windows access control instead of relying on startup hardening", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "morrow-update-attempt-windows-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, "State");

  const accepting = windowsAccessStub();
  const store = createUpdateAttemptStore({
    stateDirectory,
    trustedRoot: root,
    platform: "win32",
    windowsPrivateAccess: accepting.access
  });
  const written = await store.write({ fromVersion: "1.0.0", toVersion: "1.0.1", at: ATTEMPT_AT });
  assert.equal(accepting.calls.harden, 1);
  assert.deepEqual(accepting.calls.options[0], { trustedRoot: root });
  assert.deepEqual(await store.read(), { status: "valid", record: written, reason: null });

  const openFile = windowsAccessStub({ file: false });
  const readable = createUpdateAttemptStore({
    stateDirectory,
    trustedRoot: root,
    platform: "win32",
    windowsPrivateAccess: openFile.access
  });
  assert.deepEqual(
    await readable.read(),
    { status: "damaged", record: null, reason: "update_attempt_not_private" }
  );

  const openDirectory = windowsAccessStub({ directory: false });
  const exposed = createUpdateAttemptStore({
    stateDirectory,
    trustedRoot: root,
    platform: "win32",
    windowsPrivateAccess: openDirectory.access
  });
  assert.deepEqual(
    await exposed.read(),
    { status: "damaged", record: null, reason: "update_attempt_state_not_private" }
  );
  assert.equal(await exposed.clear(written), false);

  const unhardenable = windowsAccessStub({ harden: false });
  const unhardened = createUpdateAttemptStore({
    stateDirectory: path.join(root, "Fresh"),
    trustedRoot: root,
    platform: "win32",
    windowsPrivateAccess: unhardenable.access
  });
  await assert.rejects(
    () => unhardened.write({ fromVersion: "1.0.0", toVersion: "1.0.1", at: ATTEMPT_AT }),
    /not private/
  );
});

test("the attempt store requires the access injection on win32 and fails closed without it", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "morrow-update-attempt-win32-plain-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, "State");
  // Without the injection there is no ACL check and no hardening on win32, so
  // the store refuses to exist instead of keeping shape-only checks.
  assert.throws(
    () => createUpdateAttemptStore({ stateDirectory, platform: "win32" }),
    /windows access is required/
  );
  assert.throws(
    () => createUpdateAttemptStore({ stateDirectory, platform: "win32", windowsPrivateAccess: null }),
    /windows access is required/
  );
  // Off Windows the injection stays optional: POSIX mode checks decide.
  const store = createUpdateAttemptStore({ stateDirectory, platform: "darwin" });
  if (process.platform !== "win32") {
    const written = await store.write({ fromVersion: "1.0.0", toVersion: "1.0.1", at: ATTEMPT_AT });
    assert.deepEqual(await store.read(), { status: "valid", record: written, reason: null });
    assert.equal(await store.clear(written), true);
  }
});

test("the attempt store ignores a Windows access injection off Windows", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "morrow-update-attempt-posix-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, "State");
  const denying = windowsAccessStub({ directory: false, file: false, harden: false });
  const store = createUpdateAttemptStore({
    stateDirectory,
    trustedRoot: root,
    platform: "darwin",
    windowsPrivateAccess: denying.access
  });
  if (process.platform === "win32") {
    // A Windows host cannot verify POSIX privacy, so the store fails closed. The injection
    // stays ignored either way: the refusal comes from the mode check, never the stub.
    await assert.rejects(
      () => store.write({ fromVersion: "1.0.0", toVersion: "1.0.1", at: ATTEMPT_AT }),
      /not private/
    );
  } else {
    const written = await store.write({ fromVersion: "1.0.0", toVersion: "1.0.1", at: ATTEMPT_AT });
    assert.deepEqual(await store.read(), { status: "valid", record: written, reason: null });
  }
  assert.deepEqual([denying.calls.directory, denying.calls.file, denying.calls.harden], [0, 0, 0]);
});

test("the attempt store refuses an incomplete Windows access injection", () => {
  assert.throws(
    () => createUpdateAttemptStore({ stateDirectory: path.join(os.tmpdir(), "State"), platform: "win32", windowsPrivateAccess: {} }),
    /windows access is incomplete/
  );
  assert.throws(
    () => createUpdateAttemptStore({ stateDirectory: path.join(os.tmpdir(), "State"), trustedRoot: "relative" }),
    /trustedRoot/
  );
});

test("two conditional writers with the same expectation serialize so exactly one wins", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "morrow-update-attempt-race-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, "State");
  const store = createUpdateAttemptStore({ stateDirectory, ...hostStoreOptions(root) });
  const first = await store.write({ fromVersion: "1.0.0", toVersion: "1.0.1", at: ATTEMPT_AT });
  const left = store.write(
    { fromVersion: "1.0.0", toVersion: "1.0.2", at: "2026-01-02T00:00:00.000Z" },
    { expected: first }
  );
  const right = store.write(
    { fromVersion: "1.0.0", toVersion: "1.0.3", at: "2026-01-03T00:00:00.000Z" },
    { expected: first }
  );
  const outcomes = await Promise.allSettled([left, right]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.match(outcomes.find((outcome) => outcome.status === "rejected").reason.message, /ownership changed/);
  const final = await store.read();
  assert.equal(final.status, "valid");
  assert.ok(["1.0.2", "1.0.3"].includes(final.record.toVersion));
});

test("a conditional write queued on the lock observes the record committed while it waited", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "morrow-update-attempt-queued-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, "State");
  const file = path.join(stateDirectory, "update-attempt.json");
  const store = createUpdateAttemptStore({ stateDirectory, ...hostStoreOptions(root) });
  const first = await store.write({ fromVersion: "1.0.0", toVersion: "1.0.1", at: ATTEMPT_AT });
  const lockPath = path.join(stateDirectory, UPDATE_ATTEMPT_LOCK_FILE);
  fs.writeFileSync(lockPath, "test-holder\n");
  const pending = store.write(
    { fromVersion: "1.0.0", toVersion: "1.0.2", at: "2026-01-02T00:00:00.000Z" },
    { expected: first }
  );
  await sleep(50);
  const committed = { schema: ATTEMPT_SCHEMA, fromVersion: "1.0.0", toVersion: "1.0.9", at: "2026-01-09T00:00:00.000Z" };
  fs.writeFileSync(file, `${JSON.stringify(committed)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  fs.rmSync(lockPath);
  await assert.rejects(pending, /ownership changed/);
  assert.deepEqual((await store.read()).record, committed);
});

test("clear re-verifies identity under the lock and keeps a record written while it waited", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "morrow-update-attempt-clear-race-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, "State");
  const file = path.join(stateDirectory, "update-attempt.json");
  const store = createUpdateAttemptStore({ stateDirectory, ...hostStoreOptions(root) });
  const first = await store.write({ fromVersion: "1.0.0", toVersion: "1.0.1", at: ATTEMPT_AT });
  const lockPath = path.join(stateDirectory, UPDATE_ATTEMPT_LOCK_FILE);
  fs.writeFileSync(lockPath, "test-holder\n");
  const pending = store.clear(first);
  await sleep(50);
  const replacement = { schema: ATTEMPT_SCHEMA, fromVersion: "1.0.0", toVersion: "1.0.2", at: "2026-01-02T00:00:00.000Z" };
  fs.writeFileSync(file, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  fs.rmSync(lockPath);
  assert.equal(await pending, false);
  assert.deepEqual((await store.read()).record, replacement);
});

test("clearDamaged keeps a valid record written while it waited on the lock", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "morrow-update-attempt-cleardamaged-race-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, "State");
  const file = path.join(stateDirectory, "update-attempt.json");
  const store = createUpdateAttemptStore({ stateDirectory, ...hostStoreOptions(root) });
  await store.write({ fromVersion: "1.0.0", toVersion: "1.0.1", at: ATTEMPT_AT });
  fs.writeFileSync(file, "{ not json");
  assert.equal((await store.read()).status, "damaged");
  const lockPath = path.join(stateDirectory, UPDATE_ATTEMPT_LOCK_FILE);
  fs.writeFileSync(lockPath, "test-holder\n");
  const pending = store.clearDamaged();
  await sleep(50);
  const replacement = { schema: ATTEMPT_SCHEMA, fromVersion: "1.0.0", toVersion: "1.0.2", at: "2026-01-02T00:00:00.000Z" };
  fs.writeFileSync(file, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  fs.rmSync(lockPath);
  assert.equal(await pending, false);
  assert.deepEqual((await store.read()).record, replacement);
});

test("clearDamaged unlinks only the same damaged identity it verified", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "morrow-update-attempt-identity-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, "State");
  const file = path.join(stateDirectory, "update-attempt.json");
  const store = createUpdateAttemptStore({ stateDirectory, ...hostStoreOptions(root) });
  await store.write({ fromVersion: "1.0.0", toVersion: "1.0.1", at: ATTEMPT_AT });
  fs.writeFileSync(file, "{ not json");
  assert.equal((await store.read()).status, "damaged");
  const lockPath = path.join(stateDirectory, UPDATE_ATTEMPT_LOCK_FILE);
  fs.writeFileSync(lockPath, "test-holder\n");
  const pending = store.clearDamaged();
  // The head start lets the queued call finish its first read of the original
  // damage before the swap lands; the sizes differ so the identity check
  // cannot mistake one for the other even within one mtime tick.
  await sleep(50);
  const swapped = "{ not json, replaced while queued, longer";
  fs.writeFileSync(file, swapped);
  fs.rmSync(lockPath);
  assert.equal(await pending, false);
  assert.equal(fs.readFileSync(file, "utf8"), swapped);
  // The next repair pass re-verifies the new identity from scratch and
  // removes it.
  assert.equal(await store.clearDamaged(), true);
  assert.equal(fs.existsSync(file), false);
});

test("a hung lease acquisition times out to deferred and releases the shared install promise", async () => {
  const clock = testClock();
  let acquisitions = 0;
  const releases = [];
  const adapter = createAdapter({ check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }) });
  const controller = createUpdateController({
    adapter,
    policy: enabledPolicy(),
    clock,
    acquireRestartLease: () => { acquisitions += 1; return new Promise(() => {}); },
    releaseRestartLease: async (leaseId) => { releases.push(leaseId); },
    commitRestartLease: async () => ({ status: "closing" })
  });
  await controller.check();
  await settle();
  assert.equal(controller.snapshot().status, "ready");
  const pending = controller.installWhenIdle();
  await settle();
  assert.equal(acquisitions, 1);
  clock.fireTimeout(INSTALL_LEASE_ACQUIRE_TIMEOUT_MS);
  const result = await pending;
  assert.equal(result.status, "ready");
  assert.equal(result.reason, "active_or_uncertain_operations");
  assert.equal(adapter.installs, 0);
  assert.deepEqual(releases, []);
  // The wedge is gone: a second attempt acquires again instead of joining a
  // promise that can never settle.
  const retry = controller.installWhenIdle();
  await settle();
  assert.equal(acquisitions, 2);
  clock.fireTimeout(INSTALL_LEASE_ACQUIRE_TIMEOUT_MS);
  await retry;
  controller.stop();
});

test("a lease grant that arrives after acquisition expiry is released instead of used", async () => {
  const clock = testClock();
  const gate = deferred();
  const releases = [];
  const adapter = createAdapter({ check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }) });
  const controller = createUpdateController({
    adapter,
    policy: enabledPolicy(),
    clock,
    acquireRestartLease: () => gate.promise,
    releaseRestartLease: async (leaseId) => { releases.push(leaseId); },
    commitRestartLease: async () => ({ status: "closing" })
  });
  await controller.check();
  await settle();
  const pending = controller.installWhenIdle();
  await settle();
  clock.fireTimeout(INSTALL_LEASE_ACQUIRE_TIMEOUT_MS);
  const result = await pending;
  assert.equal(result.reason, "active_or_uncertain_operations");
  gate.resolve({ status: "granted", leaseId: "late-lease" });
  await settle();
  await settle();
  assert.deepEqual(releases, ["late-lease"]);
  assert.equal(adapter.installs, 0);
  controller.stop();
});

test("a hung lease commit times out, releases the lease, and clears the attempt record", async () => {
  const clock = testClock();
  const attempts = memoryAttempts();
  const releases = [];
  let acquisitions = 0;
  const adapter = createAdapter({ check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }) });
  const controller = createUpdateController({
    adapter,
    policy: enabledPolicy(),
    clock,
    updateAttempts: attempts,
    confirmUpdatedRuntime: async () => ({ status: "verified" }),
    acquireRestartLease: async () => { acquisitions += 1; return { status: "granted", leaseId: "hung-commit-lease" }; },
    releaseRestartLease: async (leaseId) => { releases.push(leaseId); },
    commitRestartLease: () => new Promise(() => {})
  });
  await controller.check();
  await settle();
  const pending = controller.installWhenIdle();
  await settle();
  await settle();
  assert.notEqual(attempts.record, null);
  clock.fireTimeout(INSTALL_LEASE_COMMIT_TIMEOUT_MS);
  const result = await pending;
  assert.equal(result.status, "ready");
  assert.equal(result.reason, "update_install_failed");
  assert.equal(result.availableVersion, "1.0.1");
  assert.equal(adapter.installs, 0);
  assert.deepEqual(releases, ["hung-commit-lease"]);
  assert.equal(attempts.record, null);
  const retry = controller.installWhenIdle();
  await settle();
  await settle();
  assert.equal(acquisitions, 2);
  clock.fireTimeout(INSTALL_LEASE_COMMIT_TIMEOUT_MS);
  await retry;
  controller.stop();
});

test("a late closing commit with an unconfirmed release keeps recovery evidence and blocks retry", async () => {
  const clock = testClock();
  const attempts = memoryAttempts();
  const commit = deferred();
  let acquisitions = 0;
  const adapter = createAdapter({ check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }) });
  const controller = createUpdateController({
    adapter, clock, policy: enabledPolicy(), updateAttempts: attempts,
    confirmUpdatedRuntime: async () => ({ status: "verified" }),
    acquireRestartLease: async () => { acquisitions += 1; return { status: "granted", leaseId: "late-commit-lease" }; },
    commitRestartLease: () => commit.promise,
    releaseRestartLease: async () => {
      assert.notEqual(attempts.record, null, "recovery evidence must survive until release is confirmed");
      throw new Error("closing owner no longer accepts release");
    }
  });
  await controller.check();
  await settle();
  const pending = controller.installWhenIdle();
  await settle();
  await settle();
  const recorded = attempts.record;
  assert.notEqual(recorded, null);
  clock.fireTimeout(INSTALL_LEASE_COMMIT_TIMEOUT_MS);
  assert.equal((await pending).reason, "active_or_uncertain_operations");
  assert.deepEqual(attempts.record, recorded);
  assert.equal(attempts.clears, 0);
  commit.resolve({ status: "closing" });
  await settle();
  await controller.reconcileAfterRepair();
  await controller.installWhenIdle();
  await controller.check();
  assert.equal(acquisitions, 1);
  assert.equal(adapter.checks, 1);
  assert.equal(adapter.installs, 0);
  assert.deepEqual(attempts.record, recorded);
  controller.stop();
  const restartAdapter = createAdapter({ check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.2" } }) });
  const restarted = createUpdateController({
    adapter: restartAdapter, clock: testClock(), policy: enabledPolicy(),
    ...grantedRestartLease(), updateAttempts: attempts,
    confirmUpdatedRuntime: async () => ({ status: "verified" })
  });
  assert.equal((await restarted.start()).reason, "update_rolled_back");
  assert.deepEqual(attempts.record, recorded);
  assert.equal(restartAdapter.checks, 0);
  await restarted.check();
  await settle();
  assert.equal(restarted.snapshot().availableVersion, "1.0.2");
  assert.equal((await restarted.installWhenIdle()).status, "installing");
  assert.equal(restartAdapter.installs, 1);
  assert.equal(attempts.record.toVersion, "1.0.2");
  restarted.stop();
});

test("a confirmed release with a failed record clear retains evidence and fences the current process", async () => {
  const attempts = memoryAttempts();
  attempts.clear = async () => false;
  let acquisitions = 0;
  const adapter = createAdapter({ check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }) });
  const controller = createUpdateController({
    adapter, clock: testClock(), policy: enabledPolicy(), updateAttempts: attempts,
    confirmUpdatedRuntime: async () => ({ status: "verified" }),
    acquireRestartLease: async () => { acquisitions += 1; return { status: "granted", leaseId: "failed-clear-lease" }; },
    commitRestartLease: async () => ({ status: "busy" }),
    releaseRestartLease: async () => { assert.notEqual(attempts.record, null); }
  });
  await controller.check();
  await settle();
  assert.equal((await controller.installWhenIdle()).reason, "active_or_uncertain_operations");
  const record = attempts.record;
  await controller.reconcileAfterRepair();
  await controller.check();
  await controller.installWhenIdle();
  assert.equal(acquisitions, 1);
  assert.equal(adapter.checks, 1);
  assert.deepEqual(attempts.record, record);
  controller.stop();
});

test("a hung updater handoff times out but keeps the committed lease and attempt record", async () => {
  const clock = testClock();
  const attempts = memoryAttempts();
  const releases = [];
  const adapter = createAdapter({
    check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }),
    install: () => new Promise(() => {})
  });
  const controller = createUpdateController({
    adapter,
    policy: enabledPolicy(),
    clock,
    updateAttempts: attempts,
    confirmUpdatedRuntime: async () => ({ status: "verified" }),
    acquireRestartLease: async () => ({ status: "granted", leaseId: "committed-lease" }),
    releaseRestartLease: async (leaseId) => { releases.push(leaseId); },
    commitRestartLease: async () => ({ status: "closing" })
  });
  await controller.check();
  await settle();
  const pending = controller.installWhenIdle();
  await settle();
  await settle();
  assert.equal(controller.snapshot().status, "installing");
  clock.fireTimeout(INSTALL_QUIT_TIMEOUT_MS);
  const result = await pending;
  assert.equal(result.status, "installing");
  assert.equal(result.reason, "update_install_failed");
  assert.equal(adapter.installs, 1);
  assert.deepEqual(releases, []);
  assert.notEqual(attempts.record, null);
  controller.stop();
});

test("an unverified runtime after an update blocks with an explicit reason instead of stale status", async () => {
  const record = { schema: ATTEMPT_SCHEMA, fromVersion: "1.0.0", toVersion: "1.0.1", at: ATTEMPT_AT };
  const attempts = memoryAttempts({ ...record });
  const adapter = createAdapter({ currentVersion: "1.0.1" });
  const controller = createUpdateController({
    adapter,
    policy: enabledPolicy(),
    updateAttempts: attempts,
    confirmUpdatedRuntime: async () => ({ status: "unverified" }),
    ...grantedRestartLease(),
    clock: testClock()
  });
  const result = await controller.start();
  assert.equal(result.status, "error");
  assert.equal(result.reason, "update_runtime_unverified");
  assert.equal(result.availableVersion, null);
  assert.deepEqual(attempts.record, record);
  assert.equal(adapter.checks, 0);
  controller.stop();
});

test("the win32 commit path leaves no lock or temporary file behind", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "morrow-update-attempt-win32-commit-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, "State");
  const store = createUpdateAttemptStore({
    stateDirectory,
    trustedRoot: root,
    platform: "win32",
    windowsPrivateAccess: windowsAccessStub().access
  });
  const written = await store.write({ fromVersion: "1.0.0", toVersion: "1.0.1", at: ATTEMPT_AT });
  assert.deepEqual(await store.read(), { status: "valid", record: written, reason: null });
  assert.equal(await store.clear(written), true);
  assert.deepEqual(fs.readdirSync(stateDirectory), []);
});

test("the win32 read path refuses a swapped-in symlink without O_NOFOLLOW", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "morrow-update-attempt-win32-swap-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, "State");
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const file = path.join(stateDirectory, "update-attempt.json");
  const external = path.join(root, "external-attempt.json");
  const record = { schema: ATTEMPT_SCHEMA, fromVersion: "1.0.0", toVersion: "1.0.1", at: ATTEMPT_AT };
  fs.writeFileSync(external, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  try {
    fs.symlinkSync(external, file);
  } catch {
    t.skip("this host forbids symlink creation");
    return;
  }
  const store = createUpdateAttemptStore({
    stateDirectory,
    trustedRoot: root,
    platform: "win32",
    windowsPrivateAccess: windowsAccessStub().access
  });
  // The link is refused before the open, and the post-open size/mtime identity
  // check behind it is what stays valid on Windows, where O_NOFOLLOW cannot.
  assert.deepEqual(await store.read(), { status: "damaged", record: null, reason: "update_attempt_not_private" });
});

test("a write sweeps stale temporary files and keeps fresh, foreign, and non-file entries", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "morrow-update-attempt-sweep-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, "State");
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const file = path.join(stateDirectory, "update-attempt.json");
  const stale = `${file}.tmp-00000000-0000-0000-0000-000000000000`;
  fs.writeFileSync(stale, "partial write from a crashed process");
  const ancient = new Date(Date.now() - STALE_TEMP_SWEEP_MS - 60 * 1000);
  fs.utimesSync(stale, ancient, ancient);
  const fresh = `${file}.tmp-11111111-1111-1111-1111-111111111111`;
  fs.writeFileSync(fresh, "a concurrent writer's file");
  const foreign = path.join(stateDirectory, "notes.txt");
  fs.writeFileSync(foreign, "not this record's temporary file");
  const directory = `${file}.tmp-a-directory`;
  fs.mkdirSync(directory);
  let link = null;
  try {
    link = `${file}.tmp-a-link`;
    fs.symlinkSync(foreign, link);
  } catch {
    link = null;
  }
  const store = createUpdateAttemptStore({ stateDirectory, ...hostStoreOptions(root) });
  const written = await store.write({ fromVersion: "1.0.0", toVersion: "1.0.1", at: ATTEMPT_AT });
  assert.deepEqual(await store.read(), { status: "valid", record: written, reason: null });
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(foreign), true);
  assert.equal(fs.existsSync(directory), true);
  if (link) assert.equal(fs.existsSync(link), true);
});

test("an over-large group-readable record reports the privacy failure before its size", { skip: process.platform === "win32" ? "POSIX modes" : false }, async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "morrow-update-attempt-oversize-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, "State");
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const file = path.join(stateDirectory, "update-attempt.json");
  fs.writeFileSync(file, Buffer.alloc(4 * 1024 + 1, 0x20), { mode: 0o644 });
  const store = createUpdateAttemptStore({ stateDirectory });
  assert.deepEqual(await store.read(), { status: "damaged", record: null, reason: "update_attempt_not_private" });
  fs.chmodSync(file, 0o600);
  assert.deepEqual(await store.read(), { status: "damaged", record: null, reason: "update_attempt_too_large" });
});
