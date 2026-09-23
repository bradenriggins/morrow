const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const test = require("node:test");
const {
  claudeDesktopLauncherPath,
  inspectClaudeDesktopConnection: inspectClaudeDesktopConnectionRaw,
  isCurrentClaudeDesktopSetup,
  parseUnixProcessStartTimes,
  parseWindowsProcessStartTimes,
  prepareClaudeDesktopBundle,
  processAlive,
  sameCanonicalPath,
  verifyClaudeProcessProof,
  windowsProcessStartQuery
} = require("../shared/claude-desktop.cjs");
const installerController = require("../shared/installer-controller.cjs");
const { freshRecord } = require("../shared/state-policy.cjs");

const inspectionOptionsBySetup = new WeakMap();

// Claude Desktop runs on macOS and Windows. A fixture uses this host's own
// platform where Claude Desktop runs, and macOS elsewhere: a setup made for
// one platform names paths the other platform cannot hold.
const CLAUDE_DESKTOP_PLATFORM = process.platform === "win32" ? "win32" : "darwin";

function inspectClaudeDesktopConnection(setup, options = inspectionOptionsBySetup.get(setup)) {
  return inspectClaudeDesktopConnectionRaw(setup, options);
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-claude-desktop-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "Materials with spaces");
  const state = path.join(root, "State");
  await fs.mkdir(workspace);
  await fs.mkdir(state, { mode: 0o700 });
  const server = path.join(root, "server.cjs");
  const node = path.join(root, process.platform === "win32" ? "node.exe" : "node");
  const runtimeManifest = path.join(root, "mcp-runtime-manifest.json");
  const upstreams = path.join(state, "upstreams.json");
  const descendantPath = path.join(root, "server-descendant.pid");
  await fs.writeFile(upstreams, JSON.stringify({ privateFixtureValue: "must-not-be-bundled" }));
  const stubbornServer = options.stubbornTree ? [
    'const { spawn } = require("node:child_process");',
    `const descendant = spawn(process.execPath, ["-e", ${JSON.stringify("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)")}], { stdio: "ignore" });`,
    `fs.writeFileSync(${JSON.stringify(descendantPath)}, String(descendant.pid));`,
    'process.on("SIGTERM", () => {});',
    'setInterval(() => {}, 1000);',
  ].join("\n") : "";
  await fs.writeFile(server, `const readline = require("node:readline");
const fs = require("node:fs");
${stubbornServer}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    const response = { ${options.invalidJsonRpc ? "" : 'jsonrpc: "2.0",'} id: message.id,
      result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: ${JSON.stringify(options.fragmentUnicode ? "mor🌾row" : "morrow")}, version: "1.0.0" } } };
    const bytes = Buffer.from(JSON.stringify(response) + "\\n");
    if (${options.invalidUtf8 === true}) {
      process.stdout.write(Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"'), Buffer.from([0xff]), Buffer.from('"}}\\n')]));
    } else if (${options.fragmentUnicode === true}) {
      const split = bytes.indexOf(Buffer.from("🌾")) + 1;
      process.stdout.write(bytes.subarray(0, split));
      setTimeout(() => process.stdout.write(bytes.subarray(split)), 30);
    } else process.stdout.write(bytes);
  }
  if (message.method === "test/paths") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id,
    result: { workspace: process.cwd(), upstreams: process.env.MORROW_UPSTREAMS_FILE } }) + "\\n");
});`);
  // The launcher starts this file itself. Windows starts only an executable,
  // so there the fixture is a copy of this Node; elsewhere a small script runs it.
  if (process.platform === "win32") await fs.copyFile(process.execPath, node);
  else await fs.writeFile(node, "#!/bin/sh\nexec " + JSON.stringify(process.execPath) + " \"$@\"\n", { mode: 0o700 });
  const serverBytes = await fs.readFile(server);
  await fs.writeFile(runtimeManifest, JSON.stringify({
    schema: "morrow.mcp-runtime-manifest.v2",
    entrypoint: {
      path: "server.cjs",
      bytes: serverBytes.length,
      sha256: crypto.createHash("sha256").update(serverBytes).digest("hex")
    },
    dependencies: [],
    directFiles: []
  }) + "\n");
  const extracted = path.join(root, "Claude", "Claude Extensions", "local.mcpb.morrow.morrow");
  const managedLauncherPath = path.join(extracted, "server", "launch.cjs");
  const setup = await prepareClaudeDesktopBundle({ nodePath: node, serverEntryPath: server,
    runtimeManifestPath: runtimeManifest, upstreamsPath: upstreams, workspaceRoot: workspace,
    stateDirectory: state, version: "1.0.0-rc.0", platform: CLAUDE_DESKTOP_PLATFORM, managedLauncherPath });
  const installerRecordPath = path.join(state, "installer.json");
  await fs.writeFile(installerRecordPath, `${JSON.stringify({ ...freshRecord(), configured: { "claude-desktop": setup } })}\n`, { mode: 0o600 });
  const { unpackExtension } = await import("@anthropic-ai/mcpb");
  assert.equal(await unpackExtension({ mcpbPath: setup.bundlePath, outputDir: extracted, silent: true }), true);
  const result = {
    root,
    workspace: await fs.realpath(workspace),
    node: await fs.realpath(node),
    server: await fs.realpath(server),
    runtimeManifest: await fs.realpath(runtimeManifest),
    upstreams: await fs.realpath(upstreams),
    descendantPath,
    setup,
    extracted,
    managedLauncherPath,
    installerRecordPath,
    inspectionOptions: { platform: CLAUDE_DESKTOP_PLATFORM, managedLauncherPath, verifyClaudeProcessProof: async () => true }
  };
  inspectionOptionsBySetup.set(setup, result.inspectionOptions);
  return result;
}

