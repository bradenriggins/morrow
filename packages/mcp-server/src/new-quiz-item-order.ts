import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { isJsonObject, sha256Json, type JsonObject } from "@morrow/contracts";
import * as z from "zod/v4";
import { canvasReadResult } from "./canvas-read.js";
import type { GatewayRuntime } from "./runtime.js";

const UPDATE_TOOL = "canvas_update_quiz_item";
const LIST_TOOL = "canvas_list_quiz_items";
const READ_QUIZ_TOOL = "canvas_get_new_quiz";
const MAX_ITEMS = 5_000;
const canvasId = z.string().regex(/^[1-9][0-9]{0,18}$/);
const inputSchema = z.strictObject({
  source_binding_id: z.string().regex(/^[A-Za-z0-9_.:@-]{1,160}$/),
  course_id: canvasId,
  quiz_id: canvasId.describe("The Canvas assignment ID of the New Quiz."),
  ordered_item_ids: z.array(canvasId).min(1).max(MAX_ITEMS)
    .describe("Every saved New Quiz item ID exactly once, in the requested final order."),
});

export type NewQuizItemOrderInput = z.infer<typeof inputSchema>;
type OrderRuntime = Pick<GatewayRuntime, "searchCatalog" | "capabilityGet" | "callSourceOwned" | "resultPage">;

