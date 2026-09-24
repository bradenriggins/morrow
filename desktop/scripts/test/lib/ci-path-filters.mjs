/**
 * Which product suites a change runs. CI runs a product's suites only when a changed path matches
 * that product's filter in the `changes` job of `.github/workflows/ci.yml`, and the pre-commit hook
 * (`desktop/.githooks/pre-commit`) runs the same suites. Read by `scripts/test/ci-path-filters.test.mjs`
 * and `scripts/test/pre-commit-hook.test.mjs`. This file is not a test: it lives in `lib/` and keeps
 * `.test.` out of its name, so `pnpm scripts:test` does not run it.
 */

/**
 * Every file the repository tracks outside `desktop/`, `morrow-for-muse/` and `.github/`, with the
 * products whose suites read it. A root file a product reads must be in that product's filter, or a
 * change to that file alone skips the suite that guards it and the required check still passes. A
 * file no product reads is checked by the repository text gates only.
 */
export const ROOT_FILE_READERS = Object.freeze({
  ".gitattributes": {
    products: ["desktop", "muse"],
    why: "it sets the bytes every checkout writes: Windows packaging reads the lockfile and each sealed Bridge file (desktop/scripts/test/checkout-line-endings.test.mjs), and the Muse carve ships the checked-out files",
  },
  ".gitignore": {
    products: ["muse"],
    why: "Morrow for Muse has no ignore file of its own, and morrow-for-muse/scripts/test_carve.py checks that its test scratch stays ignored",
  },
  LICENSE: {
    products: ["muse"],
    why: "the Muse carve ships it (REPO_FILES in morrow-for-muse/scripts/carve.py)",
  },
  "docs/versioning.md": {
    products: ["desktop"],
    why: "desktop/scripts/test/desktop-release-workflow.test.mjs checks its release steps against desktop-release.yml",
  },
  "README.md": { products: [], why: "only the repository text gates read it" },
  "SECURITY.md": { products: [], why: "only the repository text gates read it" },
  "docs/products.md": { products: [], why: "only the repository text gates read it" },
});

/** Paths the product directories and the workflows own; everything else tracked is a root file. */
export const OWNED_DIRECTORY = /^(?:desktop|morrow-for-muse|\.github)\//;

/**
 * The `changes` job's path filters, by name. Each pattern must be a file path or `<directory>/**`,
 * the two forms `filterMatches` reproduces exactly.
 */
export function pathFilters(workflow) {
  const start = workflow.indexOf("\n          filters: |\n");
  if (start === -1) throw new Error("ci.yml has no paths-filter `filters: |` block");
  const filters = {};
  let current = null;
  for (const line of workflow.slice(start).split("\n").slice(2)) {
    if (line.trim() === "") continue;
    const name = /^ {12}([a-z-]+):$/.exec(line);
    if (name) {
      current = filters[name[1]] = [];
      continue;
    }
    const pattern = /^ {14}- '([^'*]+(?:\/\*\*)?)'$/.exec(line);
    if (pattern && current) {
      current.push(pattern[1]);
      continue;
    }
    if (/^\s*#/.test(line)) continue;
    if (/^ {0,11}\S/.test(line)) break;
    throw new Error(`ci.yml filter line is neither a filter name nor a file or <directory>/** pattern: ${line}`);
  }
  return filters;
}

export function filterMatches(patterns, path) {
  return patterns.some((pattern) => (pattern.endsWith("/**") ? path.startsWith(pattern.slice(0, -2)) : path === pattern));
}

/** The names of the filters, and so of the products, whose suites a change to `path` runs. */
export function productsFor(filters, path) {
  return Object.keys(filters).filter((name) => filterMatches(filters[name], path));
}
