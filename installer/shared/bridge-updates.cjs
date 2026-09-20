"use strict";

// This module changes only the app-owned unpacked Bridge directory. Electron
// main must provide paths and the release-manifest hash from its signed payload.

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { decodeStrictUtf8, parseStrictJson } = require("./strict-utf8.cjs");
const { DatabaseSync } = require("node:sqlite");
const {
  processMatchesExactStart,
  processMatchesRecordedLifetime,
  readProcessStartedAt,
} = require("./process-lifetime.cjs");

const RELEASE_SCHEMA = "morrow.bridge-release.v1";
const INSTALLATION_SCHEMA = "morrow.bridge-installation.v1";
const CHALLENGE_SCHEMA = "morrow.bridge.active-folder-challenge.v1";
const PROOF_SCHEMA = "morrow.bridge.active-folder-proof.v1";
const QUIESCED_SCHEMA = "morrow.bridge.update-quiesced.v1";
const RESUMED_SCHEMA = "morrow.bridge.update-resumed.v1";
const READBACK_SCHEMA = "morrow.bridge.update-readback.v1";
const LOCK_SCHEMA = "morrow.bridge.update-lock.v1";
const LOCK_DATABASE_FILE = "bridge-update-lock.sqlite3";
const UPDATE_TRANSACTION_SCHEMA = "morrow.bridge-update-transaction.v1";
const UPDATE_TRANSACTION_FILE = "bridge-update-transaction.json";
const ROLLBACK_TRANSACTION_SCHEMA = "morrow.bridge-rollback-transaction.v1";
const ROLLBACK_TRANSACTION_FILE = "bridge-rollback-transaction.json";
const LOCK_STALE_MS = 10 * 60 * 1000;
const INSTALLATION_RECORD_VERSION = 1;
const ACTIVE_FOLDER_MARKER = "morrow-bridge-active-folder.json";
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 5_000;

class BridgeUpdateError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "BridgeUpdateError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, details) {
  throw new BridgeUpdateError(code, details);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isDigest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function objectKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");
}

function identifier(value, minimum = 1, maximum = 256) {
  return typeof value === "string"
    && new RegExp(`^[A-Za-z0-9._-]{${minimum},${maximum}}$`).test(value);
}

function extensionId(value) {
  return typeof value === "string" && /^[a-p]{32}$/.test(value);
}

function normalRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)) return false;
  return value.split("/").every((part) => part && part !== "." && part !== "..");
}

function parseChromeVersion(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*)){0,3}$/.test(value)) return null;
  const parts = value.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part) || part > 65535)) return null;
  while (parts.length < 4) parts.push(0);
  return { raw: value, parts };
}

function compareChromeVersions(left, right) {
  for (let index = 0; index < 4; index += 1) {
    if (left.parts[index] !== right.parts[index]) return left.parts[index] > right.parts[index] ? 1 : -1;
  }
  return 0;
}

function sameStrings(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => value === right[index]);
}

function validStrings(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") && new Set(value).size === value.length;
}

function derivedExtensionId(publicKey) {
  if (typeof publicKey !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(publicKey)) return null;
  const decoded = Buffer.from(publicKey, "base64");
  if (!decoded.byteLength || decoded.toString("base64") !== publicKey) return null;
  return [...crypto.createHash("sha256").update(decoded).digest().subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 15])
    .map((nibble) => String.fromCharCode(97 + nibble))
    .join("");
}

function json(value, code) {
  try { return JSON.parse(value); } catch { fail(code); }
}

function recordFile(value) {
  return objectKeys(value, ["bytes", "path", "sha256"])
    && normalRelativePath(value.path)
    && value.path !== ACTIVE_FOLDER_MARKER
    && Number.isSafeInteger(value.bytes) && value.bytes >= 0 && value.bytes <= MAX_FILE_BYTES
    && isDigest(value.sha256);
}

function inspectFiles(files, code) {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES || !files.every(recordFile)) fail(code);
  const paths = files.map((file) => file.path);
  if (new Set(paths).size !== paths.length || [...paths].sort().some((entry, index) => entry !== paths[index])) fail(code);
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  if (!Number.isSafeInteger(total) || total > MAX_TOTAL_BYTES) fail(code);
  return files.map((file) => Object.freeze({ path: file.path, bytes: file.bytes, sha256: file.sha256 }));
}

function inspectChallenge(value, version, extension) {
  if (value === null || value === undefined) return null;
  if (!objectKeys(value, ["challengeId", "extensionId", "manifestVersion", "nonce", "sha256"])
    || !identifier(value.challengeId, 16) || !identifier(value.nonce, 16, 512)
    || value.extensionId !== extension || value.manifestVersion !== version || !isDigest(value.sha256)) {
    fail("bridge_challenge_invalid");
  }
  return Object.freeze({ ...value });
}

function releaseMetadata(value) {
  if (!objectKeys(value, ["extensionId", "files", "hostPermissions", "manifestSha256", "optionalHostPermissions", "permissions", "schema", "version"])
    || value.schema !== RELEASE_SCHEMA || !extensionId(value.extensionId) || !parseChromeVersion(value.version)
    || !isDigest(value.manifestSha256) || !validStrings(value.permissions) || !validStrings(value.hostPermissions)
    || !validStrings(value.optionalHostPermissions)) fail("bridge_release_manifest_invalid");
  return Object.freeze({
    schema: value.schema,
    extensionId: value.extensionId,
    version: value.version,
    manifestSha256: value.manifestSha256,
    permissions: Object.freeze([...value.permissions]),
    hostPermissions: Object.freeze([...value.hostPermissions]),
    optionalHostPermissions: Object.freeze([...value.optionalHostPermissions]),
    files: Object.freeze(inspectFiles(value.files, "bridge_release_manifest_invalid"))
  });
}

async function lstatDirectory(directory, code) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) fail(code);
  let info;
  try { info = await fs.lstat(directory); } catch { fail(code); }
  if (!info.isDirectory() || info.isSymbolicLink()) fail(code);
  return fs.realpath(directory);
}

async function ensurePrivateDirectory(directory, code) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) fail(code);
  try { await fs.mkdir(directory, { recursive: true, mode: 0o700 }); } catch { fail(code); }
  const canonical = await lstatDirectory(directory, code);
  if (process.platform !== "win32") await fs.chmod(canonical, 0o700);
  return canonical;
}

async function regularFile(file, code) {
  let info;
  try { info = await fs.lstat(file); } catch { fail(code); }
  if (!info.isFile() || info.isSymbolicLink()) fail(code);
  return info;
}

async function walkFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const files = [];
  for (const entry of entries) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    const full = path.join(root, next);
    const info = await fs.lstat(full);
    if (info.isSymbolicLink()) fail("bridge_release_symlink_refused", { path: next });
    if (info.isDirectory()) files.push(...await walkFiles(root, next));
    else if (info.isFile()) files.push({ path: next, bytes: info.size, full });
    else fail("bridge_release_file_type_refused", { path: next });
  }
  return files;
}

async function verifyDirectoryReceipt(root, files, code, allowMarker = false) {
  const actual = await walkFiles(root);
  const actualWithoutMarker = actual.filter((entry) => entry.path !== ACTIVE_FOLDER_MARKER);
  if (actual.length !== actualWithoutMarker.length && !allowMarker) fail(code);
  if (actualWithoutMarker.length !== files.length) fail(code);
  for (let index = 0; index < files.length; index += 1) {
    const expected = files[index];
    const present = actualWithoutMarker[index];
    if (!present || present.path !== expected.path || present.bytes !== expected.bytes) fail(code);
    const digest = sha256(await fs.readFile(present.full));
    if (digest !== expected.sha256) fail(code);
  }
  const marker = actual.find((entry) => entry.path === ACTIVE_FOLDER_MARKER) || null;
  if (marker && marker.bytes > 16 * 1024) fail(code);
  return marker;
}

