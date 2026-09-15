import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { hardenPrivateDirectory } from "../../packages/gateway-core/dist/private-file-access.js";
import { createChildProcessReclaimer, createRuntimeMonitor } from "../shared/runtime-monitor.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const gatewayEntry = path.join(repository, "packages/mcp-server/dist/index.js");
const fakeUpstream = path.join(repository, "packages/mcp-server/test/fixtures/fake-upstream.mjs");
const sourcePackage = path.join(repository, "packages/mcp-server");

async function privateTemporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  if (!hardenPrivateDirectory(directory)) {
    await removeTemporaryDirectory(directory);
    throw new Error("The runtime-monitor fixture directory could not be made private");
  }
  return directory;
}

async function removeTemporaryDirectory(directory) {
  await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

async function waitFor(predicate, detail) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${detail}`);
}

test("child reclaim never signals a different process that reused the transport PID", async () => {
  const signals = [];
  let clock = 0;
  const identities = [true, false];
  const reclaim = createChildProcessReclaimer({
    processAlive: () => true,
    processMatchesExactStart: async () => identities.shift() ?? false,
    signalProcess: (_pid, signal) => { signals.push(signal); },
    pause: async (milliseconds) => { clock += milliseconds; },
    now: () => clock,
  });

  assert.equal(await reclaim(1234, "2026-09-14T00:00:00.000Z", 100), true);
  assert.deepEqual(signals, ["SIGTERM"], "a reused PID is never sent the final signal");

  signals.length = 0;
  clock = 0;
  const matching = [true, true, false];
  const reclaimMatching = createChildProcessReclaimer({
    processAlive: () => true,
    processMatchesExactStart: async () => matching.shift() ?? false,
    signalProcess: (_pid, signal) => { signals.push(signal); },
    pause: async (milliseconds) => { clock += milliseconds; },
    now: () => clock,
  });
  assert.equal(await reclaimMatching(1234, "2026-09-14T00:00:00.000Z", 100), true);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

function processIsAlive(pid) {
  // Every process these tests spawn runs as this user, so a live pid this
  // user cannot signal belongs to someone else and is never a monitor child.
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writeGatewayConfig(directory) {
  const config = {
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    toolSurface: "full",
    sourcePolicy: { requireAttestation: false },
    upstreams: [{
      id: "morrow-legacy",
      label: "Fixture",
      kind: "mcp-stdio",
      command: process.execPath,
      args: [fakeUpstream],
      env: { FAKE_SOURCE: "morrow-legacy" },
      priority: 1,
      required: true,
      enabled: true,
      outputPrivacy: {
        canvas_page_get: {
          allowedFields: ["source", "course_id"],
          dataClass: "course",
          maxRecords: 10,
          maxBytes: 2_000,
          freeText: "deny",
          learnerTokens: false,
          artifactInspection: "deny",
        },
      },
    }],
    filters: { excludePrefixes: [], excludeNames: [] },
    operationJournal: { path: path.join(directory, "gateway.sqlite3") },
    batchScheduler: { maxConcurrentWindows: 1 },
    maxCatalogTools: 100,
  };
  const configPath = path.join(directory, "morrow.upstreams.json");
  await writeFile(configPath, `${JSON.stringify(config)}\n`, "utf8");
  return configPath;
}

async function writeMockGateway(directory, entryDirectory = sourcePackage) {
  const entry = path.join(entryDirectory, `.runtime-monitor-mock-${path.basename(directory)}.cjs`);
  const script = String.raw`
const crypto = require("node:crypto");
const fs = require("node:fs");
const nodePath = require("node:path");
const { McpServer } = require("@modelcontextprotocol/server");
const { serveStdio } = require("@modelcontextprotocol/server/stdio");
const z = require("zod/v4");
const mode = process.env.MORROW_RUNTIME_MONITOR_FIXTURE || "good";
const log = process.env.MORROW_RUNTIME_MONITOR_LOG;
// The stall regression records every spawned fixture pid here to prove the
// monitor reclaimed each generation's child.
const pidLog = process.env.MORROW_RUNTIME_MONITOR_PID_LOG;
if (pidLog) fs.appendFileSync(pidLog, "pid:" + process.pid + "\n", "utf8");
// A stall never settles its operation. A frozen fixture also ignores SIGTERM and
// spins the event loop, so only a reclaim that escalates to SIGKILL ends it.
const stall = () => new Promise(() => {});
const freeze = () => { process.on("SIGTERM", () => {}); setTimeout(() => { for (;;) { /* spin */ } }, 0); return stall(); };
if (mode === "stall-initialize") { process.stdin.resume(); setInterval(() => {}, 1000); }
// Mirrors the packaged gateway: read the sealed manifest that sits beside the
// payload this entrypoint was loaded from and hash its bytes. Nothing about the
// runtime identity comes from the parent process.
const mcpRuntime = (() => {
  try {
    const bytes = fs.readFileSync(nodePath.resolve(__dirname, "../../../mcp-runtime-manifest.json"));
    const manifest = JSON.parse(bytes.toString("utf8"));
    if (manifest.schema !== "morrow.mcp-runtime-manifest.v2" || manifest.package.name !== "@morrow-lms/gateway") return null;
    return {
      schema: "morrow.mcp-runtime.health.v1",
      packageVersion: manifest.package.version,
      manifestSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    return null;
  }
})();
let healthCalls = 0;
const note = (value) => { if (log) fs.appendFileSync(log, value + "\n", "utf8"); };
const server = new McpServer({ name: "runtime-monitor-fixture", version: "1" });
server.registerTool("morrow_health", { inputSchema: z.object({}) }, async () => {
  note("morrow_health");
  if (mode === "stall-health") return stall();
  if (mode === "freeze-health") return freeze();
  healthCalls += 1;
  const busy = mode === "busy";
  const partial = mode === "partial";
  return { content: [{ type: "text", text: "health" }], structuredContent: {
    schema: "morrow.health.v1", ...(mcpRuntime ? { mcpRuntime } : {}), components: {
      gateway: { ready: mode === "warming" ? healthCalls > 1 : true }, extensionBridge: { connected: true, listening: true },
      effectBroker: partial ? { unresolvedOperationCount: 0 } : { unresolvedOperationCount: 0, dispatchingCount: busy ? 1 : 0, appliedOrUnknownCount: 0 },
      batchLedger: { activeBatches: 0, inspectionRequiredBatches: 0 },
    },
  }};
});
server.registerResource("runtime-monitor-guidance", "morrow://guidance/course-audit-v1", { mimeType: "text/plain" }, async (uri) => {
  if (mode === "stall-resource") return stall();
  return { contents: [{ uri: uri.href, text: "Morrow runtime monitor fixture guidance." }] };
});
const CANVAS = { sourceBindingId: "canvas:course-42", provider: "canvas", courseId: "42", runtimeVerified: true, sessionGeneration: 1, courseName: "Verified Course" };
const MOODLE = { sourceBindingId: "moodle:course-77", provider: "moodle", courseId: "77", runtimeVerified: true, sessionGeneration: 1, courseName: "Second Course" };
const BLACKBOARD = { sourceBindingId: "blackboard:course-1", provider: "blackboard", courseId: "_11_1", runtimeVerified: true, sessionGeneration: 1, courseName: "Blackboard Course" };
const OTHER_BLACKBOARD = { sourceBindingId: "blackboard:course-2", provider: "blackboard", courseId: "_12_1", runtimeVerified: true, sessionGeneration: 1, courseName: "Other Blackboard Course" };
let bindingCalls = 0;
const connectedBindings = () => {
  if (mode === "incomplete") return [Object.assign({}, CANVAS, { sessionGeneration: 0, courseName: "Ignored" })];
  if (mode === "changed") return [Object.assign({}, CANVAS, { sessionGeneration: 2, courseName: "Changed Course" })];
  if (mode === "multi") return [CANVAS, MOODLE];
  if (mode === "multi-reordered") return [MOODLE, CANVAS];
  if (mode === "durable-second-read") return [CANVAS, Object.assign({}, MOODLE, { firstReadCompleted: true })];
  if (mode === "multi-moodle") return [BLACKBOARD, MOODLE];
  if (mode === "blackboard-only") return [BLACKBOARD, OTHER_BLACKBOARD];
  // The same course in a new browser session, from the third bindings read on:
  // the binding the monitor selected changes before the read is dispatched.
  if (mode === "multi-shift") return [Object.assign({}, CANVAS, { sessionGeneration: bindingCalls > 2 ? 2 : 1 }), MOODLE];
  return [CANVAS];
};
server.registerTool("morrow_capability_read", {
  inputSchema: z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }),
}, async ({ name, arguments: input }) => {
  note(name);
  if (name === "morrow_browser_bindings" && mode === "stall-bindings") return stall();
  if (name !== "morrow_browser_bindings" && mode === "stall-read") return stall();
  if (name === "morrow_browser_bindings") {
    bindingCalls += 1;
    const bindings = connectedBindings();
    if (mode === "exit-after-status") {
      note("status-process:" + process.pid);
      setTimeout(() => process.exit(71), 25);
    }
    return { content: [{ type: "text", text: "bindings" }], structuredContent: {
      schema: "morrow.result.v1", data: { schema: "morrow.browser-bindings.v1", ok: true, count: bindings.length, bindings },
    }};
  }
  if (name === "canvas_get_single_course_courses") {
    const valid = input && input.id === "42" && input._morrow && input._morrow.source_binding_id === "canvas:course-42";
    return { content: [{ type: "text", text: "course" }], structuredContent: {
      schema: "morrow.result.v1", data: {
        schema: "morrow.canvas-connector.result.v1", ok: true, provider: "canvas", commandKind: "invoke_read",
        result: { schema: "morrow.canvas-browser-result.v1", ok: true, sent: true, data: valid ? { id: "42" } : { id: "wrong" } },
      },
    }};
  }
  if (name === "moodle_get_course") {
    const valid = input && input.course_id === "77" && input._morrow && input._morrow.source_binding_id === "moodle:course-77";
    return { content: [{ type: "text", text: "course" }], structuredContent: {
      schema: "morrow.result.v1", data: {
        schema: "morrow.canvas-connector.result.v1", ok: true, provider: "moodle", commandKind: "invoke_read",
        result: { schema: "morrow.moodle-browser-result.v1", ok: true, sent: true, data: valid ? { course_id: "77" } : { course_id: "wrong" } },
      },
    }};
  }
  return { isError: true, content: [{ type: "text", text: "unavailable" }], structuredContent: { schema: "morrow.problem.v1" } };
});
if (mode !== "stall-initialize") void serveStdio(() => server);
`;
  await writeFile(entry, script, { mode: 0o600 });
  return entry;
}

function mcpRuntimeManifestFixture(entrypointSha256) {
  return {
    schema: "morrow.mcp-runtime-manifest.v2",
    package: { name: "@morrow-lms/gateway", version: "1.0.0-rc.0" },
    entrypoint: { path: "packages/mcp-server/dist/index.js", bytes: 341, sha256: entrypointSha256 },
    dependencies: [{
      name: "@morrow-lms/gateway",
      version: "1.0.0-rc.0",
      packageJson: { path: "node_modules/@morrow-lms/gateway/package.json", bytes: 512, sha256: "d".repeat(64) },
      files: [{ path: "node_modules/@morrow-lms/gateway/package.json", bytes: 512, sha256: "d".repeat(64) }],
    }],
  };
}

/**
 * Builds the directory shape a packaged install has: the sealed manifest at
 * app/mcp-runtime-manifest.json and the gateway entrypoint three directories
 * below it. The stub gateway resolves the manifest from that layout, so the
 * digest it reports is the digest of the file on disk. The fixture lives under
 * packages/mcp-server so the stub resolves its MCP modules from the workspace.
 */
async function writePayloadGateway(directory, manifest) {
  const root = path.join(sourcePackage, `.runtime-monitor-payload-${path.basename(directory)}`);
  const manifestPath = path.join(root, "app", "mcp-runtime-manifest.json");
  const distDirectory = path.join(root, "app", "packages", "mcp-server", "dist");
  await mkdir(distDirectory, { recursive: true });
  const writeManifest = async (value) => {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    await writeFile(manifestPath, bytes, { mode: 0o600 });
    return {
      schema: "morrow.mcp-runtime.health.v1",
      packageVersion: value.package.version,
      manifestSha256: createHash("sha256").update(bytes).digest("hex"),
    };
  };
  const expected = await writeManifest(manifest);
  return {
    root,
    expected,
    writeManifest,
    removeManifest: () => rm(manifestPath, { force: true }),
    entry: await writeMockGateway(directory, distDirectory),
  };
}

async function bridgeOwnerEndpoint(workspaceRoot, journalPath) {
  const extensionId = "a".repeat(32);
  const manifestVersion = "1.0.2";
  const leaseId = randomUUID();
  const leaseToken = "morrow-runtime-monitor-bridge-test-lease-token-123456";
  const calls = [];
  let malformed = false;
  let storeStatus = false;
  let statusOverride = null;
  const proof = () => ({
    schema: "morrow.bridge.active-folder-proof.v1",
    extensionId,
    manifestVersion,
    challengeId: "runtime-monitor-bridge-challenge",
    nonce: "runtime-monitor-bridge-nonce",
    challengeSha256: "d".repeat(64),
  });
  const resultFor = (control) => {
    if (control.action === "status" && statusOverride !== null) return statusOverride;
    if (malformed) return { schema: "morrow.bridge.update-status.v1" };
    if (control.action === "status") return storeStatus
      ? { schema: "morrow.bridge.update-status.v1", extensionId, manifestVersion: "1.0.3", installType: "normal", quiescent: false, activeFolderProof: null }
      : { schema: "morrow.bridge.update-status.v1", extensionId, manifestVersion, installType: "development", quiescent: false, activeFolderProof: proof() };
    if (control.action === "quiesce") return {
      schema: "morrow.bridge.update-quiesced.v1", extensionId, manifestVersion, installType: "development", quiescent: true,
      quiesceEpoch: "runtime-monitor-bridge-quiesce-epoch", activeFolderProof: proof(),
    };
    if (control.action === "readback") return {
      schema: "morrow.bridge.update-readback.v1", extensionId, manifestVersion, installType: "development", activeFolderProof: proof(),
    };
    if (control.action === "commit") return {
      schema: "morrow.bridge.update-committed.v1",
      extensionId,
      previousManifestVersion: control.previousManifestVersion,
      manifestVersion,
      quiesceEpoch: control.quiesceEpoch,
      committed: true,
      activeFolderProof: proof(),
    };
    return {
      schema: "morrow.bridge.update-resumed.v1", extensionId, manifestVersion, quiesceEpoch: control.quiesceEpoch, resumed: true,
    };
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* The test records the malformed request. */ }
    calls.push({
      authorization: request.headers.authorization,
      proxyPid: request.headers["x-morrow-proxy-pid"],
      workspace: request.headers["x-morrow-workspace"],
      body,
    });
    let payload;
    if (request.method !== "POST" || request.url !== "/morrow-maintenance/v1" || !body) {
      response.writeHead(404).end();
      return;
    }
    if (body.action === "acquire") {
      payload = {
        schema: "morrow.local-owner-maintenance.v1", status: "held", leaseId, leaseToken,
        ownerNonce: descriptor.nonce, holderPid: body.holderPid, monitorProxyPid: body.monitorProxyPid,
      };
    } else if (body.action === "release") {
      payload = { schema: "morrow.local-owner-maintenance.v1", status: "released", leaseId: body.leaseId };
    } else if (body.action === "commit") {
      payload = { schema: "morrow.local-owner-maintenance.v1", status: "closing", leaseId: body.leaseId };
    } else if (body.action === "bridge") {
      payload = { schema: "morrow.local-owner-maintenance.v1", status: "bridge", result: resultFor(body.control) };
    } else {
      response.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ schema: "morrow.problem.v1", code: "fixture_unavailable" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const descriptor = {
    schema: "morrow.local-owner.v1",
    nonce: randomUUID(),
    pid: process.pid,
    port: address.port,
    token: "morrow-runtime-monitor-bridge-test-owner-token-123456",
    journalPath,
    configDigest: "e".repeat(64),
    startedAt: new Date().toISOString(),
  };
  const descriptorPath = `${journalPath}.local-owner.json`;
  await writeFile(descriptorPath, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
  await chmod(descriptorPath, 0o600);
  return {
    extensionId,
    manifestVersion,
    leaseToken,
    calls,
    malformed: () => { malformed = true; },
    useStoreStatus: () => { storeStatus = true; },
    proof,
    // Answers one exact status result, whatever the fixture would otherwise
    // return, so the status shapes the monitor must refuse can be read back.
    setStatus: (value) => { malformed = false; statusOverride = value; },
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

test("uses one durable gateway owner instead of starting a connector", async (t) => {
  assert.equal(existsSync(gatewayEntry), true, "build packages/mcp-server before this test");
  const directory = await privateTemporaryDirectory("morrow-runtime-monitor-owner-");
  const workspaceRoot = await realpath(directory);
  const configPath = await writeGatewayConfig(workspaceRoot);
  const journalPath = path.join(workspaceRoot, "gateway.sqlite3");
  const common = { nodePath: process.execPath, serverEntryPath: gatewayEntry, upstreamsPath: configPath, workspaceRoot, journalPath };
  const first = createRuntimeMonitor(common);
  const second = createRuntimeMonitor(common);
  t.after(async () => {
    await Promise.all([first.close(), second.close()]);
    await removeTemporaryDirectory(directory);
  });

  const firstSnapshot = await first.start();
  const ownerPath = path.join(directory, "gateway.sqlite3.local-owner.json");
  assert.equal(existsSync(ownerPath), true);
  const owner = JSON.parse(await readFile(ownerPath, "utf8"));
  assert.deepEqual(firstSnapshot.health, { attempted: true, gatewayReady: true, bridgeConnected: false, canRestart: "unknown" });
  assert.deepEqual(await first.firstSafeRead(), {
    schema: "morrow.installer-first-safe-read.v1",
    completed: false,
    runtimeVerifiedCourseCount: 0,
    selectedCourseName: null,
    firstPreviewCourseName: null,
  });
  assert.deepEqual(await first.maintenance({ action: "acquire", holderPid: process.pid }), {
    schema: "morrow.installer-maintenance.v1",
    action: "acquire",
    status: "held",
  });
  assert.equal(first.snapshot().health.canRestart, "yes");
  assert.equal((await first.start()).health.canRestart, "yes", "a held owner must not receive another monitor health request");
  assert.deepEqual(await first.maintenance({ action: "release", holderPid: process.pid }), {
    schema: "morrow.installer-maintenance.v1",
    action: "release",
    status: "released",
  });
  assert.equal(first.snapshot().health.canRestart, "unknown");
  const secondSnapshot = await second.start();
  assert.deepEqual(secondSnapshot.health, firstSnapshot.health);
  assert.equal(secondSnapshot.bindings.runtimeVerifiedCourseCount, 0);
  assert.deepEqual(secondSnapshot.firstPreview, { available: "no", completed: false });
  assert.equal(JSON.parse(await readFile(ownerPath, "utf8")).pid, owner.pid);

  await Promise.all([first.close(), second.close()]);
  await waitFor(() => !existsSync(ownerPath), "gateway owner cleanup");
});

test("uses only the held private owner lease for Bridge maintenance", async (t) => {
  const directory = await privateTemporaryDirectory("morrow-runtime-monitor-bridge-");
  const workspaceRoot = await realpath(directory);
  const journalPath = path.join(workspaceRoot, "gateway.sqlite3");
  const entry = await writeMockGateway(directory, path.dirname(gatewayEntry));
  const endpoint = await bridgeOwnerEndpoint(workspaceRoot, journalPath);
  const monitor = createRuntimeMonitor({
    nodePath: process.execPath,
    serverEntryPath: entry,
    upstreamsPath: path.join(workspaceRoot, "upstreams.json"),
    workspaceRoot,
    journalPath,
  });
  t.after(async () => {
    await monitor.close();
    await endpoint.close();
    await rm(entry, { force: true });
    await removeTemporaryDirectory(directory);
  });

  const status = await monitor.bridgeMaintenance({ action: "status" });
  assert.deepEqual(status, {
    schema: "morrow.bridge.update-status.v1",
    extensionId: endpoint.extensionId,
    manifestVersion: endpoint.manifestVersion,
    installType: "development",
    quiescent: false,
    activeFolderProof: {
      schema: "morrow.bridge.active-folder-proof.v1",
      extensionId: endpoint.extensionId,
      manifestVersion: endpoint.manifestVersion,
      challengeId: "runtime-monitor-bridge-challenge",
      nonce: "runtime-monitor-bridge-nonce",
      challengeSha256: "d".repeat(64),
    },
  });
  assert.equal(JSON.stringify(status).includes(endpoint.leaseToken), false);
  endpoint.useStoreStatus();
  assert.deepEqual(await monitor.bridgeMaintenance({ action: "status" }), {
    schema: "morrow.bridge.update-status.v1",
    extensionId: endpoint.extensionId,
    manifestVersion: "1.0.3",
    installType: "normal",
    quiescent: false,
    activeFolderProof: null,
  });
  await assert.rejects(monitor.bridgeMaintenance({ action: "quiesce" }), /lease is not held/);
  assert.equal(endpoint.calls.length, 2, "non-status Bridge controls must not reach the owner before acquire");

  await monitor.start();
  assert.deepEqual(await monitor.maintenance({ action: "acquire", holderPid: process.pid }), {
    schema: "morrow.installer-maintenance.v1", action: "acquire", status: "held",
  });
  const quiesced = await monitor.bridgeMaintenance({ action: "quiesce" });
  assert.equal(quiesced.schema, "morrow.bridge.update-quiesced.v1");
  assert.equal(quiesced.quiescent, true);
  const readback = await monitor.bridgeMaintenance({ action: "readback" });
  assert.equal(readback.schema, "morrow.bridge.update-readback.v1");
  const committed = await monitor.bridgeMaintenance({
    action: "commit", previousManifestVersion: "1.0.1", quiesceEpoch: quiesced.quiesceEpoch,
  });
  assert.equal(committed.schema, "morrow.bridge.update-committed.v1");
  const resumed = await monitor.bridgeMaintenance({
    action: "resume", quiesceEpoch: quiesced.quiesceEpoch, fileLayerRestored: true,
  });
  assert.deepEqual(resumed, {
    schema: "morrow.bridge.update-resumed.v1",
    extensionId: endpoint.extensionId,
    manifestVersion: endpoint.manifestVersion,
    quiesceEpoch: quiesced.quiesceEpoch,
    resumed: true,
  });
  endpoint.malformed();
  await assert.rejects(monitor.bridgeMaintenance({ action: "status" }), /Bridge maintenance result is invalid/);

  const privateCalls = endpoint.calls.map((call) => ({
    action: call.body?.action,
    control: call.body?.control?.action || null,
    hasLease: Object.hasOwn(call.body || {}, "leaseId") && Object.hasOwn(call.body || {}, "leaseToken"),
    authorization: call.authorization,
    proxyPid: call.proxyPid,
    workspace: call.workspace,
  }));
  assert.deepEqual(privateCalls.map(({ action, control, hasLease }) => ({ action, control, hasLease })), [
    { action: "bridge", control: "status", hasLease: false },
    { action: "bridge", control: "status", hasLease: false },
    { action: "acquire", control: null, hasLease: false },
    { action: "bridge", control: "quiesce", hasLease: true },
    { action: "bridge", control: "readback", hasLease: true },
    { action: "bridge", control: "commit", hasLease: true },
    { action: "bridge", control: "resume", hasLease: true },
    { action: "bridge", control: "status", hasLease: false },
  ]);
  for (const call of privateCalls) {
    assert.equal(call.authorization, "Bearer morrow-runtime-monitor-bridge-test-owner-token-123456");
    assert.equal(call.proxyPid, String(process.pid));
    assert.equal(call.workspace, Buffer.from(workspaceRoot, "utf8").toString("base64url"));
  }

  assert.deepEqual(await monitor.maintenance({ action: "release", holderPid: process.pid }), {
    schema: "morrow.installer-maintenance.v1", action: "release", status: "released",
  });
  await assert.rejects(monitor.bridgeMaintenance({ action: "readback" }), /lease is not held/);

  // A Chrome Web Store Bridge may answer exactly one status shape: install type
  // "normal" carrying no active-folder proof. A Store install that claims a
  // proof it cannot have, a development install that omits the proof it must
  // have, and any install type Morrow does not know are all refused here, so
  // "normal" never becomes a way past the active-folder check.
  const storeShape = {
    schema: "morrow.bridge.update-status.v1",
    extensionId: endpoint.extensionId,
    manifestVersion: endpoint.manifestVersion,
    installType: "normal",
    quiescent: false,
    activeFolderProof: null,
  };
  endpoint.setStatus({ ...storeShape, activeFolderProof: endpoint.proof() });
  await assert.rejects(monitor.bridgeMaintenance({ action: "status" }), /Bridge maintenance result is invalid/);
  endpoint.setStatus({ ...storeShape, installType: "development" });
  await assert.rejects(monitor.bridgeMaintenance({ action: "status" }), /Bridge maintenance result is invalid/);
  endpoint.setStatus({ ...storeShape, installType: "chrome_web_store" });
  await assert.rejects(monitor.bridgeMaintenance({ action: "status" }), /Bridge maintenance result is invalid/);
  endpoint.setStatus(storeShape);
  assert.deepEqual(await monitor.bridgeMaintenance({ action: "status" }), storeShape);
});

test("reports only sanitized verified runtime state and reconnects through public reads", async (t) => {
  const directory = await privateTemporaryDirectory("morrow-runtime-monitor-mock-");
  const workspaceRoot = await realpath(directory);
  const log = path.join(directory, "calls.log");
  const entry = await writeMockGateway(directory);
  const originalMode = process.env.MORROW_RUNTIME_MONITOR_FIXTURE;
  const originalLog = process.env.MORROW_RUNTIME_MONITOR_LOG;
  process.env.MORROW_RUNTIME_MONITOR_FIXTURE = "good";
  process.env.MORROW_RUNTIME_MONITOR_LOG = log;
  const monitor = createRuntimeMonitor({ nodePath: process.execPath, serverEntryPath: entry, upstreamsPath: path.join(workspaceRoot, "upstreams.json"), workspaceRoot, journalPath: path.join(workspaceRoot, "gateway.sqlite3") });
  t.after(async () => {
    if (originalMode === undefined) delete process.env.MORROW_RUNTIME_MONITOR_FIXTURE;
    else process.env.MORROW_RUNTIME_MONITOR_FIXTURE = originalMode;
    if (originalLog === undefined) delete process.env.MORROW_RUNTIME_MONITOR_LOG;
    else process.env.MORROW_RUNTIME_MONITOR_LOG = originalLog;
    await monitor.close();
    await rm(entry, { force: true });
    await removeTemporaryDirectory(directory);
  });
  const verified = await monitor.start();
  assert.deepEqual(verified, {
    schema: "morrow.installer-runtime.v1",
    health: { attempted: true, gatewayReady: true, bridgeConnected: true, canRestart: "unknown" },
    bindings: { runtimeVerifiedCourseCount: 1, selectedCourseName: "Verified Course", firstPreviewCourseName: "Verified Course" },
    firstPreview: { available: "yes", completed: false },
  });
  assert.equal(JSON.stringify(verified).includes("canvas:course-42"), false);
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
    "morrow_health", "morrow_browser_bindings",
  ]);
  const completed = await monitor.firstSafeRead();
  assert.deepEqual(completed, {
    schema: "morrow.installer-first-safe-read.v1",
    completed: true,
    runtimeVerifiedCourseCount: 1,
    selectedCourseName: "Verified Course",
    firstPreviewCourseName: "Verified Course",
  });
  assert.deepEqual(monitor.snapshot().firstPreview, { available: "yes", completed: true });
  await monitor.close();
  const reconnected = await monitor.start();
  assert.deepEqual(reconnected.firstPreview, { available: "yes", completed: true });
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
    "morrow_health", "morrow_browser_bindings",
    "morrow_health", "morrow_browser_bindings", "canvas_get_single_course_courses", "morrow_browser_bindings",
    "morrow_health", "morrow_browser_bindings",
  ]);

  await monitor.close();
  process.env.MORROW_RUNTIME_MONITOR_FIXTURE = "changed";
  const changed = await monitor.start();
  assert.deepEqual(changed.bindings, { runtimeVerifiedCourseCount: 1, selectedCourseName: "Changed Course", firstPreviewCourseName: "Changed Course" });
  assert.deepEqual(changed.firstPreview, { available: "yes", completed: false });
  await monitor.close();
  process.env.MORROW_RUNTIME_MONITOR_FIXTURE = "incomplete";
  const incomplete = await monitor.start();
  assert.deepEqual(incomplete.bindings, { runtimeVerifiedCourseCount: 0, selectedCourseName: null, firstPreviewCourseName: null });
  assert.deepEqual(incomplete.firstPreview, { available: "no", completed: false });
  await monitor.close();
  process.env.MORROW_RUNTIME_MONITOR_FIXTURE = "busy";
  assert.equal((await monitor.start()).health.canRestart, "unknown");
  await monitor.close();
  process.env.MORROW_RUNTIME_MONITOR_FIXTURE = "partial";
  assert.equal((await monitor.start()).health.canRestart, "unknown");
});

test("replaces a connected runtime client after its stdio process dies", async (t) => {
  const directory = await privateTemporaryDirectory("morrow-runtime-monitor-reconnect-");
  const workspaceRoot = await realpath(directory);
  const log = path.join(directory, "calls.log");
  const entry = await writeMockGateway(directory);
  const originalMode = process.env.MORROW_RUNTIME_MONITOR_FIXTURE;
  const originalLog = process.env.MORROW_RUNTIME_MONITOR_LOG;
  process.env.MORROW_RUNTIME_MONITOR_FIXTURE = "exit-after-status";
  process.env.MORROW_RUNTIME_MONITOR_LOG = log;
  const monitor = createRuntimeMonitor({
    nodePath: process.execPath,
    serverEntryPath: entry,
    upstreamsPath: path.join(workspaceRoot, "upstreams.json"),
    workspaceRoot,
    journalPath: path.join(workspaceRoot, "gateway.sqlite3"),
  });
  t.after(async () => {
    if (originalMode === undefined) delete process.env.MORROW_RUNTIME_MONITOR_FIXTURE;
    else process.env.MORROW_RUNTIME_MONITOR_FIXTURE = originalMode;
    if (originalLog === undefined) delete process.env.MORROW_RUNTIME_MONITOR_LOG;
    else process.env.MORROW_RUNTIME_MONITOR_LOG = originalLog;
    await monitor.close();
    await rm(entry, { force: true });
    await removeTemporaryDirectory(directory);
  });

  const first = await monitor.start();
  assert.equal(first.health.gatewayReady, true);
  const statusLine = (await readFile(log, "utf8")).trim().split("\n").find((line) => line.startsWith("status-process:"));
  const deadPid = Number(statusLine?.slice("status-process:".length));
  assert.equal(Number.isSafeInteger(deadPid), true);
  await waitFor(() => !processIsAlive(deadPid), "the first runtime process to exit");

  process.env.MORROW_RUNTIME_MONITOR_FIXTURE = "good";
  const second = await monitor.start();
  assert.equal(second.health.gatewayReady, true);
  assert.deepEqual(second.bindings, {
    runtimeVerifiedCourseCount: 1,
    selectedCourseName: "Verified Course",
    firstPreviewCourseName: "Verified Course",
  });
  const calls = (await readFile(log, "utf8")).trim().split("\n");
  assert.equal(calls.filter((line) => line === "morrow_health").length, 2);
  assert.equal(calls.filter((line) => line === "morrow_browser_bindings").length, 2);
});

test("names and reads exactly one connected course while several courses are connected", async (t) => {
  const directory = await privateTemporaryDirectory("morrow-runtime-monitor-multi-");
  const workspaceRoot = await realpath(directory);
  const log = path.join(directory, "calls.log");
  const entry = await writeMockGateway(directory);
  const originalMode = process.env.MORROW_RUNTIME_MONITOR_FIXTURE;
  const originalLog = process.env.MORROW_RUNTIME_MONITOR_LOG;
  process.env.MORROW_RUNTIME_MONITOR_FIXTURE = "multi";
  process.env.MORROW_RUNTIME_MONITOR_LOG = log;
  const monitor = createRuntimeMonitor({ nodePath: process.execPath, serverEntryPath: entry, upstreamsPath: path.join(workspaceRoot, "upstreams.json"), workspaceRoot, journalPath: path.join(workspaceRoot, "gateway.sqlite3") });
  t.after(async () => {
    if (originalMode === undefined) delete process.env.MORROW_RUNTIME_MONITOR_FIXTURE;
    else process.env.MORROW_RUNTIME_MONITOR_FIXTURE = originalMode;
    if (originalLog === undefined) delete process.env.MORROW_RUNTIME_MONITOR_LOG;
    else process.env.MORROW_RUNTIME_MONITOR_LOG = originalLog;
    await monitor.close();
    await rm(entry, { force: true });
    await removeTemporaryDirectory(directory);
  });
  const lines = async () => (await readFile(log, "utf8")).trim().split("\n");

  const connected = await monitor.start();
  assert.deepEqual(connected.bindings, {
    runtimeVerifiedCourseCount: 2,
    selectedCourseName: null,
    firstPreviewCourseName: "Verified Course",
  });
  assert.deepEqual(connected.firstPreview, { available: "yes", completed: false });
  assert.deepEqual(await monitor.firstSafeRead(), {
    schema: "morrow.installer-first-safe-read.v1",
    completed: true,
    runtimeVerifiedCourseCount: 2,
    selectedCourseName: null,
    firstPreviewCourseName: "Verified Course",
  });
  const dispatched = await lines();
  assert.equal(dispatched.includes("canvas_get_single_course_courses"), true, "the first read reads the course it named");
  assert.equal(dispatched.includes("moodle_get_course"), false, "the first read reads no course it did not name");

  // The same two courses, in the other order. The course the completed read
  // used is still connected, so that read stands and keeps its name.
  await monitor.close();
  process.env.MORROW_RUNTIME_MONITOR_FIXTURE = "multi-reordered";
  const reordered = await monitor.start();
  assert.equal(reordered.bindings.firstPreviewCourseName, "Verified Course");
  assert.deepEqual(reordered.firstPreview, { available: "yes", completed: true });

  // The course that read is no longer connected. Morrow names the course it
  // will read instead and asks for the read again.
  await monitor.close();
  process.env.MORROW_RUNTIME_MONITOR_FIXTURE = "multi-moodle";
  const moved = await monitor.start();
  assert.deepEqual(moved.bindings, {
    runtimeVerifiedCourseCount: 2,
    selectedCourseName: null,
    firstPreviewCourseName: "Second Course",
  });
  assert.deepEqual(moved.firstPreview, { available: "yes", completed: false });
  assert.deepEqual(await monitor.firstSafeRead(), {
    schema: "morrow.installer-first-safe-read.v1",
    completed: true,
    runtimeVerifiedCourseCount: 2,
    selectedCourseName: null,
    firstPreviewCourseName: "Second Course",
  });
  assert.equal((await lines()).includes("moodle_get_course"), true, "the first read reads the Moodle course it named");

  // Blackboard courses are connected through the Blackboard API, so two
  // connected courses can still leave this browser read with no course to read.
  await monitor.close();
  process.env.MORROW_RUNTIME_MONITOR_FIXTURE = "blackboard-only";
  const blackboard = await monitor.start();
  assert.deepEqual(blackboard.bindings, {
    runtimeVerifiedCourseCount: 2,
    selectedCourseName: null,
    firstPreviewCourseName: null,
  });
  assert.deepEqual(blackboard.firstPreview, { available: "no", completed: false });
  const beforeRead = (await lines()).length;
  assert.deepEqual(await monitor.firstSafeRead(), {
    schema: "morrow.installer-first-safe-read.v1",
    completed: false,
    runtimeVerifiedCourseCount: 2,
    selectedCourseName: null,
    firstPreviewCourseName: null,
  });
  assert.deepEqual((await lines()).slice(beforeRead), ["morrow_health", "morrow_browser_bindings"], "no course read is dispatched with no course to read");

  // A new status sequence has no readable in-memory choice. It still adopts the durable
  // receipt from the exact current binding even when that binding is second.
  await monitor.close();
  process.env.MORROW_RUNTIME_MONITOR_FIXTURE = "durable-second-read";
  const durable = await monitor.start();
  assert.equal(durable.bindings.firstPreviewCourseName, "Second Course");
  assert.deepEqual(durable.firstPreview, { available: "yes", completed: true });
});

test("refuses the first read when the course binding changed between selection and dispatch", async (t) => {
  const directory = await privateTemporaryDirectory("morrow-runtime-monitor-shift-");
  const workspaceRoot = await realpath(directory);
  const log = path.join(directory, "calls.log");
  const entry = await writeMockGateway(directory);
  const originalMode = process.env.MORROW_RUNTIME_MONITOR_FIXTURE;
  const originalLog = process.env.MORROW_RUNTIME_MONITOR_LOG;
  process.env.MORROW_RUNTIME_MONITOR_FIXTURE = "multi-shift";
  process.env.MORROW_RUNTIME_MONITOR_LOG = log;
  const monitor = createRuntimeMonitor({ nodePath: process.execPath, serverEntryPath: entry, upstreamsPath: path.join(workspaceRoot, "upstreams.json"), workspaceRoot, journalPath: path.join(workspaceRoot, "gateway.sqlite3") });
  t.after(async () => {
    if (originalMode === undefined) delete process.env.MORROW_RUNTIME_MONITOR_FIXTURE;
    else process.env.MORROW_RUNTIME_MONITOR_FIXTURE = originalMode;
    if (originalLog === undefined) delete process.env.MORROW_RUNTIME_MONITOR_LOG;
    else process.env.MORROW_RUNTIME_MONITOR_LOG = originalLog;
    await monitor.close();
    await rm(entry, { force: true });
    await removeTemporaryDirectory(directory);
  });

  const connected = await monitor.start();
  assert.deepEqual(connected.bindings, {
    runtimeVerifiedCourseCount: 2,
    selectedCourseName: null,
    firstPreviewCourseName: "Verified Course",
  });
  assert.deepEqual(await monitor.firstSafeRead(), {
    schema: "morrow.installer-first-safe-read.v1",
    completed: false,
    runtimeVerifiedCourseCount: 2,
    selectedCourseName: null,
    firstPreviewCourseName: "Verified Course",
  });
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
    "morrow_health", "morrow_browser_bindings",
    "morrow_health", "morrow_browser_bindings", "canvas_get_single_course_courses", "morrow_browser_bindings",
  ], "the read is dispatched and the binding read back after it is what refuses the result");
  assert.deepEqual(monitor.snapshot().firstPreview, { available: "yes", completed: false }, "Morrow offers the read again rather than reporting it complete");
});

test("retries only an observed transient gateway-not-ready state before reporting installer status", async (t) => {
  const directory = await privateTemporaryDirectory("morrow-runtime-monitor-warming-");
  const workspaceRoot = await realpath(directory);
  const log = path.join(directory, "calls.log");
  const entry = await writeMockGateway(directory);
  const originalMode = process.env.MORROW_RUNTIME_MONITOR_FIXTURE;
  const originalLog = process.env.MORROW_RUNTIME_MONITOR_LOG;
  process.env.MORROW_RUNTIME_MONITOR_FIXTURE = "warming";
  process.env.MORROW_RUNTIME_MONITOR_LOG = log;
  const monitor = createRuntimeMonitor({ nodePath: process.execPath, serverEntryPath: entry, upstreamsPath: path.join(workspaceRoot, "upstreams.json"), workspaceRoot, journalPath: path.join(workspaceRoot, "gateway.sqlite3") });
  t.after(async () => {
    if (originalMode === undefined) delete process.env.MORROW_RUNTIME_MONITOR_FIXTURE;
    else process.env.MORROW_RUNTIME_MONITOR_FIXTURE = originalMode;
    if (originalLog === undefined) delete process.env.MORROW_RUNTIME_MONITOR_LOG;
    else process.env.MORROW_RUNTIME_MONITOR_LOG = originalLog;
    await monitor.close();
    await rm(entry, { force: true });
    await removeTemporaryDirectory(directory);
  });

  const snapshot = await monitor.start();
  assert.equal(snapshot.health.gatewayReady, true);
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
    "morrow_health", "morrow_browser_bindings",
    "morrow_health", "morrow_browser_bindings",
  ]);
});

test("requires the MCP package version and digest the gateway reads from its own payload", async (t) => {
  const directory = await privateTemporaryDirectory("morrow-runtime-monitor-mcp-binding-");
  const workspaceRoot = await realpath(directory);
  const payload = await writePayloadGateway(directory, mcpRuntimeManifestFixture("c".repeat(64)));
  const originalMode = process.env.MORROW_RUNTIME_MONITOR_FIXTURE;
  process.env.MORROW_RUNTIME_MONITOR_FIXTURE = "good";
  const monitor = createRuntimeMonitor({
    nodePath: process.execPath,
    serverEntryPath: payload.entry,
    upstreamsPath: path.join(workspaceRoot, "upstreams.json"),
    workspaceRoot,
    journalPath: path.join(workspaceRoot, "gateway.sqlite3"),
    mcpRuntime: payload.expected,
  });
  t.after(async () => {
    if (originalMode === undefined) delete process.env.MORROW_RUNTIME_MONITOR_FIXTURE;
    else process.env.MORROW_RUNTIME_MONITOR_FIXTURE = originalMode;
    await monitor.close();
    await rm(payload.root, { recursive: true, force: true });
    await removeTemporaryDirectory(directory);
  });

  assert.equal((await monitor.start()).health.gatewayReady, true);

  // Another sealed manifest of the same package version: only the digest of the
  // file the gateway itself reads separates it from the verified payload.
  await monitor.close();
  const substituted = await payload.writeManifest(mcpRuntimeManifestFixture("f".repeat(64)));
  assert.equal(substituted.packageVersion, payload.expected.packageVersion);
  assert.notEqual(substituted.manifestSha256, payload.expected.manifestSha256);
  const mismatched = await monitor.start();
  assert.equal(mismatched.health.gatewayReady, false);
  assert.equal(mismatched.health.runtimeMismatch, true);

  await monitor.close();
  await payload.removeManifest();
  const repeatedMismatch = await monitor.start();
  assert.equal(repeatedMismatch.health.gatewayReady, false);
  assert.equal(repeatedMismatch.health.runtimeMismatch, true);

  await monitor.close();
  await payload.writeManifest(mcpRuntimeManifestFixture("c".repeat(64)));
  const restored = await monitor.start();
  assert.equal(restored.health.gatewayReady, true);
  assert.equal(Object.hasOwn(restored.health, "runtimeMismatch"), false);
});

test("emits a bounded test-only startup trace without private runtime details", async (t) => {
  const directory = await privateTemporaryDirectory("morrow-runtime-monitor-trace-");
  const workspaceRoot = await realpath(directory);
  const entry = await writeMockGateway(directory);
  const tracePath = path.join(workspaceRoot, "runtime-startup-trace.json");
  const monitor = createRuntimeMonitor({
    nodePath: process.execPath,
    serverEntryPath: entry,
    upstreamsPath: path.join(workspaceRoot, "upstreams.json"),
    workspaceRoot,
    journalPath: path.join(workspaceRoot, "gateway.sqlite3"),
    diagnosticTracePath: tracePath,
  });
  t.after(async () => {
    await monitor.close();
    await rm(entry, { force: true });
    await removeTemporaryDirectory(directory);
  });

  await monitor.start();
  await writeFile(`${tracePath}.owner-stderr.log`, [
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'fixture-module' imported from C:\\Users\\fixture-user\\Morrow\\app\\server.js",
    "token=fixture-private-token-abcdefghijklmnopqrstuvwxyz",
  ].join("\n"), { mode: 0o600 });
  const trace = await monitor.testDiagnostics();
  assert.equal(trace.schema, "morrow.desktop-runtime-trace.v1");
  assert.deepEqual(trace.child, { spawned: true, exitCode: null });
  assert.equal(trace.stderrStage, "none");
  assert.equal(trace.owner.stderrCaptured, true);
  assert.match(trace.owner.failure, /ERR_MODULE_NOT_FOUND/);
  assert.equal(trace.portBinding, "bound");
  for (const phase of Object.values(trace.upstream)) {
    assert.equal(phase.ready, true);
    assert.equal(Number.isSafeInteger(phase.durationMs), true);
    assert.ok(phase.durationMs >= 0 && phase.durationMs <= 600_000);
  }
  assert.equal(JSON.stringify(trace).includes(workspaceRoot), false);
  assert.equal(JSON.stringify(trace).includes("morrow-runtime-monitor-trace"), false);
  assert.equal(JSON.stringify(trace).includes("fixture-private-token"), false);
  assert.equal(JSON.stringify(trace).includes("fixture-user"), false);
});

test("settles every stalled MCP operation within its bound, reclaims that generation's child, and reconnects", async (t) => {
  const directory = await privateTemporaryDirectory("morrow-runtime-monitor-stall-");
  const workspaceRoot = await realpath(directory);
  const log = path.join(directory, "pids.log");
  const entry = await writeMockGateway(directory);
  const tracePath = path.join(workspaceRoot, "runtime-startup-trace.json");
  const originalMode = process.env.MORROW_RUNTIME_MONITOR_FIXTURE;
  const originalLog = process.env.MORROW_RUNTIME_MONITOR_PID_LOG;
  process.env.MORROW_RUNTIME_MONITOR_PID_LOG = log;
  const operationTimeouts = { connectMs: 1_500, operationMs: 400, closeMs: 300, reclaimMs: 1_500 };
  // One public method may spawn a child, run one connect and one operation to
  // their deadlines, close the client and transport, and reclaim the child
  // through SIGTERM then SIGKILL. That contract sum is the bound; the envelope
  // allows a loaded host several times that and still stays far under the
  // unbounded SDK wait the repair removed.
  const contractMs = operationTimeouts.connectMs + operationTimeouts.operationMs + 2 * operationTimeouts.closeMs + operationTimeouts.reclaimMs;
  const envelopeMs = contractMs * 5;
  const monitor = createRuntimeMonitor({
    nodePath: process.execPath,
    serverEntryPath: entry,
    upstreamsPath: path.join(workspaceRoot, "upstreams.json"),
    workspaceRoot,
    journalPath: path.join(workspaceRoot, "gateway.sqlite3"),
    diagnosticTracePath: tracePath,
    operationTimeouts,
  });
  t.after(async () => {
    if (originalMode === undefined) delete process.env.MORROW_RUNTIME_MONITOR_FIXTURE;
    else process.env.MORROW_RUNTIME_MONITOR_FIXTURE = originalMode;
    if (originalLog === undefined) delete process.env.MORROW_RUNTIME_MONITOR_PID_LOG;
    else process.env.MORROW_RUNTIME_MONITOR_PID_LOG = originalLog;
    await monitor.close();
    await rm(entry, { force: true });
    await removeTemporaryDirectory(directory);
  });
  const childPids = async () => (await readFile(log, "utf8")).trim().split("\n")
    .filter((line) => line.startsWith("pid:")).map((line) => Number(line.slice(4)));
  const settled = async (operation, detail) => {
    const marker = Symbol("deadline");
    let timer = null;
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(marker), envelopeMs); });
    const outcome = await Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
    assert.notEqual(outcome, marker, `${detail} did not settle within ${envelopeMs} ms`);
    return outcome;
  };
  const expectUnavailable = async (mode, run, detail) => {
    process.env.MORROW_RUNTIME_MONITOR_FIXTURE = mode;
    const before = (await childPids().catch(() => [])).length;
    const snapshot = await settled(run(), detail);
    const pids = await childPids();
    assert.ok(pids.length > before, `${detail} spawned a child`);
    const child = pids[pids.length - 1];
    await waitFor(() => !processIsAlive(child), `${detail} child reclaim`);
    assert.equal(monitor.lastGenerationReclaimed(), true, `${detail} reclaimed its generation`);
    return snapshot;
  };

  const initialize = await expectUnavailable("stall-initialize", () => monitor.start(), "stalled initialize");
  assert.equal(initialize.health.gatewayReady, "unknown");
  const health = await expectUnavailable("stall-health", () => monitor.start(), "stalled health");
  assert.equal(health.health.gatewayReady, "unknown");
  assert.deepEqual(health.firstPreview, { available: "unknown", completed: false });
  const bindings = await expectUnavailable("stall-bindings", () => monitor.start(), "stalled course binding discovery");
  assert.equal(bindings.health.gatewayReady, true);
  assert.equal(bindings.bindings.runtimeVerifiedCourseCount, 0);
  const read = await expectUnavailable("stall-read", () => monitor.firstSafeRead(), "stalled first safe read");
  assert.equal(read.schema, "morrow.installer-first-safe-read.v1");
  assert.equal(read.completed, false);
  assert.deepEqual(monitor.snapshot().firstPreview, { available: "unknown", completed: false });
  const frozen = await expectUnavailable("freeze-health", () => monitor.start(), "frozen runtime that ignores SIGTERM");
  assert.equal(frozen.health.gatewayReady, "unknown");

  process.env.MORROW_RUNTIME_MONITOR_FIXTURE = "stall-resource";
  await settled(monitor.start(), "start before a stalled resource read");
  const trace = await settled(monitor.testDiagnostics(), "stalled diagnostic resource read");
  assert.equal(trace.upstream.listTools.ready, true);
  assert.equal(trace.upstream.readResource.ready, false);
  const resourcePids = await childPids();
  await waitFor(() => !processIsAlive(resourcePids[resourcePids.length - 1]), "stalled resource child reclaim");

  process.env.MORROW_RUNTIME_MONITOR_FIXTURE = "good";
  const recovered = await settled(monitor.start(), "reconnect after stalls");
  assert.equal(recovered.health.gatewayReady, true);
  assert.deepEqual(recovered.bindings, {
    runtimeVerifiedCourseCount: 1,
    selectedCourseName: "Verified Course",
    firstPreviewCourseName: "Verified Course",
  });
  const firstRead = await settled(monitor.firstSafeRead(), "first read after reconnect");
  assert.deepEqual(firstRead, {
    schema: "morrow.installer-first-safe-read.v1",
    completed: true,
    runtimeVerifiedCourseCount: 1,
    selectedCourseName: "Verified Course",
    firstPreviewCourseName: "Verified Course",
  });
  assert.deepEqual(monitor.snapshot().firstPreview, { available: "yes", completed: true });
  await settled(monitor.close(), "close");
  const finalPids = await childPids();
  await waitFor(() => !processIsAlive(finalPids[finalPids.length - 1]), "closed child reclaim");
});

test("serializes reconnects and close owns a reconnect started outside start", async (t) => {
  const directory = await privateTemporaryDirectory("morrow-runtime-monitor-lifecycle-");
  const workspaceRoot = await realpath(directory);
  const log = path.join(directory, "pids.log");
  const entry = await writeMockGateway(directory);
  const originalMode = process.env.MORROW_RUNTIME_MONITOR_FIXTURE;
  const originalLog = process.env.MORROW_RUNTIME_MONITOR_PID_LOG;
  process.env.MORROW_RUNTIME_MONITOR_FIXTURE = "good";
  process.env.MORROW_RUNTIME_MONITOR_PID_LOG = log;
  const monitor = createRuntimeMonitor({
    nodePath: process.execPath,
    serverEntryPath: entry,
    upstreamsPath: path.join(workspaceRoot, "upstreams.json"),
    workspaceRoot,
    journalPath: path.join(workspaceRoot, "gateway.sqlite3"),
    operationTimeouts: { connectMs: 1_000, operationMs: 500, closeMs: 300, reclaimMs: 1_000 },
  });
  t.after(async () => {
    if (originalMode === undefined) delete process.env.MORROW_RUNTIME_MONITOR_FIXTURE;
    else process.env.MORROW_RUNTIME_MONITOR_FIXTURE = originalMode;
    if (originalLog === undefined) delete process.env.MORROW_RUNTIME_MONITOR_PID_LOG;
    else process.env.MORROW_RUNTIME_MONITOR_PID_LOG = originalLog;
    await monitor.close();
    await rm(entry, { force: true });
    await removeTemporaryDirectory(directory);
  });
  const childPids = async () => (await readFile(log, "utf8")).trim().split("\n")
    .filter((line) => line.startsWith("pid:")).map((line) => Number(line.slice(4)));

  await Promise.all([monitor.firstSafeRead(), monitor.firstSafeRead()]);
  assert.equal((await childPids()).length, 1, "concurrent reconnecting operations share one generation");
  await monitor.close();

  process.env.MORROW_RUNTIME_MONITOR_FIXTURE = "stall-initialize";
  const reconnecting = monitor.firstSafeRead();
  await waitFor(async () => (await childPids()).length === 2, "reconnecting child spawn");
  await monitor.close();
  const finalPids = await childPids();
  assert.equal(finalPids.every((pid) => !processIsAlive(pid)), true, "close reclaims every generation created before it");
  await reconnecting;
});

test("every MCP SDK request in the runtime monitor runs under the owned operation boundary", async () => {
  const monitorPath = fileURLToPath(new URL("../shared/runtime-monitor.mjs", import.meta.url));
  const source = await readFile(monitorPath, "utf8");
  const syntax = ts.createSourceFile("runtime-monitor.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const REQUESTS = new Set(["connect", "callTool", "listTools", "readResource"]);
  const unbounded = [];
  let requests = 0;
  let closes = 0;
  const location = (node) => `runtime-monitor.mjs:${syntax.getLineAndCharacterOfPosition(node.getStart(syntax)).line + 1}`;
  const enclosingCallee = (node) => {
    // The name of the call this node is a direct argument of, if any.
    const parent = node.parent;
    return parent && ts.isCallExpression(parent) && parent.arguments.includes(node) && ts.isIdentifier(parent.expression) ? parent.expression.text : null;
  };
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (method === "close") {
        closes += 1;
        // A close settles within a bound, never directly.
        if (enclosingCallee(node) !== "settleWithin") unbounded.push(`${location(node)}:close`);
      } else if (REQUESTS.has(method)) {
        requests += 1;
        // A request receives the boundary's options as its last argument, from
        // the arrow the boundary invokes, and nothing else may await it.
        let owner = node.parent;
        while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
        const last = node.arguments[node.arguments.length - 1];
        const parameter = owner && ts.isArrowFunction(owner) && owner.parameters.length === 1 ? owner.parameters[0].name.getText(syntax) : null;
        const bound = Boolean(last) && ts.isIdentifier(last) && parameter !== null && last.text === parameter
          && enclosingCallee(owner) === "operate";
        if (!bound) unbounded.push(`${location(node)}:${method}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  assert.ok(requests >= 4 && closes >= 2, `the guard must see every SDK request and close, saw ${requests} and ${closes}`);
  assert.deepEqual(unbounded, []);
});
