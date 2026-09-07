const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const test = require("node:test");
const {
  inspectClaudeDesktopConnection,
  parseUnixProcessStartTimes,
  parseWindowsProcessStartTimes,
  prepareClaudeDesktopBundle,
  processAlive,
  windowsProcessStartQuery
} = require("../shared/claude-desktop.cjs");
const installerController = require("../shared/installer-controller.cjs");
const { freshRecord } = require("../shared/state-policy.cjs");

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-claude-desktop-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "Materials with spaces");
  const state = path.join(root, "State");
  await fs.mkdir(workspace);
  await fs.mkdir(state);
  const server = path.join(root, "server.cjs");
  const upstreams = path.join(state, "upstreams.json");
  await fs.writeFile(upstreams, JSON.stringify({ privateFixtureValue: "must-not-be-bundled" }));
  await fs.writeFile(server, `const readline = require("node:readline");
const fs = require("node:fs");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    const response = { ${options.invalidJsonRpc ? "" : 'jsonrpc: "2.0",'} id: message.id,
      result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: ${JSON.stringify(options.fragmentUnicode ? "mor🌾row" : "morrow")}, version: "1.0.0" } } };
    const bytes = Buffer.from(JSON.stringify(response) + "\\n");
    if (${options.fragmentUnicode === true}) {
      const split = bytes.indexOf(Buffer.from("🌾")) + 1;
      process.stdout.write(bytes.subarray(0, split));
      setTimeout(() => process.stdout.write(bytes.subarray(split)), 30);
    } else process.stdout.write(bytes);
  }
  if (message.method === "test/paths") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id,
    result: { workspace: process.cwd(), upstreams: process.env.MORROW_UPSTREAMS_FILE } }) + "\\n");
});`);
  const setup = await prepareClaudeDesktopBundle({ nodePath: process.execPath, serverEntryPath: server,
    upstreamsPath: upstreams, workspaceRoot: workspace, stateDirectory: state, version: "1.0.0-rc.0", platform: "darwin" });
  const { unpackExtension } = await import("@anthropic-ai/mcpb");
  const extracted = path.join(root, "Extracted by assistant");
  assert.equal(await unpackExtension({ mcpbPath: setup.bundlePath, outputDir: extracted, silent: true }), true);
  return { root, workspace: await fs.realpath(workspace), upstreams: await fs.realpath(upstreams), setup, extracted };
}

async function waitFor(predicate) {
  for (let count = 0; count < 100; count += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("expected connection state was not observed");
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

function writeReceipt(setup, receipt) {
  return fs.writeFile(setup.receiptPath, `${JSON.stringify({ schema: "morrow.claude-desktop-connection.v1",
    installationId: setup.installationId, ...receipt })}\n`);
}

/** An installer controller over a temporary user-data root, as main.cjs builds one. */
function controller(root) {
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
    runCli: async () => ({ code: 0, stdout: "", stderr: "" })
  });
}

test("native Claude bundle contains its launcher and icon and becomes configured after an actual initialize response", async (t) => {
  const input = await fixture(t);
  assert.deepEqual((await fs.readdir(input.extracted)).sort(), ["icon.png", "manifest.json", "server"]);
  const manifest = JSON.parse(await fs.readFile(path.join(input.extracted, "manifest.json"), "utf8"));
  assert.equal(manifest.server.mcp_config.command, await fs.realpath(process.execPath));
  assert.deepEqual(manifest.server.mcp_config.args, ["${__dirname}/server/launch.cjs"]);
  const launcher = path.join(input.extracted, "server", "launch.cjs");
  assert.doesNotMatch(await fs.readFile(launcher, "utf8"), /must-not-be-bundled/);
  assert.deepEqual(await inspectClaudeDesktopConnection(input.setup), { installed: false, running: false });
  const child = spawn(process.execPath, [launcher], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", () => {});
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
  await waitFor(async () => (await inspectClaudeDesktopConnection(input.setup)).installed);
  await waitFor(async () => (await inspectClaudeDesktopConnection(input.setup)).running === true);
  child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"test/paths"}\n');
  await waitFor(() => Buffer.concat(output).toString().includes('"id":2'));
  const lines = Buffer.concat(output).toString().trim().split("\n").map(JSON.parse);
  assert.equal(lines[0].result.serverInfo.name, "morrow");
  assert.deepEqual(lines.find((line) => line.id === 2).result, { workspace: input.workspace, upstreams: input.upstreams });
  const stopped = once(child, "close");
  child.stdin.end();
  await stopped;

  // Closing Claude Desktop ends these processes. The extension is still
  // installed, so Morrow must not ask the person to set it up again.
  assert.deepEqual(await inspectClaudeDesktopConnection(input.setup), { installed: true, running: false });
});

