#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const MAX_OUTPUT_BYTES = 128 * 1024;
// Morrow verifies every file of the sealed MCP payload by hash before it starts
// the gateway, so a first run takes tens of seconds on a quiet machine and much
// longer on a loaded one. Reaching this limit is a machine result, not a defect.
const APP_TIMEOUT_MS = 300_000;
const RECEIPT_TIMEOUT_MS = 20_000;
// The Chrome bridge port the packaged connector uses
// (packages/canvas-connector-mcp/src/config.ts). One computer has one of these,
// so whether Morrow can hold it is a fact about the machine, not the build.
const BRIDGE_PORT = 32147;

// The installed application writes one receipt shape on both platforms. The
// identifiers below are the ones installer/main.cjs writes; they were named
// before this macOS harness existed and are not evidence about the platform.
const APP_RECEIPT_SCHEMA = "morrow.desktop-windows-smoke.v1";
const STATE_SECURITY_SCHEMA = "morrow.desktop-windows-state-security.v1";

// The runtime trace stages that name a startup failure. Every other stage means
// the child wrote no failure marker: `none` when it wrote nothing yet,
// `local_owner_ready` when the owner banner had arrived, and `other` for an
// unrecognized line such as Node's SQLite experimental warning. Which of the
// three a healthy run reports is timing, so the assertion is the failure set.
const STDERR_FAILURE_STAGES = Object.freeze(["configured_port_in_use", "local_owner_connection_failed", "protocol_error"]);
const STDERR_NO_FAILURE_STAGES = Object.freeze(["none", "local_owner_ready", "other"]);

function usage() {
  return [
    "Usage:",
    "  node scripts/test/desktop-mac-smoke.mjs --app <absolute Morrow.app> --receipt <absolute receipt.json>"
  ].join("\n");
}

function parseArguments(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (!new Set(["--app", "--receipt"]).has(flag) || parsed.has(flag)) throw new Error(usage());
    const value = values[index + 1];
    if (!value || !isAbsolute(value)) throw new Error(`${flag} requires one absolute path.\n${usage()}`);
    parsed.set(flag, resolve(value));
    index += 1;
  }
  if (parsed.size !== 2) throw new Error(usage());
  return Object.freeze({ app: parsed.get("--app"), receipt: parsed.get("--receipt") });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function boundedOutput(chunks) {
  return Buffer.concat(chunks).subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
}

async function run(executable, argumentsValue, { timeoutMs, environment } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, argumentsValue, {
      env: environment ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) child.kill();
    }, timeoutMs ?? APP_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolveResult({ code, signal, stdout: boundedOutput(stdout), stderr: boundedOutput(stderr) });
    });
  });
}

function ensureSuccess(result, label) {
  if (result.code === 0) return;
  const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").slice(0, MAX_OUTPUT_BYTES);
  throw new Error(`${label} failed with exit ${result.code ?? "unknown"}${result.signal ? ` (${result.signal})` : ""}${detail ? `:\n${detail}` : ""}`);
}

/**
 * The single executable inside the application bundle. macOS names it after
 * productName, so a bundle that carries no `Contents/MacOS/Morrow` and no
 * `Contents/Resources/MorrowPayload` is not the application this harness
 * measures, and saying so is more useful than a later failure to launch.
 */
async function bundleExecutable(bundle) {
  const info = await stat(bundle).catch(() => null);
  if (!info?.isDirectory() || !bundle.endsWith(".app")) throw new Error("--app must name a macOS application bundle ending in .app.");
  const executable = join(bundle, "Contents", "MacOS", "Morrow");
  const executableInfo = await stat(executable).catch(() => null);
  if (!executableInfo?.isFile()) throw new Error("--app does not contain Contents/MacOS/Morrow.");
  await access(executable, constants.X_OK);
  const payload = await stat(join(bundle, "Contents", "Resources", "MorrowPayload")).catch(() => null);
  if (!payload?.isDirectory()) throw new Error("--app does not contain Contents/Resources/MorrowPayload.");
  return executable;
}

/**
 * Whether this machine's Chrome bridge port is free right now. `null` is the
 * third answer: the probe could neither take the port nor find it taken, and
 * that is not the same as "another Morrow holds it".
 */
async function probeBridgePort(port) {
  return new Promise((resolveResult) => {
    const probe = createServer();
    probe.once("error", (error) => {
      probe.close(() => resolveResult(error?.code === "EADDRINUSE" ? false : null));
    });
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolveResult(true)));
  });
}