class OrderPlanError extends Error {}
function refuse(message: string): never { throw new OrderPlanError(message); }
function exactId(value: unknown): string {
  if (typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return "";
}

function savedOrder(value: unknown): string[] {
  if (!Array.isArray(value)) refuse("Canvas did not return the complete saved item list for this New Quiz.");
  if (value.length > MAX_ITEMS) refuse(`This New Quiz has more than ${MAX_ITEMS} items, so Morrow will not plan its order.`);
  const rows: { id: string; position: number }[] = [];
  const ids = new Set<string>();
  const positions = new Set<number>();
  for (const valueRow of value) {
    if (!isJsonObject(valueRow)) refuse("Canvas returned an invalid New Quiz item list.");
    const id = exactId(valueRow.id);
    if (valueRow.entry_type !== "Item") {
      refuse(`Canvas returned item ${id || "without an id"} with entry_type ${typeof valueRow.entry_type === "string" ? valueRow.entry_type : "unknown"}. Only Item entries support this position update, so Morrow planned nothing.`);
    }
    const position = typeof valueRow.position === "number" && Number.isSafeInteger(valueRow.position) && valueRow.position > 0
      ? valueRow.position
      : typeof valueRow.position === "string" && /^[1-9][0-9]{0,15}$/.test(valueRow.position)
        ? Number(valueRow.position) : 0;
    if (!id || !position || ids.has(id) || positions.has(position)) {
      refuse("Canvas returned New Quiz items without unique exact IDs and positions. Morrow planned nothing.");
    }
    ids.add(id);
    positions.add(position);
    rows.push({ id, position });
  }
  return rows.sort((left, right) => left.position - right.position).map((row) => row.id);
}

function exactPermutation(before: readonly string[], requested: readonly string[]): boolean {
  if (before.length !== requested.length || new Set(requested).size !== requested.length) return false;
  const ids = new Set(before);
  return requested.every((id) => ids.has(id));
}

export async function planNewQuizItemOrder(runtime: OrderRuntime, value: NewQuizItemOrderInput, callerSignal?: AbortSignal): Promise<CallToolResult> {
  try {
    const input = inputSchema.parse(value);
    const timeout = AbortSignal.timeout(60_000);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    let source: string | undefined;
    const tool = (name: string, readOnly: boolean): string => {
      const matches = runtime.searchCatalog({ query: name, limit: 100 }).tools.filter((candidate) => {
        const descriptor = runtime.capabilityGet(candidate.publicName).descriptor;
        return candidate.upstreamName === name && candidate.annotations?.readOnlyHint === readOnly
          && (!source || candidate.upstreamId === source) && isJsonObject(descriptor)
          && isJsonObject(descriptor.route) && descriptor.route.backend === "canvas-connector";
      });
      if (matches.length !== 1) refuse(`This Canvas connection does not provide one ${name} tool.`);
      source = matches[0]!.upstreamId;
      return matches[0]!.publicName;
    };
    const updateTool = tool(UPDATE_TOOL, false);
    const listTool = tool(LIST_TOOL, true);
    const quizTool = tool(READ_QUIZ_TOOL, true);
    const courseTool = tool("canvas_get_single_course_courses", true);
    const routing = { source_binding_id: input.source_binding_id };
    const target = { course_id: input.course_id, assignment_id: input.quiz_id };
    const read = async (name: string, args: JsonObject): Promise<unknown> => {
      signal.throwIfAborted();
      return canvasReadResult(runtime, await runtime.callSourceOwned(name, { ...args, _morrow: routing }, { signal })).data;
    };
    const [course, quiz, list] = await Promise.all([
      read(courseTool, { id: input.course_id }),
      read(quizTool, target),
      read(listTool, { ...target, morrow_max_pages: 50 }),
    ]);
    if (!isJsonObject(course) || exactId(course.id) !== input.course_id || typeof course.name !== "string" || !course.name.trim()) {
      refuse("Morrow could not confirm the selected course from a fresh Canvas read.");
    }
    if (!isJsonObject(quiz) || exactId(quiz.id) !== input.quiz_id
      || (quiz.course_id !== undefined && exactId(quiz.course_id) !== input.course_id)) {
      refuse("Morrow could not confirm this New Quiz in the selected course from a fresh Canvas read.");
    }
    const before = savedOrder(list);
    if (!exactPermutation(before, input.ordered_item_ids)) {
      refuse("ordered_item_ids must contain every item in the complete saved New Quiz list exactly once, with no other ID.");
    }
    const working = [...before];
    const operations: JsonObject[] = [];
    for (let index = 0; index < input.ordered_item_ids.length; index += 1) {
      const itemId = input.ordered_item_ids[index]!;
      if (working[index] === itemId) continue;
      const from = working.indexOf(itemId, index + 1);
      if (from < 0) refuse("The requested item order changed while Morrow was planning it.");
      const beforeDigest = sha256Json(working);
      working.splice(from, 1);
      working.splice(index, 0, itemId);
      const expected = [...working];
      operations.push({
        step: operations.length + 1,
        tool: updateTool,
        arguments: {
          ...target,
          item_id: itemId,
          item_position: index + 1,
          morrow_new_quiz_item_position_guard: {
            kind: "new_quiz_item_position",
            before_item_ids_sha256: beforeDigest,
            expected_item_ids: expected,
            expected_item_ids_sha256: sha256Json(expected),
          },
          _morrow: routing,
        },
        readback: {
          tool: listTool,
          ...target,
          expected_item_ids: expected,
          expected_item_ids_sha256: sha256Json(expected),
          complete_list_required: true,
        },
      });
    }
    const title = typeof quiz.title === "string" && quiz.title.trim() ? quiz.title.trim().slice(0, 300) : "New Quiz";
    const report: JsonObject = {
      schema: "morrow.new-quiz-item-order.plan.v1",
      status: operations.length ? "planned" : "unchanged",
      planned_at: new Date().toISOString(),
      course: { id: input.course_id, name: course.name.trim() },
      quiz: { id: input.quiz_id, title },
      before_item_ids: before,
      before_item_ids_sha256: sha256Json(before),
      expected_item_ids: input.ordered_item_ids,
      expected_item_ids_sha256: sha256Json(input.ordered_item_ids),
      operations,
      operation_count: operations.length,
      atomic: operations.length <= 1,
      warnings: operations.length > 1 ? [
        "These moves are separate Canvas requests. After each move, the complete saved list must match that step before the next move is reviewed.",
        "An uncertain result must not be sent again. Read the complete item list and reconcile the existing operation.",
      ] : [],
      limits: ["No New Quiz item move has been sent through Morrow on a live Canvas course."],
    };
    return {
      content: [{ type: "text", text: operations.length
        ? `Review ${operations.length} item ${operations.length === 1 ? "move" : "moves"} for ${title} (${course.name.trim()}). Each move requires a complete current-list check and complete readback. No Canvas change has been made or scheduled.`
        : `${title} already has this complete item order. No change was planned.` }],
      structuredContent: report,
    };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: `No item order change was planned. ${error instanceof OrderPlanError ? error.message : "Morrow could not validate the request or read the complete New Quiz item list."}` }],
      structuredContent: { schema: "morrow.problem.v1", code: "new_quiz_item_order_not_planned" },
    };
  }
}

export function registerNewQuizItemOrderTool(server: McpServer, runtime: GatewayRuntime): void {
  server.registerTool("morrow_plan_new_quiz_item_order", {
    title: "Plan New Quiz item order",
    description: "Read one complete New Quiz item list and plan a guarded sequence of position moves for an exact requested order. Each move requires the complete current list and complete post-write list. Planning sends and schedules no Canvas change.",
    inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input, context) => planNewQuizItemOrder(runtime, input, context.mcpReq.signal));
}
