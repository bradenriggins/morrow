"use strict";

// This module deliberately has no Electron dependency. The main process owns the
// electron-updater adapter and the fixed, signed release configuration.
// `createUpdateController` itself performs no file access: main injects the
// update attempt store below, which owns exactly one file.

const crypto = require("node:crypto");
const { constants: fsConstants } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { parseStrictJson } = require("./strict-utf8.cjs");

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
const UPDATE_CHECK_TIMEOUT_MS = 2 * 60 * 1000;
const UPDATE_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
// electron-updater downloads the artifact into its cache and stages the install
// from the same volume, so the volume needs room for more than one copy of it.
// This is a bounded headroom check before the download starts, not a
// measurement of the library's exact peak usage.
const REQUIRED_FREE_SPACE_MULTIPLE = 3;
const UPDATE_ATTEMPT_SCHEMA = "morrow.desktop-update-attempt.v1";
const UPDATE_ATTEMPT_FILE = "update-attempt.json";
const MAX_UPDATE_ATTEMPT_BYTES = 4 * 1024;

function plainSnapshot(state) {
  return {
    schema: "morrow.desktop-update.v1",
    revision: state.revision,
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
  if (code === "err_update_check_timeout") return "update_check_timeout";
  if (code === "err_update_download_timeout") return "update_download_timeout";
  if (code.includes("cancel") || message.includes("cancel")) return "download_cancelled";
  if (code.includes("generation") || message.includes("generation changed")) return "update_generation_mismatch";
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

function sameUpdateAttempt(left, right) {
  return Boolean(left && right
    && left.schema === right.schema
    && left.fromVersion === right.fromVersion
    && left.toVersion === right.toVersion
    && left.at === right.at);
}

function attemptState(status, record = null, reason = null) {
  return Object.freeze({ status, record, reason });
}

function privateStateEntry(info, kind) {
  if (!info || (kind === "directory" ? !info.isDirectory() : !info.isFile()) || info.isSymbolicLink()) return false;
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) return false;
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) return false;
  return true;
}

async function privateStateDirectory(stateDirectory) {
  let info;
  try { info = await fs.lstat(stateDirectory); }
  catch (error) {
    return error?.code === "ENOENT"
      ? attemptState("absent")
      : attemptState("damaged", null, "update_attempt_state_unreadable");
  }
  return privateStateEntry(info, "directory")
    ? attemptState("valid")
    : attemptState("damaged", null, "update_attempt_state_not_private");
}

async function ensurePrivateStateDirectory(stateDirectory) {
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(stateDirectory);
  if (!info.isDirectory() || info.isSymbolicLink()
    || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
    throw new Error("update attempt state directory is invalid");
  }
  if (process.platform !== "win32") {
    await fs.chmod(stateDirectory, 0o700);
    if (!privateStateEntry(await fs.lstat(stateDirectory), "directory")) {
      throw new Error("update attempt state directory is not private");
    }
  }
}

