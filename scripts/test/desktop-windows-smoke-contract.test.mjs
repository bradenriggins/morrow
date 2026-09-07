import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  assertAppReceipt,
  assertDamagedAppReceipt,
  assertRetainedData,
  captureRetention,
  damageSealedPayload,
  retentionTargets,
  sealedGatewayEntry
} from "./desktop-windows-smoke.mjs";

const INSTALL_DIRECTORY = resolve("/morrow-install");
const TEST_ROOT = resolve("/morrow-test-root");

/**
 * The receipt shape installer/main.cjs writes on Windows when every step of a
 * contained run succeeded. The `reportedMode` value is the POSIX number Node
 * reports for a writable file on NTFS; it is informational, so the assertions
 * below must not read it.
 */
function healthyReceipt() {
  return {
    schema: "morrow.desktop-windows-smoke.v1",
    runtime: { ready: true },
    payload: { withinResources: true },
    state: { withinTestRoot: true },
    codexConfig: { withinTestRoot: true, exists: true },
    health: { attempted: true, gatewayReady: true, bridgeConnected: false },
    runtimeTrace: {
      schema: "morrow.desktop-runtime-trace.v1",
      child: { spawned: true, exitCode: null },
      stderrStage: "none",
      owner: { stderrCaptured: true, failure: null },
      portBinding: "bound",
      upstream: {
        initialize: { ready: true, durationMs: 4120 },
        listTools: { ready: true, durationMs: 12 },
        readResource: { ready: true, durationMs: 7 }
      }
    },
    stateSecurity: {
      schema: "morrow.desktop-windows-state-security.v1",
      state: { underUserData: true, acl: "current_user_system_admin_sensitive_access_only" },
      descriptor: {
        withinState: true,
        present: true,
        regularFile: true,
        symlink: false,
        reportedMode: "0666",
        acl: "current_user_system_admin_sensitive_access_only"
      },
      posix: { stateMode: null, stateOwner: "not_posix", descriptorOwner: "not_posix" }
    }
  };
}

/**
 * The receipt the same application writes while one sealed payload file is
 * damaged: the sealed runtime verification fails before any runtime child is
 * started, so nothing is spawned, no assistant is configured, and the State
 * already on the computer is still reported exactly as it was.
 */
function damagedReceipt() {
  const receipt = healthyReceipt();
  receipt.runtime.ready = false;
  receipt.codexConfig.exists = false;
  receipt.health = { attempted: false, gatewayReady: false, bridgeConnected: false };
  receipt.runtimeTrace = {
    schema: "morrow.desktop-runtime-trace.v1",
    child: { spawned: false, exitCode: null },
    stderrStage: "not_started",
    owner: { stderrCaptured: false, failure: null },
    portBinding: "not_observed",
    upstream: {
      initialize: { ready: false, durationMs: 0 },
      listTools: { ready: false, durationMs: 0 },
      readResource: { ready: false, durationMs: 0 }
    }
  };
  receipt.stateSecurity.descriptor = { withinState: true, present: false, regularFile: false, symlink: false, reportedMode: null, acl: "not_checked" };
  return receipt;
}

function rejectsHealthy(receipt) {
  assert.throws(() => assertAppReceipt(receipt), /Morrow smoke receipt/);
}

function rejectsDamaged(receipt) {
  assert.throws(() => assertDamagedAppReceipt(receipt), /Morrow smoke receipt/);
}

function retained(overrides = {}) {
  return retentionTargets(TEST_ROOT).map((target, index) => ({
    ...target,
    present: true,
    sha256: `${index}`.repeat(64).slice(0, 64),
    ...overrides
  }));
}

test("accepts the receipt a contained Windows run writes", () => {
  assertAppReceipt(healthyReceipt());
});

test("accepts every startup stage that names no failure", () => {
  for (const stage of ["none", "local_owner_ready", "other"]) {
    const receipt = healthyReceipt();
    receipt.runtimeTrace.stderrStage = stage;
    assertAppReceipt(receipt);
  }
});

