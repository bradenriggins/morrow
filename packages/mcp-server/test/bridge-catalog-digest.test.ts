import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CanvasConnectorRuntime } from "../../canvas-connector-mcp/src/runtime.js";
import { bridgeCatalogDigestForTests } from "./fixtures/bridge-catalog-digest.js";

const runtimes: CanvasConnectorRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
});

describe("bridge catalog digest fixture", () => {
  it("matches the digest the connector requires in a Bridge hello", async () => {
    const root = resolve("../..");
    const runtime = await CanvasConnectorRuntime.start({
      statePath: ":memory:",
      catalogPath: resolve(root, "artifacts/canvas-api/canvas-api-catalog.json"),
      token: "bridge-catalog-digest-token-".repeat(3),
      port: 0,
      runtimeRevision: "1.0.0-rc.2",
      allowedExtensionIds: ["a".repeat(32)],
      approveExtensionId: async () => undefined,
    });
    runtimes.push(runtime);

    expect(bridgeCatalogDigestForTests(root)).toBe(runtime.catalogDigest);
  });
});