test("a closed Claude Desktop stays configured in the installer state", async (t) => {
  const input = await fixture(t);
  await writeReceipt(input.setup, { launcherPid: await endedProcessId(), proxyPid: await endedProcessId(),
    connectedAt: new Date().toISOString() });
  assert.deepEqual(await inspectClaudeDesktopConnection(input.setup), { installed: true, running: false });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "morrow-claude-desktop-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "UserData"), { recursive: true });
  await fs.mkdir(path.join(root, "Home"), { recursive: true });
  await fs.mkdir(path.join(root, "Payload"), { recursive: true });
  const installer = controller(root);
  await installer.writeRecord({
    ...freshRecord(),
    selectedAssistantId: "claude-desktop",
    configured: { "claude-desktop": { bundlePath: input.setup.bundlePath, installationId: input.setup.installationId, receiptPath: input.setup.receiptPath } }
  });

  const state = await installer.state();
  const claude = state.assistants.find((assistant) => assistant.id === "claude-desktop");
  assert.equal(claude.configured, true);
  assert.equal(claude.pending, false);
  assert.notEqual(state.lifecycle, "assistant_pending");
});

test("a mismatched or oversized connection receipt cannot mark Claude configured", async (t) => {
  const { setup } = await fixture(t);
  await fs.writeFile(setup.receiptPath, JSON.stringify({ schema: "morrow.claude-desktop-connection.v1",
    installationId: "different-installation", launcherPid: process.pid, proxyPid: process.pid }));
  assert.deepEqual(await inspectClaudeDesktopConnection(setup), { installed: false, running: false });
  await writeReceipt(setup, { schema: "morrow.claude-desktop-connection.v0", launcherPid: process.pid, proxyPid: process.pid });
  assert.equal((await inspectClaudeDesktopConnection(setup)).installed, false);
  await fs.writeFile(setup.receiptPath, "x".repeat(4097));
  assert.equal((await inspectClaudeDesktopConnection(setup)).installed, false);
});

test("a process id reused after the recorded connection is not reported as running", async (t) => {
  const { setup } = await fixture(t);
  const reused = runningProcess(t);

  // This process started after the receipt was written, so it holds a reused id.
  await writeReceipt(setup, { launcherPid: process.pid, proxyPid: reused.pid,
    connectedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
  assert.deepEqual(await inspectClaudeDesktopConnection(setup), { installed: true, running: false });

  await writeReceipt(setup, { launcherPid: process.pid, proxyPid: reused.pid, connectedAt: new Date().toISOString() });
  await waitFor(async () => (await inspectClaudeDesktopConnection(setup)).running === true);

  // Morrow reports what it could not find out as "unknown", never as "not running".
  await writeReceipt(setup, { launcherPid: process.pid, proxyPid: reused.pid, connectedAt: "not a time" });
  assert.deepEqual(await inspectClaudeDesktopConnection(setup), { installed: true, running: "unknown" });
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
  assert.match(query, /Get-CimInstance Win32_Process -Filter "ProcessId=1234 OR ProcessId=5678"/);
  assert.match(query, /ConvertTo-Json -Compress/);
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
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    await waitFor(() => Buffer.concat(output).toString().includes("\n"));
    assert.equal(JSON.parse(Buffer.concat(output).toString()).result.serverInfo.name, "mor🌾row");
    assert.equal((await inspectClaudeDesktopConnection(input.setup)).installed, !invalidJsonRpc);
    const stopped = once(child, "close");
    child.stdin.end();
    await stopped;
  });
}

test("native removal of the installed launcher closes its proxy and clears the connection receipt", async (t) => {
  const input = await fixture(t);
  const launcher = path.join(input.extracted, "server", "launch.cjs");
  const child = spawn(process.execPath, [launcher], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  child.stdout.resume();
  child.stderr.resume();
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
  await waitFor(async () => (await inspectClaudeDesktopConnection(input.setup)).installed);
  const stopped = once(child, "close");
  await fs.unlink(launcher);
  await Promise.race([stopped, new Promise((_, reject) => setTimeout(() => reject(new Error("removed extension stayed active")), 4000).unref())]);

  // Claude removed the extension, so this setup is no longer installed.
  await waitFor(async () => (await inspectClaudeDesktopConnection(input.setup)).installed === false);
  await assert.rejects(() => fs.stat(input.setup.receiptPath), { code: "ENOENT" });
});
