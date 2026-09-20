/**
 * Runs the start decision installer/main.cjs ships. The module is loaded with
 * an injected Electron `app` and an injected controller factory, so these tests
 * read what a duplicate start actually does instead of matching source text.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const installerRoot = path.resolve(__dirname, "..");
const mainPath = require.resolve("../main.cjs");
const electronPath = require.resolve("electron", { paths: [installerRoot] });
const updaterPath = require.resolve("electron-updater", { paths: [installerRoot] });
const adapterPath = require.resolve("../shared/electron-updater-adapter.cjs");
const controllerPath = require.resolve("../shared/installer-controller.cjs");
const updatesPath = require.resolve("../shared/updates.cjs");
const controllerModule = require("../shared/installer-controller.cjs");

const REFUSAL_RECEIPT = {
  schema: "morrow.desktop-windows-smoke-refused.v1",
  start: "refused",
  reason: "another_instance_holds_the_single_instance_lock"
};

async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-main-lifecycle-"));
  test.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

/** The Electron `app` surface installer/main.cjs uses while it loads. */
function fakeApp(lock) {
  let signalQuit = null;
  return {
    isPackaged: false,
    exitCode: null,
    quits: 0,
    whenReadyCalls: 0,
    handlers: new Map(),
    quitted: new Promise((resolve) => { signalQuit = resolve; }),
    getVersion: () => "1.0.0-rc.0",
    getPath: () => installerRoot,
    setPath() {},
    requestSingleInstanceLock: () => lock,
    whenReady() { this.whenReadyCalls += 1; return new Promise(() => {}); },
    on(name, handler) { this.handlers.set(name, handler); },
    quit() { this.quits += 1; signalQuit(); }
  };
}

function fakeWindow(condition = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => condition.destroyed === true,
    isMinimized: () => condition.minimized === true,
    restore() { calls.push("restore"); },
    show() { calls.push("show"); },
    focus() { calls.push("focus"); }
  };
}

function plant(id, exports) {
  const previous = require.cache[id];
  require.cache[id] = { id, filename: id, path: path.dirname(id), loaded: true, children: [], paths: [], exports };
  return () => {
    if (previous) require.cache[id] = previous;
    else delete require.cache[id];
  };
}

/**
 * Loads installer/main.cjs against the injected app and records every
 * InstallerController construction. The module is removed from the cache again
 * so each test loads it fresh.
 */
function loadMain(app) {
  const constructions = [];
  const restoreElectron = plant(electronPath, {
    app,
    BrowserWindow: class {},
    dialog: {},
    ipcMain: { handle() {} },
    session: { defaultSession: { setPermissionRequestHandler() {} } },
    shell: {}
  });
  const restoreController = plant(controllerPath, {
    ...controllerModule,
    createInstallerController(dependencies) { constructions.push(dependencies); return {}; }
  });
  delete require.cache[mainPath];
  try {
    return { main: require(mainPath), constructions };
  } finally {
    delete require.cache[mainPath];
    restoreController();
    restoreElectron();
  }
}

/** The test-mode arguments a packaged smoke run starts with. */
function startedWith({ testRoot, receipt, rendererReceipt }) {
  const argv = process.argv;
  const mode = process.env.MORROW_INSTALLER_TEST_MODE;
  process.argv = [argv[0], argv[1], `--morrow-test-root=${testRoot}`];
  if (receipt) process.argv.push(`--morrow-smoke-receipt=${receipt}`);
  if (rendererReceipt) process.argv.push(`--morrow-renderer-smoke-receipt=${rendererReceipt}`);
  process.env.MORROW_INSTALLER_TEST_MODE = "1";
  return () => {
    process.argv = argv;
    if (mode === undefined) delete process.env.MORROW_INSTALLER_TEST_MODE;
    else process.env.MORROW_INSTALLER_TEST_MODE = mode;
  };
}

async function quitted(app) {
  let timer = null;
  const overdue = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Morrow did not quit")), 5_000); });
  try {
    await Promise.race([app.quitted, overdue]);
  } finally {
    clearTimeout(timer);
  }
}

