import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  deterministicZip,
  buildCycloneDxSbom,
  scanCandidateEntries,
  sha256,
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
