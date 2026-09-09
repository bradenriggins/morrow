import { fromJsonSchema, type CallToolResult, type McpServer } from "@modelcontextprotocol/server";
import { isJsonObject, sha256Json, type JsonObject } from "@morrow/contracts";
import * as z from "zod/v4";
import { canvasReadResult } from "./canvas-read.js";
import {
  newQuizSettingArguments,
  validateNewQuizSettingDependencies,
  validateRequestedNewQuizSettings,
} from "./new-quiz-settings.js";
import type { CatalogSearchTool, GatewayRuntime } from "./runtime.js";

const CREATE_TOOL = "canvas_create_new_quiz";
const DELETE_TOOL = "canvas_delete_new_quiz";
const GET_TOOL = "canvas_get_new_quiz";
const LIST_TOOL = "canvas_list_new_quizzes";
const LIST_ITEMS_TOOL = "canvas_list_quiz_items";
const ASSIGNMENT_TOOL = "canvas_get_single_assignment";
const COURSE_TOOL = "canvas_get_single_course_courses";
const MODULE_TOOL = "canvas_show_module";
const MODULE_ITEMS_TOOL = "canvas_list_module_items";
const MODULE_ITEM_TOOL = "canvas_show_module_item";
const CREATE_MODULE_ITEM_TOOL = "canvas_create_module_item";
const UPDATE_MODULE_ITEM_TOOL = "canvas_update_module_item";
const EDIT_ASSIGNMENT_TOOL = "canvas_edit_assignment";
const GROUP_ASSIGNMENTS_TOOL = "canvas_list_assignments_assignment_groups";
const MAX_QUIZZES = 10_000;
const MAX_MODULE_ITEMS = 5_000;

const id = z.string().regex(/^[1-9][0-9]{0,18}$/);
const binding = z.string().regex(/^[A-Za-z0-9_.:@-]{1,160}$/);
const createInputSchema = z.strictObject({
  source_binding_id: binding,
  course_id: id,
  quiz: z.record(z.string(), z.unknown()).refine((value) => JSON.stringify(value).length <= 128 * 1024),
});
const deleteInputSchema = z.strictObject({
  source_binding_id: binding,
  course_id: id,
  quiz_id: id.describe("The Canvas assignment ID of the New Quiz."),
});
const position = z.number().int().min(1).max(10_000);
const placementInputSchema = z.strictObject({
  source_binding_id: binding,
  course_id: id,
  quiz_id: id.describe("The Canvas assignment ID of the New Quiz."),
  module_id: id,
  position: position.optional().describe("Where the New Quiz goes in the module. Canvas appends it when this is omitted."),
});
const moveInputSchema = z.strictObject({
  source_binding_id: binding,
  course_id: id,
  quiz_id: id.describe("The Canvas assignment ID of the New Quiz."),
  module_id: id.describe("The module the New Quiz is in now."),
  module_item_id: id,
  position: position.optional(),
  target_module_id: id.optional().describe("Another module in the same course to move the New Quiz into."),
}).refine((value) => value.position !== undefined || value.target_module_id !== undefined,
  "Name a new position, a target module, or both.");
const groupOrderInputSchema = z.strictObject({
  source_binding_id: binding,
  course_id: id,
  quiz_id: id.describe("The Canvas assignment ID of the New Quiz."),
  position,
});

type LifecycleRuntime = Pick<GatewayRuntime,
  "catalog" | "searchCatalog" | "capabilityGet" | "callSourceOwned" | "resultPage" | "planOperationWithCurrentEditPermission">;

class LifecycleError extends Error {}
function refuse(message: string): never { throw new LifecycleError(message); }

function exactId(value: unknown): string {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) ? value
    : typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : "";
}

function quizIds(data: unknown): readonly string[] {
  if (!Array.isArray(data) || data.length > MAX_QUIZZES) refuse("Canvas did not return one complete bounded New Quiz list.");
  const values = data.map((row) => isJsonObject(row) ? exactId(row.id) : "");
  if (values.some((value) => !value) || new Set(values).size !== values.length) {
    refuse("Canvas returned a New Quiz list with a missing or repeated id.");
  }
  return [...values].sort((left, right) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0));
}