test("a duplicate start quits with exit code 0, builds no controller, and writes nothing", async () => {
  const root = await temporaryRoot();
  const restoreArguments = startedWith({ testRoot: root });
  try {
    const app = fakeApp(false);
    const { constructions } = loadMain(app);
    await quitted(app);
    assert.deepEqual(constructions, []);
    assert.equal(app.whenReadyCalls, 0);
    assert.equal(app.handlers.has("second-instance"), false);
    assert.equal(app.exitCode, 0);
    assert.equal(app.quits, 1);
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    restoreArguments();
  }
});

test("the start that holds the lock reaches app.whenReady() and answers a later start", async () => {
  const root = await temporaryRoot();
  const restoreArguments = startedWith({ testRoot: root });
  try {
    const app = fakeApp(true);
    loadMain(app);
    assert.equal(app.whenReadyCalls, 1);
    assert.equal(app.quits, 0);
    assert.equal(app.exitCode, null);
    const secondInstance = app.handlers.get("second-instance");
    assert.equal(typeof secondInstance, "function");
    // A second start before this one has created its window is not an error.
    assert.doesNotThrow(() => secondInstance({}, [], ""));
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    restoreArguments();
  }
});

test("a granted lock installs a second-instance handler that restores and focuses the open window", () => {
  const { main } = loadMain(fakeApp(true));
  const app = fakeApp(true);
  const window = fakeWindow({ minimized: true });
  assert.equal(main.claimSingleInstance(app, () => window), true);
  app.handlers.get("second-instance")({}, [], "");
  assert.deepEqual(window.calls, ["restore", "show", "focus"]);

  const open = fakeWindow();
  const second = fakeApp(true);
  assert.equal(main.claimSingleInstance(second, () => open), true);
  second.handlers.get("second-instance")({}, [], "");
  assert.deepEqual(open.calls, ["show", "focus"]);
});

test("a denied lock registers no second-instance handler and focuses nothing that is gone", () => {
  const { main } = loadMain(fakeApp(true));
  const app = fakeApp(false);
  const window = fakeWindow();
  assert.equal(main.claimSingleInstance(app, () => window), false);
  assert.equal(app.handlers.size, 0);
  assert.deepEqual(window.calls, []);

  assert.equal(main.focusExistingWindow(null), false);
  const closed = fakeWindow({ destroyed: true });
  assert.equal(main.focusExistingWindow(closed), false);
  assert.deepEqual(closed.calls, []);
});

test("activation during bootstrap joins one initialization and creates one trusted window", async () => {
  const { main } = loadMain(fakeApp(true));
  const target = fakeApp(true);
  let releaseBootstrap;
  let initialized = 0;
  let created = 0;
  let current = null;
  const gate = new Promise((resolve) => { releaseBootstrap = resolve; });
  const lifecycle = main.createDesktopLifecycle({
    target,
    initialize: async () => { initialized += 1; await gate; return true; },
    currentWindow: () => current,
    openWindow: () => {
      created += 1;
      current = { destroyed: false, isDestroyed() { return this.destroyed; } };
      return current;
    },
    closeResources: async () => {}
  });

  const initial = lifecycle.open();
  const activation = lifecycle.open();
  assert.equal(initial, activation, "activation started a second window operation");
  await Promise.resolve();
  assert.equal(initialized, 1);
  assert.equal(created, 0);

  releaseBootstrap();
  const [firstWindow, activatedWindow] = await Promise.all([initial, activation]);
  assert.equal(firstWindow, activatedWindow);
  assert.equal(created, 1);

  current.destroyed = true;
  const reopened = lifecycle.open();
  const duplicateReopen = lifecycle.open();
  assert.equal(reopened, duplicateReopen);
  assert.equal(await reopened, current);
  assert.equal(initialized, 1, "reopening repeated desktop initialization");
  assert.equal(created, 2, "concurrent activation created more than one replacement window");
});

