import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { validateTestOutput } from "../create-zero-tolerance-receipt.mjs";
import { bindWindowsSmokeObservation, createWindowsSmokeBinding } from "../lib/windows-smoke-evidence.mjs";

const COMMIT = "a".repeat(40);
const SKIP_LOG = [
  "﹣ the smoke access-control classification reads a real Windows access-control list (0.1ms) # Windows access control needs a Windows host",
  "ℹ skipped 1",
  "ℹ todo 0",
].join("\n");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeFixture({ installer = Buffer.from("native Windows installer"), runId = "1".repeat(32) } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "morrow-zero-tolerance-"));
  const evidence = resolve(root, "output/final-pass-20260907");
  mkdirSync(evidence, { recursive: true });
  const installerSha256 = sha256(installer);
  const packageReceipt = JSON.stringify({
    schema: "morrow.desktop-installer.v1",
    version: "1.0.4",
    target: "win32-x64",
    source: { head: COMMIT, dirty: false },
    payload: { releaseGraph: { schema: "morrow.desktop-packager-admission.v1", sha256: "c".repeat(64) } },
    signing: {
      mode: "unsigned_private_qa",
      target: "win32-x64",
      publicRelease: false,
      artifactSignature: "authenticode_absent",
    },
    artifacts: [{ name: "Morrow-1.0.4-win-x64.exe", sha256: installerSha256 }],
  });
  const smokeObservation = {
    schema: "morrow.desktop-windows-smoke.v1",
    runtime: { ready: true },
    payload: { withinResources: true },
    health: { attempted: true, gatewayReady: true },
    state: { withinTestRoot: true },
    codexConfig: { withinTestRoot: true, exists: true },
    runtimeTrace: { schema: "morrow.desktop-runtime-trace.v1" },
    stateSecurity: {
      schema: "morrow.desktop-windows-state-security.v1",
      state: { underUserData: true, acl: "current_user_system_admin_sensitive_access_only" },
      descriptor: {
        withinState: true,
        present: true,
        regularFile: true,
        symlink: false,
        acl: "current_user_system_admin_sensitive_access_only",
      },
    },
  };
  const binding = createWindowsSmokeBinding({
    runId,
    sourceCommit: COMMIT,
    packageReceiptSha256: sha256(packageReceipt),
    releaseGraphSha256: "c".repeat(64),
    installerFileName: "Morrow-1.0.4-win-x64.exe",
    installerSha256,
  });
  const smoke = bindWindowsSmokeObservation(smokeObservation, binding);
  writeFileSync(resolve(evidence, "Morrow-1.0.4-win-x64.exe"), installer);
  writeFileSync(resolve(evidence, "package-receipt.json"), packageReceipt);
  writeFileSync(resolve(evidence, "smoke.json"), JSON.stringify(smoke));
  writeFileSync(resolve(evidence, "smoke.harness.json"), JSON.stringify({
    schema: "morrow.desktop-windows-harness.v5",
    binding,
    installer: binding.installer,
    installation: { completed: true, repairCompleted: true },
    application: {
      runtimeDiagnosticCompleted: true,
      rendererStartupCompleted: true,
      receipt: smoke,
      rendererReceipt: {
        schema: "morrow.desktop-renderer-smoke.v1",
        renderer: { loaded: true, stateRendered: true },
        window: { visible: true },
      },
      installedPackage: { sourceCommit: COMMIT, releaseGraphSha256: "c".repeat(64) },
    },
    repair: { restoredExactly: true, receiptWhileDamaged: smoke, receiptAfterRepair: smoke },
    uninstall: { completed: true, applicationRemoved: true, unrelatedDataPreserved: true },
    cleanup: { temporaryStateRemoved: true, installationDirectoryRemoved: true },
  }));
  writeFileSync(resolve(evidence, "upgrade.json"), JSON.stringify({
    schema: "morrow.native-windows-upgrade.v1",
    oldArtifact: {
      role: "published_v1.0.0",
      source: "3720b76bfd5dc5d132627777be4034bf9ef0dae5",
      sha256: "2750cd7b6746fb7f6701a92920158691eb9ad787732826597f6de4c3ed0fadf1",
    },
    newArtifact: { role: "workflow_build", source: COMMIT, sha256: installerSha256 },
    beforeReady: true,
    beforeReadiness: {
      coldGatewayReady: false,
      retryUsed: true,
      retryUsedIffColdNotReady: true,
      finalGatewayReady: true,
    },
    afterReady: true,
    stateSecurity: {
      before: {
        stateAcl: "additional_principal_sensitive_access_allow",
        descriptorAcl: "additional_principal_sensitive_access_allow",
        acceptedAs: "pinned_3720_legacy",
      },
      after: {
        stateAcl: "current_user_system_admin_sensitive_access_only",
        descriptorAcl: "current_user_system_admin_sensitive_access_only",
        acceptedAs: "private",
      },
    },
    privateAclBefore: "additional_principal_sensitive_access_allow",
    privateAclAfter: "current_user_system_admin_sensitive_access_only",
    retainedAfterUpgrade: [
      { id: "course_material", sha256Before: "b".repeat(64), sha256After: "b".repeat(64), unchanged: true },
      { id: "assistant_configuration", sha256Before: "c".repeat(64), sha256After: "c".repeat(64), unchanged: true },
    ],
    retention: {
      exactAcrossUpgrade: [
        { id: "course_material", sha256Before: "b".repeat(64), sha256After: "b".repeat(64), unchanged: true },
        { id: "assistant_configuration", sha256Before: "c".repeat(64), sha256After: "c".repeat(64), unchanged: true },
      ],
      applicationStateExactAfterInstall: [
        { id: "state_upstreams", sha256Before: "e".repeat(64), sha256After: "e".repeat(64), unchanged: true },
        { id: "state_journal", sha256Before: "f".repeat(64), sha256After: "f".repeat(64), unchanged: true },
      ],
      applicationStateAfterRuntime: {
        ids: ["state_upstreams", "state_journal"],
        presentAfterUpgrade: true,
        exactAcrossUninstall: true,
      },
    },
    statePresentAfterUpgrade: true,
    newApplication: {
      sha256: "d".repeat(64),
      fileVersion: "1.0.4",
      productVersion: "1.0.4.0",
      productName: "Morrow",
      companyName: "Braden Riggins",
      fileDescription: "Morrow",
      signatureStatus: "NotSigned",
      signerCertificate: null,
    },
    registration: { displayName: "Morrow 1.0.4", displayVersion: "1.0.4", publisher: "Braden Riggins" },
    uninstall: {
      completed: true,
      uninstallerSignatureStatus: "NotSigned",
      dataRetained: true,
      stateRetained: true,
      registryCount: 0,
      shortcutCount: 0,
      processCount: 0,
    },
  }));
  return { root, evidence };
}

