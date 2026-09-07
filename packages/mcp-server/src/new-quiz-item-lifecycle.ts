import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { isJsonObject, sha256Json, type JsonObject } from "@morrow/contracts";
import * as z from "zod/v4";
import { canvasReadResult } from "./canvas-read.js";
import { quizItemPayloadMessage, quizItemPayloadReason } from "./quiz-item-payload.js";
import type { GatewayRuntime } from "./runtime.js";

/**
 * New Quiz question create, replacement, and delete plans.
 *
 * These three tools read Canvas and return a plan. They never send a Canvas
 * change and they never schedule one.
 *
 * A replacement is planned as a delete and an add, in that order, never as an
 * in-place PATCH. New Quizzes merges the parts of a question by the ids the
 * question already holds, so a change that renumbers those ids leaves the old
 * parts behind as blank answers. That is harvested ExamplePlatform production
 * evidence from 1 June 2026, recorded in section 2.2 of
 * docs/research/CANVAS-NEW-QUIZZES-ITEM-BANKS-CONTRACT-2026-09-06.md.
 * `connector/extension/src/new-quiz-item-guard.js` refuses the unsafe PATCH at
 * dispatch; these plans are the safe route in its place.
 *
 * The delete and the add are two separate Canvas requests. Nothing makes them
 * one change, so every replacement plan states the window in which the quiz
 * holds one fewer question, and names the saved question list as the authority.
 */

export const NEW_QUIZ_ITEM_LIFECYCLE_PLAN_SCHEMA = "morrow.new-quiz-item-lifecycle.plan.v1";

/** Questions one plan reads. A longer list is a quiz this planner will not plan against. */
const MAX_ITEMS = 10_000;
/** Question ids one plan lists as evidence. A longer quiz reports its count instead. */
const MAX_LISTED_ITEM_IDS = 200;
/** Characters of caller-supplied question JSON one plan accepts. */
const MAX_ITEM_JSON_CHARS = 256 * 1024;

const canvasId = z.string().regex(/^[1-9][0-9]{0,18}$/);
const sourceBindingId = z.string().regex(/^[A-Za-z0-9_.:@-]{1,160}$/);
const itemPayload = z.record(z.string(), z.unknown()).refine(
  (value) => JSON.stringify(value).length <= MAX_ITEM_JSON_CHARS,
  { message: "The question is too large to plan in one call." },
);

const createInputSchema = z.strictObject({
  source_binding_id: sourceBindingId,
  course_id: canvasId,
  quiz_id: canvasId.describe("The Canvas assignment ID of the New Quiz."),
  item: itemPayload.describe("The complete new question, in the shape Canvas returns one: entry_type, entry, and optional points_possible and position."),
  requested_item_id: canvasId.optional().describe("An item id you want to reuse. Morrow refuses it when the quiz still holds it. Canvas assigns the id of a created question."),
});

const replacementInputSchema = z.strictObject({
  source_binding_id: sourceBindingId,
  course_id: canvasId,
  quiz_id: canvasId.describe("The Canvas assignment ID of the New Quiz."),
  item_id: canvasId.describe("The question to replace. It is deleted, and the replacement gets a new id."),
  item: itemPayload.describe("The parts of the question to change. Every field you leave out is kept from the current question."),
});

const deleteInputSchema = z.strictObject({
  source_binding_id: sourceBindingId,
  course_id: canvasId,
  quiz_id: canvasId.describe("The Canvas assignment ID of the New Quiz."),
  item_id: canvasId,
});

export type NewQuizItemCreateInput = z.infer<typeof createInputSchema>;
export type NewQuizItemReplacementInput = z.infer<typeof replacementInputSchema>;
export type NewQuizItemDeleteInput = z.infer<typeof deleteInputSchema>;

type LifecycleRuntime = Pick<GatewayRuntime, "searchCatalog" | "capabilityGet" | "callSourceOwned" | "resultPage">;

const CREATE_TOOL = "canvas_create_quiz_item";
const DELETE_TOOL = "canvas_delete_quiz_item";
const READ_ITEM_TOOL = "canvas_get_quiz_item";
const LIST_ITEMS_TOOL = "canvas_list_quiz_items";