async function verifyExtensionManifest(root, release, code) {
  const file = path.join(root, "manifest.json");
  await regularFile(file, code);
  const bytes = await fs.readFile(file);
  if (sha256(bytes) !== release.manifestSha256) fail(code);
  let manifest;
  try { manifest = parseStrictJson(bytes, "Bridge extension manifest"); } catch { fail(code); }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
    || manifest.manifest_version !== 3 || manifest.version !== release.version
    || derivedExtensionId(manifest.key) !== release.extensionId
    || !sameStrings(manifest.permissions, release.permissions)
    || !sameStrings(manifest.host_permissions, release.hostPermissions)
    || !sameStrings(manifest.optional_host_permissions, release.optionalHostPermissions)) fail(code);
}

function absoluteDestination(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) fail("bridge_directory_invalid");
  const resolved = path.resolve(directory);
  const base = path.basename(resolved);
  if (!base || base === "." || base === path.sep) fail("bridge_directory_invalid");
  return { resolved, base, parent: path.dirname(resolved) };
}

async function stableDestination(directory) {
  const target = absoluteDestination(directory);
  const parent = await ensurePrivateDirectory(target.parent, "bridge_directory_invalid");
  const actual = path.join(parent, target.base);
  try {
    const info = await fs.lstat(actual);
    if (info.isSymbolicLink() || !info.isDirectory()) fail("bridge_directory_invalid");
    return { path: await fs.realpath(actual), exists: true };
  } catch (error) {
    if (error instanceof BridgeUpdateError) throw error;
    if (error?.code === "ENOENT") return { path: actual, exists: false };
    fail("bridge_directory_invalid");
  }
}

async function readOnlyStateDirectory(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) fail("bridge_state_directory_invalid");
  try {
    return await lstatDirectory(directory, "bridge_state_directory_invalid");
  } catch (error) {
    if (error instanceof BridgeUpdateError && error.code === "bridge_state_directory_invalid") {
      try {
        await fs.lstat(directory);
      } catch (missing) {
        if (missing?.code === "ENOENT") return null;
      }
    }
    throw error;
  }
}

async function readOnlyStableDestination(directory) {
  const target = absoluteDestination(directory);
  let parent;
  try {
    parent = await lstatDirectory(target.parent, "bridge_directory_invalid");
  } catch (error) {
    if (error instanceof BridgeUpdateError && error.code === "bridge_directory_invalid") {
      try {
        await fs.lstat(target.parent);
      } catch (missing) {
        if (missing?.code === "ENOENT") return { path: target.resolved, exists: false };
      }
    }
    throw error;
  }
  const actual = path.join(parent, target.base);
  try {
    const info = await fs.lstat(actual);
    if (info.isSymbolicLink() || !info.isDirectory()) fail("bridge_directory_invalid");
    return { path: await fs.realpath(actual), exists: true };
  } catch (error) {
    if (error instanceof BridgeUpdateError) throw error;
    if (error?.code === "ENOENT") return { path: actual, exists: false };
    fail("bridge_directory_invalid");
  }
}

function under(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function readReleaseManifest(options) {
  const sourceDirectory = await lstatDirectory(options?.sourceDirectory, "bridge_release_source_invalid");
  if (typeof options?.releaseManifestPath !== "string" || !path.isAbsolute(options.releaseManifestPath)) fail("bridge_release_manifest_invalid");
  const releasePath = path.resolve(options.releaseManifestPath);
  if (under(sourceDirectory, releasePath)) fail("bridge_release_manifest_invalid");
  await regularFile(releasePath, "bridge_release_manifest_invalid");
  if (!isDigest(options?.trustedReleaseManifestSha256)) fail("bridge_release_manifest_untrusted");
  const bytes = await fs.readFile(releasePath);
  const releaseManifestSha256 = sha256(bytes);
  if (releaseManifestSha256 !== options.trustedReleaseManifestSha256) fail("bridge_release_manifest_untrusted");
  let releaseValue;
  try { releaseValue = parseStrictJson(bytes, "Bridge release manifest"); } catch { fail("bridge_release_manifest_invalid"); }
  const release = releaseMetadata(releaseValue);
  if (options.expectedExtensionId !== undefined && release.extensionId !== options.expectedExtensionId) fail("bridge_extension_identity_changed");
  await verifyDirectoryReceipt(sourceDirectory, release.files, "bridge_release_files_invalid");
  await verifyExtensionManifest(sourceDirectory, release, "bridge_release_manifest_invalid");
  return Object.freeze({ ...release, sourceDirectory, releaseManifestPath: releasePath, releaseManifestSha256 });
}

async function copyRelease(release, destination) {
  await lstatDirectory(destination, "bridge_stage_invalid");
  for (const file of release.files) {
    const output = path.join(destination, file.path);
    await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
    await fs.copyFile(path.join(release.sourceDirectory, file.path), output, fs.constants.COPYFILE_EXCL);
    if (process.platform !== "win32") await fs.chmod(output, 0o600);
  }
  if (process.platform !== "win32") await fs.chmod(destination, 0o700);
}

async function makeStage(targetPath) {
  return fs.mkdtemp(path.join(path.dirname(targetPath), ".morrow-bridge-stage-"));
}

async function exists(value) {
  try { await fs.lstat(value); return true; } catch { return false; }
}

// A lock is reclaimable only when it names no running process and was started
// longer ago than the window. A lock file written by an earlier app version
// names no process, so its modification time bounds it instead.
async function reclaimableLock(lockPath) {
  let info;
  try { info = await fs.lstat(lockPath); } catch { return false; }
  if (!info.isFile() || info.isSymbolicLink()) return false;
  let content = null;
  try { content = decodeStrictUtf8(await fs.readFile(lockPath), "Bridge update lock"); } catch { /* use its age as the damaged-lock bound */ }
  let startedAt = info.mtimeMs;
  let parsed = null;
  try { parsed = content === null ? null : JSON.parse(content); } catch { parsed = null; }
  if (objectKeys(parsed, ["pid", "schema", "startedAt"]) && parsed.schema === LOCK_SCHEMA) {
    if (await processMatchesRecordedLifetime(parsed.pid, parsed.startedAt) !== false) return false;
    const recorded = Date.parse(parsed.startedAt);
    if (Number.isFinite(recorded)) startedAt = recorded;
  }
  return Date.now() - startedAt >= LOCK_STALE_MS;
}

async function databaseLockReclaimable(value) {
  if (!value || typeof value !== "object"
    || !identifier(value.lock_id, 36, 36)
    || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || typeof value.started_at !== "string"
    || !(value.process_started_at === null || typeof value.process_started_at === "string")) return false;
  const startedAt = Date.parse(value.started_at);
  if (!Number.isFinite(startedAt) || Date.now() - startedAt < LOCK_STALE_MS) return false;
  const processMatch = value.process_started_at === null
    ? await processMatchesRecordedLifetime(value.pid, value.started_at)
    : await processMatchesExactStart(value.pid, value.process_started_at);
  return processMatch === false;
}

function sqliteContention(error) {
  return typeof error?.message === "string" && /(?:busy|locked)/i.test(error.message);
}

async function openLockDatabase(stateDirectory) {
  const file = path.join(stateDirectory, LOCK_DATABASE_FILE);
  const info = await fs.lstat(file).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (info && (!info.isFile() || info.isSymbolicLink())) fail("bridge_state_directory_invalid");
  let database;
  try {
    database = new DatabaseSync(file);
    database.exec([
      "PRAGMA busy_timeout = 250;",
      "CREATE TABLE IF NOT EXISTS bridge_update_lock (",
      "  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),",
      "  lock_id TEXT NOT NULL CHECK (length(lock_id) = 36),",
      "  pid INTEGER NOT NULL CHECK (pid > 0),",
      "  started_at TEXT NOT NULL,",
      "  process_started_at TEXT",
      ") STRICT;"
    ].join("\n"));
    const columns = database.prepare("PRAGMA table_info(bridge_update_lock)").all();
    if (!columns.some((column) => column.name === "process_started_at")) {
      database.exec("ALTER TABLE bridge_update_lock ADD COLUMN process_started_at TEXT;");
    }
    if (process.platform !== "win32") await fs.chmod(file, 0o600);
    return database;
  } catch (error) {
    try { database?.close(); } catch {}
    if (sqliteContention(error)) fail("bridge_update_busy");
    fail("bridge_state_directory_invalid");
  }
}

async function releaseDatabaseLock(stateDirectory, lockId) {
  const database = await openLockDatabase(stateDirectory);
  let transaction = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transaction = true;
    const result = database.prepare("DELETE FROM bridge_update_lock WHERE singleton = 1 AND lock_id = ?").run(lockId);
    database.exec("COMMIT;");
    transaction = false;
    return result.changes === 1;
  } catch (error) {
    if (transaction) try { database.exec("ROLLBACK;"); } catch {}
    if (sqliteContention(error)) fail("bridge_update_busy");
    fail("bridge_state_directory_invalid");
  } finally {
    try { database.close(); } catch {}
  }
}

