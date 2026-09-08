const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, dialog, ipcMain, session, shell } = require("electron");
const { assertAssistantId, envelope } = require("./shared/contract.cjs");
const { createElectronUpdaterAdapter } = require("./shared/electron-updater-adapter.cjs");
const { createUpdateAttemptStore, createUpdateController } = require("./shared/updates.cjs");
const { createInstallerController, detectAssistant, errorDetails, repairRequiredState } = require("./shared/installer-controller.cjs");
const { canonicalDirectory, exists, isComplete, mkdirPrivate, payloadLayout } = require("./shared/runtime.cjs");

const PRODUCT_VERSION = app.getVersion();
const BUILD_METADATA = require("./package.json").morrow || Object.freeze({});
const UPDATE_METADATA = BUILD_METADATA.desktopUpdates || null;
const UPDATE_FEED = Object.freeze({
  id: "morrow-github-stable",
  provider: "github",
  owner: "example-owner",
  repo: "morrow",
  channel: "latest"
});
const TEST_ROOT_ARGUMENT = process.argv.find((value) => value.startsWith("--morrow-test-root="));
const IS_TEST_MODE = process.env.MORROW_INSTALLER_TEST_MODE === "1";
const testRoot = IS_TEST_MODE && TEST_ROOT_ARGUMENT
  ? path.resolve(TEST_ROOT_ARGUMENT.slice("--morrow-test-root=".length))
  : null;
if (testRoot && !path.isAbsolute(testRoot)) throw new Error("Morrow test root must be absolute.");
if (testRoot) app.setPath("userData", path.join(testRoot, "UserData"));

let mainWindow = null;
let installer = null;
let updateController = null;

function isStableReleaseVersion(value) {
  return typeof value === "string" && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value);
}

function updatePolicy() {
  const enabled = app.isPackaged
    && isStableReleaseVersion(PRODUCT_VERSION)
    && UPDATE_METADATA?.enabled === true
    && UPDATE_METADATA?.feedId === UPDATE_FEED.id
    && UPDATE_METADATA?.provider === UPDATE_FEED.provider
    && UPDATE_METADATA?.owner === UPDATE_FEED.owner
    && UPDATE_METADATA?.repo === UPDATE_FEED.repo
    && UPDATE_METADATA?.channel === UPDATE_FEED.channel
    && fsSync.existsSync(path.join(process.resourcesPath, "app-update.yml"));
  return Object.freeze({
    enabled,
    automatic: true,
    allowPrerelease: false,
    feed: { id: UPDATE_FEED.id }
  });
}

/**
 * Whether the runtime this version of Morrow starts with is the verified one.
 * `ready` is the only runtime status that requires both the sealed MCP payload
 * verification and a gateway that answered its health request, so it is the
 * only verified answer. `repair_required` is a proven failure. Every other
 * status means Morrow could not tell yet, which is not proof either way.
 */
async function confirmUpdatedRuntime() {
  if (!installer) return { status: "unknown" };
  try {
    const current = await installer.state();
    if (current.runtime.status === "ready") return { status: "verified" };
    return { status: current.runtime.status === "repair_required" ? "unverified" : "unknown" };
  } catch {
    return { status: "unknown" };
  }
}

/**
 * The directory electron-updater downloads into. It derives this path itself
 * from the operating system cache location (`getAppCacheDir` in
 * `electron-updater/out/AppAdapter.js`), which Electron does not expose through
 * `app.getPath`, so Morrow repeats the same rule to name the volume. Only the
 * volume matters here: the free space Morrow measures before a download.
 */
function updaterCacheDirectory() {
  const home = os.homedir();
  if (process.platform === "win32") return process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  if (process.platform === "darwin") return path.join(home, "Library", "Caches");
  return process.env.XDG_CACHE_HOME || path.join(home, ".cache");
}

function createAppUpdateController() {
  const { autoUpdater } = require("electron-updater");
  const adapter = createElectronUpdaterAdapter({
    updater: autoUpdater,
    currentVersion: PRODUCT_VERSION,
    platform: process.platform,
    arch: process.arch,
    feedId: UPDATE_FEED.id,
    cacheDirectory: updaterCacheDirectory()
  });
  return createUpdateController({
    adapter,
    policy: updatePolicy(),
    updateAttempts: createUpdateAttemptStore({
      stateDirectory: payloadLayout(fixedPayloadRoot(), app.getPath("userData")).state
    }),
    confirmUpdatedRuntime,
    acquireRestartLease: async () => installer?.acquireRestartLease() || { status: "uncertain" },
    releaseRestartLease: async (leaseId) => {
      if (!installer) throw new Error("restart lease service is unavailable");
      return installer.releaseRestartLease(leaseId);
    },
    commitRestartLease: async (leaseId) => {
      if (!installer) throw new Error("restart lease service is unavailable");
      return installer.commitRestartLease(leaseId);
    }
  });
}