/**
 * The `item[...]` fields `canvas_create_quiz_item` carries, taken from the
 * generated Canvas catalog. A field outside this table cannot reach Canvas
 * through the create route, so this planner never puts one in a plan and never
 * lets one look preserved.
 */
const CREATE_ARGUMENT_FIELDS = Object.freeze([
  { argument: "item_entry_type", path: Object.freeze(["entry_type"]) },
  { argument: "item_points_possible", path: Object.freeze(["points_possible"]) },
  { argument: "item_position", path: Object.freeze(["position"]) },
  { argument: "item_entry_answer_feedback", path: Object.freeze(["entry", "answer_feedback"]) },
  { argument: "item_entry_calculator_type", path: Object.freeze(["entry", "calculator_type"]) },
  { argument: "item_entry_feedback_correct", path: Object.freeze(["entry", "feedback", "correct"]) },
  { argument: "item_entry_feedback_incorrect", path: Object.freeze(["entry", "feedback", "incorrect"]) },
  { argument: "item_entry_feedback_neutral", path: Object.freeze(["entry", "feedback", "neutral"]) },
  { argument: "item_entry_interaction_data", path: Object.freeze(["entry", "interaction_data"]) },
  { argument: "item_entry_interaction_type_slug", path: Object.freeze(["entry", "interaction_type_slug"]) },
  { argument: "item_entry_item_body", path: Object.freeze(["entry", "item_body"]) },
  { argument: "item_entry_properties", path: Object.freeze(["entry", "properties"]) },
  { argument: "item_entry_scoring_algorithm", path: Object.freeze(["entry", "scoring_algorithm"]) },
  { argument: "item_entry_scoring_data", path: Object.freeze(["entry", "scoring_data"]) },
  { argument: "item_entry_title", path: Object.freeze(["entry", "title"]) },
] as const);

/** Paths this planner walks into instead of sending whole. */
const CREATE_CONTAINER_PATHS = Object.freeze(new Set(["entry", "entry.feedback"]));
const CARRIED_PATHS = Object.freeze(new Set(CREATE_ARGUMENT_FIELDS.map((field) => field.path.join("."))));
/** Canvas assigns these. The new-id consequence covers them, so they are never reported as lost. */
const PROVIDER_ASSIGNED_PATHS = Object.freeze(new Set(["id", "entry.id"]));

const LIMITS = Object.freeze([
  "Morrow never plans an in-place structural change to a New Quiz question. The reason is harvested ExamplePlatform production evidence from 1 June 2026, when one question changed in place ended with 10 real answer choices and 18 blank ones. That evidence is live-unverified in Morrow.",
  "Morrow has not run a New Quiz question create, delete, or delete-then-add against a live Canvas course. The route contract comes from the harvested ExamplePlatform client, so it stays live-unverified.",
  "This plan is exact for the moment Morrow read the quiz. Read the quiz again before you send anything if another person may have changed it.",
]);

const UNCERTAIN_RESULT_WARNING = "An uncertain Canvas result must not be sent again. Read the question list again and reconcile from it.";

class NewQuizItemLifecycleError extends Error {}

function refuse(message: string): never {
  throw new NewQuizItemLifecycleError(message);
}

function noPlan(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [{
      type: "text",
      text: `No change was planned. ${error instanceof NewQuizItemLifecycleError ? error.message : "Morrow could not finish reading this New Quiz. Check the Canvas connection and try again."}`,
    }],
    structuredContent: { schema: "morrow.problem.v1", code: "new_quiz_item_lifecycle_not_planned" },
  };
}

function exactId(value: unknown): string {
  if (typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return "";
}

/** A whole question number of at least 1, written by Canvas as a number or as digits. 0 means none. */
function exactPosition(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) return value;
  if (typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value)) return Number(value);
  return 0;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 300) : fallback;
}

function itemTitle(row: JsonObject, fallback: string): string {
  const entry = isJsonObject(row.entry) ? row.entry : {};
  return text(entry.title, fallback);
}

export interface NewQuizMembershipItem {
  readonly id: string;
  readonly position: number;
  readonly entryType: string;
  readonly title: string;
}

/**
 * The saved question list is the authority on what a New Quiz holds. Every item
 * must have a stable non-duplicate id and a whole position of at least 1 with no
 * duplicates. Anything else means the list Morrow can read is not a list it can
 * plan from: that is a provider-state error, not a condition a person can
 * recover from here, so no plan is built and nothing is sent.
 */
