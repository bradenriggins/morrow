import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  deterministicZip,
  buildCycloneDxSbom,
  scanCandidateEntries,
  sha256,
  stageCandidateSet,
  validateSourceOriginLedger,
} from "../lib/release-candidate.mjs";

test("candidate archive bytes are deterministic", () => {
  const entries = [
    { path: "b.json", data: Buffer.from('{"b":2}\n') },
    { path: "a.md", data: Buffer.from("candidate\n") },
  ];
  const first = deterministicZip(entries);
  const second = deterministicZip([...entries].reverse());
  assert.deepEqual(first, second);
  assert.equal(sha256(first), sha256(second));
});

test("candidate SBOM is deterministic and names each staged package", () => {
  const sourceFiles = [
    { path: "package.json", data: Buffer.from('{"name":"morrow","version":"1.0.0-rc.0"}') },
    { path: "packages/gateway/package.json", data: Buffer.from('{"name":"@morrow/gateway","version":"1.0.0-rc.0"}') },
  ];
  const first = buildCycloneDxSbom({ candidateName: "morrow-v1.0.0-rc.0-test", sourceFiles });
  const second = buildCycloneDxSbom({ candidateName: "morrow-v1.0.0-rc.0-test", sourceFiles: [...sourceFiles].reverse() });
  assert.deepEqual(first, second);
  assert.deepEqual(first.components.map((component) => component.name), ["@morrow/gateway", "morrow"]);
});

test("public package scan checks docs, JSON, and source maps", () => {
  const scan = scanCandidateEntries([
    { path: "docs/example.md", data: Buffer.from("CHCP marker") },
    { path: "examples/config.json", data: Buffer.from('{"path":"/Users/example"}') },
    { path: "bundle.js.map", data: Buffer.from("-----BEGIN PRIVATE KEY-----") },
  ], "public");
  assert.equal(scan.passed, false);
  assert.deepEqual(scan.violations.map((entry) => entry.marker).sort(), [
    "absolute_user_path",
    "private_example-kit_marker",
    "private_key",
  ]);
});

test("source-origin validation fails closed until every staged file is reviewed", () => {
  const root = mkdtempSync(resolve(tmpdir(), "morrow-release-ledger-"));
  try {
    mkdirSync(resolve(root, "config"), { recursive: true });
    const files = [{ path: "packages/example.js", sha256: "a".repeat(64), bytes: 1 }];
    writeFileSync(resolve(root, "config/source-origin-ledger.json"), JSON.stringify({
      schema: "morrow.source-origin-ledger.v1",
      status: "blocked-pending-per-file-review",
      entries: [],
    }));
    const blocked = validateSourceOriginLedger({ root, files, commit: "b".repeat(40) });
    assert.equal(blocked.passed, false);
    assert.deepEqual(blocked.missing, ["packages/example.js"]);

    writeFileSync(resolve(root, "config/source-origin-ledger.json"), JSON.stringify({
      schema: "morrow.source-origin-ledger.v1",
      status: "reviewed",
      candidateCommit: "b".repeat(40),
      entries: [{
        path: "packages/example.js",
        sourceCommit: "d".repeat(40),
        originalPath: "packages/example.js",
        ownership: "new",
        dependencies: [],
        testMapping: ["scripts/test/release-gates.test.mjs"],
        reviewer: "release-review",
        beforeDigest: "c".repeat(64),
        afterDigest: "a".repeat(64),
      }],
    }));
    assert.equal(validateSourceOriginLedger({ root, files, commit: "b".repeat(40) }).passed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate set receipts bind the final digest of every profile", () => {
  const root = mkdtempSync(resolve(tmpdir(), "morrow-release-set-"));
  try {
    mkdirSync(resolve(root, "config"), { recursive: true });
    const packageBytes = Buffer.from('{"name":"morrow-test","version":"1.0.0-rc.0"}\n');
    writeFileSync(resolve(root, "package.json"), packageBytes);
    writeFileSync(resolve(root, "config/release-profiles.json"), JSON.stringify({
      schema: "morrow.release-profiles.v1",
      candidateVersion: "1.0.0-rc.0",
      profiles: {
        "private-full": { visibility: "private", include: ["package.json"], exclude: [] },
        "public-canvas": { visibility: "private", include: ["package.json"], exclude: [] },
      },
    }));
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Morrow Test"], { cwd: root });
    execFileSync("git", ["add", "package.json", "config/release-profiles.json"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    writeFileSync(resolve(root, "config/source-origin-ledger.json"), JSON.stringify({
      schema: "morrow.source-origin-ledger.v1",
      status: "reviewed",
      candidateCommit: sourceCommit,
      entries: [{
        path: "package.json",
        sourceCommit,
        originalPath: "package.json",
        ownership: "new",
        dependencies: [],
        testMapping: ["scripts/test/release-gates.test.mjs"],
        reviewer: "release-review",
        beforeDigest: sha256(Buffer.alloc(0)),
        afterDigest: sha256(packageBytes),
      }],
    }));
    execFileSync("git", ["add", "config/source-origin-ledger.json"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "ledger"], { cwd: root });

    const receipts = stageCandidateSet({
      root,
      profileNames: ["private-full", "public-canvas"],
      verifyRebuild: true,
    });
    const expected = {
      privateFull: receipts[0].packageDigest,
      publicCanvas: receipts[1].packageDigest,
    };
    for (const receipt of receipts) {
      assert.deepEqual(receipt.externalReceipts.binding.candidateDigests, expected);
      assert.deepEqual(receipt.promotionReceipts.binding.candidateDigests, expected);
      assert.deepEqual(receipt.zeroTolerance.binding.candidateDigests, expected);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
