#!/usr/bin/env node
/**
 * Desktop first use, from the assistant connection check to the screen a
 * person reads, in one isolated fixture. The real installer controller writes
 * and reads back its record, each assistant settings file, and its connection
 * proof on disk. The real renderer draws each state that controller returns,
 * in Playwright's own Chromium, at 320, 390, and 940px.
 *
 * The runtime is the one injected part: its maintenance lease refusal, which
 * says a client other than Morrow's monitor is connected and not which one,
 * and a completed first read of one course. The receipt names each scenario,
 * what the controller recorded, what the renderer showed, and the SHA-256 of
 * every screenshot.
 *
 * Usage: node scripts/test/desktop-first-use.mjs [--out <absolute directory>]
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { buildClientConfigBundle, morrowServerEntryRoute } from "../../packages/client-config/dist/index.js";

const require = createRequire(import.meta.url);
const DESKTOP = path.resolve(import.meta.dirname, "..", "..");
const INSTALLER = path.join(DESKTOP, "installer");
const { createInstallerController } = require(path.join(INSTALLER, "shared", "installer-controller.cjs"));
const { freshRecord } = require(path.join(INSTALLER, "shared", "state-policy.cjs"));

const USAGE = "Usage: node scripts/test/desktop-first-use.mjs [--out <absolute directory>]";
const WIDTHS = [320, 390, 940];
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf"
};
const OTHER_CLIENT = Object.freeze({ status: "uncertain", reason: "local_owner_other_client_connected" });
const COMPLETED_RUNTIME = Object.freeze({
  schema: "morrow.installer-runtime.v1",
  health: { attempted: true, gatewayReady: true, bridgeConnected: true, canRestart: "yes" },
  bindings: { runtimeVerifiedCourseCount: 1, selectedCourseName: "BIO 101", firstPreviewCourseName: "BIO 101" },
  firstPreview: { available: "yes", completed: true }
});

function outputDirectory(argv) {
  if (argv.length === 0) return path.join(DESKTOP, "output", "desktop-first-use");
  if (argv.length === 2 && argv[0] === "--out" && path.isAbsolute(argv[1])) return argv[1];
  console.error(USAGE);
  process.exit(2);
}

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function git(...args) {
  try { return execFileSync("git", ["-C", DESKTOP, ...args], { encoding: "utf8" }).trim(); } catch { return null; }
}

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "morrow-desktop-first-use-")));
  const folders = {
    home: path.join(root, "Home"),
    userData: path.join(root, "UserData"),
    project: path.join(root, "Project"),
    oldMaterials: path.join(root, "Old Materials"),
    newMaterials: path.join(root, "New Materials")
  };
  for (const folder of Object.values(folders)) await fs.mkdir(folder, { recursive: true });
  const targets = {
    codex: path.join(folders.home, ".codex", "config.toml"),
    "gemini-cli": path.join(folders.project, ".gemini", "settings.json")
  };
  const writes = [];
  const installedRoutes = new Map();
  let observedRoutes = [];
  let choice = null;
  const installer = createInstallerController({
    app: { getPath: () => folders.userData },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [choice] }) },
    shell: {},
    platform: process.platform,
    homeDirectory: folders.home,
    payloadRoot: path.join(root, "Payload"),
    productVersion: "1.0.7",
    detectAssistant: async () => true,
    trustedMcpRuntimeManifestSha256: () => null,
    trustedMcpRuntimeNodeSha256: () => null,
    trustedBridgeReleaseManifestSha256: () => null
  });
  // No packaged runtime exists in this fixture. Everything below these
  // replacements is the controller's own code reading and writing real files.
  installer.ensureRuntime = async () => installer.paths;
  installer.runtimeSnapshot = async () => structuredClone(COMPLETED_RUNTIME);
  installer.acquireRestartLease = async () => OTHER_CLIENT;
  installer.clientConfigModule = async () => ({ morrowServerEntryRoute });
  installer.runtimeMonitorFor = async () => ({
    start: async () => structuredClone(COMPLETED_RUNTIME),
    maintenance: async ({ action }) => action === "routes" ? { status: "routes", routes: observedRoutes } : { status: "unavailable" }
  });
  installer.admitMaterialsFolder = async () => {};
  installer.withDesktopMutation = async (action) => action({ stopRuntime: async () => {} });
  installer.executeCli = async (argumentsValue) => {
    const id = argumentsValue[2] === "gemini" ? "gemini-cli" : argumentsValue[2];
    const folder = argumentsValue[argumentsValue.indexOf("--workspace-root") + 1];
    const route = { id: argumentsValue[argumentsValue.indexOf("--route-id") + 1], generation: argumentsValue[argumentsValue.indexOf("--route-generation") + 1] };
    writes.push({ assistant: id, workspaceRoot: folder, route });
    await writeEntry(id, folder, route);
  };
  const writeEntry = async (id, folder, route) => {
    const bundle = buildClientConfigBundle({ repositoryRoot: installer.paths.appRoot, upstreamConfigPath: installer.paths.upstreams,
      nodeCommand: process.execPath, serverEntryPath: installer.paths.server, workspaceRoot: folder, route });
    const filename = id === "codex" ? "codex.config.toml" : "gemini.settings.json";
    const text = bundle.files.find((file) => file.path === filename).content;
    await fs.mkdir(path.dirname(targets[id]), { recursive: true });
    await fs.writeFile(targets[id], text);
    installedRoutes.set(id, route);
    return { target: targets[id], sha256: sha256(text), route };
  };
  const configured = async (ids) => {
    const entries = {};
    for (const id of ids) {
      entries[id] = await writeEntry(id, folders.oldMaterials, { id: crypto.randomUUID(), generation: crypto.randomBytes(32).toString("base64url") });
    }
    return entries;
  };
  return {
    root, folders, targets, installer, writes, installedRoutes,
    observeRoutes: (ids) => { observedRoutes = ids.map((id) => installedRoutes.get(id)); },
    setRoutes: (routes) => { observedRoutes = routes; },
    choose: (folder) => { choice = folder; return installer.configureWorkspace(null); },
    configured
  };
}

async function observe(installer) {
  const state = await installer.state();
  return {
    state,
    connected: state.assistants.filter((assistant) => assistant.connected).map((assistant) => assistant.id),
    configured: state.assistants.filter((assistant) => assistant.configured).map((assistant) => assistant.id)
  };
}

async function check(installer) {
  try {
    await installer.checkAssistantConnection();
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error?.code ?? String(error?.message || error) };
  }
}

function serveInstaller() {
  const server = createServer((request, response) => {
    const file = path.join(INSTALLER, path.normalize(new URL(request.url, "http://127.0.0.1").pathname));
    if (file !== INSTALLER && !file.startsWith(`${INSTALLER}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    fs.readFile(file).then((bytes) => {
      response.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
      response.end(bytes);
    }, () => response.writeHead(404).end());
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** What the renderer drew for one controller state at one width, read from the page. */
async function render(browser, url, state, width, screenshotPath) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((snapshot) => {
    window.morrowInstaller = {
      platform: "darwin",
      invoke: async () => ({ schema: "morrow.installer-result.v1", ok: true, state: snapshot }),
      subscribeUpdates: () => () => {}
    };
  }, state);
  await page.goto(url);
  await page.waitForSelector("#action-content:not([hidden])");
  const drawn = await page.evaluate(() => {
    const textRects = (element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0)
        .map(({ left, right, top, bottom }) => ({ left, right, top, bottom }));
    };
    const body = document.querySelector("#action-body");
    return {
      title: document.querySelector("#action-title").textContent,
      checkButton: body.querySelector('[data-action="check-assistant-connection"]')?.textContent ?? null,
      reopenNotice: body.querySelector(".reopen-notice strong")?.textContent ?? null,
      statusRows: [...body.querySelectorAll(".home-status-row")].map((row) => {
        const box = row.getBoundingClientRect();
        return {
          label: row.querySelector(".home-status-label").textContent,
          word: row.querySelector(".home-status-word").textContent,
          row: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
          texts: {
            label: textRects(row.querySelector(".home-status-label")),
            word: textRects(row.querySelector(".home-status-word")),
            button: textRects(row.querySelector("button"))
          }
        };
      }),
      sideways: document.documentElement.scrollWidth > window.innerWidth
    };
  });
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await page.close();
  assert.deepEqual(errors, [], "the renderer raised no error");
  assert.equal(drawn.sideways, false, `no sideways scroll at ${width}px`);
  const overlaps = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  for (const row of drawn.statusRows) {
    for (const [part, rects] of Object.entries(row.texts)) {
      assert.ok(rects.length > 0, `${row.label} paints its ${part} at ${width}px`);
      for (const rect of rects) {
        assert.ok(rect.left >= row.row.left - 0.5 && rect.right <= row.row.right + 0.5
          && rect.top >= row.row.top - 0.5 && rect.bottom <= row.row.bottom + 0.5, `${row.label} ${part} stays inside its row at ${width}px`);
      }
    }
    for (const [first, second] of [["label", "word"], ["label", "button"], ["word", "button"]]) {
      for (const a of row.texts[first]) {
        for (const b of row.texts[second]) assert.equal(overlaps(a, b), false, `${row.label} ${first} and ${second} overlap at ${width}px`);
      }
    }
  }
  const bytes = await fs.readFile(screenshotPath);
  return {
    width,
    title: drawn.title,
    checkButton: drawn.checkButton,
    reopenNotice: drawn.reopenNotice,
    assistantWord: drawn.statusRows.find((row) => row.label === "Assistant")?.word ?? null,
    statusRowsApart: drawn.statusRows.length,
    screenshot: path.basename(screenshotPath),
    sha256: sha256(bytes)
  };
}

