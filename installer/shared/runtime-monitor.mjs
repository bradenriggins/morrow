import { createRequire } from "node:module";
import { readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

const SNAPSHOT_SCHEMA = "morrow.installer-runtime.v1";
const FIRST_READ_SCHEMA = "morrow.installer-first-safe-read.v1";
const MAINTENANCE_SCHEMA = "morrow.installer-maintenance.v1";
const SOURCE_BINDING_ID = /^[A-Za-z0-9_.:@-]{1,160}$/;
const NUMERIC_COURSE_ID = /^[1-9][0-9]*$/;
const BLACKBOARD_COURSE_ID = /^_[0-9]+_[0-9]+$/;
const BRIDGE_EXTENSION_ID = /^[a-p]{32}$/;
const BRIDGE_VERSION = /^(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*)){0,3}$/;
const BRIDGE_IDENTIFIER = /^[A-Za-z0-9._-]{16,256}$/;
const BRIDGE_SHA256 = /^[0-9a-f]{64}$/;
const SAFE_COURSE_NAME_LENGTH = 300;
const INITIAL_GATEWAY_READY_RETRIES = 4;
const INITIAL_GATEWAY_READY_RETRY_MS = 250;
const TEST_DIAGNOSTIC_SCHEMA = "morrow.desktop-runtime-trace.v1";
const TEST_CHILD_DIAGNOSTIC_SCHEMA = "morrow.desktop-runtime-child.v1";
const TEST_DIAGNOSTIC_RESOURCE_URI = "morrow://guidance/course-audit-v1";
const TEST_DIAGNOSTIC_STDERR_LIMIT = 8 * 1024;
const TEST_DIAGNOSTIC_OWNER_SUMMARY_LIMIT = 600;
const TEST_DIAGNOSTIC_DURATION_LIMIT_MS = 10 * 60 * 1000;
const MCP_RUNTIME_HEALTH_SCHEMA = "morrow.mcp-runtime.health.v1";
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function absolutePath(value, name) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new TypeError(`${name} must be an absolute path`);
  return value;
}

function canonicalDirectory(value, name) {
  const absolute = absolutePath(value, name);
  const canonical = realpathSync(absolute);
  if (canonical !== absolute || !statSync(canonical).isDirectory()) throw new TypeError(`${name} must be a canonical directory`);
  return canonical;
}

function durableJournalPath(value) {
  const path = absolutePath(value, "journalPath");
  if (path === ":memory:" || /[\0\r\n]/.test(path)) throw new TypeError("journalPath must be a durable path");
  return path;
}

function diagnosticPath(value) {
  if (value === undefined) return null;
  const path = absolutePath(value, "diagnosticTracePath");
  if (/\0|\r|\n/.test(path)) throw new TypeError("diagnosticTracePath is invalid");
  return path;
}

function mcpRuntimeBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 3
    || value.schema !== MCP_RUNTIME_HEALTH_SCHEMA
    || typeof value.packageVersion !== "string" || !VERSION.test(value.packageVersion)
    || typeof value.manifestSha256 !== "string" || !SHA256.test(value.manifestSha256)) return null;
  return Object.freeze({
    schema: MCP_RUNTIME_HEALTH_SCHEMA,
    packageVersion: value.packageVersion,
    manifestSha256: value.manifestSha256,
  });
}

function validPid(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}

function emptySnapshot() {
  return {
    schema: SNAPSHOT_SCHEMA,
    health: {
      attempted: false,
      gatewayReady: "unknown",
      bridgeConnected: "unknown",
      // Only the local-owner maintenance lease can admit a restart.
      canRestart: "unknown",
    },
    bindings: {
      runtimeVerifiedCourseCount: 0,
      // The name of the one connected course, and the name of the course the
      // first read targets. With more than one connected course there is no
      // single selected course, so only the first-read target is named.
      selectedCourseName: null,
      firstPreviewCourseName: null,
    },
    firstPreview: {
      available: "unknown",
      completed: false,
    },
  };
}