function unavailableSmokeRuntimeTrace() {
  return {
    schema: "morrow.desktop-runtime-trace.v1",
    child: { spawned: false, exitCode: null },
    stderrStage: "not_started",
    owner: { stderrCaptured: false, failure: null },
    portBinding: "not_observed",
    upstream: {
      initialize: { ready: false, durationMs: 0 },
      listTools: { ready: false, durationMs: 0 },
      readResource: { ready: false, durationMs: 0 }
    }
  };
}

function smokeRuntimeTrace(value) {
  const fallback = unavailableSmokeRuntimeTrace();
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== fallback.schema) return fallback;
  const child = value.child;
  const owner = value.owner;
  const upstream = value.upstream;
  const validPhase = (phase) => phase && typeof phase === "object" && !Array.isArray(phase)
    && typeof phase.ready === "boolean" && Number.isSafeInteger(phase.durationMs) && phase.durationMs >= 0 && phase.durationMs <= 600_000;
  if (!child || typeof child !== "object" || Array.isArray(child)
    || typeof child.spawned !== "boolean"
    || (child.exitCode !== null && (!Number.isSafeInteger(child.exitCode) || child.exitCode < 0 || child.exitCode > 255))
    || !owner || typeof owner !== "object" || Array.isArray(owner)
    || typeof owner.stderrCaptured !== "boolean"
    || (owner.failure !== null && (typeof owner.failure !== "string" || owner.failure.length === 0 || owner.failure.length > 600
      || /(?:[A-Za-z]:)?[\\/]/.test(owner.failure)
      || /\b(?:token|secret|password|authorization|cookie)\s*[:=]\s*(?!<redacted>)/i.test(owner.failure)))
    || !["not_started", "none", "configured_port_in_use", "local_owner_connection_failed", "protocol_error", "local_owner_ready", "other"].includes(value.stderrStage)
    || !["not_observed", "bound", "unbound"].includes(value.portBinding)
    || !upstream || typeof upstream !== "object" || Array.isArray(upstream)
    || !validPhase(upstream.initialize) || !validPhase(upstream.listTools) || !validPhase(upstream.readResource)) return fallback;
  return {
    schema: fallback.schema,
    child: { spawned: child.spawned, exitCode: child.exitCode },
    stderrStage: value.stderrStage,
    owner: { stderrCaptured: owner.stderrCaptured, failure: owner.failure },
    portBinding: value.portBinding,
    upstream: {
      initialize: { ready: upstream.initialize.ready, durationMs: upstream.initialize.durationMs },
      listTools: { ready: upstream.listTools.ready, durationMs: upstream.listTools.durationMs },
      readResource: { ready: upstream.readResource.ready, durationMs: upstream.readResource.durationMs }
    }
  };
}

const SMOKE_STATE_SECURITY_SCHEMA = "morrow.desktop-windows-state-security.v1";
const SMOKE_ACL_CLASSIFICATIONS = new Set([
  "not_checked",
  "not_windows",
  "current_user_system_admin_sensitive_access_only",
  "additional_principal_sensitive_access_allow",
  "untrusted_owner",
  "unresolved_identity",
  "unavailable"
]);

function unavailableSmokeStateSecurity() {
  return {
    schema: SMOKE_STATE_SECURITY_SCHEMA,
    state: { underUserData: false, acl: "not_checked" },
    descriptor: {
      withinState: false,
      present: false,
      regularFile: false,
      symlink: false,
      reportedMode: null,
      acl: "not_checked"
    },
    posix: { stateMode: null, stateOwner: "not_checked", descriptorOwner: "not_checked" }
  };
}

/**
 * On macOS the containment facts are the POSIX ones: State is created 0700 and
 * the local-owner descriptor 0600, both owned by the account Morrow runs as.
 * Windows has no POSIX owner, so the answer there is `not_posix` and the ACL
 * classification is the record that carries the meaning. Each of "no record
 * to read" (`not_checked`) and "the record could not be read" (`unavailable`)
 * keeps its own value, so neither is reported as "another account owns it".
 */
