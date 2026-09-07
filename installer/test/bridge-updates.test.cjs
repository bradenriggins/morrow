"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const {
  ACTIVE_FOLDER_MARKER,
  BridgeUpdateError,
  bridgeInstallationStatus,
  confirmBridgeUpdate,
  initializeBridgeDirectory,
  issueBridgeActiveFolderChallenge,
  prepareBridgeUpdate,
  pruneBridgeRollbackCopies,
  readReleaseManifest
} = require("../shared/bridge-updates.cjs");

const extensionKey = JSON.parse(require("node:fs").readFileSync(path.join(__dirname, "../../connector/extension/manifest.json"), "utf8")).key;
const extensionId = "abeloclekioohahgedmjcdbpllfjfhko";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function fixture(root, version, options = {}) {
  const bundled = path.join(root, `bundle-${version}-${crypto.randomUUID()}`);
  const sourceDirectory = path.join(bundled, "extension");
  await fs.mkdir(path.join(sourceDirectory, "src"), { recursive: true });
  const manifest = {
    manifest_version: 3,
    name: "Morrow Bridge fixture",
    version,
    key: extensionKey,
    permissions: options.permissions || ["storage", "tabs"],
    host_permissions: options.hostPermissions || ["http://127.0.0.1/*"],
    optional_host_permissions: options.optionalHostPermissions || ["https://*/*"],
    background: { service_worker: "src/service-worker.js", type: "module" }
  };
  await fs.writeFile(path.join(sourceDirectory, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  await fs.writeFile(path.join(sourceDirectory, "src", "service-worker.js"), `export const version = ${JSON.stringify(version)};\n`);
  await fs.writeFile(path.join(sourceDirectory, "settings.html"), "<main>Morrow Bridge</main>\n");
  const paths = ["manifest.json", "settings.html", "src/service-worker.js"];
  const files = [];
  for (const relative of paths) {
    const content = await fs.readFile(path.join(sourceDirectory, relative));
    files.push({ path: relative, bytes: content.byteLength, sha256: sha256(content) });
  }
  const manifestContent = await fs.readFile(path.join(sourceDirectory, "manifest.json"));
  const release = {
    schema: "morrow.bridge-release.v1",
    extensionId,
    version,
    manifestSha256: sha256(manifestContent),
    permissions: manifest.permissions,
    hostPermissions: manifest.host_permissions,
    optionalHostPermissions: manifest.optional_host_permissions,
    files
  };
  const releaseManifestPath = path.join(bundled, "manifest.json");
  await fs.writeFile(releaseManifestPath, `${JSON.stringify(release)}\n`);
  return { sourceDirectory, releaseManifestPath, trustedReleaseManifestSha256: sha256(await fs.readFile(releaseManifestPath)), expectedExtensionId: extensionId };
}

function challenge(label) {
  return { challengeId: `${label}-challenge-id`, nonce: `${label}-nonce-value-with-enough-entropy` };
}

function proof(activeFolderChallenge) {
  return {
    schema: "morrow.bridge.active-folder-proof.v1",
    extensionId,
    manifestVersion: activeFolderChallenge.manifestVersion,
    challengeId: activeFolderChallenge.challengeId,
    nonce: activeFolderChallenge.nonce,
    challengeSha256: activeFolderChallenge.sha256
  };
}

async function record(stateDirectory) {
  return JSON.parse(await fs.readFile(path.join(stateDirectory, "bridge-installation.json"), "utf8"));
}

function lockPath(stateDirectory) {
  return path.join(stateDirectory, "bridge-update.lock");
}

function backupRoot(stateDirectory) {
  return path.join(stateDirectory, "bridge-backups");
}

async function present(value) {
  return fs.lstat(value).then(() => true, () => false);
}

/** A process identifier that named a real process and no longer names one. */
function exitedPid() {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  assert.equal(child.status, 0);
  return child.pid;
}

async function stageUpdate(root, stateDirectory, bridgeDirectory, activeFolderChallenge, fromVersion, toVersion) {
  const next = await fixture(root, toVersion);
  const quiesceEpoch = `epoch-for-the-${fromVersion}-worker`;
  return prepareBridgeUpdate({
    ...next,
    stateDirectory,
    bridgeDirectory,
    nextChallenge: challenge(`to-${toVersion}`),
    requestQuiescence: async () => ({
      schema: "morrow.bridge.update-quiesced.v1",
      extensionId,
      manifestVersion: fromVersion,
      installType: "development",
      quiescent: true,
      quiesceEpoch,
      activeFolderProof: proof(activeFolderChallenge)
    }),
    resumeQuiescence: async () => ({ schema: "morrow.bridge.update-resumed.v1", extensionId, manifestVersion: fromVersion, quiesceEpoch, resumed: true })
  });
}

function readback(activeFolderChallenge) {
  return {
    schema: "morrow.bridge.update-readback.v1",
    extensionId,
    manifestVersion: activeFolderChallenge.manifestVersion,
    installType: "development",
    activeFolderProof: proof(activeFolderChallenge)
  };
}

async function assertBridgeError(callback, code) {
  await assert.rejects(callback, (error) => error instanceof BridgeUpdateError && error.code === code);
}

test("read-only installation status does not create a Bridge or rotate its active-folder challenge", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-bridge-status-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, "State");
  const bridgeDirectory = path.join(root, "Bridge");
  assert.deepEqual(await bridgeInstallationStatus({ stateDirectory, bridgeDirectory }), {
    installed: false,
    extensionId: null,
    version: null,
    activeFolderChallenge: null,
    manualChromeReloadRequired: false
  });
  assert.equal(await fs.stat(stateDirectory).then(() => true, () => false), false);
  assert.equal(await fs.stat(bridgeDirectory).then(() => true, () => false), false);

  const release = await fixture(root, "1.0.2");
  const initial = await initializeBridgeDirectory({ ...release, stateDirectory, bridgeDirectory, initialChallenge: challenge("stable") });
  const marker = await fs.readFile(path.join(bridgeDirectory, ACTIVE_FOLDER_MARKER));
  const status = await bridgeInstallationStatus({ stateDirectory, bridgeDirectory, expectedExtensionId: extensionId });
  assert.deepEqual(status, {
    installed: true,
    extensionId,
    version: "1.0.2",
    activeFolderChallenge: initial.activeFolderChallenge,
    manualChromeReloadRequired: false
  });
  assert.deepEqual(await fs.readFile(path.join(bridgeDirectory, ACTIVE_FOLDER_MARKER)), marker);
});

