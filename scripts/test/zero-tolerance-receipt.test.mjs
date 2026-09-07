import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
    schema: "morrow.native-manual-upgrade.v1",
    newSource: COMMIT,
    installerSha256,
    beforeReady: true,
    afterReady: true,
    retained: [{ unchanged: true }],
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
