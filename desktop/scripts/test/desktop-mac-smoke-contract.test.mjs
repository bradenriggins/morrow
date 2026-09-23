import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { assertAppReceipt, createMacSmokeBinding } from "./desktop-mac-smoke.mjs";

const PORT_FREE = Object.freeze({ bridgePortFree: true });
const PORT_HELD = Object.freeze({ bridgePortFree: false });
const SOURCE = "a".repeat(40);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The receipt an installed Morrow wrote on macOS on 2026-09-06, kept verbatim
 * so these assertions run against the shape the application really produces.
 * The saved copy is output/desktop-mac-smoke-2026-09-06/receipt.json.
 */
function observedReceipt() {
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
      stderrStage: "other",
      owner: { stderrCaptured: true, failure: null },
      portBinding: "unbound",
      upstream: {
        initialize: { ready: true, durationMs: 3205 },
        listTools: { ready: true, durationMs: 10 },
        readResource: { ready: true, durationMs: 6 }
      }
    },
    stateSecurity: {
      schema: "morrow.desktop-windows-state-security.v1",
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

/** The same run with the Chrome bridge port free, so Morrow binds it. */
function boundReceipt() {
  const receipt = observedReceipt();
  receipt.runtimeTrace.portBinding = "bound";
  return receipt;
}

function rejects(receipt, precondition = PORT_FREE) {
  assert.throws(() => assertAppReceipt(receipt, precondition), /Morrow smoke receipt/);
}

test("accepts the receipt a contained run writes when the Chrome bridge port was free", () => {
  assertAppReceipt(boundReceipt(), PORT_FREE);
});

test("macOS smoke evidence binds the retained package graph, DMG, ZIP, source, and run", async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "morrow-mac-smoke-binding-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const diskImage = resolve(root, "Morrow-1.0.4-mac-arm64.dmg");
  const archive = resolve(root, "Morrow-1.0.4-mac-arm64.zip");
  const packageReceipt = resolve(root, "package-receipt.json");
  const imageBytes = Buffer.from("retained disk image");
  const archiveBytes = Buffer.from("retained archive");
  writeFileSync(diskImage, imageBytes);
  writeFileSync(archive, archiveBytes);
  writeFileSync(packageReceipt, JSON.stringify({
    schema: "morrow.desktop-installer.v1",
    version: "1.0.4",
    target: "darwin-arm64",
    source: { head: SOURCE, dirty: false },
    payload: { releaseGraph: { schema: "morrow.desktop-packager-admission.v1", sha256: "c".repeat(64) } },
    signing: { mode: "unsigned_private_qa", target: "darwin-arm64", publicRelease: false },
    artifacts: [
      { name: "Morrow-1.0.4-mac-arm64.dmg", sha256: sha256(imageBytes) },
      { name: "Morrow-1.0.4-mac-arm64.zip", sha256: sha256(archiveBytes) },
    ],
  }));

  const binding = await createMacSmokeBinding({
    diskImage,
    packageReceipt,
    source: SOURCE,
    runId: "b".repeat(32),
  });
  assert.equal(binding.sourceCommit, SOURCE);
  assert.equal(binding.diskImage.sha256, sha256(imageBytes));
  assert.equal(binding.artifacts.length, 2);

  writeFileSync(diskImage, "substituted disk image");
  await assert.rejects(createMacSmokeBinding({
    diskImage,
    packageReceipt,
    source: SOURCE,
    runId: "b".repeat(32),
  }), /artifact changed/);
  writeFileSync(diskImage, imageBytes);
  await assert.rejects(createMacSmokeBinding({
    diskImage,
    packageReceipt,
    source: "d".repeat(40),
    runId: "b".repeat(32),
  }), /not the expected unsigned release graph/);
});

/**
 * The release a maintainer publishes is built with --unsigned-release, and the QA workflow builds
 * with --unsigned-qa. Both are the same unsigned application; only the receipt's signing record
 * differs. docs/versioning.md smoke-tests the published files before `gh release create`, so the
 * harness binds either record the packager writes, and nothing else.
 *
 * Failure mode pinned down (written before the fix; final sweep 2026-09-23): the harness refused
 * every --unsigned-release receipt, so the files educators download were never started by a smoke
 * test; the QA run tested other bytes that were then discarded.
 */