const CONNECTION_OBSERVATION_INTERVAL_MS = 20;

function processEnded(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Waits until `predicate` holds. A busy computer only makes it wait longer:
 * it fails when a process it names ends first, and the bounded test runner
 * ends a wait that never settles.
 */
async function waitFor(predicate, ...processes) {
  for (;;) {
    if (await predicate()) return;
    const ended = processes.find(processEnded);
    if (ended) {
      if (await predicate()) return;
      assert.fail(`process ${ended.pid} ended before the expected connection state was observed`);
    }
    await new Promise((resolve) => setTimeout(resolve, CONNECTION_OBSERVATION_INTERVAL_MS));
  }
}

/** Waits until `child` has written `text` to stdout, collected in `chunks`; fails if it closes first. */
function outputIncludes(child, chunks, text) {
  return new Promise((resolve, reject) => {
    const written = () => Buffer.concat(chunks).toString().includes(text);
    const check = () => {
      if (!written()) return;
      cleanup();
      resolve();
    };
    const closed = () => {
      cleanup();
      if (written()) resolve();
      else reject(new Error(`the launcher closed before it wrote ${text}`));
    };
    const cleanup = () => {
      child.stdout.off("data", check);
      child.off("close", closed);
    };
    child.stdout.on("data", check);
    child.once("close", closed);
    check();
  });
}

/** A process id whose process has ended, so nothing is running under it now. */
async function endedProcessId() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "close");
  return child.pid;
}

/** A process that keeps running until the test ends. */
function runningProcess(t) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  return child;
}

async function writeReceipt(input, receipt) {
  const { setup } = input;
  const metadata = JSON.parse(await fs.readFile(path.join(path.dirname(setup.receiptPath), "setup.json"), "utf8"));
  return fs.writeFile(setup.receiptPath, `${JSON.stringify({ schema: "morrow.claude-desktop-connection.v5",
    installationId: setup.installationId, launcherSha256: metadata.launcherSha256, claudeProcessCheck: "complete", claudeProcess: null,
    launcherPath: await fs.realpath(path.join(input.extracted, "server", "launch.cjs")),
    clientInfo: { name: "morrow-extension-test", version: "1.0.0" }, protocolVersion: "2025-11-25", ...receipt })}\n`);
}

async function inspect(input, options = {}) {
  return inspectClaudeDesktopConnection(input.setup, { ...input.inspectionOptions, ...options });
}

async function activateSetup(input, setup, extra = {}) {
  const record = {
    ...freshRecord(),
    ...extra,
    configured: setup ? { ...(extra.configured || {}), "claude-desktop": setup } : { ...(extra.configured || {}) },
  };
  await fs.writeFile(input.installerRecordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await fs.chmod(input.installerRecordPath, 0o600);
}

async function handshake(child, { complete = true } = {}) {
  const chunks = [];
  const receive = (chunk) => { chunks.push(chunk); };
  child.stdout.on("data", receive);
  const answered = outputIncludes(child, chunks, "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "morrow-extension-test", version: "1.0.0" }
  } }) + "\n");
  try {
    await answered;
  } finally {
    child.stdout.off("data", receive);
  }
  if (complete) child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
}

/** An installer controller over a temporary user-data root, as main.cjs builds one. */
function controller(root, overrides = {}) {
  return installerController.createInstallerController({
    app: { getPath: (name) => (name === "userData" ? path.join(root, "UserData") : root) },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
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
    ...overrides,
  });
}

test("native Claude bundle uses the client Node runtime and requires a completed initialize handshake", async (t) => {
  const input = await fixture(t);
  assert.deepEqual((await fs.readdir(input.extracted)).sort(), ["icon.png", "manifest.json", "server"]);
  const manifest = JSON.parse(await fs.readFile(path.join(input.extracted, "manifest.json"), "utf8"));
  assert.equal(manifest.server.mcp_config.command, "node");
  assert.deepEqual(manifest.server.mcp_config.args, ["${__dirname}/server/launch.cjs"]);
  const launcher = path.join(input.extracted, "server", "launch.cjs");
  assert.doesNotMatch(await fs.readFile(launcher, "utf8"), /must-not-be-bundled/);
  assert.deepEqual(await inspectClaudeDesktopConnection(input.setup), { installed: false, running: false });
  const child = spawn(process.execPath, [launcher], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", () => {});
  await handshake(child, { complete: false });
  assert.deepEqual(await inspectClaudeDesktopConnection(input.setup), { installed: false, running: false });
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await waitFor(async () => (await inspectClaudeDesktopConnection(input.setup)).installed, child);
  await waitFor(async () => (await inspectClaudeDesktopConnection(input.setup)).running === true, child);
  child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"test/paths"}\n');
  await outputIncludes(child, output, '"id":2');
  const lines = Buffer.concat(output).toString().trim().split("\n").map(JSON.parse);
  assert.equal(lines[0].result.serverInfo.name, "morrow");
  assert.deepEqual(lines.find((line) => line.id === 2).result, { workspace: input.workspace, upstreams: input.upstreams });
  const receipt = JSON.parse(await fs.readFile(input.setup.receiptPath, "utf8"));
  assert.deepEqual(await fs.readFile(receipt.launcherPath), await fs.readFile(launcher));
  assert.deepEqual(receipt.clientInfo, { name: "morrow-extension-test", version: "1.0.0" });
  const stopped = once(child, "close");
  child.stdin.end();
  await stopped;

  // Closing Claude Desktop ends these processes. The extension is still
  // installed, so Morrow must not ask the person to set it up again.
  assert.deepEqual(await inspectClaudeDesktopConnection(input.setup), { installed: true, running: false });
});