const TOP_LEVEL = Object.freeze(new Set([
  "title", "assignment_group_id", "points_possible", "due_at", "lock_at", "unlock_at",
  "grading_type", "instructions", "quiz_settings",
]));

function dateTime(value: unknown, path: string): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || Number.isNaN(Date.parse(value))) refuse(`${path} must be a Canvas date and time.`);
}

function createArguments(courseId: string, quiz: JsonObject): JsonObject {
  for (const key of Object.keys(quiz)) if (!TOP_LEVEL.has(key)) refuse(`${key} is not a supported New Quiz create field.`);
  if (Object.hasOwn(quiz, "title") && (typeof quiz.title !== "string" || quiz.title.length > 4_000)) refuse("title must be text of at most 4000 characters.");
  if (Object.hasOwn(quiz, "instructions") && (typeof quiz.instructions !== "string" || quiz.instructions.length > 100_000)) refuse("instructions must be text of at most 100000 characters.");
  if (Object.hasOwn(quiz, "assignment_group_id") && !exactId(quiz.assignment_group_id)) refuse("assignment_group_id must be a positive Canvas id.");
  if (Object.hasOwn(quiz, "points_possible") && (typeof quiz.points_possible !== "number" || !Number.isFinite(quiz.points_possible) || quiz.points_possible <= 0)) refuse("points_possible must be greater than 0.");
  if (Object.hasOwn(quiz, "grading_type") && !["pass_fail", "percent", "letter_grade", "gpa_scale", "points"].includes(String(quiz.grading_type))) refuse("grading_type is not supported by New Quizzes.");
  for (const key of ["due_at", "lock_at", "unlock_at"]) if (Object.hasOwn(quiz, key)) dateTime(quiz[key], key);
  if (typeof quiz.unlock_at === "string" && typeof quiz.lock_at === "string" && Date.parse(quiz.lock_at) <= Date.parse(quiz.unlock_at)) refuse("lock_at must be later than unlock_at.");
  if (typeof quiz.due_at === "string" && typeof quiz.lock_at === "string" && Date.parse(quiz.due_at) > Date.parse(quiz.lock_at)) refuse("due_at must not be later than lock_at.");
  const settings = quiz.quiz_settings;
  if (settings !== undefined) {
    if (!isJsonObject(settings) || Object.keys(settings).length === 0) refuse("quiz_settings must contain at least one setting.");
    validateRequestedNewQuizSettings(settings);
    validateNewQuizSettingDependencies(settings, settings);
  }
  const args: JsonObject = { course_id: courseId };
  const mapping: Readonly<Record<string, string>> = {
    title: "quiz_title", assignment_group_id: "quiz_assignment_group_id", points_possible: "quiz_points_possible",
    due_at: "quiz_due_at", lock_at: "quiz_lock_at", unlock_at: "quiz_unlock_at",
    grading_type: "quiz_grading_type", instructions: "quiz_instructions",
  };
  for (const [field, argument] of Object.entries(mapping)) if (Object.hasOwn(quiz, field)) args[argument] = quiz[field];
  if (isJsonObject(settings)) Object.assign(args, newQuizSettingArguments(settings));
  return args;
}

function problem(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `No New Quiz lifecycle change was planned. ${error instanceof LifecycleError ? error.message : "Morrow could not read or validate this Canvas target."}` }],
    structuredContent: { schema: "morrow.problem.v1", code: "new_quiz_lifecycle_not_planned" },
  };
}

function tools(runtime: LifecycleRuntime, sourceBindingId: string) {
  let source: string | undefined;
  const find = (name: string, readOnly: boolean): CatalogSearchTool => {
    const matches = runtime.searchCatalog({ query: name, limit: 100 }).tools.filter((candidate) => {
      const descriptor = runtime.capabilityGet(candidate.publicName).descriptor;
      return candidate.upstreamName === name && candidate.annotations?.readOnlyHint === readOnly
        && (!source || candidate.upstreamId === source) && isJsonObject(descriptor)
        && isJsonObject(descriptor.route) && descriptor.route.backend === "canvas-connector";
    });
    if (matches.length !== 1) refuse(`This Canvas connection does not provide one ${name} tool.`);
    source = matches[0]!.upstreamId;
    return matches[0]!;
  };
  const routing = { source_binding_id: sourceBindingId };
  const read = async (tool: CatalogSearchTool, args: JsonObject, signal: AbortSignal): Promise<unknown> => {
    signal.throwIfAborted();
    return canvasReadResult(runtime, await runtime.callSourceOwned(tool.publicName, { ...args, _morrow: routing }, { signal })).data;
  };
  return { find, read, routing };
}

