#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(root, "artifacts/release", `evidence-${Date.now()}`);
const receiptPath = resolve(root, "artifacts/release/zero-tolerance-receipt.json");
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
  if (id.endsWith("-test") && /\b[1-9]\d*\s+(?:skipped|todo)\b|\b(?:skipped|todo)\s+[1-9]\d*\b/i.test(plainOutput)) {
    throw new Error(`${id} skipped required tests; see ${relative(root, path)}`);
  }
  process.stdout.write(`[zero-tolerance] ${id}=passed\n`);
}

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

  run("catalog-check", ["catalog:canvas:check"]);
  run("workspace-test", ["test"]);
  run("connector-test", ["test:connector"]);
  run("source-rights", ["source-rights:check"]);
  run("package-scan", ["package:scan"]);
  run("connector-package", ["package:connector:check"]);
  run("catalog-stats", ["morrow", "catalog", "stats", "--json"]);
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
