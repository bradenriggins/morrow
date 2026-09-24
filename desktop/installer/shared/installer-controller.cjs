"use strict";

const crypto = require("node:crypto");
const fsConstants = require("node:fs").constants;
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { ASSISTANTS, errorDetails, installerState } = require("./contract.cjs");

/**
 * The public code for one refused restart lease. The runtime names which
 * condition held it, so the person is told what to wait for; a refusal Morrow
 * cannot explain keeps the general answer.
 */
const RESTART_REFUSALS = Object.freeze({
  local_owner_request_in_flight: "runtime_request_in_flight",
  local_owner_approval_running: "runtime_change_running",
  local_owner_other_client_connected: "runtime_other_client_connected"
});

function restartRefusalCode(reason) {
  return (typeof reason === "string" && RESTART_REFUSALS[reason]) || "active_or_uncertain_operations";
}

/**
 * Whether the runtime reports a Bridge connected right now: true, false, or
 * "unknown" when this monitor cannot say.
 */
function reportedBridgeConnection(monitor) {
  let connected;
  try { connected = monitor?.snapshot?.()?.health?.bridgeConnected; } catch { connected = undefined; }
  return typeof connected === "boolean" ? connected : "unknown";
}

// A refusal that already names what holds Morrow keeps its own words when an
// update of a connected Bridge stops. Any other failure is the update failing.
const NAMED_MAINTENANCE_REFUSALS = new Set([
  "runtime_repair_required",
  "active_or_uncertain_operations",
  "runtime_request_in_flight",
  "runtime_change_running",
  "runtime_other_client_connected"
]);

function bridgeUpdateRefusal(error) {
  // The Bridge refuses to pause while it is in the middle of course work.
  if (error?.code === "bridge_quiesce_busy") return errorDetails("active_or_uncertain_operations");
  return errorDetails(NAMED_MAINTENANCE_REFUSALS.has(error?.code) ? error.code : "bridge_update_failed");
}
const { DATA_REMOVAL_SCHEMA, freshRecord, insideDirectory, inspectRecord, readPrivateRegularFile, retentionSnapshot } = require("./state-policy.cjs");
const {
  bridgeInstallationStatus,
  compareChromeVersions,
  confirmBridgeUpdate,
  discardBridgeTransactions,
  initializeBridgeDirectory,
  inspectPendingBridgeUpdate,
  issueBridgeActiveFolderChallenge,
  parseChromeVersion,
  prepareBridgeUpdate,
  pruneBridgeRollbackCopies,
  readReleaseManifest,
  rollbackPendingBridgeUpdate
} = require("./bridge-updates.cjs");
const { completeBridgeUpdate, stageBridgeSwap } = require("./bridge-coordination.cjs");
const BRIDGE_RELOAD_WAIT_MS = 30_000;
const BRIDGE_RELOAD_POLL_MS = 1_000;
const {
  detectClaudeDesktop,
  inspectClaudeDesktopConnection,
  isCurrentClaudeDesktopSetup,
  prepareClaudeDesktopBundle,
  processAlive,
  resolveClaudeDesktopLauncher,
} = require("./claude-desktop.cjs");
const {
  WINDOWS_POWERSHELL_TIMEOUT_MS,
  processMatchesRecordedLifetime,
  windowsPowerShellPath,
} = require("./process-lifetime.cjs");
const { blackboardPaths, blackboardTenantIdFromBaseUrl, configureBlackboard, readBlackboardHealth, removeBlackboardData, removeBlackboardTenant, selectBlackboardCourses } = require("./blackboard.cjs");
const { detectAssistantApplication, detectAssistantCommand, detectGeminiCli } = require("./assistant-app-detection.cjs");
const { detectWindowsCodexPackage } = require("./windows-appx-detection.cjs");
const { parseStrictJson } = require("./strict-utf8.cjs");
const {
  canonicalDirectory,
  captureConfiguration,
  exists,
  isComplete,
  verifyMcpRuntime,
  runtimeStatus,
  payloadLayout,
  mkdirPrivate
} = require("./runtime.cjs");

const BRIDGE_EXTENSION_ID = "abeloclekioohahgedmjcdbpllfjfhko";

/**
 * The two Chrome routes setup can ask a person to take for Morrow Bridge.
 * `developer_temporary` is the temporary unpacked route Morrow uses until the
 * Chrome Web Store listing is live; `available` is the Store route. The build
 * chooses it once, in installer/electron-builder.config.cjs, and the installed
 * app reads it from its own packaged build metadata, so publishing the Store
 * listing flips the route with a rebuilt package and no new installer logic.
 *
 * The route decides only which instructions setup shows. It grants nothing: the
 * Bridge identity, active-folder, and pairing checks are the same on both.
 */
const BRIDGE_DELIVERY_MODES = Object.freeze(["available", "developer_temporary"]);
const DEFAULT_BRIDGE_DELIVERY = "developer_temporary";

/**
 * The delivery route this installation may claim. A missing, misspelled, or
 * otherwise unrecognised value keeps the temporary route: it is the route that
 * works without a Store listing, so an unreadable flag never sends a person to
 * a Chrome Web Store page that may not exist.
 */
function bridgeDeliveryMode(value) {
  return BRIDGE_DELIVERY_MODES.includes(value) ? value : DEFAULT_BRIDGE_DELIVERY;
}

// How long one assistant detection answer is reused. Setup reads its state on
// every window focus, and detection reaches the file system and, on Windows,
// PowerShell. Selecting Check status asks again straight away.
const ASSISTANT_DETECTION_TTL_MS = 60_000;

function withUpdateRevision(current, updates) {
  return {
    ...current,
    updates: {
      ...current.updates,
      revision: Number.isSafeInteger(updates?.revision) && updates.revision >= 0 ? updates.revision : 0
    }
  };
}

/** The state Morrow reports when it cannot read its own installer record. */
function repairRequiredState(updates = null) {
  return withUpdateRevision(installerState({ lifecycle: "repair_required", assistants: [], selectedAssistantId: null, workspaceSelected: false, runtimeStatus: "repair_required", bridgeDelivery: DEFAULT_BRIDGE_DELIVERY, bridgeFolderReady: false, bridgeLoadedInChrome: false, bridgePaired: "unknown", courseSite: "unknown", runtimeVerifiedCourseCount: 0, selectedCourseName: null, updates }), updates);
}

function unobservedRuntime() {
  return {
    schema: "morrow.installer-runtime.v1",
    health: { attempted: false, gatewayReady: "unknown", bridgeConnected: "unknown", canRestart: "unknown" },
    bindings: { runtimeVerifiedCourseCount: 0, selectedCourseName: null, firstPreviewCourseName: null },
    firstPreview: { available: "unknown", completed: false }
  };
}

function fileHash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

// A configured assistant file is read back for verification, removal, and the
// state display. Four MiB is far above any real one; a larger file is refused
// as unreadable rather than read whole.
const ASSISTANT_CONFIG_READ_LIMIT = 4 * 1024 * 1024;
const INSTALLER_RECORD_READ_LIMIT = 64 * 1024;
const ASSISTANT_REMOVAL_READ_LIMIT = 16 * 1024;
const ASSISTANT_REMOVAL_SCHEMA = "morrow.assistant-removal.v1";
const ASSISTANT_CONNECTION_SCHEMA = "morrow.assistant-connections.v1";
const CLAUDE_GENERATION_TRANSITION_READ_LIMIT = 64 * 1024;
const CLAUDE_GENERATION_TRANSITION_SCHEMA = "morrow.claude-generation-transition.v1";
const CLAUDE_SETUP_ROOT_LIMIT = 128;
const SHA256 = /^[0-9a-f]{64}$/;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function readConfigurationFile(file) {
  const info = await fs.lstat(file).then((value) => value, () => null);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.size > ASSISTANT_CONFIG_READ_LIMIT) return null;
  return fs.readFile(file);
}

function sameBridgeChallenge(record, response) {
  const challenge = record?.activeFolderChallenge;
  const proof = response?.activeFolderProof;
  return Boolean(challenge && proof
    && response.extensionId === record.extensionId
    && response.manifestVersion === record.version
    && proof.extensionId === challenge.extensionId
    && proof.manifestVersion === challenge.manifestVersion
    && proof.challengeId === challenge.challengeId
    && proof.nonce === challenge.nonce
    && proof.challengeSha256 === challenge.sha256);
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const DEFAULT_COMMAND_OUTPUT_LIMIT = 128 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 500;
const DEFAULT_CLOSE_GRACE_MS = 500;

function killChild(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch (error) {
    if (error?.code === "ESRCH") return;
  }
  try { child.kill(signal); } catch {}
}

/**
 * Runs one command with finite time, retained output, and termination bounds.
 * POSIX children own a process group so their descendants cannot outlive a
 * timed-out installer command. Windows child.kill terminates the spawned
 * process directly. The final deadline releases pipes and settles even when an
 * operating-system process is stuck and never reports close.
 */
function runBoundedCommand(executable, argumentsValue, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_COMMAND_OUTPUT_LIMIT;
    const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    const closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
      || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0
      || !Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 0
      || !Number.isSafeInteger(closeGraceMs) || closeGraceMs < 0) {
      reject(new TypeError("Invalid bounded command limits"));
      return;
    }

    let child;
    try {
      child = spawn(executable, argumentsValue, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32"
      });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout = [];
    const stderr = [];
    let retainedBytes = 0;
    let observedBytes = 0;
    let settled = false;
    let termination = null;
    let forceKillTimer = null;
    let closeDeadlineTimer = null;

    const clearTimers = () => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (closeDeadlineTimer) clearTimeout(closeDeadlineTimer);
    };
    const result = (code, signal) => ({
      code,
      signal: signal || null,
      termination,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(value);
    };
    const terminate = (reason) => {
      if (settled || termination) return;
      termination = reason;
      clearTimeout(timeoutTimer);
      killChild(child, "SIGTERM");
      forceKillTimer = setTimeout(() => killChild(child, "SIGKILL"), terminationGraceMs);
      closeDeadlineTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish(result(null, "SIGKILL"));
      }, terminationGraceMs + closeGraceMs);
    };
    const retain = (destination, chunk) => {
      observedBytes += chunk.length;
      const available = maxOutputBytes - retainedBytes;
      if (available > 0) {
        const kept = chunk.length <= available ? chunk : chunk.subarray(0, available);
        destination.push(Buffer.from(kept));
        retainedBytes += kept.length;
      }
      if (observedBytes > maxOutputBytes) terminate("output_limit");
    };
    const timeoutTimer = setTimeout(() => terminate("timeout"), timeoutMs);
    child.stdout.on("data", (chunk) => retain(stdout, chunk));
    child.stderr.on("data", (chunk) => retain(stderr, chunk));
    child.once("error", (reason) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(reason);
    });
    child.once("close", (code, signal) => finish(result(code, signal)));
  });
}

/**
 * Runs one bounded read-only command and answers with its standard output, or
 * `null` when it cannot start, exits non-zero, passes its time limit, or writes
 * more than `maxBytes`. Assistant detection runs on the Electron main process,
 * so this waits for the child asynchronously and never holds the window.
 */
async function readCommandOutput(executable, argumentsValue, { timeoutMs, maxBytes }) {
  try {
    const result = await runBoundedCommand(executable, argumentsValue, {
      timeoutMs,
      maxOutputBytes: maxBytes
    });
    return result.code === 0 && result.termination === null ? result.stdout : null;
  } catch {
    return null;
  }
}

async function readMacApplicationBundleIdentifier(applicationPath) {
  if (process.platform !== "darwin") return null;
  const output = await readCommandOutput("/usr/bin/plutil", [
    "-extract", "CFBundleIdentifier", "raw", "-n", path.join(applicationPath, "Contents", "Info.plist")
  ], { timeoutMs: 2_000, maxBytes: 4 * 1024 });
  const identifier = String(output || "").trim();
  return identifier || null;
}

async function runWindowsPowerShell(script) {
  if (process.platform !== "win32") return null;
  return readCommandOutput(windowsPowerShellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    timeoutMs: WINDOWS_POWERSHELL_TIMEOUT_MS,
    maxBytes: 8 * 1024
  });
}

async function commandFound(command) {
  return detectAssistantCommand({
    command,
    probe: async (candidate) => await readCommandOutput(candidate, ["--version"], {
      timeoutMs: 2_000,
      maxBytes: 4 * 1024,
    }) !== null,
  });
}

async function findMacApplicationsByBundleIdentifier(identifier) {
  if (process.platform !== "darwin" || !/^[A-Za-z0-9.-]{1,155}$/.test(identifier)) return [];
  const output = await readCommandOutput("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${identifier}'`], {
    timeoutMs: 3_000,
    maxBytes: 16 * 1024
  });
  return String(output || "").split("\n").map((line) => line.trim()).filter((line) => path.isAbsolute(line));
}

async function detectAssistant(assistant) {
  if (assistant.id === "claude-desktop") {
    return detectClaudeDesktop({
      platform: process.platform,
      homeDirectory: os.homedir(),
      exists,
      readBundleIdentifier: readMacApplicationBundleIdentifier,
      findByBundleIdentifier: findMacApplicationsByBundleIdentifier
    });
  }
  if (process.platform === "win32" && assistant.id === "codex") {
    return detectWindowsCodexPackage({ assistantId: assistant.id, runPowerShell: runWindowsPowerShell });
  }
  const applicationDirectories = process.platform === "win32"
    ? [process.env.LOCALAPPDATA, process.env.ProgramFiles].filter(Boolean)
    : ["/Applications", path.join(os.homedir(), "Applications")];
  if (await detectAssistantApplication({
    assistantId: assistant.id,
    applicationDirectories,
    exists,
    readBundleIdentifier: readMacApplicationBundleIdentifier
  })) return true;
  if (assistant.id === "claude-code") return commandFound("claude");
  if (assistant.id === "gemini-cli") return detectGeminiCli();
  if (assistant.id === "codex") return commandFound("codex");
  return false;
}

/**
 * The public error for one refusal client-config reported in --json mode, naming the
 * assistant's own settings file. `null` when the output carries no such report.
 */
const CLIENT_CONFIG_REFUSALS = Object.freeze({
  config_invalid: "assistant_config_invalid",
  config_unreadable: "assistant_config_unreadable",
  config_read_only: "assistant_config_read_only",
  config_permission_denied: "assistant_config_permission_denied",
  config_symlink: "assistant_config_symlink",
  config_busy: "assistant_config_busy",
  config_existing_entry: "existing_morrow_configuration",
  config_entry_not_morrow: "existing_morrow_configuration",
  config_changed: "existing_morrow_configuration",
});

function clientConfigRefusal(output) {
  for (const line of String(output || "").split(/\r?\n/)) {
    if (!line.startsWith("{\"schema\":\"morrow.client-config-error.v1\"")) continue;
    try {
      const report = JSON.parse(line);
      const code = Object.hasOwn(CLIENT_CONFIG_REFUSALS, report?.code) ? CLIENT_CONFIG_REFUSALS[report.code] : null;
      if (code) return errorDetails(code, typeof report.path === "string" && path.isAbsolute(report.path) ? report.path : null);
    } catch {}
  }
  return null;
}

/**
 * Repair answers only with an installer error state the setup view can show, so
 * a failure from a module with its own error vocabulary is reported as the
 * step Morrow could not finish.
 */
function reportedError(error) {
  return typeof error?.code === "string" && typeof error?.recovery === "string" ? error : errorDetails("setup_failed");
}

function clientConfigTarget(assistant, home, project) {
  switch (assistant.id) {
    case "codex": return path.join(home, ".codex", "config.toml");
    case "claude-code": return path.join(project, ".mcp.json");
    case "gemini-cli": return path.join(project, ".gemini", "settings.json");
    default: return null;
  }
}

// The name client-config gives the Morrow server in every assistant
// configuration file. The installer never passes --name, so this is the name
// every entry it wrote carries.
const MORROW_SERVER_NAME = "morrow";

function exactObject(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key)));
}

function canonicalAbsolutePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && !value.includes("\0") && path.isAbsolute(value) && path.normalize(value) === value;
}

function installerRecordDigest(record, home) {
  const inspected = inspectRecord(record, { homeDirectory: home });
  if (!inspected.compatible) throw new Error(inspected.reason);
  return fileHash(Buffer.from(JSON.stringify(inspected.record), "utf8"));
}

function recordWithoutAssistant(record, assistantId) {
  const configured = { ...(record.configured || {}) };
  delete configured[assistantId];
  const remaining = ASSISTANTS.map((candidate) => candidate.id).filter((id) => configured[id] !== undefined);
  return {
    ...record,
    selectedAssistantId: record.selectedAssistantId === assistantId ? remaining[0] ?? null : record.selectedAssistantId,
    configured,
  };
}

function inspectAssistantRemovalTombstone(value, home) {
  const keys = [
    "schema", "operationId", "assistantId", "target", "beforeSha256", "afterSha256",
    "recordBeforeSha256", "recordAfterSha256",
  ];
  if (!exactObject(value, keys) || value.schema !== ASSISTANT_REMOVAL_SCHEMA
    || typeof value.operationId !== "string" || !OPERATION_ID.test(value.operationId)
    || typeof value.assistantId !== "string"
    || typeof value.target !== "string" || !canonicalAbsolutePath(value.target)
    || typeof value.beforeSha256 !== "string" || !SHA256.test(value.beforeSha256)
    || typeof value.afterSha256 !== "string" || !SHA256.test(value.afterSha256)
    || value.beforeSha256 === value.afterSha256
    || typeof value.recordBeforeSha256 !== "string" || !SHA256.test(value.recordBeforeSha256)
    || typeof value.recordAfterSha256 !== "string" || !SHA256.test(value.recordAfterSha256)
    || value.recordBeforeSha256 === value.recordAfterSha256) return null;
  const assistant = ASSISTANTS.find((candidate) => candidate.id === value.assistantId);
  if (!assistant || assistant.id === "claude-desktop" || !configuredProject(assistant, home, value.target)) return null;
  return {
    schema: value.schema,
    operationId: value.operationId,
    assistantId: value.assistantId,
    target: value.target,
    beforeSha256: value.beforeSha256,
    afterSha256: value.afterSha256,
    recordBeforeSha256: value.recordBeforeSha256,
    recordAfterSha256: value.recordAfterSha256,
  };
}