export async function planNewQuizCreate(runtime: LifecycleRuntime, value: z.infer<typeof createInputSchema>, callerSignal?: AbortSignal): Promise<CallToolResult> {
  try {
    const input = createInputSchema.parse(value);
    const quiz = structuredClone(input.quiz);
    const args = createArguments(input.course_id, quiz);
    const timeout = AbortSignal.timeout(60_000);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    const context = tools(runtime, input.source_binding_id);
    const write = context.find(CREATE_TOOL, false);
    const list = context.find(LIST_TOOL, true);
    const get = context.find(GET_TOOL, true);
    const courseRead = context.find(COURSE_TOOL, true);
    const [course, current] = await Promise.all([
      context.read(courseRead, { id: input.course_id }, signal),
      context.read(list, { course_id: input.course_id }, signal),
    ]);
    if (!isJsonObject(course) || exactId(course.id) !== input.course_id || typeof course.name !== "string" || !course.name.trim()) refuse("Morrow could not confirm the selected Canvas course.");
    const before = quizIds(current);
    args.morrow_new_quiz_lifecycle_guard = {
      kind: "create", before_quiz_ids: before, before_quiz_ids_sha256: sha256Json(before), payload_sha256: sha256Json(quiz),
    };
    args._morrow = context.routing;
    const schema = runtime.catalog.tools.find((candidate) => candidate.publicName === write.publicName)?.inputSchema;
    if (!schema || (await fromJsonSchema(schema)["~standard"].validate(args)).issues) refuse("The connected Canvas route does not accept this reviewed New Quiz create.");
    const planned = await runtime.planOperationWithCurrentEditPermission(write.publicName, args);
    if (planned.isError === true) return planned as CallToolResult;
    const report: JsonObject = {
      schema: "morrow.new-quiz-lifecycle.plan.v1", action: "create", status: "planned", planned_at: new Date().toISOString(),
      course: { id: input.course_id, name: course.name.trim() }, requested_quiz: quiz,
      before_quiz_ids_sha256: sha256Json(before), operation_count: 1,
      operations: [{ step: 1, tool: write.publicName, arguments: args,
        readback: { tool: get.publicName, course_id: input.course_id, assignment_id: "<created id>", expected_quiz: quiz } }],
      limits: ["Canvas assigns the New Quiz id. Morrow verifies one added id and every requested saved field before it reports completion."],
    };
    return { ...planned, content: [{ type: "text", text: `Review one New Quiz create in ${course.name.trim()}. Morrow froze the complete current quiz membership and every requested field. No Canvas change has been made or scheduled.` }], structuredContent: isJsonObject(planned.structuredContent) ? { ...planned.structuredContent, new_quiz_lifecycle_plan: report } : report } as CallToolResult;
  } catch (error) { return problem(error); }
}

