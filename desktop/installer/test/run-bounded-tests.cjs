"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Windows' real ACL and file-system operations are much slower than the same
// calls on macOS. The Windows installer-controller suite passed 84 tests before
// reaching its four-minute per-file limit, so keep the Windows budgets above
// that measured runtime while retaining a hard process boundary.
const FILE_TIMEOUT_MS = process.platform === "win32" ? 600_000 : 60_000;
const SUITE_TIMEOUT_MS = process.platform === "win32" ? 900_000 : 300_000;
const DEPENDENCY_TIMEOUT_MS = 30_000;

function usage() {
  return "Usage: node test/run-bounded-tests.cjs --per-file|--suite";
}

async function runNode(argumentsValue, label, timeoutMs) {
  try {
    const { runOwnedProcess } = await import("../../scripts/lib/owned-process.mjs");
    const result = await runOwnedProcess(process.execPath, argumentsValue, {
      workingDirectory: path.resolve(__dirname, ".."),
      timeoutMs,
      killGraceMs: 2_000,
      finalGraceMs: 2_000,
      maxOutputBytes: 1_024,
      onStdout: (chunk) => process.stdout.write(chunk),
      onStderr: (chunk) => process.stderr.write(chunk),
    });
    return { label, code: result.code, signal: result.signal, timedOut: result.timedOut, spawnError: null };
  } catch (spawnError) {
    return { label, code: null, signal: null, timedOut: false, spawnError };
  }
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
    const concurrency = process.platform === "win32" ? 1 : 2;
    assertPassed(await runNode(["--test", `--test-concurrency=${concurrency}`, ...files], "full installer test suite", SUITE_TIMEOUT_MS), SUITE_TIMEOUT_MS);
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
