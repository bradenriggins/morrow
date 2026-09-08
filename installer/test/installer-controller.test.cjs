"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createInstallerController, readCommandOutput, readMacApplicationBundleIdentifier } = require("../shared/installer-controller.cjs");
const { freshRecord } = require("../shared/state-policy.cjs");

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-installer-controller-"));
  await fs.mkdir(path.join(root, "UserData"), { recursive: true });
  await fs.mkdir(path.join(root, "Home"), { recursive: true });
  await fs.mkdir(path.join(root, "Payload"), { recursive: true });
  test.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function controller(root, overrides = {}) {
  return createInstallerController({
    app: { getPath: (name) => (name === "userData" ? path.join(root, "UserData") : root) },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openPath: async () => "", openExternal: async () => {}, showItemInFolder: () => {} },
    platform: process.platform,
    homeDirectory: path.join(root, "Home"),
    testRoot: null,
    isTestMode: false,
    payloadRoot: path.join(root, "Payload"),
    productVersion: "1.0.0-rc.0",
    trustedBridgeReleaseManifestSha256: () => null,
    trustedMcpRuntimeManifestSha256: () => null,
    detectAssistant: async () => false,
    runCli: async () => ({ code: 0, stdout: "", stderr: "" }),
    ...overrides
  });
}

/**
 * Writes the sealed files `isComplete` requires plus an MCP runtime manifest
 * that `verifyMcpRuntime` accepts, and returns that manifest digest.
 */
async function completePayload(root, options = {}) {
  const payload = path.join(root, "Payload");
  const app = path.join(payload, "app");
  const node = process.platform === "win32"
    ? path.join(payload, "runtime", "node", "node.exe")
    : path.join(payload, "runtime", "node", "bin", "node");
  await fs.mkdir(path.dirname(node), { recursive: true });
  await fs.writeFile(node, "node fixture");
  for (const relative of [
    "packages/client-config/dist/cli.js",
    "packages/canvas-connector-mcp/dist/index.js",
    "bridge-release/manifest.json",
    "bridge-release/extension/manifest.json",
    "connector/extension/manifest.json"
  ]) {
    const target = path.join(app, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "fixture");
  }
  await fs.mkdir(path.join(app, "installer"), { recursive: true });
  await fs.writeFile(path.join(app, "installer", "runtime-monitor.mjs"), options.runtimeMonitor || "export function createRuntimeMonitor() { return {}; }\n");

  // The gateway runs as ESM from app/packages while its sealed copy under
  // app/node_modules carries the digests the manifest binds.
  const gatewayFiles = [
    ["package.json", JSON.stringify({ name: "@morrow-lms/gateway", version: "1.0.0-rc.0", type: "module" })],
    ["dist/index.js", "gateway entrypoint"],
    ["dist/local-owner-maintenance.js", options.maintenance || "export function localOwnerMaintenanceMarkerPresent() { return false; }\n"],
    ["dist/local-owner-sidecar-access.js", "sidecar fixture"]
  ];
  const files = [];
  for (const [relative, content] of gatewayFiles) {
    const direct = path.join(app, "packages", "mcp-server", relative);
    const installed = path.join(app, "node_modules", "@morrow-lms", "gateway", relative);
    await fs.mkdir(path.dirname(direct), { recursive: true });
    await fs.mkdir(path.dirname(installed), { recursive: true });
    await fs.writeFile(direct, content);
    await fs.writeFile(installed, content);
    files.push({ path: `node_modules/@morrow-lms/gateway/${relative}`, bytes: Buffer.byteLength(content), sha256: sha256(content) });
  }
  const entrypoint = gatewayFiles[1][1];
  const manifest = {
    schema: "morrow.mcp-runtime-manifest.v1",
    package: { name: "@morrow-lms/gateway", version: "1.0.0-rc.0" },
    entrypoint: { path: "packages/mcp-server/dist/index.js", bytes: Buffer.byteLength(entrypoint), sha256: sha256(entrypoint) },
    dependencies: [{ name: "@morrow-lms/gateway", version: "1.0.0-rc.0", packageJson: files[0], files }]
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const manifestSha256 = sha256(bytes);
  await fs.writeFile(path.join(app, "mcp-runtime-manifest.json"), bytes);
  await fs.writeFile(path.join(app, "package-input-manifest.json"), `${JSON.stringify({
    schema: "morrow.desktop-package-input.v1",
    mcpRuntime: { path: "app/mcp-runtime-manifest.json", sha256: manifestSha256 }
  })}\n`);
  return manifestSha256;
}

test("the installer record round-trips and an incompatible record is refused", async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  assert.deepEqual(await installer.record(), freshRecord());

  await installer.writeRecord({ ...freshRecord(), selectedAssistantId: "codex", configured: { codex: { target: "config", sha256: "a".repeat(64) } } });
  const stored = await installer.record();
  assert.equal(stored.selectedAssistantId, "codex");
  assert.deepEqual(stored.configured, { codex: { target: "config", sha256: "a".repeat(64) } });

  await assert.rejects(() => installer.writeRecord({ schema: "morrow.desktop-state.v2" }), /migration_required/);
  await assert.rejects(() => installer.writeRecord({ configured: ["not an object"] }), /record_invalid/);
  assert.equal((await installer.record()).selectedAssistantId, "codex", "a refused write left the stored record unchanged");

  await fs.writeFile(path.join(root, "UserData", "State", "installer.json"), `${JSON.stringify({ schema: "morrow.desktop-state.v0", version: 1 })}\n`);
  await assert.rejects(() => installer.record(), /migration_required/);
});

test("effectiveWorkspace creates the default materials folder and refuses a missing chosen folder", async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  const materials = await installer.effectiveWorkspace();
  assert.equal(materials, await fs.realpath(path.join(root, "UserData", "Materials")));
  assert.equal((await fs.stat(materials)).isDirectory(), true);

  const missing = path.join(root, "Gone");
  assert.equal(await installer.effectiveWorkspace({ ...freshRecord(), materialsFolder: missing }), null);
});