export async function planNewQuizDelete(runtime: LifecycleRuntime, value: z.infer<typeof deleteInputSchema>, callerSignal?: AbortSignal): Promise<CallToolResult> {
  try {
    const input = deleteInputSchema.parse(value);
    const timeout = AbortSignal.timeout(60_000);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    const context = tools(runtime, input.source_binding_id);
    const write = context.find(DELETE_TOOL, false);
    const list = context.find(LIST_TOOL, true);
    const get = context.find(GET_TOOL, true);
    const listItems = context.find(LIST_ITEMS_TOOL, true);
    const courseRead = context.find(COURSE_TOOL, true);
    const assignmentRead = context.find(ASSIGNMENT_TOOL, true);
    const target = { course_id: input.course_id, assignment_id: input.quiz_id };
    const [course, current, quiz, items, assignment] = await Promise.all([
      context.read(courseRead, { id: input.course_id }, signal), context.read(list, { course_id: input.course_id }, signal),
      context.read(get, target, signal), context.read(listItems, target, signal),
      context.read(assignmentRead, { course_id: input.course_id, id: input.quiz_id }, signal),
    ]);
    if (!isJsonObject(course) || exactId(course.id) !== input.course_id || typeof course.name !== "string" || !course.name.trim()) refuse("Morrow could not confirm the selected Canvas course.");
    const before = quizIds(current);
    if (!before.includes(input.quiz_id) || !isJsonObject(quiz) || exactId(quiz.id) !== input.quiz_id
      || (quiz.course_id !== undefined && exactId(quiz.course_id) !== input.course_id)) refuse("The selected New Quiz is not present in the complete current course quiz list.");
    if (!isJsonObject(assignment) || exactId(assignment.id) !== input.quiz_id
      || (assignment.course_id !== undefined && exactId(assignment.course_id) !== input.course_id)) {
      refuse("Morrow could not confirm the linked Canvas Assignment.");
    }
    if (assignment.has_submitted_submissions !== false || assignment.graded_submissions_exist !== false) {
      refuse("Morrow deletes a New Quiz only when Canvas confirms that its linked Assignment has no submitted or graded student work.");
    }
    if (!Array.isArray(items)) refuse("Canvas did not return the complete item list before this destructive change.");
    const itemSnapshot = items.map((row) => {
      if (!isJsonObject(row) || !exactId(row.id)) refuse("Canvas returned an item with no exact id.");
      return structuredClone(row);
    }).sort((left, right) => Number(left.position) - Number(right.position));
    const args: JsonObject = { ...target, morrow_new_quiz_lifecycle_guard: {
      kind: "delete", before_quiz_ids: before, before_quiz_ids_sha256: sha256Json(before), target_quiz_sha256: sha256Json(quiz),
      target_items_sha256: sha256Json(itemSnapshot), target_assignment_sha256: sha256Json(assignment), quiz_id: input.quiz_id,
    }, _morrow: context.routing };
    const schema = runtime.catalog.tools.find((candidate) => candidate.publicName === write.publicName)?.inputSchema;
    if (!schema || (await fromJsonSchema(schema)["~standard"].validate(args)).issues) refuse("The connected Canvas route does not accept this reviewed New Quiz delete.");
    const planned = await runtime.planOperationWithCurrentEditPermission(write.publicName, args);
    if (planned.isError === true) return planned as CallToolResult;
    const title = typeof quiz.title === "string" && quiz.title.trim() ? quiz.title.trim().slice(0, 300) : `New Quiz ${input.quiz_id}`;
    const report: JsonObject = {
      schema: "morrow.new-quiz-lifecycle.plan.v1", action: "delete", status: "planned", planned_at: new Date().toISOString(),
      course: { id: input.course_id, name: course.name.trim() }, quiz: { id: input.quiz_id, title },
      item_count: itemSnapshot.length, target_quiz_sha256: sha256Json(quiz), target_items_sha256: sha256Json(itemSnapshot),
      target_assignment_sha256: sha256Json(assignment),
      operation_count: 1, operations: [{ step: 1, tool: write.publicName, arguments: args,
        readback: { tool: list.publicName, course_id: input.course_id, expect_absent_assignment_id: input.quiz_id } }],
      warnings: ["Canvas does not restore a deleted New Quiz. This removes the quiz and every item currently in it."],
    };
    return { ...planned, content: [{ type: "text", text: `Review deletion of ${title} from ${course.name.trim()}. It currently contains ${itemSnapshot.length} items. Morrow froze the quiz and item snapshots. No Canvas change has been made or scheduled.` }], structuredContent: isJsonObject(planned.structuredContent) ? { ...planned.structuredContent, new_quiz_lifecycle_plan: report } : report } as CallToolResult;
  } catch (error) { return problem(error); }
}

/**
 * The proof that one Canvas Assignment is the New Quiz the caller named.
 *
 * A New Quiz's id is its Assignment id, so the exact New Quiz read and the exact
 * Assignment read must both return that id inside the selected course, and
 * Canvas must report `is_quiz_lti_assignment: true` for the Assignment. Without
 * all three, Morrow is not looking at a New Quiz and plans nothing.
 */