test("the managed Claude launcher terminates its complete stubborn server process tree", async (t) => {
  if (process.platform === "win32") return t.skip("the POSIX process-group regression is not available on Windows");
  const input = await fixture(t, { stubbornTree: true });
  const launcher = path.join(input.extracted, "server", "launch.cjs");
  const child = spawn(process.execPath, [launcher], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  child.stdout.resume();
  child.stderr.resume();
  await handshake(child);
  await waitFor(async () => (await inspectClaudeDesktopConnection(input.setup)).installed, child);
  await waitFor(async () => {
    try { return Number.isSafeInteger(Number(await fs.readFile(input.descendantPath, "utf8"))); } catch { return false; }
  }, child);
  const receipt = JSON.parse(await fs.readFile(input.setup.receiptPath, "utf8"));
  const descendantPid = Number(await fs.readFile(input.descendantPath, "utf8"));
  assert.equal(processAlive(receipt.proxyPid), true);
  assert.equal(processAlive(descendantPid), true);
  const stopped = once(child, "close");
  child.stdin.end();
  await stopped;
  await waitFor(() => !processAlive(receipt.proxyPid) && !processAlive(descendantPid));
});

test("the managed Claude launcher refuses malformed UTF-8 before recording a connection", async (t) => {
  const input = await fixture(t, { invalidUtf8: true });
  const launcher = path.join(input.extracted, "server", "launch.cjs");
  const child = spawn(process.execPath, [launcher], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  child.stderr.resume();
  const stopped = once(child, "close");
  await handshake(child, { complete: false });
  await stopped;
  await assert.rejects(() => fs.stat(input.setup.receiptPath), { code: "ENOENT" });
});

test("a closed verified Claude Desktop receipt preserves the installed fact", async (t) => {
  const input = await fixture(t);
  await writeReceipt(input, { launcherPid: await endedProcessId(), proxyPid: await endedProcessId(),
    connectedAt: new Date().toISOString() });
  assert.deepEqual(await inspectClaudeDesktopConnection(input.setup), { installed: true, running: false });
});

test("Windows Claude setup opens the registered app and reveals only its own extension file", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-claude-desktop-open-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const installer = controller(root, { isCurrentClaudeDesktopSetup: async () => true });
  installer.platform = "win32";
  let bundle = path.join(installer.paths.state, "ClaudeDesktop", "setup-fixture", "Morrow.mcpb");
  await fs.mkdir(path.dirname(bundle), { recursive: true });
  await fs.writeFile(bundle, "extension fixture");
  bundle = await fs.realpath(bundle);
  const calls = [];
  installer.shell = {
    openExternal: async (value) => calls.push(["application", value]),
    openPath: async () => assert.fail("Windows must not depend on a .mcpb file association"),
    showItemInFolder: (value) => calls.push(["file", value])
  };
  await installer.writeRecord({ ...freshRecord(), configured: { "claude-desktop": {
    bundlePath: bundle,
    installationId: "windows-open-test",
    receiptPath: path.join(path.dirname(bundle), "connection.json")
  } } });
  await installer.openClaudeDesktop();
  await installer.revealClaudeDesktopBundle();
  assert.deepEqual(calls, [["application", "claude://"], ["file", bundle]]);

  const outside = path.join(root, "Morrow.mcpb");
  await fs.writeFile(outside, "unrelated file");
  await installer.writeRecord({ ...freshRecord(), configured: { "claude-desktop": {
    bundlePath: outside,
    installationId: "windows-outside-test",
    receiptPath: path.join(path.dirname(outside), "connection.json")
  } } });
  await assert.rejects(installer.revealClaudeDesktopBundle(), { code: "setup_failed" });
  assert.equal(calls.length, 2);
});

test("a mismatched or oversized connection receipt cannot mark Claude configured", async (t) => {
  const input = await fixture(t);
  const { setup } = input;
  await fs.writeFile(setup.receiptPath, JSON.stringify({ schema: "morrow.claude-desktop-connection.v2",
    installationId: "different-installation", launcherPid: process.pid, proxyPid: process.pid }));
  assert.deepEqual(await inspectClaudeDesktopConnection(setup), { installed: false, running: false });
  await writeReceipt(input, { schema: "morrow.claude-desktop-connection.v1", launcherPid: process.pid, proxyPid: process.pid });
  assert.equal((await inspectClaudeDesktopConnection(setup)).installed, false);
  await fs.writeFile(setup.receiptPath, "x".repeat(4097));
  assert.equal((await inspectClaudeDesktopConnection(setup)).installed, false);
});

test("a process id reused after the recorded connection is not reported as running", async (t) => {
  const input = await fixture(t);
  const { setup } = input;
  const reused = runningProcess(t);

  // This process started after the receipt was written, so it holds a reused id.
  await writeReceipt(input, { launcherPid: process.pid, proxyPid: reused.pid,
    connectedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
  assert.deepEqual(await inspectClaudeDesktopConnection(setup), { installed: true, running: false });

  await writeReceipt(input, { launcherPid: process.pid, proxyPid: reused.pid, connectedAt: new Date().toISOString() });
  await waitFor(async () => (await inspectClaudeDesktopConnection(setup)).running === true, reused);

  await writeReceipt(input, { launcherPid: process.pid, proxyPid: reused.pid, connectedAt: "not a time" });
  assert.deepEqual(await inspectClaudeDesktopConnection(setup), { installed: false, running: false });
});

test("process liveness treats EPERM as alive and the installer answers it in one place", async (t) => {
  assert.equal(processAlive, installerController.processAlive, "the installer has one process-liveness helper");
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(await endedProcessId()), false);
  for (const invalid of [0, -1, 1.5, "1", null, undefined, Number.MAX_SAFE_INTEGER + 2]) assert.equal(processAlive(invalid), false);
  let denied = false;
  try { process.kill(1, 0); } catch (error) { denied = error?.code === "EPERM"; }
  if (!denied) {
    t.skip("this account may signal process 1, so EPERM cannot be observed here");
    return;
  }
  assert.equal(processAlive(1), true, "a process this account may not signal is still running");
});

test("the Windows start-time query asks for both ids and its answer is read", () => {
  const query = windowsProcessStartQuery([1234, 5678]);
  assert.match(query, /\$processIdentifiers = @\(1234, 5678\)/);
  assert.match(query, /System\.Diagnostics\.Process]::GetProcessById/);
  assert.match(query, /ConvertTo-Json -Compress/);
  assert.equal(sameCanonicalPath("C:\\Users\\Teacher\\Morrow.cjs", "c:\\Users\\Teacher\\Morrow.cjs", "win32"), true);
  assert.equal(sameCanonicalPath("C:\\Users\\Teacher\\Morrow.cjs", "C:\\Users\\Teacher\\..\\Morrow.cjs", "win32"), false);
  const started = parseWindowsProcessStartTimes('[{"processId":1234,"startedAt":"2026-09-06T10:00:00.1234567Z"},{"processId":5678,"startedAt":"2026-09-06T10:00:01.0000000Z"}]');
  assert.deepEqual([...started], [[1234, Date.parse("2026-09-06T10:00:00.123Z")], [5678, Date.parse("2026-09-06T10:00:01Z")]]);
  assert.equal(parseWindowsProcessStartTimes('{"processId":9,"startedAt":"2026-09-06T10:00:00.0000000Z"}').get(9), Date.parse("2026-09-06T10:00:00Z"));
  assert.equal(parseWindowsProcessStartTimes("not json").size, 0);
  assert.equal(parseWindowsProcessStartTimes("").size, 0);
  assert.equal(parseUnixProcessStartTimes("  4321 Sun Sep  6 23:22:58 2026    \n").get(4321), Date.parse("Sun Sep  6 23:22:58 2026"));
  assert.equal(parseUnixProcessStartTimes("ps: no such process\n").size, 0);
});

for (const invalidJsonRpc of [false, true]) {
  test(invalidJsonRpc ? "a non-JSON-RPC response cannot mark Claude configured" : "fragmented Unicode in a real initialize response is decoded correctly", async (t) => {
    const input = await fixture(t, { fragmentUnicode: true, invalidJsonRpc });
    const child = spawn(process.execPath, [path.join(input.extracted, "server", "launch.cjs")], { stdio: ["pipe", "pipe", "pipe"] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", () => {});
    await handshake(child);
    await outputIncludes(child, output, "\n");
    assert.equal(JSON.parse(Buffer.concat(output).toString()).result.serverInfo.name, "mor🌾row");
    if (!invalidJsonRpc) await waitFor(async () => (await inspectClaudeDesktopConnection(input.setup)).installed, child);
    assert.equal((await inspectClaudeDesktopConnection(input.setup)).installed, !invalidJsonRpc);
    const stopped = once(child, "close");
    child.stdin.end();
    await stopped;
  });
}

const proofSimulation = path.join(__dirname, "fixtures", "claude-proof-simulation.cjs");

/** Starts the fixture launcher with its Claude process proof answered as `mode` says (see the fixture). */
function launchWithProof(t, input, mode) {
  const log = path.join(input.root, `proof-questions-${crypto.randomUUID()}.log`);
  const child = spawn(process.execPath, ["--require", proofSimulation, path.join(input.extracted, "server", "launch.cjs")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MORROW_TEST_CLAUDE_PROOF: mode, MORROW_TEST_CLAUDE_PROOF_LOG: log },
  });
  t.after(() => { if (!processEnded(child)) child.kill(); });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.resume();
  const questions = async () => (await fs.readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  return { child, output, questions };
}

async function receiptOf(input) {
  try { return JSON.parse(await fs.readFile(input.setup.receiptPath, "utf8")); } catch { return null; }
}

async function closeLauncher(child) {
  const stopped = once(child, "close");
  child.stdin.end();
  await stopped;
}

test("messages keep flowing while the Claude process proof runs, one proof at a time, and the receipt waits for its answer", async (t) => {
  const input = await fixture(t);
  const gate = path.join(input.root, "proof-gate");
  const { child, output, questions } = launchWithProof(t, input, `gate:${gate}`);
  await handshake(child);
  await waitFor(async () => (await questions()) === 1, child);
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"test/paths"}\n');
  await outputIncludes(child, output, '"id":2');
  assert.equal(await receiptOf(input), null, "no receipt is written before the proof answers");
  assert.equal(await questions(), 1, "a second initialized notification starts no second proof");

  await fs.writeFile(gate, "");
  await waitFor(async () => (await receiptOf(input)) !== null, child);
  const receipt = await receiptOf(input);
  assert.equal(receipt.claudeProcessCheck, "complete");
  assert.equal(receipt.claudeProcess.processId, 4242);
  assert.deepEqual(await inspectClaudeDesktopConnection(input.setup), { installed: true, running: true });
  assert.equal(await questions(), 1);
  await closeLauncher(child);
});

test("a Claude process proof that answers after 3.5 seconds, within the 10 second limit, proves the connection", async (t) => {
  const input = await fixture(t);
  const { child, questions } = launchWithProof(t, input, "delay:3500");
  await handshake(child);
  await waitFor(async () => (await receiptOf(input)) !== null, child);
  const receipt = await receiptOf(input);
  assert.equal(receipt.claudeProcessCheck, "complete");
  assert.equal(receipt.claudeProcess.processId, 4242);
  assert.equal((await inspectClaudeDesktopConnection(input.setup)).installed, true);
  assert.equal(await questions(), 1);
  await closeLauncher(child);
});

for (const [mode, description] of [
  ["hang", "never answers within 10 seconds"],
  ["malformed", "answers with text that is not JSON"],
  ["wrong-shape", "answers with JSON that is not a proof"],
]) {
  test(`a Claude process proof that ${description} is recorded unverified, shown as still checking, and never as connected`, async (t) => {
    const input = await fixture(t);
    const { child, questions } = launchWithProof(t, input, mode);
    await handshake(child);
    await waitFor(async () => (await receiptOf(input)) !== null, child);
    let receipt = await receiptOf(input);
    assert.equal(receipt.claudeProcessCheck, "unverified");
    assert.equal(receipt.claudeProcess, null);
    assert.deepEqual(await inspectClaudeDesktopConnection(input.setup), { installed: false, running: true, checking: true });
    if (mode !== "hang") {
      // The launcher asks again, and a second unverified answer claims nothing either.
      await waitFor(async () => (await questions()) >= 2 && (await receiptOf(input)) !== null, child);
      receipt = await receiptOf(input);
      assert.equal(receipt.claudeProcessCheck, "unverified");
      assert.equal(receipt.claudeProcess, null);
    }
    await closeLauncher(child);
    assert.deepEqual(await inspectClaudeDesktopConnection(input.setup), { installed: false, running: false },
      "a closed launcher cannot finish its check, so its unverified receipt proves nothing");
  });
}

test("the launcher asks again after an unverified answer, and a later proof proves the connection", async (t) => {
  const input = await fixture(t);
  const { child, questions } = launchWithProof(t, input, "malformed-then-proof");
  await handshake(child);
  await waitFor(async () => (await receiptOf(input))?.claudeProcessCheck === "unverified", child);
  await waitFor(async () => (await receiptOf(input))?.claudeProcessCheck === "complete", child);
  assert.equal((await receiptOf(input)).claudeProcess.processId, 4242);
  assert.equal(await questions(), 2);
  assert.equal((await inspectClaudeDesktopConnection(input.setup)).installed, true);
  await closeLauncher(child);
});

test("a receipt must say whether its Claude process proof answered, and an unverified one carries no proof", async (t) => {
  const input = await fixture(t);
  const launcherPid = await endedProcessId();
  const proxyPid = await endedProcessId();
  const connectedAt = new Date().toISOString();
  await writeReceipt(input, { launcherPid, proxyPid, connectedAt });
  assert.deepEqual(await inspectClaudeDesktopConnection(input.setup), { installed: true, running: false });
  for (const change of [
    { claudeProcessCheck: undefined },
    { claudeProcessCheck: "pending" },
    { claudeProcessCheck: "unverified", claudeProcess: { platform: "win32", processId: 4 } },
  ]) {
    await writeReceipt(input, { launcherPid, proxyPid, connectedAt, ...change });
    assert.deepEqual(await inspectClaudeDesktopConnection(input.setup), { installed: false, running: false }, JSON.stringify(change));
  }
});

test("native removal of the installed launcher closes its proxy and clears the connection receipt", async (t) => {
  const input = await fixture(t);
  const launcher = path.join(input.extracted, "server", "launch.cjs");
  const child = spawn(process.execPath, [launcher], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  child.stdout.resume();
  child.stderr.resume();
  await handshake(child);
  await waitFor(async () => (await inspectClaudeDesktopConnection(input.setup)).installed, child);
  const stopped = once(child, "close");
  await fs.unlink(launcher);
  await stopped;

  // Claude removed the extension, so this setup is no longer installed.
  await waitFor(async () => (await inspectClaudeDesktopConnection(input.setup)).installed === false);
  await assert.rejects(() => fs.stat(input.setup.receiptPath), { code: "ENOENT" });
});

test("a closed client's receipt stops proving installation when its launcher is removed or replaced", async (t) => {
  const input = await fixture(t);
  const launcher = path.join(input.extracted, "server", "launch.cjs");
  const child = spawn(process.execPath, [launcher], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  child.stderr.resume();
  await handshake(child);
  await waitFor(async () => (await inspectClaudeDesktopConnection(input.setup)).installed, child);
  const stopped = once(child, "close");
  child.stdin.end();
  await stopped;
  assert.deepEqual(await inspectClaudeDesktopConnection(input.setup), { installed: true, running: false });
  const source = await fs.readFile(launcher);
  await fs.unlink(launcher);
  assert.deepEqual(await inspectClaudeDesktopConnection(input.setup), { installed: false, running: false });
  await fs.writeFile(launcher, Buffer.concat([source, Buffer.from("\n// replacement\n")]));
  assert.deepEqual(await inspectClaudeDesktopConnection(input.setup), { installed: false, running: false });
});

test("an arbitrary copied launcher cannot refresh the managed connection receipt", async (t) => {
  const input = await fixture(t);
  const firstLauncher = path.join(input.extracted, "server", "launch.cjs");
  const first = spawn(process.execPath, [firstLauncher], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (first.exitCode === null) first.kill(); });
  first.stderr.resume();
  await handshake(first);
  await waitFor(async () => (await inspectClaudeDesktopConnection(input.setup)).installed, first);
  const secondDirectory = path.join(input.root, "Reinstalled by assistant");
  await fs.mkdir(secondDirectory);
  const secondLauncher = path.join(secondDirectory, "launch.cjs");
  await fs.copyFile(firstLauncher, secondLauncher);
  const second = spawn(process.execPath, [secondLauncher], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (second.exitCode === null) second.kill(); });
  const errors = [];
  second.stderr.on("data", (chunk) => errors.push(chunk));
  assert.equal((await once(second, "close"))[0], 1);
  assert.match(Buffer.concat(errors).toString(), /Morrow setup changed/);
  assert.deepEqual(await inspectClaudeDesktopConnection(input.setup), { installed: true, running: true });
  assert.equal(JSON.parse(await fs.readFile(input.setup.receiptPath, "utf8")).launcherPid, first.pid);
  const closed = once(first, "close");
  first.stdin.end();
  await closed;
});

test("replacing Morrow setup revokes the running old workspace and prevents its installed copy reopening", async (t) => {
  const input = await fixture(t);
  const launcher = path.join(input.extracted, "server", "launch.cjs");
  const child = spawn(process.execPath, [launcher], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  child.stderr.resume();
  await handshake(child);
  await waitFor(async () => (await inspectClaudeDesktopConnection(input.setup)).installed, child);
  const stopped = once(child, "close");
  await fs.rm(path.dirname(input.setup.bundlePath), { recursive: true });
  await stopped;
  assert.deepEqual(await inspectClaudeDesktopConnection(input.setup), { installed: false, running: false });
  const reopened = spawn(process.execPath, [launcher], { stdio: ["pipe", "pipe", "pipe"] });
  const errors = [];
  reopened.stderr.on("data", (chunk) => errors.push(chunk));
  assert.equal((await once(reopened, "close"))[0], 1);
  assert.match(Buffer.concat(errors).toString(), /Morrow setup changed/);
});

test("the installer record alone activates one generation and revokes a stale receipt and process", async (t) => {
  const input = await fixture(t);
  const launcherA = input.managedLauncherPath;
  const processA = spawn(process.execPath, [launcherA], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (processA.exitCode === null) processA.kill(); });
  processA.stdout.resume();
  processA.stderr.resume();
  await handshake(processA);
  await waitFor(async () => (await inspect(input)).installed, processA);

  await activateSetup(input, input.setup, { selectedAssistantId: "claude-desktop" });
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(processA.exitCode, null, "an unrelated valid record update preserves the active generation");

  const extractedB = path.join(input.root, "Claude B", "Claude Extensions", "local.mcpb.morrow.morrow");
  const launcherB = path.join(extractedB, "server", "launch.cjs");
  const setupB = await prepareClaudeDesktopBundle({
    nodePath: input.node,
    serverEntryPath: input.server,
    runtimeManifestPath: input.runtimeManifest,
    upstreamsPath: input.upstreams,
    workspaceRoot: input.workspace,
    stateDirectory: path.dirname(input.installerRecordPath),
    version: "1.0.0-rc.0",
    platform: CLAUDE_DESKTOP_PLATFORM,
    managedLauncherPath: launcherB,
  });
  const { unpackExtension } = await import("@anthropic-ai/mcpb");
  assert.equal(await unpackExtension({ mcpbPath: setupB.bundlePath, outputDir: extractedB, silent: true }), true);

  const inactiveB = spawn(process.execPath, [launcherB], { stdio: ["pipe", "pipe", "pipe"] });
  inactiveB.stderr.resume();
  assert.equal((await once(inactiveB, "close"))[0], 1, "a prepared but unrecorded generation cannot start");

  const stoppedA = once(processA, "close");
  await activateSetup(input, setupB, { selectedAssistantId: "claude-desktop" });
  assert.deepEqual(await inspect(input), { installed: false, running: false }, "A's valid receipt became stale at the record commit");
  await stoppedA;

  const reopenedA = spawn(process.execPath, [launcherA], { stdio: ["pipe", "pipe", "pipe"] });
  reopenedA.stderr.resume();
  assert.equal((await once(reopenedA, "close"))[0], 1, "generation A cannot reopen while B is active");

  const processB = spawn(process.execPath, [launcherB], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (processB.exitCode === null) processB.kill(); });
  processB.stdout.resume();
  processB.stderr.resume();
  await handshake(processB);
  const optionsB = { ...input.inspectionOptions, managedLauncherPath: launcherB };
  await waitFor(async () => (await inspectClaudeDesktopConnectionRaw(setupB, optionsB)).installed, processB);

  const stoppedB = once(processB, "close");
  await activateSetup(input, null);
  assert.deepEqual(await inspectClaudeDesktopConnectionRaw(setupB, optionsB), { installed: false, running: false });
  await stoppedB;
});

test("a missing, linked, malformed, or oversized installer record fails before server spawn", async (t) => {
  for (const state of ["missing", "linked", "malformed", "oversized"]) {
    const input = await fixture(t);
    const admitted = await fs.readFile(input.installerRecordPath);
    if (state === "missing") await fs.unlink(input.installerRecordPath);
    if (state === "linked") {
      const target = `${input.installerRecordPath}.target`;
      await fs.rename(input.installerRecordPath, target);
      await fs.symlink(target, input.installerRecordPath);
    }
    if (state === "malformed") await fs.writeFile(input.installerRecordPath, "{not-json}\n");
    if (state === "oversized") await fs.writeFile(input.installerRecordPath, Buffer.alloc(64 * 1024 + 1, 0x78));
    const child = spawn(process.execPath, [input.managedLauncherPath], { stdio: ["pipe", "pipe", "pipe"] });
    const errors = [];
    child.stderr.on("data", (chunk) => errors.push(chunk));
    assert.equal((await once(child, "close"))[0], 1, state);
    assert.match(Buffer.concat(errors).toString(), /Morrow setup changed/, state);
    assert.equal((await inspect(input)).installed, false, state);
    if (state !== "linked") await fs.writeFile(input.installerRecordPath, admitted, { mode: 0o600 });
  }
});

test("a generated source launcher or unavailable runtime cannot prove an installed connection", async (t) => {
  const input = await fixture(t);
  await writeReceipt(input, { launcherPid: await endedProcessId(), proxyPid: await endedProcessId(), connectedAt: new Date().toISOString() });
  assert.deepEqual(await inspectClaudeDesktopConnection(input.setup), { installed: true, running: false });
  const receipt = JSON.parse(await fs.readFile(input.setup.receiptPath, "utf8"));
  await fs.writeFile(input.setup.receiptPath, JSON.stringify({ ...receipt,
    launcherPath: path.join(path.dirname(input.setup.bundlePath), "bundle", "server", "launch.cjs") }));
  assert.deepEqual(await inspectClaudeDesktopConnection(input.setup), { installed: false, running: false });
  await fs.writeFile(input.setup.receiptPath, JSON.stringify(receipt));
  await fs.unlink(path.join(input.root, "server.cjs"));
  assert.deepEqual(await inspectClaudeDesktopConnection(input.setup), { installed: false, running: false });
});

test("legacy bundles and changed runtime or workspace paths require fresh extension preparation", async (t) => {
  const input = await fixture(t);
  assert.equal(await isCurrentClaudeDesktopSetup(input.setup), true);
  assert.equal(await isCurrentClaudeDesktopSetup(input.setup, {
    nodePath: input.node,
    runtimeManifestPath: input.runtimeManifest,
    workspaceRoot: input.workspace
  }), true);
  assert.equal(await isCurrentClaudeDesktopSetup(input.setup, { workspaceRoot: input.root }), false);
  assert.equal(await isCurrentClaudeDesktopSetup(input.setup, { serverEntryPath: path.join(input.root, "unavailable.cjs") }), false);
  await fs.unlink(path.join(path.dirname(input.setup.receiptPath), "setup.json"));
  assert.equal(await isCurrentClaudeDesktopSetup(input.setup), false);
});

test("Claude-managed launcher locations are exact on macOS and Windows", () => {
  assert.equal(claudeDesktopLauncherPath({ platform: "darwin", homeDirectory: "/Users/Teacher" }),
    "/Users/Teacher/Library/Application Support/Claude/Claude Extensions/local.mcpb.morrow.morrow/server/launch.cjs");
  assert.equal(claudeDesktopLauncherPath({ platform: "win32", appDataDirectory: "C:\\Users\\Teacher\\AppData\\Roaming" }),
    "C:\\Users\\Teacher\\AppData\\Roaming\\Claude\\Claude Extensions\\local.mcpb.morrow.morrow\\server\\launch.cjs");
});

test("macOS and Windows process proof require the recorded Claude ancestor", async () => {
  const cases = [{
    platform: "darwin",
    proof: {
      platform: "darwin",
      processId: 41,
      executablePath: "/Applications/Claude.app/Contents/MacOS/Claude",
      bundleId: "com.anthropic.claudefordesktop",
      teamId: "Q6L2SF6YDW"
    }
  }, {
    platform: "win32",
    proof: {
      platform: "win32",
      processId: 52,
      executablePath: "C:\\Users\\Teacher\\AppData\\Local\\AnthropicClaude\\Claude.exe",
      signerThumbprint: "A".repeat(40)
    }
  }];
  for (const { platform, proof } of cases) {
    const receipt = { launcherPid: 99, claudeProcess: proof };
    const dependencies = {
      platform,
      running: true,
      resolveExecutable: async (value) => value,
      verifyExecutableIdentity: async () => true,
      readProcessAncestry: async () => [{ processId: proof.processId, executablePath: proof.executablePath }]
    };
    assert.equal(await verifyClaudeProcessProof(receipt, dependencies), true, platform);
    assert.equal(await verifyClaudeProcessProof(receipt, {
      ...dependencies,
      readProcessAncestry: async () => [{ processId: proof.processId + 1, executablePath: proof.executablePath }]
    }), false, platform);
  }
});

test("Windows process proof waits for a cold PowerShell start", async () => {
  const lifetime = require("../shared/process-lifetime.cjs");
  const modulePath = require.resolve("../shared/claude-desktop.cjs");
  const original = lifetime.readBoundedCommandOutput;
  const executablePath = "C:\\Users\\Teacher\\AppData\\Local\\AnthropicClaude\\Claude.exe";
  const thumbprint = "A".repeat(40);
  const answers = [];
  delete require.cache[modulePath];
  // Each PowerShell here answers after 4 s, as a cold start can on Windows.
  lifetime.readBoundedCommandOutput = async (executable, argumentsValue, options) => {
    const script = argumentsValue.at(-1);
    answers.push({ executable, timeoutMs: options.timeoutMs });
    if (options.timeoutMs <= 4_000) return null;
    if (script.includes("Get-AuthenticodeSignature")) {
      return JSON.stringify({ subject: "CN=Anthropic, PBC", thumbprint });
    }
    const pid = Number(/ProcessId=([0-9]+)/.exec(script)?.[1]);
    return JSON.stringify(pid === 99
      ? { processId: 99, parentProcessId: 52, executablePath: "C:\\Morrow\\launch.cjs" }
      : { processId: 52, parentProcessId: 1, executablePath });
  };
  let isolated;
  try {
    isolated = require(modulePath);
  } finally {
    lifetime.readBoundedCommandOutput = original;
    delete require.cache[modulePath];
  }
  const receipt = {
    launcherPid: 99,
    claudeProcess: { platform: "win32", processId: 52, executablePath, signerThumbprint: thumbprint }
  };
  assert.equal(await isolated.verifyClaudeProcessProof(receipt, {
    platform: "win32",
    running: true,
    resolveExecutable: async (value) => value
  }), true);
  assert.ok(answers.length >= 2 && answers.every((answer) => /powershell\.exe$/i.test(answer.executable)));
});

test("clientInfo metadata and an arbitrary copied launcher cannot prove Claude installation", async (t) => {
  const input = await fixture(t);
  const ended = await endedProcessId();
  await writeReceipt(input, {
    launcherPid: ended,
    proxyPid: ended,
    connectedAt: new Date().toISOString(),
    clientInfo: { name: "Claude Desktop", version: "999" }
  });
  assert.deepEqual(await inspect(input, { verifyClaudeProcessProof: async () => false }),
    { installed: false, running: false });

  await writeReceipt(input, {
    launcherPid: ended,
    proxyPid: ended,
    connectedAt: new Date().toISOString(),
    clientInfo: undefined
  });
  assert.deepEqual(await inspect(input), { installed: true, running: false },
    "verified process proof does not depend on clientInfo");

  const copiedLauncher = path.join(input.root, "copied-launch.cjs");
  await fs.copyFile(input.managedLauncherPath, copiedLauncher);
  await writeReceipt(input, {
    launcherPid: ended,
    proxyPid: ended,
    connectedAt: new Date().toISOString(),
    launcherPath: copiedLauncher
  });
  assert.deepEqual(await inspect(input), { installed: false, running: false });
});

test("every setup check binds the runtime manifest, Node, server, and upstream bytes", async (t) => {
  for (const field of ["runtimeManifest", "node", "server", "upstreams"]) {
    const input = await fixture(t);
    const original = await fs.readFile(input[field]);
    await fs.writeFile(input[field], Buffer.concat([original, Buffer.from("\nchanged")]));
    assert.equal(await isCurrentClaudeDesktopSetup(input.setup), false, field);
    await fs.writeFile(input[field], original);
    assert.equal(await isCurrentClaudeDesktopSetup(input.setup), true, field);
  }
});

test("the launcher fails closed before spawn when a bound file changes", async (t) => {
  const input = await fixture(t);
  await fs.appendFile(input.upstreams, "\nchanged");
  const child = spawn(process.execPath, [input.managedLauncherPath], { stdio: ["pipe", "pipe", "pipe"] });
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(chunk));
  assert.equal((await once(child, "close"))[0], 1);
  assert.match(Buffer.concat(errors).toString(), /Morrow setup changed/);
  assert.equal(await isCurrentClaudeDesktopSetup(input.setup), false);
});

test("setup inspection rejects a bound file above its byte limit", async (t) => {
  const input = await fixture(t);
  await fs.writeFile(input.upstreams, Buffer.alloc(8 * 1024 * 1024 + 1, 0x78));
  assert.equal(await isCurrentClaudeDesktopSetup(input.setup), false);
});