function smokePosixOwner(info) {
  if (process.platform === "win32") return "not_posix";
  if (!info) return "not_checked";
  if (typeof process.getuid !== "function") return "unavailable";
  return info.uid === process.getuid() ? "current_user" : "other_user";
}

function smokePosixMode(info) {
  if (process.platform === "win32" || !info) return null;
  return (info.mode & 0o777).toString(8).padStart(4, "0");
}

function smokeWindowsAclClassification(candidate) {
  if (process.platform !== "win32") return "not_windows";
  const encodedPath = Buffer.from(candidate, "utf16le").toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$target = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    "$allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')",
    "$acl = Get-Acl -LiteralPath $target",
    "try { $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value } catch { 'unresolved_identity'; exit 0 }",
    "if ($allowed -notcontains $owner) { 'untrusted_owner'; exit 0 }",
    "$sensitive = [Security.AccessControl.FileSystemRights]::ReadData -bor [Security.AccessControl.FileSystemRights]::ReadExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::ReadAttributes -bor [Security.AccessControl.FileSystemRights]::ReadPermissions -bor [Security.AccessControl.FileSystemRights]::ExecuteFile -bor [Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership",
    "foreach ($rule in $acl.Access) { if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or (($rule.FileSystemRights -band $sensitive) -eq 0)) { continue }; try { $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { 'unresolved_identity'; exit 0 }; if ($allowed -notcontains $sid) { 'additional_principal_sensitive_access_allow'; exit 0 } }",
    "'current_user_system_admin_sensitive_access_only'"
  ].join("; ");
  const result = spawnSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")
  ], { encoding: "utf8", timeout: 5_000, maxBuffer: 4 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  if (result.status !== 0) return "unavailable";
  const value = String(result.stdout || "").trim();
  return SMOKE_ACL_CLASSIFICATIONS.has(value) ? value : "unavailable";
}

async function smokeStateSecurity(paths, userData) {
  const result = unavailableSmokeStateSecurity();
  if (!IS_TEST_MODE || !testRoot) return result;
  try {
    const state = await canonicalDirectory(paths.state);
    const canonicalUserData = await canonicalDirectory(userData);
    const stateInfo = fsSync.lstatSync(state);
    result.state = {
      underUserData: isWithin(canonicalUserData, state),
      acl: smokeWindowsAclClassification(state)
    };
    const descriptorPath = path.join(state, "morrow.sqlite3.local-owner.json");
    let info = null;
    try { info = fsSync.lstatSync(descriptorPath); } catch { /* The owner did not create a descriptor. */ }
    result.descriptor = {
      withinState: isWithin(state, descriptorPath),
      present: info !== null,
      regularFile: info?.isFile() === true,
      symlink: info?.isSymbolicLink() === true,
      reportedMode: info ? (info.mode & 0o777).toString(8).padStart(4, "0") : null,
      acl: info ? smokeWindowsAclClassification(descriptorPath) : "not_checked"
    };
    result.posix = {
      stateMode: smokePosixMode(stateInfo),
      stateOwner: smokePosixOwner(stateInfo),
      descriptorOwner: smokePosixOwner(info)
    };
  } catch {
    return unavailableSmokeStateSecurity();
  }
  return result;
}

function trustedBridgeReleaseManifestSha256() {
  const digest = BUILD_METADATA.bridgeRelease?.manifestSha256;
  return typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest) ? digest : null;
}

function trustedMcpRuntimeManifestSha256() {
  const digest = BUILD_METADATA.mcpRuntime?.manifestSha256;
  return typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest) ? digest : null;
}

function fixedPayloadRoot() {
  const seed = app.isPackaged
    ? path.join(process.resourcesPath, "MorrowPayload")
    : process.env.MORROW_INSTALLER_PAYLOAD;
  if (!seed || !path.isAbsolute(seed)) throw new Error("Morrow bundled files are unavailable.");
  return seed;
}

function requestedArgument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function writeSmokeReceipt(destination, value) {
  await mkdirPrivate(path.dirname(destination));
  const temporary = `${destination}.tmp-${crypto.randomUUID()}`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, destination);
  if (process.platform !== "win32") await fs.chmod(destination, 0o600);
}

