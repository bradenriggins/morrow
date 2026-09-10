"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

// Windows' real ACL and file-system operations run measurably slower than the
// same calls on macOS: this suite's win32-only paths were never exercised for
// real on a Windows host until they had real fixtures, and installer-controller
// .test.cjs alone needed more than 60s once they were. Both budgets stay wide
// margins above what was actually observed, not a bare minimum.
const FILE_TIMEOUT_MS = process.platform === "win32" ? 240_000 : 60_000;
const SUITE_TIMEOUT_MS = process.platform === "win32" ? 600_000 : 300_000;
const DEPENDENCY_TIMEOUT_MS = 30_000;

function usage() {
  return "Usage: node test/run-bounded-tests.cjs --per-file|--suite";
}

function stopProcessTree(child) {
  if (!Number.isSafeInteger(child.pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 10_000,
    });
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
}

function runNode(argumentsValue, label, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argumentsValue, {
      cwd: path.resolve(__dirname, ".."),
      detached: process.platform !== "win32",
      stdio: "inherit",
      windowsHide: true,
    });
    let timedOut = false;
    let spawnError = null;
    const timer = setTimeout(() => {
      timedOut = true;
      stopProcessTree(child);
    }, timeoutMs);
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ label, code, signal, timedOut, spawnError });
    });
  });
}

function assertPassed(result, timeoutMs) {
  if (!result.spawnError && !result.timedOut && result.code === 0) return;
  if (result.timedOut) throw new Error(`${result.label} exceeded its ${timeoutMs} ms limit`);
  if (result.spawnError) throw new Error(`${result.label} could not start: ${result.spawnError.message}`);
  throw new Error(`${result.label} failed with exit ${result.code ?? "unknown"}${result.signal ? ` (${result.signal})` : ""}`);
}

function testFiles() {
  return fs.readdirSync(__dirname)
    .filter((name) => /\.test\.(?:cjs|mjs)$/.test(name))
    .sort()
    .map((name) => path.join("test", name));
}

async function main() {
  const mode = process.argv[2];
  if ((mode !== "--per-file" && mode !== "--suite") || process.argv.length !== 3) throw new Error(usage());
  assertPassed(await runNode([path.join("test", "require-dependencies.cjs")], "installer dependency check", DEPENDENCY_TIMEOUT_MS), DEPENDENCY_TIMEOUT_MS);
  const files = testFiles();
  if (mode === "--suite") {
    assertPassed(await runNode(["--test", "--test-concurrency=2", ...files], "full installer test suite", SUITE_TIMEOUT_MS), SUITE_TIMEOUT_MS);
    return;
  }
  for (const file of files) {
    const result = await runNode(["--test", "--test-concurrency=1", file], file, FILE_TIMEOUT_MS);
    assertPassed(result, FILE_TIMEOUT_MS);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
