"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const { bridgeDeliveryMode, createInstallerController, readCommandOutput, readMacApplicationBundleIdentifier, runBoundedCommand } = require("../shared/installer-controller.cjs");
const { freshRecord } = require("../shared/state-policy.cjs");
const { errorDetails } = require("../shared/contract.cjs");

const installerRoot = path.resolve(__dirname, "..");
// ensureRuntime() hardens the state directory through the real gateway-core
// ACL functions on win32, so every fixture below carries it. Present only in
// a built workspace, same as the packaged app's own payload.
const PRIVATE_FILE_ACCESS = path.join(installerRoot, "..", "packages", "gateway-core", "dist", "private-file-access.js");

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

function nodeRuntimePinFor(root) {
  const nodePath = process.platform === "win32"
    ? path.join(root, "Payload", "runtime", "node", "node.exe")
    : path.join(root, "Payload", "runtime", "node", "bin", "node");
  try {
    return crypto.createHash("sha256").update(require("node:fs").readFileSync(nodePath)).digest("hex");
  } catch {
    return null;
  }
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
    ...(
      overrides.trustedMcpRuntimeManifestSha256 && !overrides.trustedMcpRuntimeNodeSha256
        ? { ...overrides, trustedMcpRuntimeNodeSha256: () => nodeRuntimePinFor(root) }
        : overrides
    )
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
  await fs.writeFile(path.join(app, "installer", "process-lifetime.cjs"), "module.exports = {};\n");
  // Writing an assistant's configuration restricts the file to this account on
  // win32 before checking its digest, through the real client-config module.
  await fs.writeFile(path.join(app, "packages", "client-config", "dist", "index.js"), [
    "export function restrictToCurrentAccount() {}",
    "export function withoutMorrowCodexTable(content, name, options = {}) {",
    "  const lines = content.split('\\n');",
    "  const start = lines.findIndex((line) => line.trim() === '[mcp_servers.morrow]');",
    "  if (start === -1) return null;",
    "  const next = lines.findIndex((line, index) => index > start && line.trimStart().startsWith('['));",
    "  const table = lines.slice(start, next === -1 ? lines.length : next);",
    "  if (options.requireMorrowEntry && !table.some((line) => line.includes('MORROW_UPSTREAMS_FILE'))) {",
    "    throw Object.assign(new Error('not written by Morrow'), { code: 'config_entry_not_morrow' });",
    "  }",
    "  if (next === -1) { const kept = lines.slice(0, start).join('\\n').trimEnd(); return kept ? `${kept}\\n` : ''; }",
    "  return [...lines.slice(0, start), ...lines.slice(next)].join('\\n');",
    "}",
    ""
  ].join("\n"));

  // The gateway runs as ESM from app/packages while its sealed copy under
  // app/node_modules carries the digests the manifest binds.
  const gatewayFiles = [
    ["package.json", JSON.stringify({ name: "@morrow-lms/gateway", version: "1.0.0-rc.0", type: "module" })],
    ["dist/index.js", "gateway entrypoint"],
    ["dist/local-owner-maintenance.js", options.maintenance || "export function localOwnerMaintenanceMarkerPresent() { return false; }\n"],
    ["dist/local-owner-sidecar-access.js", "sidecar fixture"]
  ];
  const files = [];
  const directFiles = [];
  for (const [relative, content] of gatewayFiles) {
    const direct = path.join(app, "packages", "mcp-server", relative);
    const installed = path.join(app, "node_modules", "@morrow-lms", "gateway", relative);
    await fs.mkdir(path.dirname(direct), { recursive: true });
    await fs.mkdir(path.dirname(installed), { recursive: true });
    await fs.writeFile(direct, content);
    await fs.writeFile(installed, content);
    files.push({ path: `node_modules/@morrow-lms/gateway/${relative}`, bytes: Buffer.byteLength(content), sha256: sha256(content) });
    directFiles.push({ path: `packages/mcp-server/${relative}`, bytes: Buffer.byteLength(content), sha256: sha256(content) });
  }
  for (const relative of [
    "packages/client-config/dist/cli.js",
    "packages/client-config/dist/index.js",
    "packages/canvas-connector-mcp/dist/index.js",
    "installer/runtime-monitor.mjs",
    "installer/process-lifetime.cjs",
  ]) {
    const content = await fs.readFile(path.join(app, relative));
    directFiles.push({ path: relative, bytes: content.byteLength, sha256: sha256(content) });
  }
  directFiles.sort((left, right) => left.path.localeCompare(right.path));
  const entrypoint = gatewayFiles[1][1];
  const manifest = {
    schema: "morrow.mcp-runtime-manifest.v2",
    package: { name: "@morrow-lms/gateway", version: "1.0.0-rc.0" },
    entrypoint: { path: "packages/mcp-server/dist/index.js", bytes: Buffer.byteLength(entrypoint), sha256: sha256(entrypoint) },
    dependencies: [{ name: "@morrow-lms/gateway", version: "1.0.0-rc.0", packageJson: files[0], files }],
    directFiles,
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const manifestSha256 = sha256(bytes);
  await fs.writeFile(path.join(app, "mcp-runtime-manifest.json"), bytes);
  await fs.writeFile(path.join(app, "package-input-manifest.json"), `${JSON.stringify({
    schema: "morrow.desktop-package-input.v2",
    mcpRuntime: { path: "app/mcp-runtime-manifest.json", sha256: manifestSha256 }
  })}\n`);
  if (fsSync.existsSync(PRIVATE_FILE_ACCESS)) {
    const core = path.join(app, "node_modules", "@morrow", "gateway-core", "dist");
    await fs.mkdir(core, { recursive: true });
    await fs.copyFile(PRIVATE_FILE_ACCESS, path.join(core, "private-file-access.js"));
    await fs.writeFile(path.join(core, "index.js"), 'export * from "./private-file-access.js";\n');
  }
  return manifestSha256;
}

test("the installer record round-trips and an incompatible record is refused", async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  assert.deepEqual(await installer.record(), freshRecord());

  const target = path.join(root, "Home", ".codex", "config.toml");
  await installer.writeRecord({ ...freshRecord(), selectedAssistantId: "codex", configured: { codex: { target, sha256: "a".repeat(64) } } });
  const stored = await installer.record();
  assert.equal(stored.selectedAssistantId, "codex");
  assert.deepEqual(stored.configured, { codex: { target, sha256: "a".repeat(64) } });

  await assert.rejects(() => installer.writeRecord({ schema: "morrow.desktop-state.v2" }), /migration_required/);
  await assert.rejects(() => installer.writeRecord({ configured: ["not an object"] }), /record_invalid/);
  assert.equal((await installer.record()).selectedAssistantId, "codex", "a refused write left the stored record unchanged");

  await fs.writeFile(path.join(root, "UserData", "State", "installer.json"), `${JSON.stringify({ schema: "morrow.desktop-state.v0", version: 1 })}\n`);
  await assert.rejects(() => installer.record(), /migration_required/);
});

test("an immediate Desktop record readback survives ctime precision refinement", async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  await installer.writeRecord(freshRecord());
  const originalOpen = fs.open;
  let statCalls = 0;
  fs.open = async (...argumentsValue) => {
    const handle = await originalOpen(...argumentsValue);
    if (argumentsValue[0] !== installer.recordPath) return handle;
    const originalStat = handle.stat.bind(handle);
    handle.stat = async (...statArguments) => {
      const info = await originalStat(...statArguments);
      statCalls += 1;
      return Object.assign(Object.create(Object.getPrototypeOf(info)), info, {
        ctimeMs: info.ctimeMs + statCalls * 0.5,
      });
    };
    return handle;
  };
  try {
    assert.deepEqual(await installer.record(), freshRecord());
  } finally {
    fs.open = originalOpen;
  }
  assert.ok(statCalls >= 2, "the regression exercised admission and final descriptor stats");
});

test("the installer refuses malformed UTF-8 before it can change a saved path", async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  await fs.mkdir(path.dirname(installer.recordPath), { recursive: true, mode: 0o700 });
  const prefix = Buffer.from(`{"schema":"morrow.desktop-state.v1","version":1,"selectedAssistantId":null,"materialsFolder":"${path.join(root, "Home", "Cour")}`);
  const suffix = Buffer.from('ses","configured":{}}\n');
  await fs.writeFile(installer.recordPath, Buffer.concat([prefix, Buffer.from([0xff]), suffix]), { mode: 0o600 });

  await assert.rejects(() => installer.record(), /installer record is not valid UTF-8/);
});

test("installer record replacement flushes the new file and its directory", {
  skip: process.platform === "win32" ? "directory fsync is a POSIX durability primitive" : false
}, async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  const opened = [];
  const originalOpen = fs.open;
  fs.open = async (...argumentsValue) => {
    const handle = await originalOpen(...argumentsValue);
    const originalSync = handle.sync.bind(handle);
    handle.sync = async () => {
      opened.push(String(argumentsValue[0]));
      return originalSync();
    };
    return handle;
  };
  try {
    await installer.writeRecord(freshRecord());
  } finally {
    fs.open = originalOpen;
  }
  assert.equal(opened.some((file) => file.startsWith(`${installer.recordPath}.tmp-`)), true);
  assert.equal(opened.includes(path.dirname(installer.recordPath)), true);
  assert.deepEqual(await installer.record(), freshRecord());
});

test("record admission refuses a symlink and repair removes only the link", {
  skip: process.platform === "win32" ? "file symlink creation needs a POSIX host" : false
}, async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  const stateDirectory = path.dirname(installer.recordPath);
  const outside = path.join(root, "outside-installer.json");
  const stored = `${JSON.stringify(freshRecord())}\n`;
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(stateDirectory, 0o700);
  await fs.writeFile(outside, stored, { mode: 0o600 });
  await fs.symlink(outside, installer.recordPath);

  await assert.rejects(() => installer.record(), /private_file_not_admitted/);
  await installer.repairInstallerRecord();

  assert.equal(await fs.readFile(outside, "utf8"), stored);
  assert.equal((await fs.lstat(installer.recordPath)).isSymbolicLink(), false);
  assert.deepEqual(await installer.record(), freshRecord());
  assert.deepEqual(await fs.readdir(path.join(stateDirectory, "Backups")), []);
});

test("record admission refuses a linked State directory before using its record", {
  skip: process.platform === "win32" ? "directory symlink creation needs a POSIX host" : false
}, async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  const outside = path.join(root, "outside-state");
  const stored = `${JSON.stringify({ ...freshRecord(), selectedAssistantId: "codex" })}\n`;
  await fs.mkdir(outside, { mode: 0o700 });
  await fs.writeFile(path.join(outside, "installer.json"), stored, { mode: 0o600 });
  await fs.symlink(outside, path.dirname(installer.recordPath));

  await assert.rejects(() => installer.record(), /private_file_ancestor_not_admitted/);
  assert.equal((await installer.state()).lifecycle, "repair_required");
  assert.equal(await fs.readFile(path.join(outside, "installer.json"), "utf8"), stored);
});

test("invalid configured state is never admitted and repair preserves it only as inert backup", async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  const stateDirectory = path.dirname(installer.recordPath);
  const invalid = `${JSON.stringify({
    ...freshRecord(),
    selectedAssistantId: "unknown-assistant",
    configured: { codex: { target: "relative/config.toml", sha256: "not-a-digest" } },
  })}\n`;
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(stateDirectory, 0o700);
  await fs.writeFile(installer.recordPath, invalid, { mode: 0o600 });

  await assert.rejects(() => installer.record(), /record_invalid/);
  await installer.repairInstallerRecord();

  assert.deepEqual(await installer.record(), freshRecord());
  const backups = await fs.readdir(path.join(stateDirectory, "Backups"));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(stateDirectory, "Backups", backups[0]), "utf8"), invalid);
});

test("record recovery refuses a linked Backups directory without moving the record through it", {
  skip: process.platform === "win32" ? "directory symlink creation needs a POSIX host" : false
}, async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  const stateDirectory = path.dirname(installer.recordPath);
  const outside = path.join(root, "outside-backups");
  const stored = "{not-json\n";
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(stateDirectory, 0o700);
  await fs.mkdir(outside, { mode: 0o700 });
  await fs.writeFile(installer.recordPath, stored, { mode: 0o600 });
  await fs.symlink(outside, path.join(stateDirectory, "Backups"));

  await assert.rejects(() => installer.repairInstallerRecord(), /record_backup_directory_invalid/);
  assert.equal(await fs.readFile(installer.recordPath, "utf8"), stored);
  assert.deepEqual(await fs.readdir(outside), []);
});

