import { readFileSync } from "node:fs";
import { sha256Json, type JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { newQuizLifecycleWriteSchema } from "../../canvas-connector-mcp/src/server.js";
import { planNewQuizCreate, planNewQuizDelete } from "../src/new-quiz-lifecycle.js";
import type { GatewayRuntime } from "../src/runtime.js";

const catalog = JSON.parse(readFileSync(new URL("../../../artifacts/canvas-api/canvas-api-catalog.json", import.meta.url), "utf8"));
const writeNames = new Set(["canvas_create_new_quiz", "canvas_delete_new_quiz"]);
const sourceBindingId = "canvas:biology";
const safeAssignment = { id: "77", course_id: "42", name: "Cell structure", published: false,
  has_submitted_submissions: false, graded_submissions_exist: false };

function fixture(overrides: { quizzes?: JsonObject[]; quiz?: JsonObject; items?: JsonObject[]; assignment?: JsonObject } = {}) {
  const quizzes = overrides.quizzes ?? [{ id: "77", course_id: "42", title: "Cell structure" }];
  const quiz = overrides.quiz ?? quizzes.find((entry) => String(entry.id) === "77") ?? { id: "77", course_id: "42", title: "Cell structure" };
  const items = overrides.items ?? [{ id: "88", position: 1, entry_type: "Item", points_possible: 2 }];
  const assignment = overrides.assignment ?? safeAssignment;
  const plans: { tool: string; args: JsonObject }[] = [];
  const tools = catalog.operations.filter((entry: { toolName: string }) => writeNames.has(entry.toolName)).map((entry: { toolName: string; inputSchema: JsonObject }) => ({
    publicName: entry.toolName, upstreamName: entry.toolName, upstreamId: "canvas-session", annotations: { readOnlyHint: false },
    inputSchema: newQuizLifecycleWriteSchema(entry.inputSchema),
  }));
  const runtime = {
    catalog: { tools },
    searchCatalog: ({ query }: { query: string }) => ({ tools: [{
      publicName: query, upstreamName: query, upstreamId: "canvas-session", annotations: { readOnlyHint: !writeNames.has(query) },
    }] }),
    capabilityGet: () => ({ descriptor: { route: { backend: "canvas-connector" } } }),
    callSourceOwned: async (tool: string) => {
      const data = tool === "canvas_get_single_course_courses" ? { id: "42", name: "Biology" }
        : tool === "canvas_list_new_quizzes" ? quizzes
          : tool === "canvas_get_new_quiz" ? quiz
            : tool === "canvas_list_quiz_items" ? items
              : tool === "canvas_get_single_assignment" ? assignment : null;
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
  return { runtime, plans };
}

describe("New Quiz lifecycle planner", () => {
  it("sorts adjacent 18-digit ids without Number precision loss and permits an empty create payload", async () => {
    const ids = ["9007199254740993", "9007199254740992"];
    const { runtime, plans } = fixture({ quizzes: ids.map((id) => ({ id, course_id: "42", title: id })) });
    const result = await planNewQuizCreate(runtime, { source_binding_id: sourceBindingId, course_id: "42", quiz: {} });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(plans[0]!.args.morrow_new_quiz_lifecycle_guard).toEqual({
      kind: "create", before_quiz_ids: ["9007199254740992", "9007199254740993"],
      before_quiz_ids_sha256: sha256Json(["9007199254740992", "9007199254740993"]), payload_sha256: sha256Json({}),
    });
  });

  it("freezes the complete quiz, item, and linked Assignment records before deletion", async () => {
    const items = [{ id: "89", position: 2, entry_type: "Item", entry: { item_body: "Second" } },
      { id: "88", position: 1, entry_type: "Item", entry: { item_body: "First" } }];
    const { runtime, plans } = fixture({ items });
    const result = await planNewQuizDelete(runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77",
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.args.morrow_new_quiz_lifecycle_guard).toMatchObject({
      kind: "delete", quiz_id: "77", target_assignment_sha256: sha256Json(safeAssignment),
      target_items_sha256: sha256Json([items[1], items[0]]),
    });
  });

  it.each([
    { has_submitted_submissions: true, graded_submissions_exist: false },
    { has_submitted_submissions: false, graded_submissions_exist: true },
    { has_submitted_submissions: false, graded_submissions_exist: undefined },
  ])("refuses deletion unless Canvas explicitly confirms no submitted or graded work %#", async (studentWork) => {
    const { runtime, plans } = fixture({ assignment: { ...safeAssignment, ...studentWork } });
    const result = await planNewQuizDelete(runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77",
    });
    expect(result.isError).toBe(true);
    expect(plans).toEqual([]);
  });

  it("accepts long instructions within the provider-safe bound and refuses longer content", async () => {
    const { runtime, plans } = fixture({ quizzes: [] });
    expect((await planNewQuizCreate(runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz: { instructions: "x".repeat(100_000) },
    })).isError).not.toBe(true);
    expect(plans).toHaveLength(1);
    const refused = await planNewQuizCreate(runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz: { instructions: "x".repeat(100_001) },
    });
    expect(refused.isError).toBe(true);
  });
});
