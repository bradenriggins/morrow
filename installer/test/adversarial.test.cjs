"use strict";

/**
 * Adversarial verification of the setup app: the requests, payloads, paths,
 * records and update answers Morrow can be handed by something other than the
 * person using it. Each case runs the shipped code: the real IPC handlers
 * installer/main.cjs registers, the real installer controller, the real update
 * controller: and asserts both halves of the answer: the refusal, and that the
 * step it refused changed nothing.
 *
 * Windows access control cannot be read on this computer. Those cases are
 * skipped with their reason rather than asserted as passing.
 */

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const { createInstallerController } = require("../shared/installer-controller.cjs");
const { captureConfiguration, restoreConfiguration } = require("../shared/runtime.cjs");
const { freshRecord } = require("../shared/state-policy.cjs");
const { createUpdateController } = require("../shared/updates.cjs");

const installerRoot = path.resolve(__dirname, "..");
const electronPath = require.resolve("electron", { paths: [installerRoot] });
const updaterPath = require.resolve("electron-updater", { paths: [installerRoot] });
const adapterPath = require.resolve("../shared/electron-updater-adapter.cjs");
const controllerPath = require.resolve("../shared/installer-controller.cjs");
const updatesPath = require.resolve("../shared/updates.cjs");
const mainPath = require.resolve("../main.cjs");
const canonicalPage = pathToFileURL(fsSync.realpathSync(path.join(installerRoot, "renderer", "index.html"))).href;
// The private-file rules the packaged app runs from its own payload. Present
// only in a built workspace; the cases that need them say so when they skip.
const PRIVATE_FILE_ACCESS = path.join(installerRoot, "..", "packages", "gateway-core", "dist", "private-file-access.js");

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function present(value) {
  return fs.lstat(value).then(() => true, () => false);
}

async function mode(value) {
  return (await fs.lstat(value)).mode & 0o777;
}

/** Replaces one module in the require cache and answers with the undo. */
function plant(id, exports) {
  const previous = require.cache[id];
  require.cache[id] = { id, filename: id, path: path.dirname(id), loaded: true, children: [], paths: [], exports };
  return () => {
    if (previous) require.cache[id] = previous;
    else delete require.cache[id];
  };
}

/**
 * Runs the start installer/main.cjs performs with Electron, the updater and the
 * installer controller injected, and answers with the IPC handlers that start
 * registered, the window guards it installed, and every call those handlers
 * make. The controller and the update controller are recorders, so a refusal
 * that still performed the step is visible as a recorded call.
 */