test("a nonprivate installer record enters recovery before JSON fields are used", {
  skip: process.platform === "win32" ? "POSIX mode admission needs a POSIX host" : false
}, async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  const stateDirectory = path.dirname(installer.recordPath);
  const stored = `${JSON.stringify({ ...freshRecord(), selectedAssistantId: "codex" })}\n`;
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(stateDirectory, 0o700);
  await fs.writeFile(installer.recordPath, stored, { mode: 0o644 });

  await assert.rejects(() => installer.record(), /private_file_not_admitted/);
  assert.equal((await installer.state()).lifecycle, "repair_required");
  await installer.repairInstallerRecord();
  assert.deepEqual(await installer.record(), freshRecord());
  const [backup] = await fs.readdir(path.join(stateDirectory, "Backups"));
  assert.equal(await fs.readFile(path.join(stateDirectory, "Backups", backup), "utf8"), stored);
  assert.equal((await fs.stat(path.join(stateDirectory, "Backups", backup))).mode & 0o777, 0o600);
});

test("effectiveWorkspace is observational and refuses a missing chosen folder", async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  const materials = path.join(root, "UserData", "Materials");
  assert.equal(await installer.effectiveWorkspace(), null);
  assert.equal(await fs.lstat(materials).then(() => true, () => false), false);
  await fs.mkdir(materials, { recursive: true });
  assert.equal(await installer.effectiveWorkspace(), await fs.realpath(materials));

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

  const nodePath = process.platform === "win32"
    ? path.join(root, "Payload", "runtime", "node", "node.exe")
    : path.join(root, "Payload", "runtime", "node", "bin", "node");
  const nodeSha256 = crypto.createHash("sha256").update(await fs.readFile(nodePath)).digest("hex");
  const missingNodePin = controller(root, {
    trustedMcpRuntimeManifestSha256: () => manifestSha256,
    trustedMcpRuntimeNodeSha256: () => null
  });
  await assert.rejects(() => missingNodePin.ensureRuntime(), (error) => error.code === "runtime_repair_required");

  const verified = controller(root, {
    trustedMcpRuntimeManifestSha256: () => manifestSha256,
    trustedMcpRuntimeNodeSha256: () => nodeSha256
  });
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

test("the installer command runner bounds retained output while the child is writing", async () => {
  const result = await runBoundedCommand(process.execPath, ["-e", [
    "const block = Buffer.alloc(64 * 1024, 120);",
    "function write() { while (process.stdout.write(block)) {} setImmediate(write); }",
    "write();"
  ].join("\n")], {
    timeoutMs: 5_000,
    maxOutputBytes: 4 * 1024,
    terminationGraceMs: 100,
    closeGraceMs: 200
  });

  assert.equal(result.termination, "output_limit");
  assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 4 * 1024);
  assert.notEqual(result.code, 0);
});

