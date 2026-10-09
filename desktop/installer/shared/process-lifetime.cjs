"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

// Linux reports /proc starttime in USER_HZ, which is fixed at 100 for that interface.
const LINUX_TICKS_PER_SECOND = 100;

const QUERY_TIMEOUT_MS = 3_000;
// A cold Windows PowerShell start can take several seconds. The bound stays
// below the runtime monitor's 15 s connect limit, which includes this query.
const WINDOWS_POWERSHELL_TIMEOUT_MS = 10_000;
const QUERY_KILL_GRACE_MS = 500;
const QUERY_FINAL_GRACE_MS = 750;
const QUERY_MAX_BYTES = 8 * 1024;

function exactPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0 && pid <= 2_147_483_647;
}

function processAlive(pid) {
  if (!exactPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function windowsProcessStartQuery(pids) {
  const identifiers = pids.filter(exactPid).join(", ");
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    `$processIdentifiers = @(${identifiers})`,
    "$processes = @($processIdentifiers | ForEach-Object { try { $process = [System.Diagnostics.Process]::GetProcessById([int]$_); [pscustomobject]@{ processId = [int]$process.Id; startedAt = $process.StartTime.ToUniversalTime().ToString('o') } } catch {} })",
    "$processes | ConvertTo-Json -Compress",
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
    if (exactPid(entry?.processId) && Number.isFinite(at)) started.set(entry.processId, at);
  }
  return started;
}

function parseUnixProcessStartTimes(output) {
  const started = new Map();
  if (typeof output !== "string") return started;
  for (const line of output.split("\n")) {
    const match = /^\s*([0-9]{1,10})\s+(\S.*\S)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const at = Date.parse(match[2]);
    if (exactPid(pid) && Number.isFinite(at)) started.set(pid, at);
  }
  return started;
}

function terminateProcessTree(child, force = false, platform = process.platform, spawnProcess = spawn) {
  if (!child || !exactPid(child.pid)) return false;
  if (platform === "win32") {
    try {
      const killer = spawnProcess("taskkill.exe", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => { try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {} });
      killer.unref?.();
      return true;
    } catch {
      try { return child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { return false; }
    }
  }
  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
    return true;
  } catch {
    try { return child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { return false; }
  }
}

function pidHandle(pid) {
  return {
    pid,
    kill(signal) {
      process.kill(pid, signal);
      return true;
    },
  };
}

/** Ends one PID's process tree. Used when reclaim has a pid and no ChildProcess handle. */
function terminatePidTree(pid, force = false, platform = process.platform, spawnProcess = spawn) {
  if (!exactPid(pid)) return false;
  return terminateProcessTree(pidHandle(pid), force, platform, spawnProcess);
}

function createBoundedCommandReader(dependencies = {}) {
  const spawnProcess = dependencies.spawnProcess || spawn;
  const platform = dependencies.platform || process.platform;
  const terminateTree = dependencies.terminateTree || ((child, force) => terminateProcessTree(child, force, platform));
  return function readBoundedCommandOutput(executable, argumentsValue, options = {}) {
    const timeoutMs = options.timeoutMs ?? QUERY_TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? QUERY_MAX_BYTES;
    const killGraceMs = options.killGraceMs ?? QUERY_KILL_GRACE_MS;
    const finalGraceMs = options.finalGraceMs ?? QUERY_FINAL_GRACE_MS;
    const includeStderr = options.includeStderr === true;
    const binary = options.binary === true;
    if (typeof executable !== "string" || executable.length === 0 || !Array.isArray(argumentsValue)
      || argumentsValue.some((value) => typeof value !== "string")
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024
      || !Number.isSafeInteger(killGraceMs) || killGraceMs < 1 || killGraceMs > 60_000
      || !Number.isSafeInteger(finalGraceMs) || finalGraceMs < 1 || finalGraceMs > 60_000) {
      return Promise.resolve(null);
    }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(executable, argumentsValue, {
        stdio: ["ignore", "pipe", includeStderr ? "pipe" : "ignore"],
        windowsHide: true,
        detached: platform !== "win32",
      });
    } catch {
      resolve(null);
      return;
    }
    const output = [];
    let bytes = 0;
    let settled = false;
    let stopping = false;
    let timeout = null;
    let escalation = null;
    let final = null;
    const receive = (chunk) => {
      bytes += chunk.length;
      if (bytes <= maxBytes) output.push(Buffer.from(chunk));
      else stop();
    };
    const onError = () => finish(null);
    const onClose = (code) => {
      const payload = Buffer.concat(output);
      finish(!stopping && code === 0 && bytes <= maxBytes ? (binary ? payload : payload.toString("utf8")) : null);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      if (final) clearTimeout(final);
      child.stdout?.removeListener("data", receive);
      child.stderr?.removeListener("data", receive);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref?.();
      resolve(value);
    };
    const stop = () => {
      if (stopping || settled) return;
      stopping = true;
      try { terminateTree(child, false); } catch {}
      escalation = setTimeout(() => { try { terminateTree(child, true); } catch {} }, killGraceMs);
      final = setTimeout(() => finish(null), killGraceMs + finalGraceMs);
    };
    timeout = setTimeout(stop, timeoutMs);
    child.stdout?.on("data", receive);
    child.stderr?.on("data", receive);
    child.once("error", onError);
    child.once("close", onClose);
  });
  };
}

