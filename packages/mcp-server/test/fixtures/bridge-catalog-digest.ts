import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadCanvasApiCatalog } from "@morrow/canvas-api-catalog";

/**
 * The catalog digest a Bridge hello must carry: the Canvas API catalog digest,
 * the raw bytes of the Canvas browser catalog, then the raw bytes of the Moodle
 * browser catalog. This mirrors bridgeCatalogDigest in
 * packages/canvas-connector-mcp/src/browser-catalog.ts and the extension's own
 * computation in connector/extension/src/service-worker.js.
 *
 * Every test computes it here because a hello carrying any other value is
 * refused with close code 4403, and `once(socket, "message")` does not reject
 * on a close, so a test that misses a catalog waits for a message that never
 * arrives. Adding a catalog now breaks test/bridge-catalog-digest.test.ts
 * instead of hanging an integration test.
 *
 * @param root repository root, usually `resolve("../..")` from a package test.
 */
export function bridgeCatalogDigestForTests(root: string): string {
  const rawDigest = (relativePath: string): string => createHash("sha256")
    .update(readFileSync(resolve(root, relativePath)))
    .digest("hex");
  const canvas = loadCanvasApiCatalog(resolve(root, "artifacts/canvas-api/canvas-api-catalog.json"));
  const canvasBrowser = rawDigest("connector/extension/generated/canvas-browser-catalog.json");
  const moodle = rawDigest("connector/extension/generated/moodle-browser-catalog.json");
  return createHash("sha256").update(`${canvas.catalogDigest}\n${canvasBrowser}\n${moodle}`).digest("hex");
}