test("the installer command runner hard-kills a child that ignores its soft timeout", { skip: process.platform === "win32" ? "POSIX signal behavior" : false }, async () => {
  const started = Date.now();
  const result = await runBoundedCommand(process.execPath, ["-e", [
    "process.on('SIGTERM', () => {});",
    "console.log(process.pid);",
    "setInterval(() => {}, 1_000);"
  ].join("\n")], {
    timeoutMs: 150,
    maxOutputBytes: 1024,
    terminationGraceMs: 100,
    closeGraceMs: 300
  });
  const pid = Number.parseInt(result.stdout.trim(), 10);

  assert.equal(result.termination, "timeout");
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.ok(Date.now() - started < 2_000, "the runner obeyed its hard close deadline");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.throws(() => process.kill(pid, 0), (error) => error?.code === "ESRCH");
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

/**
 * The Chrome route the packaged build chose. Setup shows the Chrome Web Store
 * steps only for a build that was packaged after the listing went live, so this
 * value has to survive from the build metadata to the state the renderer reads,
 * and anything Morrow cannot recognise has to land on the temporary route that
 * always works.
 */
test("the Bridge delivery route comes from the build, and an unusable value keeps the temporary route", async () => {
  assert.equal(bridgeDeliveryMode("available"), "available");
  assert.equal(bridgeDeliveryMode("developer_temporary"), "developer_temporary");
  for (const value of [undefined, null, "", "unavailable", "Available", "store", 1, true, {}, ["available"]]) {
    assert.equal(bridgeDeliveryMode(value), "developer_temporary", `${JSON.stringify(value) ?? "undefined"} is not a delivery route`);
  }
});

test("state() reports the Chrome Web Store route only when the build selected it", async () => {
  const root = await temporaryRoot();
  assert.equal((await controller(root, { bridgeDelivery: "available" }).state()).bridge.delivery, "available");
  assert.equal((await controller(root, { bridgeDelivery: "developer_temporary" }).state()).bridge.delivery, "developer_temporary");
  // A build with no delivery metadata at all, and a build whose metadata says
  // something Morrow does not know, both keep the temporary Chrome steps.
  assert.equal((await controller(root).state()).bridge.delivery, "developer_temporary");
  assert.equal((await controller(root, { bridgeDelivery: "chrome_web_store" }).state()).bridge.delivery, "developer_temporary");
  assert.equal((await controller(root, { bridgeDelivery: null }).state()).bridge.delivery, "developer_temporary");
});

test("the Chrome Web Store route changes no Bridge identity or pairing check", async () => {
  const root = await temporaryRoot();
  const installer = controller(root, { bridgeDelivery: "available" });
  const installation = bridgeInstallation();
  const answering = (answer) => ({ bridgeMaintenance: async () => answer });
  const foreign = answering({ ...bridgeStatusAnswer(installation.activeFolderChallenge), extensionId: "a".repeat(32) });
  await assert.rejects(() => installer.currentBridgeStatus(installation, foreign), /identity is unconfirmed/);
  const otherFolder = answering(bridgeStatusAnswer({ ...installation.activeFolderChallenge, nonce: "nonce-fedcba9876543210" }));
  await assert.rejects(() => installer.currentBridgeStatus(installation, otherFolder), /active folder is unconfirmed/);

  installer.runtimeMonitor = otherFolder;
  assert.equal(
    await installer.bridgeLoadedInChrome(installation, { health: { ...READY_HEALTH } }),
    "unknown",
    "the Store route never accepts an unpacked Bridge that answered another folder's challenge",
  );
});

/**
 * The packaged Node runtime is the one payload file Morrow cannot check the
 * same way on both platforms: `exactExecutable` in packages/client-config skips
 * its executable-bit check on Windows, so a damaged runtime there is not caught
 * where it is caught here. What must hold on both is that a payload missing its
 * runtime is reported as an app that needs repair, with the repair action on
 * screen, rather than as a setup step that quietly fails later.
 */
test("a payload whose Node runtime is gone asks for repair instead of failing later", async () => {
  const root = await temporaryRoot();
  const manifestSha256 = await completePayload(root);
  const nodePath2 = process.platform === "win32"
    ? path.join(root, "Payload", "runtime", "node", "node.exe")
    : path.join(root, "Payload", "runtime", "node", "bin", "node");
  const nodeSha256_2 = crypto.createHash("sha256").update(await fs.readFile(nodePath2)).digest("hex");
  const trusted = {
    trustedMcpRuntimeManifestSha256: () => manifestSha256,
    trustedMcpRuntimeNodeSha256: () => nodeSha256_2
  };
  const ready = await controller(root, trusted).state();
  assert.notEqual(ready.lifecycle, "repair_required", "the complete payload must start out usable");

  const node = process.platform === "win32"
    ? path.join(root, "Payload", "runtime", "node", "node.exe")
    : path.join(root, "Payload", "runtime", "node", "bin", "node");
  await fs.rm(node);
  const damaged = await controller(root, trusted).state();
  assert.equal(damaged.lifecycle, "repair_required");
  assert.equal(damaged.runtime.status, "repair_required");
  // Repair is a real action on that screen, so the person is told what to do.
  const { actionView } = await import(pathToFileURL(path.join(__dirname, "..", "shared", "setup-view.mjs")).href);
  const view = actionView(damaged);
  assert.equal(view.body.includes('data-action="repair"'), true, "the repair state offers no repair action");
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

test("Blackboard health does not turn saved data into absence when private access inspection is unavailable", async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  installer.privateFileAccessAccepted = async () => { throw new Error("private access module unavailable"); };
  assert.deepEqual(await installer.blackboardHealth(), {
    schema: "morrow.blackboard.health.v1",
    status: "not_configured",
    tenants: [],
  });
  const config = path.join(root, "Home", ".morrow", "blackboard-learn.json");
  await fs.mkdir(path.dirname(config), { mode: 0o700 });
  await fs.writeFile(config, "{}\n", { mode: 0o600 });
  assert.deepEqual(await installer.blackboardHealth(), {
    schema: "morrow.blackboard.health.v1",
    status: "private_access_refused",
    tenants: [],
  });
});

test("state() reports repair for an incomplete payload and never creates the Bridge folder", async () => {
  const root = await temporaryRoot();
  const installer = controller(root, { updateSnapshot: () => ({
    schema: "morrow.desktop-update.v1",
    revision: 7,
    status: "unavailable",
    currentVersion: "1.0.0",
    availableVersion: null,
    automatic: false,
    reason: "updates_disabled"
  }) });
  const state = await installer.state();
  assert.equal(state.lifecycle, "repair_required");
  assert.equal(state.runtime.status, "repair_required");
  assert.equal(state.bridge.folderReady, false);
  assert.equal(state.bridge.manualChromeReloadRequired, false);
  assert.equal(state.blackboard.status, "not_configured");
  assert.equal(state.updates.status, "unavailable");
  assert.equal(state.updates.revision, 7);
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

function storeBridgeStatusAnswer(overrides = {}) {
  return {
    schema: "morrow.bridge.update-status.v1",
    extensionId: BRIDGE_EXTENSION_ID,
    manifestVersion: "1.0.3",
    installType: "normal",
    quiescent: false,
    activeFolderProof: null,
    ...overrides
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

test("a paired Chrome Web Store Bridge is accepted without app-folder maintenance", async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  const installation = bridgeInstallation();
  const storeStatus = storeBridgeStatusAnswer({ manifestVersion: "1.0.9" });
  const calls = [];
  const monitor = {
    bridgeMaintenance: async (control) => {
      calls.push(control);
      return storeStatus;
    }
  };
  installer.runtimeMonitor = monitor;

  assert.deepEqual(await installer.currentBridgeStatus(installation, monitor), storeStatus);
  assert.equal(await installer.bridgeLoadedInChrome(installation, { health: { ...READY_HEALTH } }), true);

  let staged = false;
  installer.verifiedBridgeInstallation = async () => installation;
  installer.packagedBridgeRelease = async () => ({ version: "1.0.4" });
  installer.bridgeMonitor = async () => monitor;
  installer.stageBridgeUpdate = async () => { staged = true; };
  assert.equal(await installer.reconcileBridgeRelease(), installation);
  assert.equal(staged, false, "Morrow never stages an app-folder swap for the Store Bridge");
  assert.deepEqual(calls, [{ action: "status" }, { action: "status" }, { action: "status" }]);

  await assert.rejects(
    () => installer.currentBridgeStatus(installation, { bridgeMaintenance: async () => storeBridgeStatusAnswer({ extensionId: "a".repeat(32) }) }),
    /identity is unconfirmed/,
  );
  await assert.rejects(
    () => installer.currentBridgeStatus(installation, { bridgeMaintenance: async () => ({
      ...bridgeStatusAnswer(installation.activeFolderChallenge),
      installType: "admin",
    }) }),
    /active folder is unconfirmed/,
  );
});

test("Bridge reconciliation requires a newer Chrome version even when sealed bytes changed", async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  const monitor = {};
  const installed = bridgeInstallation({ releaseManifestSha256: "a".repeat(64) });
  let release = { version: installed.version, releaseManifestSha256: installed.releaseManifestSha256 };
  let stages = 0;
  installer.verifiedBridgeInstallation = async () => installed;
  installer.packagedBridgeRelease = async () => release;
  installer.bridgeMonitor = async () => monitor;
  installer.currentBridgeStatus = async () => ({ installType: "development" });
  installer.stageBridgeUpdate = async () => { stages += 1; return { updated: true }; };

  assert.equal(await installer.reconcileBridgeRelease(), installed);
  assert.equal(stages, 0);

  release = { ...release, releaseManifestSha256: "b".repeat(64) };
  assert.equal(await installer.reconcileBridgeRelease(), installed);
  assert.equal(stages, 0);
});

test("a staged Bridge update completes in the same session while it holds its own lease", async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  const monitor = {};
  const pendingRecord = bridgeInstallation({ manualChromeReloadRequired: true });
  const completed = bridgeInstallation();
  installer.restartLeases.set("bridge-lease", monitor);
  installer.bridgeLeaseId = "bridge-lease";
  installer.verifiedBridgeInstallation = async () => pendingRecord;
  installer.packagedBridgeRelease = async () => ({ version: pendingRecord.version });
  installer.bridgeMonitor = async () => monitor;
  let completions = 0;
  installer.completePendingBridgeUpdate = async (record, used) => {
    completions += 1;
    assert.equal(record, pendingRecord);
    assert.equal(used, monitor);
    return completed;
  };
  assert.equal(await installer.reconcileBridgeRelease(), completed);
  assert.equal(completions, 1);

  // The same lease still refuses every other maintenance step, and a second lease is other work.
  assert.equal(installer.maintenanceAdmission(), "active_or_uncertain_operations");
  installer.restartLeases.set("other-lease", {});
  await assert.rejects(() => installer.reconcileBridgeRelease(), (error) => error.code === "active_or_uncertain_operations");
  installer.restartLeases.delete("other-lease");

  // A held Bridge lease without a pending update is an update still being staged.
  installer.verifiedBridgeInstallation = async () => completed;
  await assert.rejects(() => installer.reconcileBridgeRelease(), (error) => error.code === "active_or_uncertain_operations");
});

test("a staged Bridge reloads itself and finishes the update without the person", async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  const staged = bridgeInstallation({ manualChromeReloadRequired: true });
  const completed = bridgeInstallation();
  const calls = [];
  let running = "1.0.0";
  const monitor = {
    bridgeMaintenance: async (control) => {
      calls.push(control.action);
      if (control.action === "reload") {
        assert.equal(control.quiesceEpoch, "quiesce-epoch-for-reload-test");
        setTimeout(() => { running = "1.0.1"; }, 5);
        return { schema: "morrow.bridge.reload-scheduled.v1", extensionId: "a".repeat(32), manifestVersion: "1.0.0", nextManifestVersion: "1.0.1", quiesceEpoch: control.quiesceEpoch };
      }
      if (running === "1.0.0" && calls.filter((entry) => entry === "status").length === 1) throw new Error("Bridge restarting");
      return { manifestVersion: running };
    }
  };
  let completions = 0;
  installer.completePendingBridgeUpdate = async (record, used) => {
    completions += 1;
    assert.equal(record, staged);
    assert.equal(used, monitor);
    return completed;
  };
  assert.equal(await installer.reloadStagedBridge(staged, monitor, "quiesce-epoch-for-reload-test", "1.0.1", { waitMs: 2_000, pollMs: 10 }), completed);
  assert.equal(completions, 1);
  assert.equal(calls[0], "reload");
});

test("a Bridge that cannot reload itself leaves the staged update for a manual reload", async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  const staged = bridgeInstallation({ manualChromeReloadRequired: true });
  installer.completePendingBridgeUpdate = async () => { throw new Error("must not complete"); };
  const older = { bridgeMaintenance: async () => { throw new Error("bridge_maintenance_control_invalid"); } };
  assert.equal(await installer.reloadStagedBridge(staged, older, "quiesce-epoch-for-reload-test", "1.0.1", { waitMs: 50, pollMs: 5 }), staged);
  const neverRestarts = { bridgeMaintenance: async (control) => control.action === "reload"
    ? { nextManifestVersion: "1.0.1" }
    : { manifestVersion: "1.0.0" } };
  assert.equal(await installer.reloadStagedBridge(staged, neverRestarts, "quiesce-epoch-for-reload-test", "1.0.1", { waitMs: 50, pollMs: 5 }), staged);
});

test("Bridge state advertises only a strictly newer extension version", async () => {
  const root = await temporaryRoot();
  const installer = controller(root, { bridgeDelivery: "developer_temporary" });
  const installed = bridgeInstallation({ releaseManifestSha256: "a".repeat(64) });
  installer.packagedBridgeRelease = async () => ({ version: installed.version, releaseManifestSha256: "b".repeat(64) });
  assert.equal(await installer.bridgeReleaseUpdateAvailable(installed), false);
  installer.packagedBridgeRelease = async () => ({ version: "1.0.1", releaseManifestSha256: "b".repeat(64) });
  assert.equal(await installer.bridgeReleaseUpdateAvailable(installed), true);
  installer.packagedBridgeRelease = async () => ({ version: installed.version, releaseManifestSha256: installed.releaseManifestSha256 });
  assert.equal(await installer.bridgeReleaseUpdateAvailable(installed), false);
  assert.equal(await installer.bridgeReleaseUpdateAvailable({ ...installed, manualChromeReloadRequired: true }), false);
});

test("Bridge update names an active runtime instead of asking for repair", async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  const monitor = {};
  installer.acquireRestartLease = async () => ({ status: "unavailable" });
  await assert.rejects(() => installer.acquireBridgeLease(monitor), (error) => {
    assert.equal(error.code, "active_or_uncertain_operations");
    assert.match(error.message, /work in progress/);
    return true;
  });
});

test("state() reports the Chrome load state the Bridge itself answered", async () => {
  const root = await temporaryRoot();
  await fs.mkdir(path.join(root, "UserData", "Materials"), { recursive: true });
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
  installer.readBridgeInstallation = async () => installer.bridgeInstallation;

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

test("Check connection reports a course read that did not complete instead of answering as if it had", async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  const snapshot = (firstPreview) => ({
    schema: "morrow.installer-runtime.v1",
    health: { attempted: true, gatewayReady: true, bridgeConnected: true, canRestart: "yes" },
    bindings: { runtimeVerifiedCourseCount: 1, selectedCourseName: "Biology 101", firstPreviewCourseName: "Biology 101" },
    firstPreview
  });
  let observed = snapshot({ available: "yes", completed: false });
  let reads = 0;
  let answer = { available: "no", completed: false };
  installer.effectiveWorkspace = async () => path.join(root, "Materials");
  installer.runtimeSnapshot = async () => observed;
  installer.runtimeMonitor = {
    firstSafeRead: async () => {
      reads += 1;
      observed = snapshot(answer);
      return { schema: "morrow.installer-first-read.v1", completed: answer.completed };
    },
    snapshot: () => observed
  };

  // Canvas answered, but not for this course: the read did not complete.
  await assert.rejects(installer.firstSafeRead(), (error) => error.code === "first_read_failed");
  // The read failed on the way: the session in Chrome expired.
  observed = snapshot({ available: "yes", completed: true });
  answer = { available: "unknown", completed: false };
  await assert.rejects(installer.firstSafeRead(), (error) => error.code === "first_read_failed");
  // No course can be read right now, so Morrow does not start a read.
  observed = snapshot({ available: "no", completed: false });
  await assert.rejects(installer.firstSafeRead(), (error) => error.code === "first_read_failed");
  assert.equal(reads, 2);

  observed = snapshot({ available: "yes", completed: false });
  answer = { available: "yes", completed: true };
  assert.equal((await installer.firstSafeRead()).firstPreview.completed, true);
  assert.equal(reads, 3);
  const failure = errorDetails("first_read_failed");
  assert.equal(failure.message, "Morrow could not read your course.");
  assert.equal(failure.recovery, "Open the course in Chrome and make sure you are signed in, then select Check connection again.");
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
  await fs.mkdir(path.join(root, "UserData", "Materials"), { recursive: true });
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

test("concurrent runtime reads create and own exactly one monitor", async () => {
  const root = await temporaryRoot();
  await fs.mkdir(path.join(root, "UserData", "Materials"), { recursive: true });
  const runtimeMonitor = [
    "globalThis.__morrowMonitorLifecycle = { created: 0, closed: 0 };",
    "export function createRuntimeMonitor() {",
    "  globalThis.__morrowMonitorLifecycle.created += 1;",
    "  return { close: async () => { globalThis.__morrowMonitorLifecycle.closed += 1; } };",
    "}",
    "",
  ].join("\n");
  const manifestSha256 = await completePayload(root, { maintenance: MAINTENANCE_MODULE, runtimeMonitor });
  const installer = controller(root, { trustedMcpRuntimeManifestSha256: () => manifestSha256 });
  await installer.ensureRuntime();
  await fs.writeFile(path.join(root, "UserData", "State", "morrow.upstreams.json"), "{}\n");
  const materials = await installer.effectiveWorkspace();
  const canonicalStateDirectory = installer.canonicalStateDirectory.bind(installer);
  installer.canonicalStateDirectory = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return canonicalStateDirectory();
  };

  const [first, second] = await Promise.all([
    installer.runtimeMonitorFor(materials),
    installer.runtimeMonitorFor(materials),
  ]);

  assert.strictEqual(first, second);
  assert.deepEqual(globalThis.__morrowMonitorLifecycle, { created: 1, closed: 0 });
  await installer.closeRuntimeMonitor();
  assert.deepEqual(globalThis.__morrowMonitorLifecycle, { created: 1, closed: 1 });
  delete globalThis.__morrowMonitorLifecycle;
});

test("concurrent desktop cleanup waits for one runtime close and clears its lease references", async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  let releaseClose;
  let closeCalls = 0;
  const closeGate = new Promise((resolve) => { releaseClose = resolve; });
  installer.runtimeMonitor = {
    async close() {
      closeCalls += 1;
      await closeGate;
    }
  };
  installer.runtimeWorkspace = path.join(root, "Materials");
  installer.restartLeases.set("lease-one", installer.runtimeMonitor);

  const first = installer.closeRuntimeMonitor();
  const second = installer.closeRuntimeMonitor();
  await Promise.resolve();
  assert.equal(closeCalls, 1);
  assert.equal(installer.runtimeMonitor, null);
  assert.equal(installer.restartLeases.size, 1, "lease state remains owned until close finishes");

  releaseClose();
  await Promise.all([first, second]);
  assert.equal(closeCalls, 1);
  assert.equal(installer.restartLeases.size, 0);
  assert.equal(installer.runtimeClosing, null);
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
  assert.deepEqual(first, ["codex", "claude-desktop", "claude-code", "gemini-cli"],
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

test("Check status waits for the fresh runtime observation", async () => {
  const root = await temporaryRoot();
  const installer = controller(root, { detectAssistant: async () => false });
  const waits = [];
  installer.runtimeSnapshot = async (_materials, options) => {
    waits.push(options);
    return {
      health: { attempted: true, gatewayReady: true, bridgeConnected: true, canRestart: "yes" },
      bindings: { runtimeVerifiedCourseCount: 1, selectedCourseName: "BT2", firstPreviewCourseName: "BT2" },
      firstPreview: { available: "yes", completed: true },
    };
  };
  installer.bridgeInstallation = bridgeInstallation();
  installer.readBridgeInstallation = async () => installer.bridgeInstallation;

  await installer.state();
  await installer.state({ recheckAssistants: true });

  assert.deepEqual(waits, [{ wait: false }, { wait: true }]);
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
  assert.equal(reads, 4);
  // The assistant was installed after that state read. Setting it up must not
  // refuse on the answer Morrow already had.
  detected = true;
  // The payload in this fixture is incomplete, so setup stops at the runtime.
  // What this case proves is the read that happened before that.
  await assert.rejects(() => installer.installAssistant("codex"), (error) => error.code === "runtime_repair_required");
  assert.equal(reads, 5, "the setup step read this computer again");
  assert.equal((await installer.state()).assistants.find((assistant) => assistant.id === "codex").detected, true,
    "the state read after it shows what that fresh read found");
});

test("dead maintenance is recovered before a runtime monitor is created", async () => {
  const root = await temporaryRoot();
  await fs.mkdir(path.join(root, "UserData", "Materials"), { recursive: true });
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

test("a desktop mutation stops a live owner under one unbroken authoritative guard", async () => {
  const root = await temporaryRoot();
  await fs.mkdir(path.join(root, "UserData", "Materials"), { recursive: true });
  globalThis.__morrowDesktopMutationOrder = [];
  const maintenance = [
    "export function localOwnerMaintenanceMarkerPresent() { return false; }",
    "export function readLocalOwnerMaintenanceLease() { return null; }",
    "export function requestLocalOwnerMaintenance() { return null; }",
    "export function clearDeadLocalOwnerMaintenanceLease() { return false; }",
    "export function acquireStoppedLocalOwnerMaintenanceLease() { globalThis.__morrowDesktopMutationOrder.push('stopped-probe'); return null; }",
    "export function replaceDeadLocalOwnerMaintenanceLeaseWithStoppedGuard() { globalThis.__morrowDesktopMutationOrder.push('stopped-guard'); return { leaseId: '00000000-0000-4000-8000-000000000071', leaseToken: 'morrow-desktop-mutation-token-1234567890123456' }; }",
    "export function removeExactLocalOwnerMaintenanceLease() { globalThis.__morrowDesktopMutationOrder.push('release'); return true; }",
    "",
  ].join("\n");
  const runtimeMonitor = [
    "export function createRuntimeMonitor() {",
    "  return {",
    "    start: async () => { globalThis.__morrowDesktopMutationOrder.push('monitor-start'); return {}; },",
    "    snapshot: () => ({ health: { canRestart: 'yes' } }),",
    "    maintenance: async ({ action }) => { globalThis.__morrowDesktopMutationOrder.push(`owner-${action}`); return action === 'acquire' ? { status: 'held' } : action === 'commit' ? { status: 'closing' } : { status: 'released' }; },",
    "    close: async () => { globalThis.__morrowDesktopMutationOrder.push('monitor-close'); }",
    "  };",
    "}",
    "",
  ].join("\n");
  const manifestSha256 = await completePayload(root, { maintenance, runtimeMonitor });
  const installer = controller(root, { trustedMcpRuntimeManifestSha256: () => manifestSha256 });
  await installer.ensureRuntime();
  await fs.writeFile(path.join(root, "UserData", "State", "morrow.upstreams.json"), "{}\n");

  await installer.withDesktopMutation(async (transaction) => {
    await transaction.stopRuntime();
    globalThis.__morrowDesktopMutationOrder.push("mutation");
  });

  assert.deepEqual(globalThis.__morrowDesktopMutationOrder, [
    "stopped-probe",
    "monitor-start",
    "owner-acquire",
    "owner-commit",
    "monitor-close",
    "stopped-guard",
    "mutation",
    "release",
  ]);
  assert.equal(installer.desktopMutationGuard, null);
  assert.equal(installer.desktopMutationInProgress, null);
});

test("every public desktop configuration mutation writes nothing when owner admission is refused", async () => {
  const root = await temporaryRoot();
  const maintenance = [
    "export function localOwnerMaintenanceMarkerPresent() { return false; }",
    "export function readLocalOwnerMaintenanceLease() { return null; }",
    "export function requestLocalOwnerMaintenance() { return null; }",
    "export function clearDeadLocalOwnerMaintenanceLease() { return false; }",
    "export function acquireStoppedLocalOwnerMaintenanceLease() { return null; }",
    "export function replaceDeadLocalOwnerMaintenanceLeaseWithStoppedGuard() { return null; }",
    "export function removeExactLocalOwnerMaintenanceLease() { return false; }",
    "",
  ].join("\n");
  const runtimeMonitor = [
    "export function createRuntimeMonitor() {",
    "  return { start: async () => ({}), snapshot: () => ({ health: { canRestart: 'unknown' } }),",
    "    maintenance: async () => ({ status: 'unavailable' }), close: async () => {} };",
    "}",
    "",
  ].join("\n");
  const manifestSha256 = await completePayload(root, { maintenance, runtimeMonitor });
  const chosen = path.join(root, "Chosen materials");
  await fs.mkdir(chosen);
  const target = path.join(root, "Home", ".codex", "config.toml");
  await fs.mkdir(path.dirname(target), { recursive: true });
  const content = '[mcp_servers.morrow]\ncommand = "node"\n';
  await fs.writeFile(target, content);
  const calls = [];
  const installer = controller(root, {
    trustedMcpRuntimeManifestSha256: () => manifestSha256,
    detectAssistant: async () => true,
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [chosen] }) },
    runCli: async (...input) => { calls.push(input); return { code: 0, stdout: "", stderr: "" }; },
  });
  await installer.ensureRuntime();
  await fs.writeFile(path.join(root, "UserData", "State", "morrow.upstreams.json"), "{}\n");
  await installer.writeRecord({
    ...freshRecord(),
    materialsFolder: chosen,
    selectedAssistantId: "codex",
    configured: { codex: { target, sha256: sha256(content) } },
  });
  const beforeRecord = await fs.readFile(installer.recordPath);
  const operations = [
    () => installer.configureWorkspace(null),
    () => installer.configureBlackboard({ baseUrl: "https://learn.example.edu", applicationKey: "key", applicationSecret: "secret-value" }),
    () => installer.selectBlackboardCourses({ tenantId: "learn-example-edu", courseBindings: [] }),
    () => installer.removeBlackboardTenant({ tenantId: "learn-example-edu" }),
    () => installer.removeBlackboardData(),
    () => installer.installAssistant("codex", null),
    () => installer.removeAssistant("codex"),
    () => installer.repair(),
  ];

  for (const operation of operations) {
    await assert.rejects(operation, (error) => error.code === "active_or_uncertain_operations");
  }
  assert.deepEqual(await fs.readFile(installer.recordPath), beforeRecord);
  assert.equal(await fs.readFile(target, "utf8"), content);
  assert.deepEqual(calls, []);
  assert.equal(await fs.stat(path.join(root, "Home", ".morrow", "blackboard-learn.json")).then(() => true, () => false), false);
});

test("a second desktop mutation is refused while the first is acquiring authority", async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  let admit;
  const admission = new Promise((resolve) => { admit = resolve; });
  installer.acquireDesktopMutationGuard = async () => {
    await admission;
    return { kind: "stopped", leaseId: "test-lease", leaseToken: "test-token" };
  };
  installer.releaseDesktopMutationGuard = async (guard) => {
    if (installer.desktopMutationGuard === guard) installer.desktopMutationGuard = null;
  };
  const order = [];
  const first = installer.withDesktopMutation(async () => { order.push("first"); });
  await Promise.resolve();
  await assert.rejects(
    () => installer.withDesktopMutation(async () => { order.push("second"); }),
    (error) => error.code === "active_or_uncertain_operations",
  );
  admit();
  await first;
  assert.deepEqual(order, ["first"]);
  assert.equal(installer.desktopMutationInProgress, null);
});

const BRIDGE_EXTENSION_KEY = JSON.parse(require("node:fs").readFileSync(path.join(__dirname, "..", "..", "connector", "extension", "manifest.json"), "utf8")).key;

const MAINTENANCE_MODULE = [
  "export function localOwnerMaintenanceMarkerPresent() { return false; }",
  "export function readLocalOwnerMaintenanceLease() { return null; }",
  "export function requestLocalOwnerMaintenance() { return null; }",
  "export function clearDeadLocalOwnerMaintenanceLease() { return false; }",
  "export function acquireStoppedLocalOwnerMaintenanceLease() { globalThis.__morrowStoppedGuardCalls?.push('acquire'); return { leaseId: '00000000-0000-4000-8000-000000000001', leaseToken: 'morrow-stopped-maintenance-token-1234567890123456' }; }",
  "export function replaceDeadLocalOwnerMaintenanceLeaseWithStoppedGuard() { return { leaseId: '00000000-0000-4000-8000-000000000002', leaseToken: 'morrow-stopped-maintenance-token-2345678901234567' }; }",
  "export function removeExactLocalOwnerMaintenanceLease() { globalThis.__morrowStoppedGuardCalls?.push('release'); return true; }",
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
  "    maintenance: async ({ action }) => action === 'acquire' ? { status: 'held' } : action === 'release' ? { status: 'released' } : { status: 'closing' },",
  "    close: async () => { globalThis.__morrowRepairOrder.push('closed'); }",
  "  };",
  "}",
  ""
].join("\n");

/** Writes a sealed Bridge release into the payload and returns its digest. */
async function writeBridgeRelease(root, version = "1.0.0", workerSource = null) {
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
  await fs.writeFile(path.join(source, "src", "service-worker.js"), workerSource || `export const version = ${JSON.stringify(version)};\n`);
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
  const manifestSha256 = await completePayload(root, {
    maintenance: overrides.maintenance || MAINTENANCE_MODULE,
    runtimeMonitor: overrides.runtimeMonitor || RECORDING_MONITOR
  });
  const bridgeReleaseSha256 = await writeBridgeRelease(root);
  const calls = [];
  const installer = controller(root, {
    trustedMcpRuntimeManifestSha256: () => manifestSha256,
    trustedBridgeReleaseManifestSha256: () => bridgeReleaseSha256,
    detectAssistant: async () => true,
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
  await fs.mkdir(path.join(root, "UserData", "Materials"), { recursive: true });
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

/**
 * A durable swap that can no longer converge: the transaction still names a
 * stage and a backup that are both gone. Repair discards that installation,
 * so it must discard the transaction with it. A transaction left behind fails
 * every later lock, which leaves the Bridge unrepairable from then on.
 */
test("repair discards a durable swap transaction with the record it removes", async () => {
  const root = await temporaryRoot();
  await fs.mkdir(path.join(root, "UserData", "Materials"), { recursive: true });
  const { installer } = await repairableController(root);
  const stateDirectory = path.join(root, "UserData", "State");
  const bridgeDirectory = path.join(root, "UserData", "Bridge");
  await fs.mkdir(stateDirectory, { recursive: true });
  await fs.writeFile(path.join(stateDirectory, "morrow.upstreams.json"), "{}\n");
  await installer.initializeBridgeAtStartup();
  const previous = JSON.parse(await fs.readFile(path.join(stateDirectory, "bridge-installation.json"), "utf8"));

  // The record names the resolved paths, and the transaction is read against
  // those, so the fixture derives both from the record rather than from root.
  const resolvedUserData = path.dirname(previous.bridgeDirectory);
  const transactionId = crypto.randomUUID();
  const backupDirectory = path.join(resolvedUserData, "State", "bridge-backups", `${previous.extensionVersion}-${transactionId}`);
  const nextRecord = {
    ...previous,
    extensionVersion: "9.9.9",
    releaseManifestSha256: sha256("a release this fixture never installs"),
    activeFolderChallenge: { ...previous.activeFolderChallenge, manifestVersion: "9.9.9" },
    pendingUpdate: {
      backupDirectory,
      fromVersion: previous.extensionVersion,
      quiesceEpoch: "quiesce-epoch-0123456789",
      previousRecord: previous
    }
  };
  const transactionFile = path.join(stateDirectory, "bridge-update-transaction.json");
  await fs.writeFile(transactionFile, `${JSON.stringify({
    schema: "morrow.bridge-update-transaction.v1",
    transactionId,
    createdAt: new Date().toISOString(),
    stageDirectory: path.join(resolvedUserData, `.morrow-bridge-stage-${transactionId}`),
    backupDirectory,
    previousRecord: previous,
    nextRecord
  })}\n`, { mode: 0o600 });

  installer.bridgeInitialization = null;
  installer.bridgeInstallation = null;
  await assert.rejects(() => installer.readBridgeInstallation(), (error) => error.code === "bridge_update_transaction_invalid");

  const state = await installer.repair();
  assert.equal(state.bridge.folderReady, true);
  assert.equal(await fs.stat(transactionFile).then(() => true, () => false), false,
    "repair removes the transaction it can no longer converge");
  assert.equal((await fs.stat(path.join(bridgeDirectory, "manifest.json"))).isFile(), true);
  const rebuilt = JSON.parse(await fs.readFile(path.join(stateDirectory, "bridge-installation.json"), "utf8"));
  assert.equal(rebuilt.extensionVersion, previous.extensionVersion);
  assert.equal((await installer.readBridgeInstallation()).installed, true,
    "every later read stays usable once the orphaned transaction is gone");
});

test("restoring a staged Bridge does not enter assistant configuration repair", async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  const calls = [];
  const finalState = { schema: "morrow.installer-state.v1", lifecycle: "assistant_ready" };
  installer.maintenanceAdmission = () => null;
  installer.readBridgeInstallation = async () => {
    calls.push("read-bridge");
    return bridgeInstallation({ manualChromeReloadRequired: true });
  };
  installer.rollbackPendingBridgeInstallation = async () => { calls.push("rollback-bridge"); };
  installer.effectiveWorkspace = async () => path.join(root, "UserData", "Materials");
  installer.runtimeSnapshot = async () => { calls.push("refresh-runtime"); };
  installer.state = async () => finalState;
  installer.repairAssistantConfiguration = async () => { calls.push("repair-assistant"); };

  assert.equal(await installer.restorePreviousBridge(), finalState);
  assert.deepEqual(calls, ["read-bridge", "rollback-bridge", "refresh-runtime"]);
});

test("restoring a staged Bridge is admitted while that update still holds its own lease", async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  const monitor = {};
  const finalState = { schema: "morrow.installer-state.v1", lifecycle: "assistant_ready" };
  let rollbacks = 0;
  installer.restartLeases.set("bridge-lease", monitor);
  installer.bridgeLeaseId = "bridge-lease";
  installer.readBridgeInstallation = async () => bridgeInstallation({ manualChromeReloadRequired: true });
  installer.rollbackPendingBridgeInstallation = async () => { rollbacks += 1; };
  installer.effectiveWorkspace = async () => path.join(root, "UserData", "Materials");
  installer.runtimeSnapshot = async () => {};
  installer.state = async () => finalState;

  assert.equal(await installer.restorePreviousBridge(), finalState);
  assert.equal(await installer.repair(), finalState);
  assert.equal(rollbacks, 2, "repair reaches the same rollback for this state");

  // A second lease is other work, and the rollback still refuses to run beside it.
  installer.restartLeases.set("other-lease", {});
  await assert.rejects(() => installer.restorePreviousBridge(), (error) => error.code === "active_or_uncertain_operations");
  await assert.rejects(() => installer.repair(), (error) => error.code === "active_or_uncertain_operations");
});

test("repair replaces an older app-owned Bridge from the sealed release", async () => {
  const root = await temporaryRoot();
  const manifestSha256 = await completePayload(root, { maintenance: MAINTENANCE_MODULE, runtimeMonitor: RECORDING_MONITOR });
  let bridgeReleaseSha256 = await writeBridgeRelease(root, "1.0.0");
  const installer = controller(root, {
    trustedMcpRuntimeManifestSha256: () => manifestSha256,
    trustedBridgeReleaseManifestSha256: () => bridgeReleaseSha256,
    runCli: async (executable, argumentsValue) => {
      if (argumentsValue[1] === "setup") {
        await fs.mkdir(path.join(root, "UserData", "State"), { recursive: true });
        await fs.writeFile(path.join(root, "UserData", "State", "morrow.upstreams.json"), "{}\n");
      }
      return { code: 0, stdout: "", stderr: "" };
    }
  });
  const stateDirectory = path.join(root, "UserData", "State");
  const bridgeDirectory = path.join(root, "UserData", "Bridge");
  await fs.mkdir(stateDirectory, { recursive: true });
  await fs.writeFile(path.join(stateDirectory, "morrow.upstreams.json"), "{}\n");
  await installer.initializeBridgeAtStartup();
  const before = JSON.parse(await fs.readFile(path.join(stateDirectory, "bridge-installation.json"), "utf8"));
  assert.equal(before.extensionVersion, "1.0.0");

  bridgeReleaseSha256 = await writeBridgeRelease(root, "1.0.1");
  const state = await installer.repair();
  const after = JSON.parse(await fs.readFile(path.join(stateDirectory, "bridge-installation.json"), "utf8"));
  assert.equal(after.extensionVersion, "1.0.1");
  assert.notEqual(after.activeFolderChallenge.challengeId, before.activeFolderChallenge.challengeId);
  assert.equal(await fs.readFile(path.join(bridgeDirectory, "src", "service-worker.js"), "utf8"), 'export const version = "1.0.1";\n');
  assert.equal(state.bridge.folderReady, true);
  assert.equal(state.bridge.loadedInChrome, "unknown");
  const backups = await fs.readdir(path.join(stateDirectory, "Backups"));
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateDirectory, "Backups", backups[0]), "utf8")), before);
});

