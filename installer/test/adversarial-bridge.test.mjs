/**
 * Adversarial verification of the app-owned Morrow Bridge folder, from the
 * position of something already on this computer that wants Morrow to act on a
 * path or a record it did not write: a folder replaced by a link, a file inside
 * the installed folder replaced by a link, a record that points a rollback copy
 * somewhere else, and an interrupted update whose confirmation no longer holds.
 *
 * Every case runs the shipped installer/shared/bridge-updates.cjs. None of them
 * needs Chrome: the Chrome half of each conversation is the exact document the
 * Bridge would return, so the refusals here are the refusals the app performs.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ACTIVE_FOLDER_MARKER,
  BridgeUpdateError,
  bridgeInstallationStatus,
  confirmBridgeUpdate,
  initializeBridgeDirectory,
  prepareBridgeUpdate,
  pruneBridgeRollbackCopies
} from "../shared/bridge-updates.cjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionKey = JSON.parse(readFileSync(path.join(here, "../../connector/extension/manifest.json"), "utf8")).key;
const extensionId = "abeloclekioohahgedmjcdbpllfjfhko";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** One sealed Bridge release, built the way the packaged app ships it. */
async function fixture(root, version) {
  const bundled = await fs.mkdtemp(path.join(root, `bundle-${version}-`));
  const sourceDirectory = path.join(bundled, "extension");
  await fs.mkdir(path.join(sourceDirectory, "src"), { recursive: true });
  const manifest = {
    manifest_version: 3,
    name: "Morrow Bridge fixture",
    version,
    key: extensionKey,
    permissions: ["storage", "tabs"],
    host_permissions: ["http://127.0.0.1/*"],
    optional_host_permissions: ["https://*/*"],
    background: { service_worker: "src/service-worker.js", type: "module" }
  };
  await fs.writeFile(path.join(sourceDirectory, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  await fs.writeFile(path.join(sourceDirectory, "src", "service-worker.js"), `export const version = ${JSON.stringify(version)};\n`);
  await fs.writeFile(path.join(sourceDirectory, "settings.html"), "<main>Morrow Bridge</main>\n");
  const files = [];
  for (const relative of ["manifest.json", "settings.html", "src/service-worker.js"]) {
    const content = await fs.readFile(path.join(sourceDirectory, relative));
    files.push({ path: relative, bytes: content.byteLength, sha256: sha256(content) });
  }
  const release = {
    schema: "morrow.bridge-release.v1",
    extensionId,
    version,
    manifestSha256: sha256(await fs.readFile(path.join(sourceDirectory, "manifest.json"))),
    permissions: manifest.permissions,
    hostPermissions: manifest.host_permissions,
    optionalHostPermissions: manifest.optional_host_permissions,
    files
  };
  const releaseManifestPath = path.join(bundled, "manifest.json");
  await fs.writeFile(releaseManifestPath, `${JSON.stringify(release)}\n`);
  return {
    sourceDirectory,
    releaseManifestPath,
    trustedReleaseManifestSha256: sha256(await fs.readFile(releaseManifestPath)),
    expectedExtensionId: extensionId
  };
}

function challenge(label) {
  return { challengeId: `${label}-challenge-id`, nonce: `${label}-nonce-value-with-enough-entropy` };
}

function proof(activeFolderChallenge, manifestVersion = activeFolderChallenge.manifestVersion) {
  return {
    schema: "morrow.bridge.active-folder-proof.v1",
    extensionId,
    manifestVersion,
    challengeId: activeFolderChallenge.challengeId,
    nonce: activeFolderChallenge.nonce,
    challengeSha256: activeFolderChallenge.sha256
  };
}

/** What the Bridge in Chrome answers after a swap, for these exact facts. */
function readback(activeFolderChallenge, { installType = "development", manifestVersion = activeFolderChallenge.manifestVersion } = {}) {
  return {
    schema: "morrow.bridge.update-readback.v1",
    extensionId,
    manifestVersion,
    installType,
    activeFolderProof: proof(activeFolderChallenge, manifestVersion)
  };
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

async function record(stateDirectory) {
  return JSON.parse(await fs.readFile(path.join(stateDirectory, "bridge-installation.json"), "utf8"));
}

async function writeRecord(stateDirectory, value) {
  await fs.writeFile(path.join(stateDirectory, "bridge-installation.json"), `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

async function present(value) {
  return fs.lstat(value).then(() => true, () => false);
}

async function assertBridgeError(callback, code) {
  await assert.rejects(callback, (error) => {
    assert.ok(error instanceof BridgeUpdateError, `expected a bounded Bridge error, received ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

/** A folder of a person's own files, used as the target of every planted link. */
async function ownFolder(root, name = "Documents") {
  const directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "syllabus.docx"), "course materials");
  return directory;
}

async function untouched(directory) {
  assert.deepEqual(await fs.readdir(directory), ["syllabus.docx"]);
  assert.equal(await fs.readFile(path.join(directory, "syllabus.docx"), "utf8"), "course materials");
}

async function temporaryRoot(t, label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `morrow-adversarial-${label}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("a Bridge folder that is a link is refused, and the folder it points at is left alone", async (t) => {
  const root = await temporaryRoot(t, "bridge-link");
  const stateDirectory = path.join(root, "UserData", "State");
  const bridgeDirectory = path.join(root, "UserData", "Bridge");
  const documents = await ownFolder(root);
  await fs.mkdir(path.join(root, "UserData"), { recursive: true });
  await fs.symlink(documents, bridgeDirectory, "dir");
  const release = await fixture(root, "1.0.2");

  await assertBridgeError(() => initializeBridgeDirectory({ ...release, stateDirectory, bridgeDirectory, initialChallenge: challenge("linked") }), "bridge_directory_invalid");
  await assertBridgeError(() => bridgeInstallationStatus({ stateDirectory, bridgeDirectory, expectedExtensionId: extensionId }), "bridge_directory_invalid");
  await untouched(documents);
  assert.equal(await present(stateDirectory), false, "a refused Bridge folder must not leave a state folder behind");
});

test("a state folder that is a link is refused before anything is written through it", async (t) => {
  const root = await temporaryRoot(t, "state-link");
  const stateDirectory = path.join(root, "UserData", "State");
  const bridgeDirectory = path.join(root, "UserData", "Bridge");
  const documents = await ownFolder(root);
  await fs.mkdir(path.join(root, "UserData"), { recursive: true });
  await fs.symlink(documents, stateDirectory, "dir");
  const release = await fixture(root, "1.0.2");

  await assertBridgeError(() => initializeBridgeDirectory({ ...release, stateDirectory, bridgeDirectory, initialChallenge: challenge("linked") }), "bridge_state_directory_invalid");
  await assertBridgeError(() => bridgeInstallationStatus({ stateDirectory, bridgeDirectory }), "bridge_state_directory_invalid");
  await assertBridgeError(() => pruneBridgeRollbackCopies({ stateDirectory }), "bridge_state_directory_invalid");
  await untouched(documents);
  assert.equal(await present(bridgeDirectory), false, "a refused state folder must not leave a Bridge folder behind");
});

test("a file inside the installed Bridge folder replaced by a link is refused", async (t) => {
  const root = await temporaryRoot(t, "bridge-file-link");
  const stateDirectory = path.join(root, "UserData", "State");
  const bridgeDirectory = path.join(root, "UserData", "Bridge");
  const release = await fixture(root, "1.0.2");
  await initializeBridgeDirectory({ ...release, stateDirectory, bridgeDirectory, initialChallenge: challenge("installed") });
  assert.equal((await bridgeInstallationStatus({ stateDirectory, bridgeDirectory, expectedExtensionId: extensionId })).installed, true);

  // The link points at a file whose bytes are exactly the sealed ones, so only
  // the file type separates it from the release Morrow installed.
  const settings = path.join(bridgeDirectory, "settings.html");
  const elsewhere = path.join(root, "settings-copy.html");
  await fs.copyFile(settings, elsewhere);
  await fs.rm(settings);
  await fs.symlink(elsewhere, settings);

  await assertBridgeError(() => bridgeInstallationStatus({ stateDirectory, bridgeDirectory, expectedExtensionId: extensionId }), "bridge_release_symlink_refused");
  const newer = await fixture(root, "1.0.3");
  await assertBridgeError(() => prepareBridgeUpdate({
    ...newer,
    stateDirectory,
    bridgeDirectory,
    nextChallenge: challenge("after-link"),
    requestQuiescence: async () => assert.fail("the update asked Chrome to stop work over an unverified folder"),
    resumeQuiescence: async () => undefined
  }), "bridge_release_symlink_refused");
  assert.equal(await fs.readFile(path.join(bridgeDirectory, "src/service-worker.js"), "utf8"), 'export const version = "1.0.2";\n');
});

test("an interrupted update cannot be confirmed once its rollback copy is gone or is a link", async (t) => {
  const root = await temporaryRoot(t, "rollback-missing");
  const stateDirectory = path.join(root, "UserData", "State");
  const bridgeDirectory = path.join(root, "UserData", "Bridge");
  const documents = await ownFolder(root);
  const release = await fixture(root, "1.0.2");
  const initial = await initializeBridgeDirectory({ ...release, stateDirectory, bridgeDirectory, initialChallenge: challenge("before") });
  const updated = await stageUpdate(root, stateDirectory, bridgeDirectory, initial.activeFolderChallenge, "1.0.2", "1.0.3");
  const staged = await record(stateDirectory);

  await fs.rm(updated.backupDirectory, { recursive: true, force: true });
  const confirm = () => confirmBridgeUpdate({ stateDirectory, bridgeDirectory, expectedExtensionId: extensionId, extensionReadback: readback(staged.activeFolderChallenge) });
  await assertBridgeError(confirm, "bridge_rollback_missing");
  assert.equal((await record(stateDirectory)).pendingUpdate.fromVersion, "1.0.2", "a refused confirmation must keep the pending update");
  assert.equal((await bridgeInstallationStatus({ stateDirectory, bridgeDirectory })).manualChromeReloadRequired, true);

  // A rollback copy replaced by a link is the same refusal, so the confirmation
  // never removes the folder such a link points at.
  await fs.symlink(documents, updated.backupDirectory, "dir");
  await assertBridgeError(confirm, "bridge_rollback_missing");
  await untouched(documents);
  assert.equal((await record(stateDirectory)).pendingUpdate.fromVersion, "1.0.2");
});

test("a stale Chrome answer, and one from a Store installation, cannot confirm an interrupted update", async (t) => {
  const root = await temporaryRoot(t, "stale-answer");
  const stateDirectory = path.join(root, "UserData", "State");
  const bridgeDirectory = path.join(root, "UserData", "Bridge");
  const release = await fixture(root, "1.0.2");
  const initial = await initializeBridgeDirectory({ ...release, stateDirectory, bridgeDirectory, initialChallenge: challenge("before") });
  const updated = await stageUpdate(root, stateDirectory, bridgeDirectory, initial.activeFolderChallenge, "1.0.2", "1.0.3");
  const staged = await record(stateDirectory);

  // A Chrome still running the folder as it was before the swap answers with
  // the challenge that folder held, under the version the record now names.
  await assertBridgeError(() => confirmBridgeUpdate({
    stateDirectory,
    bridgeDirectory,
    expectedExtensionId: extensionId,
    extensionReadback: readback(initial.activeFolderChallenge, { manifestVersion: "1.0.3" })
  }), "bridge_active_folder_unconfirmed");

  // A Bridge installed from the Chrome Web Store is not the folder this app
  // owns, so its answer cannot close the update either.
  await assertBridgeError(() => confirmBridgeUpdate({
    stateDirectory,
    bridgeDirectory,
    expectedExtensionId: extensionId,
    extensionReadback: readback(staged.activeFolderChallenge, { installType: "normal" })
  }), "bridge_update_readback_unconfirmed");

  assert.equal((await record(stateDirectory)).pendingUpdate.fromVersion, "1.0.2");
  assert.equal(await present(updated.backupDirectory), true, "an unconfirmed update must keep its rollback copy");
  assert.equal(await fs.readFile(path.join(updated.backupDirectory, "src/service-worker.js"), "utf8"), 'export const version = "1.0.2";\n');

  // The exact answer still closes it, so the refusals above are about the
  // answers themselves and not about a Bridge that can no longer be confirmed.
  const confirmed = await confirmBridgeUpdate({ stateDirectory, bridgeDirectory, expectedExtensionId: extensionId, extensionReadback: readback(staged.activeFolderChallenge) });
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.rollbackCopy, "removed");
});

test("a Chrome Web Store installation cannot start a swap of the app-owned folder", async (t) => {
  const root = await temporaryRoot(t, "store-install");
  const stateDirectory = path.join(root, "UserData", "State");
  const bridgeDirectory = path.join(root, "UserData", "Bridge");
  const release = await fixture(root, "1.0.2");
  const initial = await initializeBridgeDirectory({ ...release, stateDirectory, bridgeDirectory, initialChallenge: challenge("before") });
  const newer = await fixture(root, "1.0.3");

  await assertBridgeError(() => prepareBridgeUpdate({
    ...newer,
    stateDirectory,
    bridgeDirectory,
    nextChallenge: challenge("store"),
    requestQuiescence: async () => ({
      schema: "morrow.bridge.update-quiesced.v1",
      extensionId,
      manifestVersion: "1.0.2",
      installType: "normal",
      quiescent: true,
      quiesceEpoch: "epoch-for-a-store-installation",
      activeFolderProof: proof(initial.activeFolderChallenge)
    }),
    resumeQuiescence: async () => ({ schema: "morrow.bridge.update-resumed.v1", extensionId, manifestVersion: "1.0.2", quiesceEpoch: "epoch-for-a-store-installation", resumed: true })
  }), "bridge_quiesce_unconfirmed");

  assert.equal(await fs.readFile(path.join(bridgeDirectory, "src/service-worker.js"), "utf8"), 'export const version = "1.0.2";\n');
  assert.equal((await record(stateDirectory)).pendingUpdate, null, "a refused swap left a pending update behind");
  assert.equal(await present(path.join(stateDirectory, "bridge-backups")), false, "a refused swap left a rollback copy behind");
  assert.equal((await fs.readdir(path.dirname(bridgeDirectory))).some((name) => name.startsWith(".morrow-bridge-stage-")), false, "a refused swap left its staged copy behind");
});

test("a record that points its rollback copy outside Morrow's own backups is refused, never followed", async (t) => {
  const root = await temporaryRoot(t, "rollback-outside");
  const stateDirectory = path.join(root, "UserData", "State");
  const bridgeDirectory = path.join(root, "UserData", "Bridge");
  const documents = await ownFolder(root);
  const release = await fixture(root, "1.0.2");
  const initial = await initializeBridgeDirectory({ ...release, stateDirectory, bridgeDirectory, initialChallenge: challenge("before") });
  await stageUpdate(root, stateDirectory, bridgeDirectory, initial.activeFolderChallenge, "1.0.2", "1.0.3");
  const staged = await record(stateDirectory);

  await writeRecord(stateDirectory, { ...staged, pendingUpdate: { ...staged.pendingUpdate, backupDirectory: documents } });
  const readbackDocument = readback(staged.activeFolderChallenge);
  await assertBridgeError(() => confirmBridgeUpdate({ stateDirectory, bridgeDirectory, expectedExtensionId: extensionId, extensionReadback: readbackDocument }), "bridge_installation_record_invalid");
  await assertBridgeError(() => bridgeInstallationStatus({ stateDirectory, bridgeDirectory }), "bridge_installation_record_invalid");
  await assertBridgeError(() => pruneBridgeRollbackCopies({ stateDirectory }), "bridge_installation_record_invalid");
  await untouched(documents);
});

test("startup pruning removes only what is inside the backups folder and never follows a link out of it", async (t) => {
  const root = await temporaryRoot(t, "prune-link");
  const stateDirectory = path.join(root, "UserData", "State");
  const bridgeDirectory = path.join(root, "UserData", "Bridge");
  const documents = await ownFolder(root);
  const release = await fixture(root, "1.0.2");
  await initializeBridgeDirectory({ ...release, stateDirectory, bridgeDirectory, initialChallenge: challenge("before") });
  const backupRoot = path.join(await fs.realpath(stateDirectory), "bridge-backups");
  await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const planted = path.join(backupRoot, "1.0.1-planted-link");
  await fs.symlink(documents, planted, "dir");

  const pruned = await pruneBridgeRollbackCopies({ stateDirectory });
  assert.deepEqual(pruned.removed, [planted]);
  assert.deepEqual(pruned.retained, []);
  assert.equal(await present(planted), false, "the link itself is Morrow's own file and is removed");
  await untouched(documents);
});

test("the Bridge record and the update lock are private files inside a private folder", {
  skip: process.platform === "win32" ? "POSIX modes; the Windows access-control classification needs a Windows host" : false
}, async (t) => {
  const root = await temporaryRoot(t, "bridge-modes");
  const stateDirectory = path.join(root, "UserData", "State");
  const bridgeDirectory = path.join(root, "UserData", "Bridge");
  const release = await fixture(root, "1.0.2");
  const initial = await initializeBridgeDirectory({ ...release, stateDirectory, bridgeDirectory, initialChallenge: challenge("modes") });
  const mode = async (value) => (await fs.lstat(value)).mode & 0o777;
  assert.equal(await mode(stateDirectory), 0o700);
  assert.equal(await mode(path.join(stateDirectory, "bridge-installation.json")), 0o600);
  assert.equal(await mode(bridgeDirectory), 0o700);
  assert.equal(await mode(path.join(bridgeDirectory, ACTIVE_FOLDER_MARKER)), 0o600);

  let lockMode = null;
  const next = await fixture(root, "1.0.3");
  await prepareBridgeUpdate({
    ...next,
    stateDirectory,
    bridgeDirectory,
    nextChallenge: challenge("locked"),
    requestQuiescence: async () => {
      lockMode = await mode(path.join(stateDirectory, "bridge-update.lock"));
      return {
        schema: "morrow.bridge.update-quiesced.v1",
        extensionId,
        manifestVersion: "1.0.2",
        installType: "development",
        quiescent: true,
        quiesceEpoch: "epoch-for-the-1.0.2-worker",
        activeFolderProof: proof(initial.activeFolderChallenge)
      };
    },
    resumeQuiescence: async () => ({ schema: "morrow.bridge.update-resumed.v1", extensionId, manifestVersion: "1.0.2", quiesceEpoch: "epoch-for-the-1.0.2-worker", resumed: true })
  });
  assert.equal(lockMode, 0o600);
});
