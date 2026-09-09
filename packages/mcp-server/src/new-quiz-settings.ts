import { fromJsonSchema, type CallToolResult, type McpServer } from "@modelcontextprotocol/server";
import { isJsonObject, sha256Text, type JsonObject } from "@morrow/contracts";
import { isIP } from "node:net";
import * as z from "zod/v4";
import { canvasReadResult } from "./canvas-read.js";
import type { CatalogSearchTool, GatewayRuntime } from "./runtime.js";

const WRITE_TOOL = "canvas_update_single_quiz";
const READ_TOOL = "canvas_get_new_quiz";
const GROUPS = ["filters", "multiple_attempts", "result_view_settings"];
const TOP_LEVEL_SETTINGS = Object.freeze(new Set([
  "allow_backtracking", "calculator_type", "filter_ip_address", "filters", "has_time_limit",
  "multiple_attempts", "one_at_a_time_type", "require_student_access_code", "result_view_settings",
  "session_time_limit_in_seconds", "shuffle_answers", "shuffle_questions", "student_access_code",
]));
const GROUP_SETTINGS = Object.freeze({
  filters: new Set(["ips"]),
  multiple_attempts: new Set([
    "attempt_limit", "cooling_period", "cooling_period_seconds", "max_attempts",
    "multiple_attempts_enabled", "score_to_keep",
  ]),
  result_view_settings: new Set([
    "display_item_correct_answer", "display_item_feedback", "display_item_response",
    "display_item_response_correctness", "display_item_response_correctness_qualifier",
    "display_item_response_qualifier", "display_items", "display_points_awarded",
    "display_points_possible", "hide_item_response_correctness_at", "hide_item_responses_at",
    "result_view_restricted", "show_item_response_correctness_at", "show_item_responses_at",
  ]),
});
const inputSchema = z.strictObject({
  source_binding_id: z.string().regex(/^[A-Za-z0-9_.:@-]{1,160}$/),
  course_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  quiz_id: z.string().regex(/^[1-9][0-9]{0,18}$/).describe("The Canvas assignment ID of the New Quiz."),
  settings: z.record(z.string(), z.unknown()).refine((value) => JSON.stringify(value).length <= 64 * 1024)
    .describe("Only the quiz_settings values to change, using Canvas field names. Nest filters, multiple_attempts, and result_view_settings. Omitted values are preserved."),
});

export type NewQuizSettingsInput = z.infer<typeof inputSchema>;
type SettingsRuntime = Pick<GatewayRuntime, "catalog" | "searchCatalog" | "capabilityGet" | "callSourceOwned" | "resultPage" | "planOperationWithCurrentEditPermission">;

class SettingsPlanError extends Error {}
function refuse(message: string): never { throw new SettingsPlanError(message); }

// This encoding matches newQuizSettingsDigestSource in the extension, including
// numeric object keys, which JSON.stringify would otherwise reorder.
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isJsonObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  return refuse("Canvas settings must contain only JSON values.");
}

export function newQuizSettingsDigest(settings: JsonObject): string { return sha256Text(stable(settings)); }

function mergeSettings(current: JsonObject, requested: JsonObject): { merged: JsonObject; preserved: string[] } {
  const merged = { ...current, ...requested };
  const preserved: string[] = [];
  for (const [key, value] of Object.entries(current)) {
    if (GROUPS.includes(key) && isJsonObject(value)) {
      const change = requested[key];
      if (isJsonObject(change)) merged[key] = { ...value, ...change };
      if (change === undefined || isJsonObject(change)) {
        for (const leaf of Object.keys(value)) if (!isJsonObject(change) || !Object.hasOwn(change, leaf)) preserved.push(`${key}.${leaf}`);
      }
    } else if (!Object.hasOwn(requested, key)) preserved.push(key);
  }
  return { merged, preserved: preserved.sort() };
}

function requestedLeaf(requested: JsonObject, group: keyof typeof GROUP_SETTINGS, leaf: string): boolean {
  return isJsonObject(requested[group]) && Object.hasOwn(requested[group], leaf);
}

function mergedGroup(merged: JsonObject, group: keyof typeof GROUP_SETTINGS): JsonObject {
  return isJsonObject(merged[group]) ? merged[group] : {};
}

function requireBoolean(value: unknown, path: string): void {
  if (typeof value !== "boolean") refuse(`${path} must be true or false.`);
}

function requirePositiveIntegerOrNull(value: unknown, path: string): void {
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)) {
    refuse(`${path} must be a positive whole number or null.`);
  }
}

