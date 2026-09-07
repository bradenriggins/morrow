const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const RECEIPT_SCHEMA = "morrow.claude-desktop-connection.v1";
const PROCESS_START_QUERY_TIMEOUT_MS = 3_000;
const PROCESS_START_QUERY_MAX_BYTES = 8 * 1024;

function launcherSource(configuration) {
  return `"use strict";
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const config = ${JSON.stringify(configuration)};
const child = spawn(config.nodePath, [config.serverEntryPath], {
  cwd: config.workspaceRoot,
  env: { ...process.env, MORROW_UPSTREAMS_FILE: config.upstreamsPath },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true
});
let initializeId;
let initialized = false;
let finishing = false;
function observe(stream, receive) {
  let pending = "";
  let skipping = false;
  const decoder = new StringDecoder("utf8");
  stream.on("data", (bytes) => {
    const text = decoder.write(bytes);
    for (const part of text.match(/[^\\n]*\\n|[^\\n]+$/g) || []) {
      const complete = part.endsWith("\\n");
      if (!skipping) pending += part;
      if (pending.length > 65536) { pending = ""; skipping = true; }
      if (complete) {
        if (!skipping) { try { receive(JSON.parse(pending)); } catch {} }
        pending = "";
        skipping = false;
      }
    }
  });
}
observe(process.stdin, (message) => {
  if (!initialized && message?.jsonrpc === "2.0" && message.method === "initialize" && (typeof message.id === "string" || typeof message.id === "number")) initializeId = message.id;
});
observe(child.stdout, (message) => {
  if (initialized || initializeId === undefined || message?.jsonrpc !== "2.0" || message.id !== initializeId || message.error
    || typeof message.result?.protocolVersion !== "string" || typeof message.result?.serverInfo?.name !== "string") return;
  initialized = true;
  const receipt = { schema: ${JSON.stringify(RECEIPT_SCHEMA)}, installationId: config.installationId,
    launcherPid: process.pid, proxyPid: child.pid, connectedAt: new Date().toISOString() };
  const temporary = config.receiptPath + ".tmp-" + process.pid;
  try {
    fs.writeFileSync(temporary, JSON.stringify(receipt) + "\\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, config.receiptPath);
  } catch { try { fs.unlinkSync(temporary); } catch {} }
});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdin.on("error", () => {});
function stop() {
  if (finishing) return;
  finishing = true;
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 2000);
  timer.unref();
}
process.stdin.on("end", stop);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
// Claude can remove an extension without closing its existing stdio process.
// The receipt goes with it, because it is what tells Morrow this extension is installed.
const installedFileWatch = setInterval(() => {
  if (fs.existsSync(__filename)) return;
  try { fs.unlinkSync(config.receiptPath); } catch {}
  stop();
}, 1000);
installedFileWatch.unref();
child.once("error", () => { process.stderr.write("Morrow could not start. Open Morrow and check setup.\\n"); process.exit(1); });
child.once("close", (code) => { process.stdin.pause(); process.exit(Number.isInteger(code) ? code : 1); });
`;
}

async function realPath(value, kind) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new TypeError("Morrow setup path is invalid");
  const canonical = await fs.realpath(value);
  const info = await fs.stat(canonical);
  if (kind === "directory" ? !info.isDirectory() : !info.isFile()) throw new TypeError("Morrow setup path is unavailable");
  return canonical;
}

async function prepareClaudeDesktopBundle({ nodePath, serverEntryPath, upstreamsPath, workspaceRoot, stateDirectory, version, platform = process.platform }) {
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[A-Za-z0-9.-]+)?$/.test(version || "")) throw new TypeError("Morrow version is invalid");
  if (platform !== "darwin" && platform !== "win32") throw new TypeError("This computer is not supported");
  const configuration = {
    nodePath: await realPath(nodePath, "file"),
    serverEntryPath: await realPath(serverEntryPath, "file"),
    upstreamsPath: await realPath(upstreamsPath, "file"),
    workspaceRoot: await realPath(workspaceRoot, "directory"),
    installationId: crypto.randomUUID()
  };
  if (configuration.nodePath.includes("${")) throw new TypeError("Morrow installation path cannot be used by Claude");
  const state = await realPath(stateDirectory, "directory");
  const setupRoot = path.join(state, "ClaudeDesktop");
  await fs.mkdir(setupRoot, { recursive: true, mode: 0o700 });
  const root = await fs.mkdtemp(path.join(setupRoot, "setup-"));
  const extensionPath = path.join(root, "bundle");
  const bundlePath = path.join(root, "Morrow.mcpb");
  configuration.receiptPath = path.join(root, "connection.json");
  await fs.mkdir(path.join(extensionPath, "server"), { recursive: true, mode: 0o700 });
  const manifest = {
    manifest_version: "0.3",
    name: "morrow",
    display_name: "Morrow",
    version,
    description: "Build, review, and update Canvas and Moodle courses through conversation.",
    long_description: "Connect Claude to the Morrow app on this computer. Morrow uses the course sites connected in Morrow Bridge and the materials folder chosen in Morrow. Keep Morrow installed to use this extension.",
    author: { name: "Morrow", url: "https://meetmorrow.app" },
    homepage: "https://meetmorrow.app",
    support: "https://meetmorrow.app/support",
    icon: "icon.png",
    privacy_policies: ["https://meetmorrow.app/privacy"],
    server: { type: "node", entry_point: "server/launch.cjs", mcp_config: {
      command: configuration.nodePath,
      args: ["${__dirname}/server/launch.cjs"]
    } },
    tools_generated: true,
    compatibility: { platforms: [platform] }
  };
  await fs.writeFile(path.join(extensionPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await fs.writeFile(path.join(extensionPath, "server", "launch.cjs"), launcherSource(configuration), { mode: 0o600, flag: "wx" });
  await fs.copyFile(path.join(__dirname, "..", "assets", "morrow-knot-512.png"), path.join(extensionPath, "icon.png"), fs.constants.COPYFILE_EXCL);
  const { packExtension } = await import("@anthropic-ai/mcpb");
  if (!await packExtension({ extensionPath, outputPath: bundlePath, silent: true })) throw new Error("Morrow could not prepare the Claude extension");
  if (process.platform !== "win32") await fs.chmod(bundlePath, 0o600);
  return Object.freeze({ bundlePath, installationId: configuration.installationId, receiptPath: configuration.receiptPath });
}

/**
 * Whether a process with this id exists now. `EPERM` means a process exists
 * that this user is not allowed to signal, so it counts as alive. This is the
 * single process-liveness answer Morrow uses; `installer-controller.cjs`
 * imports it rather than keeping a second copy that answered `EPERM`
 * differently.
 */
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function windowsProcessStartQuery(pids) {
  const filter = pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0).map((pid) => `ProcessId=${pid}`).join(" OR ");
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    `$processes = @(Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { [pscustomobject]@{ processId = [int]$_.ProcessId; startedAt = $_.CreationDate.ToUniversalTime().ToString('o') } })`,
    "$processes | ConvertTo-Json -Compress"
  ].join("; ");
}