test("a failed bootstrap reports the failure once, opens no window, and quits", async () => {
  const { main } = loadMain(fakeApp(true));
  const target = fakeApp(true);
  let reported = 0;
  let windows = 0;
  const lifecycle = main.createDesktopLifecycle({
    target,
    initialize: async () => { throw new Error("bootstrap failed"); },
    currentWindow: () => null,
    openWindow: () => { windows += 1; return fakeWindow(); },
    closeResources: async () => {},
    reportFailure: () => { reported += 1; }
  });

  assert.equal(await lifecycle.open(), null, "a failed bootstrap opened a window");
  await lifecycle.pending();
  assert.equal(reported, 1);
  assert.equal(windows, 0);
  assert.equal(target.quits, 1);

  assert.equal(await lifecycle.open(), null, "activation after a failed bootstrap reopened the app");
  assert.equal(reported, 1, "activation repeated the failure message");
  assert.equal(target.quits, 1);
});

test("a renderer load failure destroys the hidden window and activation opens a fresh one", async () => {
  const root = await temporaryRoot();
  let startup = null;
  let signalSecondLoad;
  const secondLoad = new Promise((resolve) => { signalSecondLoad = resolve; });
  const handlers = new Map();
  const windows = [];
  const recovery = [];
  let loadCount = 0;
  const app = {
    isPackaged: false,
    exitCode: null,
    getVersion: () => "1.0.0-rc.0",
    getPath: () => path.join(root, "UserData"),
    setPath() {},
    requestSingleInstanceLock: () => true,
    whenReady: () => ({ then(onReady) { startup = Promise.resolve().then(onReady); return startup; } }),
    on(name, handler) { handlers.set(name, handler); },
    quit() {}
  };
  const controller = {
    paths: { state: path.join(root, "UserData", "State") },
    async initializeBridgeAtStartup() {},
    async closeRuntimeMonitor() {}
  };
  const updateController = {
    subscribe() { return () => {}; },
    async start() {},
    stop() {}
  };
  const undo = [
    plant(electronPath, {
      app,
      BrowserWindow: class {
        constructor() {
          this.destroyed = false;
          this.shown = 0;
          this.listeners = new Map();
          this.webContents = { on() {}, setWindowOpenHandler() {}, send() {} };
          windows.push(this);
        }
        isDestroyed() { return this.destroyed; }
        once(name, handler) { this.listeners.set(name, handler); }
        destroy() {
          if (this.destroyed) return;
          this.destroyed = true;
          this.listeners.get("closed")?.();
        }
        show() { this.shown += 1; }
        loadFile(file) {
          this.loadedFile = file;
          loadCount += 1;
          if (loadCount === 1) return Promise.reject(new Error("private renderer failure"));
          signalSecondLoad();
          return Promise.resolve();
        }
      },
      dialog: { showErrorBox(title, message) { recovery.push([title, message]); } },
      ipcMain: { handle() {} },
      session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
      shell: {}
    }),
    plant(updaterPath, { autoUpdater: {} }),
    plant(adapterPath, { createElectronUpdaterAdapter: () => ({}) }),
    plant(updatesPath, {
      createUpdateAttemptStore: () => ({}),
      createUpdateController: () => updateController
    }),
    plant(controllerPath, { ...controllerModule, createInstallerController: () => controller })
  ];
  const previousPayload = process.env.MORROW_INSTALLER_PAYLOAD;
  process.env.MORROW_INSTALLER_PAYLOAD = path.join(root, "Payload");
  delete require.cache[mainPath];
  try {
    require(mainPath);
    assert.equal(await startup, null);
    assert.equal(windows.length, 1);
    assert.equal(windows[0].destroyed, true);
    assert.equal(windows[0].shown, 0);
    assert.deepEqual(recovery, [[
      "Morrow could not open",
      "Morrow could not open its setup window. Close Morrow and open it again. If Morrow still cannot open, reinstall Morrow."
    ]]);
    assert.doesNotMatch(recovery[0][1], /private renderer failure/);

    handlers.get("activate")();
    await secondLoad;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(windows.length, 2);
    assert.equal(windows[1].destroyed, false);
    assert.equal(windows[1].shown, 1);
    assert.equal(windows[1].loadedFile, path.join(installerRoot, "renderer", "index.html"));
    assert.equal(recovery.length, 1);
  } finally {
    delete require.cache[mainPath];
    for (const restore of undo.reverse()) restore();
    if (previousPayload === undefined) delete process.env.MORROW_INSTALLER_PAYLOAD;
    else process.env.MORROW_INSTALLER_PAYLOAD = previousPayload;
  }
});

