#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMacSmokeBinding, assertAppReceipt } from "./desktop-mac-smoke.mjs";
import { electronAsarReleaseIdentity, readElectronAsarPackage } from "../lib/electron-asar-package.mjs";
import { runOwnedProcess } from "../lib/owned-process.mjs";
import { bridgeReleaseManifest } from "../package-mcp-bundle.mjs";

export const BRIDGE_VERSION = "1.0.138";
export const BRIDGE_SEAL = "6730a9c62c55a9dceabde15e63c128465a6e23518fd4f70f86cbedbd263376c6";
const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EXTENSION_ID = "abeloclekioohahgedmjcdbpllfjfhko";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function remoteRunnerRequired(environment = process.env, platform = process.platform, architecture = process.arch) {
  if (environment.GITHUB_ACTIONS !== "true" || environment.GITHUB_WORKFLOW !== "sealed Desktop Bridge qualification"
    || platform !== "darwin" || architecture !== "arm64") throw new Error("remote_macos_actions_runner_required");
}

export function verifyQaSource(record, source, qaRun) {
  if (!/^[0-9a-f]{40}$/.test(source) || !/^[1-9][0-9]*$/.test(qaRun)
    || record.databaseId !== Number(qaRun) || record.headSha !== source || record.conclusion !== "success"
    || record.workflowName !== "desktop installer QA") throw new Error("successful_qa_source_binding_required");
}

export function qualifyRetainedCheckout(receipt, { version, head }) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("checkout_desktop_version_required");
  if (!/^[0-9a-f]{40}$/.test(head || "")) throw new Error("checkout_head_required");
  if (receipt?.version !== version) throw new Error("retained_desktop_version_mismatch");
  if (receipt?.source?.head !== head || receipt?.source?.dirty !== false) throw new Error("retained_source_head_mismatch");
}

export function checkoutBridgeReleaseBytes(extensionRoot = resolve(DESKTOP_ROOT, "connector/extension")) {
  return Buffer.from(`${JSON.stringify(bridgeReleaseManifest(extensionRoot), null, 2)}\n`);
}

export function assertPackagedBridgeMatchesCheckout(packagedBytes, checkoutBytes) {
  if (!Buffer.isBuffer(packagedBytes) || !Buffer.isBuffer(checkoutBytes) || sha256(packagedBytes) !== sha256(checkoutBytes)) {
    throw new Error("packaged_bridge_does_not_match_checkout");
  }
}

export function verifyRetainedPackageContract(receipt) {
  assert.equal(receipt.schema, "morrow.desktop-installer.v1", "retained_installer_schema_required");
  assert.equal(receipt.target, "darwin-arm64", "retained_native_target_required");
  assert.deepEqual(receipt.signing, { mode: "unsigned_public_release", target: "darwin-arm64",
    publicRelease: true, automaticUpdates: false }, "retained_unsigned_release_signing_required");
  assert.equal(receipt.bridgeDelivery, "developer_temporary", "retained_unpacked_bridge_delivery_required");
  assert.equal(receipt.verification?.electronAsarAndBridge, true, "packaged_bridge_verification_required");
}

export async function verifySealedBridge(root, releaseBytes, { activeFolderMarker = false, expectedSeal = BRIDGE_SEAL } = {}) {
  if (sha256(releaseBytes) !== expectedSeal) throw new Error("exact_bridge_release_seal_required");
  const release = JSON.parse(releaseBytes);
  if (release.schema !== "morrow.bridge-release.v1" || release.version !== BRIDGE_VERSION
    || release.extensionId !== EXTENSION_ID || !Array.isArray(release.files) || release.files.length === 0) {
    throw new Error("exact_bridge_release_identity_required");
  }
  const seen = new Set();
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("bridge_root_directory_required");
  for (const file of release.files) {
    if (typeof file.path !== "string" || !file.path || file.path.includes("\\") || isAbsolute(file.path)
      || file.path.split("/").some((part) => !part || part === "." || part === "..") || seen.has(file.path)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      throw new Error("bridge_file_record_invalid");
    }
    seen.add(file.path);
    let parent = root;
    for (const part of file.path.split("/")) {
      parent = join(parent, part);
      if ((await lstat(parent)).isSymbolicLink()) throw new Error("bridge_symbolic_link_refused");
    }
    const info = await lstat(parent);
    const bytes = await readFile(parent);
    if (!info.isFile() || bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error("sealed_bridge_file_changed");
  }
  const inspect = async (directory, prefix = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await inspect(join(directory, entry.name), `${name}/`);
      else if (!entry.isFile() || (!seen.has(name) && !(activeFolderMarker && name === "morrow-bridge-active-folder.json"))) {
        throw new Error("unsealed_bridge_file_refused");
      }
    }
  };
  await inspect(root);
  return { version: release.version, manifestSha256: release.manifestSha256, files: release.files.length,
    workerSha256: release.files.find((file) => file.path === "src/service-worker.js")?.sha256 };
}

