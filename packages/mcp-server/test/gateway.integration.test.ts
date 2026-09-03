import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseGatewayConfig } from "../src/config.js";
import { GatewayRuntime } from "../src/runtime.js";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url));

describe("GatewayRuntime stdio federation", () => {
  it("merges, filters, aliases, and forwards through real MCP stdio clients", async () => {
    const config = parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      profile: "private-full",
      upstreams: [
        {
          id: "meridian",
          label: "ExamplePlatform fixture",
          kind: "mcp-stdio",
          command: process.execPath,
          args: [fixturePath],
          env: { FAKE_SOURCE: "meridian" },
          priority: 100,
          required: true,
          enabled: true,
        },
        {
          id: "example-legacy",
          label: "Morrow legacy fixture",
          kind: "mcp-stdio",
          command: process.execPath,
          args: [fixturePath],
          env: { FAKE_SOURCE: "example-legacy" },
          priority: 50,
          required: true,
          enabled: true,
        },
      ],
      filters: {
        excludePrefixes: ["mindtap_", "connect_"],
        excludeNames: [],
      },
      maxCatalogTools: 20,
    });

    const runtime = await GatewayRuntime.connect(config);
    try {
      const names = runtime.catalog.tools.map((tool) => tool.publicName);
      expect(names).toContain("canvas_page_get");
      expect(names).toContain("morrow_legacy__canvas_page_get");
      expect(names).toContain("meridian_only");
      expect(names).toContain("morrow_legacy_only");
      expect(names.some((name) => name.startsWith("mindtap_"))).toBe(false);
      expect(names.some((name) => name.startsWith("connect_"))).toBe(false);

      expect(runtime.catalog.collisions).toEqual([{
        requestedName: "canvas_page_get",
        retainedBy: "meridian",
        aliasedSource: "example-legacy",
        aliasedTo: "morrow_legacy__canvas_page_get",
      }]);

      const primary = await runtime.call("canvas_page_get", { course_id: "101" });
      expect(primary.structuredContent).toEqual({
        source: "meridian",
        course_id: "101",
      });
      expect(primary._meta).toMatchObject({
        "io.morrow/gateway": {
          publicToolName: "canvas_page_get",
          upstreamId: "meridian",
          upstreamToolName: "canvas_page_get",
          catalogDigest: runtime.catalog.digest,
        },
      });

      const alias = await runtime.call("morrow_legacy__canvas_page_get", { course_id: "202" });
      expect(alias.structuredContent).toEqual({
        source: "example-legacy",
        course_id: "202",
      });

      expect(runtime.health()).toMatchObject({
        ready: true,
        publicToolCount: 4,
        collisionCount: 1,
        excludedToolCount: 4,
        sources: [
          { id: "meridian", connected: true, toolCount: 4 },
          { id: "example-legacy", connected: true, toolCount: 4 },
        ],
      });
    } finally {
      await runtime.close();
    }
  }, 20_000);
});
