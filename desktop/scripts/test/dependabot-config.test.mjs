import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";

// Dependabot reads .github/dependabot.yml at the repository root, one level above the desktop
// product, and finds nothing to update in a directory that holds no manifest for its ecosystem.
const repositoryRoot = new URL("../../../", import.meta.url);
const config = readFileSync(new URL(".github/dependabot.yml", repositoryRoot), "utf8");

const updates = [...config.matchAll(/^ {2}- package-ecosystem: (\S+)\n {4}directory: (\S+)$/gm)]
  .map(([, ecosystem, directory]) => ({ ecosystem, directory }));

/** Whether `directory` holds a manifest Dependabot reads for `ecosystem`. */
function hasManifest(ecosystem, directory) {
  const folder = new URL(`.${directory === "/" ? "/" : `${directory}/`}`, repositoryRoot);
  if (!existsSync(folder)) return false;
  const files = readdirSync(folder);
  if (ecosystem === "npm") return files.includes("package.json") && files.some((file) => ["pnpm-lock.yaml", "package-lock.json"].includes(file));
  if (ecosystem === "pip") return files.some((file) => /^requirements.*\.txt$/.test(file) || file === "pyproject.toml");
  if (ecosystem === "github-actions") {
    const workflows = new URL(".github/workflows/", folder);
    return existsSync(workflows) && readdirSync(workflows).some((file) => /\.ya?ml$/.test(file));
  }
  return false;
}

test("every Dependabot entry names a directory that holds its ecosystem's manifest", () => {
  assert.ok(updates.length > 0, "dependabot.yml lists no updates");
  assert.equal(updates.length, [...config.matchAll(/package-ecosystem:/g)].length, "every entry is written in the checked shape");
  for (const { ecosystem, directory } of updates) {
    assert.ok(hasManifest(ecosystem, directory), `${ecosystem} ${directory} has no manifest Dependabot can read`);
  }
});

test("Dependabot covers every product's dependencies and the workflow actions", () => {
  assert.deepEqual(
    updates.map(({ ecosystem, directory }) => `${ecosystem} ${directory}`).sort(),
    ["github-actions /", "npm /desktop", "npm /desktop/installer", "pip /morrow-for-muse"],
  );
});