async function startedMorrow() {
  const calls = [];
  const updateCalls = [];
  const recorded = { calls, updateCalls, handlers: new Map(), events: new Map(), window: null, windowOpen: null, started: null };
  const mainFrame = { url: canonicalPage };
  const webContents = {
    mainFrame,
    on(event, handler) { recorded.events.set(event, handler); return webContents; },
    setWindowOpenHandler(handler) { recorded.windowOpen = handler; }
  };
  const setupState = { schema: "morrow.installer-state.v1", lifecycle: "ready_for_workspace" };
  const answer = (name, value) => async (...args) => { calls.push({ name, args }); return value; };
  const installer = {
    paths: { state: path.join(os.tmpdir(), "morrow-adversarial-start", "State") },
    initializeBridgeAtStartup: answer("initializeBridgeAtStartup", undefined),
    state: answer("state", setupState),
    configureWorkspace: answer("configureWorkspace", true),
    configureBlackboard: answer("configureBlackboard", undefined),
    selectBlackboardCourses: answer("selectBlackboardCourses", undefined),
    removeBlackboardTenant: answer("removeBlackboardTenant", undefined),
    installAssistant: answer("installAssistant", undefined),
    removeAssistant: answer("removeAssistant", undefined),
    revealBridgeFolder: answer("revealBridgeFolder", undefined),
    reconcileBridgeRelease: answer("reconcileBridgeRelease", undefined),
    firstSafeRead: answer("firstSafeRead", undefined),
    openClaudeDesktop: answer("openClaudeDesktop", undefined),
    repair: answer("repair", setupState),
    removeData: answer("removeData", undefined),
    acquireRestartLease: answer("acquireRestartLease", { status: "uncertain" }),
    releaseRestartLease: answer("releaseRestartLease", undefined),
    commitRestartLease: answer("commitRestartLease", undefined),
    closeRuntimeMonitor: answer("closeRuntimeMonitor", undefined)
  };
  const updateController = {
    snapshot: () => null,
    async start() { updateCalls.push("start"); },
    async check() { updateCalls.push("check"); },
    async installWhenIdle() { updateCalls.push("installWhenIdle"); },
    stop() { updateCalls.push("stop"); }
  };
  const undo = [
    plant(electronPath, {
      app: {
        isPackaged: false,
        getVersion: () => "1.0.0-rc.0",
        getPath: () => path.join(os.tmpdir(), "morrow-adversarial-start"),
        setPath() {},
        requestSingleInstanceLock: () => true,
        // main.cjs starts Morrow from app.whenReady().then(startMorrow) and
        // drops that promise. Holding it here is what lets the test await the
        // start instead of racing it.
        whenReady: () => ({ then(onReady) { recorded.started = Promise.resolve().then(onReady); return recorded.started; } }),
        on() {},
        quit() {}
      },
      BrowserWindow: class {
        constructor(options) { this.options = options; this.webContents = webContents; recorded.window = this; }
        once() {}
        show() {}
        loadFile() {}
      },
      dialog: {},
      ipcMain: { handle(channel, handler) { recorded.handlers.set(channel, handler); } },
      session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
      shell: {}
    }),
    plant(updaterPath, { autoUpdater: {} }),
    plant(adapterPath, { createElectronUpdaterAdapter: () => ({ identity: {} }) }),
    plant(updatesPath, { ...require("../shared/updates.cjs"), createUpdateController: () => updateController }),
    plant(controllerPath, { ...require("../shared/installer-controller.cjs"), createInstallerController: () => installer })
  ];
  const payload = process.env.MORROW_INSTALLER_PAYLOAD;
  process.env.MORROW_INSTALLER_PAYLOAD = path.join(os.tmpdir(), "morrow-adversarial-payload");
  delete require.cache[mainPath];
  try {
    require(mainPath);
    assert.notEqual(recorded.started, null, "Morrow never reached app.whenReady()");
    await recorded.started;
  } finally {
    delete require.cache[mainPath];
    for (const restore of undo.reverse()) restore();
    if (payload === undefined) delete process.env.MORROW_INSTALLER_PAYLOAD;
    else process.env.MORROW_INSTALLER_PAYLOAD = payload;
  }
  calls.length = 0;
  updateCalls.length = 0;
  return recorded;
}

/** Loads installer/main.cjs for its exported guards, without starting it. */
function loadMain() {
  const restore = plant(electronPath, {
    app: {
      isPackaged: false,
      getVersion: () => "1.0.0-rc.0",
      getPath: () => installerRoot,
      setPath() {},
      requestSingleInstanceLock: () => true,
      whenReady: () => new Promise(() => {}),
      on() {},
      quit() {}
    },
    BrowserWindow: class {},
    dialog: {},
    ipcMain: { handle() {} },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
    shell: {}
  });
  delete require.cache[mainPath];
  try {
    return require(mainPath);
  } finally {
    delete require.cache[mainPath];
    restore();
  }
}

function trustedRequest(started) {
  return { sender: started.window.webContents, senderFrame: started.window.webContents.mainFrame };
}