async function readNewQuizAssignment(
  context: ReturnType<typeof tools>, courseId: string, quizId: string, signal: AbortSignal,
): Promise<{ courseName: string; title: string; assignment: JsonObject }> {
  const courseRead = context.find(COURSE_TOOL, true);
  const get = context.find(GET_TOOL, true);
  const assignmentRead = context.find(ASSIGNMENT_TOOL, true);
  const [course, quiz, assignment] = await Promise.all([
    context.read(courseRead, { id: courseId }, signal),
    context.read(get, { course_id: courseId, assignment_id: quizId }, signal),
    context.read(assignmentRead, { course_id: courseId, id: quizId }, signal),
  ]);
  if (!isJsonObject(course) || exactId(course.id) !== courseId || typeof course.name !== "string" || !course.name.trim()) {
    refuse("Morrow could not confirm the selected Canvas course.");
  }
  if (!isJsonObject(quiz) || exactId(quiz.id) !== quizId
    || (quiz.course_id !== undefined && exactId(quiz.course_id) !== courseId)) refuse("Morrow could not confirm the selected New Quiz.");
  if (!isJsonObject(assignment) || exactId(assignment.id) !== quizId
    || (assignment.course_id !== undefined && exactId(assignment.course_id) !== courseId)) {
    refuse("Morrow could not confirm the Canvas Assignment linked to this New Quiz.");
  }
  if (assignment.is_quiz_lti_assignment !== true) {
    refuse("Canvas does not report this Assignment as a New Quiz, so Morrow will not treat it as one.");
  }
  const title = typeof quiz.title === "string" && quiz.title.trim() ? quiz.title.trim().slice(0, 300) : `New Quiz ${quizId}`;
  return { courseName: course.name.trim(), title, assignment };
}

/** The complete saved membership of one module, frozen in its saved order. */
function moduleItemSnapshot(rows: unknown): JsonObject[] {
  if (!Array.isArray(rows) || rows.length > MAX_MODULE_ITEMS) refuse("Canvas did not return one complete bounded module item list.");
  const items = rows.map((row) => {
    if (!isJsonObject(row) || !exactId(row.id)) refuse("Canvas returned a module item with no exact id.");
    return structuredClone(row);
  });
  const ids = items.map((row) => exactId(row.id));
  if (new Set(ids).size !== ids.length) refuse("Canvas returned a module item list with a repeated id.");
  return items.sort((left, right) => Number(left.position) - Number(right.position));
}

/**
 * A module item is the linked New Quiz Assignment when Canvas reports
 * `type: "Assignment"` and a `content_id` equal to the New Quiz id. A `Quiz`
 * module item names a Classic Quiz in a different id space, so it never counts.
 */
function isNewQuizModuleItem(row: JsonObject, quizId: string): boolean {
  return row.type === "Assignment" && exactId(row.content_id) === quizId;
}

async function planned(
  runtime: LifecycleRuntime, tool: CatalogSearchTool, args: JsonObject, text: string, report: JsonObject,
): Promise<CallToolResult> {
  const schema = runtime.catalog.tools.find((candidate) => candidate.publicName === tool.publicName)?.inputSchema;
  if (!schema || (await fromJsonSchema(schema)["~standard"].validate(args)).issues) {
    refuse("The connected Canvas route does not accept this reviewed change.");
  }
  const operation = await runtime.planOperationWithCurrentEditPermission(tool.publicName, args);
  if (operation.isError === true) return operation as CallToolResult;
  return {
    ...operation,
    content: [{ type: "text", text }],
    structuredContent: isJsonObject(operation.structuredContent)
      ? { ...operation.structuredContent, new_quiz_lifecycle_plan: report } : report,
  } as CallToolResult;
}