test("renderer smoke waits for a visible loaded window and an acknowledged first state", async () => {
  const root = await temporaryRoot();
  const receipt = path.join(root, "Receipts", "renderer.json");
  const restoreArguments = startedWith({ testRoot: root, rendererReceipt: receipt });
  let startup = null;
  const handlers = new Map();
  let window = null;
  const app = fakeApp(true);
  app.getPath = () => path.join(root, "UserData");
  app.whenReady = () => ({ then(onReady) { startup = Promise.resolve().then(onReady); return startup; } });
  const rendererUrl = require("node:url").pathToFileURL(
    require("node:fs").realpathSync(path.join(installerRoot, "renderer", "index.html"))
  ).href;
  const webContents = {
    mainFrame: { url: rendererUrl },
    on() {},
    setWindowOpenHandler() {},
    send() {}
  };
  const controller = {
    paths: { state: path.join(root, "UserData", "State") },
    async initializeBridgeAtStartup() {},
    async state() { throw new Error("use the fixed recovery state"); },
    async closeRuntimeMonitor() {}
  };
  const updateController = { subscribe: () => () => {}, start: async () => {}, stop() {} };
  const undo = [
    plant(electronPath, {
      app,
      BrowserWindow: class {
        constructor() {
          this.visible = false;
          this.webContents = webContents;
          window = this;
        }
        isDestroyed() { return false; }
        isVisible() { return this.visible; }
        once() {}
        show() { this.visible = true; }
        loadFile() { return Promise.resolve(); }
      },
      dialog: {},
      ipcMain: { handle(channel, handler) { handlers.set(channel, handler); } },
      session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
      shell: {}
    }),
    plant(updaterPath, { autoUpdater: {} }),
    plant(adapterPath, { createElectronUpdaterAdapter: () => ({}) }),
    plant(updatesPath, {
      createUpdateAttemptStore: () => ({}),
      createUpdateController: () => updateController
    }),
    plant(controllerPath, { ...controllerModule, createInstallerController: () => controller })
  ];
  const previousPayload = process.env.MORROW_INSTALLER_PAYLOAD;
  process.env.MORROW_INSTALLER_PAYLOAD = path.join(root, "Payload");
  delete require.cache[mainPath];
  try {
    require(mainPath);
    await startup;
    assert.equal(window.isVisible(), true);
    assert.equal(await fs.stat(receipt).then(() => true, () => false), false);

    const event = { sender: webContents, senderFrame: webContents.mainFrame };
    await handlers.get("installer:renderer-ready")(event);
    assert.equal(await fs.stat(receipt).then(() => true, () => false), false, "a renderer acknowledgment preceded its first state");
    await handlers.get("installer:get-state")(event);
    assert.equal(await fs.stat(receipt).then(() => true, () => false), false, "a delivered state was not yet acknowledged as rendered");
    await handlers.get("installer:renderer-ready")(event);
    await quitted(app);
    assert.deepEqual(JSON.parse(await fs.readFile(receipt, "utf8")), {
      schema: "morrow.desktop-renderer-smoke.v1",
      renderer: { loaded: true, stateRendered: true },
      window: { visible: true }
    });
  } finally {
    delete require.cache[mainPath];
    for (const restore of undo.reverse()) restore();
    if (previousPayload === undefined) delete process.env.MORROW_INSTALLER_PAYLOAD;
    else process.env.MORROW_INSTALLER_PAYLOAD = previousPayload;
    restoreArguments();
  }
});

