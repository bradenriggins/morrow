"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createElectronUpdaterAdapter } = require("../shared/electron-updater-adapter.cjs");

const CACHE_DIRECTORY = os.tmpdir();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

function updater() {
  const listeners = new Map();
  return {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    allowDowngrade: true,
    disableWebInstaller: false,
    checks: 0,
    downloads: 0,
    downloadTokens: [],
    installs: [],
    on(event, listener) {
      const values = listeners.get(event) || new Set();
      values.add(listener);
      listeners.set(event, values);
    },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); },
    emit(event, value) {
      for (const listener of listeners.get(event) || []) listener(value);
    },
    async checkForUpdates() { this.checks += 1; return { isUpdateAvailable: false, cancellationToken: { value: "current-check" } }; },
    async downloadUpdate(token) { this.downloads += 1; this.downloadTokens.push(token); return []; },
    quitAndInstall(...argumentsValue) { this.installs.push(argumentsValue); }
  };
}

test("electron-updater adapter fixes updater behavior and does not set an arbitrary feed URL", async () => {
  const source = updater();
  const adapter = createElectronUpdaterAdapter({
    updater: source,
    currentVersion: "1.0.0",
    platform: "darwin",
    arch: "arm64",
    feedId: "morrow-github-stable",
    cacheDirectory: CACHE_DIRECTORY
  });
  assert.deepEqual(adapter.identity, { currentVersion: "1.0.0", platform: "darwin", arch: "arm64", feedId: "morrow-github-stable" });
  assert.equal(source.autoDownload, false);
  assert.equal(source.autoInstallOnAppQuit, false);
  assert.equal(source.allowPrerelease, false);
  assert.equal(source.allowDowngrade, false);
  assert.equal(source.disableWebInstaller, true);
  await adapter.checkForUpdates();
  await adapter.downloadUpdate();
  await adapter.quitAndInstall();
  assert.equal(source.checks, 1);
  assert.equal(source.downloads, 1);
  assert.deepEqual(source.downloadTokens, [{ value: "current-check" }]);
  assert.deepEqual(source.installs, [[false, true]]);
});

test("electron-updater adapter refuses invalid builds, unsupported platforms and architectures, and incomplete updater objects", () => {
  const build = { currentVersion: "1.0.0", platform: "darwin", arch: "arm64", feedId: "morrow-github-stable", cacheDirectory: CACHE_DIRECTORY };
  assert.throws(() => createElectronUpdaterAdapter({ ...build, updater: updater(), currentVersion: "1.0" }), /strict SemVer/);
  assert.throws(() => createElectronUpdaterAdapter({ ...build, updater: updater(), platform: "linux" }), /platform/);
  assert.throws(() => createElectronUpdaterAdapter({ ...build, updater: updater(), arch: "ppc64" }), /arch/);
  assert.throws(() => createElectronUpdaterAdapter({ ...build, updater: updater(), arch: undefined }), /arch/);
  assert.throws(() => createElectronUpdaterAdapter({ ...build, updater: updater(), cacheDirectory: "relative/cache" }), /cacheDirectory/);
  assert.throws(() => createElectronUpdaterAdapter({ ...build, updater: {} }), /required update operations/);
});

test("the adapter reports the free space on the updater cache volume and reports nothing when it cannot measure it", async () => {
  const measured = createElectronUpdaterAdapter({
    updater: updater(),
    currentVersion: "1.0.0",
    platform: "darwin",
    arch: "arm64",
    feedId: "morrow-github-stable",
    cacheDirectory: CACHE_DIRECTORY
  });
  const free = await measured.freeCacheBytes();
  assert.equal(Number.isSafeInteger(free), true);
  assert.equal(free > 0, true);

  const missing = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "morrow-updater-cache-")), "absent");
  const unmeasured = createElectronUpdaterAdapter({
    updater: updater(),
    currentVersion: "1.0.0",
    platform: "darwin",
    arch: "arm64",
    feedId: "morrow-github-stable",
    cacheDirectory: missing
  });
  assert.equal(await unmeasured.freeCacheBytes(), null);
});

test("the adapter publishes a downloaded event only after the matching updater promise succeeds", async () => {
  const source = updater();
  const completed = deferred();
  source.checkForUpdates = async () => ({
    isUpdateAvailable: true,
    updateInfo: { version: "1.0.1", platform: "darwin", arch: "arm64" },
    cancellationToken: { cancel() {} }
  });
  source.downloadUpdate = async () => {
    source.emit("update-downloaded", { version: "1.0.1", platform: "darwin", arch: "arm64" });
    await completed.promise;
    return ["private-updater-cache"];
  };
  const adapter = createElectronUpdaterAdapter({
    updater: source,
    currentVersion: "1.0.0",
    platform: "darwin",
    arch: "arm64",
    feedId: "morrow-github-stable",
    cacheDirectory: CACHE_DIRECTORY
  });
  const events = [];
  adapter.on("update-downloaded", (event) => events.push(event));
  await adapter.checkForUpdates();
  const pending = adapter.downloadUpdate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, []);
  completed.resolve();
  await pending;
  assert.deepEqual(events, [{ version: "1.0.1", platform: "darwin", arch: "arm64" }]);
});