test("ensureRuntime refuses an incomplete payload and an unbound runtime digest", async () => {
  const root = await temporaryRoot();
  const incomplete = controller(root);
  await assert.rejects(() => incomplete.ensureRuntime(), (error) => error.code === "runtime_repair_required");

  const manifestSha256 = await completePayload(root);
  const unbound = controller(root);
  await assert.rejects(() => unbound.ensureRuntime(), (error) => error.code === "runtime_repair_required");

  const wrongDigest = controller(root, { trustedMcpRuntimeManifestSha256: () => "b".repeat(64) });
  await assert.rejects(() => wrongDigest.ensureRuntime(), (error) => error.code === "runtime_repair_required");

  const verified = controller(root, { trustedMcpRuntimeManifestSha256: () => manifestSha256 });
  const paths = await verified.ensureRuntime();
  assert.equal(paths.payload, path.join(root, "Payload"));
  assert.equal((await fs.stat(paths.state)).isDirectory(), true);
});

// The bounds detection depends on. Both commands are POSIX; the Windows runner
// passes the same two numbers to the same code.
test("a detection command that runs too long or answers too much is refused", { skip: process.platform === "win32" ? "POSIX only" : false }, async () => {
  const started = Date.now();
  assert.equal(await readCommandOutput("/bin/sleep", ["30"], { timeoutMs: 300, maxBytes: 1024 }), null);
  assert.ok(Date.now() - started < 5_000, "the runner stopped at its own time limit, not at the command's");

  assert.equal(await readCommandOutput("/bin/cat", ["/dev/urandom"], { timeoutMs: 2_000, maxBytes: 64 }), null);
  assert.equal(await readCommandOutput("/bin/sh", ["-c", "echo out; exit 3"], { timeoutMs: 2_000, maxBytes: 1024 }), null);
  assert.equal(await readCommandOutput(path.join(os.tmpdir(), "morrow-no-such-command"), [], { timeoutMs: 2_000, maxBytes: 1024 }), null);
  assert.equal(await readCommandOutput("/bin/echo", ["morrow"], { timeoutMs: 2_000, maxBytes: 1024 }), "morrow\n");
});

// The Windows half of this, runWindowsPowerShell, uses the same runner and
// cannot be exercised here. It needs a Windows host.
test("the macOS bundle identifier is read while the rest of the app keeps running", { skip: process.platform !== "darwin" ? "macOS only" : false }, async () => {
  const root = await temporaryRoot();
  const bundle = path.join(root, "Codex.app");
  await fs.mkdir(path.join(bundle, "Contents"), { recursive: true });
  await fs.writeFile(path.join(bundle, "Contents", "Info.plist"), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.openai.codex</string></dict></plist>',
    ""
  ].join("\n"));

  // The order proves the read did not hold the loop: work queued after it ran
  // before its answer arrived. A blocking read would answer first.
  const order = [];
  const reading = readMacApplicationBundleIdentifier(bundle).then((identifier) => {
    order.push("identifier");
    return identifier;
  });
  setImmediate(() => order.push("other work"));
  assert.equal(await reading, "com.openai.codex");
  assert.deepEqual(order, ["other work", "identifier"]);

  assert.equal(await readMacApplicationBundleIdentifier(path.join(root, "Missing.app")), null);
});

test("state() reports the repair lifecycle when the installer record cannot be read", async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  await fs.mkdir(path.join(root, "UserData", "State"), { recursive: true });
  await fs.writeFile(path.join(root, "UserData", "State", "installer.json"), "{ not json");

  const state = await installer.state();
  assert.equal(state.schema, "morrow.installer-state.v1");
  assert.equal(state.lifecycle, "repair_required");
  assert.equal(state.runtime.status, "repair_required");
  assert.deepEqual(state.assistants, []);
  assert.equal(state.selectedAssistantId, null);
});

test("state() reports repair for an incomplete payload and never creates the Bridge folder", async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  const state = await installer.state();
  assert.equal(state.lifecycle, "repair_required");
  assert.equal(state.runtime.status, "repair_required");
  assert.equal(state.bridge.folderReady, false);
  assert.equal(state.bridge.manualChromeReloadRequired, false);
  assert.equal(state.blackboard.status, "not_configured");
  assert.equal(state.updates.status, "unavailable");
  await assert.rejects(() => fs.stat(path.join(root, "UserData", "Bridge")), { code: "ENOENT" });
});

const BRIDGE_EXTENSION_ID = "abeloclekioohahgedmjcdbpllfjfhko";

// The two snapshots a runtime monitor fixture reports: what it says before its
// start has observed anything, and what it says after. The real monitor answers
// snapshot() with what it has observed so far, so a fixture that stands in for
// it must do the same.
const OBSERVED_MONITOR_SNAPSHOTS = [
  "const unobserved = {",
  "  schema: 'morrow.installer-runtime.v1',",
  "  health: { attempted: false, gatewayReady: 'unknown', bridgeConnected: 'unknown', canRestart: 'unknown' },",
  "  bindings: { runtimeVerifiedCourseCount: 0, selectedCourseName: null },",
  "  firstPreview: { available: 'unknown', completed: false }",
  "};",
  "const ready = {",
  "  schema: 'morrow.installer-runtime.v1',",
  "  health: { attempted: true, gatewayReady: true, bridgeConnected: false, canRestart: 'yes' },",
  "  bindings: { runtimeVerifiedCourseCount: 0, selectedCourseName: null },",
  "  firstPreview: { available: 'no', completed: false }",
  "};"
].join("\n");