function directClaudeSetupRoot(candidate, setupRoot, prefix = "setup-") {
  return canonicalAbsolutePath(candidate)
    && path.dirname(candidate) === setupRoot
    && path.basename(candidate).startsWith(prefix)
    && path.basename(candidate).length > prefix.length;
}

function inspectClaudeGenerationTransition(value, stateDirectory, home) {
  const keys = ["schema", "operationId", "mode", "recordBeforeSha256", "recordAfterSha256", "preparedEntry", "moves"];
  if (!exactObject(value, keys) || value.schema !== CLAUDE_GENERATION_TRANSITION_SCHEMA
    || typeof value.operationId !== "string" || !OPERATION_ID.test(value.operationId)
    || !["replace", "remove", "prune"].includes(value.mode)
    || typeof value.recordBeforeSha256 !== "string" || !SHA256.test(value.recordBeforeSha256)
    || typeof value.recordAfterSha256 !== "string" || !SHA256.test(value.recordAfterSha256)
    || !Array.isArray(value.moves) || value.moves.length > CLAUDE_SETUP_ROOT_LIMIT) return null;
  const setupRoot = path.join(stateDirectory, "ClaudeDesktop");
  const moves = [];
  const sources = new Set();
  const destinations = new Set();
  for (let index = 0; index < value.moves.length; index += 1) {
    const move = value.moves[index];
    if (!exactObject(move, ["source", "destination"])
      || !directClaudeSetupRoot(move.source, setupRoot)
      || !directClaudeSetupRoot(move.destination, setupRoot, `.quarantine-${value.operationId}-${index}-`)
      || sources.has(move.source) || destinations.has(move.destination)) return null;
    sources.add(move.source);
    destinations.add(move.destination);
    moves.push({ source: move.source, destination: move.destination });
  }
  let preparedEntry = null;
  if (value.mode === "replace") {
    if (value.recordBeforeSha256 === value.recordAfterSha256 || !value.preparedEntry) return null;
    const inspected = inspectRecord({ ...freshRecord(), configured: { "claude-desktop": value.preparedEntry } }, { homeDirectory: home });
    preparedEntry = inspected.compatible ? inspected.record.configured["claude-desktop"] : null;
    if (!preparedEntry || !directClaudeSetupRoot(path.dirname(preparedEntry.bundlePath), setupRoot)
      || sources.has(path.dirname(preparedEntry.bundlePath))) return null;
  } else {
    if (value.preparedEntry !== null) return null;
    if (value.mode === "remove" ? value.recordBeforeSha256 === value.recordAfterSha256
      : value.recordBeforeSha256 !== value.recordAfterSha256) return null;
  }
  return {
    schema: value.schema,
    operationId: value.operationId,
    mode: value.mode,
    recordBeforeSha256: value.recordBeforeSha256,
    recordAfterSha256: value.recordAfterSha256,
    preparedEntry,
    moves,
  };
}

/**
 * The assistant project that produced the configuration file Morrow recorded.
 * The candidate is confirmed by rebuilding the stored target from it, so a
 * record that does not describe this computer is refused instead of guessed.
 */
function configuredProject(assistant, home, target) {
  if (typeof target !== "string" || !path.isAbsolute(target)) return null;
  const project = assistant.needsProject
    ? assistant.id === "claude-code" ? path.dirname(target) : path.dirname(path.dirname(target))
    : null;
  return clientConfigTarget(assistant, home, project) === target ? { project } : null;
}

/**
 * Whether the project folder an assistant was set up in is still a folder.
 * client-config cannot write into a folder that is gone, and Morrow never
 * makes one again: the educator may have deleted it on purpose.
 */
async function projectFolderPresent(project) {
  return fs.stat(project).then((info) => info.isDirectory(), () => false);
}

class InstallerController {
  constructor(deps) {
    this.app = deps.app;
    this.dialog = deps.dialog;
    this.shell = deps.shell;
    this.platform = deps.platform;
    this.testRoot = deps.testRoot || null;
    this.isTestMode = deps.isTestMode === true;
    this.productVersion = deps.productVersion;
    this.trustedBridgeReleaseManifestSha256 = deps.trustedBridgeReleaseManifestSha256;
    this.bridgeDelivery = bridgeDeliveryMode(deps.bridgeDelivery);
    this.trustedMcpRuntimeManifestSha256 = deps.trustedMcpRuntimeManifestSha256;
    this.trustedMcpRuntimeNodeSha256 = deps.trustedMcpRuntimeNodeSha256 || (() => null);
    this.detectAssistant = deps.detectAssistant;
    // "ok", or "move_required" for a Mac app that runs from a disk image, a
    // translocated copy, or anywhere outside Applications. See app-location.cjs.
    this.appLocation = typeof deps.appLocation === "function" ? deps.appLocation : () => "ok";
    this.moveApplication = typeof deps.moveToApplications === "function" ? deps.moveToApplications : async () => false;
    this.runCli = deps.runCli || runBoundedCommand;
    this.updateSnapshot = deps.updateSnapshot || (() => null);
    this.userData = this.app.getPath("userData");
    this.paths = payloadLayout(deps.payloadRoot, this.userData);
    this.home = deps.homeDirectory;
    this.recordPath = path.join(this.paths.state, "installer.json");
    this.assistantRemovalPath = path.join(this.paths.state, "assistant-removal.json");
    this.assistantConnectionPath = path.join(this.paths.state, "assistant-connections.json");
    this.claudeGenerationTransitionPath = path.join(this.paths.state, "claude-generation-transition.json");
    this.isCurrentClaudeDesktopSetup = deps.isCurrentClaudeDesktopSetup || isCurrentClaudeDesktopSetup;
    this.workspace = null;
    this.runtimeMonitor = null;
    this.runtimeWorkspace = null;
    this.runtimeClosing = null;
    this.runtimeLifecycle = Promise.resolve();
    this.restartLeases = new Map();
    this.bridgeInstallation = null;
    this.bridgeInitialization = null;
    this.bridgeStartupAttempted = false;
    this.bridgeVerificationFailed = false;
    this.bridgeReconciliation = null;
    this.bridgeLeaseId = null;
    this.mcpRuntimeVerification = null;
    this.privateFileAccess = null;
    this.privateFileAccessModule = null;
    this.gatewayCoreModuleImport = null;
    this.blackboardClientModule = null;
    this.discoverBlackboardConnection = deps.discoverBlackboardConnection || ((input) => this.readBlackboardConnection(input));
    this.desktopMutationInProgress = null;
    this.desktopMutationGuard = null;
    this.desktopMutationScope = new AsyncLocalStorage();
    this.dataRemovalInProgress = null;
    this.dataRemovalGuard = null;
    this.dataRemoval = null;
    // assistant id -> { at, answer }. See detectedAssistant().
    this.assistantDetection = new Map();
  }

  /**
   * Whether this assistant is on this computer, reusing the answer Morrow read
   * less than ASSISTANT_DETECTION_TTL_MS ago. Concurrent reads share the one
   * detection in flight. A detection that fails is not kept, so the next state
   * read asks again instead of repeating a failure for a minute.
   */
  detectedAssistant(assistant) {
    const cached = this.assistantDetection.get(assistant.id);
    if (cached && Date.now() - cached.at < ASSISTANT_DETECTION_TTL_MS) return cached.answer;
    const entry = { at: Date.now(), answer: (async () => this.detectAssistant(assistant))() };
    this.assistantDetection.set(assistant.id, entry);
    entry.answer.catch(() => {
      if (this.assistantDetection.get(assistant.id) === entry) this.assistantDetection.delete(assistant.id);
    });
    return entry.answer;
  }

  /** Reads this assistant now and keeps that answer for the next state read. */
  freshlyDetectedAssistant(assistant) {
    this.assistantDetection.delete(assistant.id);
    return this.detectedAssistant(assistant);
  }

  async readInstallerRecord() {
    try {
      const content = await readPrivateRegularFile(this.recordPath, {
        maxBytes: INSTALLER_RECORD_READ_LIMIT,
        trustedRoot: this.paths.state,
      });
      const parsed = parseStrictJson(content, "installer record");
      const inspected = inspectRecord(parsed, { homeDirectory: this.home });
      if (!inspected.compatible) throw new Error(inspected.reason);
      return inspected.record;
    } catch (error) {
      if (error?.code === "ENOENT") return freshRecord();
      throw error;
    }
  }

  async record() {
    const record = await this.readInstallerRecord();
    if (await this.readAssistantRemovalTombstone()) throw new Error("assistant_removal_recovery_required");
    if (await this.readClaudeGenerationTransition()) throw new Error("claude_generation_recovery_required");
    return record;
  }

  async ensureInstallerStateDirectory() {
    const existingDirectory = await fs.lstat(this.paths.state).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (existingDirectory && (!existingDirectory.isDirectory() || existingDirectory.isSymbolicLink())) {
      throw new Error("record_directory_invalid");
    }
    await mkdirPrivate(this.paths.state);
    const stateDirectory = await fs.lstat(this.paths.state);
    // Mode bits describe the file system this process runs on, as the record
    // read through readPrivateRegularFile already assumes.
    if (!stateDirectory.isDirectory() || stateDirectory.isSymbolicLink()
      || (process.platform !== "win32" && (stateDirectory.mode & 0o077) !== 0)) {
      throw new Error("record_directory_invalid");
    }
  }