test("the app initializes only an exact signed-payload receipt and records an app-owned stable Bridge directory", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-bridge-update-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, "UserData", "State");
  const bridgeDirectory = path.join(root, "UserData", "Bridge");
  const release = await fixture(root, "1.0.2");
  const installed = await initializeBridgeDirectory({ ...release, stateDirectory, bridgeDirectory, initialChallenge: challenge("initial") });
  assert.equal(installed.initialized, true);
  assert.equal(installed.extensionId, extensionId);
  assert.equal(installed.version, "1.0.2");
  assert.equal(await fs.readFile(path.join(bridgeDirectory, "src/service-worker.js"), "utf8"), 'export const version = "1.0.2";\n');
  const saved = await record(stateDirectory);
  assert.equal(saved.bridgeDirectory, await fs.realpath(bridgeDirectory));
  assert.equal(saved.extensionVersion, "1.0.2");
  assert.equal(saved.activeFolderChallenge.challengeId, "initial-challenge-id");
  assert.equal(await fs.readFile(path.join(bridgeDirectory, ACTIVE_FOLDER_MARKER), "utf8").then(sha256), saved.activeFolderChallenge.sha256);

  await assertBridgeError(() => initializeBridgeDirectory({ ...release, trustedReleaseManifestSha256: "0".repeat(64), stateDirectory, bridgeDirectory }), "bridge_release_manifest_untrusted");
  await fs.writeFile(path.join(release.sourceDirectory, "src/service-worker.js"), "changed");
  await assertBridgeError(() => readReleaseManifest(release), "bridge_release_files_invalid");
});

test("a challenge is exact stable-directory evidence for a later authenticated Bridge reply", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-bridge-challenge-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, "State");
  const bridgeDirectory = path.join(root, "Bridge");
  const release = await fixture(root, "1.0.2");
  await initializeBridgeDirectory({ ...release, stateDirectory, bridgeDirectory });
  const issued = await issueBridgeActiveFolderChallenge({ stateDirectory, bridgeDirectory, expectedExtensionId: extensionId, challenge: challenge("fresh") });
  assert.equal(issued.activeFolderChallenge.challengeId, "fresh-challenge-id");
  const content = JSON.parse(await fs.readFile(path.join(bridgeDirectory, ACTIVE_FOLDER_MARKER), "utf8"));
  assert.deepEqual(content, {
    schema: "morrow.bridge.active-folder-challenge.v1",
    extensionId,
    manifestVersion: "1.0.2",
    challengeId: "fresh-challenge-id",
    nonce: "fresh-nonce-value-with-enough-entropy"
  });
  await fs.writeFile(path.join(bridgeDirectory, ACTIVE_FOLDER_MARKER), "unexpected");
  await assertBridgeError(() => issueBridgeActiveFolderChallenge({ stateDirectory, bridgeDirectory, challenge: challenge("other") }), "bridge_active_folder_marker_changed");
});

