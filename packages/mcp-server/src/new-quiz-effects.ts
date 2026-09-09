import { type CallToolResult, type McpServer } from "@modelcontextprotocol/server";
import { isJsonObject, sha256Json, type JsonObject } from "@morrow/contracts";
import * as z from "zod/v4";
import { canvasReadResult } from "./canvas-read.js";
import type { CatalogSearchTool, GatewayRuntime } from "./runtime.js";

const id = z.string().regex(/^[1-9][0-9]{0,18}$/);
const binding = z.string().regex(/^[A-Za-z0-9_.:@-]{1,160}$/);
const learnerToken = z.string().regex(/^Student A[1-9][0-9]*$/);
const accommodationInput = z.strictObject({
  source_binding_id: binding, course_id: id, quiz_id: id.optional(), learner_token: learnerToken,
  extra_time: z.number().int().min(0).max(10_080).optional(), extra_attempts: z.number().int().min(0).optional(),
  apply_to_in_progress_quiz_sessions: z.boolean().optional(), reduce_choices_enabled: z.boolean().optional(),
});
const reportInput = z.strictObject({
  source_binding_id: binding, course_id: id, quiz_id: id,
  report_type: z.enum(["student_analysis", "item_analysis"]), format: z.enum(["csv", "json"]),
});

type EffectsRuntime = Pick<GatewayRuntime, "searchCatalog" | "capabilityGet" | "callSourceOwned" | "resultPage" | "planOperationWithCurrentEditPermission">;
class EffectError extends Error {}
function refuse(message: string): never { throw new EffectError(message); }
function exactId(value: unknown): string { return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) ? value : typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : ""; }
function problem(error: unknown): CallToolResult { return { isError: true, content: [{ type: "text", text: `No New Quiz operation was planned. ${error instanceof EffectError ? error.message : "Morrow could not validate the target or request."}` }], structuredContent: { schema: "morrow.problem.v1", code: "new_quiz_effect_not_planned" } }; }

function context(runtime: EffectsRuntime, sourceBindingId: string) {
  let source: string | undefined;
  const find = (name: string, readOnly: boolean): CatalogSearchTool => {
    const matches = runtime.searchCatalog({ query: name, limit: 100 }).tools.filter((candidate) => {
      const descriptor = runtime.capabilityGet(candidate.publicName).descriptor;
      return candidate.upstreamName === name && candidate.annotations?.readOnlyHint === readOnly
        && (!source || candidate.upstreamId === source) && isJsonObject(descriptor) && isJsonObject(descriptor.route)
        && descriptor.route.backend === "canvas-connector";
    });
    if (matches.length !== 1) refuse(`This Canvas connection does not provide one ${name} tool.`);
    source = matches[0]!.upstreamId;
    return matches[0]!;
  };
  const routing = { source_binding_id: sourceBindingId };
  const read = async (tool: CatalogSearchTool, args: JsonObject, signal: AbortSignal): Promise<unknown> => canvasReadResult(runtime,
    await runtime.callSourceOwned(tool.publicName, { ...args, _morrow: routing }, { signal })).data;
  return { find, read, routing };
}

async function readTarget(runtime: EffectsRuntime, sourceBindingId: string, courseId: string, quizId: string | undefined, signal: AbortSignal) {
  const route = context(runtime, sourceBindingId);
  const courseTool = route.find("canvas_get_single_course_courses", true);
  const quizTool = quizId ? route.find("canvas_get_new_quiz", true) : null;
  const [course, quiz] = await Promise.all([
    route.read(courseTool, { id: courseId }, signal),
    quizTool ? route.read(quizTool, { course_id: courseId, assignment_id: quizId }, signal) : Promise.resolve(null),
  ]);
  if (!isJsonObject(course) || exactId(course.id) !== courseId || typeof course.name !== "string" || !course.name.trim()) refuse("Morrow could not confirm the selected Canvas course.");
  if (quizId && (!isJsonObject(quiz) || exactId(quiz.id) !== quizId || (quiz.course_id !== undefined && exactId(quiz.course_id) !== courseId))) refuse("Morrow could not confirm the selected New Quiz.");
  return { ...route, course, quiz };
}