const readBoundedCommandOutput = createBoundedCommandReader();

function windowsPowerShellPath() {
  return path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

async function readProcessStartTimes(pids, { platform = process.platform, readCommand = readBoundedCommandOutput } = {}) {
  const identifiers = [...new Set(pids)].filter(exactPid);
  if (identifiers.length === 0) return new Map();
  const limits = { maxBytes: QUERY_MAX_BYTES, killGraceMs: QUERY_KILL_GRACE_MS, finalGraceMs: QUERY_FINAL_GRACE_MS };
  if (platform === "win32") {
    const output = await readCommand(windowsPowerShellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsProcessStartQuery(identifiers)],
      { ...limits, timeoutMs: WINDOWS_POWERSHELL_TIMEOUT_MS });
    return output === null ? null : parseWindowsProcessStartTimes(output);
  }
  const output = await readCommand("/bin/ps", ["-o", "pid=,lstart=", "-p", identifiers.join(",")], { ...limits, timeoutMs: QUERY_TIMEOUT_MS });
  return output === null ? null : parseUnixProcessStartTimes(output);
}

function linuxStartFromStat(stat, bootTimeMs) {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0 || !Number.isSafeInteger(bootTimeMs)) return null;
  const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
  const ticks = Number(fields[22 - 3]);
  if (!Number.isSafeInteger(ticks) || ticks < 0) return null;
  return {
    at: bootTimeMs + Math.floor(ticks * (1_000 / LINUX_TICKS_PER_SECOND)),
    resolutionMs: 1_000 / LINUX_TICKS_PER_SECOND,
  };
}

async function readLinuxProcessStart(pid, procRoot = "/proc") {
  let statText;
  let bootText;
  try {
    [statText, bootText] = await Promise.all([
      fs.readFile(path.join(procRoot, String(pid), "stat"), "utf8"),
      fs.readFile(path.join(procRoot, "stat"), "utf8"),
    ]);
  } catch {
    return null;
  }
  const boot = /^btime\s+([0-9]+)\s*$/m.exec(bootText);
  const seconds = boot ? Number(boot[1]) : NaN;
  if (!Number.isSafeInteger(seconds)) return null;
  return linuxStartFromStat(statText, seconds * 1_000);
}

// sysctl(KERN_PROC_PID) returns kinfo_proc. On LP64 macOS the exported
// extern_proc does not start at byte 0: p_starttime is the timeval at 128,
// and p_pid follows that union, two pointers, p_flag, and p_stat.
const DARWIN_KINFO_START_OFFSET = 128;
const DARWIN_KINFO_PID_OFFSET = DARWIN_KINFO_START_OFFSET + 40;
const DARWIN_KINFO_MIN_BYTES = DARWIN_KINFO_PID_OFFSET + 4;

/**
 * macOS `ps -o lstart` is whole seconds, which cannot separate two processes
 * that started in the same second. `sysctl -b kern.proc.pid` returns the
 * kernel start timeval instead. The pid stored in that struct must be the
 * process we asked for; a layout this reader does not recognize is not an
 * identity and authorizes no signal.
 */
function darwinStartAt(buffer, pid, startOffset) {
  const pidOffset = startOffset + 40;
  if (pidOffset + 4 > buffer.length) return null;
  if (buffer.readInt32LE(pidOffset) !== pid) return null;
  const seconds = Number(buffer.readBigInt64LE(startOffset));
  const microseconds = buffer.readInt32LE(startOffset + 8);
  if (!Number.isSafeInteger(seconds) || seconds < 1_000_000_000 || seconds > 4_000_000_000) return null;
  if (!Number.isInteger(microseconds) || microseconds < 0 || microseconds > 999_999) return null;
  return {
    at: seconds * 1_000 + Math.floor(microseconds / 1_000),
    resolutionMs: 1,
  };
}