// The runtime reports no Bridge connected: Chrome has not loaded the folder, or
// Chrome is closed. No Chrome is running these files for Morrow, so there is no
// Bridge to fence or reload, and Update Bridge replaces the folder itself.
test("Update Bridge replaces an older Bridge folder directly while no Bridge is connected", async () => {
  const root = await temporaryRoot();
  await fs.mkdir(path.join(root, "UserData", "Materials"), { recursive: true });
  const manifestSha256 = await completePayload(root, { maintenance: MAINTENANCE_MODULE, runtimeMonitor: RECORDING_MONITOR });
  let bridgeReleaseSha256 = await writeBridgeRelease(root, "1.0.0");
  const installer = controller(root, {
    trustedMcpRuntimeManifestSha256: () => manifestSha256,
    trustedBridgeReleaseManifestSha256: () => bridgeReleaseSha256,
  });
  const stateDirectory = path.join(root, "UserData", "State");
  const bridgeDirectory = path.join(root, "UserData", "Bridge");
  await fs.mkdir(stateDirectory, { recursive: true });
  await fs.writeFile(path.join(stateDirectory, "morrow.upstreams.json"), "{}\n");
  await installer.initializeBridgeAtStartup();
  const before = JSON.parse(await fs.readFile(path.join(stateDirectory, "bridge-installation.json"), "utf8"));

  bridgeReleaseSha256 = await writeBridgeRelease(root, "1.0.1");
  globalThis.__morrowRepairOrder = [];
  const offered = await installer.state({ recheckAssistants: true });
  assert.equal(offered.bridge.updateAvailable, true);
  assert.equal(offered.bridge.paired, false, "the runtime reports no Bridge connected");

  // The recording runtime has no Bridge to ask, so any question to a Bridge fails this test.
  const replaced = await installer.reconcileBridgeRelease();
  assert.equal(replaced.version, "1.0.1");
  const after = JSON.parse(await fs.readFile(path.join(stateDirectory, "bridge-installation.json"), "utf8"));
  assert.equal(after.extensionVersion, "1.0.1");
  assert.equal(after.pendingUpdate, null, "nothing waits for a Chrome reload");
  assert.notEqual(after.activeFolderChallenge.challengeId, before.activeFolderChallenge.challengeId);
  assert.equal(await fs.readFile(path.join(bridgeDirectory, "src", "service-worker.js"), "utf8"), 'export const version = "1.0.1";\n');
  const marker = JSON.parse(await fs.readFile(path.join(bridgeDirectory, "morrow-bridge-active-folder.json"), "utf8"));
  assert.equal(marker.manifestVersion, "1.0.1");
  assert.equal(marker.challengeId, after.activeFolderChallenge.challengeId);
  assert.equal(globalThis.__morrowRepairOrder.includes("closed"), false, "the runtime keeps running through the replacement");
  assert.equal(installer.restartLeases.size, 0, "the maintenance lease is released");
  assert.equal(installer.maintenanceAdmission(), null);

  const current = await installer.state({ recheckAssistants: true });
  assert.equal(current.bridge.updateAvailable, false);
  assert.equal(current.bridge.folderReady, true);
  assert.equal(current.bridge.loadedInChrome, "unknown");
});

