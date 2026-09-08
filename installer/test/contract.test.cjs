const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const { ASSISTANTS, assertAssistantId, envelope, installerState } = require("../shared/contract.cjs");
const { createInstallerController, errorDetails, repairRequiredState } = require("../shared/installer-controller.cjs");
const { initializeBridgeDirectory } = require("../shared/bridge-updates.cjs");

const installerRoot = path.resolve(__dirname, "..");
const electronPath = require.resolve("electron", { paths: [installerRoot] });
const mainPath = require.resolve("../main.cjs");
const preloadPath = require.resolve("../preload.cjs");

/**
 * Loads the real Electron main module with a stub `electron`, so the tests run
 * the guards Morrow ships instead of matching their source text. Nothing in the
 * module body reaches the filesystem: `app.whenReady()` never resolves here.
 */
function loadMain() {
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    path: path.dirname(electronPath),
    loaded: true,
    children: [],
    paths: [],
    exports: {
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
    }
  };
  return require(mainPath);
}

/**
 * Replaces one module in the require cache and answers with the undo, so a test
 * can run the module Morrow ships against injected pieces and leave the cache as
 * it found it.
 */
function plant(id, exports) {
  const previous = require.cache[id];
  require.cache[id] = { id, filename: id, path: path.dirname(id), loaded: true, children: [], paths: [], exports };
  return () => {
    if (previous) require.cache[id] = previous;
    else delete require.cache[id];
  };
}

/**
 * Runs the start installer/main.cjs performs, with Electron, the updater and the
 * installer controller injected, and records what that start registers: every
 * IPC channel, the window it opens with its guards, and the answers the session
 * gives. Nothing here reaches the filesystem or the network. The app is not
 * packaged, so the update policy is disabled and the update controller stops
 * before its first check.
 */
async function startedMorrow(controller = {}) {
  const recorded = { channels: [], handlers: new Map(), events: new Map(), permissions: {}, window: null, loadedFile: null, windowOpen: null, started: null };
  const webContents = {
    mainFrame: { url: pathToFileURL(fs.realpathSync(path.join(installerRoot, "renderer", "index.html"))).href },
    on(event, handler) { recorded.events.set(event, handler); return webContents; },
    setWindowOpenHandler(handler) { recorded.windowOpen = handler; }
  };
  const undo = [
    plant(electronPath, {
      app: {
        isPackaged: false,
        getVersion: () => "1.0.0-rc.0",
        getPath: () => path.join(os.tmpdir(), "morrow-start-user-data"),
        setPath() {},
        requestSingleInstanceLock: () => true,
        // main.cjs starts Morrow from app.whenReady().then(startMorrow) and
        // drops that promise. Holding it here is what lets the test await the
        // start and see a failure in it instead of a hang.
        whenReady: () => ({ then(onReady) { recorded.started = Promise.resolve().then(onReady); return recorded.started; } }),
        on() {},
        quit() {}
      },
      BrowserWindow: class {
        constructor(options) { this.options = options; this.webContents = webContents; recorded.window = this; }
        once() {}
        show() {}
        loadFile(file) { recorded.loadedFile = file; }
      },
      dialog: {},
      ipcMain: { handle(channel, handler) { recorded.channels.push(channel); recorded.handlers.set(channel, handler); } },
      session: {
        defaultSession: {
          setPermissionRequestHandler(handler) { recorded.permissions.request = handler; },
          setPermissionCheckHandler(handler) { recorded.permissions.check = handler; }
        }
      },
      shell: {}
    }),
    plant(require.resolve("electron-updater", { paths: [installerRoot] }), { autoUpdater: {} }),
    plant(require.resolve("../shared/electron-updater-adapter.cjs"), {
      createElectronUpdaterAdapter: () => ({
        identity: { currentVersion: "1.0.0-rc.0", platform: process.platform, arch: process.arch, feedId: "morrow-github-stable" },
        checkForUpdates() {}, downloadUpdate() {}, quitAndInstall() {}, on() {}, removeListener() {}
      })
    }),
    plant(require.resolve("../shared/installer-controller.cjs"), {
      ...require("../shared/installer-controller.cjs"),
      createInstallerController: () => ({ initializeBridgeAtStartup: async () => {}, ...controller })
    })
  ];
  const payload = process.env.MORROW_INSTALLER_PAYLOAD;
  process.env.MORROW_INSTALLER_PAYLOAD = path.join(os.tmpdir(), "morrow-start-payload");
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
  return recorded;
}