function copied(snapshot) {
  return {
    schema: SNAPSHOT_SCHEMA,
    health: { ...snapshot.health },
    bindings: { ...snapshot.bindings },
    firstPreview: { ...snapshot.firstPreview },
  };
}

function safeFirstRead(snapshot) {
  return {
    schema: FIRST_READ_SCHEMA,
    completed: snapshot.firstPreview.completed === true,
    runtimeVerifiedCourseCount: snapshot.bindings.runtimeVerifiedCourseCount,
    selectedCourseName: snapshot.bindings.selectedCourseName,
    firstPreviewCourseName: snapshot.bindings.firstPreviewCourseName,
  };
}

function maintenanceResult(action, status) {
  return { schema: MAINTENANCE_SCHEMA, action, status };
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function diagnosticDuration(startedAt) {
  return Math.min(Math.max(0, Date.now() - startedAt), TEST_DIAGNOSTIC_DURATION_LIMIT_MS);
}

function diagnosticPhase(ready = false, durationMs = 0) {
  return { ready: ready === true, durationMs: Math.min(Math.max(0, durationMs), TEST_DIAGNOSTIC_DURATION_LIMIT_MS) };
}

function emptyTestDiagnostic() {
  return {
    schema: TEST_DIAGNOSTIC_SCHEMA,
    child: { spawned: false, exitCode: null },
    stderrStage: "not_started",
    owner: { stderrCaptured: false, failure: null },
    portBinding: "not_observed",
    upstream: {
      initialize: diagnosticPhase(),
      listTools: diagnosticPhase(),
      readResource: diagnosticPhase(),
    },
  };
}

function sanitizedDiagnosticFailure(raw) {
  const lines = raw
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /\b(?:error|exception|cannot|failed|unsupported|unknown)\b/i.test(line)
      || /\bERR_[A-Z0-9_]+\b/.test(line)
      || /\bnot found\b/i.test(line)
      || /\bdid not\b/i.test(line));
  return lines.slice(0, 3).join(" ")
    .replace(/\b(?:token|secret|password|authorization|cookie)\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}\b/gi, "Bearer <redacted>")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "<redacted>")
    .replace(/(?:[A-Za-z]:)?[\\/](?:[^\s'\"`()[\]{}:,;]+[\\/])*[^\s'\"`()[\]{}:,;]+/g, "<path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TEST_DIAGNOSTIC_OWNER_SUMMARY_LIMIT);
}

function ownerDiagnosticSummary(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8").slice(0, TEST_DIAGNOSTIC_STDERR_LIMIT);
  } catch {
    return { stderrCaptured: false, failure: null };
  }
  return { stderrCaptured: true, failure: sanitizedDiagnosticFailure(raw) || null };
}

function diagnosticStderrStage(value) {
  const text = value.toLowerCase();
  if (!text) return "none";
  if (text.includes("chrome bridge port") && text.includes("already in use")) return "configured_port_in_use";
  if (text.includes("local owner connection failed")) return "local_owner_connection_failed";
  if (text.includes("protocol error")) return "protocol_error";
  if (text.includes("local owner ready")) return "local_owner_ready";
  return "other";
}