test("Update Bridge never replaces the folder under a connected Bridge", async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  const installed = bridgeInstallation();
  const status = bridgeStatusAnswer(installed.activeFolderChallenge);
  const monitor = {
    snapshot: () => ({ health: { ...READY_HEALTH, bridgeConnected: true } }),
    bridgeMaintenance: async () => status,
  };
  installer.verifiedBridgeInstallation = async () => installed;
  installer.packagedBridgeRelease = async () => ({ version: "1.0.1" });
  installer.bridgeMonitor = async () => monitor;
  installer.replaceUnconnectedBridge = async () => { throw new Error("must not replace the folder of a connected Bridge"); };
  const staged = bridgeInstallation({ manualChromeReloadRequired: true });
  let stages = 0;
  installer.stageBridgeUpdate = async (record, release, used) => {
    stages += 1;
    assert.equal(record, installed);
    assert.equal(release.version, "1.0.1");
    assert.equal(used, monitor);
    return staged;
  };
  assert.equal(await installer.reconcileBridgeRelease(), staged);
  assert.equal(stages, 1);

  // A runtime that cannot say whether a Bridge is connected is asked the Bridge itself.
  monitor.snapshot = () => ({ health: { ...READY_HEALTH, bridgeConnected: "unknown" } });
  assert.equal(await installer.reconcileBridgeRelease(), staged);
  assert.equal(stages, 2);
});

test("an update of a connected Bridge that fails names the steps the Update panel offers", async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  const installed = bridgeInstallation();
  let answer = async () => bridgeStatusAnswer(installed.activeFolderChallenge, { nonce: "nonce-fedcba9876543210" });
  const monitor = {
    snapshot: () => ({ health: { ...READY_HEALTH, bridgeConnected: true } }),
    bridgeMaintenance: async () => answer(),
  };
  installer.verifiedBridgeInstallation = async () => installed;
  installer.packagedBridgeRelease = async () => ({ version: "1.0.1" });
  installer.bridgeMonitor = async () => monitor;
  installer.replaceUnconnectedBridge = async () => { throw new Error("must not replace the folder of a connected Bridge"); };
  let staging = async () => { throw new Error("must not stage"); };
  installer.stageBridgeUpdate = async () => staging();

  const refused = async () => {
    let caught = null;
    await installer.reconcileBridgeRelease().catch((error) => { caught = error; });
    assert.ok(caught, "the update was expected to fail");
    return caught;
  };
  // Chrome answers for a folder that is not this installation's.
  assert.deepEqual(await refused(), errorDetails("bridge_update_failed"));
  // The Bridge does not answer although the runtime reports it connected.
  answer = async () => { throw Object.assign(new Error("local_owner_bridge_maintenance_unavailable"), { code: "local_owner_bridge_maintenance_unavailable" }); };
  assert.deepEqual(await refused(), errorDetails("bridge_update_failed"));

  answer = async () => bridgeStatusAnswer(installed.activeFolderChallenge);
  staging = async () => { throw Object.assign(new Error("private staging detail"), { code: "bridge_stage_invalid" }); };
  assert.deepEqual(await refused(), errorDetails("bridge_update_failed"));
  // A Bridge in the middle of course work refuses to pause. That is work in progress.
  staging = async () => { throw Object.assign(new Error("bridge_quiesce_busy"), { code: "bridge_quiesce_busy" }); };
  assert.deepEqual(await refused(), errorDetails("active_or_uncertain_operations"));
  // A refusal that already names what holds Morrow keeps its own words.
  for (const code of ["runtime_other_client_connected", "runtime_request_in_flight", "runtime_change_running", "active_or_uncertain_operations"]) {
    staging = async () => { throw errorDetails(code); };
    assert.deepEqual(await refused(), errorDetails(code));
  }

  const failure = errorDetails("bridge_update_failed");
  assert.equal(failure.message, "Morrow could not update Morrow Bridge.");
  assert.match(failure.recovery, /Update Bridge/);
  assert.doesNotMatch(failure.recovery, /Repair Morrow|Check Bridge/, "the Update panel offers neither control");
});

