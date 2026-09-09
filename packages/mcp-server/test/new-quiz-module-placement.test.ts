import { readFileSync } from "node:fs";
import { augmentBridgeInputSchema } from "@morrow/bridge-protocol";
import { sha256Json, type JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import {
  planNewQuizAssignmentGroupOrder, planNewQuizModuleMove, planNewQuizModulePlacement,
} from "../src/new-quiz-lifecycle.js";
import type { GatewayRuntime } from "../src/runtime.js";

const catalog = JSON.parse(readFileSync(new URL("../../../artifacts/canvas-api/canvas-api-catalog.json", import.meta.url), "utf8"));
const writeNames = new Set(["canvas_create_module_item", "canvas_update_module_item", "canvas_edit_assignment"]);
const sourceBindingId = "canvas:biology";
const QUIZ = { id: "77", course_id: "42", title: "Cell structure" };
/** Canvas reports the linked Assignment of a New Quiz with this exact flag. */
const ASSIGNMENT = { id: "77", course_id: "42", name: "Cell structure", is_quiz_lti_assignment: true, assignment_group_id: "5", position: 2 };
const MODULE = { id: "7", name: "Week one" };
const QUIZ_ITEM = { id: "555", module_id: "7", position: 2, type: "Assignment", content_id: 77, title: "Cell structure" };
const MODULE_ITEMS = [
  { id: "554", module_id: "7", position: 1, type: "Page", page_url: "cells" },
  QUIZ_ITEM,
];

type Overrides = {
  quiz?: JsonObject; assignment?: JsonObject; module?: JsonObject;
  moduleItems?: JsonObject[]; moduleItem?: JsonObject | null;
  targetModule?: JsonObject; targetModuleItems?: JsonObject[]; groupAssignments?: JsonObject[];
};

function fixture(overrides: Overrides = {}) {
  const plans: { tool: string; args: JsonObject }[] = [];
  const reads: { tool: string; args: JsonObject }[] = [];
  const tools = catalog.operations
    .filter((entry: { toolName: string }) => writeNames.has(entry.toolName))
    .map((entry: { toolName: string; inputSchema: JsonObject }) => ({
      publicName: entry.toolName, upstreamName: entry.toolName, upstreamId: "canvas-session",
      annotations: { readOnlyHint: false }, inputSchema: augmentBridgeInputSchema(entry.inputSchema),
    }));
  const runtime = {
    catalog: { tools },
    searchCatalog: ({ query }: { query: string }) => ({ tools: [{
      publicName: query, upstreamName: query, upstreamId: "canvas-session", annotations: { readOnlyHint: !writeNames.has(query) },
    }] }),
    capabilityGet: () => ({ descriptor: { route: { backend: "canvas-connector" } } }),
    callSourceOwned: async (tool: string, args: JsonObject) => {
      reads.push({ tool, args });
      const module = String(args.module_id ?? args.id ?? "");
      const data = tool === "canvas_get_single_course_courses" ? { id: "42", name: "Biology" }
        : tool === "canvas_get_new_quiz" ? overrides.quiz ?? QUIZ
          : tool === "canvas_get_single_assignment" ? overrides.assignment ?? ASSIGNMENT
            : tool === "canvas_show_module" ? (module === "9" ? overrides.targetModule ?? { id: "9", name: "Week two" } : overrides.module ?? MODULE)
              : tool === "canvas_list_module_items" ? (module === "9" ? overrides.targetModuleItems ?? [] : overrides.moduleItems ?? MODULE_ITEMS)
                : tool === "canvas_show_module_item" ? (overrides.moduleItem === undefined ? QUIZ_ITEM : overrides.moduleItem)
                  : tool === "canvas_list_assignments_assignment_groups" ? overrides.groupAssignments ?? [ASSIGNMENT, { id: "78", position: 1 }, { id: "79", position: 3 }]
                    : null;
      if (data === null) throw new Error(`unexpected read ${tool}`);
      return { structuredContent: { schema: "morrow.canvas-connector.result.v1", ok: true, commandKind: "invoke_read",
        result: { ok: true, sent: true, truncated: false, data } } };
    },
    resultPage: () => { throw new Error("unexpected artifact"); },
    planOperationWithCurrentEditPermission: async (tool: string, args: JsonObject) => {
      plans.push({ tool, args });
      return { content: [], structuredContent: { schema: "morrow.operation.v1", operationId: `op:${plans.length}`, effectState: "awaiting_approval" } };
    },
  } as unknown as GatewayRuntime;
  return { runtime, plans, reads };
}

function report(result: { structuredContent?: unknown }): JsonObject {
  return (result.structuredContent as JsonObject).new_quiz_lifecycle_plan as JsonObject;
}

describe("New Quiz module placement and ordering", () => {
  it("plans one Assignment module item bound to the New Quiz id", async () => {
    const { runtime, plans } = fixture({ moduleItems: [MODULE_ITEMS[0]!] });
    const result = await planNewQuizModulePlacement(runtime, { source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", module_id: "7", position: 2 });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      tool: "canvas_create_module_item",
      args: { course_id: "42", module_id: "7", module_item_type: "Assignment", module_item_content_id: "77", module_item_position: "2" },
    });
    expect(report(result)).toMatchObject({
      action: "module_placement", quiz: { id: "77", title: "Cell structure" },
      module: { id: "7", name: "Week one", item_count: 1 },
      before_module_items_sha256: sha256Json([MODULE_ITEMS[0]]),
    });
  });

  it("refuses a course object Canvas does not report as a New Quiz", async () => {
    const { runtime, plans } = fixture({ assignment: { ...ASSIGNMENT, is_quiz_lti_assignment: false } });
    const result = await planNewQuizModulePlacement(runtime, { source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", module_id: "7" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("does not report this Assignment as a New Quiz");
    expect(plans).toHaveLength(0);
  });

  it("refuses to add a New Quiz the module already holds", async () => {
    const { runtime, plans } = fixture();
    const result = await planNewQuizModulePlacement(runtime, { source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", module_id: "7" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("already in this module at position 2");
    expect(plans).toHaveLength(0);
  });

  it("refuses a position past the end of the module", async () => {
    const { runtime, plans } = fixture({ moduleItems: [MODULE_ITEMS[0]!] });
    const result = await planNewQuizModulePlacement(runtime, { source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", module_id: "7", position: 4 });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("position 4 is past its end");
    expect(plans).toHaveLength(0);
  });

  it("moves the module item it proved carries that exact New Quiz", async () => {
    const { runtime, plans } = fixture();
    const result = await planNewQuizModuleMove(runtime, { source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", module_id: "7", module_item_id: "555", position: 1 });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(plans[0]).toMatchObject({
      tool: "canvas_update_module_item",
      args: { course_id: "42", module_id: "7", id: "555", module_item_position: "1" },
    });
    expect(plans[0]!.args).not.toHaveProperty("module_item_module_id");
    expect(report(result)).toMatchObject({
      action: "module_move", target_module: null,
      target_module_item_sha256: sha256Json(QUIZ_ITEM), before_module_items_sha256: sha256Json(MODULE_ITEMS),
    });
  });

  it("moves the New Quiz into another module and freezes both item lists", async () => {
    const { runtime, plans } = fixture();
    const result = await planNewQuizModuleMove(runtime, { source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", module_id: "7", module_item_id: "555", target_module_id: "9", position: 1 });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(plans[0]!.args).toMatchObject({ module_item_module_id: "9", module_item_position: "1", id: "555" });
    expect(report(result)).toMatchObject({
      target_module: { id: "9", name: "Week two", item_count: 0 },
      before_target_module_items_sha256: sha256Json([]),
    });
  });

  it("refuses a Classic Quiz module item whose content id collides with the New Quiz id", async () => {
    const { runtime, plans } = fixture({ moduleItem: { id: "555", module_id: "7", position: 2, type: "Quiz", content_id: 77 } });
    const result = await planNewQuizModuleMove(runtime, { source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", module_id: "7", module_item_id: "555", position: 1 });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("is not the Assignment that carries the selected New Quiz");
    expect(plans).toHaveLength(0);
  });

  it("refuses a module item that carries a different assignment", async () => {
    const { runtime, plans } = fixture({ moduleItem: { id: "555", module_id: "7", position: 2, type: "Assignment", content_id: 99 } });
    const result = await planNewQuizModuleMove(runtime, { source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", module_id: "7", module_item_id: "555", position: 1 });
    expect(result.isError).toBe(true);
    expect(plans).toHaveLength(0);
  });

  it("refuses a module item that is absent from the complete current list", async () => {
    const { runtime, plans } = fixture({ moduleItems: [MODULE_ITEMS[0]!] });
    const result = await planNewQuizModuleMove(runtime, { source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", module_id: "7", module_item_id: "555", position: 1 });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("not in the complete current item list");
    expect(plans).toHaveLength(0);
  });

  it("refuses a target module that already holds the New Quiz", async () => {
    const { runtime, plans } = fixture({ targetModuleItems: [{ id: "901", module_id: "9", position: 1, type: "Assignment", content_id: "77" }] });
    const result = await planNewQuizModuleMove(runtime, { source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", module_id: "7", module_item_id: "555", target_module_id: "9" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("target module already holds this New Quiz");
    expect(plans).toHaveLength(0);
  });

  it("orders the New Quiz in its assignment group through the linked Assignment", async () => {
    const { runtime, plans } = fixture();
    const result = await planNewQuizAssignmentGroupOrder(runtime, { source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", position: 1 });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(plans[0]).toMatchObject({ tool: "canvas_edit_assignment", args: { course_id: "42", id: "77", assignment_position: "1" } });
    expect(report(result)).toMatchObject({
      action: "assignment_group_order", assignment_group: { id: "5", assignment_count: 3 },
      current_position: 2, requested_position: 1,
    });
  });

  it("refuses a group position past the end of the group", async () => {
    const { runtime, plans } = fixture();
    const result = await planNewQuizAssignmentGroupOrder(runtime, { source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", position: 4 });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("position 4 is past its end");
    expect(plans).toHaveLength(0);
  });

  it("refuses a New Quiz that is absent from its own assignment group list", async () => {
    const { runtime, plans } = fixture({ groupAssignments: [{ id: "78", position: 1 }] });
    const result = await planNewQuizAssignmentGroupOrder(runtime, { source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", position: 1 });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("not in the complete current assignment list");
    expect(plans).toHaveLength(0);
  });
});