async function temporaryRoot(t, label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `morrow-adversarial-${label}-`));
  await fs.mkdir(path.join(root, "UserData"), { recursive: true });
  await fs.mkdir(path.join(root, "Home"), { recursive: true });
  await fs.mkdir(path.join(root, "Payload"), { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
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
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showMessageBox: async () => ({ response: 0 })
    },
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
 * `verifyMcpRuntime` accepts, and answers with that manifest digest. With
 * `privateFileAccess`, the payload also carries the real private-file rules the
 * packaged app imports from it.
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
  await fs.writeFile(path.join(app, "installer", "runtime-monitor.mjs"), "export function createRuntimeMonitor() { return {}; }\n");

  const gatewayFiles = [
    ["package.json", JSON.stringify({ name: "@morrow-lms/gateway", version: "1.0.0-rc.0", type: "module" })],
    ["dist/index.js", "gateway entrypoint"],
    ["dist/local-owner-maintenance.js", "export function localOwnerMaintenanceMarkerPresent() { return false; }\n"],
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
  if (options.privateFileAccess) {
    const core = path.join(app, "node_modules", "@morrow", "gateway-core", "dist");
    await fs.mkdir(core, { recursive: true });
    await fs.copyFile(PRIVATE_FILE_ACCESS, path.join(core, "private-file-access.js"));
    await fs.writeFile(path.join(core, "index.js"), 'export * from "./private-file-access.js";\n');
  }
  return manifestSha256;
}

test("every setup action refuses a request that is not the canonical setup page in the window's main frame", async () => {
  const started = await startedMorrow();
  assert.equal(started.handlers.size > 0, true, "the start registered no IPC handler");
  const frame = started.window.webContents.mainFrame;
  const senders = [
    ["a frame that is not the window's main frame", { sender: started.window.webContents, senderFrame: { url: canonicalPage } }],
    ["a page that is not the window's own", { sender: { mainFrame: frame }, senderFrame: frame }],
    ["a request that carries no frame", { sender: started.window.webContents, senderFrame: null }]
  ];
  for (const [label, request] of senders) {
    for (const [channel, handler] of started.handlers) {
      await assert.rejects(() => handler(request, { assistantId: "codex" }), /Untrusted installer request\./, `${channel} answered ${label}`);
      assert.deepEqual(started.calls, [], `${channel} acted on ${label}`);
    }
  }
  // The window's own main frame, showing something other than the setup page
  // this app ships. The third address is that exact file reached by a spelling
  // the canonical form does not have.
  for (const address of [
    "https://example.edu/index.html",
    `${canonicalPage}?assistant=codex`,
    `${pathToFileURL(installerRoot).href}/renderer/./index.html`
  ]) {
    frame.url = address;
    for (const [channel, handler] of started.handlers) {
      await assert.rejects(() => handler(trustedRequest(started), { assistantId: "codex" }), /Untrusted installer request\./, `${channel} answered ${address}`);
      assert.deepEqual(started.calls, [], `${channel} acted on ${address}`);
    }
  }

  frame.url = canonicalPage;
  const answered = await started.handlers.get("installer:get-state")(trustedRequest(started));
  assert.equal(answered.ok, true, "the canonical setup page is refused as well");
  assert.deepEqual(started.calls.map((call) => call.name), ["state"]);
});

test("an assistant request with an extra key, a wrong shape, or an unknown assistant sets up nothing", async () => {
  const started = await startedMorrow();
  const request = trustedRequest(started);
  for (const [channel, method] of [["installer:install-assistant", "installAssistant"], ["installer:remove-assistant", "removeAssistant"]]) {
    const handler = started.handlers.get(channel);
    for (const payload of [
      { assistantId: "codex", scope: "user" },
      { assistantId: "codex", target: path.join(os.homedir(), ".codex", "config.toml") },
      { assistantId: "not-an-assistant" },
      ["codex"],
      "codex",
      null,
      undefined,
      {}
    ]) {
      started.calls.length = 0;
      const refused = await handler(request, payload);
      assert.equal(refused.ok, false, `${channel} accepted ${JSON.stringify(payload) ?? String(payload)}`);
      assert.equal(refused.error.code, "setup_failed");
      assert.deepEqual(started.calls.filter((call) => call.name === method), [], `${channel} acted on ${JSON.stringify(payload) ?? String(payload)}`);
    }
    started.calls.length = 0;
    const accepted = await handler(request, { assistantId: "codex" });
    assert.equal(accepted.ok, true);
    assert.deepEqual(started.calls.filter((call) => call.name === method).map((call) => call.args[0]), ["codex"]);
  }
});

test("every action that takes no input refuses one, and performs its step only without it", async () => {
  const started = await startedMorrow();
  const request = trustedRequest(started);
  // channel -> what performing it would record. The two update channels reach
  // the update controller instead of the installer controller.
  const inputFree = [
    ["installer:reconcile-bridge", "reconcileBridgeRelease", null],
    ["installer:check-for-updates", null, "check"],
    ["installer:install-update", null, "installWhenIdle"],
    ["installer:run-first-read", "firstSafeRead", null],
    ["installer:open-claude-desktop", "openClaudeDesktop", null],
    ["installer:repair", "repair", null],
    ["installer:remove-data", "removeData", null]
  ];
  for (const [channel, method, updateMethod] of inputFree) {
    const handler = started.handlers.get(channel);
    for (const argument of [{}, { confirm: true }, "", 0, null, undefined, ["codex"]]) {
      started.calls.length = 0;
      started.updateCalls.length = 0;
      const refused = await handler(request, argument);
      assert.equal(refused.ok, false, `${channel} accepted an argument`);
      assert.equal(refused.error.code, "setup_failed");
      if (method) assert.deepEqual(started.calls.filter((call) => call.name === method), [], `${channel} acted on an argument`);
      assert.deepEqual(started.updateCalls, [], `${channel} reached the update controller with an argument`);
    }
    started.calls.length = 0;
    started.updateCalls.length = 0;
    const accepted = await handler(request);
    assert.equal(accepted.ok, true, `${channel} refused a request with no input`);
    if (method) assert.equal(started.calls.filter((call) => call.name === method).length, 1);
    if (updateMethod) assert.deepEqual(started.updateCalls, [updateMethod]);
  }
});

test("the setup window navigates nowhere, opens nothing, and embeds nothing, whatever the address", async () => {
  const started = await startedMorrow();
  const addresses = [
    "https://example.edu/",
    "file:///etc/passwd",
    `${pathToFileURL(installerRoot).href}/package.json`,
    "javascript:fetch('https://example.edu')",
    "data:text/html,<script>1</script>",
    canonicalPage
  ];
  for (const event of ["will-navigate", "will-attach-webview"]) {
    const handler = started.events.get(event);
    assert.equal(typeof handler, "function", `the window installs no ${event} guard`);
    for (const address of addresses) {
      let prevented = false;
      handler({ preventDefault() { prevented = true; } }, address);
      assert.equal(prevented, true, `${event} allowed ${address}`);
    }
  }
  for (const address of addresses) assert.deepEqual(started.windowOpen({ url: address }), { action: "deny" }, `a new window was allowed for ${address}`);
});

test("a duplicate start registers no setup action at all", async (t) => {
  const root = await temporaryRoot(t, "duplicate-start");
  const channels = [];
  const constructions = [];
  let exitCode = null;
  let quitted = null;
  const quit = new Promise((resolve) => { quitted = resolve; });
  const undo = [
    plant(electronPath, {
      app: {
        isPackaged: false,
        getVersion: () => "1.0.0-rc.0",
        getPath: () => path.join(root, "UserData"),
        setPath() {},
        requestSingleInstanceLock: () => false,
        whenReady: () => new Promise(() => {}),
        on() {},
        quit() { quitted(); },
        set exitCode(value) { exitCode = value; },
        get exitCode() { return exitCode; }
      },
      BrowserWindow: class {},
      dialog: {},
      ipcMain: { handle(channel) { channels.push(channel); } },
      session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
      shell: {}
    }),
    plant(controllerPath, {
      ...require("../shared/installer-controller.cjs"),
      createInstallerController: (dependencies) => { constructions.push(dependencies); return {}; }
    })
  ];
  const payload = process.env.MORROW_INSTALLER_PAYLOAD;
  process.env.MORROW_INSTALLER_PAYLOAD = path.join(root, "Payload");
  delete require.cache[mainPath];
  try {
    require(mainPath);
    await quit;
  } finally {
    delete require.cache[mainPath];
    for (const restore of undo.reverse()) restore();
    if (payload === undefined) delete process.env.MORROW_INSTALLER_PAYLOAD;
    else process.env.MORROW_INSTALLER_PAYLOAD = payload;
  }
  assert.deepEqual(channels, [], "the duplicate start exposed setup actions of its own");
  assert.deepEqual(constructions, [], "the duplicate start built an installer controller");
  assert.equal(exitCode, 0);
  assert.deepEqual(await fs.readdir(path.join(root, "UserData")), []);
});

test("a sealed payload file replaced by a link to identical bytes is refused", async (t) => {
  const root = await temporaryRoot(t, "payload-link");
  const manifestSha256 = await completePayload(root);
  const verified = controller(root, { trustedMcpRuntimeManifestSha256: () => manifestSha256 });
  assert.equal((await verified.ensureRuntime()).payload, path.join(root, "Payload"));

  const entrypoint = path.join(root, "Payload", "app", "packages", "mcp-server", "dist", "index.js");
  const elsewhere = path.join(root, "gateway-entrypoint.js");
  await fs.copyFile(entrypoint, elsewhere);
  await fs.rm(entrypoint);
  await fs.symlink(elsewhere, entrypoint);
  assert.equal(await fs.readFile(entrypoint, "utf8"), await fs.readFile(elsewhere, "utf8"), "the link reads as the sealed bytes");

  // A controller that has not verified this payload yet reads it from disk.
  const relinked = controller(root, { trustedMcpRuntimeManifestSha256: () => manifestSha256 });
  await assert.rejects(() => relinked.ensureRuntime(), (error) => error.code === "runtime_repair_required");
  const state = await relinked.state();
  assert.equal(state.lifecycle, "repair_required");
  assert.equal(state.runtime.status, "repair_required");
});

test("the data removal removes the folder Morrow named and never a folder a link points at", async (t) => {
  const root = await temporaryRoot(t, "materials-link");
  const installer = controller(root, {
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showMessageBox: async () => ({ response: 1 })
    }
  });
  const documents = path.join(root, "Home", "Documents");
  await fs.mkdir(documents, { recursive: true });
  await fs.writeFile(path.join(documents, "syllabus.docx"), "course materials");
  const materials = path.join(root, "UserData", "Materials");
  await fs.symlink(documents, materials, "dir");
  await installer.writeRecord(freshRecord());

  // The folder Morrow works in is the folder the link resolves to, read once,
  // so no later step acts on two different names for one folder.
  assert.equal(await installer.effectiveWorkspace(), await fs.realpath(documents));

  const removal = await installer.removeData(null);
  assert.equal(removal.status, "removed");
  assert.equal(removal.removed.includes(materials), true, "the removal did not report the folder it named");
  assert.equal(await present(materials), false, "the link Morrow named is still there");
  assert.deepEqual(await fs.readdir(documents), ["syllabus.docx"]);
  assert.equal(await fs.readFile(path.join(documents, "syllabus.docx"), "utf8"), "course materials");
});