export function newQuizItemMembership(rows: unknown): readonly NewQuizMembershipItem[] {
  if (!Array.isArray(rows)) refuse("Canvas did not return the saved question list for this New Quiz.");
  if (rows.length > MAX_ITEMS) refuse(`This New Quiz lists more than ${MAX_ITEMS} questions, which is more than Morrow reads in one plan.`);
  const items: NewQuizMembershipItem[] = [];
  const ids = new Set<string>();
  const positions = new Set<number>();
  for (const row of rows) {
    if (!isJsonObject(row)) refuse("Canvas returned a question list row that is not a question record. Morrow will not plan against this list.");
    const id = exactId(row.id);
    if (!id) refuse("Canvas returned a question with no exact id. Morrow cannot tell which question that row names, so it planned nothing.");
    if (ids.has(id)) refuse(`Canvas listed question id ${id} more than once. Morrow will not plan against a question list with a repeated id.`);
    const position = exactPosition(row.position);
    if (position === 0) refuse(`Canvas returned question ${id} with no whole question number. Morrow will not plan against this list.`);
    if (positions.has(position)) refuse(`Canvas listed two questions at position ${position}. Morrow will not plan against a question list with a repeated position.`);
    ids.add(id);
    positions.add(position);
    items.push({ id, position, entryType: text(row.entry_type, ""), title: itemTitle(row, `Question ${position}`) });
  }
  return items.sort((left, right) => left.position - right.position);
}

function membershipItem(membership: readonly NewQuizMembershipItem[], itemId: string): NewQuizMembershipItem | undefined {
  return membership.find((candidate) => candidate.id === itemId);
}