function writeTestDiagnosticLauncher({ tracePath, nodePath, serverEntryPath }) {
  const launcherPath = `${tracePath}.launcher.cjs`;
  const childPath = `${tracePath}.child.json`;
  const ownerStderrPath = `${tracePath}.owner-stderr.log`;
  const source = `const { spawn } = require("node:child_process");
const { renameSync, writeFileSync } = require("node:fs");
const tracePath = ${JSON.stringify(childPath)};
const write = (state, exitCode) => {
  const temporary = tracePath + ".tmp-" + process.pid;
  try {
    writeFileSync(temporary, JSON.stringify({ schema: ${JSON.stringify(TEST_CHILD_DIAGNOSTIC_SCHEMA)}, state, exitCode }) + "\\n", { mode: 0o600, flag: "w" });
    renameSync(temporary, tracePath);
  } catch {}
};
let child;
try {
  child = spawn(${JSON.stringify(nodePath)}, [${JSON.stringify(serverEntryPath)}], { cwd: process.cwd(), env: process.env, stdio: "inherit", windowsHide: true });
} catch {
  write("spawn_failed", 1);
  process.exitCode = 1;
}
if (child) {
  child.once("spawn", () => write("running", null));
  child.once("error", () => { write("spawn_failed", 1); process.exitCode = 1; });
  child.once("close", (code) => { const exitCode = Number.isSafeInteger(code) ? code : null; write("closed", exitCode); process.exitCode = exitCode === null ? 1 : exitCode; });
}
`;
  writeFileSync(launcherPath, source, { mode: 0o600, flag: "w" });
  return { launcherPath, childPath, ownerStderrPath };
}

function readTestDiagnosticChild(path) {
  try {
    const value = object(JSON.parse(readFileSync(path, "utf8")));
    if (!value || value.schema !== TEST_CHILD_DIAGNOSTIC_SCHEMA
      || !["running", "closed", "spawn_failed"].includes(value.state)
      || (value.exitCode !== null && (!Number.isSafeInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255))) return null;
    return { state: value.state, exitCode: value.exitCode };
  } catch {
    return null;
  }
}

function exactKeys(value, keys) {
  const source = object(value);
  return source !== null
    && Object.keys(source).length === keys.length
    && Object.keys(source).every((key) => keys.includes(key));
}

function bridgeControl(value) {
  if (exactKeys(value, ["action"]) && ["status", "quiesce", "readback"].includes(value.action)) {
    return { action: value.action };
  }
  if (!exactKeys(value, ["action", "quiesceEpoch", "fileLayerRestored"])
    || value.action !== "resume"
    || typeof value.quiesceEpoch !== "string"
    || !BRIDGE_IDENTIFIER.test(value.quiesceEpoch)
    || value.fileLayerRestored !== true) return null;
  return { action: "resume", quiesceEpoch: value.quiesceEpoch, fileLayerRestored: true };
}

function activeFolderProof(value, extensionId, manifestVersion) {
  return exactKeys(value, ["schema", "extensionId", "manifestVersion", "challengeId", "nonce", "challengeSha256"])
    && value.schema === "morrow.bridge.active-folder-proof.v1"
    && value.extensionId === extensionId
    && value.manifestVersion === manifestVersion
    && typeof value.challengeId === "string" && BRIDGE_IDENTIFIER.test(value.challengeId)
    && typeof value.nonce === "string" && BRIDGE_IDENTIFIER.test(value.nonce)
    && typeof value.challengeSha256 === "string" && BRIDGE_SHA256.test(value.challengeSha256);
}

function bridgeRecord(control, value) {
  const record = object(value);
  if (!record || typeof record.extensionId !== "string" || !BRIDGE_EXTENSION_ID.test(record.extensionId)
    || typeof record.manifestVersion !== "string" || !BRIDGE_VERSION.test(record.manifestVersion)) return null;
  const extensionId = record.extensionId;
  const manifestVersion = record.manifestVersion;
  if (control.action === "status") {
    if (!exactKeys(record, ["schema", "extensionId", "manifestVersion", "installType", "quiescent", "activeFolderProof"])
      || record.schema !== "morrow.bridge.update-status.v1"
      || !["admin", "development", "normal", "sideload", "other"].includes(record.installType)
      || typeof record.quiescent !== "boolean"
      || !activeFolderProof(record.activeFolderProof, extensionId, manifestVersion)) return null;
  } else if (control.action === "quiesce") {
    if (!exactKeys(record, ["schema", "extensionId", "manifestVersion", "installType", "quiescent", "quiesceEpoch", "activeFolderProof"])
      || record.schema !== "morrow.bridge.update-quiesced.v1"
      || record.installType !== "development"
      || record.quiescent !== true
      || typeof record.quiesceEpoch !== "string" || !BRIDGE_IDENTIFIER.test(record.quiesceEpoch)
      || !activeFolderProof(record.activeFolderProof, extensionId, manifestVersion)) return null;
  } else if (control.action === "readback") {
    if (!exactKeys(record, ["schema", "extensionId", "manifestVersion", "installType", "activeFolderProof"])
      || record.schema !== "morrow.bridge.update-readback.v1"
      || record.installType !== "development"
      || !activeFolderProof(record.activeFolderProof, extensionId, manifestVersion)) return null;
  } else if (!exactKeys(record, ["schema", "extensionId", "manifestVersion", "quiesceEpoch", "resumed"])
    || record.schema !== "morrow.bridge.update-resumed.v1"
    || record.quiesceEpoch !== control.quiesceEpoch
    || record.resumed !== true) return null;
  return structuredClone(record);
}

