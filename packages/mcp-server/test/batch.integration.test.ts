import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseGatewayConfig } from "../src/config.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-batch-upstream.mjs", import.meta.url));

function config() {
  return parseGatewayConfig({
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
    filters: { excludePrefixes: ["mindtap_", "connect_"], excludeNames: [] },
    operationJournal: { path: ":memory:" },
    maxCatalogTools: 50,
  });
}

describe("MorrowRuntime durable batches", () => {
  it("runs read-only children in bounded windows and never exposes stored arguments", async () => {
    const runtime = await MorrowRuntime.connect(config(), { statePath: ":memory:" });
    try {
      expect(runtime.gateway.catalog.tools.some((tool) => tool.publicName === "morrow_batch_create")).toBe(false);
      const created = runtime.batchCreate({
        name: "Read three courses",
        mode: "read_only",
        concurrency: 2,
        operations: [1, 2, 3].map((course) => ({
          childId: `course:${course}`,
          tool: "canvas_page_get",
          arguments: { course_id: String(course), privateMarker: `not-for-output-${course}` },
        })),
      });
      const batch = created.batch as { batchId: string; state: string };
      expect(batch.state).toBe("planned");

      const first = await runtime.batchRun({ batchId: batch.batchId, maxChildren: 2 });
      expect((first.batch as { state: string }).state).toBe("running");
      expect(first.processed).toBe(2);
      expect(first.remaining).toBe(1);

      const second = await runtime.batchRun({ batchId: batch.batchId, maxChildren: 2 });
      expect((second.batch as { state: string }).state).toBe("completed");
      expect(second.processed).toBe(1);
      expect(second.remaining).toBe(0);

      const detail = runtime.batchGet({ batchId: batch.batchId, limit: 10 });
      const children = detail.children as Record<string, unknown>[];
      expect(children).toHaveLength(3);
      expect(children.every((child) => !("arguments" in child))).toBe(true);
      expect(JSON.stringify(detail)).not.toContain("not-for-output");
      expect(runtime.batchesRecent({ state: "completed" }).returned).toBe(1);
      expect(runtime.batchHealth()).toMatchObject({ activeBatches: 0, inspectionRequiredBatches: 0 });
    } finally {
      await runtime.close();
    }
  }, 20_000);

  it("turns a multi-course write request into separately approved donor tasks", async () => {
    const runtime = await MorrowRuntime.connect(config(), { statePath: ":memory:" });
    try {
      const created = runtime.batchCreate({
        name: "Stage two page edits",
        mode: "stage_writes",
        concurrency: 8,
        operations: [41, 42].map((course) => ({
          childId: `course:${course}`,
          tool: "edit_page",
          sourceBindingId: `canvas:${course}`,
          arguments: { course_id: String(course), title: `Course ${course}` },
        })),
      });
      const batch = created.batch as { batchId: string; concurrency: number };
      expect(batch.concurrency).toBe(4);
      expect(String(created.note)).toContain("separate human approval");

      const result = await runtime.batchRun({ batchId: batch.batchId, maxChildren: 10 });
      expect((result.batch as { state: string }).state).toBe("completed");
      const children = result.children as { state: string; sourceTaskId: string | null; sourceOperationId: string | null }[];
      expect(children.map((child) => child.state)).toEqual(["succeeded", "succeeded"]);
      expect(children.map((child) => child.sourceTaskId)).toEqual(["task-41", "task-42"]);
      expect(children.every((child) => String(child.sourceOperationId).startsWith("operation:"))).toBe(true);

      const operations = runtime.gateway.operationsRecent({ source: "morrow-legacy", limit: 10 });
      expect(operations.returned).toBe(2);
      expect((operations.operations as Record<string, unknown>[]).every((operation) => (
        operation.sourceResultState === "awaiting_confirmation"
        && String(operation.sourceTaskId).startsWith("task-")
      ))).toBe(true);
    } finally {
      await runtime.close();
    }
  }, 20_000);
});
