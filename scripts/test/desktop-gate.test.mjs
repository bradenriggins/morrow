import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const installerPackage = JSON.parse(readFileSync(join(root, "installer/package.json"), "utf8"));
const guard = join(root, "installer/test/require-dependencies.cjs");

function guardRoot(t, installed) {
  const directory = mkdtempSync(join(tmpdir(), "morrow-desktop-gate-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "test"));
  cpSync(guard, join(directory, "test/require-dependencies.cjs"));
  for (const name of installed) {
    mkdirSync(join(directory, "node_modules", name), { recursive: true });
    writeFileSync(join(directory, "node_modules", name, "package.json"), `{"name":"${name}"}\n`);
  }
  return spawnSync(process.execPath, [join(directory, "test/require-dependencies.cjs")], { encoding: "utf8" });
}

test("the authoritative gate runs the desktop installer suites and the update harness", () => {
  assert.match(rootPackage.scripts["test:desktop"], /^pnpm --dir installer --ignore-workspace test(?: |$)/);
  assert.match(rootPackage.scripts["test:desktop"], / && pnpm test:desktop:update$/);
  assert.equal(rootPackage.scripts["test:desktop:update"], "node --test scripts/test/desktop-update-harness.test.mjs");
  assert.match(rootPackage.scripts.test, /&& pnpm test:desktop/);
  assert.equal(rootPackage.scripts.check, "pnpm test");
  const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  assert.doesNotMatch(workspace, /installer/, "the installer pins its own Electron toolchain and stays outside the workspace");
});

test("the installer test script runs every installer suite file", () => {
  assert.match(installerPackage.scripts.test, /^node test\/require-dependencies\.cjs && /);
  const globs = installerPackage.scripts.test.match(/test\/\*\.test\.[a-z]+/g) ?? [];
  const covered = new Set(globs.map((glob) => glob.slice("test/*".length)));
  const suites = readdirSync(join(root, "installer/test")).filter((name) => /\.test\.[a-z]+$/.test(name));
  assert.ok(suites.length > 0, "installer/test must hold suite files");
  for (const suite of suites) {
    assert.ok(covered.has(suite.slice(suite.indexOf(".test."))), `installer/test/${suite} is outside the installer test globs`);
  }
});

test("a missing installer install reports the install command instead of a resolution stack", (t) => {
  const none = guardRoot(t, []);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /electron, electron-updater, @anthropic-ai\/mcpb/);
  assert.match(none.stderr, /pnpm --dir installer --ignore-workspace install/);
  assert.doesNotMatch(none.stderr, /Cannot find module|MODULE_NOT_FOUND/);

  const partial = guardRoot(t, ["electron"]);
  assert.equal(partial.status, 1);
  assert.match(partial.stderr, /electron-updater, @anthropic-ai\/mcpb/);
  assert.doesNotMatch(partial.stderr, /: electron,/);

  const complete = guardRoot(t, ["electron", "electron-updater", "@anthropic-ai/mcpb"]);
  assert.equal(complete.status, 0, complete.stderr);
  assert.equal(complete.stderr, "");
});

test("continuous integration installs the installer dependencies and runs the desktop suites", () => {
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const commands = [...workflow.matchAll(/^\s+(?:- )?run: (.+)$/gm)].map((match) => match[1].trim());
  const install = commands.indexOf("pnpm --dir installer --ignore-workspace install --frozen-lockfile");
  const check = commands.indexOf("pnpm check");
  const desktop = commands.indexOf("pnpm test:desktop");
  assert.ok(install >= 0, "ci.yml must install the installer dependencies");
  assert.ok(check > install, "ci.yml must install the installer dependencies before pnpm check");
  assert.ok(desktop > check, "ci.yml must run the desktop suites");
});
