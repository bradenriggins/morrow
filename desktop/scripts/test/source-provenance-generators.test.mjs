import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scripts = dirname(dirname(fileURLToPath(import.meta.url)));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

for (const layout of ["standalone", "monorepo"]) {
  test(`source provenance reads committed Desktop bytes in a ${layout} checkout`, () => {
    const repository = mkdtempSync(join(tmpdir(), "morrow-provenance-"));
    const desktop = layout === "monorepo" ? join(repository, "desktop") : repository;
    const git = (...args) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const put = (path, bytes) => {
      const target = join(desktop, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    };
    try {
      git("init", "-q");
      git("config", "user.name", "Provenance fixture");
      git("config", "user.email", "fixture@example.invalid");
      for (const name of ["create-source-origin-ledger.mjs", "create-source-rights-manifest.mjs"]) {
        put(`scripts/${name}`, readFileSync(join(scripts, name)));
      }
      put("ARCHITECTURE.md", "Desktop source v1\n");
      put("packages/mcp-server/src/example.ts", "export const value = 1;\n");
      put("packages/mcp-server/test/example.test.ts", "// fixture test\n");
      put("excluded.txt", "excluded source\n");
      put("config/source-origin-ledger.json", "{}\n");
      put("config/release-profiles.json", JSON.stringify({ profiles: { "public-canvas": { visibility: "public", include: ["*"], exclude: ["excluded.txt", "config/"] } } }));
      if (layout === "monorepo") {
        writeFileSync(join(repository, "ARCHITECTURE.md"), "Unrelated root source\n");
        mkdirSync(join(repository, "desktop-other"));
        writeFileSync(join(repository, "desktop-other/sibling.txt"), "Unrelated sibling\n");
      }
      git("add", ".");
      git("commit", "-qm", "Fixture original source");
      const firstCommit = git("rev-parse", "HEAD");
      put("ARCHITECTURE.md", "Desktop source v2\n");
      git("add", ".");
      git("commit", "-qm", "Fixture updated source");
      const candidateCommit = git("rev-parse", "HEAD");
      put("ARCHITECTURE.md", "Uncommitted bytes must not enter provenance\n");
      execFileSync(process.execPath, [join(desktop, "scripts/create-source-origin-ledger.mjs")], { cwd: repository });
      execFileSync(process.execPath, [join(desktop, "scripts/create-source-rights-manifest.mjs"), "--reviewer", "fixture-reviewer", "--authorization", "fixture authorization"], { cwd: repository });
      const checked = execFileSync(process.execPath, [join(scripts, "validate-source-rights.mjs"), "--root", desktop], { cwd: repository, encoding: "utf8" });
      assert.match(checked, /public-source-rights=ok/);
      const origin = JSON.parse(readFileSync(join(desktop, "config/source-origin-ledger.json")));
      const rights = JSON.parse(readFileSync(join(desktop, "config/source-rights.manifest.json")));
      assert.equal(origin.candidateCommit, candidateCommit);
      const architecture = origin.entries.find((entry) => entry.path === "ARCHITECTURE.md");
      assert.equal(architecture.sourceCommit, candidateCommit);
      assert.equal(architecture.beforeDigest, digest("Desktop source v1\n"));
      assert.equal(architecture.afterDigest, digest("Desktop source v2\n"));
      const source = origin.entries.find((entry) => entry.path === "packages/mcp-server/src/example.ts");
      assert.equal(source.sourceCommit, firstCommit);
      assert.deepEqual(source.testMapping, ["packages/mcp-server/test/example.test.ts"]);
      assert.equal(origin.entries.some((entry) => entry.path === "config/source-origin-ledger.json"), false);
      assert.equal(rights.files.find((entry) => entry.path === "ARCHITECTURE.md").sha256, architecture.afterDigest);
      assert.equal(rights.files.find((entry) => entry.path === source.path).disposition, "adapted_owned");
      assert.equal(rights.files.some((entry) => entry.path === "excluded.txt" || entry.path.startsWith("config/")), false);
      const tampered = structuredClone(rights);
      tampered.files.find((entry) => entry.path === "ARCHITECTURE.md").sha256 = "0".repeat(64);
      writeFileSync(join(desktop, "config/source-rights.manifest.json"), JSON.stringify(tampered));
      assert.throws(() => execFileSync(process.execPath, [join(scripts, "validate-source-rights.mjs"), "--root", desktop], { stdio: "pipe" }), /Command failed/);
      for (const entry of [...origin.entries, ...rights.files]) {
        assert.equal(entry.path.startsWith("desktop/"), false);
        assert.equal(entry.path.includes("sibling.txt"), false);
      }
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
}