function bridgeInstallation(overrides = {}) {
  return {
    installed: true,
    extensionId: BRIDGE_EXTENSION_ID,
    version: "1.0.0",
    activeFolderChallenge: {
      challengeId: "morrow-0123456789abcdef0123456789abcdef",
      nonce: "nonce-0123456789abcdef",
      extensionId: BRIDGE_EXTENSION_ID,
      manifestVersion: "1.0.0",
      sha256: "a".repeat(64)
    },
    manualChromeReloadRequired: false,
    ...overrides
  };
}

function bridgeStatusAnswer(challenge, overrides = {}) {
  return {
    schema: "morrow.bridge.update-status.v1",
    extensionId: challenge.extensionId,
    manifestVersion: challenge.manifestVersion,
    installType: "development",
    quiescent: false,
    activeFolderProof: {
      schema: "morrow.bridge.active-folder-proof.v1",
      extensionId: challenge.extensionId,
      manifestVersion: challenge.manifestVersion,
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      challengeSha256: challenge.sha256,
      ...overrides
    }
  };
}

const READY_HEALTH = { attempted: true, gatewayReady: true, bridgeConnected: false, canRestart: "yes" };

test("the reported Chrome load state comes from a proof, never from the written folder", async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  const installation = bridgeInstallation();
  const runtime = { health: { ...READY_HEALTH } };

  assert.equal(
    await installer.bridgeLoadedInChrome(bridgeInstallation({ installed: false }), runtime),
    false,
    "no verified folder means Chrome cannot have this Bridge loaded"
  );
  assert.equal(
    await installer.bridgeLoadedInChrome(installation, runtime),
    "unknown",
    "a written folder with no runtime monitor is not a proof of a Chrome load"
  );
  assert.equal(
    await installer.bridgeLoadedInChrome(installation, { health: { ...READY_HEALTH, bridgeConnected: true } }),
    true
  );

  const calls = [];
  installer.runtimeMonitor = {
    bridgeMaintenance: async (control) => {
      calls.push(control);
      return bridgeStatusAnswer(installation.activeFolderChallenge);
    }
  };
  assert.equal(await installer.bridgeLoadedInChrome(installation, runtime), true);
  assert.deepEqual(calls, [{ action: "status" }]);

  assert.equal(
    await installer.bridgeLoadedInChrome(installation, { health: { ...READY_HEALTH, gatewayReady: "unknown" } }),
    "unknown",
    "Morrow does not ask an unready gateway"
  );
  installer.bridgeLeaseId = "held";
  assert.equal(
    await installer.bridgeLoadedInChrome(installation, runtime),
    "unknown",
    "Morrow does not probe the Bridge while a Bridge maintenance lease is held"
  );
  installer.bridgeLeaseId = null;
  assert.equal(calls.length, 1);

  installer.runtimeMonitor = {
    bridgeMaintenance: async () => bridgeStatusAnswer(installation.activeFolderChallenge, { nonce: "nonce-fedcba9876543210" })
  };
  assert.equal(
    await installer.bridgeLoadedInChrome(installation, runtime),
    "unknown",
    "an answer that does not match this installation's challenge proves nothing"
  );

  installer.runtimeMonitor = { bridgeMaintenance: async () => { throw new Error("Morrow Bridge maintenance result is invalid"); } };
  assert.equal(await installer.bridgeLoadedInChrome(installation, runtime), "unknown");
});

test("state() reports the Chrome load state the Bridge itself answered", async () => {
  const root = await temporaryRoot();
  const installation = bridgeInstallation();
  const answer = bridgeStatusAnswer(installation.activeFolderChallenge);
  const manifestSha256 = await completePayload(root, {
    maintenance: [
      "export function localOwnerMaintenanceMarkerPresent() { return false; }",
      "export function readLocalOwnerMaintenanceLease() { return null; }",
      "export function requestLocalOwnerMaintenance() { return null; }",
      "export function clearDeadLocalOwnerMaintenanceLease() { return false; }",
      ""
    ].join("\n"),
    runtimeMonitor: [
      `const answer = ${JSON.stringify(answer)};`,
      OBSERVED_MONITOR_SNAPSHOTS,
      "export function createRuntimeMonitor() {",
      "  let observed = unobserved;",
      "  return {",
      "    start: async () => { await Promise.resolve(); observed = ready; return ready; },",
      "    snapshot: () => observed,",
      "    bridgeMaintenance: async (control) => control.action === 'status' ? answer : null,",
      "    close: async () => {}",
      "  };",
      "}",
      ""
    ].join("\n")
  });

  const installer = controller(root, { trustedMcpRuntimeManifestSha256: () => manifestSha256 });
  await installer.ensureRuntime();
  await fs.writeFile(path.join(root, "UserData", "State", "morrow.upstreams.json"), "{}\n");
  installer.bridgeInstallation = installation;

  // The first read starts the runtime and answers with what Morrow has already
  // observed, which is nothing yet. The read after it shows what that start found.
  const starting = await installer.state();
  assert.equal(starting.runtime.status, "uncertain");
  assert.equal(starting.bridge.loadedInChrome, "unknown");

  const state = await installer.state();
  assert.equal(state.runtime.status, "ready");
  assert.equal(state.bridge.folderReady, true);
  assert.equal(state.bridge.loadedInChrome, true);
  assert.equal(state.bridge.paired, false);

  installer.bridgeInstallation = bridgeInstallation({ activeFolderChallenge: { ...installation.activeFolderChallenge, challengeId: "morrow-ffffffffffffffffffffffffffffffff" } });
  const unconfirmed = await installer.state();
  assert.equal(unconfirmed.bridge.folderReady, true);
  assert.equal(unconfirmed.bridge.loadedInChrome, "unknown");

  await installer.closeRuntimeMonitor();
});