test("rejects a startup stage that names a failure or no start at all", () => {
  for (const stage of ["configured_port_in_use", "local_owner_connection_failed", "protocol_error", "not_started", "invented"]) {
    const receipt = healthyReceipt();
    receipt.runtimeTrace.stderrStage = stage;
    rejectsHealthy(receipt);
  }
});

test("reads the owner descriptor's ACL classification and not its POSIX mode", () => {
  const otherMode = healthyReceipt();
  otherMode.stateSecurity.descriptor.reportedMode = "0444";
  assertAppReceipt(otherMode);
  const absentMode = healthyReceipt();
  delete absentMode.stateSecurity.descriptor.reportedMode;
  rejectsHealthy(absentMode);
  const openAcl = healthyReceipt();
  openAcl.stateSecurity.descriptor.acl = "additional_principal_sensitive_access_allow";
  rejectsHealthy(openAcl);
  const stateAcl = healthyReceipt();
  stateAcl.stateSecurity.state.acl = "unavailable";
  rejectsHealthy(stateAcl);
});

test("rejects an owner descriptor that is absent, a symlink, or not a regular file", () => {
  for (const change of [{ present: false }, { symlink: true }, { regularFile: false }, { withinState: false }]) {
    const receipt = healthyReceipt();
    Object.assign(receipt.stateSecurity.descriptor, change);
    rejectsHealthy(receipt);
  }
});

test("rejects a run that never proved its runtime, gateway, or Codex configuration", () => {
  const unready = healthyReceipt();
  unready.runtime.ready = false;
  rejectsHealthy(unready);
  const gateway = healthyReceipt();
  gateway.health.gatewayReady = false;
  rejectsHealthy(gateway);
  const codex = healthyReceipt();
  codex.codexConfig.exists = false;
  rejectsHealthy(codex);
});

test("rejects state, Codex configuration, or a payload read outside the contained run", () => {
  const state = healthyReceipt();
  state.state.withinTestRoot = false;
  rejectsHealthy(state);
  const codex = healthyReceipt();
  codex.codexConfig.withinTestRoot = false;
  rejectsHealthy(codex);
  const payload = healthyReceipt();
  payload.payload.withinResources = false;
  rejectsHealthy(payload);
});

test("rejects a missing or added record and a value that is not a receipt", () => {
  const missing = healthyReceipt();
  delete missing.stateSecurity.posix;
  rejectsHealthy(missing);
  const added = healthyReceipt();
  added.stateSecurity.posix.extra = true;
  rejectsHealthy(added);
  const addedTop = healthyReceipt();
  addedTop.unexpected = true;
  rejectsHealthy(addedTop);
  for (const value of [null, "receipt", 7, []]) rejectsHealthy(value);
});

test("accepts the receipt a damaged sealed payload produces", () => {
  assertDamagedAppReceipt(damagedReceipt());
});

test("refuses to read a healthy run as proof that a damaged payload was caught", () => {
  rejectsDamaged(healthyReceipt());
  const stillReady = damagedReceipt();
  stillReady.runtime.ready = true;
  rejectsDamaged(stillReady);
  const stillServing = damagedReceipt();
  stillServing.health.gatewayReady = true;
  rejectsDamaged(stillServing);
  const stillSpawned = damagedReceipt();
  stillSpawned.runtimeTrace.child.spawned = true;
  rejectsDamaged(stillSpawned);
});

test("requires the damaged run to keep its state contained and still private", () => {
  const outside = damagedReceipt();
  outside.state.withinTestRoot = false;
  rejectsDamaged(outside);
  const openState = damagedReceipt();
  openState.stateSecurity.state.acl = "additional_principal_sensitive_access_allow";
  rejectsDamaged(openState);
  const unexpectedOwner = damagedReceipt();
  unexpectedOwner.stateSecurity.descriptor = healthyReceipt().stateSecurity.descriptor;
  rejectsDamaged(unexpectedOwner);
});

test("names the sealed gateway entry inside the chosen install directory", () => {
  const application = join(INSTALL_DIRECTORY, "Morrow.exe");
  const target = sealedGatewayEntry(INSTALL_DIRECTORY, application);
  assert.equal(target, join(INSTALL_DIRECTORY, "resources", "MorrowPayload", "app", "packages", "mcp-server", "dist", "index.js"));
});