test("repair never replaces changed Bridge bytes under an unchanged Chrome version", async () => {
  const root = await temporaryRoot();
  const manifestSha256 = await completePayload(root, { maintenance: MAINTENANCE_MODULE, runtimeMonitor: RECORDING_MONITOR });
  let bridgeReleaseSha256 = await writeBridgeRelease(root, "1.0.0");
  const installer = controller(root, {
    trustedMcpRuntimeManifestSha256: () => manifestSha256,
    trustedBridgeReleaseManifestSha256: () => bridgeReleaseSha256,
    runCli: async (executable, argumentsValue) => {
      if (argumentsValue[1] === "setup") {
        await fs.mkdir(path.join(root, "UserData", "State"), { recursive: true });
        await fs.writeFile(path.join(root, "UserData", "State", "morrow.upstreams.json"), "{}\n");
      }
      return { code: 0, stdout: "", stderr: "" };
    }
  });
  const stateDirectory = path.join(root, "UserData", "State");
  const bridgeDirectory = path.join(root, "UserData", "Bridge");
  await fs.mkdir(stateDirectory, { recursive: true });
  await fs.writeFile(path.join(stateDirectory, "morrow.upstreams.json"), "{}\n");
  await installer.initializeBridgeAtStartup();
  const before = JSON.parse(await fs.readFile(path.join(stateDirectory, "bridge-installation.json"), "utf8"));

  bridgeReleaseSha256 = await writeBridgeRelease(
    root,
    "1.0.0",
    'export const version = "1.0.0";\nexport const releaseRevision = 2;\n'
  );
  await installer.repair();
  const after = JSON.parse(await fs.readFile(path.join(stateDirectory, "bridge-installation.json"), "utf8"));
  assert.equal(after.extensionVersion, "1.0.0");
  assert.equal(after.releaseManifestSha256, before.releaseManifestSha256);
  assert.equal(await fs.readFile(path.join(bridgeDirectory, "src/service-worker.js"), "utf8"), 'export const version = "1.0.0";\n');
  assert.notEqual(after.activeFolderChallenge.challengeId, before.activeFolderChallenge.challengeId);
});

test("state stops reporting a Bridge folder that was removed while Morrow stayed open", async () => {
  const root = await temporaryRoot();
  await fs.mkdir(path.join(root, "UserData", "Materials"), { recursive: true });
  const { installer } = await repairableController(root, {
    runtimeMonitor: RECORDING_MONITOR.replace("bridgeConnected: false", "bridgeConnected: true")
  });
  const stateDirectory = path.join(root, "UserData", "State");
  const bridgeDirectory = path.join(root, "UserData", "Bridge");
  await fs.mkdir(stateDirectory, { recursive: true });
  await fs.writeFile(path.join(stateDirectory, "morrow.upstreams.json"), "{}\n");
  await installer.initializeBridgeAtStartup();

  assert.equal((await installer.state({ recheckAssistants: true })).bridge.folderReady, true);
  await fs.rm(bridgeDirectory, { recursive: true, force: true });

  const afterRemoval = await installer.state({ recheckAssistants: true });
  assert.equal(afterRemoval.bridge.folderReady, false, "state re-reads the app-owned Bridge folder from disk");
  assert.equal(afterRemoval.bridge.loadedInChrome, false);
  assert.equal(afterRemoval.lifecycle, "repair_required",
    "an already-running extension cannot hide a missing app-owned Bridge folder");
  assert.equal((await installer.state({ recheckAssistants: true })).lifecycle, "repair_required",
    "later refreshes retain the failed disk verification until a verified folder replaces it");
});

test("a fresh Desktop process reports repair when a live unpacked Bridge outlasts damaged installed files", async () => {
  const root = await temporaryRoot();
  await fs.mkdir(path.join(root, "UserData", "Materials"), { recursive: true });
  const runtimeMonitor = RECORDING_MONITOR.replace("bridgeConnected: false", "bridgeConnected: true");
  const first = await repairableController(root, { runtimeMonitor });
  const stateDirectory = path.join(root, "UserData", "State");
  const bridgeDirectory = path.join(root, "UserData", "Bridge");
  await fs.mkdir(stateDirectory, { recursive: true });
  await fs.writeFile(path.join(stateDirectory, "morrow.upstreams.json"), "{}\n");
  await first.installer.initializeBridgeAtStartup();
  await fs.writeFile(path.join(bridgeDirectory, "src", "service-worker.js"), "damaged\n");

  const restarted = controller(root, {
    trustedMcpRuntimeManifestSha256: first.installer.trustedMcpRuntimeManifestSha256,
    trustedBridgeReleaseManifestSha256: first.installer.trustedBridgeReleaseManifestSha256,
    runtimeMonitor,
    detectAssistant: async () => true,
  });
  await assert.rejects(() => restarted.initializeBridgeAtStartup());
  const current = await restarted.state({ recheckAssistants: true });
  assert.equal(current.bridge.paired, true);
  assert.equal(current.bridge.folderReady, false);
  assert.equal(current.lifecycle, "repair_required");
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

test("repair re-points Morrow's entry after the assistant edited its file, and leaves an entry someone else wrote", async () => {
  const root = await temporaryRoot();
  await fs.mkdir(path.join(root, "UserData", "Materials"), { recursive: true });
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

  await installer.repair();
  assert.deepEqual(calls.map((entry) => entry[0]), ["setup", "mcp"], "the edit elsewhere in the file does not stop repair");

  const runCli = installer.runCli;
  installer.runCli = async (executable, argumentsValue, options) => {
    if (argumentsValue[1] !== "mcp") return runCli(executable, argumentsValue, options);
    return {
      code: 1,
      stdout: "",
      stderr: `${JSON.stringify({ schema: "morrow.client-config-error.v1", code: "config_entry_not_morrow", path: target })}\n`
    };
  };
  await assert.rejects(() => installer.repair(), (error) => error.code === "existing_morrow_configuration");
  assert.deepEqual(await fs.readFile(target), edited, "the file is still on disk, byte for byte");
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

  // A concurrent Bridge transaction stays authoritative even if the runtime
  // would otherwise permit a restart.
  installer.runtimeMonitor = { close: async () => { closed = true; }, snapshot: () => ({ health: { canRestart: "yes" } }) };
  await assert.rejects(() => installer.repair(), (error) => error.code === "active_or_uncertain_operations");
  assert.equal(closed, false);
  installer.bridgeReconciliation = null;
});

test("repair keeps a malformed installer record in Backups and starts a fresh one", async () => {
  const root = await temporaryRoot();
  const { installer, calls } = await repairableController(root);
  const stateDirectory = path.join(root, "UserData", "State");
  await fs.mkdir(stateDirectory, { recursive: true });
  if (process.platform !== "win32") await fs.chmod(stateDirectory, 0o700);
  const stored = "{not-json\n";
  await fs.writeFile(path.join(stateDirectory, "installer.json"), stored, { mode: 0o600 });
  await assert.rejects(() => installer.record(), /JSON/);

  const state = await installer.repair();
  assert.deepEqual(await installer.record(), freshRecord());
  const backups = await fs.readdir(path.join(stateDirectory, "Backups"));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(stateDirectory, "Backups", backups[0]), "utf8"), stored);
  assert.equal(state.lifecycle, "ready_for_workspace");
  assert.equal(state.selectedAssistantId, null);
  assert.deepEqual(calls.map((entry) => entry[0]), ["setup"], "a fresh record names no assistant to configure");
});

test("repair leaves an installer record from another app version exactly as it is", async () => {
  const root = await temporaryRoot();
  const { installer, calls } = await repairableController(root);
  const stateDirectory = path.join(root, "UserData", "State");
  await fs.mkdir(stateDirectory, { recursive: true });
  const stored = `${JSON.stringify({
    schema: "morrow.desktop-state.v1",
    version: 2,
    selectedAssistantId: "codex",
    configured: {},
    materialsFolder: path.join(root, "Materials from newer Morrow")
  })}\n`;
  const recordPath = path.join(stateDirectory, "installer.json");
  await fs.writeFile(recordPath, stored, { mode: 0o600 });

  await assert.rejects(() => installer.repair(), (error) => {
    assert.equal(error.code, "installer_record_incompatible");
    assert.equal(error.recovery, "Install the Morrow version that created this setup record. Morrow left the record unchanged.");
    return true;
  });

  assert.equal(await fs.readFile(recordPath, "utf8"), stored);
  assert.deepEqual(calls, []);
  assert.equal((await installer.state()).lifecycle, "repair_required");
});

test("repair writes the assistant configuration again when the file Morrow wrote is gone", async () => {
  const root = await temporaryRoot();
  await fs.mkdir(path.join(root, "UserData", "Materials"), { recursive: true });
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
  assert.equal(calls[1].includes("--expected-config-sha256"), false,
    "a missing file has no current digest for the client configuration command to match");
  assert.equal(calls[1][2], "codex");
  const record = await installer.record();
  assert.equal(record.configured.codex.sha256, sha256(await fs.readFile(target)));
  assert.equal(state.assistants.find((assistant) => assistant.id === "codex").configured, true);
  assert.equal(state.lifecycle, "assistant_ready");
});

test("assistant status keeps an exact Morrow entry configured after unrelated client edits", async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  const target = path.join(root, "Home", ".codex", "config.toml");
  const materials = path.join(root, "UserData", "Materials");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.mkdir(materials, { recursive: true });
  await fs.writeFile(target, 'model = "gpt-6"\n\n[mcp_servers.morrow]\ncommand = "morrow"\n');
  let inspected = null;
  installer.clientConfigModule = async () => ({
    morrowClientConfigurationStatus: (options) => {
      inspected = options;
      return { path: target, configured: true, sha256: sha256("current complete file") };
    }
  });

  const present = await installer.assistantConfigurationPresent(
    { id: "codex", needsProject: false },
    { target, sha256: sha256("older complete file") },
    materials
  );

  assert.equal(present, true);
  assert.deepEqual(inspected, {
    client: "codex",
    scope: "user",
    repositoryRoot: path.join(root, "Payload", "app"),
    upstreamConfigPath: path.join(root, "UserData", "State", "morrow.upstreams.json"),
    nodeCommand: process.platform === "win32"
      ? path.join(root, "Payload", "runtime", "node", "node.exe")
      : path.join(root, "Payload", "runtime", "node", "bin", "node"),
    serverEntryPath: path.join(root, "Payload", "app", "packages", "mcp-server", "dist", "index.js"),
    workspaceRoot: materials,
    serverName: "morrow"
  });
});

test("repair re-points every configured assistant by Morrow's own entry, not by the whole file", async () => {
  const root = await temporaryRoot();
  await fs.mkdir(path.join(root, "UserData", "Materials"), { recursive: true });
  const target = path.join(root, "Home", ".codex", "config.toml");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "[mcp_servers.morrow]\ncommand = \"morrow\"\n");
  const recorded = sha256(await fs.readFile(target));
  const { installer, calls } = await repairableController(root);
  await installer.writeRecord({
    ...freshRecord(),
    selectedAssistantId: "codex",
    configured: { codex: { target, sha256: recorded } }
  });

  await installer.repair();

  assert.deepEqual(calls.map((entry) => entry[0]), ["setup", "mcp"]);
  assert.equal(calls[1].includes("--replace-morrow-entry"), true);
  assert.equal(calls[1].includes("--expected-config-sha256"), false);
  assert.equal((await installer.record()).configured.codex.sha256, recorded);
  assert.equal((await installer.record()).selectedAssistantId, "codex");
});

/**
 * A controller with real files in every place the retention policy names: a
 * State directory with a record, a journal and a backup, the Bridge folder, a
 * materials folder with a file in it, the Blackboard credential folder and
 * configuration file, and one assistant configuration file.
 */
