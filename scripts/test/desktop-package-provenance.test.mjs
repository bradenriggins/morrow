import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { assertPayloadSnapshot, captureBridgeRelease } from "../package-mcp-bundle.mjs";

const root = resolve(new URL("../../", import.meta.url).pathname);
const builder = resolve(root, "scripts/package-mcp-bundle.mjs");

function sealedInput(payload) {
  return {
    manifest: JSON.parse(readFileSync(join(payload, "app/package-input-manifest.json"), "utf8")),
    manifestBytes: readFileSync(join(payload, "app/package-input-manifest.json")),
    mcpRuntime: { bytes: readFileSync(join(payload, "app/mcp-runtime-manifest.json")) }
  };
}

test("desktop payload seals the actual gateway package, records its source provenance, and rejects a tampered sibling module", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-desktop-provenance-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const payload = join(directory, "payload");
  const receipt = JSON.parse(execFileSync(process.execPath, [builder, "--target", "darwin-arm64", "--prepare-desktop-payload", payload], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  }));
  const sealed = sealedInput(payload);
  const runtime = JSON.parse(sealed.mcpRuntime.bytes.toString("utf8"));
  assert.equal(runtime.package.name, "@morrow-lms/gateway");
  assert.equal(runtime.package.version, JSON.parse(readFileSync(join(payload, "app/packages/mcp-server/package.json"), "utf8")).version);
  assert.equal(receipt.source.mcpRuntimeManifestSha256, sealed.manifest.mcpRuntime.sha256);
  assert.deepEqual(sealed.manifest.source, { head: receipt.source.head, dirty: receipt.source.dirty, statusSha256: receipt.source.statusSha256 });
  assert.match(receipt.source.head, /^[0-9a-f]{40}$/);
  assert.equal(receipt.source.inputManifestSha256, createHash("sha256").update(sealed.manifestBytes).digest("hex"));
  assert.equal(receipt.source.inputManifestFileCount, sealed.manifest.files.length);
  assert.equal(receipt.source.reproducibleFrom, "app/package-input-manifest.json");
  assert.match(receipt.source.note, /dirty[\s\S]*inputManifestSha256/);
  for (const path of [
    "node_modules/postcss/node_modules/.bin/nanoid",
    "node_modules/cross-spawn/node_modules/.bin/node-which"
  ]) {
    assert.equal(existsSync(join(payload, "app", path)), false);
    assert.equal(sealed.manifest.files.some((file) => file.path === path), false);
  }
  assertPayloadSnapshot(payload, sealed);

  const sibling = join(payload, "app/packages/mcp-server/dist/config.js");
  chmodSync(sibling, 0o600);
  writeFileSync(sibling, `${readFileSync(sibling, "utf8")}\n// tampered\n`);
  assert.throws(() => assertPayloadSnapshot(payload, sealed), /sealed source snapshot|dependency file changed/);
});

test("Bridge package source refuses an extra unreviewed file", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-bridge-provenance-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bridge = join(directory, "extension");
  cpSync(join(root, "connector/extension"), bridge, { recursive: true, dereference: true });
  writeFileSync(join(bridge, "unreviewed.js"), "export const unexpected = true;\n");
  assert.throws(() => captureBridgeRelease(bridge), /audited allowlist/);
});