function argumentsOf(values) {
  const args = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    if (!["--artifact-directory", "--package-source", "--qa-run", "--qa-record", "--artifact-metadata", "--receipt"].includes(name)
      || Object.hasOwn(args, name) || !values[index + 1]) throw new Error("sealed_bridge_arguments_invalid");
    args[name] = values[index + 1];
  }
  if (Object.keys(args).length !== 6 || ["--artifact-directory", "--qa-record", "--artifact-metadata", "--receipt"].some((name) => !isAbsolute(args[name]))) {
    throw new Error("sealed_bridge_absolute_paths_required");
  }
  return args;
}

async function run(command, args, environment = process.env) {
  const result = await runOwnedProcess(command, args, { timeoutMs: 300_000, environment, maxOutputBytes: 128 * 1024 });
  if (result.code !== 0) throw new Error(`owned_process_failed:${result.code ?? "unknown"}`);
}

async function waitFor(read, accepted, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (accepted(value)) return value;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error("sealed_bridge_authoritative_readback_timeout");
}

async function main() {
  remoteRunnerRequired();
  const args = argumentsOf(process.argv.slice(2));
  const source = args["--package-source"];
  const qaRun = args["--qa-run"];
  verifyQaSource(JSON.parse(await readFile(args["--qa-record"], "utf8")), source, qaRun);
  const artifactRecords = JSON.parse(await readFile(args["--artifact-metadata"], "utf8")).artifacts;
  const matching = artifactRecords.filter((item) => item.name === `morrow-macos-desktop-${qaRun}`);
  assert.equal(matching.length, 1, "one_bound_github_artifact_required");
  const artifactRecord = matching[0];
  assert.equal(artifactRecord.workflow_run.head_sha, source, "artifact_source_mismatch");
  assert.equal(artifactRecord.workflow_run.id, Number(qaRun), "artifact_run_mismatch");
  assert.equal(artifactRecord.expired, false, "artifact_expired");
  assert.match(artifactRecord.digest, /^sha256:[0-9a-f]{64}$/);
  const artifacts = args["--artifact-directory"];
  const images = (await readdir(artifacts)).filter((file) => file.endsWith(".dmg"));
  assert.equal(images.length, 1, "one_retained_disk_image_required");
  const diskImage = join(artifacts, images[0]);
  const packageReceipt = join(artifacts, "package-receipt.json");
  const binding = await createMacSmokeBinding({ diskImage, packageReceipt, source, runId: randomUUID().replaceAll("-", "") });
  const packageRecord = JSON.parse(await readFile(packageReceipt, "utf8"));
  verifyRetainedPackageContract(packageRecord);
  const checkoutHead = String(process.env.GITHUB_SHA || "").toLowerCase();
  if (source !== checkoutHead) throw new Error("package_source_is_not_checkout");
  const checkoutVersion = JSON.parse(await readFile(resolve(DESKTOP_ROOT, "package.json"), "utf8")).version;
  qualifyRetainedCheckout(packageRecord, { version: checkoutVersion, head: checkoutHead });
  const checkoutBridge = checkoutBridgeReleaseBytes();
  const checkoutSeal = sha256(checkoutBridge);
  const root = await realpath(await mkdtemp(join(tmpdir(), "morrow-sealed-bridge-")));
  const mount = join(root, "mounted");
  await mkdir(mount);
  let mounted = false;
  let application;
  let browser;
  let stage = "mount";
  try {
    await run("/usr/bin/hdiutil", ["attach", diskImage, "-nobrowse", "-readonly", "-mountpoint", mount]);
    mounted = true;
    const bundles = (await readdir(mount)).filter((name) => name.endsWith(".app"));
    assert.equal(bundles.length, 1, "one_retained_application_required");
    const app = join(mount, bundles[0]);
    const resources = join(app, "Contents", "Resources");
    const appPackage = readElectronAsarPackage(join(resources, "app.asar"));
    const installedPackage = electronAsarReleaseIdentity(appPackage, binding);
    assert.equal(appPackage.morrow?.bridgeRelease?.manifestSha256, checkoutSeal, "asar_bridge_seal_mismatch");
    const releaseRoot = join(resources, "MorrowPayload", "app", "bridge-release");
    const releaseBytes = await readFile(join(releaseRoot, "manifest.json"));
    assertPackagedBridgeMatchesCheckout(releaseBytes, checkoutBridge);
    const bridgeIdentity = await verifySealedBridge(join(releaseRoot, "extension"), releaseBytes, { expectedSeal: checkoutSeal });
    const testRoot = join(root, "contained");
    await mkdir(testRoot);
    const environment = { ...process.env, MORROW_INSTALLER_TEST_MODE: "1" };
    const executable = join(app, "Contents", "MacOS", "Morrow");
    const startupReceipt = join(testRoot, "startup.json");
    const networkRules = "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1";
    stage = "contained_packaged_startup";
    await run(executable, [`--morrow-test-root=${testRoot}`, `--morrow-smoke-receipt=${startupReceipt}`,
      "--morrow-smoke-install-codex", networkRules], environment);
    assertAppReceipt(JSON.parse(await readFile(startupReceipt, "utf8")), { bridgePortFree: true });
    stage = "packaged_desktop_gateway";
    const { _electron, chromium } = await import("playwright");
    application = await _electron.launch({ executablePath: executable, args: [`--morrow-test-root=${testRoot}`, networkRules],
      env: environment, timeout: 60_000 });
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(globalThis.morrowInstaller));
    const readState = () => window.evaluate(async () => globalThis.morrowInstaller.invoke("installer:get-state", { recheckAssistants: true }));
    const ready = await waitFor(readState, (value) => value?.state?.runtime?.status === "ready");
    assert.equal(ready.ok, true, "packaged_state_refused");
    assert.equal(ready.state.bridge.paired, false, "fresh_gateway_must_start_unpaired");
    const bridgeFolder = ready.state.bridge.folderPath;
    assert.equal(typeof bridgeFolder, "string", "installed_bridge_folder_required");
    assert.ok(resolve(bridgeFolder).startsWith(`${resolve(testRoot)}/`), "bridge_folder_outside_containment");
    await verifySealedBridge(bridgeFolder, releaseBytes, { activeFolderMarker: true, expectedSeal: checkoutSeal });
    stage = "exact_bridge_pairing";
    browser = await chromium.launchPersistentContext(join(root, "cft-profile"), { headless: false,
      args: [`--disable-extensions-except=${bridgeFolder}`, `--load-extension=${bridgeFolder}`, networkRules,
        "--no-first-run", "--no-default-browser-check"] });
    const onboarding = await waitFor(async () => browser.pages().find((page) => page.url() === `chrome-extension://${EXTENSION_ID}/onboarding/onboarding.html`), Boolean);
    await onboarding.getByRole("button", { name: "Agree and continue", exact: true }).click();
    const popup = await browser.newPage();
    await popup.goto(`chrome-extension://${EXTENSION_ID}/popup/popup.html`);
    await popup.getByRole("button", { name: "Pair Morrow", exact: true }).click();
    await popup.locator("#status-value").filter({ hasText: /^Connected$/ }).waitFor({ timeout: 30_000 });
    stage = "packaged_authoritative_readback";
    const paired = await waitFor(readState, (value) => value?.state?.bridge?.paired === true);
    assert.equal(paired.state.runtime.status, "ready", "packaged_runtime_not_ready_after_pairing");
    assert.equal(paired.state.bridge.loadedInChrome, true, "exact_active_bridge_not_proven");
    const worker = browser.serviceWorkers().find((value) => value.url() === `chrome-extension://${EXTENSION_ID}/src/service-worker.js`);
    assert.ok(worker, "exact_bridge_worker_missing");
    const observed = await worker.evaluate(async () => ({ version: chrome.runtime.getManifest().version,
      workerSha256: [...new Uint8Array(await crypto.subtle.digest("SHA-256", await (await fetch(chrome.runtime.getURL("src/service-worker.js"))).arrayBuffer()))]
        .map((byte) => byte.toString(16).padStart(2, "0")).join("") }));
    assert.equal(observed.version, BRIDGE_VERSION, "loaded_bridge_version_mismatch");
    assert.equal(observed.workerSha256, bridgeIdentity.workerSha256, "loaded_bridge_worker_changed");
    await verifySealedBridge(bridgeFolder, releaseBytes, { activeFolderMarker: true, expectedSeal: checkoutSeal });
    await verifySealedBridge(join(releaseRoot, "extension"), releaseBytes, { expectedSeal: checkoutSeal });
    await createMacSmokeBinding({ diskImage, packageReceipt, source, runId: binding.runId });
    await mkdir(dirname(args["--receipt"]), { recursive: true });
    await writeFile(args["--receipt"], `${JSON.stringify({ schema: "morrow.sealed-desktop-bridge-proof.v1", status: "passed",
      qaRun, signing: packageRecord.signing, artifact: { id: artifactRecord.id, name: artifactRecord.name, digest: artifactRecord.digest,
        sizeInBytes: artifactRecord.size_in_bytes }, binding, installedPackage, harnessSource: process.env.GITHUB_SHA, bridge: { ...bridgeIdentity, sealedManifestSha256: checkoutSeal,
        extensionId: EXTENSION_ID, loadedWorkerSha256: observed.workerSha256, filesUnchanged: true },
      readback: { gatewayReady: true, desktopBridgePaired: true, desktopBridgeLoadedInChrome: true, popupConnected: true },
      limits: ["unsigned QA package", "no signed-in provider or course", "no signing or notarization proof", "macOS Apple silicon only"] }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log("Exact sealed Bridge paired with retained packaged Desktop; authoritative readback passed.");
  } catch (error) {
    console.error(`sealed-desktop-bridge failed at ${stage}: ${error.name}: ${error.message}`);
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([browser?.close(), application?.close()]);
    let detachError;
    try { if (mounted) await run("/usr/bin/hdiutil", ["detach", mount]); } catch (error) { detachError = error; }
    if (!detachError) await rm(root, { recursive: true, force: true });
    const failure = cleanup.find((result) => result.status === "rejected");
    if (detachError || failure) await rm(args["--receipt"], { force: true });
    if (detachError) throw detachError;
    if (failure) throw failure.reason;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