test("only the native-Windows ACL skip is accepted, and only with bound evidence", (t) => {
  const { root, evidence } = writeFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const exclusion = validateTestOutput({
    id: "workspace-test",
    output: SKIP_LOG,
    repositoryRoot: root,
    commit: COMMIT,
    platform: "darwin",
    windowsEvidenceDirectory: evidence,
  });
  assert.deepEqual(exclusion && {
    id: exclusion.id,
    status: exclusion.status,
    host: exclusion.host,
    test: exclusion.test,
    reason: exclusion.reason,
    evidenceIds: exclusion.nativeEvidence.map((entry) => entry.id),
  }, {
    id: "windows_access_control",
    status: "platform-excluded",
    host: "darwin",
    test: "the smoke access-control classification reads a real Windows access-control list",
    reason: "Windows access control needs a Windows host",
    evidenceIds: ["installer", "packageReceipt", "smoke", "harness", "upgrade"],
  });
  assert.throws(() => validateTestOutput({
    id: "workspace-test",
    output: SKIP_LOG.replace("Windows access control needs a Windows host", "different reason"),
    repositoryRoot: root,
    commit: COMMIT,
    platform: "darwin",
    windowsEvidenceDirectory: evidence,
  }), /skipped required tests/);
  for (const output of [
    "Tests 1 skipped",
    "# skipped 2",
    "Tests 1 todo",
    [
      "﹣ the smoke access-control classification reads a real Windows access-control list (0.1ms) # Windows access control needs a Windows host",
      "﹣ a second skipped test (0.1ms) # a reason",
      "ℹ skipped 2",
      "ℹ todo 0",
    ].join("\n"),
  ]) {
    assert.throws(() => validateTestOutput({
      id: "workspace-test",
      output,
      repositoryRoot: root,
      commit: COMMIT,
      platform: "darwin",
      windowsEvidenceDirectory: evidence,
    }), /required (?:TODO )?tests/);
  }
  assert.throws(() => validateTestOutput({
    id: "workspace-test",
    output: SKIP_LOG,
    repositoryRoot: root,
    commit: COMMIT,
    platform: "win32",
    windowsEvidenceDirectory: evidence,
  }), /skipped required tests/);
  writeFileSync(resolve(evidence, "Morrow-1.0.4-win-x64.exe"), "different installer");
  assert.throws(() => validateTestOutput({
    id: "workspace-test",
    output: SKIP_LOG,
    repositoryRoot: root,
    commit: COMMIT,
    platform: "darwin",
    windowsEvidenceDirectory: evidence,
  }), /Retained Windows installer changed after packaging/);
});