// A monitor whose start never finishes on its own. The test releases it, so a
// state read that waited for the start would never answer.
const HELD_MONITOR = [
  "globalThis.__morrowHeldStart = { starts: 0, finish: null };",
  OBSERVED_MONITOR_SNAPSHOTS,
  "export function createRuntimeMonitor() {",
  "  let observed = unobserved;",
  "  return {",
  "    start: () => new Promise((resolve) => {",
  "      observed = unobserved;",
  "      globalThis.__morrowHeldStart.starts += 1;",
  "      globalThis.__morrowHeldStart.finish = () => { observed = ready; resolve(ready); };",
  "    }),",
  "    snapshot: () => observed,",
  "    close: async () => {}",
  "  };",
  "}",
  ""
].join("\n");

test("a state read answers with the runtime already observed and never waits for the start", async () => {
  const root = await temporaryRoot();
  const manifestSha256 = await completePayload(root, { maintenance: MAINTENANCE_MODULE, runtimeMonitor: HELD_MONITOR });
  const installer = controller(root, { trustedMcpRuntimeManifestSha256: () => manifestSha256 });
  await installer.ensureRuntime();
  await fs.mkdir(path.join(root, "UserData", "State"), { recursive: true });
  await fs.writeFile(path.join(root, "UserData", "State", "morrow.upstreams.json"), "{}\n");

  // This read resolves while the start is still running. A read that waited for
  // it would never return, and this test would time out.
  const starting = await installer.state();
  assert.equal(starting.runtime.status, "uncertain");
  assert.equal(globalThis.__morrowHeldStart.starts, 1, "the state read started the runtime");

  globalThis.__morrowHeldStart.finish();
  const observed = await installer.state();
  assert.equal(observed.runtime.status, "ready", "the next read shows what that start found");

  await installer.closeRuntimeMonitor();
});

test("assistant detection is read once for each assistant until Check status or the time limit", async (t) => {
  const root = await temporaryRoot();
  const detections = [];
  let clock = 1_000;
  t.mock.method(Date, "now", () => clock);
  const installer = controller(root, {
    detectAssistant: async (assistant) => {
      detections.push(assistant.id);
      return false;
    }
  });

  await installer.state();
  await installer.state();
  await installer.state();
  const first = [...detections];
  assert.deepEqual(first, ["codex", "claude-code", "gemini-cli"],
    "three state reads inside the time limit read this computer once for each assistant");

  // Check status is the person asking Morrow to look again.
  await installer.state({ recheckAssistants: true });
  assert.deepEqual(detections, [...first, ...first]);

  // Inside the 60 second limit the answer is still reused.
  clock += 59_000;
  await installer.state();
  assert.deepEqual(detections, [...first, ...first]);

  clock += 2_000;
  await installer.state();
  assert.deepEqual(detections, [...first, ...first, ...first]);
});

test("setting up an assistant reads this computer again instead of reusing an answer", async () => {
  const root = await temporaryRoot();
  let detected = false;
  let reads = 0;
  const installer = controller(root, {
    detectAssistant: async () => {
      reads += 1;
      return detected;
    }
  });

  await installer.state();
  assert.equal(reads, 3);
  // The assistant was installed after that state read. Setting it up must not
  // refuse on the answer Morrow already had.
  detected = true;
  // The payload in this fixture is incomplete, so setup stops at the runtime.
  // What this case proves is the read that happened before that.
  await assert.rejects(() => installer.installAssistant("codex"), (error) => error.code === "runtime_repair_required");
  assert.equal(reads, 4, "the setup step read this computer again");
  assert.equal((await installer.state()).assistants.find((assistant) => assistant.id === "codex").detected, true,
    "the state read after it shows what that fresh read found");
});

test("dead maintenance is recovered before a runtime monitor is created", async () => {
  const root = await temporaryRoot();
  const manifestSha256 = await completePayload(root, {
    maintenance: [
      "globalThis.__morrowRuntimeOrder ??= [];",
      "export function localOwnerMaintenanceMarkerPresent() { globalThis.__morrowRuntimeOrder.push('maintenance'); return false; }",
      "export function readLocalOwnerMaintenanceLease() { return null; }",
      "export function requestLocalOwnerMaintenance() { return null; }",
      "export function clearDeadLocalOwnerMaintenanceLease() { return false; }",
      ""
    ].join("\n"),
    runtimeMonitor: [
      "globalThis.__morrowRuntimeOrder ??= [];",
      "export function createRuntimeMonitor(options) {",
      "  globalThis.__morrowRuntimeOrder.push('monitor');",
      "  return {",
      "    start: async () => ({",
      "      schema: 'morrow.installer-runtime.v1',",
      "      health: { attempted: true, gatewayReady: true, bridgeConnected: false, canRestart: 'yes' },",
      "      bindings: { runtimeVerifiedCourseCount: 0, selectedCourseName: null },",
      "      firstPreview: { available: 'no', completed: false },",
      "      journalPath: options.journalPath",
      "    }),",
      "    close: async () => { globalThis.__morrowRuntimeOrder.push('closed'); }",
      "  };",
      "}",
      ""
    ].join("\n")
  });
  globalThis.__morrowRuntimeOrder = [];

  const installer = controller(root, { trustedMcpRuntimeManifestSha256: () => manifestSha256 });
  const materials = await installer.effectiveWorkspace();
  await installer.ensureRuntime();
  await fs.writeFile(path.join(root, "UserData", "State", "morrow.upstreams.json"), "{}\n");

  const runtime = await installer.runtimeSnapshot(materials);
  assert.deepEqual(globalThis.__morrowRuntimeOrder, ["maintenance", "monitor"]);
  assert.equal(runtime.health.gatewayReady, true);
  assert.equal(runtime.journalPath, path.join(await fs.realpath(path.join(root, "UserData", "State")), "morrow.sqlite3"));

  await installer.closeRuntimeMonitor();
  assert.deepEqual(globalThis.__morrowRuntimeOrder, ["maintenance", "monitor", "closed"]);
});

const BRIDGE_EXTENSION_KEY = JSON.parse(require("node:fs").readFileSync(path.join(__dirname, "..", "..", "connector", "extension", "manifest.json"), "utf8")).key;