async function acquireDatabaseLock(stateDirectory) {
  const processStartedAt = await readProcessStartedAt(process.pid);
  if (processStartedAt === null) fail("bridge_process_identity_unavailable");
  const database = await openLockDatabase(stateDirectory);
  const ownership = {
    lockId: crypto.randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    processStartedAt: new Date(processStartedAt).toISOString(),
  };
  let transaction = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transaction = true;
    const existing = database.prepare("SELECT lock_id, pid, started_at, process_started_at FROM bridge_update_lock WHERE singleton = 1").get();
    if (existing && !await databaseLockReclaimable(existing)) fail("bridge_update_busy");
    database.prepare([
      "INSERT INTO bridge_update_lock (singleton, lock_id, pid, started_at, process_started_at) VALUES (1, ?, ?, ?, ?)",
      "ON CONFLICT(singleton) DO UPDATE SET lock_id = excluded.lock_id, pid = excluded.pid,",
      "started_at = excluded.started_at, process_started_at = excluded.process_started_at"
    ].join(" ")).run(ownership.lockId, ownership.pid, ownership.startedAt, ownership.processStartedAt);
    database.exec("COMMIT;");
    transaction = false;
  } catch (error) {
    if (transaction) try { database.exec("ROLLBACK;"); } catch {}
    if (error instanceof BridgeUpdateError) throw error;
    if (sqliteContention(error)) fail("bridge_update_busy");
    fail("bridge_state_directory_invalid");
  } finally {
    try { database.close(); } catch {}
  }

  // Older Morrow versions used this JSON file. The database row is already
  // ours, so migration of a dead legacy owner cannot race another new owner.
  const legacyPath = path.join(stateDirectory, "bridge-update.lock");
  if (await exists(legacyPath)) {
    if (!await reclaimableLock(legacyPath)) {
      await releaseDatabaseLock(stateDirectory, ownership.lockId);
      fail("bridge_update_busy");
    }
    await fs.rm(legacyPath, { force: true }).catch(() => undefined);
    if (await exists(legacyPath)) {
      await releaseDatabaseLock(stateDirectory, ownership.lockId);
      fail("bridge_update_busy");
    }
  }
  return ownership;
}

async function lock(stateDirectory, callback) {
  const ownership = await acquireDatabaseLock(stateDirectory);
  try {
    await recoverBridgeUpdateTransaction(stateDirectory);
    await recoverBridgeRollbackTransaction(stateDirectory);
    return await callback();
  }
  finally {
    if (!await releaseDatabaseLock(stateDirectory, ownership.lockId)) fail("bridge_update_busy");
  }
}

// The rollback copy is app-owned garbage once the update is confirmed. Removal
// is proven by a fresh lstat; an unproven removal is reported, never assumed.
async function removeRollbackCopy(directory) {
  await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  try { await fs.lstat(directory); } catch (error) { return error?.code === "ENOENT"; }
  return false;
}

function recordFromRelease(bridgeDirectory, release, activeFolderChallenge = null, pendingUpdate = null) {
  return {
    schema: INSTALLATION_SCHEMA,
    recordVersion: INSTALLATION_RECORD_VERSION,
    bridgeDirectory,
    extensionId: release.extensionId,
    extensionVersion: release.version,
    releaseManifestSha256: release.releaseManifestSha256,
    extensionManifestSha256: release.manifestSha256,
    permissions: [...release.permissions],
    hostPermissions: [...release.hostPermissions],
    optionalHostPermissions: [...release.optionalHostPermissions],
    files: release.files.map((file) => ({ ...file })),
    activeFolderChallenge,
    pendingUpdate
  };
}

function inspectPendingUpdate(value, extension, version, bridgeDirectory, stateDirectory) {
  if (value === null || value === undefined) return null;
  const legacy = objectKeys(value, ["backupDirectory", "fromVersion", "quiesceEpoch"]);
  const current = objectKeys(value, ["backupDirectory", "fromVersion", "previousRecord", "quiesceEpoch"]);
  if ((!legacy && !current)
    || !parseChromeVersion(value.fromVersion) || !identifier(value.quiesceEpoch, 16, 256)
    || typeof value.backupDirectory !== "string" || !path.isAbsolute(value.backupDirectory)) fail("bridge_installation_record_invalid");
  const backup = path.resolve(value.backupDirectory);
  if (!under(path.join(stateDirectory, "bridge-backups"), backup)) fail("bridge_installation_record_invalid");
  const previousRecord = current ? inspectInstallationRecord(value.previousRecord, stateDirectory) : null;
  if (previousRecord && (previousRecord.pendingUpdate !== null
    || previousRecord.extensionId !== extension || previousRecord.extensionVersion !== value.fromVersion
    || previousRecord.bridgeDirectory !== bridgeDirectory)) fail("bridge_installation_record_invalid");
  return Object.freeze({ backupDirectory: backup, fromVersion: value.fromVersion, quiesceEpoch: value.quiesceEpoch, previousRecord, extensionId: extension, extensionVersion: version });
}

function inspectInstallationRecord(value, stateDirectory) {
  const keys = ["activeFolderChallenge", "bridgeDirectory", "extensionId", "extensionManifestSha256", "extensionVersion", "files", "hostPermissions", "optionalHostPermissions", "pendingUpdate", "permissions", "recordVersion", "releaseManifestSha256", "schema"];
  if (!objectKeys(value, keys) || value.schema !== INSTALLATION_SCHEMA || value.recordVersion !== INSTALLATION_RECORD_VERSION
    || typeof value.bridgeDirectory !== "string" || !path.isAbsolute(value.bridgeDirectory)
    || !extensionId(value.extensionId) || !parseChromeVersion(value.extensionVersion)
    || !isDigest(value.releaseManifestSha256) || !isDigest(value.extensionManifestSha256)
    || !validStrings(value.permissions) || !validStrings(value.hostPermissions) || !validStrings(value.optionalHostPermissions)) {
    fail("bridge_installation_record_invalid");
  }
  const files = inspectFiles(value.files, "bridge_installation_record_invalid");
  const challenge = inspectChallenge(value.activeFolderChallenge, value.extensionVersion, value.extensionId);
  const pendingUpdate = inspectPendingUpdate(value.pendingUpdate, value.extensionId, value.extensionVersion, path.resolve(value.bridgeDirectory), stateDirectory);
  return Object.freeze({
    ...value,
    bridgeDirectory: path.resolve(value.bridgeDirectory),
    files,
    permissions: Object.freeze([...value.permissions]),
    hostPermissions: Object.freeze([...value.hostPermissions]),
    optionalHostPermissions: Object.freeze([...value.optionalHostPermissions]),
    activeFolderChallenge: challenge,
    pendingUpdate
  });
}

