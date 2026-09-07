"use strict";

// This module deliberately has no Electron dependency. The main process owns the
// electron-updater adapter and the fixed, signed release configuration.
// `createUpdateController` itself performs no file access: main injects the
// update attempt store below, which owns exactly one file.

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const SUPPORTED_PLATFORMS = new Set(["darwin", "win32"]);
const UPDATE_EVENTS = Object.freeze([
  "checking-for-update",
  "update-available",
  "update-not-available",
  "update-downloaded",
  "update-cancelled",
  "error"
]);
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MIN_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const MAX_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
// electron-updater downloads the artifact into its cache and stages the install
// from the same volume, so the volume needs room for more than one copy of it.
// This is a bounded headroom check before the download starts, not a
// measurement of the library's exact peak usage.
const REQUIRED_FREE_SPACE_MULTIPLE = 3;
const UPDATE_ATTEMPT_SCHEMA = "morrow.desktop-update-attempt.v1";
const UPDATE_ATTEMPT_FILE = "update-attempt.json";

function plainSnapshot(state) {
  return {
    schema: "morrow.desktop-update.v1",
    status: state.status,
    currentVersion: state.currentVersion,
    availableVersion: state.availableVersion,
    automatic: state.automatic,
    reason: state.reason
  };
}

function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split(".") : [];
  if (prerelease.some((part) => !part || (/^[0-9]+$/.test(part) && part.length > 1 && part.startsWith("0")))) return null;
  return {
    raw: value,
    numeric: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease
  };
}

function compareVersions(left, right) {
  for (let index = 0; index < left.numeric.length; index += 1) {
    if (left.numeric[index] !== right.numeric[index]) return left.numeric[index] > right.numeric[index] ? 1 : -1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^[0-9]+$/.test(a);
    const bNumeric = /^[0-9]+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) > Number(b) ? 1 : -1;
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

function boundedInterval(value) {
  if (!Number.isSafeInteger(value)) return DEFAULT_CHECK_INTERVAL_MS;
  return Math.max(MIN_CHECK_INTERVAL_MS, Math.min(MAX_CHECK_INTERVAL_MS, value));
}

function normalizePolicy(value) {
  const input = value && typeof value === "object" ? value : {};
  const feed = input.feed && typeof input.feed === "object" ? input.feed : null;
  const feedId = feed && typeof feed.id === "string" && /^[A-Za-z0-9._-]{1,160}$/.test(feed.id)
    ? feed.id
    : null;
  return Object.freeze({
    enabled: input.enabled === true,
    automatic: input.enabled === true && input.automatic !== false,
    allowPrerelease: input.allowPrerelease === true,
    feedId,
    checkIntervalMs: boundedInterval(input.checkIntervalMs)
  });
}

function normalizeIdentity(adapter) {
  const identity = adapter && adapter.identity;
  if (!identity || typeof identity !== "object") throw new TypeError("update adapter identity is required");
  const current = parseVersion(identity.currentVersion);
  if (!current) throw new TypeError("update adapter currentVersion must be strict SemVer");
  if (typeof identity.platform !== "string") throw new TypeError("update adapter platform is required");
  if (typeof identity.arch !== "string" || identity.arch.length === 0) throw new TypeError("update adapter arch is required");
  const feedId = typeof identity.feedId === "string" && /^[A-Za-z0-9._-]{1,160}$/.test(identity.feedId)
    ? identity.feedId
    : null;
  return Object.freeze({ currentVersion: current.raw, current, platform: identity.platform, arch: identity.arch, feedId });
}

function updaterErrorReason(error, phase) {
  const code = typeof error?.code === "string" ? error.code.toLowerCase() : "";
  const message = typeof error?.message === "string" ? error.message.toLowerCase() : "";
  if (code.includes("cancel") || message.includes("cancel")) return "download_cancelled";
  if (code.includes("signature") || code.includes("checksum") || code.includes("integrity")
    || message.includes("signature") || message.includes("checksum") || message.includes("sha512")
    || message.includes("integrity") || message.includes("code sign")) return "update_verification_failed";
  // A full volume is a specific, recoverable cause with its own message, so it
  // does not become the generic download failure.
  if (code.includes("enospc") || message.includes("enospc") || message.includes("no space left")) return "disk_space_unavailable";
  if (phase === "checking") return "update_check_failed";
  if (phase === "downloading") return "update_download_failed";
  return "update_install_failed";
}

/**
 * The largest artifact size the updater reported for a candidate, or `null`
 * when it reported none. The largest of the reported files bounds the space the
 * download needs; a feed that omits sizes yields no bound at all.
 */
function candidateBytes(info) {
  const sizes = [];
  const files = Array.isArray(info.files) ? info.files : [];
  for (const file of [...files, info]) {
    if (file && typeof file === "object" && Number.isSafeInteger(file.size) && file.size > 0) sizes.push(file.size);
  }
  return sizes.length > 0 ? Math.max(...sizes) : null;
}

function candidateFrom(value) {
  if (!value || typeof value !== "object") return null;
  const info = value.updateInfo && typeof value.updateInfo === "object" ? value.updateInfo : value;
  return {
    version: typeof info.version === "string" ? info.version : null,
    platform: typeof info.platform === "string" ? info.platform : null,
    arch: typeof info.arch === "string" ? info.arch : null,
    size: candidateBytes(info)
  };
}

/**
 * The record Morrow writes before it hands a verified update to the updater and
 * reads on the next start. A record that does not parse, that names the same
 * version twice, or that carries no usable timestamp describes no attempt this
 * app can act on, so it is refused instead of guessed.
 */
function updateAttemptRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.schema !== UPDATE_ATTEMPT_SCHEMA) return null;
  const from = parseVersion(value.fromVersion);
  const to = parseVersion(value.toVersion);
  if (!from || !to || from.raw === to.raw) return null;
  if (typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at))) return null;
  return Object.freeze({ schema: UPDATE_ATTEMPT_SCHEMA, fromVersion: from.raw, toVersion: to.raw, at: value.at });
}

