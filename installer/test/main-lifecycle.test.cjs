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
const controllerPath = require.resolve("../shared/installer-controller.cjs");
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
function startedWith({ testRoot, receipt }) {
  const argv = process.argv;
  const mode = process.env.MORROW_INSTALLER_TEST_MODE;
  process.argv = [argv[0], argv[1], `--morrow-test-root=${testRoot}`];
  if (receipt) process.argv.push(`--morrow-smoke-receipt=${receipt}`);
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