function parseWindowsProcessStartTimes(output) {
  const started = new Map();
  if (typeof output !== "string") return started;
  const value = output.trim();
  if (!value) return started;
  let parsed;
  try { parsed = JSON.parse(value); } catch { return started; }
  for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
    const at = Date.parse(entry?.startedAt);
    if (Number.isSafeInteger(entry?.processId) && Number.isFinite(at)) started.set(entry.processId, at);
  }
  return started;
}

function parseUnixProcessStartTimes(output) {
  const started = new Map();
  if (typeof output !== "string") return started;
  for (const line of output.split("\n")) {
    const match = /^\s*([0-9]{1,10})\s+(\S.*\S)\s*$/.exec(line);
    if (!match) continue;
    const at = Date.parse(match[2]);
    if (Number.isFinite(at)) started.set(Number(match[1]), at);
  }
  return started;
}

function readCommandOutput(executable, argumentsValue) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, argumentsValue, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    const output = [];
    let bytes = 0;
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => { child.kill(); finish(null); }, PROCESS_START_QUERY_TIMEOUT_MS);
    timer.unref();
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes <= PROCESS_START_QUERY_MAX_BYTES) output.push(chunk);
    });
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code === 0 && bytes <= PROCESS_START_QUERY_MAX_BYTES ? Buffer.concat(output).toString("utf8") : null));
  });
}

/** Start times for these process ids, or null when this computer did not answer. */
async function readProcessStartTimes(pids) {
  if (process.platform === "win32") {
    const executable = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const output = await readCommandOutput(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsProcessStartQuery(pids)]);
    return output === null ? null : parseWindowsProcessStartTimes(output);
  }
  const output = await readCommandOutput("/bin/ps", ["-o", "pid=,lstart=", "-p", pids.join(",")]);
  return output === null ? null : parseUnixProcessStartTimes(output);
}

/**
 * Whether the processes the receipt recorded are the processes running under
 * those ids now. An id can be reused after the process that held it exits, so a
 * live id alone is not proof. Both recorded processes were already running when
 * the receipt was written, so a process that started after `connectedAt` holds a
 * reused id and is not the recorded process. The answer is "unknown" when this
 * computer did not answer the start-time query, because an unanswered question
 * is not an answer.
 */
async function recordedProcessesRunning(receipt) {
  const pids = [receipt.launcherPid, receipt.proxyPid];
  if (!pids.every((pid) => processAlive(pid))) return false;
  const connectedAt = Date.parse(receipt.connectedAt);
  if (!Number.isFinite(connectedAt)) return "unknown";
  const started = await readProcessStartTimes([...new Set(pids)]);
  if (started === null) return "unknown";
  return pids.every((pid) => {
    const at = started.get(pid);
    return at !== undefined && at <= connectedAt;
  });
}

/**
 * Two separate facts about one Claude Desktop setup.
 *
 * `installed`: the receipt written by Claude's copy of the Morrow extension is
 * present, is Morrow's, and is bound to the installation id recorded for this
 * setup. Closing Claude Desktop does not change it. Removing the extension in
 * Claude does, because the launcher deletes the receipt when Claude removes it.
 *
 * `running`: the recorded processes are running now, or "unknown" when this
 * computer did not answer the start-time query. It is a detail about this
 * moment, never a reason to treat an installed assistant as unconfigured.
 */
async function inspectClaudeDesktopConnection(setup) {
  if (!setup || typeof setup.installationId !== "string" || typeof setup.receiptPath !== "string") return { installed: false, running: false };
  let receipt;
  try {
    const info = await fs.lstat(setup.receiptPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) return { installed: false, running: false };
    receipt = JSON.parse(await fs.readFile(setup.receiptPath, "utf8"));
  } catch { return { installed: false, running: false }; }
  if (receipt?.schema !== RECEIPT_SCHEMA || receipt.installationId !== setup.installationId) return { installed: false, running: false };
  return { installed: true, running: await recordedProcessesRunning(receipt) };
}

module.exports = {
  parseUnixProcessStartTimes,
  parseWindowsProcessStartTimes,
  prepareClaudeDesktopBundle,
  inspectClaudeDesktopConnection,
  processAlive,
  windowsProcessStartQuery
};