function healthSnapshot(snapshot, result, expectedMcpRuntime) {
  const health = result?.isError === true ? null : object(result?.structuredContent);
  const components = object(health?.components);
  const gateway = object(components?.gateway);
  const bridge = object(components?.extensionBridge);
  // The gateway reads its own package version and manifest digest from the
  // payload it started from. This process passes neither value to it, so a
  // mismatch means the running runtime is not the one this app verified.
  const mcpRuntime = mcpRuntimeBinding(health?.mcpRuntime);
  const runtimeMatches = !expectedMcpRuntime || Boolean(mcpRuntime
    && mcpRuntime.packageVersion === expectedMcpRuntime.packageVersion
    && mcpRuntime.manifestSha256 === expectedMcpRuntime.manifestSha256);
  snapshot.health.gatewayReady = typeof gateway?.ready === "boolean"
    ? gateway.ready && runtimeMatches
    : "unknown";
  snapshot.health.bridgeConnected = typeof bridge?.connected === "boolean" ? bridge.connected : "unknown";
  return typeof bridge?.listening === "boolean" ? bridge.listening ? "bound" : "unbound" : "not_observed";
}

function validBinding(value) {
  const binding = object(value);
  if (!binding || binding.runtimeVerified !== true) return null;
  const provider = binding.provider;
  const courseId = binding.courseId;
  if ((provider !== "canvas" && provider !== "moodle" && provider !== "blackboard")
    || typeof courseId !== "string"
    || typeof binding.sourceBindingId !== "string"
    || !SOURCE_BINDING_ID.test(binding.sourceBindingId)
    || !Number.isSafeInteger(binding.sessionGeneration)
    || binding.sessionGeneration < 1) return null;
  if ((provider === "canvas" || provider === "moodle") && !NUMERIC_COURSE_ID.test(courseId)) return null;
  if (provider === "blackboard" && !BLACKBOARD_COURSE_ID.test(courseId)) return null;
  return {
    provider,
    courseId,
    sourceBindingId: binding.sourceBindingId,
    sessionGeneration: binding.sessionGeneration,
    courseName: typeof binding.courseName === "string" && binding.courseName.trim().length > 0
      ? binding.courseName.slice(0, SAFE_COURSE_NAME_LENGTH)
      : null,
  };
}

function browserBindings(result) {
  if (result?.isError === true) return { kind: "unavailable" };
  const envelope = object(result?.structuredContent);
  const data = object(envelope?.data);
  if (!data || envelope?.schema !== "morrow.result.v1"
    || data.schema !== "morrow.browser-bindings.v1"
    || data.ok !== true
    || !Number.isSafeInteger(data.count)
    || !Array.isArray(data.bindings)
    || data.count !== data.bindings.length) return { kind: "unknown" };
  return { kind: "valid", bindings: data.bindings.map(validBinding).filter(Boolean) };
}

function sameBinding(left, right) {
  return left !== null && right !== null
    && left.provider === right.provider
    && left.courseId === right.courseId
    && left.sourceBindingId === right.sourceBindingId
    && left.sessionGeneration === right.sessionGeneration;
}

