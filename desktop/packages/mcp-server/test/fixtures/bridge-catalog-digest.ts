import { resolve } from "node:path";
import { loadCanvasApiCatalog } from "@morrow/canvas-api-catalog";
import {
  bridgeCatalogDigest,
  loadCanvasBrowserCatalog,
  loadMoodleBrowserCatalog,
} from "../../../canvas-connector-mcp/src/browser-catalog.js";

/**
 * The operational compatibility digest a Bridge hello must carry. The runtime
 * keeps raw catalog digests for provenance, while this identity ignores source
 * transport details and prose that cannot change execution.
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
  const canvas = loadCanvasApiCatalog(resolve(root, "artifacts/canvas-api/canvas-api-catalog.json"));
  const canvasBrowser = loadCanvasBrowserCatalog(resolve(root, "connector/extension/generated/canvas-browser-catalog.json"));
  const moodle = loadMoodleBrowserCatalog(resolve(root, "connector/extension/generated/moodle-browser-catalog.json"));
  return bridgeCatalogDigest(canvas, canvasBrowser, moodle);
}