const MAINTENANCE_MODULE = [
  "export function localOwnerMaintenanceMarkerPresent() { return false; }",
  "export function readLocalOwnerMaintenanceLease() { return null; }",
  "export function requestLocalOwnerMaintenance() { return null; }",
  "export function clearDeadLocalOwnerMaintenanceLease() { return false; }",
  ""
].join("\n");

// Records the order Morrow starts and stops the runtime, so a test can prove
// repair stopped the running runtime before it read anything.
const RECORDING_MONITOR = [
  "globalThis.__morrowRepairOrder ??= [];",
  OBSERVED_MONITOR_SNAPSHOTS,
  "const observedReady = { ...ready, health: { ...ready.health, canRestart: 'unknown' } };",
  "export function createRuntimeMonitor() {",
  "  globalThis.__morrowRepairOrder.push('monitor');",
  "  let observed = unobserved;",
  "  return {",
  "    start: async () => { await Promise.resolve(); observed = observedReady; return observedReady; },",
  "    snapshot: () => observed,",
  "    close: async () => { globalThis.__morrowRepairOrder.push('closed'); }",
  "  };",
  "}",
  ""
].join("\n");

/** Writes a sealed Bridge release into the payload and returns its digest. */
async function writeBridgeRelease(root, version = "1.0.0") {
  const release = path.join(root, "Payload", "app", "bridge-release");
  const source = path.join(release, "extension");
  await fs.mkdir(path.join(source, "src"), { recursive: true });
  const manifest = {
    manifest_version: 3,
    name: "Morrow Bridge fixture",
    version,
    key: BRIDGE_EXTENSION_KEY,
    permissions: ["storage"],
    host_permissions: [],
    optional_host_permissions: ["https://*/*"],
    background: { service_worker: "src/service-worker.js", type: "module" }
  };
  await fs.writeFile(path.join(source, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  await fs.writeFile(path.join(source, "src", "service-worker.js"), `export const version = ${JSON.stringify(version)};\n`);
  const files = [];
  for (const relative of ["manifest.json", "src/service-worker.js"]) {
    const content = await fs.readFile(path.join(source, relative));
    files.push({ path: relative, bytes: content.byteLength, sha256: sha256(content) });
  }
  const document = {
    schema: "morrow.bridge-release.v1",
    extensionId: BRIDGE_EXTENSION_ID,
    version,
    manifestSha256: files[0].sha256,
    permissions: manifest.permissions,
    hostPermissions: manifest.host_permissions,
    optionalHostPermissions: manifest.optional_host_permissions,
    files
  };
  const manifestPath = path.join(release, "manifest.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(document)}\n`);
  return sha256(await fs.readFile(manifestPath));
}

/** Every file under a directory with its digest, for a before-and-after comparison. */
async function treeDigest(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const listing = [];
  for (const entry of entries) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      listing.push(`${next}/`, ...await treeDigest(root, next));
      continue;
    }
    listing.push(`${next} ${sha256(await fs.readFile(path.join(directory, entry.name)))}`);
  }
  return listing;
}

/**
 * A controller with a complete payload, a sealed Bridge release, and a command
 * runner that records every client-config call. `setup` writes the upstreams
 * file the runtime needs, as the real command does.
 */
async function repairableController(root, overrides = {}) {
  const manifestSha256 = await completePayload(root, { maintenance: MAINTENANCE_MODULE, runtimeMonitor: RECORDING_MONITOR });
  const bridgeReleaseSha256 = await writeBridgeRelease(root);
  const calls = [];
  const installer = controller(root, {
    trustedMcpRuntimeManifestSha256: () => manifestSha256,
    trustedBridgeReleaseManifestSha256: () => bridgeReleaseSha256,
    runCli: async (executable, argumentsValue) => {
      calls.push(argumentsValue.slice(1));
      if (argumentsValue[1] === "setup") {
        await fs.mkdir(path.join(root, "UserData", "State"), { recursive: true });
        await fs.writeFile(path.join(root, "UserData", "State", "morrow.upstreams.json"), "{}\n");
      }
      if (argumentsValue[1] === "mcp" && typeof overrides.writeClientConfiguration === "function") {
        await overrides.writeClientConfiguration();
      }
      return { code: 0, stdout: "", stderr: "" };
    }
  });
  return { installer, calls, manifestSha256 };
}

test("repair rebuilds a Bridge folder that was removed and re-issues its active-folder challenge", async () => {
  const root = await temporaryRoot();
  const { installer, calls } = await repairableController(root);
  const stateDirectory = path.join(root, "UserData", "State");
  const bridgeDirectory = path.join(root, "UserData", "Bridge");
  const bridgeRecord = async () => JSON.parse(await fs.readFile(path.join(stateDirectory, "bridge-installation.json"), "utf8"));

  await fs.mkdir(stateDirectory, { recursive: true });
  await fs.writeFile(path.join(stateDirectory, "morrow.upstreams.json"), "{}\n");
  const orphanRollback = path.join(stateDirectory, "bridge-backups", "1.0.0-interrupted-update");
  await fs.mkdir(orphanRollback, { recursive: true });
  await installer.initializeBridgeAtStartup();
  assert.equal(await fs.stat(orphanRollback).then(() => true, () => false), false,
    "startup removes a Bridge rollback copy the installation record does not reference");
  globalThis.__morrowRepairOrder = [];
  await installer.state();
  const before = await bridgeRecord();
  assert.equal((await fs.stat(path.join(bridgeDirectory, "manifest.json"))).isFile(), true);

  await fs.rm(bridgeDirectory, { recursive: true, force: true });
  const state = await installer.repair();

  assert.equal((await fs.stat(path.join(bridgeDirectory, "manifest.json"))).isFile(), true);
  assert.equal((await fs.stat(path.join(bridgeDirectory, "src", "service-worker.js"))).isFile(), true);
  assert.equal(state.bridge.folderReady, true);
  // The folder is written again. No Chrome has answered for it, so Morrow
  // reports the load as unknown rather than as installed.
  assert.equal(state.bridge.loadedInChrome, "unknown");
  assert.equal(state.runtime.status, "ready");
  assert.deepEqual(globalThis.__morrowRepairOrder, ["monitor", "closed", "monitor"]);
  assert.deepEqual(calls.map((entry) => entry[0]), ["setup"]);
  assert.equal(calls[0].includes("--replace-generated"), true,
    "repair allows the setup CLI to replace only an unchanged generated local settings file");

  const after = await bridgeRecord();
  assert.notEqual(after.activeFolderChallenge.challengeId, before.activeFolderChallenge.challengeId);
  assert.notEqual(after.activeFolderChallenge.nonce, before.activeFolderChallenge.nonce);
  const marker = JSON.parse(await fs.readFile(path.join(bridgeDirectory, "morrow-bridge-active-folder.json"), "utf8"));
  assert.equal(marker.challengeId, after.activeFolderChallenge.challengeId);

  const backups = await fs.readdir(path.join(stateDirectory, "Backups"));
  assert.equal(backups.length, 1, "the installation record repair replaced is kept, not discarded");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateDirectory, "Backups", backups[0]), "utf8")), before);

  // A second repair finds a Bridge folder that verifies. It keeps that folder
  // and still issues a new challenge, so a Chrome holding the old one must
  // answer again before Morrow reports the Bridge loaded.
  await installer.repair();
  const reissued = await bridgeRecord();
  assert.notEqual(reissued.activeFolderChallenge.challengeId, after.activeFolderChallenge.challengeId);
  assert.deepEqual(reissued.files, after.files);
  assert.equal((await fs.readdir(path.join(stateDirectory, "Backups"))).length, 1, "a Bridge folder that verifies is kept");
});