test("an assistant settings file edited by something else is left exactly as it is", async (t) => {
  const root = await temporaryRoot(t, "configuration-conflict");
  const installer = controller(root);
  const target = path.join(root, "Home", ".codex", "config.toml");
  await fs.mkdir(path.dirname(target), { recursive: true });
  const own = '[mcp_servers.morrow]\ncommand = "node"\n';
  await fs.writeFile(target, own);
  const ownDigest = sha256(own);

  // Removing Morrow from the assistant, after something else rewrote the file.
  await installer.writeRecord({ ...freshRecord(), selectedAssistantId: "codex", configured: { codex: { target, sha256: ownDigest } } });
  const edited = '[mcp_servers.morrow]\ncommand = "node"\nargs = ["--inspect"]\n';
  await fs.writeFile(target, edited);
  await assert.rejects(() => installer.removeAssistant("codex"), (error) => {
    assert.equal(error.code, "assistant_configuration_changed");
    assert.equal(error.recovery.includes(target), true, "the recovery step does not name the file");
    return true;
  });
  assert.equal(await fs.readFile(target, "utf8"), edited);
  assert.deepEqual((await installer.record()).configured.codex, { target, sha256: ownDigest }, "a refused removal changed the record");

  // The rollback of a failed setup, against a file a third process rewrote
  // between the copy and that rollback.
  const backups = path.join(root, "UserData", "State", "Backups");
  await fs.writeFile(target, own);
  const snapshot = await captureConfiguration(target, backups);
  const written = '[mcp_servers.morrow]\ncommand = "/morrow/node"\n';
  await fs.writeFile(target, written);
  const newer = '[mcp_servers.other]\ncommand = "other"\n';
  await fs.writeFile(target, newer);
  assert.equal(await restoreConfiguration(snapshot, sha256(written)), false);
  assert.equal(await fs.readFile(target, "utf8"), newer, "the rollback replaced an edit made after Morrow wrote the file");

  // The same rollback, against the file Morrow itself last wrote.
  await fs.writeFile(target, written);
  assert.equal(await restoreConfiguration(snapshot, sha256(written)), true);
  assert.equal(await fs.readFile(target, "utf8"), own);
});

