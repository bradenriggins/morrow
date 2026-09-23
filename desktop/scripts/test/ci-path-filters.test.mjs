import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { OWNED_DIRECTORY, ROOT_FILE_READERS, pathFilters, productsFor } from "./lib/ci-path-filters.mjs";

/**
 * A root file a product reads runs that product's suites when it changes. CI runs this file on every
 * change (ci.yml `check-repository`), so a new root file fails here in the pull request that adds it.
 *
 * Failure mode pinned down (written before the fix; final sweep 2026-09-23): the filters named only
 * desktop/**, morrow-for-muse/** and .github/**. A pull request that changed only .gitattributes,
 * whose `* -text` Windows packaging needs, or only the LICENSE the Muse carve ships, skipped every
 * product suite, and the required check passed. The next Windows packaging or Muse carve failed.
 */
const repositoryRoot = new URL("../../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, repositoryRoot), "utf8");
const filters = pathFilters(read(".github/workflows/ci.yml"));

function rootFiles() {
  const listed = spawnSync("git", ["-C", fileURLToPath(repositoryRoot), "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout.split("\0").filter((path) => path && !OWNED_DIRECTORY.test(path)).sort();
}

test("each product's filter watches its own directory and the workflows", () => {
  assert.deepEqual(Object.keys(filters).sort(), ["desktop", "muse"]);
  for (const [name, directory] of [["desktop", "desktop/**"], ["muse", "morrow-for-muse/**"]]) {
    assert.ok(filters[name].includes(directory), `the ${name} filter must watch ${directory}`);
    assert.ok(filters[name].includes(".github/**"), `the ${name} filter must watch .github/**, because a workflow change can break any suite`);
  }
});

test("every tracked root file is listed with the product suites that read it", () => {
  assert.deepEqual(rootFiles(), Object.keys(ROOT_FILE_READERS).sort(),
    "add each new root file to ROOT_FILE_READERS in scripts/test/lib/ci-path-filters.mjs, with the products whose suites read it");
});

test("a change to a root file runs exactly the suites of the products that read it", () => {
  const wrong = Object.entries(ROOT_FILE_READERS).flatMap(([path, { products, why }]) => {
    const runs = productsFor(filters, path);
    return runs.join() === [...products].sort().join() ? [] : [`${path} runs [${runs.join(", ")}] but is read by [${products.join(", ")}]: ${why}`];
  });
  assert.deepEqual(wrong, [], "ci.yml's `changes` filters must match ROOT_FILE_READERS");
});

test("every root file the Muse carve ships is one the Muse filter watches", () => {
  const declared = /^REPO_FILES = \(([^)]*)\)$/m.exec(read("morrow-for-muse/scripts/carve.py"));
  assert.ok(declared, "morrow-for-muse/scripts/carve.py must declare REPO_FILES, the root files the carve ships");
  const shipped = [...declared[1].matchAll(/"([^"]+)"/g)].map(([, path]) => path);
  assert.ok(shipped.length > 0, "the carve ships the repository LICENSE, so REPO_FILES cannot be empty");
  const unwatched = shipped.filter((path) => !ROOT_FILE_READERS[path]?.products.includes("muse") || !productsFor(filters, path).includes("muse"));
  assert.deepEqual(unwatched, [], "a root file the carve ships must run the Muse suite when it changes");
});
