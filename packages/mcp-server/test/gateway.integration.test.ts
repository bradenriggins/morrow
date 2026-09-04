import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseGatewayConfig } from "../src/config.js";
import { GatewayRuntime } from "../src/runtime.js";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url));

describe("GatewayRuntime stdio federation", () => {
  it("merges, filters, aliases, journals, and forwards through real MCP stdio clients", async () => {
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
          outputPrivacy: {
            canvas_page_get: { allowedFields: ["source", "course_id"], dataClass: "course", maxRecords: 10, maxBytes: 2_000, freeText: "deny", learnerTokens: false, artifactInspection: "deny" },
            meridian_only: { allowedFields: ["source", "tool", "value", "operation_id"], dataClass: "course", maxRecords: 10, maxBytes: 2_000, freeText: "deny", learnerTokens: false, artifactInspection: "deny" },
          },
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
          outputPrivacy: {
            canvas_page_get: { allowedFields: ["source", "course_id"], dataClass: "course", maxRecords: 10, maxBytes: 2_000, freeText: "deny", learnerTokens: false, artifactInspection: "deny" },
            morrow_legacy_only: { allowedFields: ["source", "tool", "value", "operation_id"], dataClass: "course", maxRecords: 10, maxBytes: 2_000, freeText: "deny", learnerTokens: false, artifactInspection: "deny" },
          },
        },
      ],
      filters: {
        excludePrefixes: ["mindtap_", "connect_"],
        excludeNames: [],
      },
      operationJournal: { path: ":memory:" },
      maxCatalogTools: 20,
    });

    const runtime = await GatewayRuntime.connect(config, { journalPath: ":memory:" });
    try {
      const names = runtime.catalog.tools.map((tool) => tool.publicName);
      expect(names).toContain("canvas_page_get");
      expect(names).toContain("morrow_legacy__canvas_page_get");
      expect(names).toContain("meridian_only");
      expect(names).toContain("morrow_legacy_only");
      expect(names.some((name) => name.startsWith("mindtap_"))).toBe(false);
      expect(names.some((name) => name.startsWith("connect_"))).toBe(false);
      expect(runtime.catalog.tools.every((tool) => !("meta" in tool))).toBe(true);

      expect(runtime.catalog.collisions).toEqual([{
        requestedName: "canvas_page_get",
        retainedBy: "meridian",
        aliasedSource: "example-legacy",
        aliasedTo: "morrow_legacy__canvas_page_get",
      }]);

      const primary = await runtime.call("canvas_page_get", { course_id: "101" });
      expect(primary.structuredContent).toMatchObject({
        schema: "morrow.result.v1",
        phase: "read",
        verification: { status: "not_applicable" },
        data: { source: "meridian", course_id: "101" },
      });
      expect(primary._meta).toEqual({
        "io.morrow/gateway": expect.objectContaining({
          publicToolName: "canvas_page_get",
          upstreamId: "meridian",
          upstreamToolName: "canvas_page_get",
          catalogDigest: runtime.catalog.digest,
          gatewayOperationId: expect.stringMatching(/^gop:/),
          gatewayOperationState: "response_received",
        }),
      });

      const alias = await runtime.call("morrow_legacy__canvas_page_get", { course_id: "202" });
      expect(alias.structuredContent).toMatchObject({
        schema: "morrow.result.v1",
        data: { source: "example-legacy", course_id: "202" },
      });

      const firstDedupe = await runtime.call("morrow_legacy_only", {
        value: "write-once",
        _morrow: {
          operation_id: "operation:dedupe-1234",
          readback: {
            tool: "canvas_page_get",
            arguments: { course_id: "101" },
            expected_digest: "a".repeat(64),
          },
        },
      });
      expect(firstDedupe.isError).not.toBe(true);
      expect(firstDedupe.structuredContent).toMatchObject({
        schema: "morrow.result.v1",
        phase: "planned",
        effectState: "awaiting_approval",
      });
      const replay = await runtime.call("morrow_legacy_only", {
        value: "write-once",
        _morrow: {
          operation_id: "operation:dedupe-1234",
          readback: {
            tool: "canvas_page_get",
            arguments: { course_id: "101" },
            expected_digest: "a".repeat(64),
          },
        },
      });
      expect(replay.isError).not.toBe(true);
      expect(replay.structuredContent).toMatchObject({
        schema: "morrow.result.v1",
        operationId: (firstDedupe.structuredContent as { operationId: string }).operationId,
      });

      const recent = runtime.operationsRecent({ limit: 10 });
      expect(recent.returned).toBe(2);
      const operations = recent.operations as { operationId: string; state: string }[];
      expect(operations.every((operation) => operation.state === "response_received")).toBe(true);
      expect(runtime.operationGet(operations[0]!.operationId)).toMatchObject({
        schema: "morrow.gateway-operation.v1",
        terminal: true,
      });

      const search = runtime.searchCatalog({ query: "canvas", limit: 1 });
      expect(search.returned).toBe(1);
      expect(search.nextOffset).toBe(1);
      expect(search.tools[0]).toMatchObject({
        publicName: "canvas_page_get",
        upstreamId: "meridian",
        inputSchemaSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(search.tools[0]).not.toHaveProperty("inputSchema");

      expect(runtime.health()).toMatchObject({
        ready: true,
        publicToolCount: 4,
        collisionCount: 1,
        excludedToolCount: 4,
        operationJournal: {
          totalOperations: 2,
          unresolvedOperations: 0,
          unknownOperations: 0,
        },
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