test("a record from a version this app cannot read asks for repair and is never quietly replaced", async (t) => {
  const root = await temporaryRoot(t, "migration");
  const installer = controller(root);
  const stateDirectory = path.join(root, "UserData", "State");
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const later = { schema: "morrow.desktop-state.v1", version: 2, configured: {}, materialsFolder: path.join(root, "UserData", "Materials") };
  const stored = `${JSON.stringify(later)}\n`;
  await fs.writeFile(path.join(stateDirectory, "installer.json"), stored, { mode: 0o600 });

  await assert.rejects(() => installer.record(), /migration_required/);
  const state = await installer.state();
  assert.equal(state.lifecycle, "repair_required");
  assert.equal(state.runtime.status, "repair_required");
  assert.equal(await fs.readFile(path.join(stateDirectory, "installer.json"), "utf8"), stored, "the state read replaced a record it could not use");
  await assert.rejects(() => installer.writeRecord(later), /migration_required/);
  assert.equal(await fs.readFile(path.join(stateDirectory, "installer.json"), "utf8"), stored);
});

test("the installer record is a private file inside a private folder", {
  skip: process.platform === "win32" ? "POSIX modes; the Windows access-control classification needs a Windows host" : false
}, async (t) => {
  const root = await temporaryRoot(t, "record-modes");
  const installer = controller(root);
  await installer.writeRecord({ ...freshRecord(), selectedAssistantId: "codex" });
  const stateDirectory = path.join(root, "UserData", "State");
  assert.equal(await mode(stateDirectory), 0o700);
  assert.equal(await mode(path.join(stateDirectory, "installer.json")), 0o600);
  assert.deepEqual((await fs.readdir(stateDirectory)), ["installer.json"], "a temporary record file was left behind");
});

