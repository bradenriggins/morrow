#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { runOwnedProcess } from "../lib/owned-process.mjs";
import { assertDesktopRendererSmokeReceipt } from "../lib/desktop-renderer-smoke.mjs";
import { electronAsarReleaseIdentity, readElectronAsarPackage } from "../lib/electron-asar-package.mjs";
import { withTemporaryDirectory } from "../lib/temporary-directory.mjs";
import { bindWindowsSmokeObservation, createWindowsSmokeBindingFromPackage } from "../lib/windows-smoke-evidence.mjs";

const MAX_OUTPUT_BYTES = 128 * 1024;
// Both limits are machine limits, not contract limits. The NSIS installer
// writes the whole sealed payload, and Morrow verifies every file of that
// payload by size and digest before it starts the gateway, so a run takes tens
// of seconds on a quiet machine and much longer on a loaded one. Reaching
// either limit is a machine result and has to be read as one.
const INSTALL_TIMEOUT_MS = 240_000;
const APP_TIMEOUT_MS = 300_000;
const RECEIPT_TIMEOUT_MS = 20_000;

const APP_RECEIPT_SCHEMA = "morrow.desktop-windows-smoke.v1";
const RUNTIME_TRACE_SCHEMA = "morrow.desktop-runtime-trace.v1";
const STATE_SECURITY_SCHEMA = "morrow.desktop-windows-state-security.v1";
// The only ACL classification installer/main.cjs reports for a State directory
// and an owner descriptor that this account, SYSTEM, and Administrators alone
// can read or change.
const PRIVATE_WINDOWS_ACL = "current_user_system_admin_sensitive_access_only";

// The runtime trace stages that name a startup failure. Every other stage means
// the child wrote no failure marker: `none` when it wrote nothing yet,
// `local_owner_ready` when the owner banner had arrived, and `other` for an
// unrecognized line such as Node's SQLite experimental warning. Which of the
// three a healthy run reports is timing, so the assertion is the failure set.
// `not_started` stays its own answer: it is what a run reports when no runtime
// child was ever started, which is what a damaged payload has to produce.
const STDERR_FAILURE_STAGES = Object.freeze(["configured_port_in_use", "local_owner_connection_failed", "protocol_error"]);
const STDERR_NO_FAILURE_STAGES = Object.freeze(["none", "local_owner_ready", "other"]);

// The one sealed payload file this harness damages before the repair run, named
// from the installed application's own directory. Morrow verifies it by size
// and digest against app/mcp-runtime-manifest.json
// (installer/shared/runtime.cjs), so truncating it leaves every file the
// existence check looks for in place and is caught by the sealed manifest
// verification instead.
const SEALED_GATEWAY_ENTRY = Object.freeze(["resources", "MorrowPayload", "app", "packages", "mcp-server", "dist", "index.js"]);

function usage() {
  return [
    "Usage:",
    "  node scripts/test/desktop-windows-smoke.mjs --installer <absolute setup.exe> --package-receipt <absolute package-receipt.json> --install-dir <absolute directory> --receipt <absolute receipt.json> --source <40-hex commit> --run-id <32-hex id>"
  ].join("\n");
}

