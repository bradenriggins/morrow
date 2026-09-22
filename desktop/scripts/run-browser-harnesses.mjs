#!/usr/bin/env node

/**
 * Runs Morrow's browser and permission harnesses in sequence and writes one receipt.
 *
 * `pnpm scripts:test` globs `scripts/test/*.test.mjs`, so the four harnesses named here are outside
 * the always-on gate on purpose: three drive a real Chromium with the Bridge loaded, one of those
 * needs a person answering Chrome's own permission prompts, and one runs only on native Windows
 * against a built installer. This command is the named opt-in gate for them, and the receipt it
 * writes is what `scripts/lib/release-candidate.mjs` reads before it calls a candidate promotable.
 *
 * Every harness reaches the receipt by name, including one this host cannot run. A harness that did
 * not run is recorded as not run, with the reason. It is never recorded as passed.
 *
 * The timeouts are machine limits, not contract limits. On a quiet MacBook Air the Chromium harness
 * finishes in about 40 seconds and the maintenance challenge in about 4; a loaded machine takes far
 * longer. A harness that reaches its limit is recorded as `timed-out`, which is a machine result to
 * re-run, not a proof that the product is wrong.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_HARNESS_RECEIPT_PATH, BROWSER_HARNESS_SCHEMA } from "./lib/release-candidate.mjs";
import { runOwnedProcess } from "./lib/owned-process.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_HARNESS_LOG_BYTES = 4 * 1024 * 1024;
const MAX_RETAINED_PROCESS_OUTPUT_BYTES = 128 * 1024;

const USAGE = "Usage: node scripts/run-browser-harnesses.mjs [--attended] [--receipt <absolute path>]";

/** The compiled files the harnesses import. Without them a run fails inside a harness for no useful reason. */
const REQUIRED_BUILD_OUTPUT = Object.freeze([
  "packages/mcp-server/dist/runtime.js",
  "packages/mcp-server/dist/approval-server.js",
  "packages/canvas-connector-mcp/dist/runtime.js",
]);

/** Every harness this gate records, in run order. */
export const HARNESSES = Object.freeze([
  Object.freeze({
    id: "canvas_connector_browser",
    script: "scripts/test/canvas-connector-browser.mjs",
    timeoutMs: 600_000,
    attendedOnly: false,
    summary: "Loads the Bridge into Chromium and drives pairing, the popup, Settings and the setup guide against a synthetic Canvas.",
  }),
  Object.freeze({
    id: "bridge_maintenance_cft",
    script: "scripts/test/bridge-maintenance-cft.mjs",
    timeoutMs: 300_000,
    attendedOnly: false,
    summary: "Loads an isolated Bridge folder into Chromium and reads back its exact active-folder challenge.",
  }),
  Object.freeze({
    id: "canvas_file_optional_permission",
    script: "scripts/test/canvas-file-optional-permission-proof.mjs",
    timeoutMs: 3_600_000,
    attendedOnly: true,
    summary: "A person allows, declines and removes Chrome's optional file-access permission while Morrow reads a course file.",
    notRunStatus: "not-run-unattended",
    notRunReason: "This proof asks a person to answer Chrome's own permission prompts. Run pnpm test:browser:attended from a terminal and follow the prompts.",
  }),
  Object.freeze({
    id: "desktop_windows_smoke",
    script: "scripts/test/desktop-windows-smoke.mjs",
    attendedOnly: false,
    summary: "Installs, starts, damages, repairs and uninstalls the Windows desktop app, then compares retained data.",
    notRunStatus: "not-run-on-this-host",
    notRunReason: "This harness needs native Windows and a built NSIS installer, which this command does not produce. The windows-2022 job in .github/workflows/desktop-release.yml runs it on manual dispatch.",
  }),
]);

/**
 * What each harness will do on this run, in run order. A harness that will not run carries the
 * status and the reason that reach the receipt in place of a result.
 */
export function planHarnesses({ attended = false } = {}) {
  return HARNESSES.map((harness) => {
    const runnable = harness.timeoutMs !== undefined && (attended || !harness.attendedOnly);
    return runnable
      ? { harness, run: true }
      : { harness, run: false, status: harness.notRunStatus, reason: harness.notRunReason };
  });
}