test("a Blackboard credential folder that is a link is refused, and no secret is written through it", {
  skip: fsSync.existsSync(PRIVATE_FILE_ACCESS) ? false : "packages/gateway-core is not built; the private-file rules the app imports are unavailable"
}, async (t) => {
  const root = await temporaryRoot(t, "blackboard-link");
  const manifestSha256 = await completePayload(root, { privateFileAccess: true });
  const installer = controller(root, {
    trustedMcpRuntimeManifestSha256: () => manifestSha256,
    discoverBlackboardConnection: async () => ({ principalId: "_123_1", courses: [] })
  });
  const home = path.join(root, "Home");
  const elsewhere = path.join(root, "Elsewhere");
  await fs.mkdir(elsewhere, { recursive: true });
  const morrowDirectory = path.join(home, ".morrow");
  await fs.mkdir(morrowDirectory, { recursive: true, mode: 0o700 });
  const privateFileAccess = await import(pathToFileURL(PRIVATE_FILE_ACCESS).href);
  assert.equal(privateFileAccess.hardenPrivateDirectory(morrowDirectory, { trustedRoot: home }), true,
    "the fixture's app-owned ancestor must be private before the adversarial link is added");
  const credentials = path.join(morrowDirectory, "credentials");
  await fs.symlink(elsewhere, credentials, "dir");

  const connection = {
    baseUrl: "https://learn.example.edu/",
    applicationKey: "application-key-for-example",
    applicationSecret: "credential-for-example"
  };
  await assert.rejects(() => installer.configureBlackboard({ ...connection }), /Blackboard credential directory is unavailable/);
  assert.deepEqual(await fs.readdir(elsewhere), [], "the refused setup wrote through the link");
  assert.equal(await present(path.join(home, ".morrow", "blackboard-learn.json")), false);

  // The same folder, without the link, is accepted and made private, so the
  // refusal above is about the link and not about this computer.
  await fs.rm(credentials);
  const directory = path.join(credentials, "blackboard");
  await installer.prepareBlackboardCredentialDirectories(directory);
  assert.equal((await fs.lstat(directory)).isDirectory(), true);
  if (process.platform !== "win32") assert.equal(await mode(directory), 0o700);
});

test("a Blackboard removal request that names more than the connection removes nothing", async (t) => {
  const root = await temporaryRoot(t, "blackboard-removal");
  const installer = controller(root);
  // The request is refused on its shape alone, before Morrow reads any file,
  // so a request carrying a second instruction never reaches the credential.
  for (const request of [{ tenantId: "learn-example-edu", force: true }, ["learn-example-edu"], "learn-example-edu", {}, null]) {
    await assert.rejects(() => installer.removeBlackboardTenant(request), /Blackboard removal request is invalid/);
  }
  assert.equal(await present(path.join(root, "Home", ".morrow")), false);
});

test("the Blackboard secret is a private file inside a private folder", {
  skip: process.platform === "win32"
    ? "POSIX modes; the Windows access-control classification needs a Windows host"
    : fsSync.existsSync(PRIVATE_FILE_ACCESS) ? false : "packages/gateway-core is not built; the private-file rules the app imports are unavailable"
}, async (t) => {
  const root = await temporaryRoot(t, "blackboard-modes");
  const manifestSha256 = await completePayload(root, { privateFileAccess: true });
  const installer = controller(root, { trustedMcpRuntimeManifestSha256: () => manifestSha256 });
  const directory = path.join(root, "Home", ".morrow", "credentials", "blackboard");
  const destination = path.join(directory, "learn-example-edu.secret");
  await installer.writeBlackboardCredential({
    directory,
    destination,
    credentialRevision: crypto.randomUUID(),
    applicationSecret: "credential-for-example"
  });
  assert.equal(await mode(directory), 0o700);
  assert.equal(await mode(path.dirname(directory)), 0o700);
  assert.equal(await mode(destination), 0o600);
  assert.deepEqual(await fs.readdir(directory), ["learn-example-edu.secret"], "a temporary secret file was left behind");
  assert.equal(JSON.parse(await fs.readFile(destination, "utf8")).applicationSecret, "credential-for-example");
});

