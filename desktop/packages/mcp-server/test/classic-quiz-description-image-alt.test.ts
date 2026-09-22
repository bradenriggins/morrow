import { describe, expect, it } from "vitest";
import { sha256Json, sha256Text, type JsonObject } from "@morrow/contracts";
import { planClassicQuizDescriptionImageAltRepair } from "../src/page-correction.js";
import type { GatewayRuntime } from "../src/runtime.js";

const sourceBindingId = "canvas:instructor";
const description = '<p>Review this quiz.</p><img src="/courses/42/files/18">';
const quiz = {
  id: "77",
  course_id: "42",
  title: "Cell Structure Check",
  description,
  quiz_type: "assignment",
  assignment_group_id: "9",
  points_possible: 25,
  published: true,
  show_correct_answers: true,
  time_limit: 20,
};

function readResult(data: JsonObject): JsonObject {
  return {
    structuredContent: {
      schema: "morrow.canvas-connector.result.v1",
      ok: true,
      commandKind: "invoke_read",
      result: { ok: true, sent: true, truncated: false, data },
    },
  };
}

function fixture(currentQuiz: JsonObject = quiz) {
  const plans: { tool: string; arguments: Readonly<Record<string, unknown>> }[] = [];
  const runtime = {
    searchCatalog: ({ query }: { query: string }) => ({ tools: [{ publicName: query, upstreamName: query, upstreamId: "canvas-session", annotations: { readOnlyHint: query !== "canvas_edit_quiz" } }] }),
    capabilityGet: () => ({ descriptor: { route: { backend: "canvas-connector" } } }),
    callSourceOwned: async (tool: string, args: JsonObject) => {
      expect((args._morrow as JsonObject).source_binding_id).toBe(sourceBindingId);
      if (tool === "canvas_get_single_course_courses") return readResult({ id: "42", name: "Biology" });
      if (tool === "canvas_get_single_quiz") return readResult(currentQuiz);
      throw new Error(`unexpected tool ${tool}`);
    },
    resultPage: () => { throw new Error("unexpected artifact page"); },
    planOperationWithCurrentEditPermission: async (tool: string, args: Readonly<Record<string, unknown>>) => {
      plans.push({ tool, arguments: args });
      return { content: [], structuredContent: { effectState: "awaiting_approval" } };
    },
  } as unknown as GatewayRuntime;
  return { runtime, plans };
}

describe("Classic Quiz description image alternative-text planning", () => {
  it("binds one current course-scoped description and preserves Classic Quiz settings", async () => {
    const { runtime, plans } = fixture();
    const result = await planClassicQuizDescriptionImageAltRepair(runtime, {
      source_binding_id: sourceBindingId,
      course_id: "42",
      quiz_id: "77",
      expected_body_sha256: sha256Text(description),
      image_index: 1,
      image_src_sha256: sha256Text("/courses/42/files/18"),
      alt_text: "Cell structure diagram",
      decorative: false,
    });

    expect(result.isError).not.toBe(true);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ tool: "canvas_edit_quiz", arguments: {
      course_id: "42", id: "77", _morrow: { source_binding_id: sourceBindingId, canvas_content_guard: {
        kind: "classic_quiz_description_image_alt", course_id: "42", quiz_id: "77",
        body_sha256: sha256Text(description), image_index: 1, alt_text: "Cell structure diagram", decorative: false,
      } },
    } });
    const guard = (plans[0]!.arguments._morrow as JsonObject).canvas_content_guard as JsonObject;
    const protectedState = { ...quiz };
    delete protectedState.description;
    expect(guard.protected_state_sha256).toBe(sha256Json(protectedState));
    expect(JSON.stringify(plans)).not.toContain(description);
    expect(JSON.stringify(plans)).not.toContain("/courses/42/files/18");
  });

  it("refuses stale evidence and a source record outside the bound course before planning", async () => {
    const stale = fixture();
    const staleResult = await planClassicQuizDescriptionImageAltRepair(stale.runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", expected_body_sha256: "0".repeat(64),
      image_index: 1, image_src_sha256: sha256Text("/courses/42/files/18"), alt_text: "Cell structure diagram", decorative: false,
    });
    expect(staleResult.isError).toBe(true);
    expect(JSON.stringify(staleResult)).toContain("changed since this accessibility signal");
    expect(stale.plans).toHaveLength(0);

    const wrongCourse = fixture({ ...quiz, course_id: "43" });
    const wrongCourseResult = await planClassicQuizDescriptionImageAltRepair(wrongCourse.runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", expected_body_sha256: sha256Text(description),
      image_index: 1, image_src_sha256: sha256Text("/courses/42/files/18"), alt_text: "Cell structure diagram", decorative: false,
    });
    expect(wrongCourseResult.isError).toBe(true);
    expect(JSON.stringify(wrongCourseResult)).toContain("complete current Canvas Classic Quiz source");
    expect(wrongCourse.plans).toHaveLength(0);
  });
});