function parseArguments(values) {
  const parsed = new Map();
  const pathFlags = new Set(["--installer", "--package-receipt", "--install-dir", "--receipt"]);
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (!new Set([...pathFlags, "--source", "--run-id"]).has(flag) || parsed.has(flag)) throw new Error(usage());
    const value = values[index + 1];
    if (!value) throw new Error(usage());
    if (pathFlags.has(flag) && !isAbsolute(value)) throw new Error(`${flag} requires one absolute path.\n${usage()}`);
    parsed.set(flag, pathFlags.has(flag) ? resolve(value) : value);
    index += 1;
  }
  if (parsed.size !== 6 || !/^[a-f0-9]{40,64}$/i.test(parsed.get("--source")) || !/^[a-f0-9]{32}$/i.test(parsed.get("--run-id"))) throw new Error(usage());
  return Object.freeze({
    installer: parsed.get("--installer"),
    packageReceipt: parsed.get("--package-receipt"),
    installDirectory: parsed.get("--install-dir"),
    receipt: parsed.get("--receipt"),
    sourceCommit: parsed.get("--source").toLowerCase(),
    runId: parsed.get("--run-id").toLowerCase()
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `candidate` is `parent` itself or a path under it. Both are compared
 * as resolved paths, so a sibling whose name starts with the parent's name is
 * outside it.
 */
function insideDirectory(parent, candidate) {
  if (typeof parent !== "string" || typeof candidate !== "string" || !isAbsolute(parent) || !isAbsolute(candidate)) return false;
  const step = relative(resolve(parent), resolve(candidate));
  return step === "" || (!step.startsWith(`..${sep}`) && step !== ".." && !isAbsolute(step));
}

function digestOf(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function run(executable, argumentsValue, { timeoutMs, environment } = {}) {
  return runOwnedProcess(executable, argumentsValue, {
    timeoutMs: timeoutMs ?? INSTALL_TIMEOUT_MS,
    environment,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
}

function ensureSuccess(result, label) {
  if (result.code === 0) return;
  const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").slice(0, MAX_OUTPUT_BYTES);
  throw new Error(`${label} failed with exit ${result.code ?? "unknown"}${result.signal ? ` (${result.signal})` : ""}${detail ? `:\n${detail}` : ""}`);
}

async function listFiles(root, predicate, current = root, results = []) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = join(current, entry.name);
    if (entry.isDirectory()) await listFiles(root, predicate, candidate, results);
    else if (entry.isFile() && predicate(entry.name, candidate)) results.push(candidate);
  }
  return results;
}

async function onlyInstalledFile(root, displayName, predicate) {
  const matches = await listFiles(root, predicate);
  if (matches.length !== 1) throw new Error(`Expected exactly one ${displayName} below the chosen install directory; found ${matches.length}.`);
  return matches[0];
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
 * What Morrow's private State has to report on Windows, in a run that reached
 * its State directory at all. `posix` is the macOS record, so `not_posix` is
 * its whole answer here, and the ACL classification beside it is the record
 * that carries the meaning. The descriptor's `reportedMode` is deliberately
 * absent: POSIX mode bits are not meaningful on NTFS, so the receipt keeps that
 * number as an informational record and this expectation does not read it.
 */
function expectedStateSecurity() {
  return {
    schema: STATE_SECURITY_SCHEMA,
    state: { underUserData: true, acl: PRIVATE_WINDOWS_ACL },
    descriptor: { withinState: true, present: true, regularFile: true, symlink: false, acl: PRIVATE_WINDOWS_ACL },
    posix: { stateMode: null, stateOwner: "not_posix", descriptorOwner: "not_posix" }
  };
}

function expectedAppReceipt() {
  return {
    schema: APP_RECEIPT_SCHEMA,
    runtime: { ready: true },
    payload: { withinResources: true },
    state: { withinTestRoot: true },
    codexConfig: { withinTestRoot: true, exists: true },
    health: { attempted: true, gatewayReady: true, bridgeConnected: false },
    runtimeTrace: {
      schema: RUNTIME_TRACE_SCHEMA,
      child: { spawned: true, exitCode: null },
      stderrStage: "no_failure_marker",
      owner: { stderrCaptured: true, failure: null },
      portBinding: "bound",
      upstream: {
        initialize: { ready: true, durationMs: 0 },
        listTools: { ready: true, durationMs: 0 },
        readResource: { ready: true, durationMs: 0 }
      }
    },
    stateSecurity: expectedStateSecurity()
  };
}

/**
 * What Morrow has to report while one sealed payload file is damaged. The
 * sealed runtime verification fails before any runtime child is started, so the
 * run has to name an unready runtime, start no gateway, configure no assistant,
 * and keep the State it already wrote exactly where it was. A receipt that
 * still reports a ready runtime means the damage this harness made was not the
 * damage Morrow checks for, and that is a failure of the proof, not a pass.
 */
function expectedDamagedAppReceipt() {
  return {
    schema: APP_RECEIPT_SCHEMA,
    runtime: { ready: false },
    payload: { withinResources: true },
    state: { withinTestRoot: true },
    codexConfig: { withinTestRoot: true, exists: false },
    health: { attempted: false, gatewayReady: false, bridgeConnected: false },
    runtimeTrace: {
      schema: RUNTIME_TRACE_SCHEMA,
      child: { spawned: false, exitCode: null },
      stderrStage: "not_started",
      owner: { stderrCaptured: false, failure: null },
      portBinding: "not_observed",
      upstream: {
        initialize: { ready: false, durationMs: 0 },
        listTools: { ready: false, durationMs: 0 },
        readResource: { ready: false, durationMs: 0 }
      }
    },
    stateSecurity: {
      ...expectedStateSecurity(),
      descriptor: { withinState: true, present: false, regularFile: false, symlink: false, acl: "not_checked" }
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
  if (value === "not_started") return "not_started";
  return STDERR_FAILURE_STAGES.includes(value) ? value : "unknown_stage";
}

/**
 * The descriptor record without `reportedMode`. The receipt must still carry
 * that field, so its absence is a shape failure, but its value is the POSIX
 * number Windows has no meaning for and no assertion reads it.
 */
function normalizedDescriptor(value) {
  const descriptor = exactObject(value, ["withinState", "present", "regularFile", "symlink", "reportedMode", "acl"]);
  return {
    withinState: descriptor.withinState,
    present: descriptor.present,
    regularFile: descriptor.regularFile,
    symlink: descriptor.symlink,
    acl: descriptor.acl
  };
}

function normalizedAppReceipt(value) {
  const receiptKeys = ["schema", "runtime", "payload", "state", "codexConfig", "health", "runtimeTrace", "stateSecurity"];
  if (value && typeof value === "object" && !Array.isArray(value)
    && Object.hasOwn(value, "smokeFailure")) receiptKeys.push("smokeFailure");
  const receipt = exactObject(value, receiptKeys);
  const trace = exactObject(receipt.runtimeTrace, ["schema", "child", "stderrStage", "owner", "portBinding", "upstream"]);
  const upstream = exactObject(trace.upstream, ["initialize", "listTools", "readResource"]);
  const stateSecurity = exactObject(receipt.stateSecurity, ["schema", "state", "descriptor", "posix"]);
  const normalized = {
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
      descriptor: normalizedDescriptor(stateSecurity.descriptor),
      posix: exactObject(stateSecurity.posix, ["stateMode", "stateOwner", "descriptorOwner"])
    }
  };
  if (Object.hasOwn(receipt, "smokeFailure")) {
    const failure = exactObject(receipt.smokeFailure, ["stage", "code"]);
    if (!/^[a-z_]{1,40}$/.test(failure.stage)
      || !/^[A-Za-z0-9_]{1,80}$/.test(failure.code)) {
      throw new Error("Morrow smoke receipt has an invalid failure classification.");
    }
    normalized.smokeFailure = { stage: failure.stage, code: failure.code };
  }
  return normalized;
}

function assertReceipt(receipt, expected, subject) {
  const actual = normalizedAppReceipt(receipt);
  const differing = Object.keys(expected).filter((key) => !isDeepStrictEqual(actual[key], expected[key]));
  if (differing.length === 0) return;
  throw new Error(`${subject} These records differ from what that run must report: ${differing.join(", ")}.`);
}

function assertAppReceipt(receipt) {
  assertReceipt(receipt, expectedAppReceipt(), "Morrow smoke receipt did not prove the required contained runtime, state, and Codex configuration.");
}

function assertDamagedAppReceipt(receipt) {
  assertReceipt(receipt, expectedDamagedAppReceipt(), "Morrow smoke receipt did not prove that a damaged sealed payload stops the runtime and is named as unready.");
}

/**
 * The sealed payload file this harness damages, named from the application it
 * found. The path has to stay inside the install directory this run created,
 * so a bundle laid out any other way stops the run instead of writing outside
 * the directory the harness owns.
 */
function sealedGatewayEntry(installDirectory, application) {
  const target = join(dirname(application), ...SEALED_GATEWAY_ENTRY);
  if (!insideDirectory(installDirectory, target)) {
    throw new Error("The sealed payload file this harness damages is not inside the chosen install directory, so this run will not touch it.");
  }
  return target;
}

/**
 * Every place this contained run wrote data that removing the application must
 * keep. The paths follow the test root the app was given: installer/main.cjs
 * puts its user data in `UserData` and the home directory it configures
 * assistants in at `Home`.
 *
 * `required` names a file the healthy run's own receipt proves it wrote, so an
 * absent one means this run cannot prove retention and has to say so. The
 * `optional` files are written only by some runs, and each one that is there is
 * held to the same digest. The owner descriptor is transient process state;
 * normal owner shutdown removes it, so it is not a retention target.
 */
function retentionTargets(testRoot) {
  const state = join(testRoot, "UserData", "State");
  return Object.freeze([
    { id: "state_upstreams", label: "the upstream list Morrow wrote", path: join(state, "morrow.upstreams.json"), requirement: "required" },
    { id: "assistant_configuration", label: "the Codex settings file Morrow wrote", path: join(testRoot, "Home", ".codex", "config.toml"), requirement: "required" },
    { id: "state_record", label: "Morrow's setup record", path: join(state, "installer.json"), requirement: "optional" },
    { id: "state_journal", label: "Morrow's local journal", path: join(state, "morrow.sqlite3"), requirement: "required" }
  ].map((target) => Object.freeze(target)));
}

async function captureRetention(targets) {
  const captured = [];
  for (const target of targets) {
    const info = await lstat(target.path).catch(() => null);
    const present = info?.isFile() === true && info.isSymbolicLink() === false;
    captured.push({
      ...target,
      present,
      sha256: present ? digestOf(await readFile(target.path)) : null
    });
  }
  return captured;
}

/**
 * Proves that removing the application kept every place this run wrote data.
 * Both readings name the same places in the same order, so a place that lost
 * its file, changed its bytes, or appeared out of nowhere is named exactly.
 * A file inside the install directory would be removed with the application,
 * so finding one there is a failure of the retention contract itself and not
 * of the uninstall.
 */
function assertRetainedData(before, after, installDirectory) {
  if (!Array.isArray(before) || !Array.isArray(after) || before.length === 0 || before.length !== after.length) {
    throw new Error("Morrow's retained-data check needs one reading of the same places before and after the uninstall.");
  }
  const absent = before.filter((entry) => entry.requirement === "required" && !entry.present);
  if (absent.length > 0) {
    throw new Error(`This run did not write ${absent.map((entry) => entry.label).join(", ")}, so it cannot prove that removing Morrow keeps them.`);
  }
  for (let index = 0; index < before.length; index += 1) {
    const start = before[index];
    const end = after[index];
    if (start.id !== end.id || start.path !== end.path) throw new Error("Morrow's retained-data readings name different places.");
    if (start.present && insideDirectory(installDirectory, start.path)) {
      throw new Error(`Morrow kept ${start.label} inside the installed application, where removing the application removes it.`);
    }
    if (!start.present) {
      if (end.present) throw new Error(`Removing Morrow created ${start.label}, which no uninstall should write.`);
      continue;
    }
    if (!end.present) throw new Error(`Removing Morrow deleted ${start.label}, which it has to keep.`);
    if (start.sha256 !== end.sha256) throw new Error(`Removing Morrow changed ${start.label}, which it has to keep unchanged.`);
  }
}

/**
 * Damages the sealed payload in one bounded, reversible way and returns the
 * record the repair is measured against.
 *
 * The packaging step seals every payload file read-only
 * (scripts/package-mcp-bundle.mjs), and on Windows that is the read-only file
 * attribute, so this first clears whatever write protection the installed copy
 * carries. It puts the file's own protection back before the repair runs, so
 * the installer meets the file in the state the installation left it in.
 * `restore` puts the original bytes and the original protection back, so a run
 * that fails before the repair proved itself leaves the installation as it
 * found it.
 */
async function damageSealedPayload(target) {
  const info = await lstat(target).catch(() => null);
  if (info?.isFile() !== true || info.isSymbolicLink() === true) {
    throw new Error("The sealed payload file this harness damages is not a regular file in the installed application.");
  }
  const original = await readFile(target);
  const originalSha256 = digestOf(original);
  const originalMode = info.mode & 0o777;
  const write = async (content) => {
    await chmod(target, originalMode | 0o200);
    try { await writeFile(target, content); }
    finally { await chmod(target, originalMode); }
  };
  await write(Buffer.alloc(0));
  const damaged = await readFile(target);
  if (damaged.length !== 0 || digestOf(damaged) === originalSha256) {
    throw new Error("This harness could not damage the sealed payload file it measures a repair with.");
  }
  return {
    path: target,
    bytes: original.length,
    sha256: originalSha256,
    // On Windows this is the read-only file attribute, which is what the
    // repair installation has to be able to replace.
    writeProtected: (originalMode & 0o200) === 0,
    restore: async () => write(original)
  };
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

async function startInstalledMorrow(application, { testRoot, receiptPath, label }) {
  ensureSuccess(await run(application, [
    `--morrow-test-root=${testRoot}`,
    `--morrow-smoke-receipt=${receiptPath}`,
    "--morrow-smoke-install-codex"
  ], {
    timeoutMs: APP_TIMEOUT_MS,
    environment: { ...process.env, MORROW_INSTALLER_TEST_MODE: "1" }
  }), label);
  return waitForReceipt(receiptPath, RECEIPT_TIMEOUT_MS);
}

async function startInstalledRenderer(application, { testRoot, receiptPath }) {
  const result = await run(application, [
    `--morrow-test-root=${testRoot}`,
    `--morrow-renderer-smoke-receipt=${receiptPath}`
  ], {
    timeoutMs: APP_TIMEOUT_MS,
    environment: { ...process.env, MORROW_INSTALLER_TEST_MODE: "1" }
  });
  if (result.code !== 0) {
    let diagnostic = null;
    try {
      const candidate = JSON.parse(await readFile(join(dirname(receiptPath), "renderer-diagnostic.json"), "utf8"));
      if (candidate.schema === "morrow.desktop-renderer-smoke-diagnostic.v1" && Array.isArray(candidate.stages)) {
        diagnostic = candidate.stages;
      }
    } catch { /* The diagnostic is supplementary to the smoke failure. */ }
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").slice(0, MAX_OUTPUT_BYTES);
    throw new Error(`Installed Morrow renderer startup failed with exit ${result.code ?? "unknown"}${result.signal ? ` (${result.signal})` : ""}${detail ? `:\n${detail}` : ""}${diagnostic ? `\nRenderer stages: ${JSON.stringify(diagnostic)}` : ""}`);
  }
  return waitForReceipt(receiptPath, RECEIPT_TIMEOUT_MS);
}

async function main() {
  if (process.platform !== "win32") throw new Error("This smoke harness must run on native Windows.");
  const input = parseArguments(process.argv.slice(2));
  const installerInfo = await stat(input.installer);
  if (!installerInfo.isFile()) throw new Error("--installer must name a regular file.");
  const binding = createWindowsSmokeBindingFromPackage({
    runId: input.runId,
    sourceCommit: input.sourceCommit,
    packageReceipt: input.packageReceipt,
    installer: input.installer,
  });
  if (await exists(input.receipt)) throw new Error("--receipt must not already exist.");
  await mkdir(dirname(input.receipt), { recursive: true });
  if (await exists(input.installDirectory)) {
    const entries = await readdir(input.installDirectory);
    if (entries.length > 0) throw new Error("--install-dir must be empty so this run cannot replace an unrelated installation.");
  } else {
    await mkdir(input.installDirectory, { recursive: true });
  }

  let harnessReceipt;
  try {
    harnessReceipt = await withTemporaryDirectory("morrow-desktop-windows-smoke-", async (testRoot) => {
  const unrelatedMarker = join(testRoot, "unrelated-marker.txt");
  const markerContents = `preserve-${randomUUID()}\n`;
  await writeFile(unrelatedMarker, markerContents, { encoding: "utf8", flag: "wx" });

  const installArguments = ["/S", `/D=${input.installDirectory}`];
  ensureSuccess(await run(input.installer, installArguments, { timeoutMs: INSTALL_TIMEOUT_MS }), "Morrow NSIS installation");
  const app = await onlyInstalledFile(input.installDirectory, "Morrow.exe", (name) => name === "Morrow.exe");
  const asar = join(dirname(app), "resources", "app.asar");
  if (!insideDirectory(input.installDirectory, asar)) throw new Error("Installed Morrow ASAR is outside the chosen installation directory.");
  const installedPackage = electronAsarReleaseIdentity(readElectronAsarPackage(asar), binding);
  const appHashBeforeRepair = digestOf(await readFile(app));

  const appObservation = await startInstalledMorrow(app, {
    testRoot,
    receiptPath: join(testRoot, "app-receipt.json"),
    label: "Installed Morrow startup"
  });
  assertAppReceipt(appObservation);
  const appReceipt = bindWindowsSmokeObservation(appObservation, binding);
  await writeFile(input.receipt, `${JSON.stringify(appReceipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const rendererReceipt = await startInstalledRenderer(app, {
    testRoot,
    receiptPath: join(testRoot, "renderer-receipt.json")
  });
  assertDesktopRendererSmokeReceipt(rendererReceipt, { requireVisible: false });

  // Repair is measured against real damage. Without it, re-running the same
  // installer proves only that an unchanged installation stays unchanged.
  const damage = await damageSealedPayload(sealedGatewayEntry(input.installDirectory, app));
  let damagedReceipt = null;
  let repairedSha256 = null;
  try {
    const damagedObservation = await startInstalledMorrow(app, {
      testRoot,
      receiptPath: join(testRoot, "damaged-app-receipt.json"),
      label: "Installed Morrow startup with a damaged sealed payload"
    });
    assertDamagedAppReceipt(damagedObservation);
    damagedReceipt = bindWindowsSmokeObservation(damagedObservation, binding);

    ensureSuccess(await run(input.installer, installArguments, { timeoutMs: INSTALL_TIMEOUT_MS }), "Morrow NSIS repair installation");
    if (!await exists(app)) throw new Error("Morrow repair installation did not preserve the installed application.");
    if (appHashBeforeRepair !== digestOf(await readFile(app))) throw new Error("Morrow repair installation changed the application while using the same installer artifact.");
    repairedSha256 = digestOf(await readFile(damage.path));
    if (repairedSha256 !== damage.sha256) throw new Error("Morrow repair installation did not restore the damaged sealed payload file to its original bytes.");
  } catch (error) {
    await damage.restore().catch(() => {});
    throw error;
  }

  const repairedObservation = await startInstalledMorrow(app, {
    testRoot,
    receiptPath: join(testRoot, "repaired-app-receipt.json"),
    label: "Installed Morrow startup after the repair installation"
  });
  assertAppReceipt(repairedObservation);
  const repairedReceipt = bindWindowsSmokeObservation(repairedObservation, binding);

  const targets = retentionTargets(testRoot);
  const retainedBefore = await captureRetention(targets);
  const uninstaller = await onlyInstalledFile(input.installDirectory, "NSIS uninstaller", (name) => /^Uninstall Morrow\.exe$/i.test(name));
  // Start-Process waits for NSIS's copied uninstaller and its process tree.
  const psLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
  const uninstallCommand = `$p = Start-Process -FilePath ${psLiteral(uninstaller)} -ArgumentList '/S',${psLiteral(`/D=${input.installDirectory}`)} -Wait -PassThru; exit $p.ExitCode`;
  ensureSuccess(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(uninstallCommand, "utf16le").toString("base64")], { timeoutMs: INSTALL_TIMEOUT_MS }), "Morrow NSIS uninstall");
  if (await exists(app)) throw new Error("Morrow NSIS uninstall left Morrow.exe installed.");
  if (await readFile(unrelatedMarker, "utf8") !== markerContents) throw new Error("Morrow NSIS uninstall modified unrelated isolated data.");
  const retainedAfter = await captureRetention(targets);
  assertRetainedData(retainedBefore, retainedAfter, input.installDirectory);

  return {
    schema: "morrow.desktop-windows-harness.v5",
    binding,
    installer: binding.installer,
    installation: { completed: true, repairCompleted: true },
    application: {
      runtimeDiagnosticCompleted: true,
      rendererStartupCompleted: true,
      receipt: appReceipt,
      rendererReceipt,
      installedPackage
    },
    repair: {
      damagedFile: SEALED_GATEWAY_ENTRY.join("/"),
      damage: "truncated to zero bytes",
      bytesBeforeDamage: damage.bytes,
      sha256BeforeDamage: damage.sha256,
      writeProtectedBeforeDamage: damage.writeProtected,
      sha256AfterRepair: repairedSha256,
      restoredExactly: repairedSha256 === damage.sha256,
      receiptWhileDamaged: damagedReceipt,
      receiptAfterRepair: repairedReceipt
    },
    uninstall: {
      completed: true,
      applicationRemoved: true,
      unrelatedDataPreserved: true,
      retainedData: retainedBefore.map((entry, index) => ({
        id: entry.id,
        location: relative(testRoot, entry.path).split("\\").join("/"),
        requirement: entry.requirement,
        presentBefore: entry.present,
        presentAfter: retainedAfter[index].present,
        sha256: entry.sha256,
        unchanged: entry.present && entry.sha256 === retainedAfter[index].sha256
      }))
    },
    // This harness installs, starts, damages, repairs, and removes one unsigned
    // build inside directories it created. It measures none of the following,
    // so no run of it is evidence about them.
    notVerified: [
      "Authenticode signature",
      "SmartScreen reputation",
      "machine-wide installation",
      "upgrade from a different installed version",
      "retention of a real per-user AppData installation: this run keeps every file it wrote inside its own test root"
    ],
    cleanup: { temporaryStateRemoved: true, installationDirectoryRemoved: true }
  };
    });
  } finally {
    await rm(input.installDirectory, { recursive: true, force: true });
  }
  if (await exists(input.installDirectory)) throw new Error("Morrow smoke installation directory remained after cleanup.");
  await writeHarnessReceipt(receiptSidecarPath(input.receipt), harnessReceipt);
  process.stdout.write(`${JSON.stringify(harnessReceipt)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[morrow desktop Windows smoke] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export {
  assertAppReceipt,
  assertDamagedAppReceipt,
  assertRetainedData,
  captureRetention,
  damageSealedPayload,
  retentionTargets,
  sealedGatewayEntry
};
