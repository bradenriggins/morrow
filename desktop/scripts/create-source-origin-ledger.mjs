#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const maxBuffer = 64 * 1024 * 1024;
const gitRoot = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const sourcePrefix = execFileSync("git", ["-C", root, "rev-parse", "--show-prefix"], {
  encoding: "utf8",
}).trim().replace(/\/$/, "");
const gitPath = (path) => sourcePrefix ? `${sourcePrefix}/${path}` : path;

function sourcePaths() {
  return git(["ls-tree", "-r", "--name-only", "HEAD"])
    .split("\n")
    .filter((path) => path && (!sourcePrefix || path.startsWith(`${sourcePrefix}/`)))
    .map((path) => sourcePrefix ? path.slice(sourcePrefix.length + 1) : path);
}

function git(args, encoding = "utf8") {
  return execFileSync("git", ["-C", gitRoot, ...args], {
    encoding,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function tracked(path, revision = "HEAD") {
  return execFileSync("git", ["-C", gitRoot, "show", `${revision}:${gitPath(path)}`], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer,
  });
}

function beforeDigest(commit, path) {
  try {
    return sha256(tracked(path, `${commit}^`));
  } catch (error) {
    const detail = `${error?.stderr || ""}\n${error?.message || ""}`;
    if (/invalid object name|bad revision|unknown revision|exists on disk, but not in|does not exist in|path .* does not exist/i.test(detail)) {
      return null;
    }
    throw error;
  }
}

const candidateCommit = git(["rev-parse", "HEAD"]).trim();
const paths = sourcePaths()
  .filter((path) => path && path !== "config/source-origin-ledger.json")
  .sort();

const entries = paths.map((path) => {
  const sourceCommit = git(["log", "-1", "--format=%H", "--", gitPath(path)]).trim() || candidateCommit;
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
    reviewer: null,
    beforeDigest: beforeDigest(sourceCommit, path),
    afterDigest: sha256(tracked(path)),
  };
});

const ledger = {
  schema: "morrow.source-origin-ledger.v1",
  status: "unreviewed",
  candidateCommit,
  entries,
  notes: [
    "Entries bind every tracked candidate source to its last source commit and current file digest.",
    "This generator does not review files. status stays unreviewed and reviewer stays empty until a person reviews each file.",
    "A file added in sourceCommit has beforeDigest null. A git show error is not stored as a digest.",
    "Extra entries are allowed in the file because private and public profiles include different subsets. The validator rejects entries that are not in the staged set.",
    "This record does not grant public source rights or publication authorization.",
  ],
};

writeFileSync(
  resolve(root, "config/source-origin-ledger.json"),
  `${JSON.stringify(ledger, null, 2)}\n`,
  { mode: 0o600 },
);
process.stdout.write(`${JSON.stringify({ schema: ledger.schema, candidateCommit, entries: entries.length })}\n`);
