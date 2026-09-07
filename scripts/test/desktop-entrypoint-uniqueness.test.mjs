import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The desktop app is `installer/`. Nothing at the repository root loads these files: the root
 * `package.json` has no `main` field, `installer/package.json` names its own `main.cjs`, and the
 * only page that loads a renderer is `installer/renderer/index.html`. A root `main.cjs` or
 * `preload.cjs` could not run in any case, because `./shared/contract.cjs` exists only under
 * `installer/`. A stale root copy is still readable and editable, so it is removed, not kept.
 */
const ROOT_ORPHANS = {
  "main.cjs": "installer/main.cjs",
  "preload.cjs": "installer/preload.cjs",
  "renderer.js": "installer/renderer/renderer.js",
};

/** Dependencies and git internals are not Morrow source at any depth. */
const SKIPPED_DIRECTORY_NAMES = new Set(["node_modules", ".git"]);

/** Build output and local run state, skipped only at the exact paths that hold them. */
const SKIPPED_PATHS = new Set(["artifacts", "output", ".morrow", join("installer", "dist")]);

/** An Electron main entrypoint for this app is a `main.cjs` that loads the installer contract. */
const ENTRYPOINT_REQUIRE = 'require("./shared/contract.cjs")';

function electronMainEntrypoints(base) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORY_NAMES.has(entry.name) || SKIPPED_PATHS.has(relative(base, absolute))) continue;
        walk(absolute);
      } else if (entry.name === "main.cjs" && readFileSync(absolute, "utf8").includes(ENTRYPOINT_REQUIRE)) {
        found.push(relative(base, absolute).split(sep).join("/"));
      }
    }
  };
  walk(base);
  return found.sort();
}

test("no desktop entrypoint sits at the repository root", () => {
  for (const [orphan, kept] of Object.entries(ROOT_ORPHANS)) {
    assert.equal(
      existsSync(join(root, orphan)),
      false,
      `${orphan} at the repository root is a stale copy of ${kept}. Nothing loads it, and it cannot run there. Delete it and change ${kept} instead.`,
    );
  }
});

test("exactly one Electron main entrypoint loads the installer contract", () => {
  assert.deepEqual(electronMainEntrypoints(root), ["installer/main.cjs"]);
  const installerPackage = JSON.parse(readFileSync(join(root, "installer/package.json"), "utf8"));
  assert.equal(installerPackage.main, "main.cjs", "installer/package.json must name the one entrypoint that remains");
});

test("the entrypoint search reads real files and skips dependencies and build output", (t) => {
  const base = mkdtempSync(join(tmpdir(), "morrow-desktop-entrypoints-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const plant = (relativePath, source) => {
    const file = join(base, ...relativePath.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
  };
  const entrypoint = `const { envelope } = ${ENTRYPOINT_REQUIRE};\n`;
  plant("installer/main.cjs", entrypoint);
  plant("main.cjs", entrypoint);
  plant("node_modules/electron/main.cjs", entrypoint);
  plant("installer/dist/mac/Morrow.app/main.cjs", entrypoint);
  plant("artifacts/candidates/morrow/main.cjs", entrypoint);
  plant("output/morrow-desktop-qa/main.cjs", entrypoint);
  plant(".morrow/main.cjs", entrypoint);
  plant("scripts/main.cjs", 'const { envelope } = require("./contract.cjs");\n');
  assert.deepEqual(electronMainEntrypoints(base), ["installer/main.cjs", "main.cjs"]);
});