async function connectorPort(testRoot) {
  const statePath = join(testRoot, "UserData", "State", "canvas-connector.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (state?.schema !== "morrow.canvas-connector.state.v1" || !Number.isSafeInteger(state.port)) {
    throw new Error("Morrow did not write a readable Chrome bridge connector state.");
  }
  return state.port;
}

async function waitForReceipt(receipt, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const content = await readFile(receipt, "utf8");
      return JSON.parse(content);
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    }
  }
  throw new Error(`Morrow did not write its smoke receipt: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/**
 * What a contained macOS run has to report. `acl` is the Windows-only
 * classification, so `not_windows` is its whole answer here and the POSIX
 * record carries the macOS containment facts instead: State is 0700, the
 * local-owner descriptor is 0600, and this account owns both.
 *
 * `bridgePortFree` is measured before the run. Morrow binds the Chrome bridge
 * port when it is free and starts without its browser tools when another
 * program holds it, so each answer is required in its own case and neither one
 * is accepted in place of the other.
 */
function expectedAppReceipt({ bridgePortFree }) {
  return {
    schema: APP_RECEIPT_SCHEMA,
    runtime: { ready: true },
    payload: { withinResources: true },
    state: { withinTestRoot: true },
    codexConfig: { withinTestRoot: true, exists: true },
    health: { attempted: true, gatewayReady: true, bridgeConnected: false },
    runtimeTrace: {
      schema: "morrow.desktop-runtime-trace.v1",
      child: { spawned: true, exitCode: null },
      stderrStage: "no_failure_marker",
      owner: { stderrCaptured: true, failure: null },
      portBinding: bridgePortFree ? "bound" : "unbound",
      upstream: {
        initialize: { ready: true, durationMs: 0 },
        listTools: { ready: true, durationMs: 0 },
        readResource: { ready: true, durationMs: 0 }
      }
    },
    stateSecurity: {
      schema: STATE_SECURITY_SCHEMA,
      state: { underUserData: true, acl: "not_windows" },
      descriptor: {
        withinState: true,
        present: true,
        regularFile: true,
        symlink: false,
        reportedMode: "0600",
        acl: "not_windows"
      },
      posix: { stateMode: "0700", stateOwner: "current_user", descriptorOwner: "current_user" }
    }
  };
}

function exactObject(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Morrow smoke receipt has an invalid record.");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (!isDeepStrictEqual(actual, expected)) throw new Error("Morrow smoke receipt has an unexpected record shape.");
  return value;
}

function normalizedPhase(value) {
  const phase = exactObject(value, ["ready", "durationMs"]);
  return {
    ready: phase.ready === true,
    durationMs: Number.isSafeInteger(phase.durationMs) && phase.durationMs >= 0 && phase.durationMs <= 600_000 ? 0 : -1
  };
}

function normalizedStderrStage(value) {
  if (STDERR_NO_FAILURE_STAGES.includes(value)) return "no_failure_marker";
  return STDERR_FAILURE_STAGES.includes(value) ? value : "unknown_stage";
}

function normalizedAppReceipt(value) {
  const receipt = exactObject(value, ["schema", "runtime", "payload", "state", "codexConfig", "health", "runtimeTrace", "stateSecurity"]);
  const trace = exactObject(receipt.runtimeTrace, ["schema", "child", "stderrStage", "owner", "portBinding", "upstream"]);
  const upstream = exactObject(trace.upstream, ["initialize", "listTools", "readResource"]);
  const stateSecurity = exactObject(receipt.stateSecurity, ["schema", "state", "descriptor", "posix"]);
  return {
    schema: receipt.schema,
    runtime: exactObject(receipt.runtime, ["ready"]),
    payload: exactObject(receipt.payload, ["withinResources"]),
    state: exactObject(receipt.state, ["withinTestRoot"]),
    codexConfig: exactObject(receipt.codexConfig, ["withinTestRoot", "exists"]),
    health: exactObject(receipt.health, ["attempted", "gatewayReady", "bridgeConnected"]),
    runtimeTrace: {
      schema: trace.schema,
      child: exactObject(trace.child, ["spawned", "exitCode"]),
      stderrStage: normalizedStderrStage(trace.stderrStage),
      owner: exactObject(trace.owner, ["stderrCaptured", "failure"]),
      portBinding: trace.portBinding,
      upstream: {
        initialize: normalizedPhase(upstream.initialize),
        listTools: normalizedPhase(upstream.listTools),
        readResource: normalizedPhase(upstream.readResource)
      }
    },
    stateSecurity: {
      schema: stateSecurity.schema,
      state: exactObject(stateSecurity.state, ["underUserData", "acl"]),
      descriptor: exactObject(stateSecurity.descriptor, ["withinState", "present", "regularFile", "symlink", "reportedMode", "acl"]),
      posix: exactObject(stateSecurity.posix, ["stateMode", "stateOwner", "descriptorOwner"])
    }
  };
}

function assertAppReceipt(receipt, precondition) {
  const expected = expectedAppReceipt(precondition);
  const actual = normalizedAppReceipt(receipt);
  const differing = Object.keys(expected).filter((key) => !isDeepStrictEqual(actual[key], expected[key]));
  if (differing.length === 0) return;
  throw new Error(`Morrow smoke receipt did not prove the required contained runtime, state, and Codex configuration. These records differ from what a contained run must report: ${differing.join(", ")}.`);
}

function receiptSidecarPath(receipt) {
  const extension = ".json";
  return receipt.endsWith(extension)
    ? `${receipt.slice(0, -extension.length)}.harness.json`
    : `${receipt}.harness.json`;
}

async function writeHarnessReceipt(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

async function main() {
  if (process.platform !== "darwin") throw new Error("This smoke harness must run on native macOS.");
  const input = parseArguments(process.argv.slice(2));
  const executable = await bundleExecutable(input.app);
  if (await exists(input.receipt)) throw new Error("--receipt must not already exist.");
  await mkdir(dirname(input.receipt), { recursive: true });

  const bridgePortFree = await probeBridgePort(BRIDGE_PORT);
  if (bridgePortFree === null) throw new Error(`This harness could not tell whether Morrow's Chrome bridge port ${BRIDGE_PORT} is free, so it cannot say what the run should report.`);

  const testRoot = await mkdtemp(join(tmpdir(), "morrow-desktop-mac-smoke-"));
  const appReceiptPath = join(testRoot, "app-receipt.json");
  const unrelatedMarker = join(testRoot, "unrelated-marker.txt");
  const markerContents = `preserve-${randomUUID()}\n`;
  await writeFile(unrelatedMarker, markerContents, { encoding: "utf8", flag: "wx" });

  ensureSuccess(await run(executable, [
    `--morrow-test-root=${testRoot}`,
    `--morrow-smoke-receipt=${appReceiptPath}`,
    "--morrow-smoke-install-codex"
  ], {
    timeoutMs: APP_TIMEOUT_MS,
    environment: { ...process.env, MORROW_INSTALLER_TEST_MODE: "1" }
  }), "Installed Morrow startup");
  const appReceipt = await waitForReceipt(appReceiptPath, RECEIPT_TIMEOUT_MS);
  assertAppReceipt(appReceipt, { bridgePortFree });
  const usedPort = await connectorPort(testRoot);
  if (usedPort !== BRIDGE_PORT) throw new Error(`Morrow used Chrome bridge port ${usedPort}, which this harness did not measure before the run.`);
  if (await readFile(unrelatedMarker, "utf8") !== markerContents) throw new Error("Morrow modified unrelated isolated data in the test root.");
  await writeFile(input.receipt, `${JSON.stringify(appReceipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

  const harnessReceipt = {
    schema: "morrow.desktop-mac-harness.v1",
    application: { bundleName: basename(input.app), startupCompleted: true, receipt: appReceipt },
    isolation: { testRoot, unrelatedDataPreserved: true },
    bridgePort: {
      port: BRIDGE_PORT,
      freeBeforeRun: bridgePortFree,
      // Morrow can only bind the one Chrome bridge port a computer has. When
      // another program already held it, this run proved that Morrow starts
      // and names that state, not that Morrow can bind the port.
      listenerProven: bridgePortFree
    },
    observed: { stderrStage: appReceipt.runtimeTrace.stderrStage, portBinding: appReceipt.runtimeTrace.portBinding },
    // This harness launches the bundle it is given, straight from the build
    // output. It measures none of the following, so no run of it is evidence
    // about them.
    notVerified: ["code signature", "notarization", "Gatekeeper quarantine handling", "macOS on Intel"]
  };
  await writeHarnessReceipt(receiptSidecarPath(input.receipt), harnessReceipt);
  process.stdout.write(`${JSON.stringify(harnessReceipt)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[morrow desktop macOS smoke] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { assertAppReceipt };