test("repair refuses a payload that no longer verifies and changes nothing", async () => {
  const root = await temporaryRoot();
  const { installer, calls } = await repairableController(root);
  const stateDirectory = path.join(root, "UserData", "State");
  await fs.mkdir(stateDirectory, { recursive: true });
  await fs.writeFile(path.join(stateDirectory, "morrow.upstreams.json"), "{}\n");
  await installer.initializeBridgeAtStartup();
  await installer.ensureRuntime();

  // One payload file changes after Morrow already verified this payload.
  const entrypoint = path.join(root, "Payload", "app", "packages", "mcp-server", "dist", "index.js");
  await fs.writeFile(entrypoint, "gateway entrypoint changed");
  const before = await treeDigest(path.join(root, "UserData"));

  await assert.rejects(() => installer.repair(), (error) => error.code === "runtime_repair_required"
    && error.recovery === "Reinstall Morrow, then reopen it.");
  assert.deepEqual(await treeDigest(path.join(root, "UserData")), before);
  assert.deepEqual(calls, []);
});

test("repair leaves an assistant configuration edited after Morrow wrote it exactly as it is", async () => {
  const root = await temporaryRoot();
  const { installer, calls } = await repairableController(root);
  const target = path.join(root, "Home", ".codex", "config.toml");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "[mcp_servers.morrow]\ncommand = \"morrow\"\n");
  const morrowSha256 = sha256(await fs.readFile(target));
  await fs.writeFile(target, "[mcp_servers.morrow]\ncommand = \"morrow\"\n\n[mcp_servers.other]\ncommand = \"other\"\n");
  const edited = await fs.readFile(target);
  await installer.writeRecord({
    ...freshRecord(),
    selectedAssistantId: "codex",
    configured: { codex: { target, sha256: morrowSha256 } }
  });

  await assert.rejects(() => installer.repair(), (error) => error.code === "existing_morrow_configuration");
  assert.deepEqual(await fs.readFile(target), edited, "the newer edit is still on disk, byte for byte");
  assert.deepEqual(calls.map((entry) => entry[0]), ["setup"], "no client-config install ran against that file");
  assert.equal((await installer.record()).configured.codex.sha256, morrowSha256);
  assert.equal((await fs.stat(path.join(root, "UserData", "Bridge", "manifest.json"))).isFile(), true);
});

test("repair refuses to start while another operation holds the runtime", async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  let closed = false;
  installer.runtimeMonitor = { close: async () => { closed = true; } };

  installer.restartLeases.set("lease", installer.runtimeMonitor);
  await assert.rejects(() => installer.repair(), (error) => error.code === "active_or_uncertain_operations"
    && typeof error.message === "string" && typeof error.recovery === "string");
  installer.restartLeases.delete("lease");

  installer.bridgeLeaseId = "bridge-lease";
  await assert.rejects(() => installer.repair(), (error) => error.code === "active_or_uncertain_operations");
  installer.bridgeLeaseId = null;

  installer.bridgeReconciliation = Promise.resolve(null);
  await assert.rejects(() => installer.repair(), (error) => error.code === "active_or_uncertain_operations");
  assert.equal(closed, false, "a refused repair never stops the runtime");

  // The same fence admits the operation once the runtime reports that a restart
  // is safe. Repair then stops the runtime before it reads the payload.
  installer.runtimeMonitor = { close: async () => { closed = true; }, snapshot: () => ({ health: { canRestart: "yes" } }) };
  await assert.rejects(() => installer.repair(), (error) => error.code === "runtime_repair_required");
  assert.equal(closed, true);
  installer.bridgeReconciliation = null;
});