test("the smoke access-control classification makes no Windows call on this computer", {
  skip: process.platform === "win32" ? "this case is the answer off Windows" : false
}, () => {
  const { smokeWindowsAclClassification } = loadMain();
  assert.equal(smokeWindowsAclClassification(path.join(os.tmpdir(), "morrow-adversarial-no-such-path")), "not_windows");
  assert.equal(smokeWindowsAclClassification(installerRoot), "not_windows");
});

test("the smoke access-control classification reads a real Windows access-control list", {
  skip: process.platform === "win32" ? false : "Windows access control needs a Windows host"
}, () => {
  const { smokeWindowsAclClassification } = loadMain();
  const answer = smokeWindowsAclClassification(installerRoot);
  assert.notEqual(answer, "not_windows");
  assert.equal([
    "current_user_system_admin_sensitive_access_only",
    "additional_principal_sensitive_access_allow",
    "untrusted_owner",
    "unresolved_identity",
    "unavailable"
  ].includes(answer), true, `unknown access-control classification ${answer}`);
});

/** The updater surface the update controller drives, recording what it is asked to do. */
function updateAdapter(options = {}) {
  const listeners = new Map();
  const adapter = {
    identity: { currentVersion: "1.0.0", platform: "darwin", arch: "arm64", feedId: "morrow-desktop-stable" },
    downloads: 0,
    installs: 0,
    on(event, listener) {
      const values = listeners.get(event) || new Set();
      values.add(listener);
      listeners.set(event, values);
      return () => values.delete(listener);
    },
    emit(event, value) { for (const listener of listeners.get(event) || []) listener(value); },
    async checkForUpdates() { return options.check ? options.check() : { isUpdateAvailable: false }; },
    async downloadUpdate() { adapter.downloads += 1; },
    async quitAndInstall() { adapter.installs += 1; }
  };
  return adapter;
}

function enabledPolicy() {
  return { enabled: true, automatic: false, feed: { id: "morrow-desktop-stable" } };
}

function settled() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("an update announced for another computer, another architecture, or an unreleased build downloads nothing", async () => {
  const cases = [
    [{ version: "1.0.1", platform: "win32", arch: "arm64" }, "update_platform_mismatch"],
    [{ version: "1.0.1", platform: "darwin", arch: "x64" }, "update_arch_mismatch"],
    [{ version: "1.0.1-beta.1", platform: "darwin", arch: "arm64" }, "update_prerelease_unavailable"],
    [{ version: "0.9.9", platform: "darwin", arch: "arm64" }, "update_version_not_newer"],
    [{ version: "1.0.0", platform: "darwin", arch: "arm64" }, "update_version_not_newer"],
    [{ version: "1.0.1.1", platform: "darwin", arch: "arm64" }, "update_version_invalid"]
  ];
  for (const [candidate, reason] of cases) {
    // The updater's own event, which arrives without a check of Morrow's.
    const announced = updateAdapter();
    const controllerForEvent = createUpdateController({
      adapter: announced,
      policy: enabledPolicy(),
      acquireRestartLease: async () => ({ status: "granted", leaseId: "idle-lease" }),
      releaseRestartLease: async () => undefined,
      commitRestartLease: async () => ({ status: "closing" })
    });
    await controllerForEvent.start();
    announced.emit("update-available", { updateInfo: candidate });
    assert.equal(controllerForEvent.snapshot().status, "error", `${candidate.version} was accepted`);
    assert.equal(controllerForEvent.snapshot().reason, reason);
    assert.equal(announced.downloads, 0, `${candidate.version} started a download`);

    // The same candidate delivered as a finished download.
    const delivered = updateAdapter();
    const controllerForDownload = createUpdateController({
      adapter: delivered,
      policy: enabledPolicy(),
      acquireRestartLease: async () => ({ status: "granted", leaseId: "idle-lease" }),
      releaseRestartLease: async () => undefined,
      commitRestartLease: async () => ({ status: "closing" })
    });
    await controllerForDownload.start();
    delivered.emit("update-downloaded", candidate);
    assert.equal(controllerForDownload.snapshot().status, "error", `${candidate.version} was accepted as downloaded`);
    assert.equal(controllerForDownload.snapshot().availableVersion, null);
    assert.equal((await controllerForDownload.installWhenIdle()).status, "error");
    assert.equal(delivered.installs, 0, `${candidate.version} was handed to the updater`);
    controllerForEvent.stop();
    controllerForDownload.stop();
  }
});