test("refuses to damage anything outside the chosen install directory", () => {
  const elsewhere = join(resolve("/morrow-install-2"), "Morrow.exe");
  assert.throws(() => sealedGatewayEntry(INSTALL_DIRECTORY, elsewhere), /not inside the chosen install directory/);
});

test("names Morrow's state and assistant settings under the test root as the places an uninstall keeps", () => {
  const targets = retentionTargets(TEST_ROOT);
  assert.ok(targets.some((target) => target.requirement === "required"), "retention has to require at least one place");
  assert.deepEqual(
    targets.filter((target) => target.requirement === "required").map((target) => target.path),
    [
      join(TEST_ROOT, "UserData", "State", "morrow.upstreams.json"),
      join(TEST_ROOT, "Home", ".codex", "config.toml"),
      join(TEST_ROOT, "UserData", "State", "morrow.sqlite3")
    ]
  );
  assert.deepEqual(
    targets.filter((target) => target.requirement === "optional").map((target) => target.path),
    [
      join(TEST_ROOT, "UserData", "State", "installer.json")
    ]
  );
});

test("accepts an uninstall that left every place it wrote exactly as it was", () => {
  const before = retained();
  assertRetainedData(before, retained(), INSTALL_DIRECTORY);
});

test("accepts an optional place that no run of this build wrote", () => {
  const absentOptional = (entries) => entries.map((entry) => entry.requirement === "optional"
    ? { ...entry, present: false, sha256: null }
    : entry);
  assertRetainedData(absentOptional(retained()), absentOptional(retained()), INSTALL_DIRECTORY);
});

test("rejects an uninstall that deleted or changed a place it has to keep", () => {
  const deleted = retained();
  deleted[0] = { ...deleted[0], present: false, sha256: null };
  assert.throws(() => assertRetainedData(retained(), deleted, INSTALL_DIRECTORY), /deleted the upstream list/);
  const changed = retained();
  changed[1] = { ...changed[1], sha256: "f".repeat(64) };
  assert.throws(() => assertRetainedData(retained(), changed, INSTALL_DIRECTORY), /changed the Codex settings file/);
});

test("rejects an uninstall that wrote a file that was not there before", () => {
  const before = retained().map((entry) => entry.requirement === "optional" ? { ...entry, present: false, sha256: null } : entry);
  const after = retained();
  assert.throws(() => assertRetainedData(before, after, INSTALL_DIRECTORY), /created Morrow's setup record/);
});

test("refuses to call a run proof of retention when it never wrote the required places", () => {
  const before = retained().map((entry) => entry.requirement === "required" ? { ...entry, present: false, sha256: null } : entry);
  assert.throws(() => assertRetainedData(before, before, INSTALL_DIRECTORY), /cannot prove that removing Morrow keeps them/);
});

test("rejects retained data that lives inside the installed application", () => {
  const inside = retentionTargets(INSTALL_DIRECTORY).map((target, index) => ({
    ...target,
    present: true,
    sha256: `${index}`.repeat(64).slice(0, 64)
  }));
  assert.throws(() => assertRetainedData(inside, inside, INSTALL_DIRECTORY), /inside the installed application/);
});

test("rejects two readings that do not name the same places", () => {
  assert.throws(() => assertRetainedData(retained(), retained().slice(1), INSTALL_DIRECTORY), /before and after the uninstall/);
  assert.throws(() => assertRetainedData([], [], INSTALL_DIRECTORY), /before and after the uninstall/);
  const renamed = retained();
  renamed[1] = { ...renamed[1], path: join(TEST_ROOT, "UserData", "State", "somewhere-else.json") };
  assert.throws(() => assertRetainedData(retained(), renamed, INSTALL_DIRECTORY), /name different places/);
});

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "morrow-desktop-windows-smoke-contract-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeFileAt(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return createHash("sha256").update(content).digest("hex");
}