/**
 * The one file this contract owns: `State/update-attempt.json`. It records the
 * version Morrow was running and the version it handed to the updater, so the
 * next start can tell a completed update from a new version that never started.
 * It holds no user data and no updater path.
 */
function createUpdateAttemptStore({ stateDirectory } = {}) {
  if (typeof stateDirectory !== "string" || !path.isAbsolute(stateDirectory)) {
    throw new TypeError("update attempt stateDirectory must be an absolute path");
  }
  const file = path.join(stateDirectory, UPDATE_ATTEMPT_FILE);
  return Object.freeze({
    async read() {
      let parsed;
      try { parsed = JSON.parse(await fs.readFile(file, "utf8")); }
      catch { return null; }
      return updateAttemptRecord(parsed);
    },
    async write(attempt) {
      const record = updateAttemptRecord({ ...attempt, schema: UPDATE_ATTEMPT_SCHEMA });
      if (!record) throw new TypeError("update attempt record is invalid");
      await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.tmp-${crypto.randomUUID()}`;
      await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, file);
      if (process.platform !== "win32") await fs.chmod(file, 0o600);
      return record;
    },
    async clear() {
      await fs.rm(file, { force: true });
    }
  });
}

function normalizeAttemptStore(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || typeof value.read !== "function"
    || typeof value.write !== "function" || typeof value.clear !== "function") {
    throw new TypeError("update attempt store is incomplete");
  }
  return value;
}

function createUpdateController({
  adapter,
  policy,
  acquireRestartLease,
  releaseRestartLease,
  commitRestartLease,
  updateAttempts,
  confirmUpdatedRuntime,
  clock
} = {}) {
  if (!adapter || typeof adapter !== "object") throw new TypeError("update adapter is required");
  if (typeof adapter.checkForUpdates !== "function" || typeof adapter.downloadUpdate !== "function"
    || typeof adapter.quitAndInstall !== "function" || typeof adapter.on !== "function") {
    throw new TypeError("update adapter is incomplete");
  }
  if (typeof acquireRestartLease !== "function") throw new TypeError("acquireRestartLease is required");
  if (typeof releaseRestartLease !== "function") throw new TypeError("releaseRestartLease is required");
  if (typeof commitRestartLease !== "function") throw new TypeError("commitRestartLease is required");

  const identity = normalizeIdentity(adapter);
  const settings = normalizePolicy(policy);
  const attempts = normalizeAttemptStore(updateAttempts);
  if (attempts && typeof confirmUpdatedRuntime !== "function") {
    throw new TypeError("confirmUpdatedRuntime is required with an update attempt store");
  }
  const timers = clock && typeof clock === "object" ? clock : globalThis;
  const state = {
    status: "unavailable",
    currentVersion: identity.currentVersion,
    availableVersion: null,
    automatic: settings.automatic,
    reason: null
  };
  const subscribers = new Set();
  const unlisteners = [];
  let started = false;
  let interval = null;
  let checkPromise = null;
  let downloadPromise = null;
  let installPromise = null;
  // The size the updater reported for the candidate now in `available`. Only
  // `acceptCandidate` reaches that status, and only `download` reads this.
  let acceptedBytes = null;
  let attemptReconciled = false;
  // A recorded update that did not start blocks automatic checking, so Morrow
  // reports what happened and waits for the person to ask for the retry instead
  // of downloading the same version again on its own.
  let automaticCheckBlocked = false;

  function publish() {
    const snapshot = plainSnapshot(state);
    for (const listener of subscribers) {
      try { listener(snapshot); } catch { /* UI listeners are not trusted update control flow. */ }
    }
    return snapshot;
  }

  function transition(status, availableVersion, reason) {
    state.status = status;
    state.availableVersion = availableVersion;
    state.reason = reason;
    return publish();
  }

  function admissionReason() {
    if (!settings.enabled) return "updates_disabled";
    if (!SUPPORTED_PLATFORMS.has(identity.platform)) return "unsupported_platform";
    if (!settings.feedId || !identity.feedId || settings.feedId !== identity.feedId) return "owned_feed_unavailable";
    return null;
  }

  function setUnavailableIfNeeded() {
    const reason = admissionReason();
    if (reason) transition("unavailable", null, reason);
    return reason;
  }

  function candidateReason(candidate) {
    const next = parseVersion(candidate?.version);
    if (!next) return "update_version_invalid";
    if (candidate.platform && candidate.platform !== identity.platform) return "update_platform_mismatch";
    if (candidate.arch && candidate.arch !== identity.arch) return "update_arch_mismatch";
    if (!settings.allowPrerelease && identity.current.prerelease.length === 0 && next.prerelease.length > 0) {
      return "update_prerelease_unavailable";
    }
    if (compareVersions(next, identity.current) <= 0) return "update_version_not_newer";
    return null;
  }

  function acceptCandidate(value) {
    if (setUnavailableIfNeeded()) return false;
    if (state.status === "ready") return true;
    const candidate = candidateFrom(value);
    const reason = candidateReason(candidate);
    if (reason) {
      transition("error", null, reason);
      return false;
    }
    acceptedBytes = candidate.size;
    transition("available", candidate.version, null);
    return true;
  }

  /**
   * Whether the updater cache volume has room for this candidate. An updater
   * that reports no size, and a computer that does not report its free space,
   * both leave this unmeasured; the download proceeds and a full volume is then
   * reported by its `ENOSPC` failure instead.
   */
  async function freeSpaceAdmits() {
    if (acceptedBytes === null || typeof adapter.freeCacheBytes !== "function") return true;
    let free = null;
    try { free = await adapter.freeCacheBytes(); }
    catch { return true; }
    if (!Number.isSafeInteger(free) || free < 0) return true;
    return free >= acceptedBytes * REQUIRED_FREE_SPACE_MULTIPLE;
  }

  function handleError(error, phase) {
    const reason = updaterErrorReason(error, phase);
    if (reason === "download_cancelled") {
      transition("available", state.availableVersion, reason);
      return;
    }
    if (phase === "installing" && state.availableVersion) {
      transition("ready", state.availableVersion, reason);
      return;
    }
    transition("error", null, reason);
  }

  function bindEvents() {
    if (started) return;
    started = true;
    const handlers = {
      "checking-for-update": () => {
        if (!admissionReason() && state.status !== "ready") transition("checking", null, null);
      },
      "update-available": (info) => acceptCandidate(info),
      "update-not-available": () => {
        if (!setUnavailableIfNeeded() && state.status !== "ready") transition("idle", null, "up_to_date");
      },
      "update-downloaded": (info) => {
        if (setUnavailableIfNeeded()) return;
        if (state.status === "ready") return;
        const candidate = candidateFrom(info);
        const version = candidate?.version || state.availableVersion;
        if (!version || candidateReason({ version, platform: candidate?.platform || null, arch: candidate?.arch || null })) {
          transition("error", null, "update_version_invalid");
          return;
        }
        transition("ready", version, null);
      },
      "update-cancelled": () => {
        if (!setUnavailableIfNeeded() && state.status !== "ready") transition("available", state.availableVersion, "download_cancelled");
      },
      error: (error) => {
        if (!setUnavailableIfNeeded() && state.status !== "ready") handleError(error, state.status);
      }
    };
    for (const event of UPDATE_EVENTS) {
      const unsubscribe = adapter.on(event, handlers[event]);
      if (typeof unsubscribe === "function") unlisteners.push(unsubscribe);
    }
  }

  async function check() {
    bindEvents();
    if (setUnavailableIfNeeded()) return plainSnapshot(state);
    // An explicit check is the person asking to try the update again, so it
    // lifts the block a failed launch put on automatic checking.
    automaticCheckBlocked = false;
    if (state.status === "ready") return plainSnapshot(state);
    if (checkPromise || downloadPromise || installPromise) return checkPromise || downloadPromise || installPromise;
    transition("checking", null, null);
    const pending = Promise.resolve()
      .then(() => adapter.checkForUpdates())
      .then((result) => {
        const candidate = candidateFrom(result);
        if (result && result.isUpdateAvailable === false) {
          if (state.status === "checking") transition("idle", null, "up_to_date");
        } else if (candidate?.version) {
          if (state.status === "checking") acceptCandidate(candidate);
        } else if (state.status === "checking") {
          transition("idle", null, "up_to_date");
        }
        // electron-updater emits update-available before checkForUpdates resolves
        // with its CancellationToken. Start an automatic download only after the
        // adapter has received that result, so a cancellation applies to this
        // exact discovery/download pair.
        if (settings.automatic && state.status === "available" && state.availableVersion) void download();
        return plainSnapshot(state);
      })
      .catch((error) => {
        handleError(error, "checking");
        return plainSnapshot(state);
      })
      .finally(() => { if (checkPromise === pending) checkPromise = null; });
    checkPromise = pending;
    return pending;
  }

  async function download() {
    if (setUnavailableIfNeeded()) return plainSnapshot(state);
    if (downloadPromise || installPromise) return downloadPromise || installPromise;
    if (state.status !== "available" || !state.availableVersion) return plainSnapshot(state);
    const version = state.availableVersion;
    const pending = Promise.resolve()
      .then(() => freeSpaceAdmits())
      .then((admitted) => {
        if (!admitted) return transition("error", null, "disk_space_unavailable");
        transition("downloading", version, null);
        return Promise.resolve().then(() => adapter.downloadUpdate()).then(() => {
          if (state.status === "downloading") transition("ready", version, null);
          return plainSnapshot(state);
        });
      })
      .catch((error) => {
        handleError(error, "downloading");
        return plainSnapshot(state);
      })
      .finally(() => { if (downloadPromise === pending) downloadPromise = null; });
    downloadPromise = pending;
    return pending;
  }

  /**
   * Resolves the recorded install attempt from the last run, once per process.
   *
   * The running version equal to the version the updater installed is the only
   * case that can complete the update, and it completes only when the runtime
   * check main supplies proves the sealed payload and a gateway that answered.
   * An unproven runtime keeps the record: the runtime status Morrow already
   * reports is the state that asks for a repair, and this controller never
   * reports the update finished without that proof. The running version equal
   * to the version Morrow started from means the new version did not start.
   * A record naming neither version cannot describe this installation, so it is
   * removed instead of guessed.
   */
  async function reconcileAttempt() {
    if (attemptReconciled || !attempts) return;
    attemptReconciled = true;
    let record = null;
    try { record = await attempts.read(); }
    catch { return; }
    if (!record) return;
    if (record.toVersion === identity.currentVersion) {
      let confirmation = null;
      try { confirmation = await confirmUpdatedRuntime(); }
      catch { confirmation = null; }
      if (confirmation?.status !== "verified") return;
      try { await attempts.clear(); }
      catch { return; }
      transition("idle", null, "update_complete");
      return;
    }
    if (record.fromVersion === identity.currentVersion) {
      automaticCheckBlocked = true;
      transition("error", null, "update_rolled_back");
      return;
    }
    await attempts.clear().catch(() => { /* The next start reads it again. */ });
  }

  async function start() {
    bindEvents();
    if (setUnavailableIfNeeded()) return plainSnapshot(state);
    await reconcileAttempt();
    if (automaticCheckBlocked) return plainSnapshot(state);
    if (interval === null && typeof timers.setInterval === "function") {
      interval = timers.setInterval(() => { void check(); }, settings.checkIntervalMs);
      if (interval && typeof interval.unref === "function") interval.unref();
    }
    return check();
  }

  function deferredInstall(version) {
    return transition("ready", version, "active_or_uncertain_operations");
  }

  async function recordAttempt(version) {
    if (!attempts) return true;
    try {
      await attempts.write({ fromVersion: identity.currentVersion, toVersion: version, at: new Date().toISOString() });
      return true;
    } catch {
      return false;
    }
  }

  function isGrantedRestartLease(value) {
    return Boolean(value && typeof value === "object"
      && value.status === "granted"
      && typeof value.leaseId === "string"
      && value.leaseId.length > 0);
  }

  function isCommittedRestartLease(value) {
    return Boolean(value && typeof value === "object"
      && Object.keys(value).length === 1
      && value.status === "closing");
  }

  function releaseFailedCommit(leaseId, version) {
    return Promise.resolve()
      .then(() => releaseRestartLease(leaseId))
      .then(() => transition("ready", version, "update_install_failed"))
      .catch(() => deferredInstall(version));
  }

  function installWhenIdle() {
    bindEvents();
    if (setUnavailableIfNeeded()) return plainSnapshot(state);
    if (installPromise) return installPromise;
    if (state.status !== "ready" || !state.availableVersion) return plainSnapshot(state);
    const version = state.availableVersion;
    // Assign the shared promise before any lease request. A second renderer
    // click must join this attempt instead of obtaining a second lease.
    const pending = Promise.resolve()
      .then(() => acquireRestartLease())
      .then((lease) => {
        if (!isGrantedRestartLease(lease)) return deferredInstall(version);
        return Promise.resolve()
          .then(() => commitRestartLease(lease.leaseId))
          .then((committed) => {
            if (!isCommittedRestartLease(committed)) return releaseFailedCommit(lease.leaseId, version);
            transition("installing", version, null);
            return Promise.resolve()
              .then(() => recordAttempt(version))
              .then((recorded) => {
                // Without the record a new version that never starts cannot be
                // told apart from an ordinary start, so Morrow keeps the
                // verified update instead of handing it over unrecorded.
                if (!recorded) return deferredInstall(version);
                return Promise.resolve()
                  .then(() => adapter.quitAndInstall())
                  // A closing owner can no longer resume ordinary work. Keep its
                  // lease through process exit, even when the updater call fails.
                  .then(() => plainSnapshot(state))
                  .catch(() => deferredInstall(version));
              });
          }, () => releaseFailedCommit(lease.leaseId, version));
      })
      .catch(() => deferredInstall(version))
      .finally(() => { if (installPromise === pending) installPromise = null; });
    installPromise = pending;
    return pending;
  }

  function snapshot() {
    return plainSnapshot(state);
  }

  function subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("update subscriber must be a function");
    subscribers.add(listener);
    listener(snapshot());
    return () => subscribers.delete(listener);
  }

  function stop() {
    if (interval !== null && typeof timers.clearInterval === "function") timers.clearInterval(interval);
    interval = null;
    while (unlisteners.length > 0) {
      try { unlisteners.pop()(); } catch { /* Adapter cleanup cannot change app state. */ }
    }
    started = false;
  }

  setUnavailableIfNeeded();
  return Object.freeze({ snapshot, start, check, installWhenIdle, subscribe, stop });
}

module.exports = {
  DEFAULT_CHECK_INTERVAL_MS,
  UPDATE_ATTEMPT_FILE,
  UPDATE_EVENTS,
  compareVersions,
  createUpdateAttemptStore,
  createUpdateController,
  parseVersion
};
