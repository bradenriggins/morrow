import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const bundler = readFileSync(new URL("scripts/package-mcp-bundle.mjs", root), "utf8");
// Dependabot reads its config at the repository root, one level above the desktop product.
const dependabot = readFileSync(new URL("../.github/dependabot.yml", root), "utf8");

/** The major Node release the packaged gateway runs on. */
const embeddedMajor = /^const NODE_VERSION = "(\d+)\.\d+\.\d+";$/m.exec(bundler)?.[1];

// The packages compile against @types/node and run on the embedded Node release. Types from a
// later major let tsc accept an API that release does not have, and it fails only at run time.
test("the Node type definitions are the major Node release the desktop payload embeds", () => {
  assert.ok(embeddedMajor, "package-mcp-bundle.mjs must name the Node release it embeds");
  const typesMajor = /^\^?(\d+)\.\d+\.\d+$/.exec(manifest.devDependencies["@types/node"])?.[1];
  assert.equal(typesMajor, embeddedMajor, `@types/node must be ^${embeddedMajor}.x to match the embedded Node ${embeddedMajor}`);
  assert.match(manifest.engines.node, new RegExp(`^>=${embeddedMajor}\\.`), "engines.node must start at the embedded major");
});

test("Dependabot does not propose a Node type definitions major past the embedded release", () => {
  assert.match(dependabot, /^ {6}- dependency-name: "@types\/node"\n {8}update-types: \["version-update:semver-major"\]$/m);
});