function matchingCourse(binding, result) {
  if (result?.isError === true) return false;
  const envelope = object(result?.structuredContent);
  const connector = object(envelope?.data);
  const browser = object(connector?.result);
  const data = object(browser?.data);
  if (!data || envelope?.schema !== "morrow.result.v1"
    || connector?.schema !== "morrow.canvas-connector.result.v1"
    || connector?.ok !== true || connector?.provider !== binding.provider
    || connector?.commandKind !== "invoke_read"
    || browser?.ok !== true || browser?.sent !== true) return false;
  const returned = binding.provider === "canvas" ? data.id : data.course_id;
  return String(returned) === binding.courseId;
}

function mcpModules(serverEntryPath) {
  const require = createRequire(join(dirname(serverEntryPath), "runtime-monitor.cjs"));
  const { Client } = require("@modelcontextprotocol/client");
  const { StdioClientTransport } = require("@modelcontextprotocol/client/stdio");
  return { Client, StdioClientTransport };
}

async function maintenanceModules(serverEntryPath) {
  const module = await import(pathToFileURL(join(dirname(serverEntryPath), "local-owner-maintenance.js")).href);
  if (typeof module.requestLocalOwnerMaintenance !== "function") {
    throw new TypeError("Morrow local-owner maintenance helper is unavailable");
  }
  return module;
}

/**
 * Starts the packaged gateway's stdio proxy. It never starts the connector
 * directly, so each monitor joins the same local-owner runtime and journal.
 */