function recordPath(stateDirectory) {
  return path.join(stateDirectory, "bridge-installation.json");
}

async function loadRecord(stateDirectory) {
  const file = recordPath(stateDirectory);
  if (!await exists(file)) return null;
  await regularFile(file, "bridge_installation_record_invalid");
  let value;
  try { value = parseStrictJson(await fs.readFile(file), "Bridge installation record"); } catch { fail("bridge_installation_record_invalid"); }
  return inspectInstallationRecord(value, stateDirectory);
}

async function writeRecord(stateDirectory, record) {
  const destination = recordPath(stateDirectory);
  const temporary = `${destination}.tmp-${crypto.randomUUID()}`;
  const content = `${JSON.stringify(record)}\n`;
  let handle = null;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    if (process.platform !== "win32") await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, destination);
    if (process.platform !== "win32") await fs.chmod(destination, 0o600);
    await syncDirectory(stateDirectory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function installationRecordDocument(record) {
  return {
    schema: record.schema,
    recordVersion: record.recordVersion,
    bridgeDirectory: record.bridgeDirectory,
    extensionId: record.extensionId,
    extensionVersion: record.extensionVersion,
    releaseManifestSha256: record.releaseManifestSha256,
    extensionManifestSha256: record.extensionManifestSha256,
    permissions: [...record.permissions],
    hostPermissions: [...record.hostPermissions],
    optionalHostPermissions: [...record.optionalHostPermissions],
    files: record.files.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })),
    activeFolderChallenge: record.activeFolderChallenge ? {
      challengeId: record.activeFolderChallenge.challengeId,
      nonce: record.activeFolderChallenge.nonce,
      extensionId: record.activeFolderChallenge.extensionId,
      manifestVersion: record.activeFolderChallenge.manifestVersion,
      sha256: record.activeFolderChallenge.sha256
    } : null,
    pendingUpdate: record.pendingUpdate ? {
      backupDirectory: record.pendingUpdate.backupDirectory,
      fromVersion: record.pendingUpdate.fromVersion,
      quiesceEpoch: record.pendingUpdate.quiesceEpoch,
      ...(record.pendingUpdate.previousRecord
        ? { previousRecord: installationRecordDocument(record.pendingUpdate.previousRecord) }
        : {})
    } : null
  };
}

function sameInstallationRecord(left, right) {
  return JSON.stringify(installationRecordDocument(left)) === JSON.stringify(installationRecordDocument(right));
}

function updateTransactionPath(stateDirectory) {
  return path.join(stateDirectory, UPDATE_TRANSACTION_FILE);
}

function inspectBridgeUpdateTransaction(value, stateDirectory) {
  if (!objectKeys(value, ["backupDirectory", "createdAt", "nextRecord", "previousRecord", "schema", "stageDirectory", "transactionId"])
    || value.schema !== UPDATE_TRANSACTION_SCHEMA || !identifier(value.transactionId, 36, 36)
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.stageDirectory !== "string" || !path.isAbsolute(value.stageDirectory)
    || typeof value.backupDirectory !== "string" || !path.isAbsolute(value.backupDirectory)) {
    fail("bridge_update_transaction_invalid");
  }
  const previousRecord = inspectInstallationRecord(value.previousRecord, stateDirectory);
  const nextRecord = inspectInstallationRecord(value.nextRecord, stateDirectory);
  const stageDirectory = path.resolve(value.stageDirectory);
  const backupDirectory = path.resolve(value.backupDirectory);
  const destination = previousRecord.bridgeDirectory;
  const backupRoot = path.join(stateDirectory, "bridge-backups");
  const nextVersion = parseChromeVersion(nextRecord.extensionVersion);
  const previousVersion = parseChromeVersion(previousRecord.extensionVersion);
  if (previousRecord.pendingUpdate !== null || !nextRecord.pendingUpdate
    || nextRecord.bridgeDirectory !== destination
    || nextRecord.extensionId !== previousRecord.extensionId
    || nextRecord.pendingUpdate.backupDirectory !== backupDirectory
    || nextRecord.pendingUpdate.fromVersion !== previousRecord.extensionVersion
    || nextRecord.pendingUpdate.quiesceEpoch.length < 16
    || nextRecord.releaseManifestSha256 === previousRecord.releaseManifestSha256
    || compareChromeVersions(nextVersion, previousVersion) <= 0
    || !sameStrings(nextRecord.permissions, previousRecord.permissions)
    || !sameStrings(nextRecord.hostPermissions, previousRecord.hostPermissions)
    || !sameStrings(nextRecord.optionalHostPermissions, previousRecord.optionalHostPermissions)
    || path.dirname(stageDirectory) !== path.dirname(destination)
    || !path.basename(stageDirectory).startsWith(".morrow-bridge-stage-")
    || !under(backupRoot, backupDirectory) || backupDirectory === backupRoot) {
    fail("bridge_update_transaction_invalid");
  }
  return Object.freeze({
    schema: UPDATE_TRANSACTION_SCHEMA,
    transactionId: value.transactionId,
    createdAt: value.createdAt,
    stageDirectory,
    backupDirectory,
    previousRecord,
    nextRecord
  });
}

