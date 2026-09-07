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

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_HARNESS_RECEIPT_PATH, BROWSER_HARNESS_SCHEMA } from "./lib/release-candidate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
 * Stops a harness that reached its limit. An unattended harness runs in its own process group, so
 * the browser it started stops with it; an attended one stays in this group to keep the terminal's
 * keyboard, so only the harness process is signalled.
 */
function stopHarness(child, attended) {
  const signal = (name) => {
    try {
      if (attended) child.kill(name);
      else process.kill(-child.pid, name);
    } catch {}
  };
  signal("SIGTERM");
  setTimeout(() => signal("SIGKILL"), 10_000).unref();
}

/**
 * Runs one harness, writes its whole output to `logPath`, and returns the result the receipt
 * records. A harness that reaches its timeout is stopped and recorded as `timed-out`.
 */
export async function runHarness(harness, { attended = false, logPath }) {
  const startedAt = Date.now();
  const output = [];
  const child = spawn(process.execPath, [resolve(ROOT, harness.script)], {
    cwd: ROOT,
    stdio: [attended ? "inherit" : "ignore", "pipe", "pipe"],
    detached: !attended,
  });
  child.stdout.on("data", (chunk) => { output.push(chunk); process.stdout.write(chunk); });
  child.stderr.on("data", (chunk) => { output.push(chunk); process.stderr.write(chunk); });
  let timedOut = false;
  const limit = setTimeout(() => { timedOut = true; stopHarness(child, attended); }, harness.timeoutMs);
  const [code, signal] = await once(child, "close");
  clearTimeout(limit);
  const log = Buffer.concat(output);
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  writeFileSync(logPath, log, { mode: 0o600 });
  return {
    id: harness.id,
    script: harness.script,
    status: timedOut ? "timed-out" : code === 0 ? "passed" : "failed",
    exitCode: code,
    ...(signal ? { signal } : {}),
    durationMs: Date.now() - startedAt,
    timeoutMs: harness.timeoutMs,
    log: basename(logPath),
    logSha256: sha256(log),
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