/** The receipt this command writes. `harnesses` holds one recorded result for every harness, by name. */
export function harnessReceipt({ commit, tree, workingTreeClean, attended, startedAt, finishedAt, host, harnesses }) {
  return {
    schema: BROWSER_HARNESS_SCHEMA,
    commit,
    tree,
    workingTreeClean,
    attended,
    startedAt,
    finishedAt,
    host,
    harnesses,
    everyHarnessPassed: harnesses.every((entry) => entry.status === "passed"),
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(args) {
  return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();
}

function receiptPath(argv) {
  const flag = argv.indexOf("--receipt");
  if (flag >= 0) {
    const value = argv[flag + 1];
    if (!value || !isAbsolute(value)) throw new Error(`--receipt requires one absolute path.\n${USAGE}`);
    return resolve(value);
  }
  const configured = process.env.MORROW_BROWSER_HARNESS_RECEIPT_PATH?.trim();
  if (configured) {
    if (!isAbsolute(configured)) throw new Error("MORROW_BROWSER_HARNESS_RECEIPT_PATH must be an absolute path.");
    return resolve(configured);
  }
  return resolve(ROOT, BROWSER_HARNESS_RECEIPT_PATH);
}

/**
 * Runs one harness, writes bounded output to `logPath`, and returns the result the receipt records.
 * The shared process owner settles even when a child or retained pipe never reports close. Output
 * beyond the evidence limit makes the run fail instead of producing an incomplete passing proof.
 */
export async function runHarness(harness, { attended = false, logPath, maxLogBytes = MAX_HARNESS_LOG_BYTES }) {
  if (!Number.isSafeInteger(maxLogBytes) || maxLogBytes < 1 || maxLogBytes > MAX_HARNESS_LOG_BYTES) {
    throw new TypeError("browser harness log limit is invalid");
  }
  const startedAt = Date.now();
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  const logDescriptor = openSync(logPath, "w", 0o600);
  const logDigest = createHash("sha256");
  let logBytes = 0;
  let logTruncated = false;
  const appendLog = (chunk, destination) => {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    destination.write(value);
    const retainedBytes = Math.min(value.byteLength, maxLogBytes - logBytes);
    if (retainedBytes > 0) {
      const retained = value.subarray(0, retainedBytes);
      let written = 0;
      while (written < retained.byteLength) written += writeSync(logDescriptor, retained, written);
      logDigest.update(retained);
      logBytes += retained.byteLength;
    }
    if (retainedBytes < value.byteLength) logTruncated = true;
  };
  let result;
  try {
    result = await runOwnedProcess(process.execPath, [resolve(ROOT, harness.script)], {
      workingDirectory: ROOT,
      input: attended ? "inherit" : "ignore",
      timeoutMs: harness.timeoutMs,
      killGraceMs: 10_000,
      finalGraceMs: 2_000,
      maxOutputBytes: MAX_RETAINED_PROCESS_OUTPUT_BYTES,
      onStdout: (chunk) => appendLog(chunk, process.stdout),
      onStderr: (chunk) => appendLog(chunk, process.stderr),
    });
  } finally {
    closeSync(logDescriptor);
  }
  const status = result.timedOut ? "timed-out" : result.code === 0 && !logTruncated ? "passed" : "failed";
  return {
    id: harness.id,
    script: harness.script,
    status,
    exitCode: result.code,
    ...(result.signal ? { signal: result.signal } : {}),
    durationMs: Date.now() - startedAt,
    timeoutMs: harness.timeoutMs,
    log: basename(logPath),
    logBytes,
    logTruncated,
    logSha256: logDigest.digest("hex"),
  };
}

export async function main(argv = []) {
  const attended = argv.includes("--attended");
  const unexpected = argv.filter((value, index) => value !== "--attended" && value !== "--receipt" && argv[index - 1] !== "--receipt");
  if (unexpected.length > 0) throw new Error(USAGE);
  const missingBuild = REQUIRED_BUILD_OUTPUT.filter((path) => !existsSync(resolve(ROOT, path)));
  if (missingBuild.length > 0) {
    throw new Error(`The harnesses import compiled packages that are not built. Run pnpm build, then this command again. Missing: ${missingBuild.join(", ")}`);
  }

  const receipt = receiptPath(argv);
  const startedAt = new Date().toISOString();
  const results = [];
  for (const planned of planHarnesses({ attended })) {
    if (!planned.run) {
      results.push({ id: planned.harness.id, script: planned.harness.script, status: planned.status, reason: planned.reason });
      process.stdout.write(`[browser-harness] ${planned.harness.id}=${planned.status}: ${planned.reason}\n`);
      continue;
    }
    process.stdout.write(`[browser-harness] ${planned.harness.id} started\n`);
    const result = await runHarness(planned.harness, { attended, logPath: resolve(dirname(receipt), `${planned.harness.id}.log`) });
    results.push(result);
    process.stdout.write(`[browser-harness] ${result.id}=${result.status} after ${Math.round(result.durationMs / 1000)}s\n`);
  }

  const written = harnessReceipt({
    commit: git(["rev-parse", "HEAD"]),
    tree: git(["rev-parse", "HEAD^{tree}"]),
    workingTreeClean: git(["status", "--porcelain", "--untracked-files=normal"]) === "",
    attended,
    startedAt,
    finishedAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, nodeVersion: process.version },
    harnesses: results,
  });
  mkdirSync(dirname(receipt), { recursive: true, mode: 0o700 });
  writeFileSync(receipt, `${JSON.stringify(written, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    receipt: receipt.startsWith(`${ROOT}/`) ? receipt.slice(ROOT.length + 1) : receipt,
    passed: results.filter((entry) => entry.status === "passed").map((entry) => entry.id),
    notRun: results.filter((entry) => entry.status.startsWith("not-run")).map((entry) => entry.id),
  })}\n`);
  const unpassed = results.filter((entry) => entry.status === "failed" || entry.status === "timed-out");
  if (unpassed.length > 0) throw new Error(`Harnesses that did not pass: ${unpassed.map((entry) => `${entry.id}=${entry.status}`).join(", ")}`);
  return written;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[morrow browser harnesses] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
