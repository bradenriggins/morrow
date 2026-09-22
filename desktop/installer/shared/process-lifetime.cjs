"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");

const QUERY_TIMEOUT_MS = 3_000;
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

function terminateProcessTree(child, force = false, platform = process.platform) {
  if (!child || !exactPid(child.pid)) return false;
  if (platform === "win32") {
    try {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], {
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
    const onClose = (code) => finish(!stopping && code === 0 && bytes <= maxBytes ? Buffer.concat(output).toString("utf8") : null);
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

function readCommandOutput(executable, argumentsValue) {
  return readBoundedCommandOutput(executable, argumentsValue, {
    timeoutMs: QUERY_TIMEOUT_MS,
    maxBytes: QUERY_MAX_BYTES,
    killGraceMs: QUERY_KILL_GRACE_MS,
    finalGraceMs: QUERY_FINAL_GRACE_MS,
  });
}

async function readProcessStartTimes(pids) {
  const identifiers = [...new Set(pids)].filter(exactPid);
  if (identifiers.length === 0) return new Map();
  if (process.platform === "win32") {
    const executable = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const output = await readCommandOutput(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsProcessStartQuery(identifiers)]);
    return output === null ? null : parseWindowsProcessStartTimes(output);
  }
  const output = await readCommandOutput("/bin/ps", ["-o", "pid=,lstart=", "-p", identifiers.join(",")]);
  return output === null ? null : parseUnixProcessStartTimes(output);
}

async function readProcessStartedAt(pid) {
  if (!exactPid(pid) || !processAlive(pid)) return null;
  const started = await readProcessStartTimes([pid]);
  return started?.get(pid) ?? null;
}

async function processMatchesRecordedLifetime(pid, observedAt) {
  const boundary = Date.parse(observedAt);
  if (!exactPid(pid) || !Number.isFinite(boundary) || !processAlive(pid)) return false;
  const startedAt = await readProcessStartedAt(pid);
  return startedAt === null ? null : startedAt <= boundary;
}

async function processMatchesExactStart(pid, recordedStartedAt) {
  const expected = Date.parse(recordedStartedAt);
  if (!exactPid(pid) || !Number.isFinite(expected) || !processAlive(pid)) return false;
  const startedAt = await readProcessStartedAt(pid);
  return startedAt === null ? null : startedAt === expected;
}

module.exports = {
  createBoundedCommandReader,
  parseUnixProcessStartTimes,
  parseWindowsProcessStartTimes,
  processAlive,
  processMatchesExactStart,
  processMatchesRecordedLifetime,
  readBoundedCommandOutput,
  readProcessStartedAt,
  readProcessStartTimes,
  windowsProcessStartQuery,
};
