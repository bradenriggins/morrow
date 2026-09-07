#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(root, "artifacts/release", `evidence-${Date.now()}`);
const receiptPath = resolve(root, "artifacts/release/zero-tolerance-receipt.json");
const WINDOWS_ACL_SKIP = Object.freeze({
  test: "the smoke access-control classification reads a real Windows access-control list",
  reason: "Windows access control needs a Windows host",
});
const WINDOWS_ACL_EVIDENCE = Object.freeze({
  installer: "Morrow-1.0.0-win-x64.exe",
  smoke: "smoke.json",
  harness: "smoke.harness.json",
  upgrade: "upgrade.json",
});
const PRIVATE_WINDOWS_ACL = "current_user_system_admin_sensitive_access_only";
const checks = {
  unapproved_provider_writes: ["workspace-test.log", "connector-test.log"],
  out_of_scope_targets_accepted: ["workspace-test.log", "connector-test.log"],
  duplicate_writes_after_ambiguous_delivery: ["workspace-test.log", "connector-test.log"],
  verified_results_with_unmet_postconditions: ["workspace-test.log", "connector-test.log"],
  unknown_effects_displayed_as_success: ["workspace-test.log", "connector-test.log"],
  stale_approvals_accepted: ["workspace-test.log", "connector-test.log"],
  catalog_rows_without_disposition: ["catalog-check.log", "workspace-test.log"],
  held_provider_rows_enabled: ["catalog-check.log", "package-scan.log"],
  credentials_or_covered_identity_in_protected_output: ["workspace-test.log", "connector-test.log", "package-scan.log"],
  private_marker_in_public_candidate: ["package-scan.log", "source-rights.log"],
  required_weekend_proof_silently_skipped: [
    "catalog-check.log",
    "workspace-test.log",
    "connector-test.log",
    "source-rights.log",
    "package-scan.log",
    "connector-package.log",
    "catalog-stats.log",
  ],
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function jsonObject(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function summaryCounts(output, label) {
  return [...output.matchAll(new RegExp(`^ℹ ${label} (\\d+)\\s*$`, "gmi"))]
    .map((match) => Number(match[1]));
}

function skippedTests(output) {
  return [...output.matchAll(/^﹣ (.+?) \([\d.]+ms\) # (.+)$/gm)]
    .map((match) => ({ test: match[1], reason: match[2] }));
}

function hasNonzeroSummary(output, label) {
  return new RegExp(`\\b[1-9]\\d*\\s+${label}\\b|\\b${label}\\s+[1-9]\\d*`, "i").test(output);
}

function isWindowsAclSmokeReceipt(value) {
  return value?.schema === "morrow.desktop-windows-smoke.v1"
    && value.runtime?.ready === true
    && value.payload?.withinResources === true
    && value.state?.withinTestRoot === true
    && value.codexConfig?.withinTestRoot === true
    && value.codexConfig?.exists === true
    && value.health?.attempted === true
    && value.health?.gatewayReady === true
    && value.stateSecurity?.schema === "morrow.desktop-windows-state-security.v1"
    && value.stateSecurity?.state?.underUserData === true
    && value.stateSecurity?.state?.acl === PRIVATE_WINDOWS_ACL
    && value.stateSecurity?.descriptor?.withinState === true
    && value.stateSecurity?.descriptor?.present === true
    && value.stateSecurity?.descriptor?.regularFile === true
    && value.stateSecurity?.descriptor?.symlink === false
    && value.stateSecurity?.descriptor?.acl === PRIVATE_WINDOWS_ACL;
}

function windowsAclEvidence({ repositoryRoot, commit, evidenceDirectory }) {
  if (typeof evidenceDirectory !== "string" || evidenceDirectory.trim() === "") {
    throw new Error("Windows ACL skip requires MORROW_WINDOWS_EVIDENCE_DIR");
  }
  const evidenceRoot = resolve(repositoryRoot, evidenceDirectory);
  const paths = Object.fromEntries(Object.entries(WINDOWS_ACL_EVIDENCE)
    .map(([id, path]) => [id, resolve(evidenceRoot, path)]));
  const installer = readFileSync(paths.installer);
  const installerSha256 = sha256(installer);
  const smoke = jsonObject(paths.smoke);
  const harness = jsonObject(paths.harness);
  const upgrade = jsonObject(paths.upgrade);

  if (!isWindowsAclSmokeReceipt(smoke)) {
    throw new Error("native Windows smoke receipt does not prove the private ACL classification");
  }
  if (harness?.schema !== "morrow.desktop-windows-harness.v2"
    || harness.installer?.fileName !== "Morrow-1.0.0-win-x64.exe"
    || harness.installation?.completed !== true
    || harness.installation?.repairCompleted !== true
    || !isDeepStrictEqual(harness.application?.receipt, smoke)
    || harness.repair?.restoredExactly !== true
    || harness.uninstall?.completed !== true
    || harness.uninstall?.applicationRemoved !== true
    || harness.uninstall?.unrelatedDataPreserved !== true) {
    throw new Error("native Windows harness receipt is not a completed smoke, repair, and uninstall proof");
  }
  if (upgrade?.schema !== "morrow.native-manual-upgrade.v1"
    || upgrade.newSource !== commit
    || upgrade.installerSha256 !== installerSha256
    || upgrade.beforeReady !== true
    || upgrade.afterReady !== true
    || !Array.isArray(upgrade.retained)
    || upgrade.retained.length === 0
    || !upgrade.retained.every((entry) => entry?.unchanged === true)) {
    throw new Error("native Windows upgrade receipt is not bound to this installer and source");
  }

  return Object.entries(paths).map(([id, path]) => ({
    id,
    path: relative(repositoryRoot, path),
    sha256: sha256(readFileSync(path)),
  }));
}

/**
 * Tests run on non-Windows hosts still refuse every skip except this one
 * physical-host check, which requires a native receipt for the final EXE.
 */
export function validateTestOutput({
  id,
  output,
  repositoryRoot = root,
  commit,
  platform = process.platform,
  windowsEvidenceDirectory = process.env.MORROW_WINDOWS_EVIDENCE_DIR,
}) {
  if (hasNonzeroSummary(output, "todo")) {
    throw new Error(`${id} has required TODO tests`);
  }
  const tests = skippedTests(output);
  const nodeSkippedCounts = summaryCounts(output, "skipped").filter((count) => count !== 0);
  if (!hasNonzeroSummary(output, "skipped") && tests.length === 0) return null;
  if (id !== "workspace-test"
    || platform === "win32"
    || nodeSkippedCounts.length !== 1
    || nodeSkippedCounts[0] !== 1
    || tests.length !== 1
    || tests[0].test !== WINDOWS_ACL_SKIP.test
    || tests[0].reason !== WINDOWS_ACL_SKIP.reason) {
    throw new Error(`${id} skipped required tests`);
  }
  return {
    id: "windows_access_control",
    status: "platform-excluded",
    host: platform,
    test: WINDOWS_ACL_SKIP.test,
    reason: WINDOWS_ACL_SKIP.reason,
    nativeEvidence: windowsAclEvidence({ repositoryRoot, commit, evidenceDirectory: windowsEvidenceDirectory }),
  };
}

function run(id, args, { commit, windowsEvidenceDirectory }) {
  const result = spawnSync("pnpm", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 128 * 1024 * 1024,
  });
  const path = resolve(outputRoot, `${id}.log`);
  writeFileSync(path, `${result.stdout || ""}\n${result.stderr || ""}`, { mode: 0o600 });
  if (result.status !== 0 || result.error) throw new Error(`${id} failed; see ${relative(root, path)}`);
  const plainOutput = String(result.stdout || "").replace(/\u001b\[[0-9;]*m/g, "");
  const platformExclusion = id.endsWith("-test") ? validateTestOutput({
    id,
    output: plainOutput,
    commit,
    windowsEvidenceDirectory,
  }) : null;
  process.stdout.write(`[zero-tolerance] ${id}=passed\n`);
  return platformExclusion;
}

function main() {
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  writeFileSync(receiptPath, JSON.stringify({ schema: "morrow.zero-tolerance-receipt.v1", status: "incomplete", checks: [] }));
  try {
  if (git(["status", "--porcelain", "--untracked-files=normal"])) {
    throw new Error("zero-tolerance verification requires a clean worktree and index");
  }
  const commit = git(["rev-parse", "HEAD"]);
  const tree = git(["rev-parse", "HEAD^{tree}"]);
  const privateReceipt = JSON.parse(readFileSync(resolve(root, "artifacts/candidates/private-full/receipt.json"), "utf8"));
  const publicReceipt = JSON.parse(readFileSync(resolve(root, "artifacts/candidates/public-canvas/receipt.json"), "utf8"));
  if (privateReceipt.commit !== commit || publicReceipt.commit !== commit) {
    throw new Error("candidate receipts must be rebuilt for HEAD before zero-tolerance verification");
  }
  const catalog = JSON.parse(readFileSync(resolve(root, "artifacts/canvas-api/canvas-api-catalog.json"), "utf8"));
  const binding = {
    commit,
    tree,
    catalogDigest: catalog.catalogDigest,
    candidateDigests: {
      privateFull: privateReceipt.packageDigest,
      publicCanvas: publicReceipt.packageDigest,
    },
  };

  const runContext = { ...binding, windowsEvidenceDirectory: process.env.MORROW_WINDOWS_EVIDENCE_DIR };
  const platformExclusions = [
    run("catalog-check", ["catalog:canvas:check"], runContext),
    run("workspace-test", ["test"], runContext),
    run("connector-test", ["test:connector"], runContext),
    run("source-rights", ["source-rights:check"], runContext),
    run("package-scan", ["package:scan"], runContext),
    run("connector-package", ["package:connector:check"], runContext),
    run("catalog-stats", ["morrow", "catalog", "stats", "--json"], runContext),
  ].filter(Boolean);
  if (git(["rev-parse", "HEAD"]) !== commit || git(["status", "--porcelain", "--untracked-files=normal"])) {
    throw new Error("source changed while zero-tolerance verification was running");
  }

  const receipt = {
    schema: "morrow.zero-tolerance-receipt.v1",
    status: "passed",
    generatedAt: new Date().toISOString(),
    evidenceRoot: relative(root, outputRoot),
    scope: {
      repository: "example-owner/morrow",
    localSyntheticOnly: true,
    observedRegressionsOnly: true,
      externalReceiptsRemainSeparate: true,
    },
    binding,
    platformExclusions,
    checks: Object.entries(checks).map(([id, evidence]) => {
      const evidenceDigests = evidence.map((name) => ({
        path: name,
        sha256: sha256(readFileSync(resolve(outputRoot, name))),
      }));
      return {
        id,
        status: "passed",
        count: 0,
        receiptDigest: sha256(JSON.stringify({ binding, id, evidenceDigests })),
        evidence: evidenceDigests,
      };
    }),
  };
  writeFileSync(
    receiptPath,
    `${JSON.stringify(receipt, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify({ schema: receipt.schema, commit, checks: receipt.checks.length })}\n`);
  } catch (error) {
  writeFileSync(receiptPath, JSON.stringify({
    schema: "morrow.zero-tolerance-receipt.v1",
    status: "failed",
    generatedAt: new Date().toISOString(),
    evidenceRoot: relative(root, outputRoot),
    checks: [],
    error: error.message,
  }, null, 2));
  throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