/**
 * Loads the real preload against a stub `electron` and answers with the bridge
 * it exposes, the channel set that bridge admits, and every call that reached
 * `ipcRenderer`.
 */
function loadedPreload() {
  const invoked = [];
  let exposed = null;
  const restore = plant(electronPath, {
    contextBridge: { exposeInMainWorld(key, value) { exposed = { key, value }; } },
    ipcRenderer: { invoke: (...call) => { invoked.push(call); return Promise.resolve("delivered"); } }
  });
  delete require.cache[preloadPath];
  try {
    return { methods: require(preloadPath).METHODS, exposed, invoked };
  } finally {
    delete require.cache[preloadPath];
    restore();
  }
}

/** The attributes of one HTML tag, by lower-case name. */
function tagAttributes(tag) {
  const found = new Map();
  for (const attribute of tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) found.set(attribute[1].toLowerCase(), attribute[2]);
  return found;
}

/**
 * The Content-Security-Policy the markup declares, as its directives and the
 * offset it sits at. A meta policy governs only what the parser reaches after
 * it, so that offset is part of the answer.
 */
function declaredPolicy(html) {
  for (const meta of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = tagAttributes(meta[0]);
    if (attributes.get("http-equiv")?.toLowerCase() !== "content-security-policy") continue;
    const directives = new Map();
    for (const directive of (attributes.get("content") || "").split(";")) {
      const tokens = directive.trim().split(/\s+/).filter((token) => token.length > 0);
      if (tokens.length > 0) directives.set(tokens[0].toLowerCase(), tokens.slice(1));
    }
    return { at: meta.index, directives };
  }
  return null;
}

test("IPC contract exposes no implementation paths or privilege", () => {
  const state = installerState({
    lifecycle: "ready_for_assistant",
    assistants: [{ id: "codex", title: "ChatGPT", tier: "primary", detected: true, configured: false, selected: false, needsWorkspace: true, supported: true }],
    selectedAssistantId: null,
    workspaceSelected: false,
    runtimeStatus: "not_prepared",
    bridgeDelivery: "developer_temporary",
    bridgeLoadedInChrome: "unknown",
    bridgeFolderReady: false,
    bridgePaired: "unknown",
    courseSite: "unknown",
    runtimeVerifiedCourseCount: 0,
    selectedCourseName: null
  });
  const result = envelope(state);
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes("/"), false);
  assert.throws(() => assertAssistantId("../../anything"), /invalid/);
  assert.equal(assertAssistantId("codex"), "codex");
});

test("Check Bridge returns safe installer errors even when the runtime or state read fails", async () => {
  const state = repairRequiredState();
  let failure = errorDetails("runtime_repair_required");
  let stateFailure = false;
  const started = await startedMorrow({
    reconcileBridgeRelease: async () => { throw failure; },
    state: async () => {
      if (stateFailure) throw new Error("private state read failed");
      return state;
    }
  });
  const event = { sender: started.window.webContents, senderFrame: started.window.webContents.mainFrame };
  const check = () => started.handlers.get("installer:reconcile-bridge")(event);
  assert.deepEqual((await check()).error, errorDetails("runtime_repair_required"));

  failure = new Error("private Bridge mismatch detail");
  assert.deepEqual((await check()).error, errorDetails("bridge_check_failed"));

  for (const error of [
    Object.assign(new Error("private MCP detail"), { code: -32603 }),
    { code: "unknown_runtime_error", message: "private runtime detail", recovery: "private internal path" },
    { code: "setup_failed", message: "private runtime detail", recovery: "private internal path" },
    null
  ]) {
    failure = error;
    for (const unreadable of [false, true]) {
      stateFailure = unreadable;
      const result = await check();
      assert.equal(result.ok, false);
      assert.deepEqual(result.state, state);
      assert.deepEqual(result.error, errorDetails("bridge_check_failed"));
      assert.doesNotMatch(JSON.stringify(result), /private/);
    }
  }
});

