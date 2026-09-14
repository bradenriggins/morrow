import { describe, expect, it } from "vitest";
import { classicQuizQuestionContract } from "../src/classic-quiz-question-contract.js";

const officialQuestion = {
  id: 301,
  quiz_id: 77,
  quiz_group_id: null,
  assessment_question_id: 9001,
  assessment_question_bank_id: null,
  created_at: "2026-09-01T12:00:00Z",
  regrade_option: null,
  position: 1,
  question_name: "Cell structure",
  question_type: "multiple_choice_question",
  question_text: "<p>Which part controls the cell?</p>",
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
    { id: 6656, text: "Nucleus", html: "<p>Nucleus</p>", weight: 100, comments: "Correct.", comments_html: "<p>Correct.</p>" },
    { id: 6657, text: "Cell wall", html: "<p>Cell wall</p>", weight: 0, comments: "Review.", comments_html: "<p>Review.</p>" },
  ],
};

describe("Classic QuizQuestion provider contract", () => {
  it("accepts the official response fields and converts stored answer keys to complete request keys", () => {
    expect(classicQuizQuestionContract(officialQuestion)).toEqual({
      ok: true,
      points: "2",
      answers: [
        { id: "6656", answer_text: "Nucleus", answer_html: "<p>Nucleus</p>", answer_weight: 100, answer_comments: "Correct.", answer_comment_html: "<p>Correct.</p>" },
        { id: "6657", answer_text: "Cell wall", answer_html: "<p>Cell wall</p>", answer_weight: 0, answer_comments: "Review.", answer_comment_html: "<p>Review.</p>" },
      ],
    });
  });

  it("keeps compatibility with documented answer request aliases", () => {
    const aliased = structuredClone(officialQuestion);
    aliased.answers = [
      { id: 6656, answer_text: "Nucleus", answer_html: "<p>Nucleus</p>", answer_weight: 100, answer_comments: "Correct.", answer_comment_html: "<p>Correct.</p>" },
    ] as typeof aliased.answers;
    expect(classicQuizQuestionContract(aliased)).toMatchObject({ ok: true, answers: [{ id: "6656", answer_text: "Nucleus", answer_weight: 100 }] });
  });

  it("accepts null type fields and null answers on an essay", () => {
    expect(classicQuizQuestionContract({ ...officialQuestion, question_type: "essay_question", answers: null })).toMatchObject({ ok: true, answers: [] });
  });

  it("refuses nonempty unsupported type state, conflicting aliases, and unknown fields", () => {
    expect(classicQuizQuestionContract({ ...officialQuestion, variables: [] })).toMatchObject({ ok: false, category: "unmodelled_state" });
    expect(classicQuizQuestionContract({
      ...officialQuestion,
      answers: [{ id: 6656, text: "Nucleus", answer_text: "Different", weight: 100 }],
    })).toMatchObject({ ok: false, category: "unmodelled_state" });
    expect(classicQuizQuestionContract({ ...officialQuestion, unexpected: true })).toMatchObject({ ok: false, category: "unmodelled_state" });
  });
});