async function installationWithData(root, response, overrides = {}) {
  const { installer } = await repairableController(root, overrides);
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
  await fs.writeFile(path.join(stateDirectory, "Backups", "installer-invalid.json"), "an earlier setup record\n");
  const assistantBackups = path.join(userData, "Assistant settings backups");
  await fs.mkdir(assistantBackups, { recursive: true });
  await fs.writeFile(path.join(assistantBackups, "config.toml.2026-09-01T10-00-00Z.bak"), "an earlier assistant setting\n");
  // Fixture construction owns no runtime. Give only this setup call a stopped
  // guard so tests below can choose their own live-owner behavior.
  const acquireDesktopMutationGuard = installer.acquireDesktopMutationGuard;
  const releaseDesktopMutationGuard = installer.releaseDesktopMutationGuard;
  installer.acquireDesktopMutationGuard = async () => ({ kind: "stopped", leaseId: "fixture", leaseToken: "fixture" });
  installer.releaseDesktopMutationGuard = async (guard) => {
    if (installer.desktopMutationGuard === guard) installer.desktopMutationGuard = null;
  };
  try { await installer.initializeBridgeAtStartup(); }
  finally {
    installer.acquireDesktopMutationGuard = acquireDesktopMutationGuard;
    installer.releaseDesktopMutationGuard = releaseDesktopMutationGuard;
  }
  const materials = path.join(userData, "Materials");
  await fs.mkdir(materials, { recursive: true });
  await fs.writeFile(path.join(materials, "syllabus.md"), "week one\n");
  const assistantConfiguration = path.join(home, ".codex", "config.toml");
  await fs.mkdir(path.dirname(assistantConfiguration), { recursive: true });
  await fs.writeFile(assistantConfiguration, "model = \"gpt-6\"\n\n[mcp_servers.morrow]\ncommand = \"morrow\"\nenv = { MORROW_UPSTREAMS_FILE = \"/State/morrow.upstreams.json\" }\n");
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
      backups: path.join(userData, "Assistant settings backups"),
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
    [paths.state, paths.bridge, paths.materials, paths.credentials, paths.blackboardConfiguration]
  );
  assert.equal(retention.locations.find((location) => location.path === paths.assistantConfiguration).keptReason, "assistant_configuration");
  assert.equal(retention.locations.find((location) => location.path === paths.backups).keptReason, "assistant_backup");
  assert.equal(retention.removal, null);
  // Every path it named is a real path on this computer.
  for (const location of retention.locations) {
    if (location.path === paths.blackboardConfiguration || location.path === paths.credentials) continue;
    assert.equal(await fs.lstat(location.path).then(() => true, () => false), true, `${location.path} exists`);
  }
});

test("the state and the removal confirmation name only places on this computer, and say Chrome loaded the Bridge only when it did", async () => {
  const root = await temporaryRoot();
  const { installer, messageBoxes, paths } = await installationWithData(root, 0);
  // This person never connected Blackboard, and the default materials folder was never made.
  await fs.rm(paths.credentials, { recursive: true, force: true });
  await fs.rm(paths.blackboardConfiguration, { force: true });
  await fs.rm(paths.materials, { recursive: true, force: true });

  const retention = (await installer.state()).retention;
  assert.deepEqual(retention.locations.map((location) => location.path), [paths.state, paths.backups, paths.bridge, paths.assistantConfiguration]);
  for (const location of retention.locations) {
    assert.equal(await fs.lstat(location.path).then(() => true, () => false), true, `${location.path} exists`);
  }

  installer.bridgeLoadedInChrome = async () => "unknown";
  assert.equal((await installer.removeData(null)).status, "cancelled");
  let detail = messageBoxes.at(-1).detail;
  for (const absent of [paths.credentials, paths.blackboardConfiguration, paths.materials]) {
    assert.equal(detail.includes(absent), false, `the confirmation does not name ${absent}`);
  }
  assert.doesNotMatch(detail, /Blackboard/);
  assert.doesNotMatch(detail, /Chrome loaded Morrow Bridge/);
  assert.match(detail, /This cannot be undone\. If you added Morrow Bridge in Chrome, remove it there as well\.$/);

  installer.bridgeLoadedInChrome = async () => true;
  assert.equal((await installer.removeData(null)).status, "cancelled");
  detail = messageBoxes.at(-1).detail;
  assert.match(detail, /This cannot be undone\. Chrome loaded Morrow Bridge from the Bridge folder, so remove Morrow Bridge in Chrome as well\.$/);
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
  for (const value of [paths.state, paths.bridge, paths.materials, paths.credentials, paths.blackboardConfiguration]) {
    assert.ok(options.detail.includes(value), `the confirmation names ${value} as removed`);
  }
  for (const value of [paths.backups, paths.assistantConfiguration]) {
    assert.ok(options.detail.includes(value), `the confirmation names ${value} as kept`);
  }
  assert.ok(options.detail.includes(`Morrow will first take its own morrow entry out of:\n- ChatGPT: ${paths.assistantConfiguration}`));
  assert.ok(options.detail.includes("Morrow will not remove:"));

  // The state carries that nothing was removed, so the panel never reports a
  // removal that did not happen.
  assert.equal((await installer.state()).retention.removal.status, "cancelled");
});