export async function planNewQuizAccommodation(runtime: EffectsRuntime, value: z.infer<typeof accommodationInput>, callerSignal?: AbortSignal): Promise<CallToolResult> {
  try {
    const input = accommodationInput.parse(value);
    if (input.quiz_id && input.apply_to_in_progress_quiz_sessions !== undefined) refuse("apply_to_in_progress_quiz_sessions is course-level only.");
    if (!input.quiz_id && input.extra_attempts !== undefined) refuse("extra_attempts is quiz-level only.");
    if ([input.extra_time, input.extra_attempts, input.reduce_choices_enabled, input.apply_to_in_progress_quiz_sessions].every((entry) => entry === undefined)) refuse("Choose at least one accommodation value.");
    const timeout = AbortSignal.timeout(60_000); const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    const target = await readTarget(runtime, input.source_binding_id, input.course_id, input.quiz_id, signal);
    const name = input.quiz_id ? "canvas_set_quiz_level_accommodations" : "canvas_set_course_level_accommodations";
    const write = target.find(name, false);
    // The reviewed operation retains only the course-local learner label. The
    // trusted gateway resolves user_id from a fresh current and deleted roster
    // immediately before dispatch and replaces the digest with the private
    // payload digest sent to the Bridge.
    const payload: JsonObject = { user_id: input.learner_token };
    for (const key of ["extra_time", "extra_attempts", "apply_to_in_progress_quiz_sessions", "reduce_choices_enabled"] as const) if (input[key] !== undefined) payload[key] = input[key];
    const args: JsonObject = { course_id: input.course_id, ...(input.quiz_id ? { assignment_id: input.quiz_id } : {}), ...payload,
      morrow_new_quiz_effect_guard: { kind: "accommodation", payload_sha256: sha256Json(payload) }, _morrow: target.routing };
    const planned = await runtime.planOperationWithCurrentEditPermission(write.publicName, args);
    if (planned.isError === true) return planned as CallToolResult;
    const title = isJsonObject(target.quiz) && typeof target.quiz.title === "string" ? target.quiz.title : "the course";
    return { ...planned, content: [{ type: "text", text: `Review one ${input.quiz_id ? "quiz-level" : "course-level"} accommodation for ${input.learner_token} in ${title}. Canvas returns an exact success or failure row for this learner. No Canvas change has been made or scheduled.` }], structuredContent: isJsonObject(planned.structuredContent) ? { ...planned.structuredContent, new_quiz_effect_plan: { schema: "morrow.new-quiz-effect.plan.v1", action: "accommodation", target: { course_id: input.course_id, ...(input.quiz_id ? { quiz_id: input.quiz_id } : {}), learner_token: input.learner_token }, payload, operation_count: 1 } } : {} } as CallToolResult;
  } catch (error) { return problem(error); }
}

export async function planNewQuizReport(runtime: EffectsRuntime, value: z.infer<typeof reportInput>, callerSignal?: AbortSignal): Promise<CallToolResult> {
  try {
    const input = reportInput.parse(value); const timeout = AbortSignal.timeout(60_000); const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    const target = await readTarget(runtime, input.source_binding_id, input.course_id, input.quiz_id, signal);
    const write = target.find("canvas_create_quiz_report_course_id_quizzes_assignment_id_reports_post", false);
    const progress = target.find("canvas_query_progress_v1_progress_id_get", true);
    const payload = { report_type: input.report_type, format: input.format };
    const args: JsonObject = { course_id: input.course_id, assignment_id: input.quiz_id,
      quiz_report_report_type: input.report_type, quiz_report_format: input.format,
      morrow_new_quiz_effect_guard: { kind: "report", payload_sha256: sha256Json(payload) }, _morrow: target.routing };
    const planned = await runtime.planOperationWithCurrentEditPermission(write.publicName, args);
    if (planned.isError === true) return planned as CallToolResult;
    const title = isJsonObject(target.quiz) && typeof target.quiz.title === "string" ? target.quiz.title : `New Quiz ${input.quiz_id}`;
    return { ...planned, content: [{ type: "text", text: `Review one ${input.format} ${input.report_type} report request for ${title}. Canvas returns an assignment-bound Progress id. Use ${progress.publicName} until it reaches completed and returns the report artifact. No Canvas request has been made or scheduled.` }], structuredContent: isJsonObject(planned.structuredContent) ? { ...planned.structuredContent, new_quiz_effect_plan: { schema: "morrow.new-quiz-effect.plan.v1", action: "report", target: { course_id: input.course_id, quiz_id: input.quiz_id }, payload, progress_tool: progress.publicName, operation_count: 1 } } : {} } as CallToolResult;
  } catch (error) { return problem(error); }
}

export function registerNewQuizEffectTools(server: McpServer, runtime: GatewayRuntime): void {
  server.registerTool("morrow_plan_new_quiz_accommodation", { title: "Review a New Quiz accommodation", description: "Read the exact Canvas course and optional New Quiz, validate one learner's supported accommodation values, and return one response-verified POST for review. Use the course-local learner label that Morrow returned, for example Student A1. Morrow resolves the Canvas user id only inside the trusted dispatch path. Canvas has no accommodation GET route, so a lost response stays ambiguous and is never retried.", inputSchema: accommodationInput, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }, (input, context) => planNewQuizAccommodation(runtime, input, context.mcpReq.signal));
  server.registerTool("morrow_plan_new_quiz_report", { title: "Review a New Quiz report", description: "Read the exact Canvas course and New Quiz, validate the report type and format, and return one report request for review. The response must be an assignment-bound Progress record; its official Progress URL provides the durable artifact read.", inputSchema: reportInput, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }, (input, context) => planNewQuizReport(runtime, input, context.mcpReq.signal));
}