async function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeBridgeUpdateTransaction(stateDirectory, transaction) {
  const destination = updateTransactionPath(stateDirectory);
  if (await exists(destination)) fail("bridge_update_confirmation_pending");
  const temporary = `${destination}.tmp-${crypto.randomUUID()}`;
  let handle = null;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(transaction)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, destination);
    if (process.platform !== "win32") await fs.chmod(destination, 0o600);
    await syncDirectory(stateDirectory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function loadBridgeUpdateTransaction(stateDirectory) {
  const file = updateTransactionPath(stateDirectory);
  if (!await exists(file)) return null;
  await regularFile(file, "bridge_update_transaction_invalid");
  let value;
  try { value = parseStrictJson(await fs.readFile(file), "Bridge update transaction"); } catch { fail("bridge_update_transaction_invalid"); }
  return inspectBridgeUpdateTransaction(value, stateDirectory);
}

async function removeBridgeUpdateTransaction(stateDirectory) {
  const file = updateTransactionPath(stateDirectory);
  await fs.rm(file, { force: true });
  await syncDirectory(stateDirectory);
  if (await exists(file)) fail("bridge_update_transaction_invalid");
}

function rollbackTransactionPath(stateDirectory) {
  return path.join(stateDirectory, ROLLBACK_TRANSACTION_FILE);
}

function inspectBridgeRollbackTransaction(value, stateDirectory) {
  if (!objectKeys(value, ["createdAt", "currentBackupDirectory", "currentRecord", "previousBackupDirectory", "previousRecord", "schema", "transactionId"])
    || value.schema !== ROLLBACK_TRANSACTION_SCHEMA || !identifier(value.transactionId, 36, 36)
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.currentBackupDirectory !== "string" || !path.isAbsolute(value.currentBackupDirectory)
    || typeof value.previousBackupDirectory !== "string" || !path.isAbsolute(value.previousBackupDirectory)) {
    fail("bridge_rollback_transaction_invalid");
  }
  const currentRecord = inspectInstallationRecord(value.currentRecord, stateDirectory);
  const previousRecord = inspectInstallationRecord(value.previousRecord, stateDirectory);
  const currentBackupDirectory = path.resolve(value.currentBackupDirectory);
  const previousBackupDirectory = path.resolve(value.previousBackupDirectory);
  const backupRoot = path.join(stateDirectory, "bridge-backups");
  if (!currentRecord.pendingUpdate || previousRecord.pendingUpdate !== null
    || !currentRecord.pendingUpdate.previousRecord
    || !sameInstallationRecord(currentRecord.pendingUpdate.previousRecord, previousRecord)
    || currentRecord.pendingUpdate.backupDirectory !== previousBackupDirectory
    || currentRecord.bridgeDirectory !== previousRecord.bridgeDirectory
    || currentRecord.extensionId !== previousRecord.extensionId
    || !under(backupRoot, currentBackupDirectory) || currentBackupDirectory === backupRoot
    || !under(backupRoot, previousBackupDirectory) || previousBackupDirectory === backupRoot
    || currentBackupDirectory === previousBackupDirectory) fail("bridge_rollback_transaction_invalid");
  return Object.freeze({
    schema: ROLLBACK_TRANSACTION_SCHEMA,
    transactionId: value.transactionId,
    createdAt: value.createdAt,
    currentBackupDirectory,
    previousBackupDirectory,
    currentRecord,
    previousRecord
  });
}

async function loadBridgeRollbackTransaction(stateDirectory) {
  const file = rollbackTransactionPath(stateDirectory);
  if (!await exists(file)) return null;
  await regularFile(file, "bridge_rollback_transaction_invalid");
  let value;
  try { value = parseStrictJson(await fs.readFile(file), "Bridge rollback transaction"); } catch { fail("bridge_rollback_transaction_invalid"); }
  return inspectBridgeRollbackTransaction(value, stateDirectory);
}

async function writeBridgeRollbackTransaction(stateDirectory, transaction) {
  const destination = rollbackTransactionPath(stateDirectory);
  if (await exists(destination) || await exists(updateTransactionPath(stateDirectory))) fail("bridge_update_confirmation_pending");
  const temporary = `${destination}.tmp-${crypto.randomUUID()}`;
  let handle = null;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(transaction)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, destination);
    if (process.platform !== "win32") await fs.chmod(destination, 0o600);
    await syncDirectory(stateDirectory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function removeBridgeRollbackTransaction(stateDirectory) {
  const file = rollbackTransactionPath(stateDirectory);
  await fs.rm(file, { force: true });
  await syncDirectory(stateDirectory);
  if (await exists(file)) fail("bridge_rollback_transaction_invalid");
}

/**
 * Discards the durable swap transactions that name the installation record.
 * Both recovery routines converge a transaction against that record, so a
 * transaction that outlives it fails every later lock and nothing can install
 * or repair the Bridge again. A caller that removes the record removes these
 * with it.
 */
async function discardBridgeTransactions(options = {}) {
  const stateDirectory = await readOnlyStateDirectory(options.stateDirectory);
  if (!stateDirectory) return Object.freeze({ discarded: Object.freeze([]) });
  const files = [updateTransactionPath(stateDirectory), rollbackTransactionPath(stateDirectory)];
  const discarded = [];
  for (const file of files) if (await exists(file)) discarded.push(file);
  await removeBridgeUpdateTransaction(stateDirectory);
  await removeBridgeRollbackTransaction(stateDirectory);
  return Object.freeze({ discarded: Object.freeze(discarded) });
}

function releaseFromRecord(record) {
  return Object.freeze({
    extensionId: record.extensionId,
    version: record.extensionVersion,
    manifestSha256: record.extensionManifestSha256,
    permissions: record.permissions,
    hostPermissions: record.hostPermissions,
    optionalHostPermissions: record.optionalHostPermissions,
    files: record.files
  });
}

async function verifyInstalled(record, destination, stateDirectory) {
  if (!destination.exists || destination.path !== record.bridgeDirectory) fail("bridge_installation_target_changed");
  const release = releaseFromRecord(record);
  const marker = await verifyDirectoryReceipt(destination.path, record.files, "bridge_installation_target_changed", true);
  await verifyExtensionManifest(destination.path, release, "bridge_installation_target_changed");
  if (record.activeFolderChallenge) {
    if (!marker || sha256(await fs.readFile(marker.full)) !== record.activeFolderChallenge.sha256) fail("bridge_active_folder_marker_changed");
  } else if (marker) {
    fail("bridge_active_folder_marker_changed");
  }
  if (record.pendingUpdate && !under(path.join(stateDirectory, "bridge-backups"), record.pendingUpdate.backupDirectory)) {
    fail("bridge_installation_record_invalid");
  }
}

async function recordMatchesDirectory(record, directory) {
  try {
    const actual = await lstatDirectory(directory, "bridge_update_transaction_invalid");
    if (actual !== path.resolve(directory)) return false;
    const release = releaseFromRecord(record);
    const marker = await verifyDirectoryReceipt(actual, record.files, "bridge_update_transaction_invalid", true);
    await verifyExtensionManifest(actual, release, "bridge_update_transaction_invalid");
    if (record.activeFolderChallenge) {
      return Boolean(marker && sha256(await fs.readFile(marker.full)) === record.activeFolderChallenge.sha256);
    }
    return marker === null;
  } catch {
    return false;
  }
}

/**
 * Converges a durable Bridge swap to the one post-swap state. Every rename is
 * recoverable from the transaction written before the first directory moves.
 */
async function recoverBridgeUpdateTransaction(stateDirectory) {
  const transaction = await loadBridgeUpdateTransaction(stateDirectory);
  if (!transaction) return null;
  const destination = transaction.previousRecord.bridgeDirectory;
  let current = await loadRecord(stateDirectory);
  if (!current) fail("bridge_update_transaction_invalid");

  let destinationExists = await exists(destination);
  let stageExists = await exists(transaction.stageDirectory);
  let backupExists = await exists(transaction.backupDirectory);
  let destinationIsPrevious = destinationExists && await recordMatchesDirectory(transaction.previousRecord, destination);
  let destinationIsNext = destinationExists && await recordMatchesDirectory(transaction.nextRecord, destination);
  let stageIsNext = stageExists && await recordMatchesDirectory(transaction.nextRecord, transaction.stageDirectory);
  let backupIsPrevious = backupExists && await recordMatchesDirectory(transaction.previousRecord, transaction.backupDirectory);

  if (sameInstallationRecord(current, transaction.previousRecord)
    && destinationIsPrevious && !backupExists && stageIsNext) {
    await fs.rename(destination, transaction.backupDirectory);
    await syncDirectory(path.dirname(destination));
    await syncDirectory(path.dirname(transaction.backupDirectory));
  }

  destinationExists = await exists(destination);
  stageExists = await exists(transaction.stageDirectory);
  backupExists = await exists(transaction.backupDirectory);
  stageIsNext = stageExists && await recordMatchesDirectory(transaction.nextRecord, transaction.stageDirectory);
  backupIsPrevious = backupExists && await recordMatchesDirectory(transaction.previousRecord, transaction.backupDirectory);
  if (sameInstallationRecord(current, transaction.previousRecord)
    && !destinationExists && stageIsNext && backupIsPrevious) {
    await fs.rename(transaction.stageDirectory, destination);
    await syncDirectory(path.dirname(destination));
  }

  destinationExists = await exists(destination);
  stageExists = await exists(transaction.stageDirectory);
  backupExists = await exists(transaction.backupDirectory);
  destinationIsNext = destinationExists && await recordMatchesDirectory(transaction.nextRecord, destination);
  backupIsPrevious = backupExists && await recordMatchesDirectory(transaction.previousRecord, transaction.backupDirectory);
  if (sameInstallationRecord(current, transaction.previousRecord)
    && destinationIsNext && !stageExists && backupIsPrevious) {
    await writeRecord(stateDirectory, installationRecordDocument(transaction.nextRecord));
    current = await loadRecord(stateDirectory);
  }

  if (!sameInstallationRecord(current, transaction.nextRecord)
    || !await recordMatchesDirectory(transaction.nextRecord, destination)
    || await exists(transaction.stageDirectory)
    || !await recordMatchesDirectory(transaction.previousRecord, transaction.backupDirectory)) {
    fail("bridge_update_transaction_invalid");
  }
  await removeBridgeUpdateTransaction(stateDirectory);
  return transaction.nextRecord;
}

/** Restores a pending update's exact prior bytes and record after any crash cut point. */
async function recoverBridgeRollbackTransaction(stateDirectory) {
  const transaction = await loadBridgeRollbackTransaction(stateDirectory);
  if (!transaction) return null;
  const destination = transaction.currentRecord.bridgeDirectory;
  let current = await loadRecord(stateDirectory);
  if (!current) fail("bridge_rollback_transaction_invalid");

  let destinationExists = await exists(destination);
  let previousBackupExists = await exists(transaction.previousBackupDirectory);
  let currentBackupExists = await exists(transaction.currentBackupDirectory);
  let destinationIsCurrent = destinationExists && await recordMatchesDirectory(transaction.currentRecord, destination);
  let destinationIsPrevious = destinationExists && await recordMatchesDirectory(transaction.previousRecord, destination);
  let previousBackupIsPrevious = previousBackupExists
    && await recordMatchesDirectory(transaction.previousRecord, transaction.previousBackupDirectory);
  let currentBackupIsCurrent = currentBackupExists
    && await recordMatchesDirectory(transaction.currentRecord, transaction.currentBackupDirectory);

  if (sameInstallationRecord(current, transaction.currentRecord)
    && destinationIsCurrent && previousBackupIsPrevious && !currentBackupExists) {
    await fs.rename(destination, transaction.currentBackupDirectory);
    await syncDirectory(path.dirname(destination));
  }

  destinationExists = await exists(destination);
  previousBackupExists = await exists(transaction.previousBackupDirectory);
  currentBackupExists = await exists(transaction.currentBackupDirectory);
  previousBackupIsPrevious = previousBackupExists
    && await recordMatchesDirectory(transaction.previousRecord, transaction.previousBackupDirectory);
  currentBackupIsCurrent = currentBackupExists
    && await recordMatchesDirectory(transaction.currentRecord, transaction.currentBackupDirectory);
  if (sameInstallationRecord(current, transaction.currentRecord)
    && !destinationExists && previousBackupIsPrevious && currentBackupIsCurrent) {
    await fs.rename(transaction.previousBackupDirectory, destination);
    await syncDirectory(path.dirname(destination));
  }

  destinationExists = await exists(destination);
  previousBackupExists = await exists(transaction.previousBackupDirectory);
  currentBackupExists = await exists(transaction.currentBackupDirectory);
  destinationIsPrevious = destinationExists && await recordMatchesDirectory(transaction.previousRecord, destination);
  currentBackupIsCurrent = currentBackupExists
    && await recordMatchesDirectory(transaction.currentRecord, transaction.currentBackupDirectory);
  if (sameInstallationRecord(current, transaction.currentRecord)
    && destinationIsPrevious && !previousBackupExists && currentBackupIsCurrent) {
    await writeRecord(stateDirectory, installationRecordDocument(transaction.previousRecord));
    current = await loadRecord(stateDirectory);
  }

  if (!sameInstallationRecord(current, transaction.previousRecord)
    || !await recordMatchesDirectory(transaction.previousRecord, destination)
    || await exists(transaction.previousBackupDirectory)
    || !await recordMatchesDirectory(transaction.currentRecord, transaction.currentBackupDirectory)) {
    fail("bridge_rollback_transaction_invalid");
  }
  await removeBridgeRollbackTransaction(stateDirectory);
  return Object.freeze({ record: transaction.previousRecord, discardedDirectory: transaction.currentBackupDirectory });
}

function challengeDocument(release, challenge) {
  return `${JSON.stringify({
    schema: CHALLENGE_SCHEMA,
    extensionId: release.extensionId,
    manifestVersion: release.version,
    challengeId: challenge.challengeId,
    nonce: challenge.nonce
  })}\n`;
}

function requestedChallenge(value) {
  if (!objectKeys(value, ["challengeId", "nonce"])
    || !identifier(value.challengeId, 16, 128) || !identifier(value.nonce, 16, 512)) fail("bridge_challenge_invalid");
  return { challengeId: value.challengeId, nonce: value.nonce };
}

async function writeChallengeFile(directory, release, input) {
  const challenge = requestedChallenge(input);
  const content = challengeDocument(release, challenge);
  const marker = path.join(directory, ACTIVE_FOLDER_MARKER);
  const temporary = `${marker}.tmp-${crypto.randomUUID()}`;
  try {
    await fs.writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, marker);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return Object.freeze({
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    extensionId: release.extensionId,
    manifestVersion: release.version,
    sha256: sha256(content)
  });
}

function proofMatches(proof, challenge, extension, version, code) {
  if (!objectKeys(proof, ["challengeId", "challengeSha256", "extensionId", "manifestVersion", "nonce", "schema"])
    || proof.schema !== PROOF_SCHEMA || proof.extensionId !== extension || proof.manifestVersion !== version
    || proof.challengeId !== challenge?.challengeId || proof.nonce !== challenge?.nonce || proof.challengeSha256 !== challenge?.sha256) {
    fail(code);
  }
}

function quiescedStatus(value, record) {
  if (!objectKeys(value, ["activeFolderProof", "extensionId", "installType", "manifestVersion", "quiesceEpoch", "quiescent", "schema"])
    || value.schema !== QUIESCED_SCHEMA || value.extensionId !== record.extensionId
    || value.manifestVersion !== record.extensionVersion || value.installType !== "development"
    || value.quiescent !== true || !identifier(value.quiesceEpoch, 16, 256)) fail("bridge_quiesce_unconfirmed");
  proofMatches(value.activeFolderProof, record.activeFolderChallenge, record.extensionId, record.extensionVersion, "bridge_active_folder_unconfirmed");
  return Object.freeze({ extensionId: value.extensionId, manifestVersion: value.manifestVersion, quiesceEpoch: value.quiesceEpoch });
}

async function resumeIfSafe(resumeQuiescence, quiesced) {
  if (typeof resumeQuiescence !== "function") return { attempted: false, resumed: false };
  try {
    const result = await resumeQuiescence({ ...quiesced });
    const resumed = objectKeys(result, ["extensionId", "manifestVersion", "quiesceEpoch", "resumed", "schema"])
      && result.schema === RESUMED_SCHEMA && result.extensionId === quiesced.extensionId
      && result.manifestVersion === quiesced.manifestVersion && result.quiesceEpoch === quiesced.quiesceEpoch
      && result.resumed === true;
    return { attempted: true, resumed };
  } catch { return { attempted: true, resumed: false }; }
}

function errorAfterQuiesce(code, details, resume) {
  return new BridgeUpdateError(code, { ...details, resume });
}

async function initializeBridgeDirectory(options = {}) {
  const release = await readReleaseManifest(options);
  const destination = await stableDestination(options.bridgeDirectory);
  const stateDirectory = await ensurePrivateDirectory(options.stateDirectory, "bridge_state_directory_invalid");
  if (under(release.sourceDirectory, destination.path) || under(destination.path, release.sourceDirectory)) fail("bridge_directory_overlap");

  return lock(stateDirectory, async () => {
    const record = await loadRecord(stateDirectory);
    if (destination.exists || record) {
      if (!record) fail("bridge_installation_untrusted");
      await verifyInstalled(record, destination, stateDirectory);
      if (record.extensionId !== release.extensionId || record.extensionVersion !== release.version
        || record.releaseManifestSha256 !== release.releaseManifestSha256) fail("bridge_installation_exists");
      return Object.freeze({ initialized: false, bridgeDirectory: destination.path, extensionId: record.extensionId, version: record.extensionVersion, activeFolderChallenge: record.activeFolderChallenge });
    }

    let stage = null;
    try {
      stage = await makeStage(destination.path);
      await copyRelease(release, stage);
      let challenge = null;
      if (options.initialChallenge !== undefined) challenge = await writeChallengeFile(stage, release, options.initialChallenge);
      await verifyDirectoryReceipt(stage, release.files, "bridge_stage_invalid", Boolean(challenge));
      await verifyExtensionManifest(stage, release, "bridge_stage_invalid");
      await fs.rename(stage, destination.path);
      stage = null;
      const installed = { ...await stableDestination(destination.path), exists: true };
      await writeRecord(stateDirectory, recordFromRelease(installed.path, release, challenge));
      return Object.freeze({ initialized: true, bridgeDirectory: installed.path, extensionId: release.extensionId, version: release.version, activeFolderChallenge: challenge });
    } catch (error) {
      if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
      if (await exists(destination.path) && !await loadRecord(stateDirectory)) await fs.rm(destination.path, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  });
}

async function issueBridgeActiveFolderChallenge(options = {}) {
  const stateDirectory = await ensurePrivateDirectory(options.stateDirectory, "bridge_state_directory_invalid");
  const destination = await stableDestination(options.bridgeDirectory);
  return lock(stateDirectory, async () => {
    const record = await loadRecord(stateDirectory);
    if (!record) fail("bridge_installation_untrusted");
    if (options.expectedExtensionId !== undefined && record.extensionId !== options.expectedExtensionId) fail("bridge_extension_identity_changed");
    await verifyInstalled(record, destination, stateDirectory);
    const release = releaseFromRecord(record);
    const previousMarker = record.activeFolderChallenge
      ? await fs.readFile(path.join(destination.path, ACTIVE_FOLDER_MARKER))
      : null;
    const challenge = await writeChallengeFile(destination.path, release, options.challenge);
    const updated = { ...record, activeFolderChallenge: challenge };
    try {
      await writeRecord(stateDirectory, updated);
    } catch (error) {
      const marker = path.join(destination.path, ACTIVE_FOLDER_MARKER);
      if (previousMarker) await fs.writeFile(marker, previousMarker, { mode: 0o600 });
      else await fs.rm(marker, { force: true });
      throw error;
    }
    return Object.freeze({ extensionId: record.extensionId, version: record.extensionVersion, activeFolderChallenge: challenge });
  });
}

async function bridgeInstallationStatus(options = {}) {
  const stateDirectory = await readOnlyStateDirectory(options.stateDirectory);
  const destination = await readOnlyStableDestination(options.bridgeDirectory);
  if (!stateDirectory) {
    if (destination.exists) fail("bridge_installation_untrusted");
    return Object.freeze({ installed: false, extensionId: null, version: null, releaseManifestSha256: null, activeFolderChallenge: null, manualChromeReloadRequired: false });
  }
  const readStatus = async () => {
    const currentDestination = await readOnlyStableDestination(options.bridgeDirectory);
    const record = await loadRecord(stateDirectory);
    if (!record) {
      if (currentDestination.exists) fail("bridge_installation_untrusted");
      return Object.freeze({ installed: false, extensionId: null, version: null, releaseManifestSha256: null, activeFolderChallenge: null, manualChromeReloadRequired: false });
    }
    if (options.expectedExtensionId !== undefined && record.extensionId !== options.expectedExtensionId) fail("bridge_extension_identity_changed");
    await verifyInstalled(record, currentDestination, stateDirectory);
    return Object.freeze({
      installed: true,
      extensionId: record.extensionId,
      version: record.extensionVersion,
      releaseManifestSha256: record.releaseManifestSha256,
      activeFolderChallenge: record.activeFolderChallenge ? Object.freeze({ ...record.activeFolderChallenge }) : null,
      manualChromeReloadRequired: record.pendingUpdate !== null
    });
  };
  // Ordinary status remains read-only. A durable interrupted swap is the one
  // startup state that status repairs before it reports the installed bytes.
  // Either transaction file is such a swap, and the lock converges both.
  if (await exists(updateTransactionPath(stateDirectory))
    || await exists(rollbackTransactionPath(stateDirectory))) return lock(stateDirectory, readStatus);
  return readStatus();
}

async function prepareBridgeUpdate(options = {}) {
  if (typeof options.requestQuiescence !== "function" || typeof options.resumeQuiescence !== "function") fail("bridge_quiesce_contract_required");
  const release = await readReleaseManifest(options);
  const destination = await stableDestination(options.bridgeDirectory);
  const stateDirectory = await ensurePrivateDirectory(options.stateDirectory, "bridge_state_directory_invalid");
  if (under(release.sourceDirectory, destination.path) || under(destination.path, release.sourceDirectory)) fail("bridge_directory_overlap");

  return lock(stateDirectory, async () => {
    const record = await loadRecord(stateDirectory);
    if (!record) fail("bridge_installation_untrusted");
    if (options.expectedExtensionId !== undefined && record.extensionId !== options.expectedExtensionId) fail("bridge_extension_identity_changed");
    await verifyInstalled(record, destination, stateDirectory);
    if (record.pendingUpdate) fail("bridge_update_confirmation_pending");
    const versionComparison = compareChromeVersions(parseChromeVersion(release.version), parseChromeVersion(record.extensionVersion));
    if (release.extensionId !== record.extensionId || versionComparison <= 0) fail("bridge_update_not_newer");
    if (!sameStrings(release.permissions, record.permissions) || !sameStrings(release.hostPermissions, record.hostPermissions)
      || !sameStrings(release.optionalHostPermissions, record.optionalHostPermissions)) fail("bridge_update_permission_changed");
    if (!record.activeFolderChallenge) fail("bridge_active_folder_unconfirmed");

    let stage = null;
    try {
      stage = await makeStage(destination.path);
      await copyRelease(release, stage);
      const nextChallenge = await writeChallengeFile(stage, release, options.nextChallenge);
      await verifyDirectoryReceipt(stage, release.files, "bridge_stage_invalid", true);
      await verifyExtensionManifest(stage, release, "bridge_stage_invalid");
      const response = await options.requestQuiescence({ extensionId: record.extensionId, manifestVersion: record.extensionVersion });
      const quiesced = quiescedStatus(response, record);
      try {
        await verifyDirectoryReceipt(stage, release.files, "bridge_stage_invalid", true);
        const backupRoot = await ensurePrivateDirectory(path.join(stateDirectory, "bridge-backups"), "bridge_backup_directory_invalid");
        const transactionId = crypto.randomUUID();
        const backup = path.join(backupRoot, `${record.extensionVersion}-${transactionId}`);
        const nextRecord = recordFromRelease(destination.path, release, nextChallenge, {
          backupDirectory: backup,
          fromVersion: record.extensionVersion,
          quiesceEpoch: quiesced.quiesceEpoch,
          previousRecord: installationRecordDocument(record)
        });
        const transaction = {
          schema: UPDATE_TRANSACTION_SCHEMA,
          transactionId,
          createdAt: new Date().toISOString(),
          stageDirectory: stage,
          backupDirectory: backup,
          previousRecord: installationRecordDocument(record),
          nextRecord: installationRecordDocument(nextRecord)
        };
        await writeBridgeUpdateTransaction(stateDirectory, transaction);
        // The durable transaction owns this stage now. Cleanup must preserve it
        // if a rename or state write fails so the next start can converge it.
        stage = null;
        try {
          await recoverBridgeUpdateTransaction(stateDirectory);
        } catch {
          throw errorAfterQuiesce("bridge_swap_recovery_required", { resume: { attempted: false, resumed: false } });
        }
        const installed = { ...await stableDestination(destination.path), exists: true };
        return Object.freeze({
          updated: true,
          bridgeDirectory: installed.path,
          extensionId: release.extensionId,
          previousVersion: record.extensionVersion,
          version: release.version,
          backupDirectory: backup,
          quiesceEpoch: quiesced.quiesceEpoch,
          manualChromeReloadRequired: true
        });
      } catch (error) {
        if (error instanceof BridgeUpdateError) throw error;
        const resume = await resumeIfSafe(options.resumeQuiescence, quiesced);
        throw errorAfterQuiesce("bridge_update_after_quiesce_failed", {}, resume);
      }
    } finally {
      if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

async function verifiedPendingBridgeUpdate(options, stateDirectory, destination) {
  const record = await loadRecord(stateDirectory);
  if (!record?.pendingUpdate) fail("bridge_update_confirmation_missing");
  if (options.expectedExtensionId !== undefined && record.extensionId !== options.expectedExtensionId) fail("bridge_extension_identity_changed");
  await verifyInstalled(record, destination, stateDirectory);
  const backup = await lstatDirectory(record.pendingUpdate.backupDirectory, "bridge_rollback_missing");
  if (backup !== record.pendingUpdate.backupDirectory) fail("bridge_rollback_missing");
  const status = options.extensionReadback;
  if (!objectKeys(status, ["activeFolderProof", "extensionId", "installType", "manifestVersion", "schema"])
    || status.schema !== READBACK_SCHEMA || status.extensionId !== record.extensionId
    || status.manifestVersion !== record.extensionVersion || status.installType !== "development") fail("bridge_update_readback_unconfirmed");
  proofMatches(status.activeFolderProof, record.activeFolderChallenge, record.extensionId, record.extensionVersion, "bridge_active_folder_unconfirmed");
  return { record, backup };
}

async function inspectPendingBridgeUpdate(options = {}) {
  const stateDirectory = await ensurePrivateDirectory(options.stateDirectory, "bridge_state_directory_invalid");
  const destination = await stableDestination(options.bridgeDirectory);
  return lock(stateDirectory, async () => {
    const { record } = await verifiedPendingBridgeUpdate(options, stateDirectory, destination);
    return Object.freeze({
      extensionId: record.extensionId,
      previousVersion: record.pendingUpdate.fromVersion,
      version: record.extensionVersion,
      quiesceEpoch: record.pendingUpdate.quiesceEpoch,
    });
  });
}

async function confirmBridgeUpdate(options = {}) {
  const stateDirectory = await ensurePrivateDirectory(options.stateDirectory, "bridge_state_directory_invalid");
  const destination = await stableDestination(options.bridgeDirectory);
  return lock(stateDirectory, async () => {
    const { record, backup } = await verifiedPendingBridgeUpdate(options, stateDirectory, destination);
    const updated = { ...record, pendingUpdate: null };
    await writeRecord(stateDirectory, updated);
    const removed = await removeRollbackCopy(backup);
    return Object.freeze({
      confirmed: true,
      extensionId: record.extensionId,
      version: record.extensionVersion,
      backupDirectory: backup,
      rollbackCopy: removed ? "removed" : "rollback_copy_retained"
    });
  });
}

async function rollbackPendingBridgeUpdate(options = {}) {
  const stateDirectory = await ensurePrivateDirectory(options.stateDirectory, "bridge_state_directory_invalid");
  const destination = await stableDestination(options.bridgeDirectory);
  return lock(stateDirectory, async () => {
    const record = await loadRecord(stateDirectory);
    if (!record?.pendingUpdate) fail("bridge_update_confirmation_missing");
    if (!record.pendingUpdate.previousRecord) fail("bridge_rollback_record_missing");
    if (options.expectedExtensionId !== undefined && record.extensionId !== options.expectedExtensionId) fail("bridge_extension_identity_changed");
    await verifyInstalled(record, destination, stateDirectory);
    const previous = record.pendingUpdate.previousRecord;
    const previousBackup = await lstatDirectory(record.pendingUpdate.backupDirectory, "bridge_rollback_missing");
    if (previousBackup !== record.pendingUpdate.backupDirectory
      || !await recordMatchesDirectory(previous, previousBackup)) fail("bridge_rollback_missing");
    const transactionId = crypto.randomUUID();
    const currentBackup = path.join(stateDirectory, "bridge-backups", `${record.extensionVersion}-failed-${transactionId}`);
    const transaction = {
      schema: ROLLBACK_TRANSACTION_SCHEMA,
      transactionId,
      createdAt: new Date().toISOString(),
      currentBackupDirectory: currentBackup,
      previousBackupDirectory: previousBackup,
      currentRecord: installationRecordDocument(record),
      previousRecord: installationRecordDocument(previous)
    };
    await writeBridgeRollbackTransaction(stateDirectory, transaction);
    let restored;
    try {
      restored = await recoverBridgeRollbackTransaction(stateDirectory);
    } catch {
      fail("bridge_rollback_recovery_required");
    }
    const removed = await removeRollbackCopy(restored.discardedDirectory);
    return Object.freeze({
      rolledBack: true,
      extensionId: previous.extensionId,
      version: previous.extensionVersion,
      quiesceEpoch: record.pendingUpdate.quiesceEpoch,
      failedReleaseCopy: removed ? "removed" : "rollback_copy_retained"
    });
  });
}

// Startup cleanup for rollback copies an interrupted update left behind. The
// copy the current record still references is never removed.
async function pruneBridgeRollbackCopies(options = {}) {
  const empty = Object.freeze({ removed: Object.freeze([]), referenced: Object.freeze([]), retained: Object.freeze([]) });
  const stateDirectory = await readOnlyStateDirectory(options.stateDirectory);
  if (!stateDirectory) return empty;
  const backupRoot = path.join(stateDirectory, "bridge-backups");
  return lock(stateDirectory, async () => {
    const record = await loadRecord(stateDirectory);
    const referenced = record?.pendingUpdate ? [record.pendingUpdate.backupDirectory] : [];
    let entries;
    try { entries = await fs.readdir(backupRoot); }
    catch (error) {
      if (error?.code === "ENOENT") return Object.freeze({ ...empty, referenced: Object.freeze(referenced) });
      fail("bridge_backup_directory_invalid");
    }
    const removed = [];
    const retained = [];
    for (const name of entries.sort()) {
      const candidate = path.join(backupRoot, name);
      if (referenced.includes(candidate)) continue;
      if (await removeRollbackCopy(candidate)) removed.push(candidate);
      else retained.push(candidate);
    }
    return Object.freeze({
      removed: Object.freeze(removed),
      referenced: Object.freeze(referenced),
      retained: Object.freeze(retained)
    });
  });
}

module.exports = {
  ACTIVE_FOLDER_MARKER,
  BridgeUpdateError,
  bridgeInstallationStatus,
  compareChromeVersions,
  confirmBridgeUpdate,
  discardBridgeTransactions,
  inspectPendingBridgeUpdate,
  initializeBridgeDirectory,
  issueBridgeActiveFolderChallenge,
  parseChromeVersion,
  prepareBridgeUpdate,
  pruneBridgeRollbackCopies,
  readReleaseManifest,
  rollbackPendingBridgeUpdate
};