test("macOS smoke binds the unsigned release build a maintainer publishes, and no other signing record", async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "morrow-mac-smoke-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const imageBytes = Buffer.from("published disk image");
  const archiveBytes = Buffer.from("published archive");
  writeFileSync(resolve(root, "Morrow-1.0.5-mac-arm64.dmg"), imageBytes);
  writeFileSync(resolve(root, "Morrow-1.0.5-mac-arm64.zip"), archiveBytes);
  const bind = (signing) => {
    const packageReceipt = resolve(root, "receipt.json");
    writeFileSync(packageReceipt, JSON.stringify({
      schema: "morrow.desktop-installer.v1",
      version: "1.0.5",
      target: "darwin-arm64",
      source: { head: SOURCE, dirty: false },
      payload: { releaseGraph: { schema: "morrow.desktop-packager-admission.v1", sha256: "c".repeat(64) } },
      signing,
      artifacts: [
        { name: "Morrow-1.0.5-mac-arm64.dmg", sha256: sha256(imageBytes) },
        { name: "Morrow-1.0.5-mac-arm64.zip", sha256: sha256(archiveBytes) },
      ],
    }));
    return createMacSmokeBinding({ diskImage: resolve(root, "Morrow-1.0.5-mac-arm64.dmg"), packageReceipt, source: SOURCE, runId: "b".repeat(32) });
  };

  const release = { mode: "unsigned_public_release", target: "darwin-arm64", publicRelease: true, automaticUpdates: false };
  const binding = await bind(release);
  assert.equal(binding.diskImage.fileName, "Morrow-1.0.5-mac-arm64.dmg");
  assert.equal(binding.packageReceipt.fileName, "receipt.json");
  await bind({ mode: "unsigned_private_qa", target: "darwin-arm64", publicRelease: false });

  for (const signing of [
    { ...release, publicRelease: false },
    { ...release, automaticUpdates: true },
    { mode: "unsigned_private_qa", target: "darwin-arm64", publicRelease: true },
    { ...release, target: "win32-x64" },
    { ...release, identity: "Developer ID Application" },
    { mode: "signed_public_release", target: "darwin-arm64", publicRelease: true, automaticUpdates: false },
  ]) {
    await assert.rejects(bind(signing), /not the expected unsigned release graph/, JSON.stringify(signing));
  }
});

test("accepts the named unbound state when another program held the Chrome bridge port", () => {
  assertAppReceipt(observedReceipt(), PORT_HELD);
});

test("requires the Chrome bridge port that the machine actually allowed", () => {
  rejects(observedReceipt(), PORT_FREE);
  rejects(boundReceipt(), PORT_HELD);
});

test("rejects the receipt an incomplete payload produces", () => {
  const receipt = boundReceipt();
  receipt.runtime.ready = false;
  receipt.codexConfig.exists = false;
  receipt.health = { attempted: false, gatewayReady: false, bridgeConnected: false };
  rejects(receipt);
});

test("rejects a gateway that never answered its health request", () => {
  const receipt = boundReceipt();
  receipt.health.gatewayReady = false;
  rejects(receipt);
});

test("a rejected receipt names what each differing record observed and what a contained run reports", () => {
  const receipt = boundReceipt();
  receipt.health.gatewayReady = false;
  receipt.runtimeTrace.portBinding = "not_observed";
  receipt.runtimeTrace.upstream.listTools = { ready: false, durationMs: 10 };
  let message = "";
  try { assertAppReceipt(receipt, PORT_FREE); } catch (error) { message = error.message; }
  assert.match(message, /These records differ from what a contained run must report: health, runtimeTrace\./);
  assert.ok(message.includes('health observed {"attempted":true,"gatewayReady":false,"bridgeConnected":false}; '
    + 'expected {"attempted":true,"gatewayReady":true,"bridgeConnected":false}'), message);
  assert.ok(message.includes('"portBinding":"not_observed"'), message);
  assert.ok(message.includes('"listTools":{"ready":false,"durationMs":0}'), message);
  assert.doesNotMatch(message, /stateSecurity observed/);
});