export async function planNewQuizModulePlacement(runtime: LifecycleRuntime, value: z.infer<typeof placementInputSchema>, callerSignal?: AbortSignal): Promise<CallToolResult> {
  try {
    const input = placementInputSchema.parse(value);
    const timeout = AbortSignal.timeout(60_000);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    const context = tools(runtime, input.source_binding_id);
    const write = context.find(CREATE_MODULE_ITEM_TOOL, false);
    const moduleRead = context.find(MODULE_TOOL, true);
    const itemsRead = context.find(MODULE_ITEMS_TOOL, true);
    const { courseName, title } = await readNewQuizAssignment(context, input.course_id, input.quiz_id, signal);
    const [module, rows] = await Promise.all([
      context.read(moduleRead, { course_id: input.course_id, id: input.module_id }, signal),
      context.read(itemsRead, { course_id: input.course_id, module_id: input.module_id }, signal),
    ]);
    if (!isJsonObject(module) || exactId(module.id) !== input.module_id) refuse("Morrow could not confirm the selected Canvas module.");
    const items = moduleItemSnapshot(rows);
    const existing = items.filter((row) => isNewQuizModuleItem(row, input.quiz_id));
    if (existing.length > 0) {
      refuse(`${title} is already in this module at position ${existing[0]!.position}. Move it instead of adding it again.`);
    }
    if (input.position !== undefined && input.position > items.length + 1) {
      refuse(`This module holds ${items.length} items, so position ${input.position} is past its end.`);
    }
    const args: JsonObject = {
      course_id: input.course_id, module_id: input.module_id,
      module_item_type: "Assignment", module_item_content_id: input.quiz_id,
      ...(input.position === undefined ? {} : { module_item_position: String(input.position) }),
      _morrow: context.routing,
    };
    const report: JsonObject = {
      schema: "morrow.new-quiz-lifecycle.plan.v1", action: "module_placement", status: "planned", planned_at: new Date().toISOString(),
      course: { id: input.course_id, name: courseName }, quiz: { id: input.quiz_id, title },
      module: { id: input.module_id, name: typeof module.name === "string" ? module.name.slice(0, 300) : null, item_count: items.length },
      before_module_items_sha256: sha256Json(items), operation_count: 1,
      operations: [{ step: 1, tool: write.publicName, arguments: args,
        readback: { tool: MODULE_ITEM_TOOL, course_id: input.course_id, module_id: input.module_id, id: "<created id>", expect: { type: "Assignment", content_id: input.quiz_id, ...(input.position === undefined ? {} : { position: input.position }) } } }],
      limits: ["Canvas represents a New Quiz in a module as an Assignment module item whose content id is the New Quiz id. Morrow verifies the saved module item carries exactly that type and content id."],
    };
    return await planned(runtime, write, args,
      `Review adding ${title} to ${typeof module.name === "string" ? module.name : `module ${input.module_id}`} in ${courseName}. Morrow froze the complete module item list. No Canvas change has been made or scheduled.`, report);
  } catch (error) { return problem(error); }
}