test("a newer unpacked Bridge is staged before quiescence, swaps once, and keeps a rollback copy only until exact readback", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-bridge-swap-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, "UserData", "State");
  const bridgeDirectory = path.join(root, "UserData", "Bridge");
  const initial = await fixture(root, "1.0.2");
  const initialResult = await initializeBridgeDirectory({ ...initial, stateDirectory, bridgeDirectory, initialChallenge: challenge("old") });
  const next = await fixture(root, "1.0.3");
  let quiesceCalls = 0;
  let resumeCalls = 0;
  const updated = await prepareBridgeUpdate({
    ...next,
    stateDirectory,
    bridgeDirectory,
    nextChallenge: challenge("new"),
    requestQuiescence: async ({ extensionId: requestedId, manifestVersion }) => {
      quiesceCalls += 1;
      assert.equal(requestedId, extensionId);
      assert.equal(manifestVersion, "1.0.2");
      assert.equal((await fs.readdir(path.dirname(bridgeDirectory))).some((name) => name.startsWith(".morrow-bridge-stage-")), true);
      assert.equal(await fs.readFile(path.join(bridgeDirectory, "src/service-worker.js"), "utf8"), 'export const version = "1.0.2";\n');
      const held = JSON.parse(await fs.readFile(lockPath(stateDirectory), "utf8"));
      assert.equal(held.schema, "morrow.bridge.update-lock.v1");
      assert.equal(held.pid, process.pid);
      assert.equal(Number.isFinite(Date.parse(held.startedAt)), true);
      return {
        schema: "morrow.bridge.update-quiesced.v1",
        extensionId,
        manifestVersion,
        installType: "development",
        quiescent: true,
        quiesceEpoch: "epoch-for-the-exact-old-worker",
        activeFolderProof: proof(initialResult.activeFolderChallenge)
      };
    },
    resumeQuiescence: async () => { resumeCalls += 1; return { schema: "morrow.bridge.update-resumed.v1", extensionId, manifestVersion: "1.0.2", quiesceEpoch: "epoch-for-the-exact-old-worker", resumed: true }; }
  });
  assert.equal(quiesceCalls, 1);
  assert.equal(resumeCalls, 0);
  assert.equal(updated.manualChromeReloadRequired, true);
  assert.equal(updated.previousVersion, "1.0.2");
  assert.equal(updated.version, "1.0.3");
  assert.equal(await fs.readFile(path.join(bridgeDirectory, "src/service-worker.js"), "utf8"), 'export const version = "1.0.3";\n');
  assert.equal(await fs.readFile(path.join(updated.backupDirectory, "src/service-worker.js"), "utf8"), 'export const version = "1.0.2";\n');
  const staged = await record(stateDirectory);
  assert.equal(staged.pendingUpdate.fromVersion, "1.0.2");
  assert.equal(staged.activeFolderChallenge.challengeId, "new-challenge-id");
  assert.deepEqual(await bridgeInstallationStatus({ stateDirectory, bridgeDirectory, expectedExtensionId: extensionId }), {
    installed: true,
    extensionId,
    version: "1.0.3",
    activeFolderChallenge: staged.activeFolderChallenge,
    manualChromeReloadRequired: true
  });

  const extensionReadback = readback(staged.activeFolderChallenge);
  assert.equal(extensionReadback.manifestVersion, "1.0.3");
  const confirmed = await confirmBridgeUpdate({ stateDirectory, bridgeDirectory, expectedExtensionId: extensionId, extensionReadback });
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.backupDirectory, updated.backupDirectory);
  assert.equal(confirmed.rollbackCopy, "removed");
  assert.equal(await present(updated.backupDirectory), false);
  assert.deepEqual(await fs.readdir(backupRoot(stateDirectory)), []);
  assert.equal((await record(stateDirectory)).pendingUpdate, null);
  assert.equal((await bridgeInstallationStatus({ stateDirectory, bridgeDirectory })).manualChromeReloadRequired, false);
  assert.equal(await present(lockPath(stateDirectory)), false);
  await assertBridgeError(() => confirmBridgeUpdate({ stateDirectory, bridgeDirectory, expectedExtensionId: extensionId, extensionReadback }), "bridge_update_confirmation_missing");
});

