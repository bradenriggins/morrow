import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("connector/extension/manifest.json", root), "utf8"));
const catalog = readFileSync(new URL("artifacts/canvas-api/canvas-api-catalog.json", root));
const extensionCatalog = readFileSync(new URL("connector/extension/generated/canvas-api-catalog.json", root));

function extensionId(publicKey) {
  const digest = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest().subarray(0, 16);
  return [...digest].flatMap((byte) => [byte >> 4, byte & 15]).map((nibble) => String.fromCharCode(97 + nibble)).join("");
}

test("Canvas connector package has a stable least-privilege identity and exact generated catalog", () => {
  assert.equal(extensionId(manifest.key), "abeloclekioohahgedmjcdbpllfjfhko");
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"]);
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
  assert.equal(manifest.permissions.includes("cookies"), false);
  assert.equal(manifest.permissions.includes("sidePanel"), false);
  assert.equal(manifest.host_permissions.includes("<all_urls>"), false);
  assert.equal("web_accessible_resources" in manifest, false);
  assert.deepEqual(catalog, extensionCatalog);
  const parsed = JSON.parse(catalog);
  assert.equal(parsed.counts.totalOperations, 1130);
  assert.equal(parsed.counts.newQuizzesOperations, 26);
  assert.equal(parsed.counts.itemBankOperations, 12);
  assert.match(parsed.catalogDigest, /^[0-9a-f]{64}$/);
});
