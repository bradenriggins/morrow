import { describe, expect, it } from "vitest";
import { sha256Json, sha256Text, type JsonObject } from "@morrow/contracts";
import {
  planNewQuizAnswerFeedbackImageAltRepair,
  planNewQuizChoiceImageAltRepair,
  planNewQuizFeedbackImageAltRepair,
  planNewQuizItemImageAltRepair,
} from "../src/page-correction.js";
import type { GatewayRuntime } from "../src/runtime.js";

const sourceBindingId = "canvas:instructor";
const body = '<p>Identify the structure.</p><img src="/courses/42/files/12">';
const item = {
  id: "12",
  position: 2,
  points_possible: 5,
  entry_type: "Item",
  entry: {
    title: "Cell membrane image",
    item_body: body,
    interaction_type_slug: "choice",
    interaction_data: { choices: [{ id: "a", item_body: "Membrane" }, { id: "b", item_body: "Nucleus" }] },
    scoring_algorithm: "Equivalence",
    scoring_data: { value: "a" },
    feedback: { correct: "Correct", incorrect: "Review the image" },
  },
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

function fixture(overrides: { item?: JsonObject; quiz?: JsonObject } = {}) {
  const plans: { tool: string; arguments: Readonly<Record<string, unknown>> }[] = [];
  const currentItem = overrides.item ?? item;
  const currentQuiz = overrides.quiz ?? { id: "77", course_id: "42", title: "Cell Structure Check" };
  const runtime = {
    searchCatalog: ({ query }: { query: string }) => ({ tools: [{ publicName: query, upstreamName: query, upstreamId: "canvas-session", annotations: { readOnlyHint: query !== "canvas_update_quiz_item" } }] }),
    capabilityGet: () => ({ descriptor: { route: { backend: "canvas-connector" } } }),
    callSourceOwned: async (tool: string, args: JsonObject) => {
      expect((args._morrow as JsonObject).source_binding_id).toBe(sourceBindingId);
      if (tool === "canvas_get_single_course_courses") return readResult({ id: "42", name: "Biology" });
      if (tool === "canvas_get_new_quiz") return readResult(currentQuiz);
      if (tool === "canvas_get_quiz_item") return readResult(currentItem);
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

describe("New Quiz item image alternative-text planning", () => {
  it("binds one current course-scoped item body and preserves all other item state", async () => {
    const { runtime, plans } = fixture();
    const result = await planNewQuizItemImageAltRepair(runtime, {
      source_binding_id: sourceBindingId,
      course_id: "42",
      quiz_id: "77",
      item_id: "12",
      expected_body_sha256: sha256Text(body),
      image_index: 1,
      image_src_sha256: sha256Text("/courses/42/files/12"),
      alt_text: "Cell membrane diagram",
      decorative: false,
    });
    expect(result.isError).not.toBe(true);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ tool: "canvas_update_quiz_item", arguments: {
      course_id: "42", assignment_id: "77", item_id: "12", _morrow: { source_binding_id: sourceBindingId, canvas_content_guard: {
        kind: "new_quiz_item_image_alt", course_id: "42", assignment_id: "77", item_id: "12",
        body_sha256: sha256Text(body), image_index: 1, alt_text: "Cell membrane diagram", decorative: false,
      } },
    } });
    const guard = (plans[0]!.arguments._morrow as JsonObject).canvas_content_guard as JsonObject;
    const protectedState = { ...item, entry: { ...item.entry } };
    delete protectedState.entry.item_body;
    expect(guard.protected_state_sha256).toBe(sha256Json(protectedState));
    expect(JSON.stringify(plans)).not.toContain(body);
    expect(JSON.stringify(plans)).not.toContain("/courses/42/files/12");
  });

  it("refuses stale, non-item, and mismatched source records before a plan", async () => {
    const stale = fixture();
    const staleResult = await planNewQuizItemImageAltRepair(stale.runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item_id: "12",
      expected_body_sha256: "0".repeat(64), image_index: 1, image_src_sha256: sha256Text("/courses/42/files/12"), alt_text: "Cell membrane diagram", decorative: false,
    });
    expect(staleResult.isError).toBe(true);
    expect(JSON.stringify(staleResult)).toContain("changed since this accessibility signal");
    expect(stale.plans).toHaveLength(0);

    const stimulus = fixture({ item: { ...item, entry_type: "Stimulus", entry: { ...item.entry, body: body } } });
    const stimulusResult = await planNewQuizItemImageAltRepair(stimulus.runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item_id: "12",
      expected_body_sha256: sha256Text(body), image_index: 1, image_src_sha256: sha256Text("/courses/42/files/12"), alt_text: "Cell membrane diagram", decorative: false,
    });
    expect(stimulusResult.isError).toBe(true);
    expect(JSON.stringify(stimulusResult)).toContain("complete current Canvas New Quiz item source");
    expect(stimulus.plans).toHaveLength(0);

    const wrongQuiz = fixture({ quiz: { id: "77", course_id: "43", title: "Other course quiz" } });
    const wrongQuizResult = await planNewQuizItemImageAltRepair(wrongQuiz.runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item_id: "12",
      expected_body_sha256: sha256Text(body), image_index: 1, image_src_sha256: sha256Text("/courses/42/files/12"), alt_text: "Cell membrane diagram", decorative: false,
    });
    expect(wrongQuizResult.isError).toBe(true);
    expect(wrongQuiz.plans).toHaveLength(0);
  });
});

