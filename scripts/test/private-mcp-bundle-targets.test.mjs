import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url);
const rootPath = fileURLToPath(root);
const builder = fileURLToPath(new URL("scripts/package-mcp-bundle.mjs", root));

test("desktop payload declares the two supported consumer installer targets", () => {
  const listed = JSON.parse(execFileSync(process.execPath, [builder, "--targets"], {
    cwd: rootPath,
    encoding: "utf8",
  }));

  assert.equal(listed.schema, "morrow.desktop-targets.v1");
  assert.deepEqual(listed.targets.map((target) => target.target), ["darwin-arm64", "win32-x64"]);
  assert.deepEqual(listed.targets.map((target) => target.installer), ["dmg", "nsis"]);
  for (const target of listed.targets) {
    assert.match(target.nodeArchive, /^node-v22\.23\.2-(darwin-arm64\.tar\.xz|win-x64\.zip)$/);
    assert.match(target.nodeSha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(listed.publicRelease, "unsigned_release_requires_native_verification");
});

test("desktop payload builder requires an explicit absolute destination before it can write", () => {
  const result = spawnSync(process.execPath, [builder, "--target", "darwin-arm64"], {
    cwd: rootPath,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Provide --prepare-desktop-payload or --output/);
});
