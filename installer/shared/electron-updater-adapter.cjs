"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

// The desktop app is built for these two architectures only. Binding the
// running one lets the controller refuse a candidate that names a different
// architecture before any download starts.
const SUPPORTED_ARCHITECTURES = new Set(["arm64", "x64"]);

function strictVersion(value) {
  return typeof value === "string" && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value);
}

function createElectronUpdaterAdapter({ updater, currentVersion, platform, arch, feedId, cacheDirectory } = {}) {
  if (!updater || typeof updater !== "object") throw new TypeError("electron updater is required");
  if (typeof updater.checkForUpdates !== "function" || typeof updater.downloadUpdate !== "function"
    || typeof updater.quitAndInstall !== "function" || typeof updater.on !== "function"
    || typeof updater.removeListener !== "function") {
    throw new TypeError("electron updater does not expose the required update operations");
  }
  if (!strictVersion(currentVersion)) throw new TypeError("currentVersion must be strict SemVer");
  if (platform !== "darwin" && platform !== "win32") throw new TypeError("platform must support desktop updates");
  if (!SUPPORTED_ARCHITECTURES.has(arch)) throw new TypeError("arch must support desktop updates");
  if (typeof feedId !== "string" || !/^[A-Za-z0-9._-]{1,160}$/.test(feedId)) throw new TypeError("feedId is invalid");
  if (typeof cacheDirectory !== "string" || !path.isAbsolute(cacheDirectory)) throw new TypeError("cacheDirectory must be an absolute path");

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.disableWebInstaller = true;

  let cancellationToken = null;

  return Object.freeze({
    identity: Object.freeze({ currentVersion, platform, arch, feedId }),
    /**
     * Free bytes on the volume that holds the electron-updater download cache,
     * or `null` when this computer does not report them. `electron-updater`
     * places that cache under the operating system cache directory, so the
     * volume this reports is the volume it downloads and stages into. A `null`
     * answer means Morrow could not measure the space, not that space is
     * available.
     */
    async freeCacheBytes() {
      try {
        const volume = await fs.statfs(cacheDirectory);
        const free = Number(volume?.bsize) * Number(volume?.bavail);
        return Number.isSafeInteger(free) && free >= 0 ? free : null;
      } catch {
        return null;
      }
    },
    async checkForUpdates() {
      cancellationToken = null;
      const result = await updater.checkForUpdates();
      cancellationToken = result?.cancellationToken || null;
      return result;
    },
    async downloadUpdate() {
      const token = cancellationToken;
      cancellationToken = null;
      return updater.downloadUpdate(token || undefined);
    },
    quitAndInstall: () => updater.quitAndInstall(false, true),
    on(event, listener) {
      updater.on(event, listener);
      return () => updater.removeListener(event, listener);
    }
  });
}

module.exports = { createElectronUpdaterAdapter };
