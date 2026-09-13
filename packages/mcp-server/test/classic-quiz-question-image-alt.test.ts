import { describe, expect, it } from "vitest";
import { sha256Json, sha256Text, type JsonObject } from "@morrow/contracts";
import { planClassicQuizQuestionImageAltRepair } from "../src/page-correction.js";
import type { GatewayRuntime } from "../src/runtime.js";

const sourceBindingId = "canvas:instructor";
const questionImage = "/courses/42/files/17";
const answerImage = "/courses/42/files/18";
const questionText = `<p>Which part controls the cell?</p><img src="${questionImage}">`;
const answerHtml = `<p>Nucleus</p><img src="${answerImage}">`;
const question: JsonObject = {
  id: "301",
  quiz_id: "77",
  quiz_group_id: null,
  assessment_question_id: "9001",
  assessment_question_bank_id: null,
  created_at: "2026-09-01T12:00:00Z",
  updated_at: "2026-09-02T12:00:00Z",
  regrade_option: null,
  position: 1,
  question_name: "Cell structure",
  question_type: "multiple_choice_question",
  question_text: questionText,
  points_possible: 2,
  correct_comments: "Correct.",
  incorrect_comments: "Review the diagram.",
  neutral_comments: "",
  correct_comments_html: "<p>Correct.</p>",
  incorrect_comments_html: "<p>Review the diagram.</p>",
  neutral_comments_html: "",
  variables: null,
  formulas: null,
  answer_tolerance: null,
  formula_decimal_places: null,
  matches: null,
  matching_answer_incorrect_matches: null,
  answers: [
    { id: "6656", text: "Nucleus", html: answerHtml, weight: 100, comments: "Correct.", comments_html: "<p>Correct.</p>" },
    { id: "6657", text: "Cell wall", html: "<p>Cell wall</p>", weight: 0, comments: "Review the diagram.", comments_html: "<p>Review the diagram.</p>" },
  ],
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

function fixture(current: JsonObject = question) {
  const plans: { tool: string; arguments: Readonly<Record<string, unknown>> }[] = [];
  const runtime = {
    searchCatalog: ({ query }: { query: string }) => ({ tools: [{ publicName: query, upstreamName: query, upstreamId: "canvas-session", annotations: { readOnlyHint: query !== "canvas_update_existing_quiz_question" } }] }),
    capabilityGet: () => ({ descriptor: { route: { backend: "canvas-connector" } } }),
    callSourceOwned: async (tool: string, args: JsonObject) => {
      expect((args._morrow as JsonObject).source_binding_id).toBe(sourceBindingId);
      if (tool === "canvas_get_single_course_courses") return readResult({ id: "42", name: "Biology" });
      if (tool === "canvas_get_single_quiz_question") return readResult(current);
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

const questionTextInput = {
  source_binding_id: sourceBindingId,
  course_id: "42",
  quiz_id: "77",
  question_id: "301",
  expected_body_sha256: sha256Text(questionText),
  image_index: 1,
  image_src_sha256: sha256Text(questionImage),
  alt_text: "Labelled plant cell diagram",
  decorative: false,
};

const answerInput = {
  ...questionTextInput,
  answer_id: "6656",
  answer_field: "html" as const,
  expected_body_sha256: sha256Text(answerHtml),
  image_src_sha256: sha256Text(answerImage),
  alt_text: "Cell nucleus diagram",
};

/** The plan is refused, nothing is planned, and the stated reason contains this text. */
async function refusal(current: JsonObject, input: Parameters<typeof planClassicQuizQuestionImageAltRepair>[1], reason: string) {
  const { runtime, plans } = fixture(current);
  const result = await planClassicQuizQuestionImageAltRepair(runtime, input);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain(reason);
  expect(plans).toHaveLength(0);
}

describe("Classic Quiz question image alternative-text planning", () => {
  it("binds the question text and carries no question source into the plan", async () => {
    const { runtime, plans } = fixture();
    const result = await planClassicQuizQuestionImageAltRepair(runtime, questionTextInput);

    expect(result.isError).not.toBe(true);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ tool: "canvas_update_existing_quiz_question", arguments: {
      course_id: "42", quiz_id: "77", id: "301", _morrow: { source_binding_id: sourceBindingId, canvas_content_guard: {
        kind: "classic_quiz_question_image_alt", course_id: "42", quiz_id: "77", question_id: "301",
        body_sha256: sha256Text(questionText), image_index: 1, alt_text: "Labelled plant cell diagram", decorative: false,
      } },
    } });
    const guard = (plans[0]!.arguments._morrow as JsonObject).canvas_content_guard as JsonObject;
    expect(guard.answer_id).toBeUndefined();
    expect(guard.answer_field).toBeUndefined();
    const protectedState = structuredClone(question);
    delete protectedState.updated_at;
    delete protectedState.question_text;
    expect(guard.protected_state_sha256).toBe(sha256Json(protectedState));
    expect(JSON.stringify(plans)).not.toContain(questionText);
    expect(JSON.stringify(plans)).not.toContain(questionImage);
  });

  it("binds one exact answer field and leaves every other answer out of the protected digest change", async () => {
    const { runtime, plans } = fixture();
    const result = await planClassicQuizQuestionImageAltRepair(runtime, answerInput);

    expect(result.isError).not.toBe(true);
    expect(plans).toHaveLength(1);
    const guard = (plans[0]!.arguments._morrow as JsonObject).canvas_content_guard as JsonObject;
    expect(guard).toMatchObject({ answer_id: "6656", answer_field: "html", body_sha256: sha256Text(answerHtml) });
    const protectedState = structuredClone(question);
    delete protectedState.updated_at;
    delete (protectedState.answers as JsonObject[])[0]!.html;
    expect(guard.protected_state_sha256).toBe(sha256Json(protectedState));
    expect(JSON.stringify(plans)).not.toContain(answerHtml);
    expect(JSON.stringify(plans)).not.toContain(answerImage);
  });

  it("refuses a question a bank can regenerate", async () => {
    await refusal({ ...question, quiz_group_id: "5501" }, questionTextInput, "question group");
  });

  it("refuses a question type whose payload cannot be rebuilt", async () => {
    await refusal({ ...question, question_type: "matching_question" }, questionTextInput, "multiple choice, true or false");
  });

  it("names the documented field a read did not return", async () => {
    for (const field of ["question_name", "correct_comments", "position", "points_possible"]) {
      const incomplete = structuredClone(question);
      delete incomplete[field];
      await refusal(incomplete, questionTextInput, field);
    }
  });

  it("accepts official nullable response fields and refuses only nonempty unsupported state", async () => {
    await refusal({ ...question, regrade_option: "current_and_previous_submissions" }, questionTextInput, "regrade_option");
    await refusal({ ...question, variables: [] }, questionTextInput, "variables");
    const withAnswerState = structuredClone(question);
    (withAnswerState.answers as JsonObject[])[1]!.blank_id = "response1";
    await refusal(withAnswerState, questionTextInput, "blank_id");
  });

  it("accepts an official answerless essay response with null answers", async () => {
    const essay = { ...structuredClone(question), question_type: "essay_question", answers: null };
    const { runtime, plans } = fixture(essay);
    const result = await planClassicQuizQuestionImageAltRepair(runtime, questionTextInput);
    expect(result.isError).not.toBe(true);
    expect(plans).toHaveLength(1);
  });

  it("refuses stale evidence, an unavailable answer, and a question outside the bound quiz", async () => {
    await refusal(question, { ...questionTextInput, expected_body_sha256: "0".repeat(64) }, "changed since this accessibility signal");
    await refusal(question, { ...answerInput, answer_id: "9999" }, "not one exact answer");
    await refusal({ ...question, quiz_id: "78" }, questionTextInput, "complete current Canvas Classic Quiz question source");
  });

  it("refuses a half-stated answer selector before any Canvas read", async () => {
    const { runtime, plans } = fixture();
    await expect(planClassicQuizQuestionImageAltRepair(runtime, { ...questionTextInput, answer_id: "6656" } as never)).rejects.toThrow();
    expect(plans).toHaveLength(0);
  });
});
