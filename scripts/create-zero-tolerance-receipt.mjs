#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(root, "artifacts/release/evidence-current");
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

function run(id, args) {
  const output = execFileSync("pnpm", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 128 * 1024 * 1024,
  });
  const path = resolve(outputRoot, `${id}.log`);
  writeFileSync(path, output, { mode: 0o600 });
  process.stdout.write(`[zero-tolerance] ${id}=passed\n`);
}

const commit = git(["rev-parse", "HEAD"]);
const privateReceipt = JSON.parse(readFileSync(resolve(root, "artifacts/candidates/private-full/receipt.json"), "utf8"));
const publicReceipt = JSON.parse(readFileSync(resolve(root, "artifacts/candidates/public-canvas/receipt.json"), "utf8"));
if (privateReceipt.commit !== commit || publicReceipt.commit !== commit) {
  throw new Error("candidate receipts must be rebuilt for HEAD before zero-tolerance verification");
}
const catalog = JSON.parse(readFileSync(resolve(root, "artifacts/canvas-api/canvas-api-catalog.json"), "utf8"));
const binding = {
  commit,
  catalogDigest: catalog.catalogDigest,
  candidateDigests: {
    privateFull: privateReceipt.packageDigest,
    publicCanvas: publicReceipt.packageDigest,
  },
};

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
run("catalog-check", ["catalog:canvas:check"]);
run("workspace-test", ["test"]);
run("connector-test", ["test:connector"]);
run("source-rights", ["source-rights:check"]);
run("package-scan", ["package:scan"]);
run("connector-package", ["package:connector:check"]);
run("catalog-stats", ["morrow", "catalog", "stats", "--json"]);

const receipt = {
  schema: "morrow.zero-tolerance-receipt.v1",
  generatedAt: new Date().toISOString(),
  evidenceRoot: "artifacts/release/evidence-current",
  scope: {
    repository: "example-owner/morrow",
    localSyntheticOnly: true,
    externalReceiptsRemainSeparate: true,
  },
  binding,
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
  resolve(root, "artifacts/release/zero-tolerance-receipt.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
  { mode: 0o600 },
);
process.stdout.write(`${JSON.stringify({ schema: receipt.schema, commit, checks: receipt.checks.length })}\n`);