async function currentSmokeRuntimeTrace() {
  const monitor = installer?.runtimeMonitor;
  if (!IS_TEST_MODE || !monitor || typeof monitor.testDiagnostics !== "function") return unavailableSmokeRuntimeTrace();
  return smokeRuntimeTrace(await monitor.testDiagnostics());
}

async function runDesktopSmokeIfRequested() {
  const receipt = requestedArgument("morrow-smoke-receipt");
  if (!receipt) return false;
  if (!IS_TEST_MODE || !testRoot || !path.isAbsolute(receipt) || !isWithin(testRoot, receipt)) {
    app.exitCode = 2;
    app.quit();
    return true;
  }
  const installCodex = process.argv.includes("--morrow-smoke-install-codex");
  let configured = false;
  let health = { attempted: false, gatewayReady: false, bridgeConnected: false };
  let runtimeTrace = unavailableSmokeRuntimeTrace();
  let stateSecurity = unavailableSmokeStateSecurity();
  try {
    await installer.ensureRuntime();
    await installer.executeCli([
      "setup", "--repository", installer.paths.appRoot, "--upstreams", installer.paths.upstreams,
      "--node", installer.paths.node, "--state-directory", installer.paths.state, "--json"
    ]);
    const materials = await installer.effectiveWorkspace();
    if (!materials) throw new Error("materials unavailable");
    if (installCodex) {
      await installer.executeCli([
        "mcp", "install", "codex", "--scope", "user",
        "--repository", installer.paths.appRoot, "--upstreams", installer.paths.upstreams,
        "--node", installer.paths.node, "--server-entry", installer.paths.server,
        "--workspace-root", materials, "--json"
      ]);
      configured = await exists(path.join(installer.home, ".codex", "config.toml"));
    }
    const runtime = await installer.runtimeSnapshot(materials);
    health = {
      attempted: runtime.health.attempted === true,
      gatewayReady: runtime.health.gatewayReady === true,
      bridgeConnected: runtime.health.bridgeConnected === true
    };
    runtimeTrace = await currentSmokeRuntimeTrace().catch(() => unavailableSmokeRuntimeTrace());
    stateSecurity = await smokeStateSecurity(installer.paths, installer.userData);
    const codexConfig = path.join(installer.home, ".codex", "config.toml");
    await writeSmokeReceipt(receipt, {
      schema: "morrow.desktop-windows-smoke.v1",
      runtime: { ready: await isComplete(installer.paths.payload) },
      payload: { withinResources: isWithin(process.resourcesPath, installer.paths.payload) },
      state: { withinTestRoot: isWithin(testRoot, installer.paths.state) },
      codexConfig: { withinTestRoot: isWithin(testRoot, codexConfig), exists: configured },
      health,
      runtimeTrace,
      stateSecurity
    });
  } catch {
    runtimeTrace = await currentSmokeRuntimeTrace().catch(() => unavailableSmokeRuntimeTrace());
    stateSecurity = await smokeStateSecurity(installer.paths, installer.userData).catch(() => unavailableSmokeStateSecurity());
    await writeSmokeReceipt(receipt, {
      schema: "morrow.desktop-windows-smoke.v1",
      runtime: { ready: false },
      payload: { withinResources: isWithin(process.resourcesPath, installer.paths.payload) },
      state: { withinTestRoot: isWithin(testRoot, installer.paths.state) },
      codexConfig: { withinTestRoot: true, exists: false },
      health,
      runtimeTrace,
      stateSecurity
    }).catch(() => {});
  }
  app.quit();
  return true;
}

/**
 * The Windows smoke harness waits for a receipt. A second Morrow started while
 * the first one holds the single-instance lock never runs the smoke, so it
 * records exactly that in a receipt of fixed size instead of leaving the
 * harness to wait for a file that has no author. `wx` keeps the receipt the
 * running instance may already have written.
 */
async function writeConcurrentStartSmokeReceipt() {
  const receipt = requestedArgument("morrow-smoke-receipt");
  if (!receipt || !IS_TEST_MODE || !testRoot || !path.isAbsolute(receipt) || !isWithin(testRoot, receipt)) return false;
  await mkdirPrivate(path.dirname(receipt));
  const refusal = { schema: "morrow.desktop-windows-smoke-refused.v1", start: "refused", reason: "another_instance_holds_the_single_instance_lock" };
  await fs.writeFile(receipt, `${JSON.stringify(refusal)}\n`, { mode: 0o600, flag: "wx" });
  return true;
}