const out = outputDirectory(process.argv.slice(2));
await fs.mkdir(out, { recursive: true });
const startedAt = new Date().toISOString();
const scenarios = [];
const server = await serveInstaller();
const url = `http://127.0.0.1:${server.address().port}/renderer/index.html`;
const browser = await chromium.launch();
const chromiumVersion = browser.version();
try {
  const renders = async (name, state) => {
    const drawn = [];
    for (const width of WIDTHS) drawn.push(await render(browser, url, state, width, path.join(out, `${name}-${width}.png`)));
    return drawn;
  };

  // The audit reproduction: two assistants set up, one runtime session that
  // names neither, then a change of materials folder that writes both again.
  {
    const run = await fixture();
    const configured = await run.configured(["codex", "gemini-cli"]);
    await run.installer.writeRecord({ ...freshRecord(), materialsFolder: run.folders.oldMaterials, selectedAssistantId: "gemini-cli", configured });
    const before = await observe(run.installer);
    const checked = await check(run.installer);
    const afterCheck = await observe(run.installer);
    assert.deepEqual(checked, { ok: false, code: "assistant_not_connected" }, "a session that names no assistant confirms neither");
    assert.deepEqual(afterCheck.connected, [], "neither assistant is recorded as connected");
    const drawnAfterCheck = await renders("two-configured-after-check", afterCheck.state);
    for (const drawn of drawnAfterCheck) {
      assert.equal(drawn.title, "Quit and reopen your assistant.");
      assert.equal(drawn.checkButton, "Check Gemini CLI");
    }
    run.observeRoutes(["gemini-cli"]);
    assert.deepEqual(await check(run.installer), { ok: true });
    assert.deepEqual((await observe(run.installer)).connected, ["gemini-cli"], "Gemini cannot confirm ChatGPT");
    run.observeRoutes(["codex", "gemini-cli"]);
    assert.deepEqual(await check(run.installer), { ok: true });
    assert.deepEqual((await observe(run.installer)).connected, ["codex", "gemini-cli"]);
    const previousRoutes = [...run.installedRoutes.values()];
    const rebound = await run.choose(run.folders.newMaterials);
    const afterRebind = await observe(run.installer);
    assert.equal(rebound, true);
    assert.deepEqual(run.writes.map((write) => write.assistant).sort(), ["codex", "gemini-cli"]);
    assert.deepEqual(afterRebind.connected, []);
    run.setRoutes(previousRoutes);
    assert.deepEqual(await check(run.installer), { ok: false, code: "assistant_connection_unconfirmed" }, "old routes cannot confirm rewritten settings");
    run.observeRoutes(["gemini-cli"]);
    assert.deepEqual(await check(run.installer), { ok: true });
    assert.deepEqual((await observe(run.installer)).connected, ["gemini-cli"]);
    scenarios.push({
      name: "two configured, one generic session, then a new materials folder",
      failureModes: ["FM1", "FM7", "FM9", "FM13"],
      controller: {
        before: before.connected,
        check: checked,
        connectedAfterCheck: afterCheck.connected,
        configurationWrites: run.writes,
        connectedAfterRebind: afterRebind.connected
      },
      renders: drawnAfterCheck
    });
    await fs.rm(run.root, { recursive: true, force: true });
  }

  // One configured assistant still needs its own route. A generic or older
  // session cannot prove that its current settings loaded.
  {
    const run = await fixture();
    const configured = await run.configured(["codex"]);
    await run.installer.writeRecord({ ...freshRecord(), materialsFolder: run.folders.oldMaterials, selectedAssistantId: "codex", configured });
    const pending = await observe(run.installer);
    assert.deepEqual(pending.connected, []);
    assert.deepEqual(await check(run.installer), { ok: false, code: "assistant_not_connected" });
    run.setRoutes([{ id: crypto.randomUUID(), generation: crypto.randomBytes(32).toString("base64url") }]);
    assert.deepEqual(await check(run.installer), { ok: false, code: "assistant_connection_unconfirmed" });
    run.observeRoutes(["codex"]);
    const checked = await check(run.installer);
    const afterCheck = await observe(run.installer);
    assert.deepEqual(checked, { ok: true });
    assert.deepEqual(afterCheck.connected, ["codex"]);
    const drawnReady = await renders("one-configured-confirmed", afterCheck.state);
    for (const drawn of drawnReady) {
      assert.equal(drawn.title, "Morrow is ready.");
      assert.equal(drawn.reopenNotice, null);
      assert.equal(drawn.assistantWord, "Ready");
    }

    const bytesBefore = sha256(await fs.readFile(run.targets.codex));
    assert.equal(await run.choose(run.folders.oldMaterials), true);
    const afterSameFolder = await observe(run.installer);
    assert.deepEqual(run.writes, [], "the folder in use is not written again");
    assert.equal(sha256(await fs.readFile(run.targets.codex)), bytesBefore);
    assert.deepEqual(afterSameFolder.connected, ["codex"]);

    assert.equal(await run.choose(run.folders.newMaterials), true);
    const afterRebind = await observe(run.installer);
    assert.deepEqual(afterRebind.connected, [], "the rewritten assistant must start again");
    const drawnPending = await renders("one-configured-after-rebind", afterRebind.state);
    for (const drawn of drawnPending) {
      assert.equal(drawn.title, "Quit and reopen your assistant.");
      assert.equal(drawn.checkButton, "Check ChatGPT");
    }

    assert.deepEqual(await check(run.installer), { ok: false, code: "assistant_connection_unconfirmed" });
    run.observeRoutes(["codex"]);
    const rechecked = await check(run.installer);
    const afterRecheck = await observe(run.installer);
    assert.deepEqual(rechecked, { ok: true });
    assert.deepEqual(afterRecheck.connected, ["codex"]);
    scenarios.push({
      name: "one configured: confirm, same-folder no-op, new folder, confirm again",
      failureModes: ["FM6", "FM7", "FM9", "FM12", "FM13"],
      controller: {
        connectedBeforeCheck: pending.connected,
        check: checked,
        connectedAfterCheck: afterCheck.connected,
        connectedAfterSameFolder: afterSameFolder.connected,
        configurationWrites: run.writes,
        connectedAfterRebind: afterRebind.connected,
        recheck: rechecked,
        connectedAfterRecheck: afterRecheck.connected
      },
      renders: [...drawnReady, ...drawnPending]
    });
    await fs.rm(run.root, { recursive: true, force: true });
  }
  {
    const run = await fixture();
    const configured = await run.configured(["codex"]);
    const { route: ignored, ...legacy } = configured.codex;
    await run.installer.writeRecord({ ...freshRecord(), materialsFolder: run.folders.oldMaterials, selectedAssistantId: "codex", configured: { codex: legacy } });
    await run.installer.writeAssistantConnectionProofs([{ id: "codex", target: legacy.target, sha256: legacy.sha256, materialsFolder: run.folders.oldMaterials }]);
    const upgrade = await observe(run.installer);
    assert.deepEqual(upgrade.connected, [], "an older entry has no route proof");
    const drawnUpgrade = await renders("legacy-entry-needs-setup", upgrade.state);
    for (const drawn of drawnUpgrade) assert.equal(drawn.title, "Set up your assistant again.");
    await run.installer.writeRecord({ ...await run.installer.record(), configured });
    await fs.writeFile(run.installer.assistantConnectionPath, JSON.stringify({ schema: "morrow.assistant-connections.v2", assistants: [{ id: "codex", target: configured.codex.target, sha256: configured.codex.sha256, materialsFolder: run.folders.oldMaterials }] }), { mode: 0o600 });
    assert.deepEqual((await observe(run.installer)).connected, [], "old inferred proof is invalidated");
    run.observeRoutes(["codex"]);
    assert.deepEqual(await check(run.installer), { ok: true });
    assert.deepEqual((await observe(run.installer)).connected, ["codex"]);
    scenarios.push({ name: "upgrade: entry without route, and older inferred proof", renders: drawnUpgrade });
    await fs.rm(run.root, { recursive: true, force: true });
  }
  {
    const run = await fixture();
    const configured = await run.configured(["codex"]);
    await run.installer.writeRecord({ ...freshRecord(), materialsFolder: run.folders.oldMaterials, selectedAssistantId: "codex", configured });
    run.installer.detectedAssistant = async (assistant) => {
      if (assistant.id === "gemini-cli") throw new Error("synthetic detection failure");
      return true;
    };
    const observed = await observe(run.installer);
    assert.deepEqual(observed.configured, ["codex"], "one failed check cannot lose another assistant");
    assert.equal(observed.state.assistants.find((assistant) => assistant.id === "gemini-cli").statusUnavailable, true);
    run.installer.detectedAssistant = async () => true;
    const inspectConfiguration = run.installer.assistantConfigurationPresent.bind(run.installer);
    run.installer.assistantConfigurationPresent = async (assistant, ...argumentsValue) => {
      if (assistant.id === "gemini-cli") throw new Error("synthetic configuration read failure");
      return inspectConfiguration(assistant, ...argumentsValue);
    };
    const readFailure = await observe(run.installer);
    assert.deepEqual(readFailure.configured, ["codex"]);
    assert.equal(readFailure.state.assistants.find((assistant) => assistant.id === "gemini-cli").statusUnavailable, true);
    scenarios.push({ name: "one assistant detection fails; other assistant stays configured", renders: await renders("assistant-check-isolated", observed.state) });
    await fs.rm(run.root, { recursive: true, force: true });
  }
} finally {
  await browser.close();
  server.close();
}

const receipt = {
  schema: "morrow.desktop-first-use-receipt.v1",
  startedAt,
  finishedAt: new Date().toISOString(),
  commit: git("rev-parse", "HEAD"),
  changedFiles: git("status", "--porcelain", "--", "installer", "scripts/test/desktop-first-use.mjs")?.split("\n").filter(Boolean) ?? null,
  host: { platform: process.platform, arch: process.arch, node: process.version, chromium: chromiumVersion },
  injected: "bounded private runtime route observations and a completed first read of one course; generic lease refusal remains present to prove it cannot confirm an assistant",
  real: "installer controller record, assistant settings files, connection proof, state; installer renderer and stylesheet",
  widths: WIDTHS,
  scenarios,
  result: "passed"
};
await fs.writeFile(path.join(out, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`desktop first use passed; receipt ${path.join(out, "receipt.json")}`);
