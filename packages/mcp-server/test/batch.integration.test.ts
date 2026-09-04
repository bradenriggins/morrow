import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
        label: "ExamplePlatform fixture",
        kind: "mcp-stdio",
        command: process.execPath,
        args: [fixturePath],
        env: { FAKE_SOURCE: "meridian" },
        priority: 100,
        required: true,
        enabled: true,
        outputPrivacy: {
          canvas_page_get: { allowedFields: ["source", "course_id"], dataClass: "course", maxRecords: 10, maxBytes: 10_000, freeText: "deny", learnerTokens: false, artifactInspection: "deny" },
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
          canvas_page_get: { allowedFields: ["source", "course_id"], dataClass: "course", maxRecords: 10, maxBytes: 10_000, freeText: "deny", learnerTokens: false, artifactInspection: "deny" },
          edit_page: { allowedFields: ["schema", "ok", "sourceToolName", "commandKind", "result", "approvalRequired", "taskId", "status", "operationId"], dataClass: "course", maxRecords: 20, maxBytes: 10_000, freeText: "deny", learnerTokens: false, artifactInspection: "deny" },
          morrow_legacy_task_get: { allowedFields: ["schema", "ok", "task", "taskId", "status", "outcome", "terminal", "verificationStatus", "resultCounts", "done", "unconfirmed", "failed", "rollbackFailed", "skipped", "undone", "notStarted", "sourceBindingId"], dataClass: "course", maxRecords: 20, maxBytes: 10_000, freeText: "deny", learnerTokens: false, artifactInspection: "deny" },
        },
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
      expect(runtime.gateway.catalog.tools.some((tool) => tool.publicName === "morrow_batch_reconcile")).toBe(false);
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
      expect(created.sourceSettlement).toMatchObject({ outcome: "not_applicable", total: 0 });

      const first = await runtime.batchRun({ batchId: batch.batchId, maxChildren: 2 });
      expect((first.batch as { state: string }).state).toBe("running");
      expect(first.processed).toBe(2);
      expect(first.remaining).toBe(1);

      const second = await runtime.batchRun({ batchId: batch.batchId, maxChildren: 2 });
      expect((second.batch as { state: string }).state).toBe("completed");
      expect(second.processed).toBe(1);
      expect(second.remaining).toBe(0);
      expect(second.providerOutcomeFinal).toBe(true);

      const detail = runtime.batchGet({ batchId: batch.batchId, limit: 10 });
      const children = detail.children as Record<string, unknown>[];
      expect(children).toHaveLength(3);
      expect(children.every((child) => !("arguments" in child))).toBe(true);
      expect(detail.sourceSettlements).toEqual([]);
      expect(JSON.stringify(detail)).not.toContain("not-for-output");
      expect(runtime.batchesRecent({ state: "completed" }).returned).toBe(1);
      expect(runtime.batchHealth()).toMatchObject({ activeBatches: 0, inspectionRequiredBatches: 0 });
    } finally {
      await runtime.close();
    }
  }, 20_000);

  it("stages multi-course writes, then reconciles approval and verified provider truth separately", async () => {
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
      expect(String(created.note)).toContain("source-task reconciliation");
      expect(created.sourceSettlement).toMatchObject({ outcome: "not_started", notStarted: 2 });

      const result = await runtime.batchRun({ batchId: batch.batchId, maxChildren: 10 });
      expect((result.batch as { state: string }).state).toBe("completed");
      expect(result.providerOutcomeFinal).toBe(false);
      expect(result.sourceSettlement).toMatchObject({
        outcome: "awaiting_approval",
        awaitingApproval: 2,
      });
      const children = result.children as { state: string; sourceTaskId: string | null; sourceOperationId: string | null }[];
      expect(children.map((child) => child.state)).toEqual(["succeeded", "succeeded"]);
      expect(children.map((child) => child.sourceTaskId)).toEqual(["task-41", "task-42"]);
      expect(children.every((child) => String(child.sourceOperationId).startsWith("operation:"))).toBe(true);

      const firstReconciliation = await runtime.batchReconcile({
        batchId: batch.batchId,
        maxChildren: 10,
      });
      expect(firstReconciliation.processed).toBe(2);
      expect(firstReconciliation.sourceSettlement).toMatchObject({
        outcome: "awaiting_approval",
        awaitingApproval: 2,
      });
      expect(firstReconciliation.providerOutcomeFinal).toBe(false);

      const secondReconciliation = await runtime.batchReconcile({
        batchId: batch.batchId,
        maxChildren: 10,
      });
      expect(secondReconciliation.processed).toBe(2);
      expect(secondReconciliation.sourceSettlement).toMatchObject({
        outcome: "succeeded",
        succeeded: 2,
        terminal: true,
      });
      expect(secondReconciliation.providerOutcomeFinal).toBe(true);

      const defaultTerminalRecheck = await runtime.batchReconcile({
        batchId: batch.batchId,
        maxChildren: 10,
      });
      expect(defaultTerminalRecheck.processed).toBe(0);
      const explicitTerminalRecheck = await runtime.batchReconcile({
        batchId: batch.batchId,
        maxChildren: 10,
        includeTerminal: true,
      });
      expect(explicitTerminalRecheck.processed).toBe(2);

      const detail = runtime.batchGet({ batchId: batch.batchId, limit: 10 });
      const sourceSettlements = detail.sourceSettlements as Record<string, unknown>[];
      expect(sourceSettlements).toHaveLength(2);
      expect(sourceSettlements.every((row) => row.state === "succeeded")).toBe(true);
      expect(JSON.stringify(detail)).not.toContain("Course 41");

      const stagingOperations = runtime.gateway.operationsRecent({
        source: "example-legacy",
        tool: "edit_page",
        limit: 10,
      });
      expect(stagingOperations.returned).toBe(2);
      expect((stagingOperations.operations as Record<string, unknown>[]).every((operation) => (
        operation.sourceResultState === "awaiting_confirmation"
        && String(operation.sourceTaskId).startsWith("task-")
      ))).toBe(true);
      const inspectionOperations = runtime.gateway.operationsRecent({
        source: "example-legacy",
        tool: "morrow_legacy_task_get",
        limit: 20,
      });
      expect(inspectionOperations.returned).toBe(6);
    } finally {
      await runtime.close();
    }
  }, 20_000);

  it("keeps effect-possible and unconfirmed source outcomes visible", async () => {
    const runtime = await MorrowRuntime.connect(config(), { statePath: ":memory:" });
    try {
      const created = runtime.batchCreate({
        name: "Source outcome distinctions",
        mode: "stage_writes",
        concurrency: 3,
        operations: [
          { childId: "effect", outcome: "failed-effect" },
          { childId: "no-effect", outcome: "failed-no-effect" },
          { childId: "unconfirmed", outcome: "unconfirmed" },
        ].map((entry, index) => ({
          childId: entry.childId,
          tool: "edit_page",
          sourceBindingId: `canvas:${index + 1}`,
          arguments: {
            course_id: String(index + 1),
            fixture_outcome: entry.outcome,
          },
        })),
      });
      const batch = created.batch as { batchId: string };
      await runtime.batchRun({ batchId: batch.batchId, maxChildren: 10 });
      const reconciled = await runtime.batchReconcile({ batchId: batch.batchId, maxChildren: 10 });
      expect(reconciled.sourceSettlement).toMatchObject({
        outcome: "inspection_required",
        failedEffectPossible: 1,
        failedNoEffect: 1,
        inspectionRequired: 1,
        requiresAttention: true,
      });
      expect(reconciled.providerOutcomeFinal).toBe(false);
      expect(reconciled.problems).toEqual([]);
    } finally {
      await runtime.close();
    }
  }, 20_000);

  it("restores staged source-task identity after a process restart without exposing arguments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-batch-restart-"));
    const statePath = join(directory, "morrow.sqlite3");
    const keyPath = join(directory, "batch.key");
    let batchId = "";

    const first = await MorrowRuntime.connect(config(), { statePath, batchKeyPath: keyPath });
    try {
      const created = first.batchCreate({
        name: "Restart source task",
        mode: "stage_writes",
        concurrency: 1,
        operations: [{
          childId: "course:700",
          tool: "edit_page",
          sourceBindingId: "canvas:700",
          arguments: { course_id: "700", title: "Never returned" },
        }],
      });
      batchId = (created.batch as { batchId: string }).batchId;
      await first.batchRun({ batchId, maxChildren: 1 });
    } finally {
      await first.close();
    }

    const second = await MorrowRuntime.connect(config(), { statePath, batchKeyPath: keyPath });
    try {
      const detail = second.batchGet({ batchId, limit: 10 });
      expect(detail.sourceSettlement).toMatchObject({
        outcome: "inspection_required",
        inspectionRequired: 1,
        requiresAttention: true,
      });
      expect(detail.sourceSettlements).toMatchObject([{
        childId: "course:700",
        sourceBindingId: "canvas:700",
        sourceTaskId: "task-700",
        state: "inspection_required",
      }]);
      expect(JSON.stringify(detail)).not.toContain("Never returned");
    } finally {
      await second.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