async function boundedFileBytes(handle) {
  const output = Buffer.alloc(MAX_UPDATE_ATTEMPT_BYTES + 1);
  let offset = 0;
  while (offset < output.byteLength) {
    const { bytesRead } = await handle.read(output, offset, output.byteLength - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset > MAX_UPDATE_ATTEMPT_BYTES ? null : output.subarray(0, offset);
}

async function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
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
  async function read() {
    const directory = await privateStateDirectory(stateDirectory);
    if (directory.status !== "valid") return directory;
    let linkInfo;
    try { linkInfo = await fs.lstat(file); }
    catch (error) {
      return error?.code === "ENOENT"
        ? attemptState("absent")
        : attemptState("damaged", null, "update_attempt_unreadable");
    }
    if (!privateStateEntry(linkInfo, "file") || linkInfo.size > MAX_UPDATE_ATTEMPT_BYTES) {
      return attemptState("damaged", null, linkInfo.size > MAX_UPDATE_ATTEMPT_BYTES ? "update_attempt_too_large" : "update_attempt_not_private");
    }
    let handle = null;
    try {
      const flags = fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW || 0);
      handle = await fs.open(file, flags);
      const openedInfo = await handle.stat();
      if (!privateStateEntry(openedInfo, "file")
        || openedInfo.dev !== linkInfo.dev || openedInfo.ino !== linkInfo.ino
        || openedInfo.size > MAX_UPDATE_ATTEMPT_BYTES) {
        return attemptState("damaged", null, "update_attempt_changed_or_invalid");
      }
      const bytes = await boundedFileBytes(handle);
      if (!bytes) return attemptState("damaged", null, "update_attempt_too_large");
      let parsed;
      try { parsed = parseStrictJson(bytes, "desktop update attempt"); }
      catch { return attemptState("damaged", null, "update_attempt_invalid"); }
      const record = updateAttemptRecord(parsed);
      return record
        ? attemptState("valid", record)
        : attemptState("damaged", null, "update_attempt_invalid");
    } catch {
      return attemptState("damaged", null, "update_attempt_unreadable");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  return Object.freeze({
    read,
    async write(attempt, options = {}) {
      const record = updateAttemptRecord({ ...attempt, schema: UPDATE_ATTEMPT_SCHEMA });
      if (!record) throw new TypeError("update attempt record is invalid");
      const expected = options.expected === undefined ? null : updateAttemptRecord(options.expected);
      if (options.expected !== undefined && !expected) throw new TypeError("expected update attempt record is invalid");
      await ensurePrivateStateDirectory(stateDirectory);
      const temporary = `${file}.tmp-${crypto.randomUUID()}`;
      let handle = null;
      try {
        handle = await fs.open(temporary, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(record)}\n`);
        await handle.sync();
        await handle.close();
        handle = null;
        if (expected) {
          const current = await read();
          if (current.status !== "valid" || !sameUpdateAttempt(current.record, expected)) throw new Error("update attempt ownership changed");
          await fs.rename(temporary, file);
        } else {
          await fs.link(temporary, file);
          await fs.rm(temporary);
        }
        if (process.platform !== "win32") await fs.chmod(file, 0o600);
        await syncDirectory(stateDirectory);
        const written = await read();
        if (written.status !== "valid" || !sameUpdateAttempt(written.record, record)) throw new Error("update attempt write is unconfirmed");
        return written.record;
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    },
    async clear(expectedValue) {
      const expected = updateAttemptRecord(expectedValue);
      if (!expected) throw new TypeError("expected update attempt record is invalid");
      const current = await read();
      if (current.status !== "valid" || !sameUpdateAttempt(current.record, expected)) return false;
      await fs.rm(file, { force: true });
      await syncDirectory(stateDirectory);
      return (await read()).status === "absent";
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

function normalizeAttemptState(value) {
  // Older injected stores used `null` for confirmed absence. The on-disk store
  // always returns the explicit state above; accepting the old empty value here
  // keeps the controller API compatible without turning any read failure into
  // absence.
  if (value === null) return attemptState("absent");
  if (!value || typeof value !== "object" || Array.isArray(value)) return attemptState("damaged", null, "update_attempt_state_invalid");
  if (value.status === "absent") return attemptState("absent");
  if (value.status === "damaged") return attemptState("damaged", null, typeof value.reason === "string" ? value.reason : "update_attempt_state_invalid");
  if (value.status !== "valid") return attemptState("damaged", null, "update_attempt_state_invalid");
  const record = updateAttemptRecord(value.record);
  return record ? attemptState("valid", record) : attemptState("damaged", null, "update_attempt_state_invalid");
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
    revision: 0,
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
  let checkBoundary = null;
  let downloadBoundary = null;
  let installPromise = null;
  let lifecycleGeneration = 0;
  let checkGeneration = null;
  let downloadGeneration = null;
  let downloadStarted = false;
  // The size the updater reported for the candidate now in `available`. Only
  // `acceptCandidate` reaches that status, and only `download` reads this.
  let acceptedBytes = null;
  let attemptReconciliationTerminal = attempts === null;
  let attemptReconciliationPromise = null;
  let restartCommitted = false;
  // A recorded update that did not start blocks automatic checking, so Morrow
  // reports what happened and waits for the person to ask for the retry instead
  // of downloading the same version again on its own.
  let automaticCheckBlocked = false;
  let unresolvedAttemptBlocked = false;

  function publish() {
    state.revision = Math.min(Number.MAX_SAFE_INTEGER, state.revision + 1);
    const snapshot = plainSnapshot(state);
    for (const listener of subscribers) {
      try { listener(snapshot); } catch { /* UI listeners are not trusted update control flow. */ }
    }
    return snapshot;
  }

  function transition(status, availableVersion, reason) {
    if (state.status === status && state.availableVersion === availableVersion && state.reason === reason) {
      return plainSnapshot(state);
    }
    state.status = status;
    state.availableVersion = availableVersion;
    state.reason = reason;
    return publish();
  }

  function operationError(code, message) {
    return Object.assign(new Error(message), { code });
  }

  function beginBoundedOperation(run, timeoutMs, timeoutError) {
    let settled = false;
    let rejectInterruption;
    const interruption = new Promise((_resolve, reject) => { rejectInterruption = reject; });
    const boundary = {
      adapterCancelled: false,
      interrupt(error, cancelAdapter = false) {
        if (settled) return false;
        if (cancelAdapter && !boundary.adapterCancelled) {
          boundary.adapterCancelled = true;
          try { adapter.cancelUpdate?.(); } catch { /* The owned deadline still settles. */ }
        }
        settled = true;
        rejectInterruption(error);
        return true;
      }
    };
    const timer = typeof timers.setTimeout === "function"
      ? timers.setTimeout(() => boundary.interrupt(timeoutError, true), timeoutMs)
      : globalThis.setTimeout(() => boundary.interrupt(timeoutError, true), timeoutMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    boundary.promise = Promise.race([Promise.resolve().then(run), interruption])
      .finally(() => {
        settled = true;
        if (typeof timers.clearTimeout === "function") timers.clearTimeout(timer);
        else globalThis.clearTimeout(timer);
      });
    return boundary;
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
    if (unresolvedAttemptBlocked) return false;
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
      if (restartCommitted) {
        transition("installing", state.availableVersion, reason);
        return;
      }
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
        if (checkGeneration === lifecycleGeneration
          && !admissionReason() && !unresolvedAttemptBlocked && state.status !== "ready") transition("checking", null, null);
      },
      "update-available": (info) => {
        if (checkGeneration === lifecycleGeneration) acceptCandidate(info);
      },
      "update-not-available": () => {
        if (checkGeneration === lifecycleGeneration
          && !setUnavailableIfNeeded() && !unresolvedAttemptBlocked && state.status !== "ready") transition("idle", null, "up_to_date");
      },
      "update-downloaded": (info) => {
        if (downloadGeneration !== lifecycleGeneration || !downloadStarted || state.status !== "downloading") return;
        if (setUnavailableIfNeeded() || unresolvedAttemptBlocked) return;
        const candidate = candidateFrom(info);
        if (!candidate?.version || candidate.version !== state.availableVersion || candidateReason(candidate)) {
          transition("error", null, "update_generation_mismatch");
          return;
        }
        // Readiness belongs to the matching download promise. electron-updater
        // emits this event before that promise finishes its staging work.
      },
      "update-cancelled": () => {
        if (downloadGeneration === lifecycleGeneration && downloadStarted
          && !setUnavailableIfNeeded() && !unresolvedAttemptBlocked && state.status !== "ready") {
          transition("available", state.availableVersion, "download_cancelled");
        }
      },
      error: (error) => {
        const activeOperation = checkGeneration === lifecycleGeneration
          || (downloadGeneration === lifecycleGeneration && downloadStarted)
          || state.status === "installing";
        if (activeOperation && !setUnavailableIfNeeded() && !unresolvedAttemptBlocked && state.status !== "ready") {
          handleError(error, state.status);
        }
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
    if (unresolvedAttemptBlocked) {
      await reconcileAttempt();
      if (unresolvedAttemptBlocked) return plainSnapshot(state);
    }
    // An explicit check is the person asking to try the update again, so it
    // lifts the block a failed launch put on automatic checking.
    automaticCheckBlocked = false;
    if (state.status === "ready") return plainSnapshot(state);
    if (checkPromise || downloadPromise || installPromise) return checkPromise || downloadPromise || installPromise;
    const generation = lifecycleGeneration;
    checkGeneration = generation;
    transition("checking", null, null);
    const boundary = beginBoundedOperation(
      () => adapter.checkForUpdates(),
      UPDATE_CHECK_TIMEOUT_MS,
      operationError("ERR_UPDATE_CHECK_TIMEOUT", "desktop update check timed out")
    );
    checkBoundary = boundary;
    const pending = boundary.promise
      .then((result) => {
        if (generation !== lifecycleGeneration) return plainSnapshot(state);
        const candidate = candidateFrom(result);
        if (result && result.isUpdateAvailable === false) {
          if (state.status === "checking" || state.status === "available") transition("idle", null, "up_to_date");
        } else if (candidate?.version) {
          if (state.status === "checking" || state.status === "available") acceptCandidate(candidate);
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
        if (generation === lifecycleGeneration) handleError(error, "checking");
        return plainSnapshot(state);
      })
      .finally(() => {
        if (checkPromise === pending) checkPromise = null;
        if (checkBoundary === boundary) checkBoundary = null;
        if (checkGeneration === generation) checkGeneration = null;
      });
    checkPromise = pending;
    return pending;
  }

  async function download() {
    if (setUnavailableIfNeeded()) return plainSnapshot(state);
    if (unresolvedAttemptBlocked) return plainSnapshot(state);
    if (downloadPromise || installPromise) return downloadPromise || installPromise;
    if (state.status !== "available" || !state.availableVersion) return plainSnapshot(state);
    const version = state.availableVersion;
    const generation = lifecycleGeneration;
    downloadGeneration = generation;
    downloadStarted = false;
    const boundary = beginBoundedOperation(
      async () => {
        const admitted = await freeSpaceAdmits();
        if (generation !== lifecycleGeneration) return plainSnapshot(state);
        if (!admitted) return transition("error", null, "disk_space_unavailable");
        transition("downloading", version, null);
        downloadStarted = true;
        await adapter.downloadUpdate();
        if (generation !== lifecycleGeneration) return plainSnapshot(state);
        if (state.status === "downloading") transition("ready", version, null);
        return plainSnapshot(state);
      },
      UPDATE_DOWNLOAD_TIMEOUT_MS,
      operationError("ERR_UPDATE_DOWNLOAD_TIMEOUT", "desktop update download timed out")
    );
    downloadBoundary = boundary;
    const pending = boundary.promise
      .catch((error) => {
        if (generation === lifecycleGeneration) {
          const reason = updaterErrorReason(error, "downloading");
          if (reason === "update_download_timeout") {
            if (state.status === "downloading" || (state.status === "available" && state.reason === null)) {
              transition("available", version, reason);
            }
          } else {
            handleError(error, "downloading");
          }
        }
        return plainSnapshot(state);
      })
      .finally(() => {
        if (downloadPromise === pending) downloadPromise = null;
        if (downloadBoundary === boundary) downloadBoundary = null;
        if (downloadGeneration === generation) {
          downloadGeneration = null;
          downloadStarted = false;
        }
      });
    downloadPromise = pending;
    return pending;
  }

  /**
   * Resolves the recorded install attempt from the last run. Calls share the
   * active reconciliation and memoize it only after one terminal outcome.
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
  async function readAttemptState() {
    if (!attempts) return attemptState("absent");
    try { return normalizeAttemptState(await attempts.read()); }
    catch { return attemptState("damaged", null, "update_attempt_state_unreadable"); }
  }

  function blockAttemptReconciliation(reason = null) {
    automaticCheckBlocked = true;
    unresolvedAttemptBlocked = true;
    return reason ? transition("error", null, reason) : plainSnapshot(state);
  }

  function completeAttemptReconciliation() {
    attemptReconciliationTerminal = true;
    automaticCheckBlocked = false;
    unresolvedAttemptBlocked = false;
  }

  async function runAttemptReconciliation() {
    const stored = await readAttemptState();
    if (stored.status === "damaged") return blockAttemptReconciliation("update_attempt_repair_required");
    if (stored.status === "absent") {
      completeAttemptReconciliation();
      return state.reason === "update_attempt_repair_required" ? transition("idle", null, null) : plainSnapshot(state);
    }
    const record = stored.record;
    if (record.toVersion === identity.currentVersion) {
      let confirmation = null;
      try { confirmation = await confirmUpdatedRuntime(); }
      catch { confirmation = null; }
      if (confirmation?.status !== "verified") {
        return blockAttemptReconciliation();
      }
      try {
        if (!await attempts.clear(record)) {
          return blockAttemptReconciliation();
        }
      }
      catch {
        return blockAttemptReconciliation();
      }
      completeAttemptReconciliation();
      return transition("idle", null, "update_complete");
    }
    if (record.fromVersion === identity.currentVersion) {
      attemptReconciliationTerminal = true;
      automaticCheckBlocked = true;
      unresolvedAttemptBlocked = false;
      return transition("error", null, "update_rolled_back");
    }
    try {
      if (!await attempts.clear(record)) return blockAttemptReconciliation();
    } catch {
      return blockAttemptReconciliation();
    }
    completeAttemptReconciliation();
    return plainSnapshot(state);
  }

  function reconcileAttempt() {
    if (attemptReconciliationTerminal) return Promise.resolve(plainSnapshot(state));
    if (attemptReconciliationPromise) return attemptReconciliationPromise;
    const pending = Promise.resolve()
      .then(runAttemptReconciliation)
      .finally(() => { if (attemptReconciliationPromise === pending) attemptReconciliationPromise = null; });
    attemptReconciliationPromise = pending;
    return pending;
  }

  function reconcileAfterRepair() {
    return reconcileAttempt();
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
    if (!attempts) return Object.freeze({ record: null });
    try {
      const stored = normalizeAttemptState(await attempts.read());
      if (stored.status === "damaged") return null;
      const current = stored.status === "valid" ? stored.record : null;
      if (current?.toVersion === identity.currentVersion) return null;
      if (current && current.fromVersion !== identity.currentVersion) return null;
      const next = { fromVersion: identity.currentVersion, toVersion: version, at: new Date().toISOString() };
      const written = await attempts.write(next, current ? { expected: current } : undefined);
      const record = updateAttemptRecord(written);
      if (!record || record.fromVersion !== next.fromVersion || record.toVersion !== next.toVersion || record.at !== next.at) return null;
      return Object.freeze({ record });
    } catch {
      return null;
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

  async function releaseFailedCommit(leaseId, version, attempt) {
    let recordCleared = attempt.record === null;
    if (!recordCleared) {
      try { recordCleared = await attempts.clear(attempt.record) === true; }
      catch { recordCleared = false; }
    }
    let leaseReleased = false;
    try {
      await releaseRestartLease(leaseId);
      leaseReleased = true;
    } catch { /* A failed release leaves the restart decision uncertain. */ }
    if (!recordCleared || !leaseReleased) return deferredInstall(version);
    return transition("ready", version, "update_install_failed");
  }

  async function releaseUncommittedLease(leaseId, version) {
    try { await releaseRestartLease(leaseId); }
    catch { return deferredInstall(version); }
    return deferredInstall(version);
  }

  function installWhenIdle() {
    bindEvents();
    if (setUnavailableIfNeeded()) return plainSnapshot(state);
    if (unresolvedAttemptBlocked) return plainSnapshot(state);
    if (installPromise) return installPromise;
    if (state.status !== "ready" || !state.availableVersion) return plainSnapshot(state);
    const version = state.availableVersion;
    // Assign the shared promise before any lease request. A second renderer
    // click must join this attempt instead of obtaining a second lease.
    const pending = Promise.resolve()
      .then(() => acquireRestartLease())
      .then(async (lease) => {
        if (!isGrantedRestartLease(lease)) return deferredInstall(version);
        const attempt = await recordAttempt(version);
        // The attempt is durable before the owner crosses its closing boundary.
        // A failed claim releases the still-reversible lease.
        if (!attempt) return releaseUncommittedLease(lease.leaseId, version);
        let committed;
        try { committed = await commitRestartLease(lease.leaseId); }
        catch { return releaseFailedCommit(lease.leaseId, version, attempt); }
        if (!isCommittedRestartLease(committed)) return releaseFailedCommit(lease.leaseId, version, attempt);
        restartCommitted = true;
        transition("installing", version, null);
        return Promise.resolve()
          .then(() => adapter.quitAndInstall())
          // A closing owner can no longer resume ordinary work. Keep its lease
          // and attempt record through process exit, including updater failure.
          .then(() => plainSnapshot(state))
          .catch(() => transition("installing", version, "update_install_failed"));
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
    lifecycleGeneration += 1;
    checkGeneration = null;
    downloadGeneration = null;
    downloadStarted = false;
    if (interval !== null && typeof timers.clearInterval === "function") timers.clearInterval(interval);
    interval = null;
    while (unlisteners.length > 0) {
      try { unlisteners.pop()(); } catch { /* Adapter cleanup cannot change app state. */ }
    }
    started = false;
    const boundaries = [checkBoundary, downloadBoundary].filter((boundary) => boundary !== null);
    const cancelAdapter = boundaries.length === 0 || boundaries.some((boundary) => !boundary.adapterCancelled);
    if (cancelAdapter) {
      for (const boundary of boundaries) boundary.adapterCancelled = true;
      try { adapter.cancelUpdate?.(); } catch { /* Stopping never reopens updater work. */ }
    }
    const stopped = operationError("ERR_UPDATE_STOPPED", "desktop update controller stopped");
    for (const boundary of boundaries) boundary.interrupt(stopped);
  }

  setUnavailableIfNeeded();
  return Object.freeze({ snapshot, start, check, installWhenIdle, reconcileAfterRepair, subscribe, stop });
}

module.exports = {
  DEFAULT_CHECK_INTERVAL_MS,
  UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_DOWNLOAD_TIMEOUT_MS,
  UPDATE_ATTEMPT_FILE,
  UPDATE_EVENTS,
  compareVersions,
  createUpdateAttemptStore,
  createUpdateController,
  parseVersion
};