export function createRuntimeMonitor({ nodePath, serverEntryPath, upstreamsPath, workspaceRoot, journalPath, mcpRuntime, diagnosticTracePath }) {
  const paths = {
    nodePath: absolutePath(nodePath, "nodePath"),
    serverEntryPath: absolutePath(serverEntryPath, "serverEntryPath"),
    upstreamsPath: absolutePath(upstreamsPath, "upstreamsPath"),
    workspaceRoot: canonicalDirectory(workspaceRoot, "workspaceRoot"),
    journalPath: durableJournalPath(journalPath),
    mcpRuntime: mcpRuntime === undefined ? null : mcpRuntimeBinding(mcpRuntime),
    diagnosticTracePath: diagnosticPath(diagnosticTracePath),
  };
  if (mcpRuntime !== undefined && !paths.mcpRuntime) throw new TypeError("mcpRuntime is invalid");
  let client = null;
  let transport = null;
  let starting = null;
  let current = emptySnapshot();
  let previewBinding = null;
  let maintenanceLease = null;
  let maintenanceCommitted = false;
  const testTrace = paths.diagnosticTracePath ? { value: emptyTestDiagnostic(), stderr: "" } : null;
  const testTraceLauncher = testTrace
    ? writeTestDiagnosticLauncher({
      tracePath: paths.diagnosticTracePath,
      nodePath: paths.nodePath,
      serverEntryPath: paths.serverEntryPath,
    })
    : null;

  const captureTestStderr = (chunk) => {
    if (!testTrace || testTrace.stderr.length >= TEST_DIAGNOSTIC_STDERR_LIMIT) return;
    testTrace.stderr += String(chunk).slice(0, TEST_DIAGNOSTIC_STDERR_LIMIT - testTrace.stderr.length);
  };

  const testDiagnostic = () => {
    if (!testTrace) return null;
    const copy = structuredClone(testTrace.value);
    const child = readTestDiagnosticChild(testTraceLauncher.childPath);
    copy.child.spawned = copy.child.spawned || child !== null;
    copy.child.exitCode = child?.exitCode ?? null;
    copy.stderrStage = diagnosticStderrStage(testTrace.stderr);
    copy.owner = ownerDiagnosticSummary(testTraceLauncher.ownerStderrPath);
    return copy;
  };

  const runTestDiagnosticPhase = async (name, action) => {
    if (!testTrace) return;
    const startedAt = Date.now();
    try {
      await action();
      testTrace.value.upstream[name] = diagnosticPhase(true, diagnosticDuration(startedAt));
    } catch {
      testTrace.value.upstream[name] = diagnosticPhase(false, diagnosticDuration(startedAt));
    }
  };

  /**
   * What the runtime reports about connected courses, and which single course
   * the first read targets. Every connected course is counted. The first read
   * targets one course: the course an earlier read already used while that
   * course is still connected, and otherwise the first connected Canvas or
   * Moodle course. A Blackboard course is connected through its own API, so it
   * is never the target of this browser read.
   */
  const setBindingState = (value) => {
    if (value.kind !== "valid") {
      current.bindings = { runtimeVerifiedCourseCount: 0, selectedCourseName: null, firstPreviewCourseName: null };
      current.firstPreview = { available: value.kind === "unavailable" ? "no" : "unknown", completed: false };
      previewBinding = null;
      return null;
    }
    const bindings = value.bindings;
    const readable = bindings.filter((binding) => binding.provider === "canvas" || binding.provider === "moodle");
    const held = previewBinding ? readable.find((binding) => sameBinding(previewBinding, binding)) || null : null;
    const selected = held || readable[0] || null;
    current.bindings = {
      runtimeVerifiedCourseCount: bindings.length,
      selectedCourseName: bindings.length === 1 ? bindings[0].courseName : null,
      firstPreviewCourseName: selected ? selected.courseName : null,
    };
    if (!selected) {
      current.firstPreview = { available: "no", completed: false };
      previewBinding = null;
      return null;
    }
    if (previewBinding && !sameBinding(previewBinding, selected)) previewBinding = null;
    current.firstPreview = { available: "yes", completed: previewBinding !== null };
    return selected;
  };

  const beginStatus = () => {
    current.health = {
      attempted: true,
      gatewayReady: "unknown",
      bridgeConnected: "unknown",
      canRestart: maintenanceLease ? "yes" : "unknown",
    };
  };

  const storedLease = (lease) => ({
    leaseId: lease.leaseId,
    leaseToken: lease.leaseToken,
    holderPid: lease.holderPid,
  });

  const monitorProxyPid = () => validPid(transport?.pid) ? transport.pid : null;

  const releaseHeldMaintenance = async () => {
    if (!maintenanceLease || maintenanceCommitted) return false;
    try {
      const { requestLocalOwnerMaintenance } = await maintenanceModules(paths.serverEntryPath);
      const released = await requestLocalOwnerMaintenance({
        action: "release",
        journalPath: paths.journalPath,
        workspaceRoot: paths.workspaceRoot,
        holderPid: maintenanceLease.holderPid,
        leaseId: maintenanceLease.leaseId,
        leaseToken: maintenanceLease.leaseToken,
      });
      if (released.status !== "released") return false;
      maintenanceLease = null;
      current.health.canRestart = "unknown";
      return true;
    } catch {
      return false;
    }
  };

  const disconnect = async () => {
    const activeClient = client;
    const activeTransport = transport;
    client = null;
    transport = null;
    await activeClient?.close().catch(() => {});
    await activeTransport?.close().catch(() => {});
  };

  const readBindings = async () => {
    try {
      const result = await client.callTool({
        name: "morrow_capability_read",
        arguments: { name: "morrow_browser_bindings", arguments: {} },
      });
      return setBindingState(browserBindings(result));
    } catch {
      return setBindingState({ kind: "unknown" });
    }
  };

  const refreshStatus = async () => {
    beginStatus();
    try {
      const health = await client.callTool({ name: "morrow_health", arguments: {} });
      const portBinding = healthSnapshot(current, health, paths.mcpRuntime);
      if (testTrace && portBinding !== "not_observed") testTrace.value.portBinding = portBinding;
    } catch {
      current.firstPreview = { available: "unknown", completed: false };
      previewBinding = null;
      return null;
    }
    return readBindings();
  };

  const connect = async () => {
    beginStatus();
    let nextClient = null;
    let nextTransport = null;
    const initializedAt = Date.now();
    try {
      const { Client, StdioClientTransport } = mcpModules(paths.serverEntryPath);
      nextClient = new Client({ name: "morrow-installer-runtime-monitor", version: "1.0.0" });
      nextTransport = new StdioClientTransport({
        command: paths.nodePath,
        args: testTraceLauncher ? [testTraceLauncher.launcherPath] : [paths.serverEntryPath],
        cwd: paths.workspaceRoot,
        env: {
          ...process.env,
          MORROW_UPSTREAMS_FILE: paths.upstreamsPath,
          ...(testTraceLauncher ? { MORROW_LOCAL_OWNER_TEST_STDERR_PATH: testTraceLauncher.ownerStderrPath } : {}),
        },
        stderr: testTrace ? "pipe" : "ignore",
      });
      nextTransport.stderr?.on("data", captureTestStderr);
      await nextClient.connect(nextTransport);
      if (testTrace) {
        testTrace.value.child.spawned = validPid(nextTransport.pid);
        testTrace.value.upstream.initialize = diagnosticPhase(true, diagnosticDuration(initializedAt));
      }
      client = nextClient;
      transport = nextTransport;
      await refreshStatus();
    } catch {
      if (testTrace) testTrace.value.upstream.initialize = diagnosticPhase(false, diagnosticDuration(initializedAt));
      await nextClient?.close().catch(() => {});
      await nextTransport?.close().catch(() => {});
      await disconnect();
    }
    return copied(current);
  };

  const refreshInitialGatewayReadiness = async () => {
    if (!client) await connect();
    else await refreshStatus();
    // The owner can accept the proxy connection immediately before its required
    // upstream has reported ready. Re-read only that observed, transient state.
    for (let attempt = 0; client && current.health.gatewayReady === false && attempt < INITIAL_GATEWAY_READY_RETRIES; attempt += 1) {
      await pause(INITIAL_GATEWAY_READY_RETRY_MS);
      await refreshStatus();
    }
    return copied(current);
  };

  const runTestDiagnostics = async () => {
    if (!testTrace) return null;
    if (!client) return testDiagnostic();
    await runTestDiagnosticPhase("listTools", () => client.listTools());
    await runTestDiagnosticPhase("readResource", () => client.readResource({ uri: TEST_DIAGNOSTIC_RESOURCE_URI }));
    return testDiagnostic();
  };

  const runFirstSafeRead = async () => {
    if (!client) await connect();
    if (!client) return safeFirstRead(current);
    const selected = await refreshStatus();
    if (!selected) return safeFirstRead(current);
    const name = selected.provider === "canvas" ? "canvas_get_single_course_courses" : "moodle_get_course";
    const argumentsValue = selected.provider === "canvas"
      ? { id: selected.courseId, _morrow: { source_binding_id: selected.sourceBindingId } }
      : { course_id: selected.courseId, _morrow: { source_binding_id: selected.sourceBindingId } };
    try {
      const preview = await client.callTool({
        name: "morrow_capability_read",
        arguments: { name, arguments: argumentsValue },
      });
      if (!matchingCourse(selected, preview)) {
        current.firstPreview = { available: "no", completed: false };
        previewBinding = null;
        return safeFirstRead(current);
      }
      const after = await readBindings();
      if (!sameBinding(selected, after)) return safeFirstRead(current);
      previewBinding = after;
      current.firstPreview = { available: "yes", completed: true };
    } catch {
      current.firstPreview = { available: "unknown", completed: false };
      previewBinding = null;
    }
    return safeFirstRead(current);
  };

  const runMaintenance = async ({ action, holderPid }) => {
    if ((action !== "acquire" && action !== "release" && action !== "commit") || !validPid(holderPid)) {
      return maintenanceResult(action, "unavailable");
    }
    if (action === "acquire") {
      if (maintenanceLease || maintenanceCommitted) return maintenanceResult(action, "unavailable");
      if (!client) await connect();
      const proxyPid = monitorProxyPid();
      if (!client || proxyPid === null) return maintenanceResult(action, "unavailable");
      try {
        const { requestLocalOwnerMaintenance } = await maintenanceModules(paths.serverEntryPath);
        const held = await requestLocalOwnerMaintenance({
          action,
          journalPath: paths.journalPath,
          workspaceRoot: paths.workspaceRoot,
          holderPid,
          monitorProxyPid: proxyPid,
        });
        if (held.status !== "held") return maintenanceResult(action, "unavailable");
        maintenanceLease = storedLease(held);
        current.health.canRestart = "yes";
        return maintenanceResult(action, "held");
      } catch {
        return maintenanceResult(action, "unavailable");
      }
    }
    if (!maintenanceLease || maintenanceCommitted || maintenanceLease.holderPid !== holderPid) {
      return maintenanceResult(action, "unavailable");
    }
    try {
      const { requestLocalOwnerMaintenance } = await maintenanceModules(paths.serverEntryPath);
      const result = await requestLocalOwnerMaintenance({
        action,
        journalPath: paths.journalPath,
        workspaceRoot: paths.workspaceRoot,
        holderPid: maintenanceLease.holderPid,
        leaseId: maintenanceLease.leaseId,
        leaseToken: maintenanceLease.leaseToken,
      });
      if (action === "release" && result.status === "released") {
        maintenanceLease = null;
        current.health.canRestart = "unknown";
        return maintenanceResult(action, "released");
      }
      if (action === "commit" && result.status === "closing") {
        maintenanceCommitted = true;
        current.health.canRestart = "yes";
        return maintenanceResult(action, "closing");
      }
    } catch { /* The caller gets a bounded state, never descriptor or lease details. */ }
    return maintenanceResult(action, "unavailable");
  };

  const runBridgeMaintenance = async (input) => {
    const control = bridgeControl(input);
    if (!control) throw new TypeError("Morrow Bridge maintenance control is invalid");
    const lease = control.action === "status" ? null : maintenanceLease;
    if (control.action !== "status" && (!lease || maintenanceCommitted)) {
      throw new Error("Morrow Bridge maintenance lease is not held");
    }
    const holderPid = lease ? lease.holderPid : process.pid;
    if (!validPid(holderPid)) throw new Error("Morrow Bridge maintenance holder is unavailable");
    const { requestLocalOwnerMaintenance } = await maintenanceModules(paths.serverEntryPath);
    const result = await requestLocalOwnerMaintenance({
      action: "bridge",
      journalPath: paths.journalPath,
      workspaceRoot: paths.workspaceRoot,
      holderPid,
      control,
      ...(lease ? { leaseId: lease.leaseId, leaseToken: lease.leaseToken } : {}),
    });
    const record = result.status === "bridge" ? bridgeRecord(control, result.result) : null;
    if (!record) throw new Error("Morrow Bridge maintenance result is invalid");
    return record;
  };

  return Object.freeze({
    async start() {
      if (maintenanceLease || maintenanceCommitted) return copied(current);
      if (starting) return starting;
      starting = refreshInitialGatewayReadiness().finally(() => { starting = null; });
      return starting;
    },
    snapshot() {
      return copied(current);
    },
    async firstSafeRead() {
      if (starting) await starting;
      return runFirstSafeRead();
    },
    async maintenance(input) {
      if (starting) await starting;
      return runMaintenance(input || {});
    },
    async bridgeMaintenance(control) {
      if (starting) await starting;
      return runBridgeMaintenance(control);
    },
    async testDiagnostics() {
      if (starting) await starting;
      return runTestDiagnostics();
    },
    async close() {
      if (starting) await starting.catch(() => {});
      await releaseHeldMaintenance();
      await disconnect();
    },
  });
}
