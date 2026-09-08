import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { validateTestOutput } from "../create-zero-tolerance-receipt.mjs";

const COMMIT = "a".repeat(40);
const SKIP_LOG = [
  "﹣ the smoke access-control classification reads a real Windows access-control list (0.1ms) # Windows access control needs a Windows host",
  "ℹ skipped 1",
  "ℹ todo 0",
].join("\n");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeFixture() {
  const root = mkdtempSync(resolve(tmpdir(), "morrow-zero-tolerance-"));
  const evidence = resolve(root, "output/final-pass-20260907");
  mkdirSync(evidence, { recursive: true });
  const installer = Buffer.from("native Windows installer");
  const installerSha256 = sha256(installer);
  const smoke = {
    schema: "morrow.desktop-windows-smoke.v1",
    runtime: { ready: true },
    payload: { withinResources: true },
    health: { attempted: true, gatewayReady: true },
    state: { withinTestRoot: true },
    codexConfig: { withinTestRoot: true, exists: true },
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
  writeFileSync(resolve(evidence, "Morrow-1.0.0-win-x64.exe"), installer);
  writeFileSync(resolve(evidence, "smoke.json"), JSON.stringify(smoke));
  writeFileSync(resolve(evidence, "smoke.harness.json"), JSON.stringify({
    schema: "morrow.desktop-windows-harness.v2",
    installer: { fileName: "Morrow-1.0.0-win-x64.exe" },
    installation: { completed: true, repairCompleted: true },
    application: { receipt: smoke },
    repair: { restoredExactly: true },
    uninstall: { completed: true, applicationRemoved: true, unrelatedDataPreserved: true },
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
    afterReady: true,
    privateAclBefore: "current_user_system_admin_sensitive_access_only",
    privateAclAfter: "current_user_system_admin_sensitive_access_only",
    retainedAfterUpgrade: [
      { id: "course_material", sha256Before: "b".repeat(64), sha256After: "b".repeat(64), unchanged: true },
      { id: "assistant_configuration", sha256Before: "c".repeat(64), sha256After: "c".repeat(64), unchanged: true },
    ],
    statePresentAfterUpgrade: true,
    newApplication: {
      sha256: "d".repeat(64),
      fileVersion: "1.0.0",
      productVersion: "1.0.0",
      productName: "Morrow",
      companyName: "Braden Riggins",
      fileDescription: "Morrow",
      signatureStatus: "NotSigned",
      signerCertificate: null,
    },
    registration: { displayName: "Morrow 1.0.0", displayVersion: "1.0.0", publisher: "Braden Riggins" },
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
    evidenceIds: ["installer", "smoke", "harness", "upgrade"],
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
  writeFileSync(resolve(evidence, "Morrow-1.0.0-win-x64.exe"), "different installer");
  assert.throws(() => validateTestOutput({
    id: "workspace-test",
    output: SKIP_LOG,
    repositoryRoot: root,
    commit: COMMIT,
    platform: "darwin",
    windowsEvidenceDirectory: evidence,
  }), /not bound to this installer and source/);
});

test("native Windows upgrade evidence fails closed when any release boundary is weakened", (t) => {
  const cases = [
    ["published artifact", (value) => { value.oldArtifact.sha256 = "0".repeat(64); }],
    ["final source", (value) => { value.newArtifact.source = "0".repeat(40); }],
    ["private state", (value) => { value.privateAclAfter = "unavailable"; }],
    ["retained data", (value) => { value.retainedAfterUpgrade[0].unchanged = false; }],
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