function requireDateTimeOrNull(value: unknown, path: string): void {
  if (value !== null && (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || Number.isNaN(Date.parse(value)))) {
    refuse(`${path} must be a Canvas date and time or null.`);
  }
}

export function validateRequestedNewQuizSettings(requested: JsonObject): void {
  for (const [key, value] of Object.entries(requested)) {
    if (!TOP_LEVEL_SETTINGS.has(key)) refuse(`${key} is not a New Quiz setting that Morrow supports.`);
    if (!GROUPS.includes(key)) continue;
    if (!isJsonObject(value) || Object.keys(value).length === 0) refuse(`Choose at least one setting inside ${key}.`);
    const allowed = GROUP_SETTINGS[key as keyof typeof GROUP_SETTINGS];
    for (const leaf of Object.keys(value)) {
      if (!allowed.has(leaf)) refuse(`${key}.${leaf} is not a New Quiz setting that Morrow supports.`);
    }
  }

  for (const key of [
    "allow_backtracking", "filter_ip_address", "has_time_limit", "require_student_access_code",
    "shuffle_answers", "shuffle_questions",
  ]) if (Object.hasOwn(requested, key)) requireBoolean(requested[key], key);

  if (Object.hasOwn(requested, "calculator_type")
    && requested.calculator_type !== null
    && !["none", "basic", "scientific"].includes(String(requested.calculator_type))) {
    refuse("calculator_type must be none, basic, scientific, or null.");
  }
  if (Object.hasOwn(requested, "one_at_a_time_type")
    && !["none", "question"].includes(String(requested.one_at_a_time_type))) {
    refuse("one_at_a_time_type must be none or question.");
  }
  if (Object.hasOwn(requested, "student_access_code")
    && requested.student_access_code !== null && typeof requested.student_access_code !== "string") {
    refuse("student_access_code must be text or null.");
  }
  if (Object.hasOwn(requested, "session_time_limit_in_seconds")) {
    requirePositiveIntegerOrNull(requested.session_time_limit_in_seconds, "session_time_limit_in_seconds");
  }

  if (isJsonObject(requested.filters) && Object.hasOwn(requested.filters, "ips")) {
    const ips = requested.filters.ips;
    if (ips !== null && (!Array.isArray(ips) || ips.length === 0
      || ips.some((range) => !Array.isArray(range) || range.length !== 2
        || range.some((address) => typeof address !== "string" || isIP(address) === 0)))) {
      refuse("filters.ips must be null or a non-empty list of start and end address pairs.");
    }
  }

  const attempts = isJsonObject(requested.multiple_attempts) ? requested.multiple_attempts : {};
  for (const key of ["attempt_limit", "cooling_period", "multiple_attempts_enabled"]) {
    if (Object.hasOwn(attempts, key)) requireBoolean(attempts[key], `multiple_attempts.${key}`);
  }
  for (const key of ["cooling_period_seconds", "max_attempts"]) {
    if (Object.hasOwn(attempts, key)) requirePositiveIntegerOrNull(attempts[key], `multiple_attempts.${key}`);
  }
  if (Object.hasOwn(attempts, "score_to_keep")
    && !["average", "first", "highest", "latest"].includes(String(attempts.score_to_keep))) {
    refuse("multiple_attempts.score_to_keep must be average, first, highest, or latest.");
  }

  const view = isJsonObject(requested.result_view_settings) ? requested.result_view_settings : {};
  for (const key of [
    "display_item_correct_answer", "display_item_feedback", "display_item_response",
    "display_item_response_correctness", "display_items", "display_points_awarded",
    "display_points_possible", "result_view_restricted",
  ]) if (Object.hasOwn(view, key)) requireBoolean(view[key], `result_view_settings.${key}`);
  if (Object.hasOwn(view, "display_item_response_qualifier")
    && !["always", "once_per_attempt", "after_last_attempt", "once_after_last_attempt"].includes(String(view.display_item_response_qualifier))) {
    refuse("result_view_settings.display_item_response_qualifier has an unsupported value.");
  }
  if (Object.hasOwn(view, "display_item_response_correctness_qualifier")
    && !["always", "after_last_attempt"].includes(String(view.display_item_response_correctness_qualifier))) {
    refuse("result_view_settings.display_item_response_correctness_qualifier must be always or after_last_attempt.");
  }
  for (const key of [
    "hide_item_response_correctness_at", "hide_item_responses_at",
    "show_item_response_correctness_at", "show_item_responses_at",
  ]) if (Object.hasOwn(view, key)) requireDateTimeOrNull(view[key], `result_view_settings.${key}`);
}

function activeValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== "";
}

function requireTimeOrder(view: JsonObject, showKey: string, hideKey: string, label: string): void {
  const show = view[showKey];
  const hide = view[hideKey];
  if (typeof show === "string" && typeof hide === "string" && Date.parse(hide) <= Date.parse(show)) {
    refuse(`${label} hide time must be later than its show time.`);
  }
}

export function validateNewQuizSettingDependencies(requested: JsonObject, merged: JsonObject): void {
  if (requested.allow_backtracking === true && merged.one_at_a_time_type !== "question") {
    refuse("allow_backtracking can be true only when one_at_a_time_type is question.");
  }
  const ips = mergedGroup(merged, "filters").ips;
  if ((requested.filter_ip_address === true || (requestedLeaf(requested, "filters", "ips") && requested.filters !== null && ips !== null))
    && (merged.filter_ip_address !== true || !Array.isArray(ips) || ips.length === 0)) {
    refuse("IP filtering needs filter_ip_address true and at least one filters.ips range.");
  }
  if ((requested.has_time_limit === true || (Object.hasOwn(requested, "session_time_limit_in_seconds") && requested.session_time_limit_in_seconds !== null))
    && (merged.has_time_limit !== true || typeof merged.session_time_limit_in_seconds !== "number"
      || !Number.isSafeInteger(merged.session_time_limit_in_seconds) || merged.session_time_limit_in_seconds <= 0)) {
    refuse("A time limit needs has_time_limit true and a positive session_time_limit_in_seconds.");
  }
  if (requested.has_time_limit === false && merged.session_time_limit_in_seconds !== undefined && merged.session_time_limit_in_seconds !== null) {
    refuse("Set session_time_limit_in_seconds to null before disabling the time limit.");
  }
  if ((requested.require_student_access_code === true || (Object.hasOwn(requested, "student_access_code") && requested.student_access_code !== null))
    && (merged.require_student_access_code !== true || typeof merged.student_access_code !== "string" || !merged.student_access_code)) {
    refuse("An access code needs require_student_access_code true and a non-empty student_access_code.");
  }
  if (requested.require_student_access_code === false && merged.student_access_code !== undefined && merged.student_access_code !== null) {
    refuse("Set student_access_code to null before disabling the access code.");
  }
  if (requested.filter_ip_address === false && ips !== undefined && ips !== null) {
    refuse("Set filters.ips to null before disabling IP filtering.");
  }

  const requestedAttempts = isJsonObject(requested.multiple_attempts) ? requested.multiple_attempts : {};
  const attempts = mergedGroup(merged, "multiple_attempts");
  const dependentAttemptLeaf = ["attempt_limit", "cooling_period", "cooling_period_seconds", "max_attempts", "score_to_keep"]
    .some((key) => Object.hasOwn(requestedAttempts, key) && requestedAttempts[key] !== false && requestedAttempts[key] !== null);
  if (dependentAttemptLeaf && attempts.multiple_attempts_enabled !== true) {
    refuse("Attempt limit, score, and cooling settings need multiple_attempts.multiple_attempts_enabled true.");
  }
  if (requestedAttempts.multiple_attempts_enabled === false
    && (attempts.attempt_limit === true || attempts.cooling_period === true
      || activeValue(attempts.cooling_period_seconds) || activeValue(attempts.max_attempts))) {
    refuse("Clear active attempt limit and cooling settings before disabling multiple attempts.");
  }
  if ((requestedAttempts.attempt_limit === true || (Object.hasOwn(requestedAttempts, "max_attempts") && requestedAttempts.max_attempts !== null))
    && (attempts.attempt_limit !== true || typeof attempts.max_attempts !== "number" || attempts.max_attempts <= 0)) {
    refuse("An attempt limit needs attempt_limit true and a positive max_attempts.");
  }
  if (requestedAttempts.attempt_limit === false && attempts.max_attempts !== undefined && attempts.max_attempts !== null) {
    refuse("Set multiple_attempts.max_attempts to null before disabling the attempt limit.");
  }
  if ((requestedAttempts.cooling_period === true
    || (Object.hasOwn(requestedAttempts, "cooling_period_seconds") && requestedAttempts.cooling_period_seconds !== null))
    && (attempts.cooling_period !== true || typeof attempts.cooling_period_seconds !== "number" || attempts.cooling_period_seconds <= 0)) {
    refuse("A cooling period needs cooling_period true and positive cooling_period_seconds.");
  }
  if (requestedAttempts.cooling_period === false && attempts.cooling_period_seconds !== undefined && attempts.cooling_period_seconds !== null) {
    refuse("Set multiple_attempts.cooling_period_seconds to null before disabling the cooling period.");
  }

  const requestedView = isJsonObject(requested.result_view_settings) ? requested.result_view_settings : {};
  const view = mergedGroup(merged, "result_view_settings");
  const active = (key: string): boolean => Object.hasOwn(requestedView, key)
    && requestedView[key] !== false && requestedView[key] !== null;
  if (["display_points_awarded", "display_points_possible"].some(active) && view.result_view_restricted !== true) {
    refuse("Point display restrictions need result_view_settings.result_view_restricted true.");
  }
  if (requestedView.result_view_restricted === false
    && [view.display_points_awarded, view.display_points_possible].some(activeValue)) {
    refuse("Disable point display settings before disabling result view restrictions.");
  }
  if (["display_item_feedback", "display_item_response"].some(active) && view.display_items !== true) {
    refuse("Item feedback and response settings need result_view_settings.display_items true.");
  }
  if (requestedView.display_items === false
    && [view.display_item_feedback, view.display_item_response, view.display_item_response_correctness].some(activeValue)) {
    refuse("Disable item feedback, response, and correctness settings before disabling item display.");
  }
  if (["display_item_response_qualifier", "show_item_responses_at", "hide_item_responses_at", "display_item_response_correctness"].some(active)
    && view.display_item_response !== true) {
    refuse("Response restrictions need result_view_settings.display_item_response true.");
  }
  if (requestedView.display_item_response === false
    && [view.show_item_responses_at, view.hide_item_responses_at, view.display_item_response_correctness].some(activeValue)) {
    refuse("Clear response times and disable correctness before disabling item responses.");
  }
  if ([
    "display_item_response_correctness_qualifier", "show_item_response_correctness_at",
    "hide_item_response_correctness_at", "display_item_correct_answer",
  ].some(active) && view.display_item_response_correctness !== true) {
    refuse("Correctness restrictions need result_view_settings.display_item_response_correctness true.");
  }
  if (requestedView.display_item_response_correctness === false
    && [view.show_item_response_correctness_at, view.hide_item_response_correctness_at, view.display_item_correct_answer].some(activeValue)) {
    refuse("Clear correctness times and disable correct-answer display before disabling response correctness.");
  }
  requireTimeOrder(view, "show_item_responses_at", "hide_item_responses_at", "Item response");
  requireTimeOrder(view, "show_item_response_correctness_at", "hide_item_response_correctness_at", "Response correctness");
}