function parseDarwinKinfoStart(buffer, pid) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 || !exactPid(pid)) return null;
  return darwinStartAt(buffer, pid, DARWIN_KINFO_START_OFFSET) || darwinStartAt(buffer, pid, 0);
}

async function readDarwinProcessStart(pid, readCommand) {
  const output = await readCommand("/usr/sbin/sysctl", ["-b", `kern.proc.pid.${pid}`], {
    timeoutMs: QUERY_TIMEOUT_MS,
    maxBytes: QUERY_MAX_BYTES,
    binary: true,
  });
  return parseDarwinKinfoStart(output, pid);
}

/**
 * The finest start instant this operating system will state for one live PID.
 * `resolutionMs` is 10 on Linux (proc starttime ticks), 1 on Windows and on
 * macOS when the kernel start timeval is readable, and 1000 where the only
 * clock is `ps -o lstart`. A 1000 ms clock cannot authorize a signal.
 */
async function readProcessStartObservation(pid, {
  platform = process.platform,
  procRoot = "/proc",
  readCommand = readBoundedCommandOutput,
  processAlive: alive = processAlive,
} = {}) {
  if (!exactPid(pid) || !alive(pid)) return null;
  if (platform === "linux") {
    const fromProc = await readLinuxProcessStart(pid, procRoot);
    if (fromProc) return fromProc;
  }
  if (platform === "darwin") {
    const fromKernel = await readDarwinProcessStart(pid, readCommand);
    if (fromKernel) return fromKernel;
  }
  const started = await readProcessStartTimes([pid], { platform, readCommand });
  if (!started) return null;
  const at = started.get(pid);
  if (!Number.isFinite(at)) return null;
  return { at, resolutionMs: platform === "win32" ? 1 : 1_000 };
}

async function readProcessStartedAt(pid) {
  const observed = await readProcessStartObservation(pid);
  return observed?.at ?? null;
}

async function processMatchesRecordedLifetime(pid, observedAt) {
  const boundary = Date.parse(observedAt);
  if (!exactPid(pid) || !Number.isFinite(boundary) || !processAlive(pid)) return false;
  const startedAt = await readProcessStartedAt(pid);
  return startedAt === null ? null : startedAt <= boundary;
}

/**
 * Exact identity is permission to signal. A millisecond clock must match exactly.
 * A whole-second clock cannot see a reuse inside that second, but refusing the
 * match leaves the live child running, so a still-alive PID with that same
 * second is the process that was recorded.
 */
function matchExactProcessStart(expected, observed) {
  if (!Number.isFinite(expected) || !observed || !Number.isFinite(observed.at)) return null;
  const resolution = Number.isFinite(observed.resolutionMs) && observed.resolutionMs > 0 ? observed.resolutionMs : 1_000;
  if (resolution >= 1_000 || expected % 1_000 === 0) {
    return Math.floor(expected / 1_000) === Math.floor(observed.at / 1_000) ? true : false;
  }
  return observed.at === expected ? true : false;
}

async function processMatchesExactStart(pid, recordedStartedAt, readObservation = null) {
  const expected = Date.parse(recordedStartedAt);
  if (!exactPid(pid) || !Number.isFinite(expected) || !processAlive(pid)) return false;
  const observed = typeof readObservation === "function"
    ? await readObservation(pid)
    : await readProcessStartObservation(pid);
  if (!processAlive(pid)) return false;
  return matchExactProcessStart(expected, observed);
}

module.exports = {
  WINDOWS_POWERSHELL_TIMEOUT_MS,
  createBoundedCommandReader,
  parseDarwinKinfoStart,
  parseUnixProcessStartTimes,
  parseWindowsProcessStartTimes,
  processAlive,
  matchExactProcessStart,
  processMatchesExactStart,
  processMatchesRecordedLifetime,
  readBoundedCommandOutput,
  readLinuxProcessStart,
  readProcessStartObservation,
  readProcessStartedAt,
  readProcessStartTimes,
  terminatePidTree,
  terminateProcessTree,
  windowsPowerShellPath,
  windowsProcessStartQuery,
};