export async function planNewQuizModuleMove(runtime: LifecycleRuntime, value: z.infer<typeof moveInputSchema>, callerSignal?: AbortSignal): Promise<CallToolResult> {
  try {
    const input = moveInputSchema.parse(value);
    const timeout = AbortSignal.timeout(60_000);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    const context = tools(runtime, input.source_binding_id);
    const write = context.find(UPDATE_MODULE_ITEM_TOOL, false);
    const itemRead = context.find(MODULE_ITEM_TOOL, true);
    const moduleRead = context.find(MODULE_TOOL, true);
    const itemsRead = context.find(MODULE_ITEMS_TOOL, true);
    const { courseName, title } = await readNewQuizAssignment(context, input.course_id, input.quiz_id, signal);
    const [item, rows] = await Promise.all([
      context.read(itemRead, { course_id: input.course_id, module_id: input.module_id, id: input.module_item_id }, signal),
      context.read(itemsRead, { course_id: input.course_id, module_id: input.module_id }, signal),
    ]);
    if (!isJsonObject(item) || exactId(item.id) !== input.module_item_id
      || (item.module_id !== undefined && exactId(item.module_id) !== input.module_id)) refuse("Morrow could not confirm the selected Canvas module item.");
    if (!isNewQuizModuleItem(item, input.quiz_id)) {
      refuse("This module item is not the Assignment that carries the selected New Quiz, so Morrow will not move it.");
    }
    const items = moduleItemSnapshot(rows);
    if (!items.some((row) => exactId(row.id) === input.module_item_id)) {
      refuse("The selected module item is not in the complete current item list for this module.");
    }
    const target = input.target_module_id && input.target_module_id !== input.module_id ? input.target_module_id : undefined;
    let targetItems: JsonObject[] | undefined;
    let targetName: string | null = null;
    if (target) {
      const [targetModule, targetRows] = await Promise.all([
        context.read(moduleRead, { course_id: input.course_id, id: target }, signal),
        context.read(itemsRead, { course_id: input.course_id, module_id: target }, signal),
      ]);
      if (!isJsonObject(targetModule) || exactId(targetModule.id) !== target) refuse("Morrow could not confirm the target Canvas module.");
      targetName = typeof targetModule.name === "string" ? targetModule.name.slice(0, 300) : null;
      targetItems = moduleItemSnapshot(targetRows);
      if (targetItems.some((row) => isNewQuizModuleItem(row, input.quiz_id))) {
        refuse("The target module already holds this New Quiz.");
      }
    }
    const holding = target ? targetItems!.length + 1 : items.length;
    if (input.position !== undefined && input.position > holding) {
      refuse(`That module holds ${target ? targetItems!.length : items.length} items, so position ${input.position} is past its end.`);
    }
    const args: JsonObject = {
      course_id: input.course_id, module_id: input.module_id, id: input.module_item_id,
      ...(input.position === undefined ? {} : { module_item_position: String(input.position) }),
      ...(target ? { module_item_module_id: target } : {}),
      _morrow: context.routing,
    };
    const report: JsonObject = {
      schema: "morrow.new-quiz-lifecycle.plan.v1", action: "module_move", status: "planned", planned_at: new Date().toISOString(),
      course: { id: input.course_id, name: courseName }, quiz: { id: input.quiz_id, title },
      module_item: { id: input.module_item_id, module_id: input.module_id, position: item.position ?? null },
      target_module: target ? { id: target, name: targetName, item_count: targetItems!.length } : null,
      target_module_item_sha256: sha256Json(item), before_module_items_sha256: sha256Json(items),
      ...(targetItems ? { before_target_module_items_sha256: sha256Json(targetItems) } : {}),
      operation_count: 1,
      operations: [{ step: 1, tool: write.publicName, arguments: args,
        readback: { tool: MODULE_ITEM_TOOL, course_id: input.course_id, module_id: target ?? input.module_id, id: input.module_item_id, expect: { type: "Assignment", content_id: input.quiz_id, ...(input.position === undefined ? {} : { position: input.position }) } } }],
      limits: ["Canvas renumbers the other items in a module when one item moves. Morrow verifies the moved item's own saved position, type, and content id."],
    };
    return await planned(runtime, write, args,
      `Review moving ${title} in ${courseName}. Morrow proved this module item carries that exact New Quiz and froze the complete module item list. No Canvas change has been made or scheduled.`, report);
  } catch (error) { return problem(error); }
}

