"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { ASSISTANTS, errorDetails, installerState } = require("./contract.cjs");
const { DATA_REMOVAL_SCHEMA, freshRecord, insideDirectory, inspectRecord, retentionSnapshot } = require("./state-policy.cjs");
const {
  bridgeInstallationStatus,
  compareChromeVersions,
  confirmBridgeUpdate,
  initializeBridgeDirectory,
  issueBridgeActiveFolderChallenge,
  parseChromeVersion,
  prepareBridgeUpdate,
  pruneBridgeRollbackCopies,
  readReleaseManifest
} = require("./bridge-updates.cjs");
const { completeBridgeUpdate, stageBridgeSwap } = require("./bridge-coordination.cjs");
const { prepareClaudeDesktopBundle, inspectClaudeDesktopConnection, processAlive } = require("./claude-desktop.cjs");
const { blackboardPaths, blackboardTenantIdFromBaseUrl, configureBlackboard, readBlackboardHealth, removeBlackboardTenant, selectBlackboardCourses } = require("./blackboard.cjs");
const { detectAssistantApplication } = require("./assistant-app-detection.cjs");
const { detectWindowsCodexPackage } = require("./windows-appx-detection.cjs");
const {
  canonicalDirectory,
  captureConfiguration,
  exists,
  isComplete,
  verifyMcpRuntime,
  runtimeStatus,
  payloadLayout,
  mkdirPrivate,
  restoreConfiguration
} = require("./runtime.cjs");

const BRIDGE_EXTENSION_ID = "abeloclekioohahgedmjcdbpllfjfhko";

// How long one assistant detection answer is reused. Setup reads its state on
// every window focus, and detection reaches the file system and, on Windows,
// PowerShell. Selecting Check status asks again straight away.
const ASSISTANT_DETECTION_TTL_MS = 60_000;

/** The state Morrow reports when it cannot read its own installer record. */
function repairRequiredState() {
  return installerState({ lifecycle: "repair_required", assistants: [], selectedAssistantId: null, workspaceSelected: false, runtimeStatus: "repair_required", bridgeDelivery: "developer_temporary", bridgeFolderReady: false, bridgeLoadedInChrome: false, bridgePaired: "unknown", courseSite: "unknown", runtimeVerifiedCourseCount: 0, selectedCourseName: null });
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

function limitedText(chunks) {
  return Buffer.concat(chunks).subarray(0, 128 * 1024).toString("utf8");
}

function run(executable, argumentsValue, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argumentsValue, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const output = [];
    const error = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) child.kill();
    }, options.timeoutMs ?? 60_000);
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => error.push(chunk));
    child.once("error", (reason) => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(reason); }
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ code, stdout: limitedText(output), stderr: limitedText(error) });
    });
  });
}

/**
 * Runs one bounded read-only command and answers with its standard output, or
 * `null` when it cannot start, exits non-zero, passes its time limit, or writes
 * more than `maxBytes`. Assistant detection runs on the Electron main process,
 * so this waits for the child asynchronously and never holds the window.
 */
function readCommandOutput(executable, argumentsValue, { timeoutMs, maxBytes }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, argumentsValue, {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        timeout: timeoutMs
      });
    } catch {
      resolve(null);
      return;
    }
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const answer = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        child.kill();
        answer(null);
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", () => answer(null));
    child.once("close", (code) => answer(code === 0 ? Buffer.concat(chunks).toString("utf8") : null));
  });
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
  const executable = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return readCommandOutput(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    timeoutMs: 3_000,
    maxBytes: 8 * 1024
  });
}

async function commandFound(command) {
  const directories = process.platform === "win32"
    ? (process.env.PATH || "").split(path.delimiter)
    : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
  const names = process.platform === "win32" ? [command, `${command}.cmd`, `${command}.exe`] : [command];
  for (const directory of directories) {
    for (const name of names) if (directory && await exists(path.join(directory, name))) return true;
  }
  return false;
}

