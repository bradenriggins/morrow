import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseGatewayConfig } from "../src/config.js";
import { GatewayRuntime } from "../src/runtime.js";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url));

describe("Morrow legacy read routing", () => {
  it("removes write operation identity while preserving independent read receipts", async () => {
    const config = parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      profile: "private-full",
      upstreams: [
        {
          id: "meridian",
          label: "Meridian fixture",
          kind: "mcp-stdio",
          command: process.execPath,
          args: [fixturePath],
          env: { FAKE_SOURCE: "meridian" },
          priority: 100,
          required: true,
          enabled: true,
        },
        {
          id: "morrow-legacy",
          label: "Morrow legacy fixture",
          kind: "mcp-stdio",
          command: process.execPath,
          args: [fixturePath],
          env: { FAKE_SOURCE: "morrow-legacy" },
          priority: 50,
          required: true,
          enabled: true,
        },
      ],
      operationJournal: { path: ":memory:" },
      maxCatalogTools: 20,
    });
    const runtime = await GatewayRuntime.connect(config, { journalPath: ":memory:" });
    try {
      const publicName = "morrow_legacy__canvas_page_get";
      const suppliedOperationId = "operation:must-not-bind-read";
      const first = await runtime.call(publicName, {
        course_id: "101",
        _morrow: {
          operation_id: suppliedOperationId,
          source_binding_id: "canvas:101",
        },
      });
      const second = await runtime.call(publicName, {
        course_id: "202",
        _morrow: {
          operation_id: suppliedOperationId,
          source_binding_id: "canvas:202",
        },
      });

      expect(first.isError).not.toBe(true);
      expect(second.isError).not.toBe(true);
      const recent = runtime.operationsRecent({
        source: "morrow-legacy",
        tool: publicName,
        limit: 10,
      });
      expect(recent.returned).toBe(2);
      const operations = recent.operations as Record<string, unknown>[];
      expect(operations.every((operation) => operation.readOnly === true)).toBe(true);
      expect(operations.every((operation) => operation.sourceOperationId === null)).toBe(true);
      expect(operations.every((operation) => operation.idempotencyKey === null)).toBe(true);
      expect(operations.every((operation) => (
        operation.requestDigest !== operation.forwardedRequestDigest
      ))).toBe(true);
    } finally {
      await runtime.close();
    }
  }, 20_000);
});