test("repair keeps an installer record it cannot read and starts a fresh one", async () => {
  const root = await temporaryRoot();
  const { installer, calls } = await repairableController(root);
  const stateDirectory = path.join(root, "UserData", "State");
  await fs.mkdir(stateDirectory, { recursive: true });
  const stored = `${JSON.stringify({ schema: "morrow.desktop-state.v2", version: 1, selectedAssistantId: "codex" })}\n`;
  await fs.writeFile(path.join(stateDirectory, "installer.json"), stored);
  await assert.rejects(() => installer.record(), /migration_required/);

  const state = await installer.repair();
  assert.deepEqual(await installer.record(), freshRecord());
  const backups = await fs.readdir(path.join(stateDirectory, "Backups"));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(stateDirectory, "Backups", backups[0]), "utf8"), stored);
  assert.equal(state.lifecycle, "ready_for_assistant");
  assert.equal(state.selectedAssistantId, null);
  assert.deepEqual(calls.map((entry) => entry[0]), ["setup"], "a fresh record names no assistant to configure");
});

test("repair writes the assistant configuration again when the file Morrow wrote is gone", async () => {
  const root = await temporaryRoot();
  const target = path.join(root, "Home", ".codex", "config.toml");
  const { installer, calls } = await repairableController(root, {
    writeClientConfiguration: async () => {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, "[mcp_servers.morrow]\ncommand = \"morrow\"\n");
    }
  });
  await installer.writeRecord({
    ...freshRecord(),
    selectedAssistantId: "codex",
    configured: { codex: { target, sha256: "a".repeat(64) } }
  });

  const state = await installer.repair();
  assert.equal((await fs.stat(target)).isFile(), true);
  assert.deepEqual(calls.map((entry) => entry[0]), ["setup", "mcp"]);
  assert.equal(calls[1].includes("--client-project"), false, "ChatGPT is configured without an assistant project");
  assert.equal(calls[1][2], "codex");
  const record = await installer.record();
  assert.equal(record.configured.codex.sha256, sha256(await fs.readFile(target)));
  assert.equal(state.assistants.find((assistant) => assistant.id === "codex").configured, true);
  assert.equal(state.lifecycle, "assistant_ready");
});

/**
 * A controller with real files in every place the retention policy names: a
 * State directory with a record, a journal and a backup, the Bridge folder, a
 * materials folder with a file in it, the Blackboard credential folder and
 * configuration file, and one assistant configuration file.
 */
async function installationWithData(root, response) {
  const { installer } = await repairableController(root);
  const messageBoxes = [];
  installer.dialog = {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showMessageBox: async (parent, options) => {
      messageBoxes.push(options);
      return { response, checkboxChecked: false };
    }
  };
  const userData = path.join(root, "UserData");
  const home = path.join(root, "Home");
  const stateDirectory = path.join(userData, "State");
  await fs.mkdir(stateDirectory, { recursive: true });
  await fs.writeFile(path.join(stateDirectory, "morrow.upstreams.json"), "{}\n");
  await fs.writeFile(path.join(stateDirectory, "morrow.sqlite3"), "journal\n");
  await fs.mkdir(path.join(stateDirectory, "Backups"), { recursive: true });
  await fs.writeFile(path.join(stateDirectory, "Backups", "config.toml"), "an earlier assistant setting\n");
  await installer.initializeBridgeAtStartup();
  const materials = await installer.effectiveWorkspace();
  await fs.writeFile(path.join(materials, "syllabus.md"), "week one\n");
  const assistantConfiguration = path.join(home, ".codex", "config.toml");
  await fs.mkdir(path.dirname(assistantConfiguration), { recursive: true });
  await fs.writeFile(assistantConfiguration, "[mcp_servers.morrow]\ncommand = \"morrow\"\n");
  await installer.writeRecord({
    ...freshRecord(),
    selectedAssistantId: "codex",
    configured: { codex: { target: assistantConfiguration, sha256: sha256(await fs.readFile(assistantConfiguration)) } }
  });
  const credentials = path.join(home, ".morrow", "credentials", "blackboard");
  await fs.mkdir(credentials, { recursive: true });
  await fs.writeFile(path.join(credentials, "default.secret"), "{\"applicationSecret\":\"kept\"}\n");
  const blackboardConfiguration = path.join(home, ".morrow", "blackboard-learn.json");
  await fs.writeFile(blackboardConfiguration, "{\"tenants\":[]}\n");
  return {
    installer,
    messageBoxes,
    paths: {
      userData,
      home,
      state: stateDirectory,
      backups: path.join(stateDirectory, "Backups"),
      bridge: path.join(userData, "Bridge"),
      materials: path.join(userData, "Materials"),
      credentials,
      blackboardConfiguration,
      assistantConfiguration
    }
  };
}

test("the state names every place this installation keeps data, by its exact path", async () => {
  const root = await temporaryRoot();
  const { installer, paths } = await installationWithData(root, 0);

  const retention = (await installer.state()).retention;
  assert.equal(retention.schema, "morrow.installer-retention.v1");
  assert.equal(retention.appRemoval, "removes_application_only");
  assert.equal(retention.explicitRemovalRequired, true);
  assert.ok(retention.retained.includes("blackboard_credentials"), "the Blackboard secret is named in the retention policy");
  assert.equal(retention.uninstall, process.platform === "darwin" ? "move_to_trash" : process.platform === "win32" ? "windows_settings_apps" : "unknown");
  assert.deepEqual(retention.locations.map((location) => location.path), [
    paths.state, paths.backups, paths.bridge, paths.materials, paths.credentials, paths.blackboardConfiguration, paths.assistantConfiguration
  ]);
  assert.deepEqual(
    retention.locations.filter((location) => location.removable).map((location) => location.path),
    [paths.state, paths.backups, paths.bridge, paths.materials, paths.credentials]
  );
  assert.equal(retention.locations.find((location) => location.path === paths.assistantConfiguration).keptReason, "assistant_configuration");
  assert.equal(retention.removal, null);
  // Every path it named is a real path on this computer.
  for (const location of retention.locations) {
    if (location.path === paths.blackboardConfiguration || location.path === paths.credentials) continue;
    assert.equal(await fs.lstat(location.path).then(() => true, () => false), true, `${location.path} exists`);
  }
});

