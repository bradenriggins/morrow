"use strict";

const crypto = require("node:crypto");
const nativeFs = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  parseUnixProcessStartTimes,
  parseWindowsProcessStartTimes,
  processAlive,
  readBoundedCommandOutput,
  readProcessStartTimes,
  windowsProcessStartQuery,
} = require("./process-lifetime.cjs");
const { inspectRecord, readPrivateRegularFile } = require("./state-policy.cjs");
const { parseStrictJson } = require("./strict-utf8.cjs");

const RECEIPT_SCHEMA = "morrow.claude-desktop-connection.v4";
const SETUP_SCHEMA = "morrow.claude-desktop-setup.v3";
const INSTALLER_RECORD_READ_LIMIT = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const CLAUDE_BUNDLE_ID = "com.anthropic.claudefordesktop";
const CLAUDE_TEAM_ID = "Q6L2SF6YDW";
const FILE_LIMITS = Object.freeze({
  runtimeManifest: 8 * 1024 * 1024,
  node: 256 * 1024 * 1024,
  serverEntry: 64 * 1024 * 1024,
  upstreams: 8 * 1024 * 1024,
  launcher: 256 * 1024,
});

function sameCanonicalPath(left, right, platform = process.platform) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (pathApi.normalize(left) !== left || pathApi.normalize(right) !== right) return false;
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function sameClaudeDesktopEntry(left, right, platform = process.platform) {
  const keys = ["bundlePath", "installationId", "receiptPath"];
  return Boolean(left && right && !Array.isArray(left) && !Array.isArray(right)
    && Object.keys(left).length === keys.length && Object.keys(right).length === keys.length
    && Object.keys(left).every((key) => keys.includes(key)) && Object.keys(right).every((key) => keys.includes(key))
    && left.installationId === right.installationId
    && sameCanonicalPath(left.bundlePath, right.bundlePath, platform)
    && sameCanonicalPath(left.receiptPath, right.receiptPath, platform));
}

function claudeDesktopLauncherPath({
  platform = process.platform,
  homeDirectory = os.homedir(),
  appDataDirectory = process.env.APPDATA,
} = {}) {
  if (platform === "darwin") {
    if (typeof homeDirectory !== "string" || !path.posix.isAbsolute(homeDirectory)) throw new TypeError("Claude home path is invalid");
    return path.posix.join(homeDirectory, "Library", "Application Support", "Claude", "Claude Extensions",
      "local.mcpb.morrow.morrow", "server", "launch.cjs");
  }
  if (platform === "win32") {
    if (typeof appDataDirectory !== "string" || !path.win32.isAbsolute(appDataDirectory)) throw new TypeError("Claude app-data path is invalid");
    return path.win32.join(appDataDirectory, "Claude", "Claude Extensions", "local.mcpb.morrow.morrow", "server", "launch.cjs");
  }
  throw new TypeError("This computer is not supported");
}

function canonicalInputPath(value, platform = process.platform) {
  if (typeof value !== "string" || /[\0\r\n]/.test(value)) throw new TypeError("Morrow setup path is invalid");
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(value) || pathApi.normalize(value) !== value) throw new TypeError("Morrow setup path is invalid");
  return value;
}

async function realPath(value, kind) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new TypeError("Morrow setup path is invalid");
  const canonical = await fs.realpath(value);
  const info = await fs.stat(canonical);
  if (kind === "directory" ? !info.isDirectory() : !info.isFile()) throw new TypeError("Morrow setup path is unavailable");
  return canonical;
}