test("the update refuses target drift, permissions, Store status, and old versions without a Bridge replacement", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-bridge-refusal-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, "State");
  const bridgeDirectory = path.join(root, "Bridge");
  const initial = await fixture(root, "1.0.2");
  const initialResult = await initializeBridgeDirectory({ ...initial, stateDirectory, bridgeDirectory, initialChallenge: challenge("current") });
  const callbackOptions = {
    requestQuiescence: async () => ({
      schema: "morrow.bridge.update-quiesced.v1",
      extensionId,
      manifestVersion: "1.0.2",
      installType: "normal",
      quiescent: true,
      quiesceEpoch: "epoch-for-normal-store-install",
      activeFolderProof: proof(initialResult.activeFolderChallenge)
    }),
    resumeQuiescence: async () => ({ schema: "morrow.bridge.update-resumed.v1", extensionId, manifestVersion: "1.0.2", quiesceEpoch: "epoch-for-normal-store-install", resumed: true }),
    nextChallenge: challenge("next")
  };
  const newer = await fixture(root, "1.0.3");
  await assertBridgeError(() => prepareBridgeUpdate({ ...newer, stateDirectory, bridgeDirectory, ...callbackOptions }), "bridge_quiesce_unconfirmed");
  assert.equal(await fs.readFile(path.join(bridgeDirectory, "src/service-worker.js"), "utf8"), 'export const version = "1.0.2";\n');
  assert.equal((await fs.readdir(path.dirname(bridgeDirectory))).some((name) => name.startsWith(".morrow-bridge-stage-")), false);

  const permissionChanged = await fixture(root, "1.0.3", { permissions: ["storage", "tabs", "alarms"] });
  await assertBridgeError(() => prepareBridgeUpdate({ ...permissionChanged, stateDirectory, bridgeDirectory, ...callbackOptions }), "bridge_update_permission_changed");
  const old = await fixture(root, "1.0.1");
  await assertBridgeError(() => prepareBridgeUpdate({ ...old, stateDirectory, bridgeDirectory, ...callbackOptions }), "bridge_update_not_newer");

  await fs.writeFile(path.join(bridgeDirectory, "unexpected.txt"), "no");
  await assertBridgeError(() => prepareBridgeUpdate({ ...newer, stateDirectory, bridgeDirectory, ...callbackOptions }), "bridge_installation_target_changed");
});

test("Bridge maintenance reclaims a lock whose process is gone and is older than the stale window, and never one a live process holds", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-bridge-lock-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, "State");
  const bridgeDirectory = path.join(root, "Bridge");
  const release = await fixture(root, "1.0.2");
  await initializeBridgeDirectory({ ...release, stateDirectory, bridgeDirectory, initialChallenge: challenge("locked") });
  const outsideWindow = new Date(Date.now() - 11 * 60 * 1000);
  const insideWindow = new Date();
  const gone = exitedPid();
  const blocked = () => issueBridgeActiveFolderChallenge({ stateDirectory, bridgeDirectory, challenge: challenge("blocked") });
  const writeLock = async (value) => fs.writeFile(lockPath(stateDirectory), `${JSON.stringify(value)}\n`, { mode: 0o600 });

  await writeLock({ schema: "morrow.bridge.update-lock.v1", pid: process.pid, startedAt: outsideWindow.toISOString() });
  await assertBridgeError(blocked, "bridge_update_busy");
  assert.equal(JSON.parse(await fs.readFile(lockPath(stateDirectory), "utf8")).pid, process.pid);

  await writeLock({ schema: "morrow.bridge.update-lock.v1", pid: gone, startedAt: insideWindow.toISOString() });
  await assertBridgeError(blocked, "bridge_update_busy");
  assert.equal(JSON.parse(await fs.readFile(lockPath(stateDirectory), "utf8")).pid, gone);

  await writeLock({ schema: "morrow.bridge.update-lock.v1", pid: gone, startedAt: outsideWindow.toISOString() });
  const reclaimed = await issueBridgeActiveFolderChallenge({ stateDirectory, bridgeDirectory, challenge: challenge("reclaimed") });
  assert.equal(reclaimed.activeFolderChallenge.challengeId, "reclaimed-challenge-id");
  assert.equal(await present(lockPath(stateDirectory)), false);

  // A lock file an earlier app version left behind names no process at all.
  await fs.writeFile(lockPath(stateDirectory), "", { mode: 0o600 });
  await assertBridgeError(blocked, "bridge_update_busy");
  await fs.utimes(lockPath(stateDirectory), outsideWindow, outsideWindow);
  const legacy = await issueBridgeActiveFolderChallenge({ stateDirectory, bridgeDirectory, challenge: challenge("afterlegacy") });
  assert.equal(legacy.activeFolderChallenge.challengeId, "afterlegacy-challenge-id");
  assert.equal(await present(lockPath(stateDirectory)), false);
});