test("a data removal without an explicit confirmation removes nothing", async () => {
  const root = await temporaryRoot();
  const { installer, messageBoxes, paths } = await installationWithData(root, 0);
  const before = { userData: await treeDigest(paths.userData), home: await treeDigest(paths.home) };

  const receipt = await installer.removeData(null);
  assert.equal(receipt.status, "cancelled");
  assert.deepEqual(receipt.removed, []);
  assert.deepEqual(receipt.remaining, []);
  assert.deepEqual(await treeDigest(paths.userData), before.userData);
  assert.deepEqual(await treeDigest(paths.home), before.home);

  assert.equal(messageBoxes.length, 1);
  const options = messageBoxes[0];
  assert.equal(options.type, "warning");
  assert.deepEqual(options.buttons, ["Cancel", "Remove data"]);
  assert.equal(options.defaultId, 0, "the destructive button is not the default button");
  assert.equal(options.cancelId, 0, "Escape answers with Cancel");
  for (const value of [paths.state, paths.backups, paths.bridge, paths.materials, paths.credentials]) {
    assert.ok(options.detail.includes(value), `the confirmation names ${value} as removed`);
  }
  for (const value of [paths.blackboardConfiguration, paths.assistantConfiguration]) {
    assert.ok(options.detail.includes(value), `the confirmation names ${value} as kept`);
  }
  assert.ok(options.detail.includes("Morrow will not remove:"));

  // The state carries that nothing was removed, so the panel never reports a
  // removal that did not happen.
  assert.equal((await installer.state()).retention.removal.status, "cancelled");
});

test("a data removal refuses to start while another operation holds the runtime", async () => {
  const root = await temporaryRoot();
  const { installer, messageBoxes, paths } = await installationWithData(root, 1);
  const before = await treeDigest(paths.userData);

  installer.restartLeases.set("lease", installer.runtimeMonitor || {});
  await assert.rejects(() => installer.removeData(null), (error) => error.code === "active_or_uncertain_operations"
    && typeof error.message === "string" && typeof error.recovery === "string");
  installer.restartLeases.delete("lease");

  installer.bridgeLeaseId = "bridge-lease";
  await assert.rejects(() => installer.removeData(null), (error) => error.code === "active_or_uncertain_operations");
  installer.bridgeLeaseId = null;

  assert.deepEqual(messageBoxes, [], "a refused removal never asks for a confirmation");
  assert.deepEqual(await treeDigest(paths.userData), before);
  assert.equal(installer.dataRemoval, null);
});

test("a confirmed removal removes what it listed, keeps what it did not, and reads every path back", async () => {
  const root = await temporaryRoot();
  const { installer, paths } = await installationWithData(root, 1);
  await installer.state();
  const homeBefore = await treeDigest(paths.home);
  globalThis.__morrowRepairOrder = [];

  const receipt = await installer.removeData(null);

  assert.equal(receipt.schema, "morrow.installer-data-removal.v1");
  assert.equal(receipt.status, "removed");
  assert.deepEqual(receipt.removed, [paths.state, paths.backups, paths.bridge, paths.materials, paths.credentials]);
  assert.deepEqual(receipt.remaining, []);
  assert.deepEqual(receipt.kept, [paths.blackboardConfiguration, paths.assistantConfiguration]);
  assert.ok(globalThis.__morrowRepairOrder.includes("closed"), "the runtime holding the journal is stopped before its folder is removed");

  // A fresh read of the disk, not the removal's own report.
  for (const removed of receipt.removed) {
    assert.equal(await fs.lstat(removed).then(() => true, () => false), false, `${removed} is gone`);
  }
  assert.deepEqual(await treeDigest(paths.userData), [], "nothing Morrow owns is left behind");
  assert.deepEqual(
    await treeDigest(paths.home),
    homeBefore.filter((entry) => !entry.startsWith(".morrow/credentials/blackboard")),
    "every path outside the list is exactly as it was"
  );

  // Morrow does not make the materials folder again on its own after removing
  // it, so the report and the disk keep saying the same thing.
  const state = await installer.state();
  assert.equal(state.lifecycle, "ready_for_workspace");
  assert.equal(state.retention.removal.status, "removed");
  assert.deepEqual(state.retention.removal.removed, receipt.removed);
  assert.equal(await fs.lstat(paths.materials).then(() => true, () => false), false);
  // Morrow does make an empty State folder for itself again while it stays
  // open, which is exactly what the removal report tells a person.
  assert.deepEqual(await fs.readdir(paths.state), []);

  // Setting Morrow up again is what makes the earlier report stop describing
  // this computer.
  await installer.writeRecord(freshRecord());
  assert.equal((await installer.state()).retention.removal, null);
});

test("a path the removal could not remove is reported as remaining, never as removed", {
  skip: process.platform === "win32" || process.getuid?.() === 0
    ? "needs POSIX file permissions and a user that they apply to"
    : false
}, async () => {
  const root = await temporaryRoot();
  const { installer, paths } = await installationWithData(root, 1);
  // A folder Morrow cannot write is a folder it cannot remove from.
  const locked = path.dirname(paths.credentials);
  await fs.chmod(locked, 0o500);
  let receipt;
  try {
    receipt = await installer.removeData(null);
  } finally {
    await fs.chmod(locked, 0o700).catch(() => {});
  }

  assert.equal(receipt.status, "incomplete");
  assert.deepEqual(receipt.remaining, [paths.credentials]);
  assert.equal(receipt.removed.includes(paths.credentials), false);
  assert.deepEqual(receipt.removed, [paths.state, paths.backups, paths.bridge, paths.materials]);
  assert.equal(await fs.lstat(path.join(paths.credentials, "default.secret")).then(() => true, () => false), true,
    "the secret Morrow could not remove is still on this computer");
  assert.equal((await installer.state()).retention.removal.status, "incomplete");
});