function valueAtPath(item: JsonObject, path: readonly string[]): unknown {
  let current: unknown = item;
  for (const key of path) {
    if (!isJsonObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** Every leaf path in the question that the create route cannot carry to Canvas. */
function uncarriedPaths(item: JsonObject, prefix: readonly string[] = []): readonly string[] {
  const paths: string[] = [];
  for (const key of Object.keys(item).sort()) {
    const path = [...prefix, key];
    const dotted = path.join(".");
    if (PROVIDER_ASSIGNED_PATHS.has(dotted)) continue;
    const value = item[key];
    if (CREATE_CONTAINER_PATHS.has(dotted)) {
      if (isJsonObject(value)) paths.push(...uncarriedPaths(value, path));
      else paths.push(dotted);
      continue;
    }
    if (!CARRIED_PATHS.has(dotted)) paths.push(dotted);
  }
  return paths;
}

/** The question with every path the create route cannot carry removed. */
function carriedItem(item: JsonObject): JsonObject {
  const carried: JsonObject = {};
  for (const field of CREATE_ARGUMENT_FIELDS) {
    const value = valueAtPath(item, field.path);
    if (value === undefined) continue;
    let target = carried;
    for (const key of field.path.slice(0, -1)) {
      const existing = target[key];
      const next = isJsonObject(existing) ? existing : {};
      target[key] = next;
      target = next;
    }
    target[field.path[field.path.length - 1] as string] = value;
  }
  return carried;
}

/**
 * The create-route arguments for one question. `checkCreatablePayload` has
 * already read `interaction_data` and `scoring_data` with the shape rules in
 * `quiz-item-payload.ts`, which check the four interaction shapes Morrow can
 * read and pass every other one through. An earlier hard allowlist made
 * ExamplePlatform refuse eight legitimate Canvas question types before Canvas ever saw
 * them, proven on 29 August 2026, so a check that cannot read a shape must not
 * forbid it. Canvas stays the authority on its own question schema.
 */
function createArguments(item: JsonObject, target: { readonly courseId: string; readonly quizId: string; readonly sourceBindingId: string }): JsonObject {
  const args: JsonObject = { course_id: target.courseId, assignment_id: target.quizId };
  for (const field of CREATE_ARGUMENT_FIELDS) {
    const value = valueAtPath(item, field.path);
    if (value === undefined) continue;
    if (field.argument !== "item_position") {
      args[field.argument] = value;
      continue;
    }
    // Canvas takes the question number as digits. A position Morrow cannot read
    // as a whole number is left out here and refused by the payload check.
    const position = exactPosition(value);
    if (position > 0) args[field.argument] = String(position);
  }
  args._morrow = { source_binding_id: target.sourceBindingId };
  return args;
}

/** The fields the create route needs, checked before a plan claims Canvas can accept it. */
function checkCreatablePayload(item: JsonObject): void {
  const entry = isJsonObject(item.entry) ? item.entry : refuse("The question needs an entry object with its body, type, and scoring.");
  const entryType = item.entry_type;
  if (typeof entryType !== "string" || !entryType.trim()) refuse("The question needs an entry_type. A New Quiz question item uses \"Item\".");
  if (entryType === "Stimulus") refuse("Canvas creates question items only. It does not create a Stimulus through this route.");
  for (const field of ["item_body", "interaction_type_slug", "scoring_algorithm"] as const) {
    const value = entry[field];
    if (typeof value !== "string" || !value.trim()) refuse(`The question needs a non-empty entry.${field}.`);
  }
  for (const field of ["interaction_data", "scoring_data"] as const) {
    if (!isJsonObject(entry[field])) refuse(`The question needs an entry.${field} object.`);
  }
  for (const field of ["answer_feedback", "properties"] as const) {
    if (entry[field] !== undefined && !isJsonObject(entry[field])) refuse(`entry.${field} must be an object.`);
  }
  if (entry.feedback !== undefined && !isJsonObject(entry.feedback)) refuse("entry.feedback must be an object.");
  const feedback = isJsonObject(entry.feedback) ? entry.feedback : {};
  for (const field of ["correct", "incorrect", "neutral"] as const) {
    if (feedback[field] !== undefined && typeof feedback[field] !== "string") refuse(`entry.feedback.${field} must be text.`);
  }
  for (const field of ["title", "calculator_type"] as const) {
    if (entry[field] !== undefined && typeof entry[field] !== "string") refuse(`entry.${field} must be text.`);
  }
  const points = item.points_possible;
  if (points !== undefined && (typeof points !== "number" || !Number.isFinite(points) || points < 0)) {
    refuse("points_possible must be a number of at least 0.");
  }
  if (item.position !== undefined && exactPosition(item.position) === 0) refuse("position must be a whole number of at least 1.");
  // The shape rules from section 6 of the harvested contract. They check the
  // four interaction shapes Morrow can read and pass every other one through to
  // Canvas, and they check the images and media of all of them. A question
  // Morrow plans is a question a person will read, so an image with no
  // alternative text is refused before the plan exists rather than repaired
  // afterwards.
  const payloadReason = quizItemPayloadReason(item);
  if (payloadReason) refuse(quizItemPayloadMessage(payloadReason));
}

/** A caller field the create route cannot carry would be dropped without a trace, so it is refused. */
function checkCallerFields(item: JsonObject, label: string): void {
  const entry = isJsonObject(item.entry) ? item.entry : {};
  if (item.id !== undefined || entry.id !== undefined) {
    refuse("Canvas assigns the ids of a created question. Remove id from the question you supplied.");
  }
  const dropped = uncarriedPaths(item);
  if (dropped.length > 0) {
    refuse(`Canvas cannot carry these ${label} fields through the create route, so Morrow planned nothing: ${dropped.join(", ")}.`);
  }
}

interface MergedItem {
  readonly merged: JsonObject;
  readonly preserved: readonly string[];
  readonly notCarried: readonly string[];
}

/**
 * Merge the caller's partial question over the current one. The merge is by leaf
 * within the question, its entry, and its feedback. `interaction_data`,
 * `scoring_data`, `properties`, and `answer_feedback` are replaced whole,
 * because half of an answer structure is not an answer structure.
 */
function mergeItem(existing: JsonObject, requested: JsonObject, position: number): MergedItem {
  const preserved: string[] = [];
  const notCarried = uncarriedPaths(existing);
  const current = carriedItem(existing);
  if (current.position === undefined) current.position = position;
  const merged: JsonObject = {};
  const mergeLevel = (base: JsonObject, change: JsonObject, target: JsonObject, prefix: readonly string[]): void => {
    for (const key of [...new Set([...Object.keys(base), ...Object.keys(change)])].sort()) {
      const path = [...prefix, key];
      const dotted = path.join(".");
      const baseValue = base[key];
      const changeValue = change[key];
      if (CREATE_CONTAINER_PATHS.has(dotted)) {
        const nested: JsonObject = {};
        mergeLevel(isJsonObject(baseValue) ? baseValue : {}, isJsonObject(changeValue) ? changeValue : {}, nested, path);
        target[key] = nested;
        continue;
      }
      if (key in change) {
        target[key] = changeValue;
        continue;
      }
      target[key] = baseValue;
      preserved.push(dotted);
    }
  };
  mergeLevel(current, requested, merged, []);
  return { merged, preserved: preserved.sort(), notCarried };
}

interface PlannedOperation {
  readonly step: number;
  readonly tool: string;
  readonly arguments: JsonObject;
  readonly readback: JsonObject;
}

/**
 * The Chrome bridge verifies each of these writes with the readback the
 * generated plan names: a created item is read back with `get_quiz_item`, and a
 * deleted item is read on the same route to prove it is gone
 * (`connector/extension/generated/canvas-readback-plan.js`). The saved question
 * list stays the authority on what the quiz holds.
 */
function readback(courseId: string, quizId: string, itemId: string | null, expect: "present" | "absent"): JsonObject {
  return {
    tool: READ_ITEM_TOOL,
    course_id: courseId,
    assignment_id: quizId,
    item_id: itemId,
    item_id_source: itemId === null ? "assigned_by_canvas_at_create" : "planned",
    expect_item: expect,
    membership_authority: LIST_ITEMS_TOOL,
  };
}

interface QuizContext {
  readonly courseName: string;
  readonly quizTitle: string;
  readonly membership: readonly NewQuizMembershipItem[];
  readonly readAt: string;
  readonly writeTool: (name: string) => string;
  readonly readItem: (itemId: string) => Promise<JsonObject>;
}

async function readQuizContext(
  runtime: LifecycleRuntime,
  input: { readonly source_binding_id: string; readonly course_id: string; readonly quiz_id: string },
  writeToolNames: readonly string[],
  signal: AbortSignal,
): Promise<QuizContext> {
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
  const read = async (name: string, args: JsonObject): Promise<unknown> => {
    signal.throwIfAborted();
    try {
      return canvasReadResult(runtime, await runtime.callSourceOwned(tool(name, true), {
        ...args, _morrow: { source_binding_id: input.source_binding_id },
      }, { signal })).data;
    } catch (error) {
      if (error instanceof NewQuizItemLifecycleError) throw error;
      refuse(`Morrow could not read the current ${name === LIST_ITEMS_TOOL ? "question list" : "Canvas record"} for this New Quiz.`);
    }
  };
  const writeTools = new Map<string, string>();
  for (const name of writeToolNames) writeTools.set(name, tool(name, false));
  const quizArgs = { course_id: input.course_id, assignment_id: input.quiz_id };
  const [course, quiz, rows] = await Promise.all([
    read("canvas_get_single_course_courses", { id: input.course_id }),
    read("canvas_get_new_quiz", quizArgs),
    read(LIST_ITEMS_TOOL, quizArgs),
  ]);
  if (!isJsonObject(course) || exactId(course.id) !== input.course_id || typeof course.name !== "string" || !course.name.trim()) {
    refuse("Morrow could not confirm the selected course from a fresh Canvas read.");
  }
  if (!isJsonObject(quiz) || exactId(quiz.id) !== input.quiz_id
    || (quiz.course_id !== undefined && exactId(quiz.course_id) !== input.course_id)) {
    refuse("Morrow could not confirm this New Quiz in the selected course from a fresh Canvas read.");
  }
  return {
    courseName: course.name.trim(),
    quizTitle: text(quiz.title, "New Quiz"),
    membership: newQuizItemMembership(rows),
    readAt: new Date().toISOString(),
    writeTool: (name: string): string => writeTools.get(name) ?? refuse(`This Canvas connection does not provide one ${name} tool.`),
    readItem: async (itemId: string): Promise<JsonObject> => {
      const item = await read(READ_ITEM_TOOL, { ...quizArgs, item_id: itemId });
      if (!isJsonObject(item) || exactId(item.id) !== itemId) {
        refuse(`Morrow could not read question ${itemId} from this New Quiz.`);
      }
      return item;
    },
  };
}

function quizSummary(context: QuizContext, input: { readonly course_id: string; readonly quiz_id: string }): JsonObject {
  return {
    course: { id: input.course_id, name: context.courseName },
    quiz: { id: input.quiz_id, title: context.quizTitle },
    membership: {
      read_at: context.readAt,
      item_count: context.membership.length,
      item_ids: context.membership.slice(0, MAX_LISTED_ITEM_IDS).map((item) => item.id),
      item_ids_complete: context.membership.length <= MAX_LISTED_ITEM_IDS,
      authority: LIST_ITEMS_TOOL,
    },
  };
}

function result(report: JsonObject, lines: readonly string[]): CallToolResult {
  return { content: [{ type: "text", text: [...lines, ...LIMITS].join("\n\n") }], structuredContent: report };
}

export async function planNewQuizItemCreate(runtime: LifecycleRuntime, value: NewQuizItemCreateInput, callerSignal?: AbortSignal): Promise<CallToolResult> {
  const input = createInputSchema.parse(value);
  const timeout = AbortSignal.timeout(60_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  try {
    checkCallerFields(input.item, "question");
    checkCreatablePayload(input.item);
    const context = await readQuizContext(runtime, input, [CREATE_TOOL], signal);
    if (input.requested_item_id && membershipItem(context.membership, input.requested_item_id)) {
      refuse(`This New Quiz already holds question id ${input.requested_item_id}. Reusing the id of a question the quiz still holds is not a create. Plan a replacement for that question, or create the new question without an id.`);
    }
    const operations: readonly PlannedOperation[] = [{
      step: 1,
      tool: context.writeTool(CREATE_TOOL),
      arguments: createArguments(input.item, { courseId: input.course_id, quizId: input.quiz_id, sourceBindingId: input.source_binding_id }),
      readback: readback(input.course_id, input.quiz_id, null, "present"),
    }];
    const warnings = [
      "Canvas assigns the id of the new question. The plan cannot name it in advance, so the readback reads the id Canvas returns.",
      UNCERTAIN_RESULT_WARNING,
      ...(input.requested_item_id
        ? [`Morrow checked that this quiz does not hold question id ${input.requested_item_id} now. Canvas does not list the ids of questions somebody deleted earlier, so Morrow cannot prove that no deleted question used it.`]
        : []),
    ];
    const report: JsonObject = {
      schema: NEW_QUIZ_ITEM_LIFECYCLE_PLAN_SCHEMA,
      action: "create",
      status: "planned",
      planned_at: new Date().toISOString(),
      ...quizSummary(context, input),
      ...(input.requested_item_id ? { requested_item_id: input.requested_item_id, requested_item_id_state: "not_held_by_this_quiz" } : {}),
      created_item_id: null,
      operations,
      operation_count: operations.length,
      warnings,
      limits: LIMITS,
    };
    const title = text(isJsonObject(input.item.entry) ? input.item.entry.title : undefined, "the new question");
    return result(report, [
      `Review one new question for ${context.quizTitle} (${context.courseName}).`,
      `Morrow plans one Canvas operation: add ${title} to this quiz. The quiz's saved list holds ${context.membership.length} ${context.membership.length === 1 ? "item" : "items"} now.`,
      "No Canvas change has been made or scheduled. The new question still needs your approval.",
      ...warnings,
    ]);
  } catch (error) {
    return noPlan(error);
  }
}

export async function planNewQuizItemReplacement(runtime: LifecycleRuntime, value: NewQuizItemReplacementInput, callerSignal?: AbortSignal): Promise<CallToolResult> {
  const input = replacementInputSchema.parse(value);
  const timeout = AbortSignal.timeout(60_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  try {
    checkCallerFields(input.item, "replacement");
    const context = await readQuizContext(runtime, input, [DELETE_TOOL, CREATE_TOOL], signal);
    const listed = membershipItem(context.membership, input.item_id);
    if (!listed) {
      refuse(`This New Quiz does not hold question ${input.item_id}, so there is nothing to replace. The saved question list is the authority.`);
    }
    if (listed.entryType !== "Item") {
      refuse(`Question ${input.item_id} is a ${listed.entryType || "question of an unnamed type"}, not a question item. Morrow replaces question items only.`);
    }
    const existing = await context.readItem(input.item_id);
    const { merged, preserved, notCarried } = mergeItem(existing, input.item, listed.position);
    checkCreatablePayload(merged);
    const target = { courseId: input.course_id, quizId: input.quiz_id, sourceBindingId: input.source_binding_id };
    if (sha256Json(createArguments(merged, target)) === sha256Json(createArguments(carriedItem(existing), target))) {
      refuse("The replacement is the same as the current question. Morrow will not delete and add a question to make no change.");
    }
    const operations: readonly PlannedOperation[] = [
      {
        step: 1,
        tool: context.writeTool(DELETE_TOOL),
        arguments: {
          course_id: input.course_id,
          assignment_id: input.quiz_id,
          item_id: input.item_id,
          _morrow: { source_binding_id: input.source_binding_id },
        },
        readback: readback(input.course_id, input.quiz_id, input.item_id, "absent"),
      },
      {
        step: 2,
        tool: context.writeTool(CREATE_TOOL),
        arguments: createArguments(merged, target),
        readback: readback(input.course_id, input.quiz_id, null, "present"),
      },
    ];
    const warnings = [
      `These two operations are not atomic. If the delete succeeds and the add then fails, the quiz holds one fewer question until somebody adds it again. ${LIST_ITEMS_TOOL} is the authority on what the quiz holds.`,
      `The replacement is a new question with a new id. Question ${input.item_id} will not exist afterwards, and anything that names that id needs the new one.`,
      "Morrow plans a delete and an add here, never an in-place change, because New Quizzes matches the parts of a question by the ids it already holds.",
      `The add asks Canvas for position ${exactPosition(merged.position) || listed.position}. Read the question list again afterwards to confirm the order.`,
      UNCERTAIN_RESULT_WARNING,
      ...(notCarried.length > 0
        ? [`The create route cannot carry these fields of the current question, so the replacement will not have them: ${notCarried.join(", ")}.`]
        : []),
    ];
    const report: JsonObject = {
      schema: NEW_QUIZ_ITEM_LIFECYCLE_PLAN_SCHEMA,
      action: "replacement",
      status: "planned",
      planned_at: new Date().toISOString(),
      ...quizSummary(context, input),
      item_id: input.item_id,
      item_position: listed.position,
      replacement_item_id: null,
      replacement_item_id_source: "assigned_by_canvas_at_create",
      atomic: false,
      in_place_update_planned: false,
      preserved_from_existing_item: preserved,
      not_carried_to_replacement: notCarried,
      operations,
      operation_count: operations.length,
      warnings,
      limits: LIMITS,
    };
    return result(report, [
      `Review this question replacement in ${context.quizTitle} (${context.courseName}).`,
      `Morrow plans two Canvas operations, in this order:\n1. Delete question ${listed.position}, "${listed.title}" (item id ${input.item_id}).\n2. Add the replacement question at position ${exactPosition(merged.position) || listed.position}.`,
      "No Canvas change has been made or scheduled. Each operation still needs your approval.",
      preserved.length > 0
        ? `The replacement keeps these fields of the current question: ${preserved.join(", ")}.`
        : "The replacement keeps no field of the current question. Every field the create route carries was supplied in this request.",
      ...warnings,
    ]);
  } catch (error) {
    return noPlan(error);
  }
}

export async function planNewQuizItemDelete(runtime: LifecycleRuntime, value: NewQuizItemDeleteInput, callerSignal?: AbortSignal): Promise<CallToolResult> {
  const input = deleteInputSchema.parse(value);
  const timeout = AbortSignal.timeout(60_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  try {
    const context = await readQuizContext(runtime, input, [DELETE_TOOL], signal);
    const listed = membershipItem(context.membership, input.item_id);
    if (!listed) {
      const report: JsonObject = {
        schema: NEW_QUIZ_ITEM_LIFECYCLE_PLAN_SCHEMA,
        action: "delete",
        status: "already_absent",
        planned_at: new Date().toISOString(),
        ...quizSummary(context, input),
        item_id: input.item_id,
        verification_state: "verified_absent",
        operations: [],
        operation_count: 0,
        warnings: [],
        limits: LIMITS,
      };
      return result(report, [
        `${context.quizTitle} (${context.courseName}) does not hold question ${input.item_id}.`,
        `Morrow planned nothing and sent nothing. The saved question list is the authority, and it names ${context.membership.length} ${context.membership.length === 1 ? "item" : "items"}, none of them this id.`,
      ]);
    }
    if (listed.entryType === "Stimulus") {
      refuse(`Item ${input.item_id} is a Stimulus. Morrow has no evidence of what happens to the questions bound to a Stimulus when it is deleted, so it plans nothing here.`);
    }
    const existing = await context.readItem(input.item_id);
    const operations: readonly PlannedOperation[] = [{
      step: 1,
      tool: context.writeTool(DELETE_TOOL),
      arguments: {
        course_id: input.course_id,
        assignment_id: input.quiz_id,
        item_id: input.item_id,
        _morrow: { source_binding_id: input.source_binding_id },
      },
      readback: readback(input.course_id, input.quiz_id, input.item_id, "absent"),
    }];
    const warnings = [
      "No Canvas route restores a deleted New Quiz question. Adding it again creates a new question with a new id.",
      "Deleting a question changes the numbering of the questions after it.",
      UNCERTAIN_RESULT_WARNING,
    ];
    const report: JsonObject = {
      schema: NEW_QUIZ_ITEM_LIFECYCLE_PLAN_SCHEMA,
      action: "delete",
      status: "planned",
      planned_at: new Date().toISOString(),
      ...quizSummary(context, input),
      item_id: input.item_id,
      item_position: listed.position,
      item_entry_type: listed.entryType,
      verification_state: "verified_present",
      operations,
      operation_count: operations.length,
      warnings,
      limits: LIMITS,
    };
    return result(report, [
      `Review this question removal in ${context.quizTitle} (${context.courseName}).`,
      `Morrow plans one Canvas operation: delete question ${listed.position}, "${itemTitle(existing, listed.title)}" (item id ${input.item_id}). The quiz's saved list holds ${context.membership.length} ${context.membership.length === 1 ? "item" : "items"} now.`,
      "No Canvas change has been made or scheduled. The delete still needs your approval.",
      ...warnings,
    ]);
  } catch (error) {
    return noPlan(error);
  }
}

export function registerNewQuizItemLifecycleTools(server: McpServer, runtime: GatewayRuntime): void {
  server.registerTool("morrow_plan_new_quiz_item_create", {
    title: "Review a new New Quiz question",
    description: "Plan one new question for an existing Canvas New Quiz. Morrow reads the course, the quiz, and the saved question list, checks the fields the Canvas create route carries, and refuses an item id the quiz still holds. It refuses an image with no alt attribute, a media source Canvas does not serve, and, for a multiple-choice, matching, numeric, or fill-in-the-blank question, answer data that breaks a rule it can read; every other question type is passed to Canvas, which stays the authority on its own schema. It returns one planned create with its readback. Canvas assigns the id of the new question. No Canvas change is made or scheduled while planning, and no local check establishes that Canvas will accept the question.",
    inputSchema: createInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (input, context) => planNewQuizItemCreate(runtime, input, context.mcpReq.signal));
  server.registerTool("morrow_plan_new_quiz_item_replacement", {
    title: "Review a New Quiz question replacement",
    description: "Plan a structural change to one Canvas New Quiz question as a delete and an add, never as an in-place change. New Quizzes matches the parts of a question by the ids it already holds, so an in-place change that renumbers them leaves blank leftover answers behind. Morrow reads the current question, keeps every field left out of the request, checks the merged question the same way a create is checked, and returns two operations in a fixed order. The two are not atomic: if the delete succeeds and the add fails, the quiz holds one fewer question and the saved question list is the authority. The replacement gets a new item id. No Canvas change is made or scheduled while planning.",
    inputSchema: replacementInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (input, context) => planNewQuizItemReplacement(runtime, input, context.mcpReq.signal));
  server.registerTool("morrow_plan_new_quiz_item_delete", {
    title: "Review a New Quiz question removal",
    description: "Plan the removal of one question from a Canvas New Quiz. Morrow reads the saved question list first. When the quiz no longer holds the question, Morrow plans nothing and reports it as verified absent. Otherwise it returns one planned delete with its readback. No Canvas change is made or scheduled while planning, no Canvas route restores a deleted question, and this does not plan a Stimulus removal.",
    inputSchema: deleteInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (input, context) => planNewQuizItemDelete(runtime, input, context.mcpReq.signal));
}