test("installer state exposes only public Blackboard tenant fields", () => {
  const state = installerState({
    lifecycle: "ready_for_assistant",
    assistants: [],
    selectedAssistantId: null,
    workspaceSelected: false,
    runtimeStatus: "not_prepared",
    bridgeDelivery: "developer_temporary",
    bridgeLoadedInChrome: "unknown",
    bridgeFolderReady: false,
    bridgePaired: "unknown",
    courseSite: "unknown",
    runtimeVerifiedCourseCount: 0,
    selectedCourseName: null,
    blackboard: {
      schema: "morrow.blackboard.health.v1",
      status: "api_configured_live_untested",
      tenants: [{
        id: "example-university",
        baseUrl: "https://learn.example.edu/",
        principalId: "_123_1",
        courseBindings: [],
        applicationKey: "must-not-reach-renderer",
        clientSecret: "must-not-reach-renderer",
        credentialRef: "file",
        sourcePath: "/private/secret.txt",
      }],
    },
  });
  assert.deepEqual(state.blackboard, {
    schema: "morrow.blackboard.health.v1",
    status: "api_configured_live_untested",
    tenants: [{ id: "example-university", baseUrl: "https://learn.example.edu", principalId: "_123_1", accountVerified: false, availableCourses: [], courseBindings: [] }],
  });
  const serialized = JSON.stringify(state);
  for (const forbidden of ["must-not-reach-renderer", "credentialRef", "sourcePath", "/private/secret.txt", "clientSecret", "applicationKey"]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} reached renderer state`);
  }
});

test("a runtime-verified account alone is not a selected course", () => {
  const bindings = [
    { runtimeVerified: true, courseId: undefined },
    { runtimeVerified: true, courseId: "42", courseName: "Biology" }
  ];
  const selected = bindings.filter((value) => value.runtimeVerified === true && typeof value.courseId === "string" && /^[1-9][0-9]{0,18}$/.test(value.courseId));
  assert.equal(selected.length, 1);
  assert.equal(selected[0].courseName, "Biology");
});

test("the installer uses the shared knot with a live-text wordmark and the ChatGPT label", () => {
  const renderer = fs.readFileSync(path.join(installerRoot, "renderer", "index.html"), "utf8");
  // The brand mark and the two managed-device notes exist only in this markup,
  // so these four assertions read it directly. installer/test/renderer.test.cjs
  // proves which note the renderer shows.
  assert.match(renderer, /<img class="brand-mark" src="\.\.\/assets\/morrow-knot\.svg"[^>]*alt=""><span>morrow<\/span>/);
  assert.doesNotMatch(renderer, /\.png/);
  assert.match(renderer, /id="windows-note"[^>]*data-platform="win32" hidden/);
  assert.match(renderer, /id="macos-note"[^>]*data-platform="darwin" hidden/);
  for (const raster of ["morrow-wordmark.png", "morrow-wordmark-dark.png"]) {
    assert.equal(fs.existsSync(path.join(installerRoot, "assets", raster)), false, `${raster} is no longer used`);
  }
  assert.deepEqual(
    fs.readFileSync(path.join(installerRoot, "assets", "morrow-knot.svg")),
    fs.readFileSync(path.join(installerRoot, "..", "connector", "extension", "brand", "morrow-knot.svg")),
  );
  assert.equal(ASSISTANTS.find((assistant) => assistant.id === "codex")?.title, "ChatGPT");
});

test("the setup page declares a Content-Security-Policy that admits only the files it ships", () => {
  const html = fs.readFileSync(path.join(installerRoot, "renderer", "index.html"), "utf8");
  const styles = fs.readFileSync(path.join(installerRoot, "renderer", "styles.css"), "utf8");
  const policy = declaredPolicy(html);
  assert.notEqual(policy, null, "the setup page declares no Content-Security-Policy");
  assert.deepEqual(Object.fromEntries(policy.directives), {
    "default-src": ["'none'"],
    "script-src": ["'self'"],
    "style-src": ["'self'"],
    "img-src": ["'self'", "data:"],
    "font-src": ["'self'"],
    "connect-src": ["'none'"],
    "form-action": ["'none'"],
    "base-uri": ["'none'"]
  });
  // Chromium ignores these in a meta policy and reports the refusal as a console
  // error at every start, so naming one claims a protection the page never has.
  // The window is never framed: it is the top-level window main.cjs opens, and
  // that window refuses navigation, webviews and new windows.
  for (const ignored of ["frame-ancestors", "report-uri", "sandbox"]) {
    assert.equal(policy.directives.has(ignored), false, `a meta policy cannot carry ${ignored}`);
  }
  // A meta policy governs only what the parser reaches after it, so it must come
  // before the stylesheet, the script and the mark.
  for (const tag of ["<link", "<script", "<img"]) {
    assert.equal(policy.at < html.indexOf(tag), true, `the policy must be declared before ${tag}`);
  }

  // `'self'` admits the files beside the page and nothing else, so every address
  // the page and its stylesheet name must be a relative path that exists.
  const referenced = [
    ...[...html.matchAll(/<(?:link|script|img|source)\b[^>]*>/gi)].flatMap((tag) => {
      const attributes = tagAttributes(tag[0]);
      const candidates = (attributes.get("srcset") || "").split(",").map((candidate) => candidate.trim().split(/\s+/)[0]);
      return [attributes.get("href"), attributes.get("src"), ...candidates];
    }),
    ...[...styles.matchAll(/url\(\s*"([^"]*)"\s*\)/g)].map((reference) => reference[1])
  ].filter((reference) => typeof reference === "string" && reference.length > 0);
  // Without these two the page has no style and no behavior, so finding them is
  // what proves this scan read the page instead of finding nothing.
  for (const shipped of ["styles.css", "renderer.js"]) {
    assert.equal(referenced.includes(shipped), true, `the page no longer references ${shipped}`);
  }
  assert.equal(referenced.length >= 4, true, "the page references fewer files than it ships");
  for (const reference of referenced) {
    assert.doesNotMatch(reference, /^[a-zA-Z][a-zA-Z0-9+.-]*:|^\/\//, `${reference} is not same-origin`);
    assert.equal(fs.existsSync(path.resolve(installerRoot, "renderer", reference)), true, `${reference} is missing`);
  }

  // The policy allows no inline script or style, so the markup and the two
  // sources that write into it must carry none.
  for (const source of ["renderer/index.html", "renderer/renderer.js", "shared/setup-view.mjs"]) {
    const text = fs.readFileSync(path.join(installerRoot, source), "utf8");
    assert.doesNotMatch(text, /\sstyle="/, `${source} carries an inline style the policy blocks`);
    assert.doesNotMatch(text, /\son[a-z]+="/, `${source} carries an inline handler the policy blocks`);
    assert.doesNotMatch(text, /<style[\s>]/, `${source} carries an inline stylesheet the policy blocks`);
  }
  assert.doesNotMatch(html, /'unsafe-inline'|'unsafe-eval'/, "the setup page loosens its own policy");
});

test("main registers exactly the channels the renderer bridge admits", async () => {
  const started = await startedMorrow();
  const preload = loadedPreload();
  assert.equal(preload.exposed?.key, "morrowInstaller");
  assert.equal(started.channels.length > 0, true, "the start registered no channel");
  assert.equal(started.channels.length, new Set(started.channels).size, "a channel is registered twice");
  // A channel on one side only is either unreachable from the renderer or an
  // unguarded action the bridge would hand to a main handler that is not there.
  assert.deepEqual([...started.channels].sort(), [...preload.methods].sort());

  for (const channel of started.channels) {
    assert.equal(await preload.exposed.value.invoke(channel), "delivered", `${channel} does not reach main through the bridge`);
  }
  assert.deepEqual(preload.invoked, started.channels.map((channel) => [channel]));
  await assert.rejects(() => preload.exposed.value.invoke("installer:remove-data-now"), /Unsupported Morrow action\./);
  assert.equal(preload.invoked.length, started.channels.length, "a refused action still reached main");
});

test("the setup window opens sandboxed and refuses navigation, webviews, new windows and permissions", async () => {
  const started = await startedMorrow();
  assert.deepEqual(started.window?.options.webPreferences, {
    preload: path.join(installerRoot, "preload.cjs"),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true
  });
  assert.equal(started.loadedFile, path.join(installerRoot, "renderer", "index.html"));

  for (const event of ["will-navigate", "will-attach-webview"]) {
    const handler = started.events.get(event);
    assert.equal(typeof handler, "function", `the window installs no ${event} guard`);
    let prevented = false;
    handler({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true, `${event} is not prevented`);
  }
  assert.deepEqual(started.windowOpen({ url: "https://example.edu/" }), { action: "deny" });

  let requested = null;
  started.permissions.request({}, "media", (answer) => { requested = answer; });
  assert.equal(requested, false, "a permission request is not refused");
  assert.equal(started.permissions.check({}, "media", "https://example.edu/"), false, "a permission check is not refused");
});

test("preload and main expose the fixed update and first-read actions used by the renderer", () => {
  const preload = fs.readFileSync(path.join(installerRoot, "preload.cjs"), "utf8");
  const main = fs.readFileSync(path.join(installerRoot, "main.cjs"), "utf8");
  const renderer = fs.readFileSync(path.join(installerRoot, "renderer", "renderer.js"), "utf8");
  for (const channel of ["installer:reconcile-bridge", "installer:check-for-updates", "installer:install-update", "installer:run-first-read", "installer:open-claude-desktop", "installer:reveal-claude-extension"]) {
    assert.match(preload, new RegExp(`"${channel}"`));
    assert.match(main, new RegExp(`ipcMain\\.handle\\("${channel}"`));
    assert.match(renderer, new RegExp(`invoke\\("${channel}"`));
  }
});

/**
 * Every installer source outside `test/`. The test directory is excluded
 * because these are the strings the tests name to prove they are gone.
 */
function installerSources(directory = installerRoot) {
  const sources = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", "assets", "test"].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) sources.push(...installerSources(target));
    else if (/\.(cjs|mjs|js|html|css|json|md)$/.test(entry.name)) sources.push(target);
  }
  return sources;
}

test("no installer source passes a browser-internal address to Chrome or keeps the removed Chrome-page channel", () => {
  // Assembled from parts so a plain search of the installer for either string
  // finds no source, and no match inside this scanner either.
  const browserScheme = `chrome:${"//"}`;
  const removedChannel = `open-bridge${"-install"}`;
  const sources = installerSources();
  assert.equal(sources.length > 10, true, "the installer source scan found almost nothing");
  for (const file of sources) {
    const relative = path.relative(installerRoot, file);
    const text = fs.readFileSync(file, "utf8");
    assert.equal(text.includes(browserScheme), false, `${relative} passes a browser-internal address to Chrome`);
    assert.equal(text.includes(removedChannel), false, `${relative} keeps the removed Chrome-page channel`);
  }
});

/**
 * A Bridge release the app can install into its own folder. The extension key
 * is the real one, so the derived extension identity matches the identity the
 * installer controller requires.
 */
async function bridgeRelease(root) {
  const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
  const bundled = path.join(root, "bridge-release");
  const sourceDirectory = path.join(bundled, "extension");
  await fs.promises.mkdir(sourceDirectory, { recursive: true });
  const manifest = {
    manifest_version: 3,
    name: "Morrow Bridge fixture",
    version: "1.0.0",
    key: JSON.parse(fs.readFileSync(path.join(installerRoot, "..", "connector", "extension", "manifest.json"), "utf8")).key,
    permissions: ["storage", "tabs"],
    host_permissions: ["http://127.0.0.1/*"],
    optional_host_permissions: ["https://*/*"],
    background: { service_worker: "service-worker.js", type: "module" }
  };
  await fs.promises.writeFile(path.join(sourceDirectory, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  await fs.promises.writeFile(path.join(sourceDirectory, "service-worker.js"), "export const version = \"1.0.0\";\n");
  const files = [];
  for (const relative of ["manifest.json", "service-worker.js"]) {
    const content = await fs.promises.readFile(path.join(sourceDirectory, relative));
    files.push({ path: relative, bytes: content.byteLength, sha256: digest(content) });
  }
  const release = {
    schema: "morrow.bridge-release.v1",
    extensionId: "abeloclekioohahgedmjcdbpllfjfhko",
    version: "1.0.0",
    manifestSha256: digest(await fs.promises.readFile(path.join(sourceDirectory, "manifest.json"))),
    permissions: manifest.permissions,
    hostPermissions: manifest.host_permissions,
    optionalHostPermissions: manifest.optional_host_permissions,
    files
  };
  const releaseManifestPath = path.join(bundled, "manifest.json");
  await fs.promises.writeFile(releaseManifestPath, `${JSON.stringify(release)}\n`);
  return {
    sourceDirectory,
    releaseManifestPath,
    trustedReleaseManifestSha256: digest(await fs.promises.readFile(releaseManifestPath)),
    expectedExtensionId: release.extensionId
  };
}

test("the Bridge step shows the app-owned folder and reports a folder failure as its own bounded error", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "morrow-bridge-reveal-"));
  test.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const userData = path.join(root, "UserData");
  await fs.promises.mkdir(userData, { recursive: true });
  const controller = (shell) => createInstallerController({
    app: { getPath: () => userData },
    dialog: {},
    shell,
    platform: process.platform,
    homeDirectory: path.join(root, "Home"),
    testRoot: null,
    isTestMode: false,
    payloadRoot: path.join(root, "Payload"),
    productVersion: "1.0.0-rc.0",
    trustedBridgeReleaseManifestSha256: () => null,
    trustedMcpRuntimeManifestSha256: () => null,
    detectAssistant: async () => false,
    runCli: async () => ({ code: 0, stdout: "", stderr: "" })
  });

  const revealed = [];
  const installer = controller({ showItemInFolder: (target) => revealed.push(target) });

  await assert.rejects(() => installer.revealBridgeFolder(), (error) => {
    assert.equal(error.code, "bridge_folder_unavailable");
    assert.notEqual(error.code, "bridge_delivery_unavailable");
    assert.doesNotMatch(error.message, /Chrome Web Store/);
    assert.doesNotMatch(error.recovery, /Chrome Web Store/);
    return true;
  }, "a missing Bridge folder must not be reported as a Chrome Web Store delivery failure");
  assert.deepEqual(revealed, [], "nothing was shown while the Bridge folder was missing");

  await initializeBridgeDirectory({
    ...await bridgeRelease(root),
    stateDirectory: installer.paths.state,
    bridgeDirectory: installer.paths.bridgeDirectory,
    initialChallenge: { challengeId: "morrow-reveal-challenge", nonce: "morrow-reveal-nonce-with-enough-entropy" }
  });

  await installer.revealBridgeFolder();
  assert.deepEqual(revealed, [path.join(installer.paths.bridgeDirectory, "manifest.json")]);

  const refusing = controller({ showItemInFolder: () => { throw new Error("no file manager answered"); } });
  await assert.rejects(() => refusing.revealBridgeFolder(), (error) => error.code === "bridge_folder_unavailable");

  const result = envelope(repairRequiredState(), errorDetails("bridge_folder_unavailable"));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "bridge_folder_unavailable");
  assert.equal(result.error.message, "Morrow could not show the Morrow Bridge folder.");
});

test("the Blackboard request clears FormData and reaches only the trusted filesystem transaction", () => {
  const preload = fs.readFileSync(path.join(installerRoot, "preload.cjs"), "utf8");
  const main = fs.readFileSync(path.join(installerRoot, "main.cjs"), "utf8");
  const controller = fs.readFileSync(path.join(installerRoot, "shared", "installer-controller.cjs"), "utf8");
  const renderer = fs.readFileSync(path.join(installerRoot, "renderer", "renderer.js"), "utf8");
  const transaction = fs.readFileSync(path.join(installerRoot, "shared", "blackboard.cjs"), "utf8");
  assert.match(preload, /"installer:configure-blackboard"/);
  assert.match(main, /ipcMain\.handle\("installer:configure-blackboard"/);
  assert.match(main, /await installer\.configureBlackboard\(input\);/);
  for (const channel of ["installer:configure-blackboard", "installer:select-blackboard-courses"]) {
    assert.match(preload, new RegExp(`"${channel}"`));
    assert.match(main, new RegExp(`ipcMain\\.handle\\("${channel}"`));
    assert.match(renderer, new RegExp(`invoke\\("${channel}"`));
  }
  assert.match(main, /errorDetails\("blackboard_configuration_invalid"\)/);
  assert.match(controller, /hardenPrivateDirectory\(candidate, \{ trustedRoot: this\.home \}\)/);
  assert.match(controller, /privateDirectoryAccessAccepted\(candidate, \{ trustedRoot: this\.home \}\)/);
  assert.match(renderer, /fields\.get\("applicationSecret"\);\r?\n  fields\.delete\("applicationSecret"\);/);
  assert.match(renderer, /finally \{\r?\n    applicationSecret = "";/);
  assert.doesNotMatch(transaction, /\bfetch\b|BlackboardLearnRuntime|runtimeSnapshot|createRuntimeMonitor/);
});

test("main authorizes IPC only from the canonical renderer main frame", () => {
  const { trusted } = loadMain();
  const canonical = pathToFileURL(fs.realpathSync(path.join(installerRoot, "renderer", "index.html"))).href;
  const mainFrame = { url: canonical };
  const webContents = { mainFrame };
  const window = { webContents };

  assert.doesNotThrow(() => trusted({ sender: webContents, senderFrame: mainFrame }, window));
  assert.throws(() => trusted({ sender: webContents, senderFrame: mainFrame }, null), /Untrusted installer request\./);
  assert.throws(() => trusted({ sender: { mainFrame: {} }, senderFrame: mainFrame }, window), /Untrusted installer request\./);
  assert.throws(() => trusted({ sender: webContents, senderFrame: { url: canonical } }, window), /Untrusted installer request\./);

  const uncanonical = `${pathToFileURL(installerRoot).href}/renderer/./index.html`;
  assert.notEqual(uncanonical, canonical);
  mainFrame.url = uncanonical;
  assert.throws(() => trusted({ sender: webContents, senderFrame: mainFrame }, window), /Untrusted installer request\./);
  mainFrame.url = "https://example.edu/index.html";
  assert.throws(() => trusted({ sender: webContents, senderFrame: mainFrame }, window), /Untrusted installer request\./);
});

test("no maintenance channel reaches the renderer", () => {
  assert.doesNotMatch(fs.readFileSync(path.join(installerRoot, "preload.cjs"), "utf8"), /maintenance/);
  assert.doesNotMatch(fs.readFileSync(path.join(installerRoot, "renderer", "renderer.js"), "utf8"), /maintenance/);
});

test("routine installer state does not create or rotate the app-owned Bridge directory", () => {
  const main = fs.readFileSync(path.join(installerRoot, "main.cjs"), "utf8");
  const controller = fs.readFileSync(path.join(installerRoot, "shared", "installer-controller.cjs"), "utf8");
  const state = controller.slice(controller.indexOf("  async state() {"), controller.indexOf("  async revealBridgeFolder() {"));
  assert.match(main, /await installer\.initializeBridgeAtStartup\(\)\.catch\(\(\) => \{\}\);/);
  assert.match(controller, /bridgeInstallationStatus/);
  assert.doesNotMatch(state, /initializeBridgeAtStartup|ensureBridgeDirectory|initializeBridgeDirectory|issueBridgeActiveFolderChallenge|bridgeInstallationStatus/);
});