async function detectAssistant(assistant) {
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
  if (assistant.id === "gemini-cli") return commandFound("gemini");
  if (assistant.id === "codex") return commandFound("codex");
  return false;
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

/**
 * A Codex configuration file with the table Morrow appended removed, or `null`
 * when it carries no such table. Morrow appends its table at the end of the
 * file, so a table header after it is a shape Morrow did not write and the
 * removal refuses rather than guessing where its own table ends.
 */
function withoutCodexMorrowTable(content) {
  const lines = content.split("\n");
  const start = lines.findLastIndex((line) => line.trim() === `[mcp_servers.${MORROW_SERVER_NAME}]`);
  if (start === -1) return null;
  if (lines.slice(start + 1).some((line) => line.trimStart().startsWith("["))) throw errorDetails("setup_failed");
  const kept = lines.slice(0, start).join("\n").trimEnd();
  return kept.length === 0 ? "" : `${kept}\n`;
}

/**
 * One assistant configuration file with Morrow's own entry removed, or `null`
 * when the file carries no Morrow entry. This mirrors exactly what
 * packages/client-config writes: a `morrow` key inside the `mcpServers` object
 * of a JSON file, and a `[mcp_servers.morrow]` table at the end of a Codex TOML
 * file. Everything else in the file is kept as it is, so a change to what that
 * package writes needs a change here as well.
 */
function withoutMorrowEntry(assistantId, content) {
  if (assistantId === "codex") return withoutCodexMorrowTable(content);
  let document;
  try { document = JSON.parse(content); } catch { throw errorDetails("setup_failed"); }
  if (!document || typeof document !== "object" || Array.isArray(document)) throw errorDetails("setup_failed");
  const servers = document.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)
    || !Object.hasOwn(servers, MORROW_SERVER_NAME)) return null;
  delete servers[MORROW_SERVER_NAME];
  return `${JSON.stringify(document, null, 2)}\n`;
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
    this.trustedMcpRuntimeManifestSha256 = deps.trustedMcpRuntimeManifestSha256;
    this.detectAssistant = deps.detectAssistant;
    this.runCli = deps.runCli || run;
    this.updateSnapshot = deps.updateSnapshot || (() => null);
    this.userData = this.app.getPath("userData");
    this.paths = payloadLayout(deps.payloadRoot, this.userData);
    this.home = deps.homeDirectory;
    this.recordPath = path.join(this.paths.state, "installer.json");
    this.workspace = null;
    this.runtimeMonitor = null;
    this.runtimeWorkspace = null;
    this.restartLeases = new Map();
    this.bridgeInstallation = null;
    this.bridgeInitialization = null;
    this.bridgeReconciliation = null;
    this.bridgeLeaseId = null;
    this.mcpRuntimeVerification = null;
    this.privateFileAccess = null;
    this.privateFileAccessModule = null;
    this.blackboardClientModule = null;
    this.discoverBlackboardConnection = deps.discoverBlackboardConnection || ((input) => this.readBlackboardConnection(input));
    this.repairInProgress = null;
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

  async record() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.recordPath, "utf8"));
      const inspected = inspectRecord(parsed);
      if (!inspected.compatible) throw new Error(inspected.reason);
      return inspected.record;
    } catch (error) {
      if (error?.code === "ENOENT") return freshRecord();
      throw error;
    }
  }

  async writeRecord(record) {
    const inspected = inspectRecord({ ...freshRecord(), ...record });
    if (!inspected.compatible) throw new Error(inspected.reason);
    await mkdirPrivate(this.paths.state);
    const temporary = `${this.recordPath}.tmp-${crypto.randomUUID()}`;
    await fs.writeFile(temporary, `${JSON.stringify(inspected.record)}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, this.recordPath);
    if (this.platform !== "win32") await fs.chmod(this.recordPath, 0o600);
    // Morrow keeps its own record on this computer again, so a report from an
    // earlier data removal no longer describes what is here.
    this.dataRemoval = null;
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

  async privateFileAccessModuleForPayload() {
    if (!this.privateFileAccessModule) {
      await this.ensureRuntime();
      this.privateFileAccessModule = import(pathToFileURL(path.join(this.paths.appRoot, "node_modules", "@morrow", "gateway-core", "dist", "index.js")).href);
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
    try {
      const privateFileAccessAccepted = await this.privateFileAccessAccepted();
      return await readBlackboardHealth(this.home, { privateFileAccessAccepted });
    } catch {
      return { schema: "morrow.blackboard.health.v1", status: "not_configured", tenants: [] };
    }
  }

  async configureBlackboard(input) {
    try {
      const privateFileAccessAccepted = await this.privateFileAccessAccepted();
      return configureBlackboard({
        home: this.home,
        input,
        discoverConnection: this.discoverBlackboardConnection,
        privateFileAccessAccepted,
        prepareCredentialDirectory: ({ directory }) => this.prepareBlackboardCredentialDirectories(directory),
        writeCredential: (value) => this.writeBlackboardCredential(value)
      });
    } finally {
      if (input && typeof input === "object" && typeof input.applicationSecret === "string") input.applicationSecret = "";
    }
  }

  async selectBlackboardCourses(input) {
    const privateFileAccessAccepted = await this.privateFileAccessAccepted();
    return selectBlackboardCourses({ home: this.home, input, privateFileAccessAccepted });
  }

  /**
   * Takes one saved Blackboard connection off this computer, so a connection
   * saved for the wrong site or account is not permanent. It contacts
   * Blackboard for nothing and changes nothing in the Blackboard site.
   */
  async removeBlackboardTenant(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1) throw new TypeError("Blackboard removal request is invalid");
    const privateFileAccessAccepted = await this.privateFileAccessAccepted();
    return removeBlackboardTenant({ home: this.home, tenantId: input.tenantId, privateFileAccessAccepted });
  }

  async effectiveWorkspace(record) {
    const currentRecord = record || await this.record();
    const candidate = this.workspace || currentRecord.materialsFolder || this.paths.defaultMaterials;
    if (await exists(candidate)) {
      try { return await canonicalDirectory(candidate); } catch { return null; }
    }
    // Morrow creates its own materials folder when it has none, but never
    // after a removal took that folder away: a folder made again on its own
    // would contradict the removal Morrow just reported.
    if (candidate === this.paths.defaultMaterials && !this.removedOwnData()) {
      await mkdirPrivate(candidate);
      return canonicalDirectory(candidate);
    }
    return null;
  }

  /**
   * Chooses the materials folder, and binds every assistant this installation
   * configured to the folder that was chosen. The change stops the runtime and
   * rewrites assistant settings, so it is refused while another operation holds
   * the runtime, under the same fence repair and the data removal use.
   */
  async configureWorkspace(parent) {
    const refused = this.maintenanceAdmission();
    if (refused) throw errorDetails(refused);
    const result = await this.dialog.showOpenDialog(parent, {
      title: "Choose Morrow materials",
      buttonLabel: "Use this folder",
      properties: ["openDirectory", "createDirectory", "dontAddToRecent"]
    });
    if (result.canceled || result.filePaths.length !== 1) return false;
    const materials = await canonicalDirectory(result.filePaths[0]);
    const record = await this.record();
    // Read what the change has to write before it writes anything, so a record
    // this computer cannot act on stops the change instead of leaving Morrow
    // and its assistants in different folders.
    const bindings = this.assistantBindings(record);
    // Choosing the folder that is already in use is recorded as the choice it
    // is and nothing else: rewriting each assistant would ask for the Claude
    // Desktop approval again for a folder that did not change.
    const changed = (await this.effectiveWorkspace(record)) !== materials;
    if (changed) await this.closeRuntimeMonitor();
    const staged = changed ? await this.bindConfiguredAssistants(bindings, materials) : [];
    try {
      const configured = { ...(record.configured || {}) };
      for (const change of staged) {
        await change.verify?.();
        configured[change.assistant.id] = change.entry;
      }
      await this.writeRecord({ ...record, materialsFolder: materials, configured });
      this.workspace = materials;
    } catch (error) {
      await this.rollbackAssistantBindings(staged);
      throw error;
    }
    for (const change of staged) await change.commit?.().catch(() => {});
    return true;
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
   * uses. Each client file is replaced only while its complete bytes still
   * match the digest Morrow recorded. The installer record changes only after
   * every assistant was written and read back. A failure restores each earlier
   * file only if nothing else changed it after Morrow's write.
   */
  async bindConfiguredAssistants(bindings, materials) {
    const staged = [];
    try {
      for (const { assistant, entry, project } of bindings) {
        if (assistant.id === "claude-desktop") {
          staged.push(await this.stageClaudeDesktopSetup(assistant, entry, materials));
          continue;
        }
        if (typeof entry.sha256 !== "string") throw errorDetails("setup_failed");
        const installed = await this.installClientConfiguration(assistant, entry.target, project, materials, {
          expectedConfigSha256: entry.sha256,
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
    if (!this.mcpRuntimeVerification) {
      this.mcpRuntimeVerification = verifyMcpRuntime(this.paths.payload, expectedManifestSha256)
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
    const status = await bridgeInstallationStatus({
      stateDirectory: this.paths.state,
      bridgeDirectory: this.paths.bridgeDirectory,
      expectedExtensionId: BRIDGE_EXTENSION_ID
    });
    this.bridgeInstallation = status;
    return status;
  }

  async initializeBridgeAtStartup() {
    if (this.bridgeInitialization) return this.bridgeInitialization;
    this.bridgeInitialization = (async () => {
      await this.ensureRuntime();
      let status = await this.readBridgeInstallation();
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
      // Rollback copies an interrupted update left behind. A failed prune must
      // not block startup; the next start repeats it.
      await pruneBridgeRollbackCopies({ stateDirectory: this.paths.state }).catch(() => undefined);
      return status;
    })();
    return this.bridgeInitialization;
  }

  async verifiedBridgeInstallation() {
    const status = await this.readBridgeInstallation();
    if (!status.installed) throw errorDetails("runtime_repair_required");
    return status;
  }

  async packagedBridgeRelease() {
    return readReleaseManifest(this.bridgeReleaseOptions());
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
    if (!sameBridgeChallenge(record, status)) throw new Error("Morrow Bridge active folder is unconfirmed");
    return status;
  }

  async acquireBridgeLease(monitor) {
    if (this.bridgeLeaseId) {
      if (this.restartLeases.get(this.bridgeLeaseId) !== monitor) throw new Error("Morrow Bridge maintenance lease changed");
      return this.bridgeLeaseId;
    }
    const lease = await this.acquireRestartLease();
    if (lease?.status !== "granted" || typeof lease.leaseId !== "string" || this.restartLeases.get(lease.leaseId) !== monitor) {
      throw new Error("Morrow Bridge update is not safe to start");
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
    return stageBridgeSwap({
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
        return result;
      },
      resumeQuiescence: async ({ quiesceEpoch }) => monitor.bridgeMaintenance({ action: "resume", quiesceEpoch, fileLayerRestored: true }),
      refresh: async () => this.readBridgeInstallation(),
      release: async () => this.releaseBridgeLease()
    });
  }

  async reconcileBridgeRelease() {
    if (this.bridgeReconciliation) return this.bridgeReconciliation;
    const pending = (async () => {
      const record = await this.verifiedBridgeInstallation();
      const release = await this.packagedBridgeRelease();
      const installedVersion = parseChromeVersion(record.version);
      const releaseVersion = parseChromeVersion(release.version);
      if (!installedVersion || !releaseVersion) throw new Error("Morrow Bridge release is invalid");
      const comparison = compareChromeVersions(releaseVersion, installedVersion);
      const monitor = await this.bridgeMonitor();
      if (record.manualChromeReloadRequired) return this.completePendingBridgeUpdate(record, monitor);
      if (comparison <= 0) {
        if (comparison === 0) await this.currentBridgeStatus(record, monitor);
        return record;
      }
      const status = await this.currentBridgeStatus(record, monitor);
      if (status.installType !== "development") return record;
      return this.stageBridgeUpdate(record, release, monitor);
    })();
    this.bridgeReconciliation = pending;
    try {
      return await pending;
    } finally {
      if (this.bridgeReconciliation === pending) this.bridgeReconciliation = null;
    }
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
      if (/Refusing to replace (?:existing Morrow (?:server|configuration)|.+ because it changed (?:after Morrow recorded it|during installation))/i.test(result.stderr)) {
        throw errorDetails("existing_morrow_configuration");
      }
      throw errorDetails("setup_failed");
    }
  }

  async installAssistant(assistantId, parent) {
    const assistant = ASSISTANTS.find((candidate) => candidate.id === assistantId);
    // Setting up an assistant is an explicit step, so it reads this computer
    // again rather than trusting a cached answer from up to a minute ago.
    if (!assistant || (assistant.id !== "claude-desktop" && !(await this.freshlyDetectedAssistant(assistant)))) throw errorDetails("assistant_not_found");
    if (!assistant.supported) throw errorDetails("setup_failed");
    const record = await this.record();
    const materials = await this.effectiveWorkspace(record);
    if (!materials) throw errorDetails("workspace_required");
    await this.closeRuntimeMonitor();
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
      let setup;
      try {
        setup = await prepareClaudeDesktopBundle({
          nodePath: this.paths.node,
          serverEntryPath: this.paths.server,
          upstreamsPath: this.paths.upstreams,
          workspaceRoot: materials,
          stateDirectory: this.paths.state,
          version: this.productVersion,
          platform: this.platform
        });
        if (this.platform === "win32") {
          await this.shell.openExternal("claude://");
        } else {
          const openError = await this.shell.openPath(setup.bundlePath);
          if (openError) throw new Error("Claude Desktop did not open the Morrow bundle");
        }
        const updated = await this.record();
        await this.writeRecord({
          ...updated,
          selectedAssistantId: assistant.id,
          configured: {
            ...(updated.configured || {}),
            [assistant.id]: {
              bundlePath: setup.bundlePath,
              installationId: setup.installationId,
              receiptPath: setup.receiptPath
            }
          }
        });
      } catch (error) {
        if (error.code) throw error;
        throw errorDetails("setup_failed");
      }
      return;
    }

    const target = clientConfigTarget(assistant, this.home, project);
    if (!target) throw errorDetails("setup_failed");
    await this.installClientConfiguration(assistant, target, project, materials);
  }

  /**
   * Writes the Morrow entry into one assistant configuration file. The file is
   * copied first, and a failure puts the copy back only when the file on disk is
   * still exactly what Morrow wrote, so an edit made by anything else survives.
   */
  async installClientConfiguration(assistant, target, project, materials, options = {}) {
    const backup = await captureConfiguration(target, path.join(this.paths.state, "Backups"));
    let installedConfigurationSha256 = null;
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
      if (options.expectedConfigSha256) {
        argumentsValue.push("--expected-config-sha256", options.expectedConfigSha256);
      }
      argumentsValue.push("--json");
      await this.executeCli(argumentsValue);
      const content = await fs.readFile(target);
      installedConfigurationSha256 = fileHash(content);
      const entry = { target, sha256: installedConfigurationSha256 };
      if (options.updateRecord !== false) {
        const updated = await this.record();
        await this.writeRecord({
          ...updated,
          selectedAssistantId: assistant.id,
          configured: { ...(updated.configured || {}), [assistant.id]: entry }
        });
      }
      return {
        entry,
        verify: async () => {
          const currentSha256 = await fs.readFile(target).then(fileHash, () => null);
          if (currentSha256 !== installedConfigurationSha256) throw errorDetails("assistant_configuration_changed");
        },
        rollback: async () => restoreConfiguration(backup, installedConfigurationSha256)
      };
    } catch (error) {
      if (installedConfigurationSha256) await restoreConfiguration(backup, installedConfigurationSha256).catch(() => {});
      if (error.code) throw error;
      throw errorDetails("setup_failed");
    }
  }

  /**
   * Removes Morrow's own entry from one assistant configuration file and keeps
   * the rest of that file as it is. It writes only while the file on disk is
   * still exactly the file Morrow wrote, so an edit made after that is refused
   * and the file is left untouched. The file is read again afterwards: the
   * removal is proven by what that file says, not by the write call.
   */
  async removeClientConfiguration(assistant, entry) {
    const target = entry?.target;
    if (typeof target !== "string" || !path.isAbsolute(target) || typeof entry.sha256 !== "string") throw errorDetails("setup_failed");
    const content = await fs.readFile(target).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw errorDetails("setup_failed");
    });
    // The file is gone, so no Morrow entry of this installation is in it.
    if (content === null) return;
    if (fileHash(content) !== entry.sha256) {
      throw {
        ...errorDetails("assistant_configuration_changed"),
        recovery: `Morrow left ${target} exactly as it is. Open it, remove the morrow entry yourself, then select Check status.`
      };
    }
    const next = withoutMorrowEntry(assistant.id, content.toString("utf8"));
    if (next === null) return;
    await this.writeAssistantConfiguration(target, next, entry.sha256);
    const written = await fs.readFile(target).catch(() => null);
    if (written === null || withoutMorrowEntry(assistant.id, written.toString("utf8")) !== null) throw errorDetails("setup_failed");
  }

  /**
   * Replaces one assistant configuration file with the content Morrow prepared.
   * The digest is checked again immediately before the replacement, so a file
   * something else changed while Morrow was preparing this is never replaced.
   */
  async writeAssistantConfiguration(target, content, expectedSha256) {
    const temporary = `${target}.tmp-${crypto.randomUUID()}`;
    try {
      await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      const current = await fs.readFile(target).then(fileHash, () => null);
      if (current !== expectedSha256) throw errorDetails("assistant_configuration_changed");
      await fs.rename(temporary, target);
      if (this.platform !== "win32") await fs.chmod(target, 0o600);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
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
    const setupRoot = path.join(this.paths.state, "ClaudeDesktop");
    if (!insideDirectory(setupRoot, directory) || path.resolve(directory) === path.resolve(setupRoot)) throw errorDetails("setup_failed");
    await fs.rm(directory, { recursive: true, force: true });
    if (await fs.lstat(directory).then(() => true, () => false)) throw errorDetails("setup_failed");
  }

  /**
   * Generates the Claude Desktop bundle for a different materials folder. The
   * caller records it only after every assistant rebind succeeds, then removes
   * the old bundle. Until that commit, a failure removes only the new bundle.
   */
  async stageClaudeDesktopSetup(assistant, previousEntry, materials) {
    let setup;
    try {
      setup = await prepareClaudeDesktopBundle({
        nodePath: this.paths.node,
        serverEntryPath: this.paths.server,
        upstreamsPath: this.paths.upstreams,
        workspaceRoot: materials,
        stateDirectory: this.paths.state,
        version: this.productVersion,
        platform: this.platform
      });
    } catch (error) {
      if (error?.code) throw error;
      throw errorDetails("setup_failed");
    }
    const entry = { bundlePath: setup.bundlePath, installationId: setup.installationId, receiptPath: setup.receiptPath };
    return {
      assistant,
      entry,
      verify: async () => {
        const info = await fs.lstat(entry.bundlePath).catch(() => null);
        if (!info?.isFile() || info.isSymbolicLink()) throw errorDetails("setup_failed");
      },
      rollback: async () => this.removeClaudeDesktopSetup(entry),
      commit: async () => this.removeClaudeDesktopSetup(previousEntry)
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
    const record = await this.record();
    const entry = record.configured?.[assistant.id];
    if (!entry) return;
    if (assistant.id === "claude-desktop") await this.removeClaudeDesktopSetup(entry);
    else await this.removeClientConfiguration(assistant, entry);
    const updated = await this.record();
    const configured = { ...(updated.configured || {}) };
    delete configured[assistant.id];
    const remaining = ASSISTANTS.map((candidate) => candidate.id).filter((id) => configured[id] !== undefined);
    await this.writeRecord({
      ...updated,
      selectedAssistantId: updated.selectedAssistantId === assistant.id ? remaining[0] ?? null : updated.selectedAssistantId,
      configured
    });
  }

  /**
   * The fence the update path uses, applied to repair and to the data removal.
   * Each of those stops the runtime and rewrites or removes files, so neither
   * may begin while another operation holds a restart lease, and neither may
   * interrupt work in flight that Morrow cannot confirm is safe to stop.
   */
  maintenanceAdmission() {
    if (this.restartLeases.size !== 0 || this.bridgeLeaseId !== null) return "active_or_uncertain_operations";
    const monitor = this.runtimeMonitor;
    const canRestart = typeof monitor?.snapshot === "function" ? monitor.snapshot()?.health?.canRestart : "unknown";
    const pending = this.repairInProgress !== null || this.bridgeReconciliation !== null;
    if (pending && canRestart !== "yes") return "active_or_uncertain_operations";
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
    const refused = this.maintenanceAdmission();
    if (refused) throw errorDetails(refused);
    const pending = this.runRepair();
    this.repairInProgress = pending;
    try {
      return await pending;
    } finally {
      if (this.repairInProgress === pending) this.repairInProgress = null;
    }
  }

  async runRepair() {
    try {
      // Closing the runtime monitor also releases the maintenance lease it holds.
      await this.closeRuntimeMonitor();
      // The payload lives in signed application resources and is never rewritten
      // here, so its file verification runs again from disk rather than reusing
      // the result of an earlier one.
      this.mcpRuntimeVerification = null;
      await this.ensureRuntime();
      const record = await this.repairInstallerRecord();
      await this.repairBridgeInstallation();
      await this.repairAssistantConfiguration(record);
      // Repair stopped the runtime, so this step waits for the restarted one
      // rather than answering with a runtime it has not observed yet.
      await this.runtimeSnapshot(await this.effectiveWorkspace(record)).catch(() => {});
      return await this.state();
    } catch (error) {
      throw reportedError(error);
    }
  }

  /**
   * Re-creates State and re-reads the installer record. A malformed record is
   * copied into State/Backups before a fresh record replaces it. A valid record
   * from another version is left exactly as it is until that version can read
   * or migrate it.
   */
  async repairInstallerRecord() {
    await mkdirPrivate(this.paths.state);
    try {
      return await this.record();
    } catch (error) {
      if (error?.message === "migration_required") throw errorDetails("installer_record_incompatible");
      await captureConfiguration(this.recordPath, path.join(this.paths.state, "Backups"));
      const fresh = freshRecord();
      await this.writeRecord(fresh);
      return fresh;
    }
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

  async discardUnusableBridgeInstallation() {
    const record = path.join(this.paths.state, "bridge-installation.json");
    if (await exists(record)) {
      await captureConfiguration(record, path.join(this.paths.state, "Backups"));
      await fs.rm(record, { force: true });
    }
    const info = await fs.lstat(this.paths.bridgeDirectory).catch(() => null);
    if (info?.isDirectory() === true) await fs.rm(this.paths.bridgeDirectory, { recursive: true, force: true });
  }

  /**
   * Re-runs the local setup, then the client configuration for the assistant
   * this installation selected and only that one. Morrow rewrites its own
   * assistant file only while the file still matches what Morrow wrote: an edit
   * made after that is reported and left exactly as it is. Claude Desktop is
   * configured by an approval inside that application, so repair leaves it to
   * the person and does not open another application.
   */
  async repairAssistantConfiguration(record) {
    await this.executeCli([
      "setup", "--repository", this.paths.appRoot, "--upstreams", this.paths.upstreams, "--node", this.paths.node,
      "--state-directory", this.paths.state, "--replace-generated", "--json"
    ]);
    const assistant = ASSISTANTS.find((candidate) => candidate.id === record.selectedAssistantId);
    if (!assistant || assistant.id === "claude-desktop") return;
    const entry = record.configured?.[assistant.id];
    if (!entry || typeof entry.sha256 !== "string") return;
    const configured = configuredProject(assistant, this.home, entry.target);
    if (!configured) return;
    const current = await fs.readFile(entry.target).then(fileHash, () => null);
    if (current !== null && current !== entry.sha256) throw errorDetails("existing_morrow_configuration");
    const materials = await this.effectiveWorkspace(record);
    if (!materials) throw errorDetails("workspace_required");
    await this.installClientConfiguration(assistant, entry.target, configured.project, materials, {
      ...(current === null ? {} : { expectedConfigSha256: entry.sha256 })
    });
  }

  /**
   * Every place this installation keeps data, with the exact path of each one.
   * Removing the Morrow application removes the application only, so this is
   * what stays on this computer until a person removes it here.
   */
  retention(record) {
    const configured = record?.configured && typeof record.configured === "object" && !Array.isArray(record.configured) ? record.configured : {};
    const assistantConfigurations = ASSISTANTS.flatMap((assistant) => {
      const target = configured[assistant.id]?.target;
      return typeof target === "string" && path.isAbsolute(target) ? [{ title: assistant.title, path: target }] : [];
    });
    const blackboard = blackboardPaths(this.home, "default");
    return retentionSnapshot({
      platform: this.platform,
      userData: this.paths.userData,
      state: this.paths.state,
      backups: path.join(this.paths.state, "Backups"),
      bridge: this.paths.bridgeDirectory,
      // The materials folder this installation uses, named without creating it.
      materials: this.workspace || record?.materialsFolder || this.paths.defaultMaterials,
      blackboardCredentials: blackboard.credentialDirectory,
      blackboardConfiguration: blackboard.config,
      assistantConfigurations,
      removal: this.dataRemoval
    });
  }

  /**
   * Removes the Morrow data this installation owns. It runs only after an
   * explicit confirmation that names every path, it removes only the places
   * inside Morrow's own user-data folder and the Blackboard credential folder,
   * and it reports what is gone by reading each path again rather than from the
   * removal calls. It never removes an assistant's own configuration file.
   *
   * Removing the application itself is a step of this computer, not of Morrow.
   * No test here exercises that step.
   */
  async removeData(parent) {
    const refused = this.maintenanceAdmission();
    if (refused) throw errorDetails(refused);
    const retention = this.retention(await this.record());
    const removable = retention.locations.filter((location) => location.removable === true);
    const kept = retention.locations.filter((location) => location.removable !== true);
    const keptPaths = kept.map((location) => location.path);
    if (!await this.confirmDataRemoval(parent, removable, kept)) {
      this.dataRemoval = { schema: DATA_REMOVAL_SCHEMA, status: "cancelled", removed: [], remaining: [], kept: keptPaths };
      return this.dataRemoval;
    }
    // The runtime holds the journal inside State. Closing the monitor is also
    // what releases the maintenance lease it holds.
    await this.closeRuntimeMonitor();
    for (const location of removable) {
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
  }

  /**
   * The confirmation the removal requires. It names every path it will remove
   * and every path it will not. The destructive button is not the default
   * button and not the button the Escape key answers with, and any other
   * answer, including a dialog Morrow cannot read, is not a confirmation.
   */
  async confirmDataRemoval(parent, removable, kept) {
    const lines = (locations) => locations.map((location) => `- ${location.label}: ${location.path}`);
    const answer = await this.dialog.showMessageBox(parent, {
      type: "warning",
      title: "Remove Morrow's data",
      message: "Remove Morrow's data from this computer?",
      detail: [
        "Morrow will remove:",
        ...lines(removable),
        ...(kept.length ? ["", "Morrow will not remove:", ...lines(kept)] : []),
        "",
        "This cannot be undone. Chrome loaded Morrow Bridge from the Bridge folder, so remove Morrow Bridge in Chrome as well."
      ].join("\n"),
      buttons: ["Cancel", "Remove data"],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    }).catch(() => null);
    return answer?.response === 1;
  }

  async closeRuntimeMonitor() {
    const active = this.runtimeMonitor;
    this.runtimeMonitor = null;
    this.runtimeWorkspace = null;
    await active?.close().catch(() => {});
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
    if (!previous || processAlive(previous.holderPid)) throw new Error("Morrow maintenance recovery is not available");
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
  async runtimeMonitorFor(materials) {
    if (!materials || !await exists(this.paths.upstreams)) return null;
    try { await this.ensureRuntime(); } catch { return null; }
    const mcpRuntime = await this.mcpRuntimeVerification;
    if (!this.runtimeMonitor || this.runtimeWorkspace !== materials) {
      await this.closeRuntimeMonitor();
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
    if (runtime.firstPreview.available !== "yes" || !this.runtimeMonitor) return runtime;
    await this.runtimeMonitor.firstSafeRead();
    return this.runtimeMonitor.snapshot();
  }

  async openClaudeDesktop() {
    const record = await this.record();
    const setup = record.configured?.["claude-desktop"];
    if (!setup || typeof setup.bundlePath !== "string" || !path.isAbsolute(setup.bundlePath)) throw errorDetails("setup_failed");
    if (this.platform === "win32") {
      await this.shell.openExternal("claude://");
    } else {
      const openError = await this.shell.openPath(setup.bundlePath);
      if (openError) throw errorDetails("setup_failed");
    }
  }

  async revealClaudeDesktopBundle() {
    const record = await this.record();
    const bundle = record.configured?.["claude-desktop"]?.bundlePath;
    if (typeof bundle !== "string" || !path.isAbsolute(bundle)
      || !insideDirectory(path.join(this.paths.state, "ClaudeDesktop"), bundle)
      || path.basename(bundle) !== "Morrow.mcpb") throw errorDetails("setup_failed");
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
    if (result?.status !== "held") return { status: "uncertain" };
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
      return sameBridgeChallenge(installation, answer) ? true : "unknown";
    } catch {
      return "unknown";
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
    catch {
      return repairRequiredState();
    }
    const materials = await this.effectiveWorkspace(record);
    const complete = await this.ensureRuntime().then(() => true, () => false);
    const configured = record.configured && typeof record.configured === "object" ? record.configured : {};
    const assistants = await Promise.all(ASSISTANTS.map(async (assistant) => {
      const entry = configured[assistant.id];
      // Claude Desktop is configured once its connection receipt is present and
      // bound to this installation. Whether Claude is open right now is a
      // separate fact, `claude.running`, and closing Claude must not make a
      // configured assistant look unconfigured.
      const claude = assistant.id === "claude-desktop" && entry
        ? await inspectClaudeDesktopConnection(entry)
        : null;
      const present = claude ? claude.installed === true : entry && typeof entry.target === "string" && typeof entry.sha256 === "string" && await exists(entry.target)
        ? fileHash(await fs.readFile(entry.target)) === entry.sha256
        : false;
      return {
        ...assistant,
        detected: assistant.id === "claude-desktop" ? true : await this.detectedAssistant(assistant),
        configured: present,
        pending: assistant.id === "claude-desktop" && entry && present !== true,
        selected: record.selectedAssistantId === assistant.id,
        needsWorkspace: true
      };
    }));
    const runtime = await this.runtimeSnapshot(materials, { wait: false }).catch(() => unobservedRuntime());
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
    const ready = assistants.some((assistant) => assistant.configured);
    const requestedAssistant = assistants.find((assistant) => assistant.selected) || null;
    const lifecycle = currentRuntimeStatus === "repair_required" ? "repair_required"
      : requestedAssistant?.pending && !ready ? "assistant_pending"
      : bridge.count > 0 && ready ? "ready"
      : bridge.paired === true && ready ? "course_not_connected"
      : ready ? "assistant_ready"
      : materials ? "ready_for_assistant" : "ready_for_workspace";
    return installerState({
      lifecycle,
      assistants,
      selectedAssistantId: requestedAssistant?.id || null,
      workspaceSelected: record.materialsFolder !== undefined,
      materialsFolder: materials,
      runtimeStatus: currentRuntimeStatus,
      bridgeDelivery: "developer_temporary",
      bridgeFolderReady: bridgeInstallation?.installed === true,
      bridgeLoadedInChrome: await this.bridgeLoadedInChrome(bridgeInstallation, runtime),
      bridgeManualChromeReloadRequired: bridgeInstallation?.manualChromeReloadRequired === true,
      bridgePaired: bridge.paired,
      courseSite: bridge.courseSite,
      runtimeVerifiedCourseCount: bridge.count,
      selectedCourseName: bridge.courseName,
      firstPreviewCourseName: bridge.firstReadCourseName,
      blackboard: await this.blackboardHealth(),
      retention: this.retention(record),
      updates: this.updateSnapshot(),
      firstPreview: {
        available: runtime.firstPreview.available === "yes",
        completed: runtime.firstPreview.completed === true
      }
    });
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
}

function createInstallerController(deps) {
  return new InstallerController(deps);
}

module.exports = { createInstallerController, detectAssistant, errorDetails, processAlive, readCommandOutput, readMacApplicationBundleIdentifier, repairRequiredState };
