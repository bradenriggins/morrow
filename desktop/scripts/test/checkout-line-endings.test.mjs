import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * The release packager digests every Morrow Bridge file against the sealed release ledger and
 * reads package integrity from pnpm-lock.yaml, so both need the committed bytes. Git for Windows
 * and the windows-2022 runner check out with core.autocrlf=true, which rewrote every one of these
 * text files with Windows line endings: the Windows packaging job then found no `packages:`
 * section in the lockfile, and the Bridge digests could not match the seal.
 */
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const SEALED_PATHS = ["desktop/connector/extension", "desktop/pnpm-lock.yaml"];

function git(args) {
  return execFileSync("git", args, { cwd: repository, maxBuffer: 64 * 1024 * 1024 });
}

function sealedFiles() {
  return git(["ls-files", "-z", "--", ...SEALED_PATHS]).toString("utf8").split("\0").filter(Boolean);
}

test("a checkout with core.autocrlf=true writes the committed bytes of every Bridge file and the lockfile", () => {
  const files = sealedFiles();
  assert.ok(files.includes("desktop/pnpm-lock.yaml"), "the lockfile must be tracked");
  assert.ok(files.includes("desktop/connector/extension/manifest.json"), "the Bridge manifest must be tracked");
  const rewritten = files.filter((path) => {
    const committed = git(["cat-file", "blob", `:${path}`]);
    const checkedOut = git(["-c", "core.autocrlf=true", "cat-file", "--filters", `:${path}`]);
    return !committed.equals(checkedOut);
  });
  assert.deepEqual(rewritten, []);
});

test("this checkout has no Windows line endings in a Bridge file or the lockfile committed with Unix ones", () => {
  const rewritten = git(["ls-files", "--eol", "--", ...SEALED_PATHS]).toString("utf8").split("\n")
    .filter((line) => /^i\/lf\s+w\/crlf\s/.test(line))
    .map((line) => line.split("\t").at(-1));
  assert.deepEqual(rewritten, []);
});
