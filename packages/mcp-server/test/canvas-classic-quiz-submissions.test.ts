import { describe, expect, it } from "vitest";
import {
  CANVAS_CLASSIC_QUIZ_SUBMISSION_SUMMARY_SCHEMA,
  projectCanvasClassicQuizSubmissionSummary,
} from "../src/canvas-classic-quiz-submissions.js";

const aggregate = {
  schema: CANVAS_CLASSIC_QUIZ_SUBMISSION_SUMMARY_SCHEMA,
  provider: "canvas",
  course_id: 2,
  quiz_id: 8,
  attempt_count: 4,
  complete_count: 1,
  pending_review_count: 1,
  workflow_state_counts: { untaken: 1, pending_review: 1, complete: 1, settings_only: 1, preview: 0 },
  proof: {
    method: "GET /api/v1/courses/:course_id/quizzes/:quiz_id/submissions",
    complete: true,
    pagination_complete: true,
    pages_read: 2,
    response_row_count: 4,
    needs_grading_count_proven: false,
  },
};

describe("Canvas Classic Quiz submission-summary projection", () => {
  it("keeps only aggregate fields when browser data includes learner-linked rows", () => {
    const result = projectCanvasClassicQuizSubmissionSummary({
      ...aggregate,
      raw_rows: [{ id: 71, user_id: 7, name: "Jane Learner", email: "jane@example.edu", score: 100, answers: ["private answer"], comments: "private feedback", validation_token: "private-token" }],
      learner: { id: 7, name: "Jane Learner" },
      provider_response: { submissions: [{ submission_id: 71, answer: "private answer" }] },
    }, { courseId: 2, quizId: 8 });
    expect(result).toEqual(aggregate);
    const serialized = JSON.stringify(result);
    for (const privateValue of ["Jane Learner", "jane@example.edu", "private answer", "private feedback", "private-token", '"user_id":7', '"submission_id":71', '"score":100']) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("refuses a changed target, incomplete pagination, unproven grading count, and inconsistent states", () => {
    expect(() => projectCanvasClassicQuizSubmissionSummary({ ...aggregate, course_id: 3 }, { courseId: 2, quizId: 8 }))
      .toThrow("canvas_classic_quiz_submission_summary_invalid");
    expect(() => projectCanvasClassicQuizSubmissionSummary({ ...aggregate, quiz_id: 9 }, { courseId: 2, quizId: 8 }))
      .toThrow("canvas_classic_quiz_submission_summary_invalid");
    expect(() => projectCanvasClassicQuizSubmissionSummary({ ...aggregate, proof: { ...aggregate.proof, pagination_complete: false } }, { courseId: 2, quizId: 8 }))
      .toThrow("canvas_classic_quiz_submission_summary_invalid");
    expect(() => projectCanvasClassicQuizSubmissionSummary({ ...aggregate, proof: { ...aggregate.proof, needs_grading_count_proven: true } }, { courseId: 2, quizId: 8 }))
      .toThrow("canvas_classic_quiz_submission_summary_invalid");
    expect(() => projectCanvasClassicQuizSubmissionSummary({ ...aggregate, pending_review_count: 2 }, { courseId: 2, quizId: 8 }))
      .toThrow("canvas_classic_quiz_submission_summary_invalid");
    expect(() => projectCanvasClassicQuizSubmissionSummary({ ...aggregate, workflow_state_counts: { ...aggregate.workflow_state_counts, unknown: 0 } }, { courseId: 2, quizId: 8 }))
      .toThrow("canvas_classic_quiz_submission_summary_invalid");
  });
});
