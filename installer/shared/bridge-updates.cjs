"use strict";

// This module changes only the app-owned unpacked Bridge directory. Electron
// main must provide paths and the release-manifest hash from its signed payload.

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const RELEASE_SCHEMA = "morrow.bridge-release.v1";
const INSTALLATION_SCHEMA = "morrow.bridge-installation.v1";
const CHALLENGE_SCHEMA = "morrow.bridge.active-folder-challenge.v1";
const PROOF_SCHEMA = "morrow.bridge.active-folder-proof.v1";
const QUIESCED_SCHEMA = "morrow.bridge.update-quiesced.v1";
const RESUMED_SCHEMA = "morrow.bridge.update-resumed.v1";
const READBACK_SCHEMA = "morrow.bridge.update-readback.v1";
const LOCK_SCHEMA = "morrow.bridge.update-lock.v1";
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
  const manifest = json(bytes.toString("utf8"), code);
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
  const release = releaseMetadata(json(bytes.toString("utf8"), "bridge_release_manifest_invalid"));
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

function lockDocument() {
  return `${JSON.stringify({ schema: LOCK_SCHEMA, pid: process.pid, startedAt: new Date().toISOString() })}\n`;
}

function livePid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

// A lock is reclaimable only when it names no running process and was started
// longer ago than the window. A lock file written by an earlier app version
// names no process, so its modification time bounds it instead.
async function reclaimableLock(lockPath) {
  let info;
  try { info = await fs.lstat(lockPath); } catch { return false; }
  if (!info.isFile() || info.isSymbolicLink()) return false;
  let content;
  try { content = (await fs.readFile(lockPath)).toString("utf8"); } catch { return false; }
  let startedAt = info.mtimeMs;
  let parsed = null;
  try { parsed = JSON.parse(content); } catch { parsed = null; }
  if (objectKeys(parsed, ["pid", "schema", "startedAt"]) && parsed.schema === LOCK_SCHEMA) {
    if (livePid(parsed.pid)) return false;
    const recorded = Date.parse(parsed.startedAt);
    if (Number.isFinite(recorded)) startedAt = recorded;
  }
  return Date.now() - startedAt >= LOCK_STALE_MS;
}

async function openLock(lockPath) {
  const handle = await fs.open(lockPath, "wx", 0o600);
  try {
    await handle.writeFile(lockDocument());
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return handle;
}

async function acquireLock(lockPath) {
  try { return await openLock(lockPath); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  if (!await reclaimableLock(lockPath)) fail("bridge_update_busy");
  await fs.rm(lockPath, { force: true }).catch(() => undefined);
  try { return await openLock(lockPath); }
  catch (error) { if (error?.code === "EEXIST") fail("bridge_update_busy"); throw error; }
}

async function lock(stateDirectory, callback) {
  const lockPath = path.join(stateDirectory, "bridge-update.lock");
  const handle = await acquireLock(lockPath);
  try { return await callback(); }
  finally {
    await handle.close().catch(() => undefined);
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
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

function inspectPendingUpdate(value, extension, version, stateDirectory) {
  if (value === null || value === undefined) return null;
  if (!objectKeys(value, ["backupDirectory", "fromVersion", "quiesceEpoch"])
    || !parseChromeVersion(value.fromVersion) || !identifier(value.quiesceEpoch, 16, 256)
    || typeof value.backupDirectory !== "string" || !path.isAbsolute(value.backupDirectory)) fail("bridge_installation_record_invalid");
  const backup = path.resolve(value.backupDirectory);
  if (!under(path.join(stateDirectory, "bridge-backups"), backup)) fail("bridge_installation_record_invalid");
  return Object.freeze({ backupDirectory: backup, fromVersion: value.fromVersion, quiesceEpoch: value.quiesceEpoch, extensionId: extension, extensionVersion: version });
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
  const pendingUpdate = inspectPendingUpdate(value.pendingUpdate, value.extensionId, value.extensionVersion, stateDirectory);
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
  return inspectInstallationRecord(json((await fs.readFile(file)).toString("utf8"), "bridge_installation_record_invalid"), stateDirectory);
}

async function writeRecord(stateDirectory, record) {
  const destination = recordPath(stateDirectory);
  const temporary = `${destination}.tmp-${crypto.randomUUID()}`;
  const content = `${JSON.stringify(record)}\n`;
  try {
    await fs.writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, destination);
    if (process.platform !== "win32") await fs.chmod(destination, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
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

async function restoreOriginalBridge(destination, backup) {
  const failed = path.join(path.dirname(destination), `.morrow-bridge-failed-${crypto.randomUUID()}`);
  try {
    if (await exists(destination)) await fs.rename(destination, failed);
    await fs.rename(backup, destination);
    await fs.rm(failed, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
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
    return Object.freeze({ installed: false, extensionId: null, version: null, activeFolderChallenge: null, manualChromeReloadRequired: false });
  }
  const record = await loadRecord(stateDirectory);
  if (!record) {
    if (destination.exists) fail("bridge_installation_untrusted");
    return Object.freeze({ installed: false, extensionId: null, version: null, activeFolderChallenge: null, manualChromeReloadRequired: false });
  }
  if (options.expectedExtensionId !== undefined && record.extensionId !== options.expectedExtensionId) fail("bridge_extension_identity_changed");
  await verifyInstalled(record, destination, stateDirectory);
  return Object.freeze({
    installed: true,
    extensionId: record.extensionId,
    version: record.extensionVersion,
    activeFolderChallenge: record.activeFolderChallenge ? Object.freeze({ ...record.activeFolderChallenge }) : null,
    manualChromeReloadRequired: record.pendingUpdate !== null
  });
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
    if (release.extensionId !== record.extensionId || compareChromeVersions(parseChromeVersion(release.version), parseChromeVersion(record.extensionVersion)) <= 0) fail("bridge_update_not_newer");
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
        const backup = path.join(backupRoot, `${record.extensionVersion}-${crypto.randomUUID()}`);
        await fs.rename(destination.path, backup);
        try {
          await fs.rename(stage, destination.path);
          stage = null;
        } catch (error) {
          const restored = await restoreOriginalBridge(destination.path, backup);
          const resume = restored ? await resumeIfSafe(options.resumeQuiescence, quiesced) : { attempted: false, resumed: false };
          throw errorAfterQuiesce(restored ? "bridge_swap_failed" : "bridge_swap_recovery_required", { resume });
        }
        const installed = { ...await stableDestination(destination.path), exists: true };
        const nextRecord = recordFromRelease(installed.path, release, nextChallenge, {
          backupDirectory: backup,
          fromVersion: record.extensionVersion,
          quiesceEpoch: quiesced.quiesceEpoch
        });
        try {
          await writeRecord(stateDirectory, nextRecord);
        } catch (error) {
          const restored = await restoreOriginalBridge(destination.path, backup);
          const resume = restored ? await resumeIfSafe(options.resumeQuiescence, quiesced) : { attempted: false, resumed: false };
          throw errorAfterQuiesce(restored ? "bridge_state_write_failed" : "bridge_swap_recovery_required", { resume });
        }
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

async function confirmBridgeUpdate(options = {}) {
  const stateDirectory = await ensurePrivateDirectory(options.stateDirectory, "bridge_state_directory_invalid");
  const destination = await stableDestination(options.bridgeDirectory);
  return lock(stateDirectory, async () => {
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
  initializeBridgeDirectory,
  issueBridgeActiveFolderChallenge,
  parseChromeVersion,
  prepareBridgeUpdate,
  pruneBridgeRollbackCopies,
  readReleaseManifest
};
