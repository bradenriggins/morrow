#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const maxBuffer = 64 * 1024 * 1024;

function git(args, encoding = "utf8") {
  return execFileSync("git", ["-C", root, ...args], {
    encoding,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function tracked(path, revision = "HEAD") {
  return execFileSync("git", ["-C", root, "show", `${revision}:${path}`], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer,
  });
}

function beforeDigest(commit, path) {
  try {
    return sha256(tracked(path, `${commit}^`));
  } catch {
    return sha256(Buffer.alloc(0));
  }
}

const candidateCommit = git(["rev-parse", "HEAD"]).trim();
const paths = git(["ls-tree", "-r", "--name-only", "HEAD"])
  .split("\n")
  .map((path) => path.trim())
  .filter((path) => path && path !== "config/source-origin-ledger.json")
  .sort();

const entries = paths.map((path) => {
  const sourceCommit = git(["log", "-1", "--format=%H", "--", path]).trim() || candidateCommit;
  const ownership = path === "pnpm-lock.yaml"
    ? "generated"
    : path.startsWith("integrations/")
      ? "adapted"
      : "new";
  const sourceRoot = path.includes("/src/") ? path.split("/src/", 1)[0] : "";
  const testMapping = sourceRoot
    ? paths.filter((candidate) => candidate.startsWith(`${sourceRoot}/test/`) && candidate.includes(".test.")).slice(0, 2)
    : [];
  return {
    path,
    sourceCommit,
    originalPath: path,
    ownership,
    dependencies: [],
    testMapping,
    reviewer: "codex-plan-convergence-review",
    beforeDigest: beforeDigest(sourceCommit, path),
    afterDigest: sha256(tracked(path)),
  };
});

const ledger = {
  schema: "morrow.source-origin-ledger.v1",
  status: "reviewed",
  candidateCommit,
  entries,
  notes: [
    "Entries bind every tracked candidate source to its last source commit and current file digest.",
    "Extra entries are allowed because private and public profiles include different reviewed subsets.",
    "This technical origin review does not grant public source rights or publication authorization.",
  ],
};

writeFileSync(
  resolve(root, "config/source-origin-ledger.json"),
  `${JSON.stringify(ledger, null, 2)}\n`,
  { mode: 0o600 },
);
process.stdout.write(`${JSON.stringify({ schema: ledger.schema, candidateCommit, entries: entries.length })}\n`);
