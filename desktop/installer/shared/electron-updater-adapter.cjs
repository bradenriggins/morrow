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
  let checkedUpdateInfo = null;
  let operationGeneration = 0;
  let activeDownload = null;
  let revokedInFlightOperations = 0;
  const inFlightOperations = new Set();
  const downloadedListeners = new Set();

  function beginOperation() {
    const operation = { revoked: false };
    inFlightOperations.add(operation);
    return operation;
  }

  function finishOperation(operation) {
    inFlightOperations.delete(operation);
    if (operation.revoked) revokedInFlightOperations -= 1;
  }

  function revokeInFlightOperations() {
    for (const operation of inFlightOperations) {
      if (operation.revoked) continue;
      operation.revoked = true;
      revokedInFlightOperations += 1;
    }
    inFlightOperations.clear();
  }

  function sameDownloadedCandidate(event, info) {
    if (!event || typeof event !== "object" || !info || typeof info !== "object") return false;
    if (event.version !== info.version) return false;
    if (typeof event.platform === "string" && typeof info.platform === "string" && event.platform !== info.platform) return false;
    if (typeof event.arch === "string" && typeof info.arch === "string" && event.arch !== info.arch) return false;
    return true;
  }

  // electron-updater emits this event before its download promise finishes all
  // staging work. Capture it here and publish it only after that promise has
  // succeeded for the same controller-owned download generation.
  const captureDownloaded = (event) => {
    if (revokedInFlightOperations > 0 || activeDownload === null) return;
    if (activeDownload.pendingDownloadedEvent !== null) activeDownload.downloadedEventInvalid = true;
    else activeDownload.pendingDownloadedEvent = event;
  };
  updater.on("update-downloaded", captureDownloaded);

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
      const generation = ++operationGeneration;
      const operation = beginOperation();
      cancellationToken = null;
      checkedUpdateInfo = null;
      try {
        const result = await updater.checkForUpdates();
        const token = result?.cancellationToken || null;
        if (generation !== operationGeneration || operation.revoked) {
          if (typeof token?.cancel === "function") token.cancel();
          return result;
        }
        cancellationToken = token;
        checkedUpdateInfo = result?.updateInfo && typeof result.updateInfo === "object" ? result.updateInfo : null;
        return result;
      } finally {
        finishOperation(operation);
      }
    },
    async downloadUpdate() {
      const token = cancellationToken;
      const info = checkedUpdateInfo;
      const generation = operationGeneration;
      const operation = beginOperation();
      const download = {
        pendingDownloadedEvent: null,
        downloadedEventInvalid: false
      };
      activeDownload = download;
      try {
        const downloaded = await updater.downloadUpdate(token || undefined);
        if (generation !== operationGeneration || operation.revoked || activeDownload !== download) return downloaded;
        if (download.downloadedEventInvalid
          || (download.pendingDownloadedEvent !== null && !sameDownloadedCandidate(download.pendingDownloadedEvent, info))) {
          const error = new Error("electron updater download generation changed");
          error.code = "ERR_UPDATER_GENERATION_MISMATCH";
          throw error;
        }
        if (download.pendingDownloadedEvent !== null) {
          for (const listener of downloadedListeners) listener(download.pendingDownloadedEvent);
        }
        return downloaded;
      } finally {
        if (activeDownload === download) activeDownload = null;
        if (cancellationToken === token) cancellationToken = null;
        finishOperation(operation);
      }
    },
    cancelUpdate() {
      operationGeneration += 1;
      const token = cancellationToken;
      cancellationToken = null;
      checkedUpdateInfo = null;
      revokeInFlightOperations();
      activeDownload = null;
      if (typeof token?.cancel === "function") token.cancel();
    },
    quitAndInstall: () => updater.quitAndInstall(false, true),
    on(event, listener) {
      if (event === "update-downloaded") {
        downloadedListeners.add(listener);
        return () => downloadedListeners.delete(listener);
      }
      const guardedListener = (...argumentsValue) => {
        if (revokedInFlightOperations === 0) listener(...argumentsValue);
      };
      updater.on(event, guardedListener);
      return () => updater.removeListener(event, guardedListener);
    }
  });
}

module.exports = { createElectronUpdaterAdapter };