describe("New Quiz nested image alternative-text planning", () => {
  it("binds one direct answer choice and preserves its scoring and every other response", async () => {
    const choiceBody = '<p>Membrane</p><img src="/courses/42/files/13">';
    const currentItem = {
      ...item,
      entry: { ...item.entry, interaction_data: { choices: [{ ...item.entry.interaction_data.choices[0], item_body: choiceBody }, item.entry.interaction_data.choices[1]] }, scoring_data: { value: "a" } },
    };
    const { runtime, plans } = fixture({ item: currentItem });
    const result = await planNewQuizChoiceImageAltRepair(runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item_id: "12", choice_id: "a",
      expected_body_sha256: sha256Text(choiceBody), image_index: 1, image_src_sha256: sha256Text("/courses/42/files/13"), alt_text: "Cell membrane diagram", decorative: false,
    });
    expect(result.isError).not.toBe(true);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ tool: "canvas_update_quiz_item", arguments: {
      course_id: "42", assignment_id: "77", item_id: "12", _morrow: { source_binding_id: sourceBindingId, canvas_content_guard: {
        kind: "new_quiz_choice_image_alt", choice_id: "a", body_sha256: sha256Text(choiceBody), alt_text: "Cell membrane diagram",
      } },
    } });
    const guard = (plans[0]!.arguments._morrow as JsonObject).canvas_content_guard as JsonObject;
    const protectedState = structuredClone(currentItem);
    delete protectedState.entry.interaction_data.choices[0]!.item_body;
    expect(guard.protected_state_sha256).toBe(sha256Json(protectedState));
    expect(JSON.stringify(plans)).not.toContain(choiceBody);
  });

  it("binds one choice feedback field and one question feedback field without disclosing their source HTML", async () => {
    const answerFeedbackBody = '<p>Review this diagram.</p><img src="/courses/42/files/14">';
    const questionFeedbackBody = '<p>Correct.</p><img src="/courses/42/files/15">';
    const currentItem = {
      ...item,
      entry: {
        ...item.entry,
        answer_feedback: { a: answerFeedbackBody },
        feedback: { correct: questionFeedbackBody, incorrect: "Review the image" },
      },
    };
    const answerFeedback = fixture({ item: currentItem });
    const answerResult = await planNewQuizAnswerFeedbackImageAltRepair(answerFeedback.runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item_id: "12", choice_id: "a",
      expected_body_sha256: sha256Text(answerFeedbackBody), image_index: 1, image_src_sha256: sha256Text("/courses/42/files/14"), alt_text: "Review diagram", decorative: false,
    });
    expect(answerResult.isError).not.toBe(true);
    const answerGuard = (answerFeedback.plans[0]!.arguments._morrow as JsonObject).canvas_content_guard as JsonObject;
    expect(answerGuard).toMatchObject({ kind: "new_quiz_answer_feedback_image_alt", choice_id: "a" });
    const answerProtected = structuredClone(currentItem);
    delete answerProtected.entry.answer_feedback.a;
    expect(answerGuard.protected_state_sha256).toBe(sha256Json(answerProtected));
    expect(JSON.stringify(answerFeedback.plans)).not.toContain(answerFeedbackBody);

    const questionFeedback = fixture({ item: currentItem });
    const questionResult = await planNewQuizFeedbackImageAltRepair(questionFeedback.runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item_id: "12", feedback_type: "correct",
      expected_body_sha256: sha256Text(questionFeedbackBody), image_index: 1, image_src_sha256: sha256Text("/courses/42/files/15"), alt_text: "Correct response diagram", decorative: false,
    });
    expect(questionResult.isError).not.toBe(true);
    const questionGuard = (questionFeedback.plans[0]!.arguments._morrow as JsonObject).canvas_content_guard as JsonObject;
    expect(questionGuard).toMatchObject({ kind: "new_quiz_feedback_image_alt", feedback_type: "correct" });
    const questionProtected = structuredClone(currentItem);
    delete questionProtected.entry.feedback.correct;
    expect(questionGuard.protected_state_sha256).toBe(sha256Json(questionProtected));
    expect(JSON.stringify(questionFeedback.plans)).not.toContain(questionFeedbackBody);
  });

  it("refuses unsupported response schemas and missing selected feedback before a plan", async () => {
    const unsupported = fixture({ item: { ...item, entry: { ...item.entry, interaction_type_slug: "matching" } } });
    const unsupportedResult = await planNewQuizChoiceImageAltRepair(unsupported.runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item_id: "12", choice_id: "a",
      expected_body_sha256: sha256Text("Membrane"), image_index: 1, image_src_sha256: sha256Text("/courses/42/files/12"), alt_text: "Cell membrane", decorative: false,
    });
    expect(unsupportedResult.isError).toBe(true);
    expect(unsupported.plans).toHaveLength(0);

    const missingFeedback = fixture();
    const missingFeedbackResult = await planNewQuizFeedbackImageAltRepair(missingFeedback.runtime, {
      source_binding_id: sourceBindingId, course_id: "42", quiz_id: "77", item_id: "12", feedback_type: "neutral",
      expected_body_sha256: "0".repeat(64), image_index: 1, image_src_sha256: sha256Text("/courses/42/files/12"), alt_text: "Cell membrane", decorative: false,
    });
    expect(missingFeedbackResult.isError).toBe(true);
    expect(missingFeedback.plans).toHaveLength(0);
  });
});