  // A folder flush is a POSIX file-system call: Windows refuses it, whatever
  // platform this controller serves. Every folder flush here asks the host.
  async syncInstallerStateDirectory() {
    if (process.platform === "win32") return;
    const directory = await fs.open(this.paths.state, fsConstants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async readAssistantRemovalTombstone() {
    let content;
    try {
      content = await readPrivateRegularFile(this.assistantRemovalPath, {
        maxBytes: ASSISTANT_REMOVAL_READ_LIMIT,
        trustedRoot: this.paths.state,
      });
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw new Error("assistant_removal_recovery_required");
    }
    let parsed;
    try { parsed = parseStrictJson(content, "assistant removal recovery record"); }
    catch { throw new Error("assistant_removal_recovery_required"); }
    const inspected = inspectAssistantRemovalTombstone(parsed, this.home);
    if (!inspected) throw new Error("assistant_removal_recovery_required");
    return inspected;
  }

  async writeAssistantRemovalTombstone(tombstone) {
    const inspected = inspectAssistantRemovalTombstone(tombstone, this.home);
    if (!inspected) throw new Error("assistant_removal_recovery_required");
    await this.ensureInstallerStateDirectory();
    if (await fs.lstat(this.assistantRemovalPath).then(() => true, (error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    })) throw new Error("assistant_removal_recovery_required");

    const temporary = `${this.assistantRemovalPath}.tmp-${crypto.randomUUID()}`;
    let handle = null;
    try {
      handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      await handle.writeFile(`${JSON.stringify(inspected)}\n`, "utf8");
      if (this.platform !== "win32") await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.link(temporary, this.assistantRemovalPath);
      await fs.rm(temporary, { force: true });
      await this.syncInstallerStateDirectory();
    } finally {
      await handle?.close().catch(() => {});
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
    const persisted = await this.readAssistantRemovalTombstone();
    if (JSON.stringify(persisted) !== JSON.stringify(inspected)) {
      throw new Error("assistant_removal_recovery_required");
    }
    return inspected;
  }

  async clearAssistantRemovalTombstone(expected) {
    const current = await this.readAssistantRemovalTombstone();
    if (!current || JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error("assistant_removal_recovery_required");
    }
    await fs.unlink(this.assistantRemovalPath);
    await this.syncInstallerStateDirectory();
    if (await this.readAssistantRemovalTombstone()) throw new Error("assistant_removal_recovery_required");
  }

  async readClaudeGenerationTransition() {
    let content;
    try {
      content = await readPrivateRegularFile(this.claudeGenerationTransitionPath, {
        maxBytes: CLAUDE_GENERATION_TRANSITION_READ_LIMIT,
        trustedRoot: this.paths.state,
      });
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw new Error("claude_generation_recovery_required");
    }
    let parsed;
    try { parsed = parseStrictJson(content, "Claude generation recovery record"); }
    catch { throw new Error("claude_generation_recovery_required"); }
    const inspected = inspectClaudeGenerationTransition(parsed, await fs.realpath(this.paths.state), this.home);
    if (!inspected) throw new Error("claude_generation_recovery_required");
    return inspected;
  }

  async writeClaudeGenerationTransition(transition) {
    const inspected = inspectClaudeGenerationTransition(transition, await fs.realpath(this.paths.state), this.home);
    if (!inspected) throw new Error("claude_generation_recovery_required");
    await this.ensureInstallerStateDirectory();
    if (await fs.lstat(this.claudeGenerationTransitionPath).then(() => true, (error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    })) throw new Error("claude_generation_recovery_required");
    const temporary = `${this.claudeGenerationTransitionPath}.tmp-${crypto.randomUUID()}`;
    let handle = null;
    try {
      handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      await handle.writeFile(`${JSON.stringify(inspected)}\n`, "utf8");
      if (this.platform !== "win32") await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.link(temporary, this.claudeGenerationTransitionPath);
      await fs.rm(temporary, { force: true });
      await this.syncInstallerStateDirectory();
    } finally {
      await handle?.close().catch(() => {});
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
    const persisted = await this.readClaudeGenerationTransition();
    if (JSON.stringify(persisted) !== JSON.stringify(inspected)) throw new Error("claude_generation_recovery_required");
    return inspected;
  }

  async clearClaudeGenerationTransition(expected) {
    const current = await this.readClaudeGenerationTransition();
    if (!current || JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("claude_generation_recovery_required");
    await fs.unlink(this.claudeGenerationTransitionPath);
    await this.syncInstallerStateDirectory();
    if (await this.readClaudeGenerationTransition()) throw new Error("claude_generation_recovery_required");
  }

  async ensureInstallerBackupDirectory() {
    const backups = path.join(this.paths.state, "Backups");
    const existingDirectory = await fs.lstat(backups).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (existingDirectory && (!existingDirectory.isDirectory() || existingDirectory.isSymbolicLink())) {
      throw new Error("record_backup_directory_invalid");
    }
    if (!existingDirectory) {
      try { await fs.mkdir(backups, { mode: 0o700 }); }
      catch (error) { if (error?.code !== "EEXIST") throw error; }
    }
    const backupDirectory = await fs.lstat(backups);
    if (!backupDirectory.isDirectory() || backupDirectory.isSymbolicLink()) {
      throw new Error("record_backup_directory_invalid");
    }
    if (process.platform !== "win32") {
      const flags = fsConstants.O_RDONLY
        | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0)
        | (typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0);
      const directory = await fs.open(backups, flags);
      try {
        const opened = await directory.stat();
        if (!opened.isDirectory() || opened.dev !== backupDirectory.dev || opened.ino !== backupDirectory.ino) {
          throw new Error("record_backup_directory_invalid");
        }
        await directory.chmod(0o700);
        const hardened = await directory.stat();
        const hardenedPath = await fs.lstat(backups);
        if (!hardened.isDirectory() || (hardened.mode & 0o077) !== 0
          || !hardenedPath.isDirectory() || hardenedPath.isSymbolicLink()
          || hardenedPath.dev !== hardened.dev || hardenedPath.ino !== hardened.ino) {
          throw new Error("record_backup_directory_invalid");
        }
      } finally {
        await directory.close();
      }
    }
    return backups;
  }

  async writeRecord(record) {
    const inspected = inspectRecord({ ...freshRecord(), ...record }, { homeDirectory: this.home });
    if (!inspected.compatible) throw new Error(inspected.reason);
    await this.ensureInstallerStateDirectory();
    const temporary = `${this.recordPath}.tmp-${crypto.randomUUID()}`;
    let handle = null;
    let renamed = false;
    try {
      handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      await handle.writeFile(`${JSON.stringify(inspected.record)}\n`, "utf8");
      if (this.platform !== "win32") await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, this.recordPath);
      renamed = true;
      if (process.platform !== "win32") {
        const directory = await fs.open(this.paths.state, fsConstants.O_RDONLY);
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally {
      await handle?.close().catch(() => {});
      if (!renamed) await fs.rm(temporary, { force: true }).catch(() => {});
    }
    // Morrow keeps its own record on this computer again, so a report from an
    // earlier data removal no longer describes what is here.
    this.dataRemoval = null;
  }

  /**
   * Moves an unreadable record entry itself into Backups without reading
   * through it. This preserves a normal malformed record for support while a
   * symlink, directory, pipe, or device can never select bytes outside State.
   */
  async quarantineInstallerRecord() {
    const info = await fs.lstat(this.recordPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return null;
    const backups = await this.ensureInstallerBackupDirectory();
    let destination = null;
    if ((info.isFile() && !info.isSymbolicLink() && info.nlink === 1) || info.isDirectory()) {
      destination = path.join(backups, `installer-${crypto.randomUUID()}${info.isDirectory() ? ".invalid" : ".json"}`);
      await fs.rename(this.recordPath, destination);
      if (this.platform !== "win32" && info.isFile()) await fs.chmod(destination, 0o600);
    } else {
      await fs.rm(this.recordPath, { force: true });
    }
    if (process.platform !== "win32") {
      for (const directoryPath of [backups, this.paths.state]) {
        const directory = await fs.open(directoryPath, fsConstants.O_RDONLY);
        try { await directory.sync(); } finally { await directory.close(); }
      }
    }
    return destination;
  }

  /** Whether a confirmed data removal already ran in this session. */
  removedOwnData() {
    return this.dataRemoval !== null && this.dataRemoval.status !== "cancelled";
  }

  async privateFileAccessAccepted() {
    if (this.privateFileAccess) return this.privateFileAccess;
    await this.ensureRuntime();
    const module = await this.privateFileAccessModuleForPayload();
    if (typeof module.privateFileAccessAccepted !== "function") throw new Error("Morrow private file access is unavailable");
    this.privateFileAccess = module.privateFileAccessAccepted;
    return this.privateFileAccess;
  }

  async gatewayCoreModule() {
    if (!this.gatewayCoreModuleImport) {
      this.gatewayCoreModuleImport = import(pathToFileURL(path.join(this.paths.appRoot, "node_modules", "@morrow", "gateway-core", "dist", "index.js")).href);
    }
    return this.gatewayCoreModuleImport;
  }

  async privateFileAccessModuleForPayload() {
    if (!this.privateFileAccessModule) {
      await this.ensureRuntime();
      this.privateFileAccessModule = await this.gatewayCoreModule();
    }
    return this.privateFileAccessModule;
  }

  async blackboardClientModuleForPayload() {
    if (!this.blackboardClientModule) {
      await this.ensureRuntime();
      this.blackboardClientModule = import(pathToFileURL(path.join(this.paths.appRoot, "packages", "blackboard-learn-api", "dist", "client.js")).href);
    }
    return this.blackboardClientModule;
  }

  /**
   * Reads the Blackboard account that this server credential actually acts as,
   * then the courses Blackboard says that account can access. This runs before
   * setup saves either the credential or connection configuration.
   */
  async readBlackboardConnection(input) {
    const module = await this.blackboardClientModuleForPayload();
    if (typeof module.BlackboardLearnClient !== "function") throw new Error("Morrow Blackboard client is unavailable");
    const tenant = {
      id: blackboardTenantIdFromBaseUrl(input.baseUrl),
      baseUrl: input.baseUrl,
      applicationKey: input.applicationKey,
      clientSecret: input.applicationSecret,
      principalId: "_1_1",
      courseBindings: []
    };
    try {
      const client = new module.BlackboardLearnClient(tenant);
      const principal = await client.get("/learn/api/public/v1/users/me");
      if (!principal || typeof principal.id !== "string" || !/^_[1-9][0-9]{0,18}_[1-9][0-9]{0,18}$/.test(principal.id)) {
        throw new TypeError("Blackboard did not return a valid integration account");
      }
      const memberships = await client.collect(`/learn/api/public/v1/users/${encodeURIComponent(principal.id)}/courses`, {
        label: "course membership", expand: ["course"], maxRecords: 500
      });
      const courses = memberships.map((membership) => {
        if (!membership || typeof membership !== "object" || Array.isArray(membership) || membership.userId !== principal.id) {
          throw new TypeError("Blackboard returned a course membership for a different account");
        }
        const course = membership.course;
        if (!course || typeof course !== "object" || Array.isArray(course)
          || typeof course.id !== "string" || !/^_[1-9][0-9]{0,18}_[1-9][0-9]{0,18}$/.test(course.id)
          || (membership.courseId !== undefined && membership.courseId !== course.id)
          || typeof course.name !== "string" || !course.name.trim() || course.name.trim().length > 500) {
          throw new TypeError("Blackboard returned an invalid accessible course");
        }
        return { courseId: course.id, title: course.name.trim() };
      });
      return { principalId: principal.id, courses };
    } finally {
      tenant.clientSecret = "";
    }
  }

  async prepareBlackboardCredentialDirectories(directory) {
    const module = await this.privateFileAccessModuleForPayload();
    if (typeof module.hardenPrivateDirectory !== "function" || typeof module.privateDirectoryAccessAccepted !== "function") {
      throw new Error("Morrow private directory access is unavailable");
    }
    const configDirectory = path.dirname(path.dirname(directory));
    for (const candidate of [configDirectory, path.dirname(directory), directory]) {
      try {
        const metadata = await fs.lstat(candidate);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Blackboard credential directory is unavailable");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await fs.mkdir(candidate, { mode: 0o700 });
      }
      if (module.hardenPrivateDirectory(candidate, { trustedRoot: this.home }) !== true
        || module.privateDirectoryAccessAccepted(candidate, { trustedRoot: this.home }) !== true) {
        throw new Error("Blackboard credential directory is unavailable");
      }
    }
  }

  async writeBlackboardCredential({ directory, destination, credentialRevision, applicationSecret }) {
    await this.prepareBlackboardCredentialDirectories(directory);
    const temporary = path.join(directory, `.${path.basename(destination)}.tmp-${crypto.randomUUID()}`);
    const credential = {
      schema: "morrow.blackboard-learn.credential.v1",
      credentialRevision,
      applicationSecret
    };
    try {
      await fs.writeFile(temporary, `${JSON.stringify(credential)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      if (this.platform !== "win32") await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, destination);
      if (this.platform !== "win32") await fs.chmod(destination, 0o600);
    } finally {
      credential.applicationSecret = "";
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async blackboardHealth() {
    let privateFileAccessAccepted;
    try {
      privateFileAccessAccepted = await this.privateFileAccessAccepted();
    } catch { /* Health distinguishes a missing route from saved data Morrow cannot safely open. */ }
    return readBlackboardHealth(this.home, { privateFileAccessAccepted });
  }

  async configureBlackboard(input) {
    try {
      return await this.withDesktopMutation(async (transaction) => {
        await transaction.stopRuntime();
        const privateFileAccessAccepted = await this.privateFileAccessAccepted();
        return configureBlackboard({
          home: this.home,
          input,
          discoverConnection: this.discoverBlackboardConnection,
          privateFileAccessAccepted,
          prepareCredentialDirectory: ({ directory }) => this.prepareBlackboardCredentialDirectories(directory),
          writeCredential: (value) => this.writeBlackboardCredential(value)
        });
      });
    } finally {
      if (input && typeof input === "object" && typeof input.applicationSecret === "string") input.applicationSecret = "";
    }
  }

  async selectBlackboardCourses(input) {
    return this.withDesktopMutation(async (transaction) => {
      await transaction.stopRuntime();
      const privateFileAccessAccepted = await this.privateFileAccessAccepted();
      return selectBlackboardCourses({ home: this.home, input, privateFileAccessAccepted });
    });
  }

  /**
   * Takes one saved Blackboard connection off this computer, so a connection
   * saved for the wrong site or account is not permanent. It contacts
   * Blackboard for nothing and changes nothing in the Blackboard site.
   */
  async removeBlackboardTenant(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1) throw new TypeError("Blackboard removal request is invalid");
    return this.withDesktopMutation(async (transaction) => {
      await transaction.stopRuntime();
      const privateFileAccessAccepted = await this.privateFileAccessAccepted();
      return removeBlackboardTenant({ home: this.home, tenantId: input.tenantId, privateFileAccessAccepted });
    });
  }

  /** Removes only saved Blackboard routes and credentials from this computer. */
  async removeBlackboardData() {
    return this.withDesktopMutation(async (transaction) => {
      await transaction.stopRuntime();
      const result = await removeBlackboardData({ home: this.home });
      if (result.configuration !== "absent" || result.credentials !== "absent") throw new Error("Blackboard data removal is unconfirmed");
      return result;
    });
  }

  async effectiveWorkspace(record) {
    const currentRecord = record || await this.record();
    const candidate = this.workspace || currentRecord.materialsFolder || this.paths.defaultMaterials;
    if (await exists(candidate)) {
      try { return await canonicalDirectory(candidate); } catch { return null; }
    }
    return null;
  }

  /**
   * The folder Morrow was using when it is gone, or null. Before any assistant
   * is set up the default folder is not missing: assistant setup makes it.
   */
  materialsFolderMissing(record, materials) {
    if (materials) return null;
    const candidate = this.workspace || record.materialsFolder || this.paths.defaultMaterials;
    const isDefault = candidate === this.paths.defaultMaterials;
    const configured = record.configured && typeof record.configured === "object" ? Object.keys(record.configured).length > 0 : false;
    return isDefault && !configured ? null : { path: candidate, isDefault };
  }

  /**
   * Makes Morrow's own default materials folder again, empty, after it was
   * deleted while an assistant is set up to use it. The assistants already
   * name that exact folder, so none of them is written. A folder the person
   * chose is never made again: it may be on a drive that is not connected, and
   * an empty folder in its place would hide the real one.
   */
  async restoreMaterialsFolder() {
    const refused = this.locationAdmission() || this.maintenanceAdmission();
    if (refused) throw errorDetails(refused);
    const record = await this.record();
    if (await this.effectiveWorkspace(record)) return;
    if (this.materialsFolderMissing(record, null)?.isDefault !== true) throw errorDetails("setup_failed");
    await mkdirPrivate(this.paths.defaultMaterials);
  }

  /**
   * Creates the default materials folder only as part of the explicit assistant
   * setup transaction. State reads stay observational, including after a new
   * process starts with all app-owned data removed.
   */
  async workspaceForAssistantSetup(record) {
    const current = await this.effectiveWorkspace(record);
    if (current) return current;
    const candidate = this.workspace || record.materialsFolder || this.paths.defaultMaterials;
    if (candidate !== this.paths.defaultMaterials) return null;
    await mkdirPrivate(candidate);
    return canonicalDirectory(candidate);
  }

  /**
   * Chooses the materials folder, and binds every assistant this installation
   * configured to the folder that was chosen. The change stops the runtime and
   * rewrites assistant settings, so it is refused while another operation holds
   * the runtime, under the same fence repair and the data removal use.
   */
  async configureWorkspace(parent) {
    const refused = this.locationAdmission() || this.maintenanceAdmission();
    if (refused) throw errorDetails(refused);
    const result = await this.dialog.showOpenDialog(parent, {
      title: "Choose Morrow materials",
      buttonLabel: "Use this folder",
      properties: ["openDirectory", "createDirectory", "dontAddToRecent"]
    });
    if (result.canceled || result.filePaths.length !== 1) return false;
    const materials = await canonicalDirectory(result.filePaths[0]);
    await this.admitMaterialsFolder(materials);
    return this.withDesktopMutation(async (transaction) => {
      const record = await this.record();
      // Read what the change has to write before it writes anything, so a record
      // this computer cannot act on stops the change instead of leaving Morrow
      // and its assistants in different folders.
      const bindings = this.assistantBindings(record);
      // Choosing the folder that is already in use is recorded as the choice it
      // is and nothing else: rewriting each assistant would ask for the Claude
      // Desktop approval again for a folder that did not change.
      const changed = (await this.effectiveWorkspace(record)) !== materials;
      if (changed) await transaction.stopRuntime();
      const staged = changed ? await this.bindConfiguredAssistants(bindings, materials) : [];
      try {
        const configured = { ...(record.configured || {}) };
        for (const change of staged) {
          await change.verify?.();
          configured[change.assistant.id] = change.entry;
        }
        const updated = { ...record, materialsFolder: materials, configured };
        for (const change of staged) await change.beforeRecordCommit?.(record, updated);
        await this.writeRecord(updated);
        this.workspace = materials;
      } catch (error) {
        await this.rollbackAssistantBindings(staged);
        throw error;
      }
      for (const change of staged) await change.commit?.().catch(() => {});
      return true;
    });
  }

  /**
   * Refuses a materials folder Morrow cannot work in, before anything is
   * written: a folder the runtime refuses as its workspace, which no assistant
   * could start Morrow in, and a folder that is, holds, or sits inside one of
   * Morrow's own folders. Morrow's own default Materials folder is allowed.
   */
  async admitMaterialsFolder(materials) {
    if (await this.workspaceRefusedByRuntime(materials)) throw errorDetails("materials_folder_too_broad");
    const userData = this.paths.userData;
    const realUserData = await fs.realpath(userData).catch(() => userData);
    const owned = [this.paths.state, this.paths.bridgeDirectory, this.paths.assistantBackups, this.paths.windowData];
    for (const folder of owned) {
      const places = [...await this.pathForms(folder), path.join(realUserData, path.relative(userData, folder))];
      if (places.some((place) => insideDirectory(place, materials) || insideDirectory(materials, place))) {
        throw errorDetails("materials_folder_morrow_data");
      }
    }
  }

  /**
   * Whether the runtime refuses `folder` as its workspace, by the runtime's own
   * rule: a whole drive, the home folder, or a folder that holds the home folder.
   */
  async workspaceRefusedByRuntime(folder) {
    await this.ensureRuntime();
    const module = await import(pathToFileURL(path.join(path.dirname(this.paths.server), "local-owner-maintenance.js")).href);
    if (typeof module.workspaceRootTooBroad !== "function") throw errorDetails("runtime_repair_required");
    return module.workspaceRootTooBroad(folder) === true;
  }

  /**
   * The folder a maintenance guard fences: the materials folder, or Morrow's
   * own folder when there is none or the runtime refuses the one recorded. No
   * runtime can run in a folder the runtime refuses, and a guard on that folder
   * is never granted, so fencing it would refuse every later step.
   */
  async fencedWorkspace(materials) {
    if (materials && !await this.workspaceRefusedByRuntime(materials)) return materials;
    return canonicalDirectory(this.paths.userData);
  }

  /** A path as written and, when it exists, as the disk resolves it. */
  async pathForms(value) {
    const real = await fs.realpath(value).catch(() => null);
    return real && real !== path.resolve(value) ? [path.resolve(value), real] : [path.resolve(value)];
  }

  /**
   * The configuration file each configured assistant is set up through, refused
   * when the record names a file that does not rebuild from this computer. The
   * refusal is the same one repair uses for a record it cannot act on.
   */
  assistantBindings(record) {
    const configured = record?.configured && typeof record.configured === "object" && !Array.isArray(record.configured) ? record.configured : {};
    return ASSISTANTS.flatMap((assistant) => {
      const entry = configured[assistant.id];
      if (!entry) return [];
      if (assistant.id === "claude-desktop") return [{ assistant, entry, project: null }];
      const located = configuredProject(assistant, this.home, entry.target);
      if (!located) throw errorDetails("setup_failed");
      return [{ assistant, entry, project: located.project }];
    });
  }

  /**
   * Writes the materials folder into every assistant this installation
   * configured, so each assistant starts Morrow in the exact folder Morrow
   * uses. Morrow finds its own entry in each settings file by its marker and
   * rewrites only that entry, so the rest of the file stays as the assistant
   * or the person left it. An assistant whose project folder is gone is left
   * out, and setup names that folder and offers Remove. The installer record
   * changes only after every assistant was written and read back. A failure
   * restores each earlier file only if nothing else changed it after Morrow's
   * write.
   */
  async bindConfiguredAssistants(bindings, materials) {
    const staged = [];
    try {
      for (const { assistant, entry, project } of bindings) {
        if (assistant.id === "claude-desktop") {
          staged.push(await this.stageClaudeDesktopSetup(assistant, entry, materials));
          continue;
        }
        if (project && !await projectFolderPresent(project)) continue;
        const installed = await this.installClientConfiguration(assistant, entry.target, project, materials, {
          rebind: true,
          updateRecord: false
        });
        staged.push({ assistant, entry: installed.entry, verify: installed.verify, rollback: installed.rollback });
      }
      return staged;
    } catch (error) {
      await this.rollbackAssistantBindings(staged);
      throw error;
    }
  }

  async rollbackAssistantBindings(staged) {
    for (const change of [...staged].reverse()) await change.rollback?.().catch(() => {});
  }

  async ensureRuntime() {
    if (!await isComplete(this.paths.payload)) throw errorDetails("runtime_repair_required");
    const expectedManifestSha256 = this.trustedMcpRuntimeManifestSha256();
    if (!expectedManifestSha256) throw errorDetails("runtime_repair_required");
    const expectedNodeSha256 = this.trustedMcpRuntimeNodeSha256();
    if (!expectedNodeSha256) throw errorDetails("runtime_repair_required");
    if (!this.mcpRuntimeVerification) {
      this.mcpRuntimeVerification = verifyMcpRuntime(this.paths.payload, expectedManifestSha256, expectedNodeSha256)
        .then((binding) => {
          if (!binding) throw errorDetails("runtime_repair_required");
          return binding;
        });
    }
    try { await this.mcpRuntimeVerification; }
    catch (error) {
      this.mcpRuntimeVerification = null;
      throw error;
    }
    await mkdirPrivate(this.paths.state);
    // State holds the journal, the upstreams, and the backups. POSIX proves it
    // with the mode mkdirPrivate set; Windows ignores that mode, so the same
    // gateway module the Blackboard credentials use replaces the directory's
    // access list with this account, SYSTEM, and Administrators. A directory
    // that cannot be proven private asks for repair instead of serving reads.
    if (this.platform === "win32") {
      const gatewayCore = await this.gatewayCoreModule();
      if (typeof gatewayCore.hardenPrivateDirectory !== "function"
        || typeof gatewayCore.privateDirectoryAccessAccepted !== "function") throw errorDetails("runtime_repair_required");
      if (gatewayCore.hardenPrivateDirectory(this.paths.state, { trustedRoot: this.paths.userData }) !== true
        || gatewayCore.privateDirectoryAccessAccepted(this.paths.state, { trustedRoot: this.paths.userData }) !== true) {
        throw errorDetails("runtime_repair_required");
      }
    } else {
      const info = await fs.lstat(this.paths.state);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw errorDetails("runtime_repair_required");
    }
    return this.paths;
  }

  async canonicalStateDirectory() {
    await mkdirPrivate(this.paths.state);
    return canonicalDirectory(this.paths.state);
  }

  bridgeReleaseOptions() {
    const trustedReleaseManifestSha256 = this.trustedBridgeReleaseManifestSha256();
    if (!trustedReleaseManifestSha256) throw errorDetails("runtime_repair_required");
    return {
      sourceDirectory: this.paths.bridgeReleaseDirectory,
      releaseManifestPath: this.paths.bridgeReleaseManifest,
      trustedReleaseManifestSha256,
      expectedExtensionId: BRIDGE_EXTENSION_ID,
      stateDirectory: this.paths.state,
      bridgeDirectory: this.paths.bridgeDirectory
    };
  }

  bridgeChallenge() {
    return {
      challengeId: `morrow-${crypto.randomUUID().replaceAll("-", "")}`,
      nonce: crypto.randomBytes(32).toString("base64url")
    };
  }

  async readBridgeInstallation() {
    try {
      const status = await bridgeInstallationStatus({
        stateDirectory: this.paths.state,
        bridgeDirectory: this.paths.bridgeDirectory,
        expectedExtensionId: BRIDGE_EXTENSION_ID
      });
      this.bridgeInstallation = status;
      this.bridgeVerificationFailed = false;
      return status;
    } catch (error) {
      this.bridgeVerificationFailed = true;
      throw error;
    }
  }

  async initializeBridgeAtStartup() {
    if (this.bridgeInitialization) return this.bridgeInitialization;
    this.bridgeStartupAttempted = true;
    const pending = this.runBridgeInitialization();
    this.bridgeInitialization = pending;
    try {
      return await pending;
    } catch (error) {
      if (this.bridgeInitialization === pending) this.bridgeInitialization = null;
      throw error;
    }
  }

  async runBridgeInitialization() {
    await this.ensureRuntime();
    await this.reconcileClaudeDesktopGenerationsAtStartup();
    let status = await this.readBridgeInstallation();
    const writeRequired = !status.installed || !status.activeFolderChallenge;
    const writeBridge = async () => {
      if (!status.installed) {
        await initializeBridgeDirectory({ ...this.bridgeReleaseOptions(), initialChallenge: this.bridgeChallenge() });
        status = await this.readBridgeInstallation();
      }
      if (!status.activeFolderChallenge) {
        await issueBridgeActiveFolderChallenge({
          stateDirectory: this.paths.state,
          bridgeDirectory: this.paths.bridgeDirectory,
          expectedExtensionId: BRIDGE_EXTENSION_ID,
          challenge: this.bridgeChallenge()
        });
        status = await this.readBridgeInstallation();
      }
      return status;
    };
    if (writeRequired) {
      status = await this.withDesktopMutation(async (transaction) => {
        await transaction.stopRuntime();
        return writeBridge();
      });
    }
    // Rollback copies an interrupted update left behind. A failed prune must
    // not block startup; the next start repeats it.
    await pruneBridgeRollbackCopies({ stateDirectory: this.paths.state }).catch(() => undefined);
    return status;
  }

  async verifiedBridgeInstallation() {
    const status = await this.readBridgeInstallation();
    if (!status.installed) throw errorDetails("runtime_repair_required");
    return status;
  }

  async packagedBridgeRelease() {
    return readReleaseManifest(this.bridgeReleaseOptions());
  }

  async bridgeReleaseUpdateAvailable(record) {
    if (this.bridgeDelivery !== "developer_temporary" || record?.installed !== true || record.manualChromeReloadRequired === true) return false;
    try {
      const release = await this.packagedBridgeRelease();
      const installedVersion = parseChromeVersion(record.version);
      const releaseVersion = parseChromeVersion(release.version);
      if (!installedVersion || !releaseVersion) return false;
      const comparison = compareChromeVersions(releaseVersion, installedVersion);
      return comparison > 0;
    } catch {
      return false;
    }
  }

  async bridgeMonitor() {
    const materials = await this.effectiveWorkspace();
    const runtime = await this.runtimeSnapshot(materials);
    if (runtime.health.gatewayReady !== true || !this.runtimeMonitor) {
      throw new Error("Morrow Bridge maintenance is unavailable");
    }
    return this.runtimeMonitor;
  }

  async currentBridgeStatus(record, monitor) {
    const status = await monitor.bridgeMaintenance({ action: "status" });
    if (status?.extensionId !== BRIDGE_EXTENSION_ID) throw new Error("Morrow Bridge identity is unconfirmed");
    if (status.installType === "normal") return status;
    if (status.installType !== "development" || !sameBridgeChallenge(record, status)) {
      throw new Error("Morrow Bridge active folder is unconfirmed");
    }
    return status;
  }

  async acquireBridgeLease(monitor) {
    if (this.bridgeLeaseId) {
      if (this.restartLeases.get(this.bridgeLeaseId) !== monitor) throw new Error("Morrow Bridge maintenance lease changed");
      return this.bridgeLeaseId;
    }
    const lease = await this.acquireRestartLease();
    if (lease?.status !== "granted" || typeof lease.leaseId !== "string" || this.restartLeases.get(lease.leaseId) !== monitor) {
      throw errorDetails(restartRefusalCode(lease?.reason));
    }
    this.bridgeLeaseId = lease.leaseId;
    return lease.leaseId;
  }

  async releaseBridgeLease() {
    const leaseId = this.bridgeLeaseId;
    if (!leaseId) return;
    await this.releaseRestartLease(leaseId);
    this.bridgeLeaseId = null;
  }

  async completePendingBridgeUpdate(record, monitor) {
    return completeBridgeUpdate({
      acquire: async () => this.acquireBridgeLease(monitor),
      readback: async () => monitor.bridgeMaintenance({ action: "readback" }),
      matchesChallenge: (readback) => sameBridgeChallenge(record, readback),
      inspect: async (readback) => inspectPendingBridgeUpdate({
        stateDirectory: this.paths.state,
        bridgeDirectory: this.paths.bridgeDirectory,
        expectedExtensionId: BRIDGE_EXTENSION_ID,
        extensionReadback: readback
      }),
      commit: async (pending) => {
        const result = await monitor.bridgeMaintenance({
          action: "commit",
          previousManifestVersion: pending.previousVersion,
          quiesceEpoch: pending.quiesceEpoch
        });
        if (result?.schema !== "morrow.bridge.update-committed.v1"
          || result.extensionId !== pending.extensionId
          || result.previousManifestVersion !== pending.previousVersion
          || result.manifestVersion !== pending.version
          || result.quiesceEpoch !== pending.quiesceEpoch
          || result.committed !== true) throw new Error("Morrow Bridge update commit is unconfirmed");
      },
      confirm: async (readback) => confirmBridgeUpdate({
        stateDirectory: this.paths.state,
        bridgeDirectory: this.paths.bridgeDirectory,
        expectedExtensionId: BRIDGE_EXTENSION_ID,
        extensionReadback: readback
      }),
      refresh: async () => this.readBridgeInstallation(),
      release: async () => this.releaseBridgeLease()
    });
  }

  async stageBridgeUpdate(record, release, monitor) {
    let quiesceEpoch = null;
    const staged = await stageBridgeSwap({
      acquire: async () => this.acquireBridgeLease(monitor),
      prepare: async ({ requestQuiescence, resumeQuiescence }) => prepareBridgeUpdate({
        ...this.bridgeReleaseOptions(),
        nextChallenge: this.bridgeChallenge(),
        requestQuiescence,
        resumeQuiescence
      }),
      requestQuiescence: async ({ extensionId, manifestVersion }) => {
        const result = await monitor.bridgeMaintenance({ action: "quiesce" });
        if (result.extensionId !== extensionId || result.manifestVersion !== manifestVersion) {
          throw new Error("Morrow Bridge quiescence is unconfirmed");
        }
        quiesceEpoch = result.quiesceEpoch;
        return result;
      },
      resumeQuiescence: async ({ quiesceEpoch: epoch }) => monitor.bridgeMaintenance({ action: "resume", quiesceEpoch: epoch, fileLayerRestored: true }),
      refresh: async () => this.readBridgeInstallation(),
      release: async () => this.releaseBridgeLease()
    });
    return quiesceEpoch ? this.reloadStagedBridge(staged, monitor, quiesceEpoch, release.version) : staged;
  }

  /**
   * Asks the fenced Bridge to reload itself into the staged folder, waits for Chrome to start the
   * new version, and finishes the update. A Bridge from before this control cannot reload itself,
   * and a reload Chrome does not finish in time leaves the staged update for the person to reload.
   * Either way the staged update, its lease, and its rollback stay exactly as staging left them.
   */
  async reloadStagedBridge(staged, monitor, quiesceEpoch, version, { waitMs = BRIDGE_RELOAD_WAIT_MS, pollMs = BRIDGE_RELOAD_POLL_MS } = {}) {
    try {
      const scheduled = await monitor.bridgeMaintenance({ action: "reload", quiesceEpoch });
      if (scheduled?.nextManifestVersion !== version) return staged;
    } catch {
      return staged;
    }
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      const status = await monitor.bridgeMaintenance({ action: "status" }).catch(() => null);
      if (status?.manifestVersion === version) return this.completePendingBridgeUpdate(staged, monitor);
    }
    return staged;
  }

  async reconcileBridgeRelease() {
    if (this.bridgeReconciliation) return this.bridgeReconciliation;
    const refused = this.maintenanceAdmission({ pendingBridgeUpdate: true });
    if (refused) throw errorDetails(refused);
    const pending = (async () => {
      const record = await this.verifiedBridgeInstallation();
      if (!record.manualChromeReloadRequired && this.bridgeLeaseId !== null) {
        throw errorDetails("active_or_uncertain_operations");
      }
      const release = await this.packagedBridgeRelease();
      const installedVersion = parseChromeVersion(record.version);
      const releaseVersion = parseChromeVersion(release.version);
      if (!installedVersion || !releaseVersion) throw new Error("Morrow Bridge release is invalid");
      const comparison = compareChromeVersions(releaseVersion, installedVersion);
      const monitor = await this.bridgeMonitor();
      if (record.manualChromeReloadRequired) return this.completePendingBridgeUpdate(record, monitor);
      if (comparison <= 0) return record;
      if (reportedBridgeConnection(monitor) === false) return this.replaceUnconnectedBridge();
      try {
        const status = await this.currentBridgeStatus(record, monitor);
        if (status.installType !== "development") return record;
        return await this.stageBridgeUpdate(record, release, monitor);
      } catch (error) {
        throw bridgeUpdateRefusal(error);
      }
    })();
    this.bridgeReconciliation = pending;
    try {
      return await pending;
    } finally {
      if (this.bridgeReconciliation === pending) this.bridgeReconciliation = null;
    }
  }

  /**
   * Replaces an older app-owned Bridge folder with the sealed release while the
   * runtime reports no Bridge connected: Chrome has not loaded the folder, or
   * Chrome is closed. No Bridge runs these files for Morrow, so there is nothing
   * to pause or reload, and this is the replacement Repair makes. The new folder
   * carries a new active-folder challenge, so a Chrome that loads it proves
   * again which folder it loaded. It holds the runtime's maintenance lease, so
   * it is refused while an assistant or an approved change is using Morrow.
   */
  async replaceUnconnectedBridge() {
    return this.withDesktopMutation(async () => {
      await this.discardUnusableBridgeInstallation();
      this.bridgeInitialization = null;
      this.bridgeInstallation = null;
      await initializeBridgeDirectory({ ...this.bridgeReleaseOptions(), initialChallenge: this.bridgeChallenge() });
      return this.verifiedBridgeInstallation();
    }, { fromBridgeReconciliation: true });
  }

  async ensureBridgeDirectory() {
    await this.ensureRuntime();
    return this.initializeBridgeAtStartup();
  }

  childEnvironment() {
    const environment = { ...process.env };
    if (this.testRoot) {
      environment.HOME = this.home;
      environment.USERPROFILE = this.home;
    }
    return environment;
  }

  async executeCli(argumentsValue) {
    const result = await this.runCli(this.paths.node, [this.paths.cli, ...argumentsValue], {
      cwd: this.paths.appRoot,
      env: this.childEnvironment()
    });
    if (result.code !== 0) {
      const refusal = clientConfigRefusal(result.stderr);
      if (refusal) throw refusal;
      if (/Refusing to replace (?:existing Morrow (?:server|configuration)|.+ because it changed (?:after Morrow recorded it|during installation))/i.test(result.stderr)) {
        throw errorDetails("existing_morrow_configuration");
      }
      throw errorDetails("setup_failed");
    }
  }

  async installAssistant(assistantId, parent) {
    const refused = this.locationAdmission() || this.maintenanceAdmission();
    if (refused) throw errorDetails(refused);
    const assistant = ASSISTANTS.find((candidate) => candidate.id === assistantId);
    // Setting up an assistant is an explicit step, so it reads this computer
    // again rather than trusting a cached answer from up to a minute ago.
    if (!assistant || !(await this.freshlyDetectedAssistant(assistant))) throw errorDetails("assistant_not_found");
    if (!assistant.supported) throw errorDetails("setup_failed");
    let project = null;
    if (assistant.needsProject) {
      const chosen = await this.dialog.showOpenDialog(parent, {
        title: `Choose the ${assistant.title} project`,
        buttonLabel: "Use this project",
        properties: ["openDirectory", "dontAddToRecent"]
      });
      if (chosen.canceled || chosen.filePaths.length !== 1) throw errorDetails("cancelled");
      project = await canonicalDirectory(chosen.filePaths[0]);
    }
    const setup = await this.withDesktopMutation(async (transaction) => {
      const record = await this.record();
      const materials = await this.workspaceForAssistantSetup(record);
      if (!materials) throw errorDetails("workspace_required");
      if (await this.workspaceRefusedByRuntime(materials)) throw errorDetails("materials_folder_too_broad");
      await transaction.stopRuntime();
      try {
        await this.ensureRuntime();
        await this.executeCli([
          "setup", "--repository", this.paths.appRoot, "--upstreams", this.paths.upstreams, "--node", this.paths.node,
          "--state-directory", this.paths.state, "--replace-generated", "--json"
        ]);
      } catch (error) {
        if (error.code) throw error;
        throw errorDetails("runtime_repair_required");
      }

      if (assistant.id === "claude-desktop") {
        let prepared;
        try {
          const generation = await this.prepareClaudeGeneration(materials);
          prepared = generation.setup;
          const { entry } = generation;
          const updated = {
            ...record,
            selectedAssistantId: assistant.id,
            configured: {
              ...(record.configured || {}),
              [assistant.id]: entry,
            }
          };
          await this.commitClaudeGeneration(record, updated, entry);
        } catch (error) {
          if (error.code) throw error;
          throw errorDetails("setup_failed");
        }
        return prepared;
      }

      const target = clientConfigTarget(assistant, this.home, project);
      if (!target) throw errorDetails("setup_failed");
      await this.installClientConfiguration(assistant, target, project, materials);
      await this.forgetAssistantConnection(assistant.id);
      return null;
    });

    if (setup) {
      try {
        if (this.platform === "win32") {
          await this.shell.openExternal("claude://");
        } else {
          const openError = await this.shell.openPath(setup.bundlePath);
          if (openError) throw new Error("Claude Desktop did not open the Morrow bundle");
        }
      } catch (error) {
        if (error.code) throw error;
        throw errorDetails("setup_failed");
      }
    }
  }

  /**
   * Writes the Morrow entry into one assistant configuration file. The file is
   * copied first. Morrow's own entry is found by what it is, so an assistant
   * that rewrote the rest of its file since does not stop the write. A
   * first-time rollback removes only Morrow from the exact generation the
   * client accepted; a rebind restores its copy only while the file on disk is
   * still exactly what Morrow wrote.
   */
  async installClientConfiguration(assistant, target, project, materials, options = {}) {
    const backup = await captureConfiguration(target, this.paths.assistantBackups);
    let installedConfigurationSha256 = null;
    const rollback = async () => {
      if (!installedConfigurationSha256) return false;
      if (options.rebind !== true) {
        const current = await readConfigurationFile(target);
        if (current === null || fileHash(current) !== installedConfigurationSha256) return false;
        const previous = await this.configurationWithoutMorrow(assistant, current.toString("utf8"), target);
        if (previous === null) return false;
        await this.writeAssistantConfiguration(target, previous, installedConfigurationSha256);
        return true;
      }
      if (!backup.present || !backup.backup) return false;
      const previous = await readConfigurationFile(backup.backup);
      if (previous === null) return false;
      await this.writeAssistantConfiguration(target, previous, installedConfigurationSha256);
      return true;
    };
    try {
      const argumentsValue = [
        "mcp", "install", assistant.id === "claude-code" ? "claude" : assistant.id === "gemini-cli" ? "gemini" : assistant.id,
        "--scope", assistant.needsProject ? "project" : "user",
        "--repository", this.paths.appRoot,
        "--upstreams", this.paths.upstreams,
        "--node", this.paths.node,
        "--server-entry", this.paths.server,
        "--workspace-root", materials
      ];
      if (project) argumentsValue.push("--client-project", project);
      argumentsValue.push("--replace-morrow-entry", "--json");
      await this.executeCli(argumentsValue);
      const content = await readConfigurationFile(target);
      if (!content) throw errorDetails("assistant_configuration_changed");
      installedConfigurationSha256 = fileHash(content);
      const entry = { target, sha256: installedConfigurationSha256 };
      if (options.updateRecord !== false) {
        const updated = await this.record();
        await this.writeRecord({
          ...updated,
          selectedAssistantId: options.keepSelection === true ? updated.selectedAssistantId ?? assistant.id : assistant.id,
          configured: { ...(updated.configured || {}), [assistant.id]: entry }
        });
      }
      return {
        entry,
        verify: async () => {
          const currentSha256 = await fs.readFile(target).then(fileHash, () => null);
          if (currentSha256 !== installedConfigurationSha256) throw errorDetails("assistant_configuration_changed");
        },
        rollback
      };
    } catch (error) {
      if (installedConfigurationSha256) await rollback().catch(() => {});
      if (error.code) throw error;
      throw errorDetails("setup_failed");
    }
  }

  /**
   * One assistant configuration file without Morrow's own entry, found by its
   * marker, with the rest of the file kept as it is. `null` when the file holds
   * no Morrow entry. A `morrow` entry Morrow did not write is refused.
   */
  async configurationWithoutMorrow(assistant, content, target = null) {
    const module = await this.clientConfigModule().catch(() => { throw errorDetails("setup_failed"); });
    const remove = assistant.id === "codex" ? module.withoutMorrowCodexTable : module.withoutMorrowClientJson;
    if (typeof remove !== "function") throw errorDetails("setup_failed");
    const options = { requireMorrowEntry: true };
    try {
      return assistant.id === "codex"
        ? remove(content, MORROW_SERVER_NAME, options)
        : remove(content, "mcpServers", MORROW_SERVER_NAME, options);
    } catch (error) {
      if (error?.code === "config_entry_not_morrow") throw errorDetails("assistant_configuration_changed", target);
      if (error?.code === "config_invalid") throw errorDetails("assistant_config_invalid", target);
      throw errorDetails("setup_failed");
    }
  }

  async confirmAssistantConfigurationRemoved(assistant, target, expectedSha256) {
    const written = await readConfigurationFile(target);
    if (written === null || fileHash(written) !== expectedSha256) throw errorDetails("setup_failed");
    if (await this.configurationWithoutMorrow(assistant, written.toString("utf8"), target) !== null) {
      throw errorDetails("setup_failed");
    }
  }

  /**
   * Removes Morrow's own entry from one assistant configuration file and keeps
   * the rest of that file as it is, including edits made after Morrow wrote it.
   * The write is refused when the file changes while Morrow writes it. The
   * file is read again afterwards: the removal is proven by what that file
   * says, not by the write call.
   */
  async removeClientConfiguration(assistant, entry, recordBefore, recordAfter) {
    const target = entry?.target;
    if (typeof target !== "string" || !path.isAbsolute(target) || typeof entry.sha256 !== "string") throw errorDetails("setup_failed");
    const content = await readConfigurationFile(target);
    // The file is gone, so no Morrow entry of this installation is in it. A
    // file Morrow cannot read whole is left exactly as it is and reported.
    if (content === null) {
      if (!await exists(target)) return null;
      throw errorDetails("assistant_config_unreadable", target);
    }
    // The assistant may have rewritten the rest of its file since Morrow wrote
    // it. Morrow's entry is found by what it is, and this exact generation is
    // what the replacement below admits.
    const beforeSha256 = fileHash(content);
    const info = await fs.lstat(target).catch(() => null);
    if (info && (info.mode & 0o200) === 0) throw errorDetails("assistant_config_read_only", target);
    const next = await this.configurationWithoutMorrow(assistant, content.toString("utf8"), target);
    if (next === null) return null;
    const afterSha256 = fileHash(Buffer.from(next, "utf8"));
    const tombstone = await this.writeAssistantRemovalTombstone({
      schema: ASSISTANT_REMOVAL_SCHEMA,
      operationId: crypto.randomUUID(),
      assistantId: assistant.id,
      target,
      beforeSha256,
      afterSha256,
      recordBeforeSha256: installerRecordDigest(recordBefore, this.home),
      recordAfterSha256: installerRecordDigest(recordAfter, this.home),
    });
    try {
      await this.writeAssistantConfiguration(target, next, beforeSha256);
      await this.confirmAssistantConfigurationRemoved(assistant, target, afterSha256);
    } catch (error) {
      // The recovery record is for a process that ends mid-removal. While the
      // file still holds Morrow's entry, the removal did not happen and the
      // record was never changed, so nothing is left for Repair to finish.
      if (await this.morrowEntryRemains(assistant, target) === true) {
        await this.clearAssistantRemovalTombstone(tombstone).catch(() => {});
      }
      throw error;
    }
    return tombstone;
  }

  /**
   * Whether one assistant settings file still holds Morrow's own entry, from
   * what the file says now: true or false, or null when Morrow cannot tell.
   * A file that is gone holds no entry.
   */
  async morrowEntryRemains(assistant, target) {
    try {
      const content = await readConfigurationFile(target);
      if (content === null) return await fs.lstat(target).then(() => null, () => false);
      return await this.configurationWithoutMorrow(assistant, content.toString("utf8"), target) !== null;
    } catch {
      return null;
    }
  }

  async assistantConfigurationGeneration(target, expectedSha256) {
    const before = await fs.lstat(target).catch(() => null);
    if (!before?.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || before.size > ASSISTANT_CONFIG_READ_LIMIT) return null;
    const content = await fs.readFile(target).catch(() => null);
    if (content === null || fileHash(content) !== expectedSha256) return null;
    const after = await fs.lstat(target).catch(() => null);
    if (!after?.isFile() || after.isSymbolicLink() || after.nlink !== 1
      || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.mode !== after.mode || before.uid !== after.uid || before.gid !== after.gid) return null;
    return { identity: after, content };
  }

  async restoreDisplacedAssistantConfiguration(displaced, target, identity) {
    try {
      await fs.link(displaced, target);
    } catch (error) {
      if (error?.code === "EEXIST") return false;
      throw error;
    }
    const restored = await fs.lstat(target).catch(() => null);
    if (!restored || restored.dev !== identity.dev || restored.ino !== identity.ino) return false;
    await fs.unlink(displaced);
    return true;
  }

  /**
   * Replaces one exact assistant configuration generation without ever
   * overwriting its pathname. The admitted generation is first displaced and
   * reverified. Publication then uses an exclusive hard link, so a concurrent
   * pathname replacement wins and remains untouched.
   */
  async writeAssistantConfiguration(target, content, expectedSha256) {
    const operationId = crypto.randomUUID();
    const temporary = `${target}.tmp-${operationId}`;
    const displaced = `${target}.morrow-displaced-${operationId}`;
    let moved = null;
    let published = false;
    try {
      await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      // The file keeps the mode its owner gave it; other accounts never gain write access.
      const current = await fs.lstat(target).catch(() => null);
      if (this.platform !== "win32" && current?.isFile()) await fs.chmod(temporary, current.mode & 0o755);
      // The file this replaces was restricted to this Windows account when it
      // was written. The replacement carries the person's other configuration
      // entries, so it is restricted the same way before publication, by the
      // same module that restricts every other client configuration write. A
      // restriction that cannot be applied refuses the write, so the file is
      // never published with a copy other accounts could read.
      if (this.platform === "win32") await this.restrictFileToThisAccount(temporary);
      const preparedSha256 = fileHash(Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"));
      const prepared = await this.assistantConfigurationGeneration(temporary, preparedSha256);
      const admitted = await this.assistantConfigurationGeneration(target, expectedSha256);
      if (!prepared || !admitted) throw errorDetails("assistant_configuration_changed");

      await fs.rename(target, displaced);
      const displacedIdentity = await fs.lstat(displaced).catch(() => null);
      if (displacedIdentity?.isFile() && !displacedIdentity.isSymbolicLink() && displacedIdentity.nlink === 1) {
        moved = { identity: displacedIdentity };
      }
      const movedGeneration = await this.assistantConfigurationGeneration(displaced, expectedSha256);
      if (!moved || !movedGeneration
        || moved.identity.dev !== admitted.identity.dev || moved.identity.ino !== admitted.identity.ino) {
        if (moved && await this.restoreDisplacedAssistantConfiguration(displaced, target, moved.identity).catch(() => false)) {
          moved = null;
        }
        throw errorDetails("assistant_configuration_changed");
      }
      moved = movedGeneration;

      try {
        await fs.link(temporary, target);
      } catch (error) {
        if (error?.code === "EEXIST") throw errorDetails("assistant_configuration_changed");
        throw error;
      }
      published = true;
      await fs.unlink(temporary);
      const installed = await this.assistantConfigurationGeneration(target, preparedSha256);
      const retained = await this.assistantConfigurationGeneration(displaced, expectedSha256);
      if (!installed || installed.identity.dev !== prepared.identity.dev || installed.identity.ino !== prepared.identity.ino
        || !retained || retained.identity.dev !== moved.identity.dev || retained.identity.ino !== moved.identity.ino) {
        throw errorDetails("assistant_configuration_changed");
      }
      await fs.unlink(displaced);
      moved = null;
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
      if (moved && !published) {
        await this.restoreDisplacedAssistantConfiguration(displaced, target, moved.identity).catch(() => false);
      }
    }
  }

  async restrictFileToThisAccount(file) {
    const module = await this.clientConfigModule();
    if (typeof module.restrictToCurrentAccount !== "function") throw errorDetails("setup_failed");
    module.restrictToCurrentAccount(file);
  }

  async clientConfigModule() {
    return import(pathToFileURL(path.join(this.paths.appRoot, "packages", "client-config", "dist", "index.js")).href);
  }

  async recoverAssistantRemoval(record, pending = undefined) {
    const tombstone = pending === undefined ? await this.readAssistantRemovalTombstone() : pending;
    if (!tombstone) return record;
    const assistant = ASSISTANTS.find((candidate) => candidate.id === tombstone.assistantId);
    if (!assistant || assistant.id === "claude-desktop") throw new Error("assistant_removal_recovery_required");

    const recordSha256 = installerRecordDigest(record, this.home);
    // The record is committed only after the file was read back without
    // Morrow's entry. Whatever the assistant wrote into its file since is its own.
    if (recordSha256 === tombstone.recordAfterSha256) {
      await this.clearAssistantRemovalTombstone(tombstone);
      return record;
    }
    if (recordSha256 !== tombstone.recordBeforeSha256) {
      throw new Error("assistant_removal_recovery_required");
    }

    const entry = record.configured?.[assistant.id];
    if (!entry || entry.target !== tombstone.target) {
      throw new Error("assistant_removal_recovery_required");
    }
    const recordAfter = recordWithoutAssistant(record, assistant.id);
    if (installerRecordDigest(recordAfter, this.home) !== tombstone.recordAfterSha256) {
      throw new Error("assistant_removal_recovery_required");
    }

    // The assistant may have rewritten its file since the removal began, so
    // what the file says now decides, not the digests the removal recorded.
    let remains = await this.morrowEntryRemains(assistant, tombstone.target);
    if (remains === true) {
      try {
        const current = await readConfigurationFile(tombstone.target);
        const next = current === null ? null
          : await this.configurationWithoutMorrow(assistant, current.toString("utf8"), tombstone.target);
        if (next !== null) {
          await this.writeAssistantConfiguration(tombstone.target, next, fileHash(current));
          await this.confirmAssistantConfigurationRemoved(assistant, tombstone.target, fileHash(Buffer.from(next, "utf8")));
        }
      } catch {}
      remains = await this.morrowEntryRemains(assistant, tombstone.target);
    }
    if (remains !== false) {
      // The removal did not happen. The assistant stays listed and can be removed again.
      await this.clearAssistantRemovalTombstone(tombstone);
      return record;
    }

    await this.writeRecord(recordAfter);
    const committed = await this.readInstallerRecord();
    if (installerRecordDigest(committed, this.home) !== tombstone.recordAfterSha256) {
      throw new Error("assistant_removal_recovery_required");
    }
    await this.clearAssistantRemovalTombstone(tombstone);
    return committed;
  }

  async claudeSetupDirectories(prefix = "setup-") {
    const setupRoot = path.join(await fs.realpath(this.paths.state), "ClaudeDesktop");
    const directory = await fs.opendir(setupRoot).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!directory) return [];
    const answer = [];
    try {
      for await (const entry of directory) {
        if (!entry.name.startsWith(prefix)) continue;
        if (answer.length >= CLAUDE_SETUP_ROOT_LIMIT) throw new Error("claude_generation_recovery_required");
        const candidate = path.join(setupRoot, entry.name);
        const info = await fs.lstat(candidate);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("claude_generation_recovery_required");
        answer.push(candidate);
      }
    } finally {
      await directory.close().catch(() => {});
    }
    return answer.sort();
  }

  async syncClaudeSetupDirectory() {
    if (process.platform === "win32") return;
    const setupRoot = path.join(await fs.realpath(this.paths.state), "ClaudeDesktop");
    const directory = await fs.open(setupRoot, fsConstants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async moveClaudeGenerationRoots(transition) {
    for (const move of transition.moves) {
      const source = await fs.lstat(move.source).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
      const destination = await fs.lstat(move.destination).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
      if (source && !destination) {
        if (!source.isDirectory() || source.isSymbolicLink()) throw new Error("claude_generation_recovery_required");
        await fs.rename(move.source, move.destination);
      } else if (source || !destination || !destination.isDirectory() || destination.isSymbolicLink()) {
        throw new Error("claude_generation_recovery_required");
      }
    }
    if (transition.moves.length > 0) await this.syncClaudeSetupDirectory();
  }

  async restoreClaudeGenerationRoots(transition) {
    for (const move of [...transition.moves].reverse()) {
      const source = await fs.lstat(move.source).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
      const destination = await fs.lstat(move.destination).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
      if (!source && destination) {
        if (!destination.isDirectory() || destination.isSymbolicLink()) throw new Error("claude_generation_recovery_required");
        await fs.rename(move.destination, move.source);
      } else if (!source || destination || !source.isDirectory() || source.isSymbolicLink()) {
        throw new Error("claude_generation_recovery_required");
      }
    }
    if (transition.moves.length > 0) await this.syncClaudeSetupDirectory();
  }

  async stageClaudeGenerationTransition(recordBefore, recordAfter, preparedEntry = null, preservedRoot = null) {
    const preparedRoot = preparedEntry ? path.dirname(preparedEntry.bundlePath) : null;
    const roots = (await this.claudeSetupDirectories())
      .filter((candidate) => candidate !== preparedRoot && candidate !== preservedRoot);
    if (roots.length === 0) return null;
    const operationId = crypto.randomUUID();
    const sameRecord = installerRecordDigest(recordBefore, this.home) === installerRecordDigest(recordAfter, this.home);
    const mode = preparedEntry ? "replace" : sameRecord ? "prune" : "remove";
    const transition = await this.writeClaudeGenerationTransition({
      schema: CLAUDE_GENERATION_TRANSITION_SCHEMA,
      operationId,
      mode,
      recordBeforeSha256: installerRecordDigest(recordBefore, this.home),
      recordAfterSha256: installerRecordDigest(recordAfter, this.home),
      preparedEntry,
      moves: roots.map((source, index) => ({
        source,
        destination: path.join(path.dirname(source), `.quarantine-${operationId}-${index}-${path.basename(source)}`),
      })),
    });
    try {
      await this.moveClaudeGenerationRoots(transition);
      return transition;
    } catch (error) {
      await this.recoverClaudeGenerationTransition(transition);
      throw error;
    }
  }

  async finishClaudeGenerationTransition(transition) {
    await this.moveClaudeGenerationRoots(transition);
    await this.clearClaudeGenerationTransition(transition);
    for (const move of transition.moves) {
      await this.removeClaudeDesktopSetup({ bundlePath: path.join(move.destination, "Morrow.mcpb") }).catch(() => {});
    }
  }

  async rollbackClaudeGenerationTransition(transition) {
    await this.restoreClaudeGenerationRoots(transition);
    if (transition.preparedEntry) await this.removeClaudeDesktopSetup(transition.preparedEntry);
    await this.clearClaudeGenerationTransition(transition);
  }

  async recoverClaudeGenerationTransition(pending = undefined) {
    const transition = pending === undefined ? await this.readClaudeGenerationTransition() : pending;
    if (!transition) return "none";
    const record = await this.readInstallerRecord();
    const currentSha256 = installerRecordDigest(record, this.home);
    if (transition.mode === "prune") {
      if (currentSha256 !== transition.recordBeforeSha256) throw new Error("claude_generation_recovery_required");
      await this.finishClaudeGenerationTransition(transition);
      return "committed";
    }
    if (currentSha256 === transition.recordAfterSha256) {
      await this.finishClaudeGenerationTransition(transition);
      return "committed";
    }
    if (currentSha256 !== transition.recordBeforeSha256) throw new Error("claude_generation_recovery_required");
    await this.rollbackClaudeGenerationTransition(transition);
    return "rolled_back";
  }

  async commitClaudeGeneration(recordBefore, recordAfter, preparedEntry = null) {
    let transition;
    try {
      transition = await this.stageClaudeGenerationTransition(recordBefore, recordAfter, preparedEntry);
    } catch (error) {
      if (preparedEntry) await this.removeClaudeDesktopSetup(preparedEntry).catch(() => {});
      throw error;
    }
    try {
      if (installerRecordDigest(recordBefore, this.home) !== installerRecordDigest(recordAfter, this.home)) {
        await this.writeRecord(recordAfter);
      }
    } catch (error) {
      if (!transition) {
        if (preparedEntry) await this.removeClaudeDesktopSetup(preparedEntry).catch(() => {});
        throw error;
      }
      const outcome = await this.recoverClaudeGenerationTransition(transition);
      if (outcome !== "committed") throw error;
      return;
    }
    if (transition) await this.finishClaudeGenerationTransition(transition);
  }

  async pruneClaudeGenerations(record, preservedEntry = null) {
    const preservedRoot = preservedEntry ? path.dirname(preservedEntry.bundlePath) : null;
    const transition = await this.stageClaudeGenerationTransition(record, record, null, preservedRoot);
    if (transition) await this.finishClaudeGenerationTransition(transition);
    for (const directory of await this.claudeSetupDirectories(".quarantine-")) {
      await this.removeClaudeDesktopSetup({ bundlePath: path.join(directory, "Morrow.mcpb") }).catch(() => {});
    }
  }

  async prepareClaudeGeneration(materials) {
    const setup = await prepareClaudeDesktopBundle({
      nodePath: this.paths.node,
      serverEntryPath: this.paths.server,
      upstreamsPath: this.paths.upstreams,
      workspaceRoot: materials,
      stateDirectory: this.paths.state,
      version: this.productVersion,
      platform: this.platform,
      homeDirectory: this.home,
    });
    return {
      setup,
      entry: { bundlePath: setup.bundlePath, installationId: setup.installationId, receiptPath: setup.receiptPath },
    };
  }

  async reconcileClaudeDesktopGenerationsAtStartup() {
    const pending = await this.readClaudeGenerationTransition();
    const roots = await this.claudeSetupDirectories();
    const quarantines = await this.claudeSetupDirectories(".quarantine-");
    if (!pending && roots.length === 0 && quarantines.length === 0) return;
    await this.withDesktopMutation(async (transaction) => {
      await transaction.stopRuntime();
      if (pending) await this.recoverClaudeGenerationTransition(pending);
      const record = await this.readInstallerRecord();
      const entry = record.configured?.["claude-desktop"];
      if (entry && await this.isCurrentClaudeDesktopSetup(entry, { platform: this.platform, homeDirectory: this.home })) {
        await this.pruneClaudeGenerations(record, entry);
        return;
      }
      if (!entry) {
        await this.pruneClaudeGenerations(record);
        return;
      }
      const materials = await this.effectiveWorkspace(record);
      let prepared = null;
      if (materials) {
        try { prepared = await this.prepareClaudeGeneration(materials); }
        catch { /* Revocation below is the fail-closed migration result. */ }
      }
      const updated = prepared
        ? { ...record, configured: { ...(record.configured || {}), "claude-desktop": prepared.entry } }
        : recordWithoutAssistant(record, "claude-desktop");
      await this.commitClaudeGeneration(record, updated, prepared?.entry || null);
    });
  }

  /**
   * Removes the Claude Desktop bundle Morrow generated and the connection
   * receipt beside it. Claude Desktop keeps its own copy of an extension it
   * installed, so this removes only what Morrow made, inside Morrow's own
   * State folder, and never reaches into Claude Desktop.
   */
  async removeClaudeDesktopSetup(entry) {
    const bundlePath = entry?.bundlePath;
    if (typeof bundlePath !== "string" || !path.isAbsolute(bundlePath)) return;
    const directory = path.dirname(bundlePath);
    const setupRoot = path.join(await fs.realpath(this.paths.state), "ClaudeDesktop");
    if (!insideDirectory(setupRoot, directory) || path.resolve(directory) === path.resolve(setupRoot)) throw errorDetails("setup_failed");
    await fs.rm(directory, { recursive: true, force: true });
    if (await fs.lstat(directory).then(() => true, () => false)) throw errorDetails("setup_failed");
  }

  /**
   * Generates the Claude Desktop bundle for a different materials folder. The
   * caller quarantines every older generation before it records the new one.
   * A failed record commit restores those roots and removes the new bundle.
   */
  async stageClaudeDesktopSetup(assistant, previousEntry, materials) {
    let setup;
    let entry;
    try {
      const generation = await this.prepareClaudeGeneration(materials);
      setup = generation.setup;
      entry = generation.entry;
    } catch (error) {
      if (error?.code) throw error;
      throw errorDetails("setup_failed");
    }
    let transition = null;
    return {
      assistant,
      entry,
      verify: async () => {
        const info = await fs.lstat(entry.bundlePath).catch(() => null);
        if (!info?.isFile() || info.isSymbolicLink()) throw errorDetails("setup_failed");
      },
      beforeRecordCommit: async (recordBefore, recordAfter) => {
        transition = await this.stageClaudeGenerationTransition(recordBefore, recordAfter, entry);
      },
      rollback: async () => {
        if (transition) await this.recoverClaudeGenerationTransition(transition);
        else await this.removeClaudeDesktopSetup(entry);
      },
      commit: async () => {
        if (transition) await this.recoverClaudeGenerationTransition(transition);
        else await this.removeClaudeDesktopSetup(previousEntry);
      }
    };
  }

  /**
   * Removes Morrow from one assistant and from this installation's record. It
   * removes only that assistant's entry, and it refuses while another operation
   * holds the runtime. Removing an assistant here does not remove Morrow from
   * inside that assistant's own interface, so the setup view says what is left
   * to do there.
   */
  async removeAssistant(assistantId) {
    const refused = this.maintenanceAdmission();
    if (refused) throw errorDetails(refused);
    const assistant = ASSISTANTS.find((candidate) => candidate.id === assistantId);
    if (!assistant) throw errorDetails("assistant_not_found");
    return this.withDesktopMutation(async (transaction) => {
      const record = await this.record();
      const entry = record.configured?.[assistant.id];
      if (!entry) return;
      const updated = recordWithoutAssistant(record, assistant.id);
      if (assistant.id === "claude-desktop") {
        await transaction.stopRuntime();
        await this.commitClaudeGeneration(record, updated);
        return;
      }
      const tombstone = await this.removeClientConfiguration(assistant, entry, record, updated);
      await this.writeRecord(updated);
      if (tombstone) await this.clearAssistantRemovalTombstone(tombstone);
    });
  }

  /**
   * The fence the update path uses, applied to repair and to the data removal.
   * Each of those stops the runtime and rewrites or removes files, so neither
   * may begin while another operation holds a restart lease, and neither may
   * interrupt work in flight that Morrow cannot confirm is safe to stop.
   */
  /**
   * Moves this Mac app into Applications. On success the app quits and opens
   * again from there, so this answers only when it could not move.
   */
  async moveToApplications() {
    if (this.appLocation() === "ok") return false;
    let moved = false;
    try { moved = await this.moveApplication() === true; } catch { moved = false; }
    if (!moved) throw errorDetails("app_location_move_failed");
    return true;
  }

  /** The refusal for a step that would write this copy's location somewhere lasting. */
  locationAdmission() {
    return this.appLocation() === "ok" ? null : "app_location_unsupported";
  }

  maintenanceAdmission({ pendingBridgeUpdate = false, fromBridgeReconciliation = false } = {}) {
    // A staged Bridge update keeps its own lease until Chrome reloads the Bridge. Finishing that
    // update is the one step that lease exists for, so it does not count as other work here.
    const ownBridgeLease = pendingBridgeUpdate && this.bridgeLeaseId !== null
      && this.restartLeases.size === 1 && this.restartLeases.has(this.bridgeLeaseId);
    if ((this.restartLeases.size !== 0 && !ownBridgeLease) || (this.bridgeLeaseId !== null && !ownBridgeLease)
      || this.dataRemovalInProgress !== null || this.dataRemovalGuard !== null
      || this.desktopMutationInProgress !== null || this.desktopMutationGuard !== null
      || (this.bridgeReconciliation !== null && !fromBridgeReconciliation)) return "active_or_uncertain_operations";
    return null;
  }

  /**
   * Repairs this installation in place, in a fixed order. Every step reports the
   * exact state it reached: repair stops at the first step whose result Morrow
   * cannot confirm and names that state, and it never reports a repair it did
   * not make. What repair could not restore stays visible in the state it
   * returns.
   *
   * This is exercised against a payload, an installer record, a Bridge folder,
   * and an assistant configuration file on disk. Repair after a damaged
   * packaged installation is unverified on both macOS and Windows.
   */
  async repair() {
    try {
      const misplaced = this.locationAdmission();
      if (misplaced) throw errorDetails(misplaced);
      const bridge = await this.readBridgeInstallation().catch(() => null);
      if (bridge?.manualChromeReloadRequired === true) return this.restorePreviousBridge();
      const record = await this.withDesktopMutation(async (transaction) => {
        await transaction.stopRuntime();
        return this.runRepair();
      });
      await this.runtimeSnapshot(await this.effectiveWorkspace(record)).catch(() => {});
      return await this.state();
    } catch (error) {
      throw reportedError(error);
    }
  }

  async restorePreviousBridge() {
    try {
      // Rolling the staged update back is the other end of the step the staging lease is held for,
      // and rollbackPendingBridgeInstallation reuses that same lease, so it is not other work here.
      const refused = this.maintenanceAdmission({ pendingBridgeUpdate: true });
      if (refused) throw errorDetails(refused);
      const installed = await this.readBridgeInstallation();
      if (installed?.manualChromeReloadRequired !== true) throw errorDetails("bridge_check_failed");
      // The Bridge lease is the exact live-worker and file-layer guard for this
      // transaction. Keep its local owner running so it can grant the lease,
      // resume the fenced worker, and prove that result.
      await this.rollbackPendingBridgeInstallation(installed);
      await this.runtimeSnapshot(await this.effectiveWorkspace()).catch(() => {});
      return await this.state();
    } catch (error) {
      throw reportedError(error);
    }
  }

  async runRepair() {
    // The payload lives in signed application resources and is never rewritten
    // here, so its file verification runs again from disk rather than reusing
    // the result of an earlier one.
    this.mcpRuntimeVerification = null;
    await this.ensureRuntime();
    const record = await this.repairInstallerRecord();
    await this.repairBridgeInstallation();
    await this.repairAssistantConfiguration(record);
    return record;
  }

  /**
   * Re-creates State and re-reads the installer record. A malformed record is
   * copied into State/Backups before a fresh record replaces it. A valid record
   * from another version is left exactly as it is until that version can read
   * or migrate it.
   */
  async repairInstallerRecord() {
    await this.ensureInstallerStateDirectory();
    const pending = await this.readAssistantRemovalTombstone();
    const claudePending = await this.readClaudeGenerationTransition();
    if (pending && claudePending) throw new Error("claude_generation_recovery_required");
    let current;
    try {
      current = await this.readInstallerRecord();
    } catch (error) {
      if (error?.message === "migration_required") throw errorDetails("installer_record_incompatible");
      if (pending || claudePending) throw error;
      await this.quarantineInstallerRecord();
      current = freshRecord();
      await this.writeRecord(current);
    }
    if (claudePending) {
      await this.recoverClaudeGenerationTransition(claudePending);
      current = await this.readInstallerRecord();
    }
    return this.recoverAssistantRemoval(current, pending);
  }

  /**
   * Rebuilds the app-owned Bridge folder from the sealed release when the
   * installed copy no longer matches its record or is older than the copy the
   * app ships. It re-issues the active-folder challenge so a Chrome that has
   * this folder loaded must prove that again. The folder holds only the sealed
   * release, so replacing it removes nothing a person put there.
   */
  async repairBridgeInstallation() {
    this.bridgeInitialization = null;
    this.bridgeInstallation = null;
    const installed = await this.readBridgeInstallation().catch(() => null);
    const packaged = await this.packagedBridgeRelease();
    const installedVersion = parseChromeVersion(installed?.version);
    const packagedVersion = parseChromeVersion(packaged.version);
    const packagedIsNewer = Boolean(installedVersion && packagedVersion
      && compareChromeVersions(packagedVersion, installedVersion) > 0);
    if (installed?.manualChromeReloadRequired === true) {
      return this.rollbackPendingBridgeInstallation(installed);
    }
    if (installed?.installed !== true || packagedIsNewer) {
      await this.discardUnusableBridgeInstallation();
      return this.initializeBridgeAtStartup();
    }
    await this.initializeBridgeAtStartup();
    await issueBridgeActiveFolderChallenge({
      stateDirectory: this.paths.state,
      bridgeDirectory: this.paths.bridgeDirectory,
      expectedExtensionId: BRIDGE_EXTENSION_ID,
      challenge: this.bridgeChallenge()
    });
    return this.readBridgeInstallation();
  }

  async rollbackPendingBridgeInstallation(installed) {
    if (installed?.manualChromeReloadRequired !== true) throw errorDetails("bridge_check_failed");
    const monitor = await this.bridgeMonitor();
    await this.acquireBridgeLease(monitor);
    try {
      const restored = await rollbackPendingBridgeUpdate({
        stateDirectory: this.paths.state,
        bridgeDirectory: this.paths.bridgeDirectory,
        expectedExtensionId: BRIDGE_EXTENSION_ID
      });
      const resumed = await monitor.bridgeMaintenance({
        action: "resume",
        quiesceEpoch: restored.quiesceEpoch,
        fileLayerRestored: true
      });
      if (resumed?.resumed !== true || resumed.extensionId !== restored.extensionId
        || resumed.manifestVersion !== restored.version || resumed.quiesceEpoch !== restored.quiesceEpoch) {
        throw new Error("Morrow Bridge rollback resume is unconfirmed");
      }
    } finally {
      await this.releaseBridgeLease();
    }
    this.bridgeInitialization = null;
    this.bridgeInstallation = null;
    return this.readBridgeInstallation();
  }

  async discardUnusableBridgeInstallation() {
    const record = path.join(this.paths.state, "bridge-installation.json");
    if (await exists(record)) {
      await captureConfiguration(record, path.join(this.paths.state, "Backups"));
      await fs.rm(record, { force: true });
    }
    // A durable swap transaction converges against the record above. Leaving
    // one behind fails every later lock, so the discard takes both together.
    await discardBridgeTransactions({ stateDirectory: this.paths.state });
    const info = await fs.lstat(this.paths.bridgeDirectory).catch(() => null);
    if (info?.isDirectory() === true) await fs.rm(this.paths.bridgeDirectory, { recursive: true, force: true });
  }

  /**
   * Re-runs the local setup, then writes Morrow's entry again into every
   * assistant file this installation configured, so each one points at this
   * copy of Morrow and its materials folder, including after Morrow moved.
   * Morrow replaces only an entry that carries its own marker: a server of
   * that name someone else wrote is reported and left exactly as it is. A
   * Claude Code or Gemini CLI setup whose project folder is gone is skipped.
   * Claude Desktop is configured by an approval inside that application, so
   * repair leaves it to the person and does not open another application.
   */
  async repairAssistantConfiguration(record) {
    await this.executeCli([
      "setup", "--repository", this.paths.appRoot, "--upstreams", this.paths.upstreams, "--node", this.paths.node,
      "--state-directory", this.paths.state, "--replace-generated", "--json"
    ]);
    const configured = record?.configured && typeof record.configured === "object" ? record.configured : {};
    for (const assistant of ASSISTANTS) {
      const entry = configured[assistant.id];
      if (!entry || assistant.id === "claude-desktop") continue;
      const located = configuredProject(assistant, this.home, entry.target);
      if (!located) continue;
      // Setup names a project folder that is gone and offers Remove; the other assistants are still repaired.
      if (located.project && !await projectFolderPresent(located.project)) continue;
      const materials = await this.effectiveWorkspace(record);
      if (!materials) throw errorDetails("workspace_required");
      if (await this.workspaceRefusedByRuntime(materials)) throw errorDetails("materials_folder_too_broad");
      await this.installClientConfiguration(assistant, entry.target, located.project, materials, {
        rebind: await exists(entry.target),
        keepSelection: true
      });
    }
  }

  /**
   * Every place this installation keeps data, with the exact path of each one.
   * Removing the Morrow application removes the application only, so this is
   * what stays on this computer until a person removes it here.
   */
  /** The places this installation keeps data that are on this computer now. */
  async retention(record) {
    const configured = record?.configured && typeof record.configured === "object" && !Array.isArray(record.configured) ? record.configured : {};
    const assistantConfigurations = ASSISTANTS.flatMap((assistant) => {
      const target = configured[assistant.id]?.target;
      return typeof target === "string" && path.isAbsolute(target) ? [{ title: assistant.title, path: target }] : [];
    });
    const blackboard = blackboardPaths(this.home, "default");
    const materials = this.workspace || record?.materialsFolder || this.paths.defaultMaterials;
    const snapshot = retentionSnapshot({
      platform: this.platform,
      userData: this.paths.userData,
      state: this.paths.state,
      backups: this.paths.assistantBackups,
      windowData: this.paths.windowData,
      bridge: this.paths.bridgeDirectory,
      // The materials folder this installation uses, named without creating it.
      materials,
      previousMaterials: await this.earlierDefaultMaterials(materials),
      blackboardCredentials: blackboard.credentialDirectory,
      blackboardConfiguration: blackboard.config,
      assistantConfigurations,
      claudeDesktopExtension: await this.claudeDesktopExtensionFolder(),
      removal: this.dataRemoval
    });
    const present = await Promise.all(snapshot.locations.map((location) => fs.lstat(location.path).then(() => true, () => false)));
    return { ...snapshot, locations: snapshot.locations.filter((_location, index) => present[index]) };
  }

  /**
   * The default Materials folder that assistant setup made, when the person has
   * since chosen another folder, or null. It keeps whatever was put in it. A
   * default folder inside the chosen one belongs to the chosen folder.
   */
  async earlierDefaultMaterials(materials) {
    const fallback = this.paths.defaultMaterials;
    if (materials === fallback) return null;
    const earlier = await fs.realpath(fallback).catch(() => null);
    if (!earlier) return null;
    const inUse = await fs.realpath(materials).catch(() => path.resolve(materials));
    return insideDirectory(inUse, earlier) ? null : fallback;
  }

  /**
   * The folder where Claude Desktop keeps its own copy of the Morrow extension,
   * or null when Claude Desktop has none on this computer.
   */
  async claudeDesktopExtensionFolder() {
    try {
      const location = await resolveClaudeDesktopLauncher({ platform: this.platform, homeDirectory: this.home });
      if (!location) return null;
      const pathApi = this.platform === "win32" ? path.win32 : path.posix;
      return pathApi.dirname(pathApi.dirname(location.physical));
    } catch {
      return null;
    }
  }

  /**
   * Removes the Morrow data this installation owns. It runs only after an
   * explicit confirmation that names every path, it removes only the places
   * inside Morrow's own user-data folder, the Blackboard credential folder, and
   * the Blackboard configuration file, and it reports what is gone by reading each path again rather than from the
   * removal calls. It never removes an assistant's own configuration file.
   *
   * Removing the application itself is a step of this computer, not of Morrow.
   * No test here exercises that step.
   */
  async removeData(parent) {
    const refused = this.maintenanceAdmission();
    if (refused) throw errorDetails(refused);
    const pending = this.runDataRemoval(parent);
    this.dataRemovalInProgress = pending;
    try {
      return await pending;
    } finally {
      if (this.dataRemovalInProgress === pending) this.dataRemovalInProgress = null;
    }
  }

  async runDataRemoval(parent) {
    const record = await this.record();
    const retention = await this.retention(record);
    const bridgeLoaded = await this.bridgeLoadedInChrome(this.bridgeInstallation, this.runtimeMonitor?.snapshot?.() ?? null) === true;
    const removable = retention.locations.filter((location) => location.removable === true);
    const kept = retention.locations.filter((location) => location.removable !== true);
    const keptPaths = kept.map((location) => location.path);
    const entries = ASSISTANTS.flatMap((assistant) => {
      const target = record.configured?.[assistant.id]?.target;
      return assistant.id !== "claude-desktop" && typeof target === "string" ? [{ label: assistant.title, path: target }] : [];
    });
    const guard = await this.acquireDataRemovalGuard();
    this.dataRemovalGuard = guard;
    if (!await this.confirmDataRemoval(parent, removable, kept, entries, bridgeLoaded)) {
      await this.releaseDataRemovalGuard(guard);
      this.dataRemoval = { schema: DATA_REMOVAL_SCHEMA, status: "cancelled", removed: [], remaining: [], kept: keptPaths };
      return this.dataRemoval;
    }
    const stoppedGuard = await this.stopRuntimeForDataRemoval(guard);
    this.dataRemovalGuard = stoppedGuard;
    try {
      // An assistant keeps starting the Morrow its settings name, so Morrow's
      // entries go first. A removal that cannot take one out stops here, before
      // anything else is removed, and names that file.
      await this.removeAssistantEntriesForDataRemoval();
      // Blackboard's configuration names its secret files. Remove and confirm
      // that routing first. A route that remains keeps every credential, while
      // a credential that remains after route removal is inert and is reported
      // by the same fresh path readback below.
      await removeBlackboardData({ home: this.home });
      // State contains the durable maintenance guard. Removing it last keeps
      // every runtime start fenced throughout all earlier mutations.
      const blackboard = blackboardPaths(this.home, "default");
      // A place that holds one Morrow keeps is left where it is and reported as
      // still there, so removing it never deletes what the list says stays.
      const keptPlaces = (await Promise.all(keptPaths.map((kept) => this.pathForms(kept)))).flat();
      const holdsKept = async (location) => (await this.pathForms(location.path))
        .some((place) => keptPlaces.some((kept) => insideDirectory(place, kept)));
      const ordered = [];
      for (const location of removable) {
        if (location.path === blackboard.config || location.path === blackboard.credentialDirectory) continue;
        if (!await holdsKept(location)) ordered.push(location);
      }
      ordered.sort((left, right) => Number(left.path === this.paths.state) - Number(right.path === this.paths.state));
      for (const location of ordered) {
        // A path Morrow cannot remove must not stop the rest. The readback below
        // reports the result; this call does not.
        await fs.rm(location.path, { recursive: true, force: true }).catch(() => {});
      }
      const removed = [];
      const remaining = [];
      for (const location of removable) {
        const present = await fs.lstat(location.path).then(() => true, () => false);
        (present ? remaining : removed).push(location.path);
      }
      if (remaining.includes(this.paths.state)) await this.releaseDataRemovalGuard(stoppedGuard);
      else this.dataRemovalGuard = null;
      this.workspace = null;
      this.bridgeInstallation = null;
      this.bridgeInitialization = null;
      this.dataRemoval = {
        schema: DATA_REMOVAL_SCHEMA,
        status: remaining.length === 0 ? "removed" : "incomplete",
        removed,
        remaining,
        kept: keptPaths
      };
      return this.dataRemoval;
    } catch (error) {
      if (await fs.lstat(this.paths.state).then(() => true, () => false)) {
        await this.releaseDataRemovalGuard(stoppedGuard).catch(() => {});
      } else {
        this.dataRemovalGuard = null;
      }
      throw error;
    }
  }

  /**
   * Takes Morrow's entry out of every assistant settings file this installation
   * configured, and each assistant out of the record, one at a time. Claude
   * Desktop's extension lives in State and goes with it.
   */
  async removeAssistantEntriesForDataRemoval() {
    let record = await this.record();
    for (const assistant of ASSISTANTS) {
      const entry = record.configured?.[assistant.id];
      if (!entry || assistant.id === "claude-desktop") continue;
      const updated = recordWithoutAssistant(record, assistant.id);
      const tombstone = await this.removeClientConfiguration(assistant, entry, record, updated);
      await this.writeRecord(updated);
      if (tombstone) await this.clearAssistantRemovalTombstone(tombstone);
      record = updated;
    }
  }

  /** The existing folder whose runtime authority a desktop mutation must fence. */
  async desktopMutationWorkspace() {
    let record = null;
    try { record = await this.record(); } catch {}
    const candidate = this.workspace || record?.materialsFolder || this.paths.defaultMaterials;
    let materials = null;
    if (await exists(candidate)) {
      try { materials = await canonicalDirectory(candidate); } catch {}
    }
    return this.fencedWorkspace(materials);
  }

  /** Acquires authority from a live owner, or proves that no owner is running. */
  async acquireDesktopMutationGuard() {
    const workspaceRoot = await this.desktopMutationWorkspace();
    const stateDirectory = await this.canonicalStateDirectory();
    const journalPath = path.join(stateDirectory, "morrow.sqlite3");
    const module = await this.localOwnerMaintenanceModule();
    if (this.runtimeMonitor) {
      const active = await this.acquireRestartLease();
      if (active?.status !== "granted" || typeof active.leaseId !== "string") {
        throw errorDetails(restartRefusalCode(active?.reason));
      }
      const activeWorkspace = this.runtimeWorkspace ? await canonicalDirectory(this.runtimeWorkspace) : workspaceRoot;
      return { kind: "owner", leaseId: active.leaseId, journalPath, workspaceRoot: activeWorkspace, module };
    }
    const stopped = module.acquireStoppedLocalOwnerMaintenanceLease(journalPath, {
      holderPid: process.pid,
      workspaceRoot
    });
    if (stopped && typeof stopped.leaseId === "string" && typeof stopped.leaseToken === "string") {
      return { kind: "stopped", leaseId: stopped.leaseId, leaseToken: stopped.leaseToken, journalPath, workspaceRoot, module };
    }
    const active = await this.acquireRestartLease();
    if (active?.status !== "granted" || typeof active.leaseId !== "string") {
      throw errorDetails(restartRefusalCode(active?.reason));
    }
    const activeWorkspace = this.runtimeWorkspace ? await canonicalDirectory(this.runtimeWorkspace) : workspaceRoot;
    return { kind: "owner", leaseId: active.leaseId, journalPath, workspaceRoot: activeWorkspace, module };
  }

  /** Stops a live owner while preserving one unbroken durable maintenance guard. */
  async stopRuntimeForDesktopMutation(guard) {
    if (guard.kind === "stopped") return guard;
    await this.commitRestartLease(guard.leaseId);
    await this.closeRuntimeMonitor();
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const lease = guard.module.replaceDeadLocalOwnerMaintenanceLeaseWithStoppedGuard(guard.journalPath, {
        holderPid: process.pid,
        workspaceRoot: guard.workspaceRoot
      });
      if (lease && typeof lease.leaseId === "string" && typeof lease.leaseToken === "string") {
        return { ...guard, kind: "stopped", leaseId: lease.leaseId, leaseToken: lease.leaseToken };
      }
      await pause(50);
    }
    throw new Error("Morrow runtime shutdown did not finish");
  }

  async releaseDesktopMutationGuard(guard) {
    if (guard.kind === "owner") {
      await this.releaseRestartLease(guard.leaseId);
    } else if (guard.module.removeExactLocalOwnerMaintenanceLease(guard.journalPath, guard.leaseId, guard.leaseToken) !== true) {
      throw new Error("Morrow desktop maintenance release is unconfirmed");
    }
    if (this.desktopMutationGuard === guard) this.desktopMutationGuard = null;
  }

  /**
   * Serializes one file mutation under exact owner maintenance authority. A
   * Bridge reconciliation that makes the mutation itself passes
   * `fromBridgeReconciliation`, so its own marker does not refuse it. A step
   * that runs inside a mutation its own call chain already holds, as repair's
   * Bridge rebuild does, joins that mutation; any other caller is refused while
   * the guard is held.
   */
  async withDesktopMutation(action, { fromBridgeReconciliation = false } = {}) {
    const held = this.desktopMutationScope.getStore();
    if (held?.active === true) return action(held.transaction);
    const refused = this.maintenanceAdmission({ fromBridgeReconciliation });
    if (refused) throw errorDetails(refused);
    const pending = (async () => {
      let guard = await this.acquireDesktopMutationGuard();
      this.desktopMutationGuard = guard;
      const transaction = Object.freeze({
        stopRuntime: async () => {
          const stopped = await this.stopRuntimeForDesktopMutation(guard);
          guard = stopped;
          this.desktopMutationGuard = stopped;
        }
      });
      const scope = { active: true, transaction };
      try {
        return await this.desktopMutationScope.run(scope, () => action(transaction));
      } finally {
        scope.active = false;
        await this.releaseDesktopMutationGuard(guard);
      }
    })();
    this.desktopMutationInProgress = pending;
    try {
      return await pending;
    } finally {
      if (this.desktopMutationInProgress === pending) this.desktopMutationInProgress = null;
    }
  }

  async localOwnerMaintenanceModule() {
    await this.ensureRuntime();
    const module = await import(pathToFileURL(path.join(path.dirname(this.paths.server), "local-owner-maintenance.js")).href);
    if (typeof module.acquireStoppedLocalOwnerMaintenanceLease !== "function"
      || typeof module.replaceDeadLocalOwnerMaintenanceLeaseWithStoppedGuard !== "function"
      || typeof module.removeExactLocalOwnerMaintenanceLease !== "function") {
      throw errorDetails("runtime_repair_required");
    }
    return module;
  }

  async acquireDataRemovalGuard() {
    const record = await this.record();
    const workspaceRoot = await this.fencedWorkspace(await this.effectiveWorkspace(record));
    const stateDirectory = await this.canonicalStateDirectory();
    const journalPath = path.join(stateDirectory, "morrow.sqlite3");
    const module = await this.localOwnerMaintenanceModule();
    const active = await this.acquireRestartLease();
    if (active?.status === "granted" && typeof active.leaseId === "string") {
      return { kind: "owner", leaseId: active.leaseId, journalPath, workspaceRoot, module };
    }
    const lease = module.acquireStoppedLocalOwnerMaintenanceLease(journalPath, { holderPid: process.pid, workspaceRoot });
    if (!lease || typeof lease.leaseId !== "string" || typeof lease.leaseToken !== "string") {
      // A live owner that refused names the condition it holds; waiting never
      // ends an open assistant, so the person is told what to close instead.
      throw errorDetails(restartRefusalCode(active?.reason));
    }
    return { kind: "stopped", leaseId: lease.leaseId, leaseToken: lease.leaseToken, journalPath, workspaceRoot, module };
  }

  async releaseDataRemovalGuard(guard) {
    if (guard.kind === "owner") {
      await this.releaseRestartLease(guard.leaseId);
    } else if (guard.module.removeExactLocalOwnerMaintenanceLease(guard.journalPath, guard.leaseId, guard.leaseToken) !== true) {
      throw new Error("Morrow data removal maintenance release is unconfirmed");
    }
    if (this.dataRemovalGuard === guard) this.dataRemovalGuard = null;
  }

  async stopRuntimeForDataRemoval(guard) {
    if (guard.kind === "stopped") return guard;
    await this.commitRestartLease(guard.leaseId);
    await this.closeRuntimeMonitor();
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const lease = guard.module.replaceDeadLocalOwnerMaintenanceLeaseWithStoppedGuard(guard.journalPath, {
        holderPid: process.pid,
        workspaceRoot: guard.workspaceRoot
      });
      if (lease && typeof lease.leaseId === "string" && typeof lease.leaseToken === "string") {
        return { ...guard, kind: "stopped", leaseId: lease.leaseId, leaseToken: lease.leaseToken };
      }
      await pause(50);
    }
    throw new Error("Morrow runtime shutdown did not finish");
  }

  /**
   * The confirmation the removal requires. It names every path it will remove
   * and every path it will not. The destructive button is not the default
   * button and not the button the Escape key answers with, and any other
   * answer, including a dialog Morrow cannot read, is not a confirmation.
   */
  async confirmDataRemoval(parent, removable, kept, entries = [], bridgeLoaded = false) {
    const lines = (locations) => locations.map((location) => `- ${location.label}: ${location.path}`);
    const answer = await this.dialog.showMessageBox(parent, {
      type: "warning",
      title: "Remove Morrow's data",
      message: "Remove Morrow's data from this computer?",
      detail: [
        ...(entries.length ? ["Morrow will first take its own morrow entry out of:", ...lines(entries), ""] : []),
        "Morrow will remove:",
        ...lines(removable),
        ...(kept.length ? ["", "Morrow will not remove:", ...lines(kept)] : []),
        ...(kept.some((location) => location.id === "claude_desktop_extension")
          ? ["", "Claude Desktop keeps its own copy of the Morrow extension. Remove Morrow in Claude Desktop under Settings, Extensions."]
          : []),
        "",
        bridgeLoaded && this.bridgeDelivery === "developer_temporary"
          ? "This cannot be undone. Chrome loaded Morrow Bridge from the Bridge folder, so remove Morrow Bridge in Chrome as well."
          : "This cannot be undone. If you added Morrow Bridge in Chrome, remove it there as well."
      ].join("\n"),
      buttons: ["Cancel", "Remove data"],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    }).catch(() => null);
    return answer?.response === 1;
  }

  runRuntimeLifecycle(operation) {
    const running = this.runtimeLifecycle.then(operation);
    this.runtimeLifecycle = running.then(() => undefined, () => undefined);
    return running;
  }

  async closeRuntimeMonitorNow() {
    if (this.runtimeClosing) return this.runtimeClosing;
    const active = this.runtimeMonitor;
    this.runtimeMonitor = null;
    this.runtimeWorkspace = null;
    let requestedClose;
    try { requestedClose = active?.close(); } catch { requestedClose = null; }
    const closing = Promise.resolve(requestedClose)
      .catch(() => {})
      .finally(() => {
        this.restartLeases.clear();
        if (this.runtimeClosing === closing) this.runtimeClosing = null;
      });
    this.runtimeClosing = closing;
    return closing;
  }

  closeRuntimeMonitor() {
    return this.runRuntimeLifecycle(() => this.closeRuntimeMonitorNow());
  }

  async recoverDeadMaintenance(journalPath, workspaceRoot) {
    const module = await import(pathToFileURL(path.join(path.dirname(this.paths.server), "local-owner-maintenance.js")).href);
    if (typeof module.localOwnerMaintenanceMarkerPresent !== "function"
      || typeof module.readLocalOwnerMaintenanceLease !== "function"
      || typeof module.requestLocalOwnerMaintenance !== "function"
      || typeof module.clearDeadLocalOwnerMaintenanceLease !== "function") {
      throw new Error("Morrow maintenance recovery is unavailable");
    }
    if (!module.localOwnerMaintenanceMarkerPresent(journalPath)) return;
    const previous = module.readLocalOwnerMaintenanceLease(journalPath);
    if (!previous || await processMatchesRecordedLifetime(previous.holderPid, previous.acquiredAt) !== false) {
      throw new Error("Morrow maintenance recovery is not available");
    }
    if (module.clearDeadLocalOwnerMaintenanceLease(journalPath, { workspaceRoot }) === true) return;
    const recovered = await module.requestLocalOwnerMaintenance({
      action: "recover",
      journalPath,
      holderPid: process.pid,
      workspaceRoot,
      leaseId: previous.leaseId,
      leaseToken: previous.leaseToken
    });
    if (recovered?.status !== "recovered") throw new Error("Morrow maintenance recovery is unconfirmed");
    const closing = await module.requestLocalOwnerMaintenance({
      action: "commit",
      journalPath,
      holderPid: process.pid,
      workspaceRoot,
      leaseId: recovered.leaseId,
      leaseToken: recovered.leaseToken
    });
    if (closing?.status !== "closing") throw new Error("Morrow maintenance recovery is unconfirmed");
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (module.clearDeadLocalOwnerMaintenanceLease(journalPath, { holderPid: process.pid, workspaceRoot }) === true) return;
      await pause(50);
    }
    throw new Error("Morrow maintenance recovery did not finish");
  }

  /** The runtime monitor for this materials folder, or null when Morrow has none. */
  runtimeMonitorFor(materials) {
    return this.runRuntimeLifecycle(async () => {
      if (!materials || !await exists(this.paths.upstreams)) return null;
      try { await this.ensureRuntime(); } catch { return null; }
      // A runtime started in a folder its own rule refuses exits before it answers.
      let refused = true;
      try { refused = await this.workspaceRefusedByRuntime(materials); } catch {}
      if (refused) {
        await this.closeRuntimeMonitorNow();
        return null;
      }
      const mcpRuntime = await this.mcpRuntimeVerification;
      if (!this.runtimeMonitor || this.runtimeWorkspace !== materials) {
        await this.closeRuntimeMonitorNow();
        const stateDirectory = await this.canonicalStateDirectory();
        const journalPath = path.join(stateDirectory, "morrow.sqlite3");
        await this.recoverDeadMaintenance(journalPath, materials);
        const module = await import(pathToFileURL(this.paths.monitorScript).href);
        this.runtimeMonitor = module.createRuntimeMonitor({
          nodePath: this.paths.node,
          serverEntryPath: this.paths.server,
          upstreamsPath: this.paths.upstreams,
          workspaceRoot: materials,
          journalPath,
          mcpRuntime,
          ...(this.isTestMode && this.testRoot ? { diagnosticTracePath: path.join(stateDirectory, "runtime-startup-trace.json") } : {})
        });
        this.runtimeWorkspace = materials;
      }
      return this.runtimeMonitor;
    });
  }

  /**
   * What the runtime reports. A step that acts on the runtime waits for the
   * monitor to finish starting. A state read does not: `wait: false` answers
   * with what the monitor has already observed and leaves the start running, so
   * a gateway that is not ready yet cannot hold up the window. The next state
   * read shows what that start found.
   */
  async runtimeSnapshot(materials, { wait = true } = {}) {
    const monitor = await this.runtimeMonitorFor(materials);
    if (!monitor) return unobservedRuntime();
    if (wait) return monitor.start();
    const observed = monitor.snapshot();
    monitor.start().catch(() => {});
    return observed;
  }

  async firstSafeRead() {
    const materials = await this.effectiveWorkspace();
    const runtime = await this.runtimeSnapshot(materials);
    if (runtime.firstPreview.available !== "yes" || !this.runtimeMonitor) throw errorDetails("first_read_failed");
    const read = await this.runtimeMonitor.firstSafeRead();
    if (read?.completed !== true) throw errorDetails("first_read_failed");
    return this.runtimeMonitor.snapshot();
  }

  async openClaudeDesktop() {
    const record = await this.record();
    const setup = record.configured?.["claude-desktop"];
    if (!setup || typeof setup.bundlePath !== "string" || !path.isAbsolute(setup.bundlePath)) throw errorDetails("setup_failed");
    if (!await this.isCurrentClaudeDesktopSetup(setup, { platform: this.platform, homeDirectory: this.home })) {
      throw errorDetails("setup_failed");
    }
    if (this.platform === "win32") {
      await this.shell.openExternal("claude://");
    } else {
      const openError = await this.shell.openPath(setup.bundlePath);
      if (openError) throw errorDetails("setup_failed");
    }
  }

  async revealClaudeDesktopBundle() {
    const record = await this.record();
    const setup = record.configured?.["claude-desktop"];
    const bundle = setup?.bundlePath;
    const setupRoot = path.join(await fs.realpath(this.paths.state), "ClaudeDesktop");
    if (typeof bundle !== "string" || !path.isAbsolute(bundle)
      || !insideDirectory(setupRoot, bundle)
      || path.basename(bundle) !== "Morrow.mcpb") throw errorDetails("setup_failed");
    if (!await this.isCurrentClaudeDesktopSetup(setup, { platform: this.platform, homeDirectory: this.home })) {
      throw errorDetails("setup_failed");
    }
    const info = await fs.lstat(bundle).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) throw errorDetails("setup_failed");
    const [realSetupRoot, realBundle] = await Promise.all([
      fs.realpath(path.join(this.paths.state, "ClaudeDesktop")), fs.realpath(bundle)
    ]);
    if (!insideDirectory(realSetupRoot, realBundle)) throw errorDetails("setup_failed");
    this.shell.showItemInFolder(bundle);
  }

  async acquireRestartLease() {
    if (this.restartLeases.size !== 0) return { status: "uncertain" };
    const materials = await this.effectiveWorkspace();
    await this.runtimeSnapshot(materials);
    const monitor = this.runtimeMonitor;
    if (!monitor) return { status: "uncertain" };
    const result = await monitor.maintenance({ action: "acquire", holderPid: process.pid });
    if (result?.status !== "held") return { status: "uncertain", ...(result?.reason ? { reason: result.reason } : {}) };
    const leaseId = crypto.randomUUID();
    this.restartLeases.set(leaseId, monitor);
    return { status: "granted", leaseId };
  }

  async releaseRestartLease(leaseId) {
    const monitor = typeof leaseId === "string" ? this.restartLeases.get(leaseId) : null;
    if (!monitor) throw new Error("restart lease is unavailable");
    const result = await monitor.maintenance({ action: "release", holderPid: process.pid });
    if (result?.status !== "released") throw new Error("restart lease release is unconfirmed");
    this.restartLeases.delete(leaseId);
    return { status: "released" };
  }

  async commitRestartLease(leaseId) {
    const monitor = typeof leaseId === "string" ? this.restartLeases.get(leaseId) : null;
    if (!monitor) throw new Error("restart lease is unavailable");
    const result = await monitor.maintenance({ action: "commit", holderPid: process.pid });
    if (result?.status !== "closing") throw new Error("restart lease commit is unconfirmed");
    this.restartLeases.delete(leaseId);
    return { status: "closing" };
  }

  /**
   * Whether Chrome has the app-owned Morrow Bridge loaded, reported as a fact
   * Morrow observed. `true` needs a proof: the runtime reports the Bridge
   * connected, or the Bridge answers this installation's active-folder
   * challenge. Writing the Bridge folder is not such a proof, so a ready folder
   * with no answer stays "unknown". A person loading the unpacked folder in
   * Chrome is the step that turns "unknown" into `true`; that step is not
   * exercised by any automated test here.
   */
  async bridgeLoadedInChrome(installation, runtime) {
    if (installation?.installed !== true) return false;
    if (runtime?.health?.bridgeConnected === true) return true;
    // A held Bridge lease means the update path owns the Bridge conversation.
    if (this.bridgeLeaseId) return "unknown";
    const monitor = this.runtimeMonitor;
    if (!monitor || runtime?.health?.gatewayReady !== true) return "unknown";
    try {
      const answer = await monitor.bridgeMaintenance({ action: "status" });
      if (answer?.extensionId === BRIDGE_EXTENSION_ID && answer.installType === "normal") return true;
      return answer?.installType === "development" && sameBridgeChallenge(installation, answer) ? true : "unknown";
    } catch {
      return "unknown";
    }
  }

  async assistantConfigurationPresent(assistant, entry, materials) {
    if (!entry || typeof entry.target !== "string" || typeof entry.sha256 !== "string") return false;
    const content = await readConfigurationFile(entry.target);
    if (content === null) return false;
    if (fileHash(content) === entry.sha256) return true;
    const located = configuredProject(assistant, this.home, entry.target);
    if (!located || !materials) return false;
    try {
      const module = await this.clientConfigModule();
      if (typeof module.morrowClientConfigurationStatus !== "function") return false;
      const status = module.morrowClientConfigurationStatus({
        client: assistant.id,
        scope: assistant.needsProject ? "project" : "user",
        ...(located.project ? { projectRoot: located.project } : {}),
        repositoryRoot: this.paths.appRoot,
        upstreamConfigPath: this.paths.upstreams,
        nodeCommand: this.paths.node,
        serverEntryPath: this.paths.server,
        workspaceRoot: materials,
        serverName: MORROW_SERVER_NAME
      });
      return status?.path === entry.target && status.configured === true;
    } catch {
      return false;
    }
  }

  /**
   * The assistants whose own Morrow session has reached the runtime since they
   * were last set up. A file Morrow cannot read counts as none observed, so the
   * restart step is shown again rather than skipped.
   */
  async connectedAssistantIds() {
    try {
      const content = await readPrivateRegularFile(this.assistantConnectionPath, {
        maxBytes: 4 * 1024,
        trustedRoot: this.paths.state,
      });
      const parsed = parseStrictJson(content, "assistant connection record");
      if (!exactObject(parsed, ["schema", "assistants"]) || parsed.schema !== ASSISTANT_CONNECTION_SCHEMA
        || !Array.isArray(parsed.assistants)) return new Set();
      return new Set(parsed.assistants.filter((id) => ASSISTANTS.some((assistant) => assistant.id === id)));
    } catch {
      return new Set();
    }
  }

  async writeConnectedAssistantIds(ids) {
    await this.ensureInstallerStateDirectory();
    const assistants = ASSISTANTS.map((assistant) => assistant.id).filter((id) => ids.has(id));
    const temporary = `${this.assistantConnectionPath}.tmp-${crypto.randomUUID()}`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify({ schema: ASSISTANT_CONNECTION_SCHEMA, assistants })}\n`, { mode: 0o600, flag: "wx" });
      if (this.platform !== "win32") await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, this.assistantConnectionPath);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  /** Setting an assistant up again means it must be restarted again. */
  async forgetAssistantConnection(assistantId) {
    const ids = await this.connectedAssistantIds();
    if (!ids.delete(assistantId)) return;
    await this.writeConnectedAssistantIds(ids);
  }

  /**
   * Checks whether an assistant's own Morrow session is connected. The runtime
   * grants its maintenance lease only while Morrow's own monitor is its sole
   * client, so a refusal naming another client, or a request from one, is that
   * session. A granted lease is released at once and means none is connected.
   * The runtime cannot say which assistant it is, so every assistant configured
   * now is recorded.
   */
  async checkAssistantConnection() {
    const refused = this.maintenanceAdmission();
    if (refused) throw errorDetails(refused);
    const lease = await this.acquireRestartLease();
    if (lease?.status === "granted") {
      await this.releaseRestartLease(lease.leaseId);
      throw errorDetails("assistant_not_connected");
    }
    if (lease?.reason !== "local_owner_other_client_connected" && lease?.reason !== "local_owner_request_in_flight") {
      throw errorDetails("assistant_connection_unconfirmed");
    }
    const record = await this.record();
    const ids = await this.connectedAssistantIds();
    for (const id of Object.keys(record.configured || {})) ids.add(id);
    await this.writeConnectedAssistantIds(ids);
    return true;
  }

  /**
   * Whether this assistant's file still starts Morrow from another place, the
   * way it does after Morrow moved, for example from a disk image into
   * Applications. A different materials folder alone is not a move.
   */
  async assistantEntryMoved(assistant, entry) {
    if (!entry || typeof entry.target !== "string" || assistant.id === "claude-desktop") return false;
    const content = await readConfigurationFile(entry.target).catch(() => null);
    if (content === null) return false;
    try {
      const module = await this.clientConfigModule();
      if (typeof module.morrowServerEntryArguments !== "function") return false;
      const args = module.morrowServerEntryArguments(assistant.id, content.toString("utf8"), MORROW_SERVER_NAME);
      return Array.isArray(args) && typeof args[0] === "string" && args[0] !== this.paths.server;
    } catch {
      return false;
    }
  }

  /**
   * Everything setup shows. `recheckAssistants` is the person selecting Check
   * status: it drops the cached detection answers so this read looks at the
   * computer again. Every other read, including the one on window focus, uses
   * those answers.
   */
  async state({ recheckAssistants = false } = {}) {
    if (recheckAssistants) this.assistantDetection.clear();
    let record;
    try { record = await this.record(); }
    catch { return repairRequiredState(this.updateSnapshot()); }
    const materials = await this.effectiveWorkspace(record);
    const complete = await this.ensureRuntime().then(() => true, () => false);
    const configured = record.configured && typeof record.configured === "object" ? record.configured : {};
    const connectedIds = await this.connectedAssistantIds();
    const assistants = await Promise.all(ASSISTANTS.map(async (assistant) => {
      const entry = configured[assistant.id];
      // Claude Desktop is configured once its connection receipt is present and
      // bound to this installation. Whether Claude is open right now is a
      // separate fact, `claude.running`, and closing Claude must not make a
      // configured assistant look unconfigured.
      const claude = assistant.id === "claude-desktop" && entry
        ? await inspectClaudeDesktopConnection(entry, { platform: this.platform, homeDirectory: this.home })
        : null;
      const present = claude ? claude.installed === true : await this.assistantConfigurationPresent(assistant, entry, materials);
      const moved = !claude && present !== true && await this.assistantEntryMoved(assistant, entry);
      const projectFolder = entry && assistant.needsProject ? configuredProject(assistant, this.home, entry.target)?.project ?? null : null;
      return {
        moved,
        ...assistant,
        projectFolder,
        projectFolderMissing: projectFolder !== null && !await projectFolderPresent(projectFolder),
        detected: await this.detectedAssistant(assistant),
        configured: present,
        // Claude Desktop counts as configured only after its session connected.
        connected: present === true && (assistant.id === "claude-desktop" || connectedIds.has(assistant.id)),
        pending: assistant.id === "claude-desktop" && entry && present !== true,
        checking: claude?.checking === true,
        selected: record.selectedAssistantId === assistant.id,
        needsWorkspace: true
      };
    }));
    // An explicit Check status action must return the state that this check
    // observed. Passive window reads stay non-blocking and may show the last
    // completed observation while the next bounded refresh runs.
    const runtime = await this.runtimeSnapshot(materials, { wait: recheckAssistants }).catch(() => unobservedRuntime());
    // The Bridge folder can change while Morrow is open. Read it from disk for
    // each displayed state so a removed or damaged folder cannot keep the
    // startup result and continue to look ready. An update owns the folder
    // while its transaction is active, so that short transition keeps the last
    // complete result until the update refreshes it.
    let bridgeInstallation = this.bridgeInstallation;
    if (!this.bridgeLeaseId && !this.bridgeReconciliation) {
      if (complete) {
        bridgeInstallation = await this.readBridgeInstallation().catch(() => null);
      } else {
        bridgeInstallation = null;
      }
      this.bridgeInstallation = bridgeInstallation;
    }
    const count = runtime.bindings.runtimeVerifiedCourseCount;
    const bridge = {
      paired: runtime.health.bridgeConnected,
      courseSite: count > 0,
      count,
      courseName: runtime.bindings.selectedCourseName,
      firstReadCourseName: runtime.bindings.firstPreviewCourseName ?? null
    };
    const currentRuntimeStatus = runtimeStatus(complete, runtime);
    // Morrow can be set up in more than one assistant. Every configured
    // assistant keeps this installation ready, so adding a second one, which
    // starts as pending, never takes the first one's steps away.
    const ready = assistants.some((assistant) => assistant.configured && assistant.detected);
    const requestedAssistant = assistants.find((assistant) => assistant.selected) || null;
    // A connected Chrome process can keep an already-loaded unpacked
    // extension alive after its app-owned folder is removed or damaged. The
    // runtime connection does not make those installed bytes trustworthy.
    // Temporary delivery therefore remains ready only while the folder has
    // passed its current sealed-record verification.
    const bridgeRepairRequired = this.bridgeDelivery === "developer_temporary"
      && bridgeInstallation?.installed !== true
      && (this.bridgeStartupAttempted || this.bridgeVerificationFailed)
      && (bridge.paired === true || bridge.count > 0 || runtime.firstPreview.completed === true);
    const appLocation = this.appLocation() === "ok" ? "ok" : "move_required";
    const lifecycle = appLocation === "move_required" ? "move_required"
      : currentRuntimeStatus === "repair_required" || bridgeRepairRequired ? "repair_required"
      : requestedAssistant?.pending && !ready ? "assistant_pending"
      : bridge.count > 0 && ready ? "ready"
      : bridge.paired === true && ready ? "course_not_connected"
      : ready ? "assistant_ready"
      : materials ? "ready_for_assistant" : "ready_for_workspace";
    const updates = this.updateSnapshot();
    const current = installerState({
      lifecycle,
      appLocation,
      assistantsNeedRepoint: assistants.some((assistant) => assistant.moved === true),
      assistants,
      selectedAssistantId: requestedAssistant?.id || null,
      workspaceSelected: record.materialsFolder !== undefined,
      materialsFolder: materials,
      materialsFolderMissing: this.materialsFolderMissing(record, materials),
      runtimeStatus: currentRuntimeStatus,
      bridgeDelivery: this.bridgeDelivery,
      bridgeFolderReady: bridgeInstallation?.installed === true,
      bridgeFolderPath: this.paths.bridgeDirectory,
      bridgeLoadedInChrome: await this.bridgeLoadedInChrome(bridgeInstallation, runtime),
      bridgeUpdateAvailable: await this.bridgeReleaseUpdateAvailable(bridgeInstallation),
      bridgeManualChromeReloadRequired: bridgeInstallation?.manualChromeReloadRequired === true,
      bridgePaired: bridge.paired,
      courseSite: bridge.courseSite,
      runtimeVerifiedCourseCount: bridge.count,
      selectedCourseName: bridge.courseName,
      firstPreviewCourseName: bridge.firstReadCourseName,
      blackboard: await this.blackboardHealth(),
      retention: await this.retention(record),
      updates,
      firstPreview: {
        available: runtime.firstPreview.available === "yes",
        completed: runtime.firstPreview.completed === true
      }
    });
    return withUpdateRevision(current, updates);
  }

  /**
   * Shows the app-owned Bridge folder in the desktop file manager. This is the
   * only Chrome step Morrow performs for the person. Chrome refuses a
   * browser-internal address handed to it by another application, and macOS
   * registers no handler for the `chrome:` scheme, so Morrow shows the folder
   * and the numbered Chrome instructions instead of opening a browser page.
   */
  async revealBridgeFolder() {
    const installation = await this.readBridgeInstallation().catch(() => null);
    if (installation?.installed !== true) throw errorDetails("bridge_folder_unavailable");
    try {
      this.shell.showItemInFolder(path.join(this.paths.bridgeDirectory, "manifest.json"));
    } catch {
      throw errorDetails("bridge_folder_unavailable");
    }
  }

  /**
   * Opens the materials folder Morrow uses. The default one is inside a folder
   * macOS and Windows hide from the file manager, so Morrow opens it for the
   * person. It never creates the folder: only assistant setup does.
   */
  async revealMaterialsFolder() {
    const folder = await this.effectiveWorkspace().catch(() => null);
    if (!folder) throw errorDetails("materials_folder_unavailable");
    const failure = await Promise.resolve(this.shell.openPath(folder)).catch((error) => String(error?.message || error || "failed"));
    if (failure) throw errorDetails("materials_folder_unavailable");
  }
}

function createInstallerController(deps) {
  return new InstallerController(deps);
}

module.exports = { bridgeDeliveryMode, clientConfigTarget, createInstallerController, detectAssistant, errorDetails, processAlive, readCommandOutput, readMacApplicationBundleIdentifier, repairRequiredState, runBoundedCommand };
