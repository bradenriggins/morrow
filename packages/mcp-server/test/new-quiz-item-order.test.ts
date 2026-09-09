import { describe, expect, it } from "vitest";
import type { JsonObject } from "@morrow/contracts";
import { sha256Json } from "@morrow/contracts";
import { planNewQuizItemOrder } from "../src/new-quiz-item-order.js";
import type { GatewayRuntime } from "../src/runtime.js";

const sourceBindingId = "canvas:instructor";

function readResult(data: unknown): JsonObject {
  return { structuredContent: { schema: "morrow.canvas-connector.result.v1", ok: true,
    commandKind: "invoke_read", result: { ok: true, sent: true, truncated: false, data } } };
}

function fixture(rows: unknown = [
  { id: "11", position: 1, entry_type: "Item" },
  { id: "12", position: 2, entry_type: "Item" },
  { id: "13", position: 3, entry_type: "Item" },
]) {
  const calls: { tool: string; args: JsonObject }[] = [];
  const runtime = {
    searchCatalog: ({ query }: { query: string }) => ({ tools: [{ publicName: query, upstreamName: query,
      upstreamId: "canvas-session", annotations: { readOnlyHint: query !== "canvas_update_quiz_item" } }] }),
    capabilityGet: () => ({ descriptor: { route: { backend: "canvas-connector" } } }),
    callSourceOwned: async (tool: string, args: JsonObject) => {
      calls.push({ tool, args });
      if (tool === "canvas_get_single_course_courses") return readResult({ id: "42", name: "Biology" });
      if (tool === "canvas_get_new_quiz") return readResult({ id: "77", course_id: "42", title: "Cells" });
      if (tool === "canvas_list_quiz_items") return readResult(rows);
      throw new Error(`Unexpected tool ${tool}`);
    },
    resultPage: () => { throw new Error("Unexpected artifact"); },
  } as unknown as GatewayRuntime;
  return { runtime, calls };
}

describe("New Quiz item order planner", () => {
  it("plans guarded moves from complete-list state", async () => {
    const { runtime, calls } = fixture();
    const result = await planNewQuizItemOrder(runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", ordered_item_ids: ["13", "12", "11"],
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const report = result.structuredContent as JsonObject;
    expect(report).toMatchObject({ status: "planned", operation_count: 2, atomic: false,
      before_item_ids: ["11", "12", "13"], expected_item_ids: ["13", "12", "11"] });
    const operations = report.operations as JsonObject[];
    expect(operations.map((operation) => (operation.arguments as JsonObject).item_id)).toEqual(["13", "12"]);
    expect(operations[0]!.arguments).toMatchObject({ item_position: 1,
      morrow_new_quiz_item_position_guard: {
        kind: "new_quiz_item_position",
        before_item_ids_sha256: sha256Json(["11", "12", "13"]),
        expected_item_ids: ["13", "11", "12"],
        expected_item_ids_sha256: sha256Json(["13", "11", "12"]),
      } });
    expect(operations[1]!.arguments).toMatchObject({ item_position: 2,
      morrow_new_quiz_item_position_guard: {
        before_item_ids_sha256: sha256Json(["13", "11", "12"]),
        expected_item_ids: ["13", "12", "11"],
      } });
    expect(calls.some((call) => call.tool === "canvas_update_quiz_item")).toBe(false);
  });

  it("plans nothing for the current order", async () => {
    const { runtime } = fixture();
    const result = await planNewQuizItemOrder(runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", ordered_item_ids: ["11", "12", "13"],
    });
    expect(result.structuredContent).toMatchObject({ status: "unchanged", operation_count: 0, operations: [] });
  });

  it("refuses partial, foreign, duplicate, and invalid saved orders", async () => {
    for (const ordered_item_ids of [["11", "12"], ["11", "12", "99"], ["11", "11", "13"]]) {
      const { runtime } = fixture();
      const result = await planNewQuizItemOrder(runtime, {
        source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", ordered_item_ids,
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("every item");
    }
    const invalid = fixture([{ id: "11", position: 1, entry_type: "Item" }, { id: "12", position: 1, entry_type: "Item" }]);
    const result = await planNewQuizItemOrder(invalid.runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", ordered_item_ids: ["11", "12"],
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("unique exact IDs and positions");

    const stimulus = fixture([{ id: "11", position: 1, entry_type: "Stimulus" }, { id: "12", position: 2, entry_type: "Item" }]);
    const stimulusResult = await planNewQuizItemOrder(stimulus.runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", ordered_item_ids: ["12", "11"],
    });
    expect(stimulusResult.isError).toBe(true);
    expect(JSON.stringify(stimulusResult)).toContain("Only Item entries support this position update");
  });
});