test("normal quit waits for one cleanup before it continues", async () => {
  const { main } = loadMain(fakeApp(true));
  const target = fakeApp(true);
  let releaseCleanup;
  const order = [];
  const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve; });
  const lifecycle = main.createDesktopLifecycle({
    target,
    initialize: async () => false,
    currentWindow: () => null,
    openWindow: () => { throw new Error("window should stay closed"); },
    closeResources: async () => {
      order.push("cleanup-started");
      await cleanupGate;
      order.push("cleanup-finished");
    }
  });
  const first = { prevented: false, preventDefault() { this.prevented = true; } };
  const duplicate = { prevented: false, preventDefault() { this.prevented = true; } };

  lifecycle.handleQuit(first);
  lifecycle.handleQuit(duplicate);
  await Promise.resolve();
  assert.equal(first.prevented, true);
  assert.equal(duplicate.prevented, true);
  assert.deepEqual(order, ["cleanup-started"]);
  assert.equal(target.quits, 0);

  releaseCleanup();
  await lifecycle.pending();
  assert.deepEqual(order, ["cleanup-started", "cleanup-finished"]);
  assert.equal(target.quits, 1);

  const continuation = { prevented: false, preventDefault() { this.prevented = true; } };
  lifecycle.handleQuit(continuation);
  assert.equal(continuation.prevented, false, "the deliberate second quit is allowed to exit");
  assert.equal(target.quits, 1);
});

test("quit during bootstrap blocks activation, joins bootstrap, and cleans its late resource", async () => {
  const { main } = loadMain(fakeApp(true));
  const target = fakeApp(true);
  let releaseBootstrap;
  let resourceOpen = false;
  let windows = 0;
  const order = [];
  const gate = new Promise((resolve) => { releaseBootstrap = resolve; });
  const lifecycle = main.createDesktopLifecycle({
    target,
    initialize: async () => {
      resourceOpen = true;
      order.push("bootstrap-started");
      await gate;
      order.push("bootstrap-finished");
      return true;
    },
    currentWindow: () => null,
    openWindow: () => { windows += 1; return fakeWindow(); },
    closeResources: async () => {
      order.push("cleanup");
      resourceOpen = false;
    }
  });

  const startup = lifecycle.open();
  await Promise.resolve();
  assert.equal(resourceOpen, true);
  const quit = { prevented: false, preventDefault() { this.prevented = true; } };
  lifecycle.handleQuit(quit);
  assert.equal(quit.prevented, true);
  assert.equal(lifecycle.isClosing(), true);
  assert.equal(await lifecycle.open(), null, "activation reopened the app while it was closing");
  assert.equal(target.quits, 0);
  assert.equal(resourceOpen, true, "cleanup ran before the resource owner finished bootstrap");

  releaseBootstrap();
  assert.equal(await startup, null, "bootstrap created a window after closing started");
  await lifecycle.pending();
  assert.deepEqual(order, ["bootstrap-started", "bootstrap-finished", "cleanup"]);
  assert.equal(resourceOpen, false);
  assert.equal(windows, 0);
  assert.equal(target.quits, 1);
});