async function boundedDigest(filePath, maximumBytes) {
  const before = await fs.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes) throw new TypeError("Morrow setup file is invalid");
  const handle = await fs.open(filePath, nativeFs.constants.O_RDONLY | (nativeFs.constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== before.size || opened.size > maximumBytes) throw new TypeError("Morrow setup file changed");
    const digest = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < opened.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - position), position);
      if (bytesRead < 1) throw new TypeError("Morrow setup file changed");
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new TypeError("Morrow setup file changed");
    }
    return { bytes: opened.size, sha256: digest.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function boundedBytes(filePath, maximumBytes) {
  const before = await fs.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes) throw new TypeError("Morrow setup file is invalid");
  const handle = await fs.open(filePath, nativeFs.constants.O_RDONLY | (nativeFs.constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== before.size || opened.size > maximumBytes) throw new TypeError("Morrow setup file changed");
    const bytes = Buffer.alloc(opened.size);
    const digest = crypto.createHash("sha256");
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await handle.read(bytes, position, Math.min(64 * 1024, bytes.length - position), position);
      if (bytesRead < 1) throw new TypeError("Morrow setup file changed");
      digest.update(bytes.subarray(position, position + bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new TypeError("Morrow setup file changed");
    }
    return { bytes: opened.size, sha256: digest.digest("hex"), value: bytes };
  } finally {
    await handle.close();
  }
}

async function contentRecord(filePath, maximumBytes) {
  const canonical = await realPath(filePath, "file");
  return Object.freeze({ path: canonical, ...await boundedDigest(canonical, maximumBytes) });
}

function validContentRecord(record, maximumBytes) {
  return record && typeof record === "object" && !Array.isArray(record)
    && Object.keys(record).sort().join(",") === "bytes,path,sha256"
    && typeof record.path === "string" && path.isAbsolute(record.path)
    && Number.isSafeInteger(record.bytes) && record.bytes >= 0 && record.bytes <= maximumBytes
    && SHA256.test(record.sha256 || "");
}

async function contentRecordMatches(record, maximumBytes) {
  if (!validContentRecord(record, maximumBytes)) return false;
  try {
    if (await realPath(record.path, "file") !== record.path) return false;
    const actual = await boundedDigest(record.path, maximumBytes);
    return actual.bytes === record.bytes && actual.sha256 === record.sha256;
  } catch {
    return false;
  }
}

async function runtimeManifestRecord(serverRecord, explicitPath) {
  const candidates = [];
  if (explicitPath !== undefined) candidates.push(explicitPath);
  else {
    let current = path.dirname(serverRecord.path);
    for (let depth = 0; depth < 6; depth += 1) {
      candidates.push(path.join(current, "mcp-runtime-manifest.json"));
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  for (const candidate of candidates) {
    try {
      const input = await boundedBytes(candidate, FILE_LIMITS.runtimeManifest);
      const manifest = parseStrictJson(input.value, "Morrow runtime manifest");
      const record = { path: await realPath(candidate, "file"), bytes: input.bytes, sha256: input.sha256 };
      const entry = manifest?.entrypoint;
      if (manifest?.schema !== "morrow.mcp-runtime-manifest.v2" || typeof entry?.path !== "string"
        || path.isAbsolute(entry.path) || entry.path.includes("\\")
        || path.resolve(path.dirname(record.path), entry.path) !== serverRecord.path
        || entry.bytes !== serverRecord.bytes || entry.sha256 !== serverRecord.sha256) {
        throw new TypeError("Morrow runtime manifest does not bind the server");
      }
      return Object.freeze(record);
    } catch (error) {
      if (explicitPath === undefined && error?.code === "ENOENT") continue;
      throw error;
    }
  }
  throw new TypeError("Morrow runtime manifest is unavailable");
}

function launcherSource(configuration) {
  return `"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const config = ${JSON.stringify(configuration)};
const fileLimits = ${JSON.stringify(FILE_LIMITS)};
const launcherPath = fs.realpathSync(__filename);
function samePath(left, right) {
  const api = config.platform === "win32" ? path.win32 : path.posix;
  return api.normalize(left) === left && api.normalize(right) === right
    && (config.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right);
}
function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}
function exactObject(value, keys) {
  return plainObject(value) && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}
function strictUtf8(bytes) {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
function canonicalPath(value) {
  const api = config.platform === "win32" ? path.win32 : path.posix;
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && !value.includes("\\0") && api.isAbsolute(value) && api.normalize(value) === value;
}
function validConfiguredEntry(assistantId, value) {
  if (assistantId === "claude-desktop") {
    return exactObject(value, ["bundlePath", "installationId", "receiptPath"])
      && canonicalPath(value.bundlePath) && canonicalPath(value.receiptPath)
      && path.dirname(value.bundlePath) === path.dirname(value.receiptPath)
      && path.basename(value.bundlePath) === "Morrow.mcpb" && path.basename(value.receiptPath) === "connection.json"
      && typeof value.installationId === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/.test(value.installationId);
  }
  return exactObject(value, ["target", "sha256"]) && canonicalPath(value.target) && /^[a-f0-9]{64}$/.test(value.sha256 || "");
}
function currentInstallerRecord() {
  try {
    const parent = path.dirname(config.installerRecordPath);
    if (!samePath(parent, config.stateDirectory)) return false;
    const owner = config.platform === "win32" || typeof process.getuid !== "function" ? null : process.getuid();
    const directory = fs.lstatSync(parent);
    if (!directory.isDirectory() || directory.isSymbolicLink()
      || (config.platform !== "win32" && ((directory.mode & 0o077) !== 0 || (owner !== null && directory.uid !== owner)))) return false;
    const accepted = (info) => info.isFile() && !info.isSymbolicLink() && info.nlink === 1
      && info.size >= 1 && info.size <= ${INSTALLER_RECORD_READ_LIMIT}
      && (config.platform === "win32" || ((info.mode & 0o077) === 0 && (owner === null || info.uid === owner)));
    const before = fs.lstatSync(config.installerRecordPath);
    if (!accepted(before)) return false;
    const descriptor = fs.openSync(config.installerRecordPath, fs.constants.O_RDONLY
      | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    let bytes;
    try {
      const opened = fs.fstatSync(descriptor);
      if (!accepted(opened) || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return false;
      bytes = Buffer.alloc(opened.size);
      let position = 0;
      while (position < bytes.length) {
        const count = fs.readSync(descriptor, bytes, position, bytes.length - position, position);
        if (count < 1) return false;
        position += count;
      }
      const after = fs.fstatSync(descriptor);
      const afterPath = fs.lstatSync(config.installerRecordPath);
      if (!accepted(after) || !accepted(afterPath)
        || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
        || after.dev !== opened.dev || after.ino !== opened.ino
        || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino) return false;
    } finally { fs.closeSync(descriptor); }
    const record = JSON.parse(strictUtf8(bytes));
    const allowedKeys = ["schema", "version", "selectedAssistantId", "materialsFolder", "configured"];
    if (!plainObject(record) || record.schema !== "morrow.desktop-state.v1" || record.version !== 1
      || Object.keys(record).some((key) => !allowedKeys.includes(key)) || !plainObject(record.configured)) return false;
    const assistantIds = ["codex", "claude-desktop", "claude-code", "gemini-cli"];
    if (Object.hasOwn(record, "selectedAssistantId") && record.selectedAssistantId !== null
      && !assistantIds.includes(record.selectedAssistantId)) return false;
    if (Object.hasOwn(record, "materialsFolder") && !canonicalPath(record.materialsFolder)) return false;
    for (const [assistantId, entry] of Object.entries(record.configured)) {
      if (!assistantIds.includes(assistantId) || !validConfiguredEntry(assistantId, entry)) return false;
    }
    const active = record.configured["claude-desktop"];
    return Boolean(active && active.installationId === config.activeEntry.installationId
      && samePath(active.bundlePath, config.activeEntry.bundlePath)
      && samePath(active.receiptPath, config.activeEntry.receiptPath));
  } catch { return false; }
}
function digestFile(filePath, maximumBytes) {
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes) throw new Error("invalid file");
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== before.size || opened.size > maximumBytes) throw new Error("changed file");
    const digest = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(65536);
    let position = 0;
    while (position < opened.size) {
      const count = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, opened.size - position), position);
      if (count < 1) throw new Error("changed file");
      digest.update(buffer.subarray(0, count));
      position += count;
    }
    const after = fs.fstatSync(descriptor);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.dev !== opened.dev || after.ino !== opened.ino) throw new Error("changed file");
    return { bytes: opened.size, sha256: digest.digest("hex") };
  } finally { fs.closeSync(descriptor); }
}
const launcherSha256 = digestFile(launcherPath, fileLimits.launcher).sha256;
function fileMatches(name) {
  const record = config.fileBindings[name];
  const canonical = fs.realpathSync(record.path);
  const actual = digestFile(canonical, fileLimits[name]);
  return samePath(canonical, record.path) && actual.bytes === record.bytes && actual.sha256 === record.sha256;
}
function installedLauncherCurrent() {
  try {
    return samePath(fs.realpathSync(config.sourcePath), config.sourcePath)
      && digestFile(config.sourcePath, fileLimits.launcher).sha256 === launcherSha256
      && samePath(launcherPath, fs.realpathSync(config.managedLauncherPath));
  } catch { return false; }
}
function setupCurrent() {
  try {
    return currentInstallerRecord() && installedLauncherCurrent()
      && samePath(fs.realpathSync(config.workspaceRoot), config.workspaceRoot)
      && fileMatches("runtimeManifest") && fileMatches("node") && fileMatches("serverEntry") && fileMatches("upstreams");
  } catch { return false; }
}
function macClaudeProof() {
  let pid = process.ppid;
  for (let depth = 0; depth < 16 && Number.isSafeInteger(pid) && pid > 1; depth += 1) {
    const answer = spawnSync("/bin/ps", ["-o", "pid=,ppid=,comm=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, maxBuffer: 65536 });
    const match = /^\\s*([0-9]+)\\s+([0-9]+)\\s+(.+?)\\s*$/.exec(answer.status === 0 ? answer.stdout : "");
    if (!match) return null;
    const executablePath = match[3];
    if (/\\/Claude\\.app\\/Contents\\/MacOS\\/Claude$/.test(executablePath)) {
      const signature = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", executablePath], { encoding: "utf8", timeout: 2000, maxBuffer: 65536 });
      const detail = String(signature.stdout || "") + String(signature.stderr || "");
      if (signature.status === 0 && /(?:^|\\n)Identifier=com\\.anthropic\\.claudefordesktop(?:\\n|$)/.test(detail)
        && /(?:^|\\n)TeamIdentifier=Q6L2SF6YDW(?:\\n|$)/.test(detail)) {
        return { platform: "darwin", processId: Number(match[1]), executablePath,
          bundleId: "com.anthropic.claudefordesktop", teamId: "Q6L2SF6YDW" };
      }
    }
    pid = Number(match[2]);
  }
  return null;
}
function windowsClaudeProof() {
  const powershell = path.win32.join(process.env.SystemRoot || "C:\\\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = [
    "$ErrorActionPreference='Stop'", "$current=" + process.ppid, "$depth=0", "$answer=$null",
    "while($current -gt 1 -and $depth -lt 16){$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$current);if($null -eq $p){break};if($p.Name -ieq 'Claude.exe'){$s=Get-AuthenticodeSignature -LiteralPath $p.ExecutablePath;if($s.Status -eq 'Valid' -and $s.SignerCertificate.Subject -match 'Anthropic'){$answer=[pscustomobject]@{platform='win32';processId=[int]$p.ProcessId;executablePath=[string]$p.ExecutablePath;signerThumbprint=[string]$s.SignerCertificate.Thumbprint};break}};$current=[int]$p.ParentProcessId;$depth++}",
    "if($null -ne $answer){$answer|ConvertTo-Json -Compress}"
  ].join(";");
  const answer = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", timeout: 3000, maxBuffer: 65536, windowsHide: true });
  try { return answer.status === 0 && answer.stdout.trim() ? JSON.parse(answer.stdout) : null; } catch { return null; }
}
function claudeProcessProof() {
  return process.platform === "darwin" ? macClaudeProof() : process.platform === "win32" ? windowsClaudeProof() : null;
}
if (!setupCurrent()) {
  process.stderr.write("Morrow setup changed. Open Morrow and set up Claude Desktop again.\\n");
  process.exit(1);
}
const child = spawn(config.nodePath, [config.serverEntryPath], {
  cwd: config.workspaceRoot,
  env: { ...process.env, MORROW_UPSTREAMS_FILE: config.upstreamsPath },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  detached: process.platform !== "win32"
});
let initializeId;
let clientInfo;
let protocolVersion;
let connected = false;
let finishing = false;
let terminateTimer;
let forceTimer;
let finalTimer;
function observe(stream, receive) {
  let pending = "";
  let skipping = false;
  let failed = false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const invalid = () => {
    if (failed) return;
    failed = true;
    pending = "";
    skipping = true;
    clearOwnReceipt();
    stop();
  };
  stream.on("data", (bytes) => {
    if (failed) return;
    let text;
    try { text = decoder.decode(bytes, { stream: true }); } catch { invalid(); return; }
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
  stream.once("end", () => { try { decoder.decode(); } catch { invalid(); } });
}
observe(process.stdin, (message) => {
  if (message?.jsonrpc !== "2.0") return;
  if (initializeId === undefined && message.method === "initialize" && (typeof message.id === "string" || typeof message.id === "number")) {
    initializeId = message.id;
    const reported = message.params?.clientInfo;
    if (typeof reported?.name === "string" && reported.name.length > 0 && reported.name.length <= 256
      && typeof reported.version === "string" && reported.version.length > 0 && reported.version.length <= 256) {
      clientInfo = { name: reported.name, version: reported.version };
    }
  }
  if (!connected && !finishing && protocolVersion && message.method === "notifications/initialized" && message.id === undefined) recordConnection();
});
observe(child.stdout, (message) => {
  if (protocolVersion || initializeId === undefined || message?.jsonrpc !== "2.0" || message.id !== initializeId || message.error
    || typeof message.result?.protocolVersion !== "string" || typeof message.result?.serverInfo?.name !== "string") return;
  protocolVersion = message.result.protocolVersion;
});
function recordConnection() {
  if (!setupCurrent()) return;
  const receipt = { schema: ${JSON.stringify(RECEIPT_SCHEMA)}, installationId: config.installationId,
    launcherPath, launcherSha256, protocolVersion, launcherPid: process.pid, proxyPid: child.pid,
    connectedAt: new Date().toISOString(), claudeProcess: claudeProcessProof() };
  if (clientInfo) receipt.clientInfo = clientInfo;
  const temporary = config.receiptPath + ".tmp-" + process.pid;
  try {
    fs.writeFileSync(temporary, JSON.stringify(receipt) + "\\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, config.receiptPath);
    connected = true;
  } catch { try { fs.unlinkSync(temporary); } catch {} }
}
function clearOwnReceipt() {
  try {
    const receipt = JSON.parse(strictUtf8(fs.readFileSync(config.receiptPath)));
    if (receipt.installationId === config.installationId && receipt.launcherPid === process.pid) fs.unlinkSync(config.receiptPath);
  } catch {}
}
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdin.on("error", () => {});
function terminateTree(force) {
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], {
        stdio: "ignore", windowsHide: true
      });
      killer.once("error", () => { try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {} });
      killer.unref();
      return;
    } catch {}
  } else {
    try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); return; } catch {}
  }
  try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {}
}
function finish(code) {
  if (terminateTimer) clearTimeout(terminateTimer);
  if (forceTimer) clearTimeout(forceTimer);
  if (finalTimer) clearTimeout(finalTimer);
  try { process.stdin.unpipe(child.stdin); } catch {}
  try { child.stdout.unpipe(process.stdout); } catch {}
  try { child.stderr.unpipe(process.stderr); } catch {}
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  process.stdin.pause();
  process.exit(Number.isInteger(code) ? code : 1);
}
function stop() {
  if (finishing) return;
  finishing = true;
  child.stdin.end();
  terminateTimer = setTimeout(() => {
    terminateTree(false);
    forceTimer = setTimeout(() => terminateTree(true), 500);
    finalTimer = setTimeout(() => finish(1), 1250);
    forceTimer.unref();
    finalTimer.unref();
  }, 2000);
  terminateTimer.unref();
}
process.stdin.on("end", stop);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
const installedFileWatch = setInterval(() => {
  try {
    if (currentInstallerRecord() && installedLauncherCurrent()
      && digestFile(launcherPath, fileLimits.launcher).sha256 === launcherSha256) return;
  } catch {}
  clearOwnReceipt();
  stop();
}, 1000);
installedFileWatch.unref();
child.once("error", () => { process.stderr.write("Morrow could not start. Open Morrow and check setup.\\n"); finish(1); });
child.once("close", (code) => finish(code));
`;
}

async function prepareClaudeDesktopBundle({
  nodePath,
  serverEntryPath,
  runtimeManifestPath,
  upstreamsPath,
  workspaceRoot,
  stateDirectory,
  version,
  platform = process.platform,
  homeDirectory = os.homedir(),
  appDataDirectory = process.env.APPDATA,
  managedLauncherPath,
}) {
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[A-Za-z0-9.-]+)?$/.test(version || "")) throw new TypeError("Morrow version is invalid");
  if (platform !== "darwin" && platform !== "win32") throw new TypeError("This computer is not supported");
  const serverEntry = await contentRecord(serverEntryPath, FILE_LIMITS.serverEntry);
  const fileBindings = {
    runtimeManifest: await runtimeManifestRecord(serverEntry, runtimeManifestPath),
    node: await contentRecord(nodePath, FILE_LIMITS.node),
    serverEntry,
    upstreams: await contentRecord(upstreamsPath, FILE_LIMITS.upstreams),
  };
  const configuration = {
    platform,
    nodePath: fileBindings.node.path,
    serverEntryPath: fileBindings.serverEntry.path,
    runtimeManifestPath: fileBindings.runtimeManifest.path,
    upstreamsPath: fileBindings.upstreams.path,
    workspaceRoot: await realPath(workspaceRoot, "directory"),
    managedLauncherPath: canonicalInputPath(managedLauncherPath
      || claudeDesktopLauncherPath({ platform, homeDirectory, appDataDirectory }), platform),
    fileBindings,
    installationId: crypto.randomUUID(),
  };
  const state = await realPath(stateDirectory, "directory");
  const setupRoot = path.join(state, "ClaudeDesktop");
  await fs.mkdir(setupRoot, { recursive: true, mode: 0o700 });
  const root = await fs.mkdtemp(path.join(setupRoot, "setup-"));
  const extensionPath = path.join(root, "bundle");
  const bundlePath = path.join(root, "Morrow.mcpb");
  configuration.stateDirectory = state;
  configuration.installerRecordPath = path.join(state, "installer.json");
  configuration.receiptPath = path.join(root, "connection.json");
  configuration.sourcePath = path.join(extensionPath, "server", "launch.cjs");
  configuration.activeEntry = {
    bundlePath,
    installationId: configuration.installationId,
    receiptPath: configuration.receiptPath,
  };
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
      command: "node",
      args: ["${__dirname}/server/launch.cjs"],
    } },
    tools_generated: true,
    compatibility: { platforms: [platform] },
  };
  await fs.writeFile(path.join(extensionPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  const source = launcherSource(configuration);
  await fs.writeFile(configuration.sourcePath, source, { mode: 0o600, flag: "wx" });
  await fs.writeFile(path.join(root, "setup.json"), `${JSON.stringify({ schema: SETUP_SCHEMA, ...configuration,
    launcherSha256: crypto.createHash("sha256").update(source).digest("hex") })}\n`, { mode: 0o600, flag: "wx" });
  await fs.copyFile(path.join(__dirname, "..", "assets", "morrow-knot-512.png"), path.join(extensionPath, "icon.png"), nativeFs.constants.COPYFILE_EXCL);
  const { packExtension } = await import("@anthropic-ai/mcpb");
  if (!await packExtension({ extensionPath, outputPath: bundlePath, silent: true })) throw new Error("Morrow could not prepare the Claude extension");
  if (process.platform !== "win32") await fs.chmod(bundlePath, 0o600);
  return Object.freeze({ bundlePath, installationId: configuration.installationId, receiptPath: configuration.receiptPath });
}

async function recordedProcessesRunning(receipt, dependencies = {}) {
  const alive = dependencies.processAlive || processAlive;
  const readStarted = dependencies.readProcessStartTimes || readProcessStartTimes;
  const pids = [receipt.launcherPid, receipt.proxyPid];
  if (!pids.every((pid) => alive(pid))) return false;
  const connectedAt = Date.parse(receipt.connectedAt);
  if (!Number.isFinite(connectedAt)) return "unknown";
  const started = await readStarted([...new Set(pids)]);
  if (started === null) return "unknown";
  return pids.every((pid) => {
    const at = started.get(pid);
    return at !== undefined && at <= connectedAt;
  });
}

async function readClaudeDesktopSetup(setup) {
  try {
    if (typeof setup?.installationId !== "string" || typeof setup.receiptPath !== "string" || !path.isAbsolute(setup.receiptPath)) return null;
    const root = await realPath(path.dirname(setup.receiptPath), "directory");
    const metadata = parseStrictJson((await boundedBytes(path.join(root, "setup.json"), 32 * 1024)).value, "Claude Desktop setup metadata");
    const sourcePath = path.join(root, "bundle", "server", "launch.cjs");
    const stateDirectory = path.dirname(path.dirname(root));
    const expectedEntry = { bundlePath: path.join(root, "Morrow.mcpb"), installationId: setup.installationId, receiptPath: setup.receiptPath };
    if (metadata?.schema !== SETUP_SCHEMA || metadata.installationId !== setup.installationId
      || metadata.sourcePath !== sourcePath || metadata.receiptPath !== setup.receiptPath
      || metadata.stateDirectory !== stateDirectory || metadata.installerRecordPath !== path.join(stateDirectory, "installer.json")
      || !sameClaudeDesktopEntry(metadata.activeEntry, expectedEntry, metadata.platform)
      || !SHA256.test(metadata.launcherSha256 || "") || typeof metadata.managedLauncherPath !== "string") return null;
    for (const [name, maximum] of [["runtimeManifest", FILE_LIMITS.runtimeManifest], ["node", FILE_LIMITS.node],
      ["serverEntry", FILE_LIMITS.serverEntry], ["upstreams", FILE_LIMITS.upstreams]]) {
      if (!await contentRecordMatches(metadata.fileBindings?.[name], maximum)) return null;
    }
    if (metadata.runtimeManifestPath !== metadata.fileBindings.runtimeManifest.path
      || metadata.nodePath !== metadata.fileBindings.node.path || metadata.serverEntryPath !== metadata.fileBindings.serverEntry.path
      || metadata.upstreamsPath !== metadata.fileBindings.upstreams.path) return null;
    if ((await boundedDigest(sourcePath, FILE_LIMITS.launcher)).sha256 !== metadata.launcherSha256) return null;
    return metadata;
  } catch {
    return null;
  }
}

async function activeClaudeDesktopSetup(metadata, options = {}) {
  try {
    const content = await readPrivateRegularFile(metadata.installerRecordPath, {
      maxBytes: INSTALLER_RECORD_READ_LIMIT,
      platform: options.platform || metadata.platform,
      trustedRoot: metadata.stateDirectory,
    });
    const parsed = parseStrictJson(content, "installer record");
    const inspected = inspectRecord(parsed, { homeDirectory: options.homeDirectory || os.homedir() });
    return inspected.compatible
      && sameClaudeDesktopEntry(inspected.record.configured?.["claude-desktop"], metadata.activeEntry, metadata.platform);
  } catch {
    return false;
  }
}

async function isCurrentClaudeDesktopSetup(setup, expected = {}) {
  const metadata = await readClaudeDesktopSetup(setup);
  if (!metadata || !await activeClaudeDesktopSetup(metadata, expected)) return false;
  for (const field of ["nodePath", "serverEntryPath", "runtimeManifestPath", "upstreamsPath", "workspaceRoot"]) {
    if (expected[field] === undefined) continue;
    try {
      if (await realPath(expected[field], field === "workspaceRoot" ? "directory" : "file") !== metadata[field]) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function boundedCommand(executable, argumentsValue) {
  return readBoundedCommandOutput(executable, argumentsValue, {
    timeoutMs: 3_000,
    maxBytes: 64 * 1024,
    includeStderr: true,
  });
}

async function processAncestry(startPid, platform) {
  const result = [];
  let pid = startPid;
  for (let depth = 0; depth < 16 && Number.isSafeInteger(pid) && pid > 1; depth += 1) {
    let record;
    if (platform === "darwin") {
      const answer = await boundedCommand("/bin/ps", ["-o", "pid=,ppid=,comm=", "-p", String(pid)]);
      const match = /^\s*([0-9]+)\s+([0-9]+)\s+(.+?)\s*$/.exec(answer || "");
      if (!match) return null;
      record = { processId: Number(match[1]), parentProcessId: Number(match[2]), executablePath: match[3] };
    } else if (platform === "win32") {
      const powershell = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';if($null-ne$p){[pscustomobject]@{processId=[int]$p.ProcessId;parentProcessId=[int]$p.ParentProcessId;executablePath=[string]$p.ExecutablePath}|ConvertTo-Json -Compress}`;
      const answer = await boundedCommand(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]);
      try { record = JSON.parse(answer || ""); } catch { return null; }
    } else {
      return null;
    }
    if (!Number.isSafeInteger(record?.processId) || !Number.isSafeInteger(record?.parentProcessId)
      || typeof record.executablePath !== "string") return null;
    result.push(record);
    pid = record.parentProcessId;
  }
  return result;
}

async function verifyClaudeExecutableIdentity(proof, platform, executable) {
  if (platform === "darwin") {
    const detail = await boundedCommand("/usr/bin/codesign", ["-dv", "--verbose=4", executable]);
    if (!detail || !/(?:^|\n)Identifier=com\.anthropic\.claudefordesktop(?:\n|$)/.test(detail)
      || !/(?:^|\n)TeamIdentifier=Q6L2SF6YDW(?:\n|$)/.test(detail)) return false;
  } else if (platform === "win32") {
    if (typeof proof.signerThumbprint !== "string" || !/^[A-Fa-f0-9]{40,64}$/.test(proof.signerThumbprint)) return false;
    const powershell = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const escaped = executable.replace(/'/g, "''");
    const script = `$s=Get-AuthenticodeSignature -LiteralPath '${escaped}';if($s.Status-eq'Valid'){[pscustomobject]@{subject=[string]$s.SignerCertificate.Subject;thumbprint=[string]$s.SignerCertificate.Thumbprint}|ConvertTo-Json -Compress}`;
    const answer = await boundedCommand(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]);
    let signature;
    try { signature = JSON.parse(answer || ""); } catch { return false; }
    if (typeof signature?.subject !== "string" || !/Anthropic/i.test(signature.subject)
      || signature.thumbprint?.toLowerCase() !== proof.signerThumbprint.toLowerCase()) return false;
  } else {
    return false;
  }
  return true;
}

async function verifyClaudeProcessProof(receipt, {
  platform,
  running,
  readProcessAncestry = processAncestry,
  resolveExecutable = (value) => realPath(value, "file"),
  verifyExecutableIdentity = verifyClaudeExecutableIdentity,
}) {
  const proof = receipt?.claudeProcess;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (!proof || proof.platform !== platform || !Number.isSafeInteger(proof.processId) || proof.processId < 1
    || typeof proof.executablePath !== "string" || !pathApi.isAbsolute(proof.executablePath)
    || (platform === "darwin" && (proof.bundleId !== CLAUDE_BUNDLE_ID || proof.teamId !== CLAUDE_TEAM_ID))
    || (platform === "win32" && (typeof proof.signerThumbprint !== "string"
      || !/^[A-Fa-f0-9]{40,64}$/.test(proof.signerThumbprint)))) return false;
  let executable;
  try { executable = await resolveExecutable(proof.executablePath); } catch { return false; }
  if (!sameCanonicalPath(executable, proof.executablePath, platform)
    || await verifyExecutableIdentity(proof, platform, executable) !== true) return false;
  if (running === true || running === "unknown") {
    const ancestry = await readProcessAncestry(receipt.launcherPid, platform);
    if (!Array.isArray(ancestry) || !ancestry.some((entry) => entry.processId === proof.processId
      && sameCanonicalPath(entry.executablePath, proof.executablePath, platform))) return false;
  }
  return true;
}

async function inspectClaudeDesktopConnection(setup, options = {}) {
  const unavailable = { installed: false, running: false };
  if (!setup || typeof setup.installationId !== "string" || typeof setup.receiptPath !== "string") return unavailable;
  let receipt;
  try {
    receipt = parseStrictJson((await boundedBytes(setup.receiptPath, 8 * 1024)).value, "Claude Desktop connection receipt");
  } catch {
    return unavailable;
  }
  if (receipt?.schema !== RECEIPT_SCHEMA || receipt.installationId !== setup.installationId
    || !Number.isSafeInteger(receipt.launcherPid) || receipt.launcherPid < 1
    || !Number.isSafeInteger(receipt.proxyPid) || receipt.proxyPid < 1
    || !Number.isFinite(Date.parse(receipt.connectedAt)) || Date.parse(receipt.connectedAt) > Date.now()
    || typeof receipt.protocolVersion !== "string" || !receipt.protocolVersion
    || !SHA256.test(receipt.launcherSha256 || "")) return unavailable;
  try {
    const metadata = await readClaudeDesktopSetup(setup);
    if (!metadata || metadata.launcherSha256 !== receipt.launcherSha256
      || !await activeClaudeDesktopSetup(metadata, options)) return unavailable;
    const installedPath = await realPath(receipt.launcherPath, "file");
    const platform = options.platform || process.platform;
    if (metadata.platform !== platform) return unavailable;
    const expectedPath = options.managedLauncherPath || claudeDesktopLauncherPath({
      platform,
      homeDirectory: options.homeDirectory,
      appDataDirectory: options.appDataDirectory,
    });
    if (installedPath !== await realPath(expectedPath, "file") || metadata.managedLauncherPath !== expectedPath) return unavailable;
    if ((await boundedDigest(installedPath, FILE_LIMITS.launcher)).sha256 !== receipt.launcherSha256) return unavailable;
    const running = await recordedProcessesRunning(receipt, options);
    const verifyProcess = options.verifyClaudeProcessProof || verifyClaudeProcessProof;
    if (await verifyProcess(receipt, { platform, running, readProcessAncestry: options.readProcessAncestry }) !== true) return unavailable;
    return { installed: true, running };
  } catch {
    return unavailable;
  }
}

module.exports = {
  claudeDesktopLauncherPath,
  inspectClaudeDesktopConnection,
  isCurrentClaudeDesktopSetup,
  parseUnixProcessStartTimes,
  parseWindowsProcessStartTimes,
  prepareClaudeDesktopBundle,
  processAlive,
  readClaudeDesktopSetup,
  sameClaudeDesktopEntry,
  sameCanonicalPath,
  verifyClaudeProcessProof,
  windowsProcessStartQuery,
};