export async function planNewQuizAssignmentGroupOrder(runtime: LifecycleRuntime, value: z.infer<typeof groupOrderInputSchema>, callerSignal?: AbortSignal): Promise<CallToolResult> {
  try {
    const input = groupOrderInputSchema.parse(value);
    const timeout = AbortSignal.timeout(60_000);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    const context = tools(runtime, input.source_binding_id);
    const write = context.find(EDIT_ASSIGNMENT_TOOL, false);
    const groupRead = context.find(GROUP_ASSIGNMENTS_TOOL, true);
    const { courseName, title, assignment } = await readNewQuizAssignment(context, input.course_id, input.quiz_id, signal);
    const groupId = exactId(assignment.assignment_group_id);
    if (!groupId) refuse("Canvas did not report the assignment group this New Quiz belongs to.");
    const rows = await context.read(groupRead, { course_id: input.course_id, assignment_group_id: groupId }, signal);
    if (!Array.isArray(rows) || rows.length > MAX_QUIZZES) refuse("Canvas did not return one complete bounded assignment group list.");
    const members = rows.map((row) => {
      if (!isJsonObject(row) || !exactId(row.id)) refuse("Canvas returned an assignment with no exact id.");
      return { id: exactId(row.id), position: row.position ?? null };
    }).sort((left, right) => Number(left.position) - Number(right.position));
    if (!members.some((row) => row.id === input.quiz_id)) {
      refuse("The selected New Quiz is not in the complete current assignment list for its group.");
    }
    if (input.position > members.length) refuse(`That assignment group holds ${members.length} assignments, so position ${input.position} is past its end.`);
    const args: JsonObject = { course_id: input.course_id, id: input.quiz_id, assignment_position: String(input.position), _morrow: context.routing };
    const report: JsonObject = {
      schema: "morrow.new-quiz-lifecycle.plan.v1", action: "assignment_group_order", status: "planned", planned_at: new Date().toISOString(),
      course: { id: input.course_id, name: courseName }, quiz: { id: input.quiz_id, title },
      assignment_group: { id: groupId, assignment_count: members.length },
      current_position: assignment.position ?? null, requested_position: input.position,
      before_group_members_sha256: sha256Json(members), operation_count: 1,
      operations: [{ step: 1, tool: write.publicName, arguments: args,
        readback: { tool: ASSIGNMENT_TOOL, course_id: input.course_id, id: input.quiz_id, expect: { position: input.position } } }],
      limits: ["A New Quiz is ordered in its assignment group as the Assignment it is. Canvas renumbers the other assignments in that group, so Morrow verifies this quiz's own saved position."],
    };
    return await planned(runtime, write, args,
      `Review moving ${title} to position ${input.position} of its assignment group in ${courseName}. Morrow froze the complete group membership. No Canvas change has been made or scheduled.`, report);
  } catch (error) { return problem(error); }
}

export function registerNewQuizLifecycleTools(server: McpServer, runtime: GatewayRuntime): void {
  server.registerTool("morrow_plan_new_quiz_create", {
    title: "Review a New Quiz create",
    description: "Read the selected course and its complete New Quiz list, validate every requested official New Quiz field and setting, and return one guarded create for approval. Canvas assigns the id. Morrow reconciles a lost response by requiring exactly one added id and an exact saved-field match.",
    inputSchema: createInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (input, context) => planNewQuizCreate(runtime, input, context.mcpReq.signal));
  server.registerTool("morrow_plan_new_quiz_delete", {
    title: "Review a New Quiz deletion",
    description: "Read the selected course, exact New Quiz, linked Assignment, complete quiz list, and complete item list, then return one guarded delete for approval. Morrow refuses any submitted or graded student work. The connector refuses changed source state and verifies exact absence after one dispatch.",
    inputSchema: deleteInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, (input, context) => planNewQuizDelete(runtime, input, context.mcpReq.signal));
  server.registerTool("morrow_plan_new_quiz_module_placement", {
    title: "Review adding a New Quiz to a module",
    description: "Read the selected course, New Quiz, its linked Assignment, the target module, and that module's complete item list, then return one guarded module item create for approval. Canvas carries a New Quiz in a module as an Assignment module item whose content id is the New Quiz id, and Morrow verifies exactly that after one dispatch.",
    inputSchema: placementInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (input, context) => planNewQuizModulePlacement(runtime, input, context.mcpReq.signal));
  server.registerTool("morrow_plan_new_quiz_module_move", {
    title: "Review moving a New Quiz in a module",
    description: "Read the selected course, New Quiz, its linked Assignment, the exact module item, and the complete item list of the current and target modules, then return one guarded module item update for approval. Morrow sends nothing unless the module item is the Assignment that carries that exact New Quiz.",
    inputSchema: moveInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (input, context) => planNewQuizModuleMove(runtime, input, context.mcpReq.signal));
  server.registerTool("morrow_plan_new_quiz_assignment_group_order", {
    title: "Review ordering a New Quiz in its assignment group",
    description: "Read the selected course, New Quiz, its linked Assignment, and the complete assignment list of that Assignment's group, then return one guarded Assignment position change for approval. Morrow verifies the exact saved position of that quiz after one dispatch.",
    inputSchema: groupOrderInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (input, context) => planNewQuizAssignmentGroupOrder(runtime, input, context.mcpReq.signal));
}