test("the real main process closes a controller created by startup and creates nothing after quit", async () => {
  const root = await temporaryRoot();
  let releaseBootstrap;
  let signalStarted;
  let signalQuit;
  let startup = null;
  let updaterConstructions = 0;
  let windows = 0;
  const channels = [];
  const order = [];
  const handlers = new Map();
  const bootstrapGate = new Promise((resolve) => { releaseBootstrap = resolve; });
  const bootstrapStarted = new Promise((resolve) => { signalStarted = resolve; });
  const quitted = new Promise((resolve) => { signalQuit = resolve; });
  const app = {
    isPackaged: false,
    exitCode: null,
    quits: 0,
    getVersion: () => "1.0.0-rc.0",
    getPath: () => path.join(root, "UserData"),
    setPath() {},
    requestSingleInstanceLock: () => true,
    whenReady: () => ({ then(onReady) { startup = Promise.resolve().then(onReady); return startup; } }),
    on(name, handler) { handlers.set(name, handler); },
    quit() { this.quits += 1; signalQuit(); }
  };
  const webContents = {
    mainFrame: { url: "file:///unused" },
    on() {},
    setWindowOpenHandler() {},
    send() {}
  };
  const controller = {
    paths: { state: path.join(root, "UserData", "State") },
    async initializeBridgeAtStartup() {
      order.push("bootstrap-started");
      signalStarted();
      await bootstrapGate;
      order.push("bootstrap-finished");
    },
    async closeRuntimeMonitor() { order.push("controller-closed"); }
  };
  const undo = [
    plant(electronPath, {
      app,
      BrowserWindow: class {
        constructor() { windows += 1; this.webContents = webContents; }
        isDestroyed() { return false; }
        once() {}
        show() {}
        loadFile() {}
      },
      dialog: {},
      ipcMain: { handle(channel) { channels.push(channel); } },
      session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
      shell: {}
    }),
    plant(updaterPath, { autoUpdater: {} }),
    plant(adapterPath, { createElectronUpdaterAdapter: () => ({}) }),
    plant(updatesPath, {
      createUpdateAttemptStore: () => ({}),
      createUpdateController: () => {
        updaterConstructions += 1;
        return { subscribe: () => () => {}, start: async () => {}, stop() {} };
      }
    }),
    plant(controllerPath, { ...controllerModule, createInstallerController: () => controller })
  ];
  const previousPayload = process.env.MORROW_INSTALLER_PAYLOAD;
  process.env.MORROW_INSTALLER_PAYLOAD = path.join(root, "Payload");
  delete require.cache[mainPath];
  try {
    require(mainPath);
    await bootstrapStarted;
    const firstQuit = { prevented: false, preventDefault() { this.prevented = true; } };
    handlers.get("before-quit")(firstQuit);
    handlers.get("activate")();
    assert.equal(firstQuit.prevented, true);
    assert.equal(app.quits, 0);

    releaseBootstrap();
    await Promise.all([startup, quitted]);
    assert.deepEqual(order, ["bootstrap-started", "bootstrap-finished", "controller-closed"]);
    assert.equal(updaterConstructions, 0);
    assert.equal(channels.length, 0);
    assert.equal(windows, 0);
    assert.equal(app.quits, 1);
  } finally {
    delete require.cache[mainPath];
    for (const restore of undo.reverse()) restore();
    if (previousPayload === undefined) delete process.env.MORROW_INSTALLER_PAYLOAD;
    else process.env.MORROW_INSTALLER_PAYLOAD = previousPayload;
  }
});

test("a duplicate start in the Windows smoke mode writes a bounded refusal receipt", async () => {
  const root = await temporaryRoot();
  const receipt = path.join(root, "Receipts", "app-receipt.json");
  const restoreArguments = startedWith({ testRoot: root, receipt });
  try {
    const app = fakeApp(false);
    const { constructions } = loadMain(app);
    await quitted(app);
    const written = await fs.readFile(receipt, "utf8");
    assert.equal(written.length < 200, true, "the refusal receipt must stay bounded");
    assert.deepEqual(JSON.parse(written), REFUSAL_RECEIPT);
    assert.deepEqual(constructions, []);
    assert.equal(app.exitCode, 0);
    assert.equal(app.quits, 1);
  } finally {
    restoreArguments();
  }
});

test("a duplicate smoke start keeps the receipt the running instance already wrote", async () => {
  const root = await temporaryRoot();
  const receipt = path.join(root, "app-receipt.json");
  const written = `${JSON.stringify({ schema: "morrow.desktop-windows-smoke.v1", runtime: { ready: true } })}\n`;
  await fs.writeFile(receipt, written, { flag: "wx" });
  const restoreArguments = startedWith({ testRoot: root, receipt });
  try {
    const app = fakeApp(false);
    loadMain(app);
    await quitted(app);
    assert.equal(await fs.readFile(receipt, "utf8"), written);
  } finally {
    restoreArguments();
  }
});

test("a duplicate smoke start writes no receipt outside the test root", async () => {
  const root = await temporaryRoot();
  const outside = await temporaryRoot();
  const receipt = path.join(outside, "app-receipt.json");
  const restoreArguments = startedWith({ testRoot: root, receipt });
  try {
    const app = fakeApp(false);
    loadMain(app);
    await quitted(app);
    assert.deepEqual(await fs.readdir(outside), []);
    assert.equal(app.quits, 1);
  } finally {
    restoreArguments();
  }
});