export function newQuizSettingArguments(settings: JsonObject): JsonObject {
  const args: JsonObject = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!/^[a-z][a-z0-9_]*$/.test(key) || GROUPS.some((group) => key.startsWith(`${group}_`))) refuse("Use nested Canvas settings field names.");
    if (GROUPS.includes(key)) {
      if (!isJsonObject(value) || !Object.keys(value).length) refuse(`Choose at least one setting inside ${key}.`);
      for (const [leaf, entry] of Object.entries(value)) {
        if (!/^[a-z][a-z0-9_]*$/.test(leaf)) refuse("The settings field name is invalid.");
        args[`quiz_quiz_settings_${key}_${leaf}`] = entry;
      }
    } else args[`quiz_quiz_settings_${key}`] = value;
  }
  if (!Object.keys(args).length) refuse("Choose at least one setting to change.");
  return args;
}

function exactId(value: unknown): string {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) ? value
    : typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : "";
}

export async function planNewQuizSettings(runtime: SettingsRuntime, value: NewQuizSettingsInput, callerSignal?: AbortSignal): Promise<CallToolResult> {
  try {
    const input = inputSchema.parse(value);
    const requested = structuredClone(input.settings);
    stable(requested);
    validateRequestedNewQuizSettings(requested);
    const changedArguments = newQuizSettingArguments(requested);
    const timeout = AbortSignal.timeout(60_000);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    let source: string | undefined;
    const tool = (name: string, readOnly: boolean): CatalogSearchTool => {
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
    const write = tool(WRITE_TOOL, false);
    const quizRead = tool(READ_TOOL, true);
    const courseRead = tool("canvas_get_single_course_courses", true);
    const routing = { source_binding_id: input.source_binding_id };
    const target = { course_id: input.course_id, assignment_id: input.quiz_id };
    const read = async (mapping: CatalogSearchTool, args: JsonObject): Promise<unknown> => {
      signal.throwIfAborted();
      return canvasReadResult(runtime, await runtime.callSourceOwned(mapping.publicName, { ...args, _morrow: routing }, { signal })).data;
    };
    const [course, quiz] = await Promise.all([read(courseRead, { id: input.course_id }), read(quizRead, target)]);
    if (!isJsonObject(course) || exactId(course.id) !== input.course_id || typeof course.name !== "string" || !course.name.trim()) refuse("Morrow could not confirm the selected course from a fresh Canvas read.");
    if (!isJsonObject(quiz) || exactId(quiz.id) !== input.quiz_id
      || (quiz.course_id !== undefined && exactId(quiz.course_id) !== input.course_id) || !isJsonObject(quiz.quiz_settings)) {
      refuse("Morrow could not confirm the selected New Quiz and its current settings from a fresh Canvas read.");
    }
    const before = quiz.quiz_settings;
    const currentDigest = newQuizSettingsDigest(before);
    const args: JsonObject = {
      ...target, ...changedArguments,
      morrow_new_quiz_settings_guard: { current_quiz_settings_sha256: currentDigest },
      _morrow: routing,
    };
    const writeSchema = runtime.catalog.tools.find((candidate) => candidate.publicName === write.publicName)?.inputSchema;
    if (!writeSchema) refuse("The current Canvas settings schema is unavailable.");
    const validated = await fromJsonSchema(writeSchema)["~standard"].validate(args);
    if (validated.issues) refuse("The current Canvas settings route does not accept these settings or their guard. Check the setting names and values and the connector version.");
    const { merged, preserved } = mergeSettings(before, requested);
    validateNewQuizSettingDependencies(requested, merged);
    const expectedDigest = newQuizSettingsDigest(merged);
    const unchanged = currentDigest === expectedDigest;
    const title = typeof quiz.title === "string" && quiz.title.trim() ? quiz.title.trim().slice(0, 300) : "New Quiz";
    signal.throwIfAborted();
    const planned = unchanged ? null : await runtime.planOperationWithCurrentEditPermission(write.publicName, args);
    if (planned?.isError === true) return planned as unknown as CallToolResult;
    const report: JsonObject = {
      schema: "morrow.new-quiz-settings.plan.v1", status: unchanged ? "unchanged" : "planned",
      planned_at: new Date().toISOString(),
      course: { id: input.course_id, name: course.name.trim() }, quiz: { id: input.quiz_id, title },
      current_quiz_settings_sha256: currentDigest, expected_quiz_settings_sha256: expectedDigest,
      requested_settings: requested, merged_settings: merged, preserved_settings: preserved,
      operations: unchanged ? [] : [{ step: 1, tool: write.publicName, arguments: args,
        readback: { tool: quizRead.publicName, ...target, expect_quiz_settings_sha256: expectedDigest } }],
      operation_count: unchanged ? 0 : 1,
      limits: ["This route remains live-unverified against a Morrow-connected Canvas tenant. An uncertain result must not be sent again; read the quiz and reconcile the existing operation."],
    };
    return {
      ...(planned ?? {}),
      content: [{ type: "text", text: unchanged
        ? `${title} already has these settings. No change was planned.`
        : `Review the settings change for ${title} (${course.name.trim()}). Morrow preserves every setting you omitted. If the saved settings change before dispatch, the change is refused. No Canvas change has been made or scheduled. The saved settings need a fresh readback after approval.` }],
      structuredContent: planned && isJsonObject(planned.structuredContent) ? { ...planned.structuredContent, settings_plan: report } : report,
    } as CallToolResult;
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: `No settings change was planned. ${error instanceof SettingsPlanError ? error.message : "Morrow could not validate the request or read the current New Quiz settings."}` }],
      structuredContent: { schema: "morrow.problem.v1", code: "new_quiz_settings_not_planned" } };
  }
}

export function registerNewQuizSettingsTool(server: McpServer, runtime: GatewayRuntime): void {
  server.registerTool("morrow_plan_new_quiz_settings", {
    title: "Plan New Quiz settings",
    description: "Read one Canvas course and New Quiz, then plan a reviewed settings change. Use Canvas quiz_settings field names; omitted settings and nested group leaves are preserved. The connector checks the fresh settings digest before dispatch and verifies the complete saved block afterward. Planning makes and schedules no Canvas change.",
    inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input, context) => planNewQuizSettings(runtime, input, context.mcpReq.signal));
}