function trusted(event, window = mainWindow) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("Untrusted installer request.");
  const expected = pathToFileURL(fsSync.realpathSync(path.join(__dirname, "renderer", "index.html"))).href;
  if (event.senderFrame.url !== expected) throw new Error("Untrusted installer request.");
}

function noInput(input) {
  if (input.length !== 0) throw errorDetails("setup_failed");
}

/**
 * The failure answer for one setup action. The state is read again so the
 * setup page shows what Morrow has now, and falls back to the fixed repair
 * state when that read itself fails. An error that carries a code is forwarded
 * to the strict result contract, which emits only the fixed public details for
 * that code; an error the contract refuses — a code outside the public list,
 * such as an MCP -32603 — and an error with no code each collapse to the fixed
 * setup_failed details, so no internal message or path ever reaches the
 * renderer.
 */
async function failed(error) {
  const state = await installer.state().catch(() => repairRequiredState());
  try {
    return envelope(state, error?.code ? error : errorDetails("setup_failed"));
  } catch {
    return envelope(state, errorDetails("setup_failed"));
  }
}

async function respond(options) {
  try { return envelope(await installer.state(options), null); } catch { return failed(errorDetails("setup_failed")); }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 940,
    height: 720,
    minWidth: 320,
    minHeight: 640,
    show: false,
    title: "Morrow",
    backgroundColor: "#F5F4EE",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

/**
 * Brings the window Morrow already has back to the front. A start that cannot
 * take the single-instance lock has nothing of its own to show, so the answer
 * to it is the window that exists.
 */
function focusExistingWindow(window) {
  if (!window || window.isDestroyed()) return false;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return true;
}

/**
 * Morrow runs as one instance. A second one would build its own
 * InstallerController, start a second runtime monitor over the same journal,
 * and ask for the same local-owner maintenance lease, which acquireRestartLease
 * can only guard inside one process. The instance that holds the lock keeps
 * that ownership, so every later start returns the focus to it and quits.
 *
 * `currentWindow` is read when a second instance starts, not now: the window
 * exists only after startMorrow() creates it. The second instance's command
 * line stays unread, so one Morrow never takes an instruction from another.
 */
function claimSingleInstance(target, currentWindow) {
  if (!target.requestSingleInstanceLock()) return false;
  target.on("second-instance", () => focusExistingWindow(currentWindow()));
  return true;
}

async function startMorrow() {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  installer = createInstallerController({
    app,
    dialog,
    shell,
    platform: process.platform,
    homeDirectory: testRoot ? path.join(testRoot, "Home") : os.homedir(),
    testRoot,
    isTestMode: IS_TEST_MODE,
    payloadRoot: fixedPayloadRoot(),
    productVersion: PRODUCT_VERSION,
    trustedBridgeReleaseManifestSha256,
    trustedMcpRuntimeManifestSha256,
    detectAssistant,
    updateSnapshot: () => updateController?.snapshot()
  });
  await installer.initializeBridgeAtStartup().catch(() => {});
  updateController = createAppUpdateController();
  await updateController.start();
  if (await runDesktopSmokeIfRequested()) return;
  // Check status is the one state read that looks at this computer again. Every
  // other read, including the one on window focus, uses what Morrow already read.
  ipcMain.handle("installer:get-state", async (event, ...input) => {
    trusted(event);
    return respond({ recheckAssistants: input[0]?.recheckAssistants === true });
  });
  ipcMain.handle("installer:choose-workspace", async (event) => {
    trusted(event);
    try {
      // Choosing a folder also binds every configured assistant to it, so this
      // answers with the state that step reached, and with the exact reason
      // when part of it did not finish.
      const selected = await installer.configureWorkspace(mainWindow);
      return selected ? respond() : failed(errorDetails("cancelled"));
    } catch (error) {
      return failed(error);
    }
  });
  ipcMain.handle("installer:configure-blackboard", async (event, input) => {
    trusted(event);
    try {
      await installer.configureBlackboard(input);
      return respond();
    } catch {
      return failed(errorDetails("blackboard_configuration_invalid"));
    }
  });
  ipcMain.handle("installer:select-blackboard-courses", async (event, input) => {
    trusted(event);
    try {
      await installer.selectBlackboardCourses(input);
      return respond();
    } catch {
      return failed(errorDetails("blackboard_course_selection_invalid"));
    }
  });
  // Removal answers with the state Morrow read back from its own files, so a
  // secret this computer still holds is never reported as removed.
  ipcMain.handle("installer:remove-blackboard-tenant", async (event, input) => {
    trusted(event);
    try {
      await installer.removeBlackboardTenant(input);
      return respond();
    } catch {
      return failed(errorDetails("blackboard_removal_failed"));
    }
  });
  ipcMain.handle("installer:install-assistant", async (event, input) => {
    trusted(event);
    try {
      if (!input || typeof input !== "object" || Object.keys(input).length !== 1) throw new TypeError("invalid input");
      await installer.installAssistant(assertAssistantId(input.assistantId), mainWindow);
      return respond();
    } catch (error) {
      return failed(error);
    }
  });
  ipcMain.handle("installer:remove-assistant", async (event, input) => {
    trusted(event);
    try {
      if (!input || typeof input !== "object" || Object.keys(input).length !== 1) throw new TypeError("invalid input");
      await installer.removeAssistant(assertAssistantId(input.assistantId));
      return respond();
    } catch (error) {
      return failed(error);
    }
  });
  ipcMain.handle("installer:reveal-bridge-folder", async (event) => {
    trusted(event);
    try { await installer.revealBridgeFolder(); return respond(); }
    catch { return failed(errorDetails("bridge_folder_unavailable")); }
  });
  ipcMain.handle("installer:reconcile-bridge", async (event, ...input) => {
    trusted(event);
    try {
      noInput(input);
    } catch (error) {
      return failed(error);
    }
    try {
      await installer.reconcileBridgeRelease();
      return respond();
    } catch (error) {
      return failed(error?.code === "runtime_repair_required" ? error : errorDetails("bridge_check_failed"));
    }
  });
  ipcMain.handle("installer:check-for-updates", async (event, ...input) => {
    trusted(event);
    try {
      noInput(input);
      await updateController.check();
      return respond();
    } catch (error) {
      return failed(error);
    }
  });
  ipcMain.handle("installer:install-update", async (event, ...input) => {
    trusted(event);
    try {
      noInput(input);
      await updateController.installWhenIdle();
      return respond();
    } catch (error) {
      return failed(error);
    }
  });
  ipcMain.handle("installer:run-first-read", async (event, ...input) => {
    trusted(event);
    try {
      noInput(input);
      await installer.firstSafeRead();
      return respond();
    } catch (error) {
      return failed(error);
    }
  });
  ipcMain.handle("installer:open-claude-desktop", async (event, ...input) => {
    trusted(event);
    try {
      noInput(input);
      await installer.openClaudeDesktop();
      return respond();
    } catch (error) {
      return failed(error);
    }
  });
  ipcMain.handle("installer:reveal-claude-extension", async (event, ...input) => {
    trusted(event);
    try {
      noInput(input);
      await installer.revealClaudeDesktopBundle();
      return respond();
    } catch (error) {
      return failed(error);
    }
  });
  ipcMain.handle("installer:repair", async (event, ...input) => {
    trusted(event);
    try {
      noInput(input);
      // Repair returns the state it reached, so the answer is that state and
      // never a separate claim that the repair succeeded.
      return envelope(await installer.repair(), null);
    } catch (error) {
      return failed(error);
    }
  });
  ipcMain.handle("installer:remove-data", async (event, ...input) => {
    trusted(event);
    try {
      noInput(input);
      // The removal reports which paths are gone and which remain inside the
      // state it returns, so the answer is that state and never a separate
      // claim that everything was removed.
      await installer.removeData(mainWindow);
      return respond();
    } catch (error) {
      return failed(error);
    }
  });
  createWindow();
}

if (claimSingleInstance(app, () => mainWindow)) {
  app.whenReady().then(startMorrow);
} else {
  // A duplicate start builds no controller, starts no runtime monitor, and
  // writes nothing outside the bounded Windows-smoke receipt.
  app.exitCode = 0;
  writeConcurrentStartSmokeReceipt().catch(() => {}).then(() => app.quit());
}

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on("before-quit", () => {
  updateController?.stop();
  void installer?.closeRuntimeMonitor();
});

// Electron ignores these exports; the installer tests use them to run the real
// guards, the real single-instance decision, and the real access-control
// classification the Windows smoke receipt carries.
module.exports = { claimSingleInstance, focusExistingWindow, smokeWindowsAclClassification, trusted };