test("rejects state or Codex configuration written outside the test root", () => {
  const outsideState = boundReceipt();
  outsideState.state.withinTestRoot = false;
  rejects(outsideState);
  const outsideCodex = boundReceipt();
  outsideCodex.codexConfig.withinTestRoot = false;
  rejects(outsideCodex);
});

test("rejects a payload read from outside the application bundle", () => {
  const receipt = boundReceipt();
  receipt.payload.withinResources = false;
  rejects(receipt);
});

test("rejects a missing or added record", () => {
  const missing = boundReceipt();
  delete missing.stateSecurity.posix;
  rejects(missing);
  const added = boundReceipt();
  added.stateSecurity.posix.extra = true;
  rejects(added);
  const addedTop = boundReceipt();
  addedTop.unexpected = true;
  rejects(addedTop);
});

test("rejects a State directory or owner descriptor that is not private", () => {
  const state = boundReceipt();
  state.stateSecurity.posix.stateMode = "0755";
  rejects(state);
  const descriptor = boundReceipt();
  descriptor.stateSecurity.descriptor.reportedMode = "0644";
  rejects(descriptor);
});

test("rejects state this account does not own", () => {
  const other = boundReceipt();
  other.stateSecurity.posix.descriptorOwner = "other_user";
  rejects(other);
  const unchecked = boundReceipt();
  unchecked.stateSecurity.posix.stateOwner = "not_checked";
  rejects(unchecked);
});

test("rejects a Windows ACL classification in a macOS receipt", () => {
  const receipt = boundReceipt();
  receipt.stateSecurity.state.acl = "current_user_system_admin_sensitive_access_only";
  rejects(receipt);
});

test("rejects an owner descriptor that is absent or a symlink", () => {
  const absent = boundReceipt();
  absent.stateSecurity.descriptor.present = false;
  rejects(absent);
  const symlink = boundReceipt();
  symlink.stateSecurity.descriptor.symlink = true;
  rejects(symlink);
});

test("rejects a startup stage that names a failure", () => {
  for (const stage of ["configured_port_in_use", "local_owner_connection_failed", "protocol_error", "not_started"]) {
    const receipt = boundReceipt();
    receipt.runtimeTrace.stderrStage = stage;
    rejects(receipt);
  }
});

test("accepts every startup stage that names no failure", () => {
  for (const stage of ["none", "local_owner_ready", "other"]) {
    const receipt = boundReceipt();
    receipt.runtimeTrace.stderrStage = stage;
    assertAppReceipt(receipt, PORT_FREE);
  }
});

test("rejects an upstream phase that failed or reported an impossible duration", () => {
  const failed = boundReceipt();
  failed.runtimeTrace.upstream.listTools.ready = false;
  rejects(failed);
  const negative = boundReceipt();
  negative.runtimeTrace.upstream.readResource.durationMs = -1;
  rejects(negative);
  const enormous = boundReceipt();
  enormous.runtimeTrace.upstream.initialize.durationMs = 600_001;
  rejects(enormous);
});

test("rejects a runtime child that never spawned or that exited", () => {
  const unspawned = boundReceipt();
  unspawned.runtimeTrace.child.spawned = false;
  rejects(unspawned);
  const exited = boundReceipt();
  exited.runtimeTrace.child.exitCode = 1;
  rejects(exited);
});

test("rejects an owner whose stderr was not captured or that reported a failure", () => {
  const uncaptured = boundReceipt();
  uncaptured.runtimeTrace.owner.stderrCaptured = false;
  rejects(uncaptured);
  const failure = boundReceipt();
  failure.runtimeTrace.owner.failure = "local owner connection failed";
  rejects(failure);
});

test("rejects a value that is not a receipt", () => {
  for (const value of [null, "receipt", 7, []]) rejects(value);
});