test("a verified update stays ready through a later no-update answer, error, or announcement", async () => {
  const adapter = updateAdapter({ check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }) });
  const controllerForUpdate = createUpdateController({
    adapter,
    policy: enabledPolicy(),
    acquireRestartLease: async () => ({ status: "uncertain" }),
    releaseRestartLease: async () => undefined,
    commitRestartLease: async () => ({ status: "closing" })
  });
  await controllerForUpdate.start();
  adapter.emit("update-downloaded", { version: "1.0.1" });
  assert.equal(controllerForUpdate.snapshot().status, "ready");

  adapter.emit("update-not-available", { version: "1.0.0" });
  adapter.emit("error", Object.assign(new Error("connection refused"), { code: "ENOTFOUND" }));
  adapter.emit("checking-for-update");
  adapter.emit("update-available", { updateInfo: { version: "2.0.0" } });
  adapter.emit("update-cancelled", { version: "1.0.1" });
  const ready = controllerForUpdate.snapshot();
  assert.equal(ready.status, "ready");
  assert.equal(ready.availableVersion, "1.0.1");
  assert.equal(ready.reason, null);
  controllerForUpdate.stop();
});

test("work Morrow cannot confirm is idle keeps a verified update ready and hands nothing to the updater", async () => {
  const leases = [];
  const adapter = updateAdapter({ check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }) });
  const controllerForUpdate = createUpdateController({
    adapter,
    policy: enabledPolicy(),
    acquireRestartLease: async () => { leases.push("acquire"); return { status: "uncertain" }; },
    releaseRestartLease: async () => { leases.push("release"); },
    commitRestartLease: async () => { leases.push("commit"); return { status: "closing" }; }
  });
  await controllerForUpdate.start();
  adapter.emit("update-downloaded", { version: "1.0.1" });

  const deferred = await controllerForUpdate.installWhenIdle();
  assert.equal(deferred.status, "ready");
  assert.equal(deferred.availableVersion, "1.0.1");
  assert.equal(deferred.reason, "active_or_uncertain_operations");
  assert.equal(adapter.installs, 0);
  assert.deepEqual(leases, ["acquire"], "an unconfirmed lease was committed or released");
  controllerForUpdate.stop();
});

test("a committed restart lease is never released and never handed over twice", async () => {
  const leases = [];
  const adapter = updateAdapter({ check: () => ({ isUpdateAvailable: true, updateInfo: { version: "1.0.1" } }) });
  const controllerForUpdate = createUpdateController({
    adapter,
    policy: enabledPolicy(),
    acquireRestartLease: async () => { leases.push("acquire"); return { status: "granted", leaseId: "known-idle-lease" }; },
    releaseRestartLease: async (leaseId) => { leases.push(`release:${leaseId}`); },
    commitRestartLease: async (leaseId) => { leases.push(`commit:${leaseId}`); return { status: "closing" }; },
    updateAttempts: {
      async read() { return null; },
      async write() { throw new Error("the attempt record could not be written"); },
      async clear() {}
    },
    confirmUpdatedRuntime: async () => ({ status: "unknown" })
  });
  await controllerForUpdate.start();
  adapter.emit("update-downloaded", { version: "1.0.1" });

  // Without a recorded attempt Morrow cannot tell a new version that never
  // started from an ordinary start, so it keeps the update and hands over
  // nothing. The lease it committed stays committed.
  const deferred = await controllerForUpdate.installWhenIdle();
  assert.equal(deferred.status, "ready");
  assert.equal(deferred.reason, "active_or_uncertain_operations");
  assert.equal(adapter.installs, 0);
  assert.deepEqual(leases, ["acquire", "commit:known-idle-lease"]);
  await settled();
  assert.deepEqual(leases, ["acquire", "commit:known-idle-lease"], "the committed lease was released after the fact");
  controllerForUpdate.stop();
});
