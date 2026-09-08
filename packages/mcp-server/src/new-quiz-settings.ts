import { fromJsonSchema, type CallToolResult, type McpServer } from "@modelcontextprotocol/server";
import { isJsonObject, sha256Text, type JsonObject } from "@morrow/contracts";
import * as z from "zod/v4";
import { canvasReadResult } from "./canvas-read.js";
import type { CatalogSearchTool, GatewayRuntime } from "./runtime.js";

const WRITE_TOOL = "canvas_update_single_quiz";
const READ_TOOL = "canvas_get_new_quiz";
const GROUPS = ["filters", "multiple_attempts", "result_view_settings"];
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

function settingArguments(settings: JsonObject): JsonObject {
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
    const changedArguments = settingArguments(requested);
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