test("startup pruning removes a rollback copy the record does not reference and keeps the one it does", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-bridge-prune-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, "State");
  const bridgeDirectory = path.join(root, "Bridge");
  const missing = path.join(root, "Missing");
  assert.deepEqual(await pruneBridgeRollbackCopies({ stateDirectory: missing }), { removed: [], referenced: [], retained: [] });
  assert.equal(await present(missing), false);

  const release = await fixture(root, "1.0.2");
  const initial = await initializeBridgeDirectory({ ...release, stateDirectory, bridgeDirectory, initialChallenge: challenge("beforeprune") });
  assert.deepEqual(await pruneBridgeRollbackCopies({ stateDirectory }), { removed: [], referenced: [], retained: [] });

  const updated = await stageUpdate(root, stateDirectory, bridgeDirectory, initial.activeFolderChallenge, "1.0.2", "1.0.3");
  const orphan = path.join(await fs.realpath(backupRoot(stateDirectory)), "1.0.1-interrupted-update");
  await fs.mkdir(orphan, { recursive: true });
  await fs.writeFile(path.join(orphan, "manifest.json"), "{}\n");
  const pruned = await pruneBridgeRollbackCopies({ stateDirectory });
  assert.deepEqual(pruned, { removed: [orphan], referenced: [updated.backupDirectory], retained: [] });
  assert.equal(await present(orphan), false);
  assert.equal(await fs.readFile(path.join(updated.backupDirectory, "src/service-worker.js"), "utf8"), 'export const version = "1.0.2";\n');

  const staged = await record(stateDirectory);
  const confirmed = await confirmBridgeUpdate({ stateDirectory, bridgeDirectory, expectedExtensionId: extensionId, extensionReadback: readback(staged.activeFolderChallenge) });
  assert.equal(confirmed.rollbackCopy, "removed");
  assert.deepEqual(await pruneBridgeRollbackCopies({ stateDirectory }), { removed: [], referenced: [], retained: [] });
  assert.deepEqual(await fs.readdir(backupRoot(stateDirectory)), []);
});

test("a rollback copy the app cannot delete is reported retained, not reported deleted", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("directory permissions do not stop removal for this platform or user");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-bridge-retained-"));
  const stateDirectory = path.join(root, "State");
  const bridgeDirectory = path.join(root, "Bridge");
  t.after(async () => {
    await fs.chmod(backupRoot(stateDirectory), 0o700).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  });
  const release = await fixture(root, "1.0.2");
  const initial = await initializeBridgeDirectory({ ...release, stateDirectory, bridgeDirectory, initialChallenge: challenge("retained") });
  const updated = await stageUpdate(root, stateDirectory, bridgeDirectory, initial.activeFolderChallenge, "1.0.2", "1.0.3");
  const staged = await record(stateDirectory);
  await fs.chmod(backupRoot(stateDirectory), 0o500);

  const confirmed = await confirmBridgeUpdate({ stateDirectory, bridgeDirectory, expectedExtensionId: extensionId, extensionReadback: readback(staged.activeFolderChallenge) });
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.rollbackCopy, "rollback_copy_retained");
  assert.equal(await present(updated.backupDirectory), true);
  assert.equal((await record(stateDirectory)).pendingUpdate, null);
  assert.equal((await bridgeInstallationStatus({ stateDirectory, bridgeDirectory })).manualChromeReloadRequired, false);

  const blocked = await pruneBridgeRollbackCopies({ stateDirectory });
  assert.deepEqual(blocked, { removed: [], referenced: [], retained: [updated.backupDirectory] });
  await fs.chmod(backupRoot(stateDirectory), 0o700);
  const pruned = await pruneBridgeRollbackCopies({ stateDirectory });
  assert.deepEqual(pruned, { removed: [updated.backupDirectory], referenced: [], retained: [] });
  assert.equal(await present(updated.backupDirectory), false);
});
