import { sha256Json, type JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { planNewQuizAccommodation, planNewQuizReport } from "../src/new-quiz-effects.js";
import { bindNewQuizAccommodationEffectGuard, type GatewayRuntime } from "../src/runtime.js";

const sourceBindingId = "canvas:biology";

function fixture() {
  const calls: { tool: string; args: JsonObject }[] = [];
  const plans: { tool: string; args: JsonObject }[] = [];
  const runtime = {
    searchCatalog: ({ query }: { query: string }) => ({ tools: [{
      publicName: query, upstreamName: query, upstreamId: "canvas-session",
      annotations: { readOnlyHint: ["canvas_get_single_course_courses", "canvas_get_new_quiz", "canvas_query_progress_v1_progress_id_get"].includes(query) },
    }] }),
    capabilityGet: () => ({ descriptor: { route: { backend: "canvas-connector" } } }),
    callSourceOwned: async (tool: string, args: JsonObject) => {
      calls.push({ tool, args });
      const data = tool === "canvas_get_single_course_courses" ? { id: "42", name: "Biology" }
        : tool === "canvas_get_new_quiz" ? { id: "77", course_id: "42", title: "Cell structure" }
          : null;
      if (!data) throw new Error(`unexpected read ${tool}`);
      return { structuredContent: { schema: "morrow.canvas-connector.result.v1", ok: true, commandKind: "invoke_read",
        result: { ok: true, sent: true, truncated: false, data } } };
    },
    resultPage: () => { throw new Error("unexpected artifact"); },
    planOperationWithCurrentEditPermission: async (tool: string, args: JsonObject) => {
      plans.push({ tool, args });
      return { content: [], structuredContent: { schema: "morrow.operation.v1", operationId: `op:${plans.length}`, effectState: "awaiting_approval" } };
    },
  } as unknown as GatewayRuntime;
  return { runtime, calls, plans };
}

describe("New Quiz accommodation planner", () => {
  it("keeps only the course-local learner label in the reviewed operation", async () => {
    const { runtime, plans } = fixture();
    const result = await planNewQuizAccommodation(runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", learner_token: "Student A1",
      extra_time: 0, extra_attempts: 0, reduce_choices_enabled: false,
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(JSON.stringify(result)).not.toContain("912345");
    expect(result.structuredContent).toMatchObject({ new_quiz_effect_plan: {
      target: { course_id: "42", quiz_id: "77", learner_token: "Student A1" },
      payload: { user_id: "Student A1", extra_time: 0, extra_attempts: 0, reduce_choices_enabled: false },
    } });
    expect(plans).toHaveLength(1);
    expect(plans[0]!.args).toMatchObject({
      course_id: "42", assignment_id: "77", user_id: "Student A1", extra_time: 0, extra_attempts: 0,
      reduce_choices_enabled: false, _morrow: { source_binding_id: sourceBindingId },
    });
    expect(plans[0]!.args.morrow_new_quiz_effect_guard).toEqual({
      kind: "accommodation",
      payload_sha256: sha256Json({ user_id: "Student A1", extra_time: 0, extra_attempts: 0, reduce_choices_enabled: false }),
    });
  });

  it("refuses raw Canvas ids and invalid course-level or quiz-level fields", async () => {
    for (const input of [
      { source_binding_id: sourceBindingId, course_id: "42", learner_token: "912345", extra_time: 10 },
      { source_binding_id: sourceBindingId, course_id: "42", learner_token: "Student A1", extra_attempts: 1 },
      { source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", learner_token: "Student A1", apply_to_in_progress_quiz_sessions: true },
    ]) {
      const { runtime, plans } = fixture();
      expect((await planNewQuizAccommodation(runtime, input as never)).isError).toBe(true);
      expect(plans).toEqual([]);
    }
  });

  it("binds the guard to the private user id only after trusted resolution", () => {
    const dispatched = bindNewQuizAccommodationEffectGuard("canvas_set_quiz_level_accommodations", {
      course_id: "42", assignment_id: "77", user_id: "912345", extra_time: 0, extra_attempts: 0,
      morrow_new_quiz_effect_guard: { kind: "accommodation", payload_sha256: "a".repeat(64) },
    });
    expect(dispatched.morrow_new_quiz_effect_guard).toEqual({
      kind: "accommodation", payload_sha256: sha256Json({ user_id: "912345", extra_time: 0, extra_attempts: 0 }),
    });
    expect(() => bindNewQuizAccommodationEffectGuard("canvas_set_course_level_accommodations", {
      course_id: "42", user_id: "Student A1", extra_time: 10,
    })).toThrow("learner_token_unavailable");
  });
});

describe("New Quiz report planner", () => {
  it("binds one report request to the exact quiz and official Progress reader", async () => {
    const { runtime, plans } = fixture();
    const result = await planNewQuizReport(runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", report_type: "item_analysis", format: "csv",
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ new_quiz_effect_plan: {
      target: { course_id: "42", quiz_id: "77" }, payload: { report_type: "item_analysis", format: "csv" },
      progress_tool: "canvas_query_progress_v1_progress_id_get",
    } });
    expect(plans[0]!.args.morrow_new_quiz_effect_guard).toEqual({
      kind: "report", payload_sha256: sha256Json({ report_type: "item_analysis", format: "csv" }),
    });
  });
});