test("the adapter discards premature download evidence when staging fails or is cancelled", async (t) => {
  await t.test("failure", async () => {
    const source = updater();
    source.checkForUpdates = async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: "1.0.1" },
      cancellationToken: { cancel() {} }
    });
    source.downloadUpdate = async () => {
      source.emit("update-downloaded", { version: "1.0.1" });
      throw new Error("cache finalization failed");
    };
    const adapter = createElectronUpdaterAdapter({
      updater: source,
      currentVersion: "1.0.0",
      platform: "darwin",
      arch: "arm64",
      feedId: "morrow-github-stable",
      cacheDirectory: CACHE_DIRECTORY
    });
    const events = [];
    adapter.on("update-downloaded", (event) => events.push(event));
    await adapter.checkForUpdates();
    await assert.rejects(() => adapter.downloadUpdate(), /cache finalization failed/);
    assert.deepEqual(events, []);
  });

  await t.test("cancellation", async () => {
    const source = updater();
    const completed = deferred();
    let cancellations = 0;
    source.checkForUpdates = async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: "1.0.1" },
      cancellationToken: { cancel() { cancellations += 1; } }
    });
    source.downloadUpdate = async () => {
      source.emit("update-downloaded", { version: "1.0.1" });
      await completed.promise;
      return ["private-updater-cache"];
    };
    const adapter = createElectronUpdaterAdapter({
      updater: source,
      currentVersion: "1.0.0",
      platform: "darwin",
      arch: "arm64",
      feedId: "morrow-github-stable",
      cacheDirectory: CACHE_DIRECTORY
    });
    const events = [];
    adapter.on("update-downloaded", (event) => events.push(event));
    await adapter.checkForUpdates();
    const pending = adapter.downloadUpdate();
    await new Promise((resolve) => setImmediate(resolve));
    adapter.cancelUpdate();
    assert.equal(cancellations, 1);
    completed.resolve();
    await pending;
    assert.deepEqual(events, []);
  });
});

test("the adapter cancels a token returned after cancellation and never gives it to a later download", async () => {
  const source = updater();
  const firstCheck = deferred();
  let checks = 0;
  let lateCancellations = 0;
  const currentToken = { value: "current-check", cancel() {} };
  source.checkForUpdates = async () => {
    checks += 1;
    return checks === 1
      ? firstCheck.promise
      : { isUpdateAvailable: true, updateInfo: { version: "1.0.2" }, cancellationToken: currentToken };
  };
  const adapter = createElectronUpdaterAdapter({
    updater: source,
    currentVersion: "1.0.0",
    platform: "darwin",
    arch: "arm64",
    feedId: "morrow-github-stable",
    cacheDirectory: CACHE_DIRECTORY
  });

  const late = adapter.checkForUpdates();
  await new Promise((resolve) => setImmediate(resolve));
  adapter.cancelUpdate();
  adapter.cancelUpdate();
  firstCheck.resolve({
    isUpdateAvailable: true,
    updateInfo: { version: "1.0.1" },
    cancellationToken: { cancel() { lateCancellations += 1; } }
  });
  await late;
  assert.equal(lateCancellations, 1);

  await adapter.checkForUpdates();
  await adapter.downloadUpdate();
  assert.deepEqual(source.downloadTokens, [currentToken]);
});

test("the adapter quarantines updater events after abandoning an operation", async () => {
  const source = updater();
  const firstDownload = deferred();
  const secondDownload = deferred();
  let check = 0;
  let firstTokenCancellations = 0;
  source.checkForUpdates = async () => {
    check += 1;
    return {
      isUpdateAvailable: true,
      updateInfo: { version: check === 1 ? "1.0.1" : "1.0.2" },
      cancellationToken: check === 1
        ? { cancel() { firstTokenCancellations += 1; } }
        : { cancel() {} }
    };
  };
  source.downloadUpdate = async () => source.downloads++ === 0 ? firstDownload.promise : secondDownload.promise;
  const adapter = createElectronUpdaterAdapter({
    updater: source,
    currentVersion: "1.0.0",
    platform: "darwin",
    arch: "arm64",
    feedId: "morrow-github-stable",
    cacheDirectory: CACHE_DIRECTORY
  });
  const downloaded = [];
  const errors = [];
  adapter.on("update-downloaded", (event) => downloaded.push(event));
  adapter.on("error", (error) => errors.push(error));

  await adapter.checkForUpdates();
  const abandoned = adapter.downloadUpdate();
  await new Promise((resolve) => setImmediate(resolve));
  adapter.cancelUpdate();
  adapter.cancelUpdate();
  assert.equal(firstTokenCancellations, 1);

  await adapter.checkForUpdates();
  const current = adapter.downloadUpdate();
  source.emit("update-downloaded", { version: "1.0.1" });
  source.emit("error", new Error("late abandoned error"));
  firstDownload.resolve(["late-private-updater-cache"]);
  await abandoned;
  source.emit("update-downloaded", { version: "1.0.2" });
  secondDownload.resolve(["current-private-updater-cache"]);
  await current;
  assert.deepEqual(downloaded, [{ version: "1.0.2" }]);
  assert.deepEqual(errors, []);
});