test("a data removal holds a stopped-runtime guard across its confirmation", async () => {
  const root = await temporaryRoot();
  const { installer, paths } = await installationWithData(root, 0);
  await fs.rm(path.join(paths.state, "morrow.upstreams.json"), { force: true });
  globalThis.__morrowStoppedGuardCalls = [];

  const receipt = await installer.removeData(null);

  assert.equal(receipt.status, "cancelled");
  assert.deepEqual(globalThis.__morrowStoppedGuardCalls, ["acquire", "release"]);
  assert.equal(await fs.lstat(paths.state).then(() => true, () => false), true);
  delete globalThis.__morrowStoppedGuardCalls;
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

test("a data removal refuses an owner that will not grant authoritative maintenance", async () => {
  const root = await temporaryRoot();
  const maintenance = [
    "export function localOwnerMaintenanceMarkerPresent() { return false; }",
    "export function readLocalOwnerMaintenanceLease() { return null; }",
    "export function requestLocalOwnerMaintenance() { return null; }",
    "export function clearDeadLocalOwnerMaintenanceLease() { return false; }",
    "export function acquireStoppedLocalOwnerMaintenanceLease() { return null; }",
    "export function replaceDeadLocalOwnerMaintenanceLeaseWithStoppedGuard() { return null; }",
    "export function removeExactLocalOwnerMaintenanceLease() { return false; }",
    ""
  ].join("\n");
  const runtimeMonitor = [
    OBSERVED_MONITOR_SNAPSHOTS,
    "const live = { ...ready, health: { ...ready.health, canRestart: 'unknown' } };",
    "export function createRuntimeMonitor() {",
    "  return {",
    "    start: async () => live,",
    "    snapshot: () => live,",
    "    maintenance: async () => ({ status: 'unavailable' }),",
    "    close: async () => {}",
    "  };",
    "}",
    ""
  ].join("\n");
  const { installer, messageBoxes, paths } = await installationWithData(root, 1, { maintenance, runtimeMonitor });
  const before = await treeDigest(paths.userData);

  await assert.rejects(() => installer.removeData(null), (error) => error.code === "active_or_uncertain_operations");

  assert.deepEqual(messageBoxes, [], "maintenance refusal happens before the destructive confirmation");
  assert.deepEqual(await treeDigest(paths.userData), before);
});

// The runtime names the condition that held its lease. Waiting never ends an
// open assistant, so the removal says to quit it, as every other step does.
test("a data removal an open assistant refuses says to quit the assistant, not to wait", async () => {
  const root = await temporaryRoot();
  const maintenance = [
    "export function localOwnerMaintenanceMarkerPresent() { return false; }",
    "export function readLocalOwnerMaintenanceLease() { return null; }",
    "export function requestLocalOwnerMaintenance() { return null; }",
    "export function clearDeadLocalOwnerMaintenanceLease() { return false; }",
    "export function acquireStoppedLocalOwnerMaintenanceLease() { return null; }",
    "export function replaceDeadLocalOwnerMaintenanceLeaseWithStoppedGuard() { return null; }",
    "export function removeExactLocalOwnerMaintenanceLease() { return false; }",
    ""
  ].join("\n");
  const runtimeMonitor = [
    OBSERVED_MONITOR_SNAPSHOTS,
    "const live = { ...ready, health: { ...ready.health, canRestart: 'unknown' } };",
    "globalThis.__morrowRefusalReason ??= 'local_owner_other_client_connected';",
    "export function createRuntimeMonitor() {",
    "  return {",
    "    start: async () => live,",
    "    snapshot: () => live,",
    "    maintenance: async () => ({ status: 'refused', reason: globalThis.__morrowRefusalReason }),",
    "    close: async () => {}",
    "  };",
    "}",
    ""
  ].join("\n");
  const { installer, messageBoxes, paths } = await installationWithData(root, 1, { maintenance, runtimeMonitor });
  const before = await treeDigest(paths.userData);

  for (const [reason, code] of [
    ["local_owner_other_client_connected", "runtime_other_client_connected"],
    ["local_owner_request_in_flight", "runtime_request_in_flight"],
    ["local_owner_approval_running", "runtime_change_running"],
    ["local_owner_unexplained", "active_or_uncertain_operations"]
  ]) {
    globalThis.__morrowRefusalReason = reason;
    await assert.rejects(() => installer.removeData(null), (error) => {
      assert.deepEqual(error, errorDetails(code));
      return true;
    });
  }
  delete globalThis.__morrowRefusalReason;
  assert.deepEqual(messageBoxes, [], "a refused removal never asks for a confirmation");
  assert.deepEqual(await treeDigest(paths.userData), before);

  const open = errorDetails("runtime_other_client_connected");
  assert.equal(open.message, "An assistant is using Morrow right now.");
  assert.equal(open.recovery, "Quit each assistant that uses Morrow, then start this step again. Morrow changed nothing.");
  assert.doesNotMatch(`${open.message} ${open.recovery}`, /other assistant|[Ww]ait/, "the only open assistant can be the one this step removes");
});

test("a desktop change with no runtime monitor names the condition a live owner refused with", async () => {
  const root = await temporaryRoot();
  const installer = controller(root);
  installer.desktopMutationWorkspace = async () => root;
  installer.canonicalStateDirectory = async () => root;
  installer.localOwnerMaintenanceModule = async () => ({ acquireStoppedLocalOwnerMaintenanceLease: () => null });
  assert.equal(installer.runtimeMonitor, null);
  installer.acquireRestartLease = async () => ({ status: "uncertain", reason: "local_owner_other_client_connected" });
  await assert.rejects(() => installer.withDesktopMutation(async () => { throw new Error("must not run"); }),
    (error) => { assert.deepEqual(error, errorDetails("runtime_other_client_connected")); return true; });
  installer.acquireRestartLease = async () => ({ status: "uncertain" });
  await assert.rejects(() => installer.withDesktopMutation(async () => { throw new Error("must not run"); }),
    (error) => { assert.deepEqual(error, errorDetails("active_or_uncertain_operations")); return true; });
  assert.equal(installer.desktopMutationInProgress, null);
});

test("a confirmed removal waits for an open SQLite owner to close before deleting State", async (t) => {
  const root = await temporaryRoot();
  const maintenance = [
    "export function localOwnerMaintenanceMarkerPresent() { return false; }",
    "export function readLocalOwnerMaintenanceLease() { return null; }",
    "export function requestLocalOwnerMaintenance() { return null; }",
    "export function clearDeadLocalOwnerMaintenanceLease() { return false; }",
    "export function acquireStoppedLocalOwnerMaintenanceLease() { return null; }",
    "export function replaceDeadLocalOwnerMaintenanceLeaseWithStoppedGuard() {",
    "  try { process.kill(globalThis.__morrowRemovalOwner.pid, 0); return null; } catch {}",
    "  globalThis.__morrowRemovalEvents.push('owner-dead');",
    "  return { leaseId: '00000000-0000-4000-8000-000000000003', leaseToken: 'morrow-stopped-maintenance-token-3456789012345678' };",
    "}",
    "export function removeExactLocalOwnerMaintenanceLease() { return true; }",
    ""
  ].join("\n");
  const runtimeMonitor = [
    OBSERVED_MONITOR_SNAPSHOTS,
    "const live = { ...ready, health: { ...ready.health, canRestart: 'unknown' } };",
    "export function createRuntimeMonitor() {",
    "  return {",
    "    start: async () => live,",
    "    snapshot: () => live,",
    "    maintenance: async ({ action }) => {",
    "      globalThis.__morrowRemovalEvents.push(action);",
    "      if (action === 'acquire') return { status: 'held' };",
    "      if (action === 'release') return { status: 'released' };",
    "      globalThis.__morrowRemovalOwner.send({ action: 'close' });",
    "      return { status: 'closing' };",
    "    },",
    "    close: async () => { globalThis.__morrowRemovalEvents.push('monitor-close'); }",
    "  };",
    "}",
    ""
  ].join("\n");
  const { installer, paths } = await installationWithData(root, 1, { maintenance, runtimeMonitor });
  const journalPath = path.join(paths.state, "morrow.sqlite3");
  await fs.rm(journalPath, { force: true });
  const childScript = [
    "const fs = require('node:fs');",
    "const { DatabaseSync } = require('node:sqlite');",
    "const stateDirectory = process.argv[1];",
    "const journalPath = process.argv[2];",
    "const database = new DatabaseSync(journalPath);",
    "database.exec('PRAGMA journal_mode=WAL; CREATE TABLE evidence (value INTEGER NOT NULL)');",
    "const insert = database.prepare('INSERT INTO evidence (value) VALUES (?)');",
    "let writes = 0;",
    "let writeError = null;",
    "let closing = false;",
    "const timer = setInterval(() => { try { insert.run(++writes); } catch (error) { writeError ??= error.message; } }, 10);",
    "process.send({ type: 'ready' });",
    "process.on('message', (message) => {",
    "  if (message?.action !== 'close' || closing) return;",
    "  closing = true;",
    "  setTimeout(() => {",
    "    const statePresentBeforeClose = fs.existsSync(stateDirectory);",
    "    try { insert.run(++writes); } catch (error) { writeError ??= error.message; }",
    "    clearInterval(timer);",
    "    database.close();",
    "    process.send({ type: 'closed', statePresentBeforeClose, writes, writeError }, () => process.exit(writeError ? 1 : 0));",
    "  }, 200);",
    "});",
    ""
  ].join("\n");
  const owner = spawn(process.execPath, ["-e", childScript, paths.state, journalPath], {
    stdio: ["ignore", "ignore", "pipe", "ipc"]
  });
  let exited = false;
  owner.once("exit", () => { exited = true; });
  t.after(() => {
    delete globalThis.__morrowRemovalOwner;
    delete globalThis.__morrowRemovalEvents;
    if (!exited) owner.kill("SIGKILL");
  });
  const message = (type) => new Promise((resolve, reject) => {
    const onMessage = (value) => {
      if (value?.type !== type) return;
      owner.off("error", onError);
      owner.off("message", onMessage);
      resolve(value);
    };
    const onError = (error) => {
      owner.off("message", onMessage);
      reject(error);
    };
    owner.on("message", onMessage);
    owner.once("error", onError);
  });
  await message("ready");
  globalThis.__morrowRemovalOwner = owner;
  globalThis.__morrowRemovalEvents = [];
  installer.dialog.showMessageBox = async () => {
    globalThis.__morrowRemovalEvents.push("confirm");
    return { response: 1, checkboxChecked: false };
  };
  const closed = message("closed");

  const receipt = await installer.removeData(null);
  const ownerReport = await closed;

  assert.equal(receipt.status, "removed");
  assert.deepEqual(globalThis.__morrowRemovalEvents, ["acquire", "confirm", "commit", "monitor-close", "owner-dead"]);
  assert.equal(ownerReport.statePresentBeforeClose, true, "State remained present while SQLite was open");
  assert.equal(ownerReport.writeError, null, "the journal stayed writable until its owner closed it");
  assert.ok(ownerReport.writes > 0);
  assert.equal(await fs.lstat(paths.state).then(() => true, () => false), false);
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
  assert.deepEqual(receipt.removed, [paths.state, paths.bridge, paths.materials, paths.credentials, paths.blackboardConfiguration]);
  assert.deepEqual(receipt.remaining, []);
  assert.deepEqual(receipt.kept, [paths.backups, paths.assistantConfiguration]);
  // The assistant no longer starts a Morrow that is gone; the rest of its file stays.
  assert.equal(await fs.readFile(paths.assistantConfiguration, "utf8"), "model = \"gpt-6\"\n");
  assert.ok(globalThis.__morrowRepairOrder.includes("closed"), "the runtime holding the journal is stopped before its folder is removed");

  // A fresh read of the disk, not the removal's own report.
  for (const removed of receipt.removed) {
    assert.equal(await fs.lstat(removed).then(() => true, () => false), false, `${removed} is gone`);
  }
  const left = await treeDigest(paths.userData);
  assert.equal(left.length, 2);
  assert.equal(left[0], "Assistant settings backups/");
  assert.ok(left[1].startsWith("Assistant settings backups/config.toml.2026-09-01T10-00-00Z.bak"), "only the kept copies of assistant settings are left");
  assert.deepEqual(
    (await treeDigest(paths.home)).filter((entry) => !entry.startsWith(".codex/config.toml ")),
    homeBefore.filter((entry) => !entry.startsWith(".morrow/blackboard-learn.json ")
      && !entry.startsWith(".morrow/credentials/blackboard") && !entry.startsWith(".codex/config.toml ")),
    "every other path outside the list is exactly as it was"
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

test("a new desktop process does not recreate materials after confirmed removal", async () => {
  const root = await temporaryRoot();
  const { installer, paths } = await installationWithData(root, 1);
  assert.equal((await installer.removeData(null)).status, "removed");

  const { installer: relaunched } = await repairableController(root);
  const state = await relaunched.state();

  assert.equal(state.lifecycle, "ready_for_workspace");
  assert.equal(state.materialsFolder, null);
  assert.equal(await fs.lstat(paths.materials).then(() => true, () => false), false);
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
  assert.deepEqual(receipt.removed, [paths.state, paths.bridge, paths.materials, paths.blackboardConfiguration]);
  assert.equal(await fs.lstat(path.join(paths.credentials, "default.secret")).then(() => true, () => false), true,
    "the secret Morrow could not remove is still on this computer");
  assert.equal((await installer.state()).retention.removal.status, "incomplete");
});

test("a data removal that cannot take Morrow's entry out of an assistant removes nothing and names that file", async () => {
  const root = await temporaryRoot();
  const { installer, paths } = await installationWithData(root, 1);
  const foreign = "[mcp_servers.morrow]\ncommand = \"someone-else\"\n";
  await fs.writeFile(paths.assistantConfiguration, foreign);
  const before = await treeDigest(paths.userData);

  await assert.rejects(() => installer.removeData(null), (error) => {
    assert.equal(error.code, "assistant_configuration_changed");
    assert.equal(error.file, paths.assistantConfiguration);
    return true;
  });

  assert.equal(await fs.readFile(paths.assistantConfiguration, "utf8"), foreign);
  assert.deepEqual(await treeDigest(paths.userData), before, "nothing was removed");
});

test("Claude Desktop is reported as installed only when this computer has it, and cannot be set up otherwise", async () => {
  const root = await temporaryRoot();
  let present = false;
  const installer = controller(root, { detectAssistant: async (assistant) => assistant.id === "claude-desktop" ? present : false });
  installer.ensureRuntime = async () => { throw new Error("no payload"); };

  const absent = (await installer.state()).assistants.find((assistant) => assistant.id === "claude-desktop");
  assert.equal(absent.detected, false);
  await assert.rejects(() => installer.installAssistant("claude-desktop", null), (error) => error.code === "assistant_not_found");

  present = true;
  const found = (await installer.state({ recheckAssistants: true })).assistants.find((assistant) => assistant.id === "claude-desktop");
  assert.equal(found.detected, true);
});

test("a Mac Morrow that must move to Applications says so and writes no assistant, folder, or repair", async () => {
  const root = await temporaryRoot();
  const installer = controller(root, { detectAssistant: async () => true, appLocation: () => "move_required" });
  installer.ensureRuntime = async () => { throw new Error("no payload"); };
  const current = await installer.state();
  assert.equal(current.appLocation, "move_required");
  assert.equal(current.lifecycle, "move_required");
  for (const attempt of [
    () => installer.installAssistant("codex", null),
    () => installer.configureWorkspace(null),
    () => installer.repair(),
  ]) {
    await assert.rejects(attempt, (error) => error.code === "app_location_unsupported");
  }
});

test("an assistant whose Morrow entry points at a Morrow that moved asks for the repair that re-points it", async () => {
  const root = await temporaryRoot();
  await fs.mkdir(path.join(root, "UserData", "Materials"), { recursive: true });
  const installer = controller(root, { detectAssistant: async () => true });
  installer.ensureRuntime = async () => installer.paths;
  const target = path.join(root, "Home", ".codex", "config.toml");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "[mcp_servers.morrow]\ncommand = \"/Volumes/Morrow/node\"\n");
  await installer.writeRecord({ ...freshRecord(), selectedAssistantId: "codex", configured: { codex: { target, sha256: sha256("recorded earlier") } } });
  installer.clientConfigModule = async () => ({
    morrowClientConfigurationStatus: () => ({ path: target, configured: false, sha256: sha256("now") }),
    morrowServerEntryArguments: () => ["/Volumes/Morrow/Morrow.app/Contents/Resources/MorrowPayload/app/packages/mcp-server/dist/index.js"],
  });
  const current = await installer.state();
  assert.equal(current.assistantsNeedRepoint, true);

  installer.clientConfigModule = async () => ({
    morrowClientConfigurationStatus: () => ({ path: target, configured: false, sha256: sha256("now") }),
    morrowServerEntryArguments: () => [installer.paths.server],
  });
  assert.equal((await installer.state()).assistantsNeedRepoint, false, "a different materials folder alone is not a move");
});

test("Morrow records that an assistant connected only when its own session holds the runtime", async () => {
  const root = await temporaryRoot();
  await fs.mkdir(path.join(root, "UserData", "Materials"), { recursive: true });
  const installer = controller(root, { detectAssistant: async () => true });
  installer.ensureRuntime = async () => installer.paths;
  const target = path.join(root, "Home", ".codex", "config.toml");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "[mcp_servers.morrow]\n");
  await installer.writeRecord({ ...freshRecord(), selectedAssistantId: "codex", configured: { codex: { target, sha256: sha256(await fs.readFile(target)) } } });
  const codex = async (current) => (await current.state()).assistants.find((assistant) => assistant.id === "codex");
  assert.equal((await codex(installer)).connected, false, "a configured assistant has not connected yet");

  // No other client: the monitor alone holds the runtime, so the lease is granted and released.
  const events = [];
  installer.acquireRestartLease = async () => { events.push("acquire"); return { status: "granted", leaseId: "probe" }; };
  installer.releaseRestartLease = async (leaseId) => { events.push(`release ${leaseId}`); return { status: "released" }; };
  await assert.rejects(() => installer.checkAssistantConnection(), (error) => error.code === "assistant_not_connected");
  assert.deepEqual(events, ["acquire", "release probe"]);
  assert.equal((await codex(installer)).connected, false);

  // The runtime cannot tell, so Morrow says so instead of guessing.
  installer.acquireRestartLease = async () => ({ status: "uncertain" });
  await assert.rejects(() => installer.checkAssistantConnection(), (error) => error.code === "assistant_connection_unconfirmed");

  // The assistant's own Morrow session is connected.
  installer.acquireRestartLease = async () => ({ status: "uncertain", reason: "local_owner_other_client_connected" });
  await installer.checkAssistantConnection();
  assert.equal((await codex(installer)).connected, true);

  // The observation outlives this window.
  const { installer: reopened } = { installer: controller(root, { detectAssistant: async () => true }) };
  reopened.ensureRuntime = async () => reopened.paths;
  assert.equal((await codex(reopened)).connected, true);

  // Setting the assistant up again asks for the restart again.
  await reopened.forgetAssistantConnection("codex");
  assert.equal((await codex(reopened)).connected, false);
});

test("Move to Applications asks the app to move itself, and says how to move it by hand when it cannot", async () => {
  const root = await temporaryRoot();
  let answer = true;
  const moves = [];
  const installer = controller(root, {
    appLocation: () => "move_required",
    moveToApplications: async () => { moves.push("move"); if (answer instanceof Error) throw answer; return answer; },
  });
  assert.equal(await installer.moveToApplications(), true);
  answer = false;
  await assert.rejects(() => installer.moveToApplications(), (error) => error.code === "app_location_move_failed");
  answer = new Error("the person cancelled the password prompt");
  await assert.rejects(() => installer.moveToApplications(), (error) => error.code === "app_location_move_failed");
  assert.deepEqual(moves, ["move", "move", "move"]);

  const settled = controller(root, { appLocation: () => "ok", moveToApplications: async () => { moves.push("unexpected"); return true; } });
  assert.equal(await settled.moveToApplications(), false);
  assert.deepEqual(moves, ["move", "move", "move"]);
});