test("damaging the sealed payload empties one file and puts its exact bytes back", async (t) => {
  const directory = temporaryDirectory(t);
  const target = join(directory, "index.js");
  const contents = Buffer.from("export const gateway = 1;\n");
  const original = writeFileAt(target, contents);

  const damage = await damageSealedPayload(target);
  assert.equal(damage.path, target);
  assert.equal(damage.bytes, contents.length);
  assert.equal(damage.sha256, original);
  assert.equal(damage.writeProtected, false);
  assert.equal(readFileSync(target).length, 0);

  await damage.restore();
  assert.deepEqual(readFileSync(target), contents);
  assert.equal(createHash("sha256").update(readFileSync(target)).digest("hex"), original);
});

test("damages a sealed read-only payload file and leaves its protection as it found it", async (t) => {
  const directory = temporaryDirectory(t);
  const target = join(directory, "index.js");
  const contents = Buffer.from("export const gateway = 1;\n");
  const original = writeFileAt(target, contents);
  // scripts/package-mcp-bundle.mjs seals every payload file 0400, which on
  // Windows is the read-only file attribute.
  chmodSync(target, 0o400);

  const damage = await damageSealedPayload(target);
  assert.equal(damage.writeProtected, true);
  assert.equal(readFileSync(target).length, 0);
  assert.equal(statSync(target).mode & 0o777, 0o400, "the repair installation has to meet the protection a real installation leaves");

  await damage.restore();
  assert.equal(createHash("sha256").update(readFileSync(target)).digest("hex"), original);
  assert.equal(statSync(target).mode & 0o777, 0o400);
});

test("refuses to damage anything that is not a regular file it can measure", async (t) => {
  const directory = temporaryDirectory(t);
  await assert.rejects(() => damageSealedPayload(join(directory, "absent.js")), /not a regular file/);
  mkdirSync(join(directory, "dist"));
  await assert.rejects(() => damageSealedPayload(join(directory, "dist")), /not a regular file/);
  writeFileAt(join(directory, "real.js"), Buffer.from("x"));
  symlinkSync(join(directory, "real.js"), join(directory, "link.js"));
  await assert.rejects(() => damageSealedPayload(join(directory, "link.js")), /not a regular file/);
  writeFileAt(join(directory, "empty.js"), Buffer.alloc(0));
  await assert.rejects(() => damageSealedPayload(join(directory, "empty.js")), /could not damage the sealed payload/);
});

test("captures a digest for each place that is there and nothing for a place that is not", async (t) => {
  const root = temporaryDirectory(t);
  const targets = retentionTargets(root);
  const written = new Map();
  for (const target of targets.filter((entry) => entry.requirement === "required")) {
    written.set(target.id, writeFileAt(target.path, Buffer.from(`${target.id} contents\n`)));
  }

  const captured = await captureRetention(targets);
  assert.deepEqual(captured.map((entry) => entry.id), targets.map((entry) => entry.id));
  for (const entry of captured) {
    if (written.has(entry.id)) {
      assert.equal(entry.present, true, `${entry.id} was written and has to be captured`);
      assert.equal(entry.sha256, written.get(entry.id));
    } else {
      assert.equal(entry.present, false);
      assert.equal(entry.sha256, null);
    }
  }
  assertRetainedData(captured, await captureRetention(targets), resolve("/morrow-install"));
});

test("a file changed between two captures fails the retention check", async (t) => {
  const targets = retentionTargets(temporaryDirectory(t));
  for (const target of targets) writeFileAt(target.path, Buffer.from(`${target.id} contents\n`));
  const before = await captureRetention(targets);
  assert.throws(() => assertRetainedData(before, [], resolve("/morrow-install")), /before and after the uninstall/);

  writeFileSync(targets[0].path, Buffer.from("rewritten by an uninstall\n"));
  const changed = await captureRetention(targets);
  assert.throws(() => assertRetainedData(before, changed, resolve("/morrow-install")), /changed the upstream list/);
});

test("a file deleted between two captures fails the retention check", async (t) => {
  const targets = retentionTargets(temporaryDirectory(t));
  for (const target of targets) writeFileAt(target.path, Buffer.from(`${target.id} contents\n`));
  const before = await captureRetention(targets);

  rmSync(targets.find(target => target.id === "assistant_configuration").path);
  const deleted = await captureRetention(targets);
  assert.throws(() => assertRetainedData(before, deleted, resolve("/morrow-install")), /deleted the Codex settings file/);
});
