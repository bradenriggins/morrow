const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const builderRequire = createRequire(require.resolve("electron-builder"));
const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
const { loadAll } = appBuilderRequire("js-yaml");
const lock = Object.assign({}, ...loadAll(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8")));
const vulnerable = "http-cache-semantics@4.2.0";

function edges(value) {
  return Object.entries({ ...value.dependencies, ...value.optionalDependencies })
    .map(([name, version]) => `${name}@${typeof version === "object" ? version.version : version}`)
    .filter((key) => Object.hasOwn(lock.snapshots, key));
}

test("the cache advisory exception stays confined to its reviewed pinned build chain", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.devDependencies["electron-builder"], "26.15.3", "review exception on builder upgrade");
  const direct = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies };
  assert.ok(!["http-cache-semantics", "cacheable-request", "got", "@electron/get", "app-builder-lib"].some((name) => Object.hasOwn(direct, name)), "unreviewed direct dependency on the cache chain");
  const reviewedParents = [
    [vulnerable, /^cacheable-request@7\.0\.4$/u],
    ["cacheable-request@7.0.4", /^got@11\.8\.6$/u],
    ["got@11.8.6", /^@electron\/get@3\.1\.0(?:\(|$)/u],
  ];
  for (const [child, parentPattern] of reviewedParents) {
    const parents = Object.entries(lock.snapshots).filter(([, value]) => edges(value).includes(child)).map(([key]) => key);
    assert.ok(parents.length > 0, `remove the advisory exception when ${child} leaves the chain`);
    assert.ok(parents.every((parent) => parentPattern.test(parent)), `unreviewed path to ${child}: ${parents.join(", ")}`);
  }
  const getKeys = Object.keys(lock.snapshots).filter((key) => /^@electron\/get@3\.1\.0(?:\(|$)/u.test(key));
  for (const child of getKeys) {
    const parents = Object.entries(lock.snapshots).filter(([, value]) => edges(value).includes(child)).map(([key]) => key);
    assert.ok(parents.length > 0 && parents.every((parent) => /^app-builder-lib@26\.15\.3(?:\(|$)/u.test(parent)), "unreviewed downloader consumer");
  }
  assert.ok(Object.keys(lock.packages).filter((key) => key.startsWith("http-cache-semantics@")).every((key) => key === vulnerable), "review package-version change");

  const seen = new Set();
  const pending = edges(lock.importers["."]);
  while (pending.length) {
    const key = pending.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    pending.push(...edges(lock.snapshots[key]));
  }
  assert.ok(![...seen].some((key) => /^(?:http-cache-semantics|cacheable-request|got|app-builder-lib)@/u.test(key)), "reviewed chain must not enter application production dependencies");
  assert.doesNotMatch(readFileSync(path.join(root, "..", "pnpm-lock.yaml"), "utf8"), /http-cache-semantics/u);
  assert.doesNotMatch(readFileSync(path.join(root, "electron-builder.config.cjs"), "utf8"), /\b(?:electronDownload|electronDist|downloadOptions|cache)["']?\s*:/u, "review any custom download/cache configuration");
});
