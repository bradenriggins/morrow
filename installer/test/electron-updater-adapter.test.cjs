"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createElectronUpdaterAdapter } = require("../shared/electron-updater-adapter.cjs");

const CACHE_DIRECTORY = os.tmpdir();

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