test("native Windows upgrade evidence fails closed when any release boundary is weakened", (t) => {
  const cases = [
    ["published artifact", (value) => { value.oldArtifact.sha256 = "0".repeat(64); }],
    ["final source", (value) => { value.newArtifact.source = "0".repeat(40); }],
    ["private state", (value) => { value.privateAclAfter = "unavailable"; }],
    ["legacy descriptor state", (value) => { value.stateSecurity.before.descriptorAcl = "unavailable"; }],
    ["bounded legacy retry", (value) => { value.beforeReadiness.retryUsedIffColdNotReady = false; }],
    ["retained data", (value) => { value.retainedAfterUpgrade[0].unchanged = false; }],
    ["application state after install", (value) => { value.retention.applicationStateExactAfterInstall[0].sha256After = "0".repeat(64); }],
    ["application state after runtime", (value) => { value.retention.applicationStateAfterRuntime.exactAcrossUninstall = false; }],
    ["exact application version", (value) => { value.newApplication.productVersion = "1.0.0"; }],
    ["unsigned application", (value) => { value.newApplication.signerCertificate = "CN=Unexpected"; }],
    ["complete uninstall", (value) => { value.uninstall.stateRetained = false; }],
  ];
  for (const [label, mutate] of cases) {
    const { root, evidence } = writeFixture();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = resolve(evidence, "upgrade.json");
    const value = JSON.parse(readFileSync(path, "utf8"));
    mutate(value);
    writeFileSync(path, JSON.stringify(value));
    assert.throws(() => validateTestOutput({
      id: "workspace-test",
      output: SKIP_LOG,
      repositoryRoot: root,
      commit: COMMIT,
      platform: "darwin",
      windowsEvidenceDirectory: evidence,
    }), /not bound to this installer and source/, label);
  }
});

test("native Windows smoke and harness evidence must come from the retained installer and the same run", (t) => {
  const first = writeFixture({ installer: Buffer.from("installer A"), runId: "1".repeat(32) });
  const second = writeFixture({ installer: Buffer.from("installer B"), runId: "2".repeat(32) });
  t.after(() => rmSync(first.root, { recursive: true, force: true }));
  t.after(() => rmSync(second.root, { recursive: true, force: true }));

  for (const name of ["smoke.json", "smoke.harness.json"]) {
    writeFileSync(resolve(second.evidence, name), readFileSync(resolve(first.evidence, name)));
  }
  assert.throws(() => validateTestOutput({
    id: "workspace-test",
    output: SKIP_LOG,
    repositoryRoot: second.root,
    commit: COMMIT,
    platform: "darwin",
    windowsEvidenceDirectory: second.evidence,
  }), /smoke receipt is not bound to this installer and source/);

  const smoke = JSON.parse(readFileSync(resolve(first.evidence, "smoke.json"), "utf8"));
  const harnessPath = resolve(first.evidence, "smoke.harness.json");
  const harness = JSON.parse(readFileSync(harnessPath, "utf8"));
  harness.binding.runId = "2".repeat(32);
  writeFileSync(harnessPath, JSON.stringify(harness));
  assert.throws(() => validateTestOutput({
    id: "workspace-test",
    output: SKIP_LOG,
    repositoryRoot: first.root,
    commit: COMMIT,
    platform: "darwin",
    windowsEvidenceDirectory: first.evidence,
  }), /harness receipt is not a completed smoke, repair, and uninstall proof/);
  assert.equal(smoke.binding.runId, "1".repeat(32));
});
