import { isJsonObject, type JsonObject } from "@morrow/contracts";

export const CANVAS_CLASSIC_QUIZ_SUBMISSION_SUMMARY_OPERATION = "canvas.api.v1.course.quiz.submissions.aggregate.read.v1";
export const CANVAS_CLASSIC_QUIZ_SUBMISSION_SUMMARY_TOOL = "canvas_get_classic_quiz_submission_summary";
export const CANVAS_CLASSIC_QUIZ_SUBMISSION_SUMMARY_SCHEMA = "morrow.canvas-classic-quiz-submission-summary.v1";

const WORKFLOW_STATES = ["untaken", "pending_review", "complete", "settings_only", "preview"] as const;
type WorkflowState = typeof WORKFLOW_STATES[number];

export type CanvasClassicQuizSubmissionSummary = Readonly<{
  schema: typeof CANVAS_CLASSIC_QUIZ_SUBMISSION_SUMMARY_SCHEMA;
  provider: "canvas";
  course_id: number;
  quiz_id: number;
  attempt_count: number;
  complete_count: number;
  pending_review_count: number;
  workflow_state_counts: Readonly<Record<WorkflowState, number>>;
  proof: Readonly<{
    method: "GET /api/v1/courses/:course_id/quizzes/:quiz_id/submissions";
    complete: true;
    pagination_complete: true;
    pages_read: number;
    response_row_count: number;
    needs_grading_count_proven: false;
  }>;
}>;

export type CanvasClassicQuizSubmissionSummaryExpectation = Readonly<{ courseId: number; quizId: number }>;

function positiveId(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function count(value: unknown, maximum: number): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum ? Number(value) : null;
}

/**
 * Reprojects the page aggregate before any result leaves the MCP runtime.
 * It intentionally ignores every unknown field, including any provider row
 * that a compromised or stale browser result might attach.
 */
export function projectCanvasClassicQuizSubmissionSummary(
  value: unknown,
  expected: CanvasClassicQuizSubmissionSummaryExpectation,
): CanvasClassicQuizSubmissionSummary {
  if (!isJsonObject(value) || value.schema !== CANVAS_CLASSIC_QUIZ_SUBMISSION_SUMMARY_SCHEMA || value.provider !== "canvas"
    || positiveId(value.course_id) !== expected.courseId || positiveId(value.quiz_id) !== expected.quizId) {
    throw new Error("canvas_classic_quiz_submission_summary_invalid");
  }
  const attempts = count(value.attempt_count, 10_000);
  const complete = attempts === null ? null : count(value.complete_count, attempts);
  const pendingReview = attempts === null ? null : count(value.pending_review_count, attempts);
  const states = isJsonObject(value.workflow_state_counts) ? value.workflow_state_counts : null;
  const proof = isJsonObject(value.proof) ? value.proof : null;
  if (attempts === null || complete === null || pendingReview === null || !states || !proof
    || Object.keys(states).length !== WORKFLOW_STATES.length
    || proof.method !== "GET /api/v1/courses/:course_id/quizzes/:quiz_id/submissions"
    || proof.complete !== true || proof.pagination_complete !== true
    || !Number.isSafeInteger(proof.pages_read) || Number(proof.pages_read) < 1 || Number(proof.pages_read) > 25
    || proof.response_row_count !== attempts || proof.needs_grading_count_proven !== false) {
    throw new Error("canvas_classic_quiz_submission_summary_invalid");
  }
  const workflowStateCounts = Object.fromEntries(WORKFLOW_STATES.map((state) => [state, count(states[state], attempts)])) as Record<WorkflowState, number | null>;
  const workflowCounts = Object.values(workflowStateCounts);
  if (workflowCounts.some((entry) => entry === null)
    || workflowCounts.reduce<number>((total, entry) => total + (entry ?? 0), 0) !== attempts
    || workflowStateCounts.complete !== complete || workflowStateCounts.pending_review !== pendingReview) {
    throw new Error("canvas_classic_quiz_submission_summary_invalid");
  }
  return {
    schema: CANVAS_CLASSIC_QUIZ_SUBMISSION_SUMMARY_SCHEMA,
    provider: "canvas",
    course_id: expected.courseId,
    quiz_id: expected.quizId,
    attempt_count: attempts,
    complete_count: complete,
    pending_review_count: pendingReview,
    workflow_state_counts: {
      untaken: workflowStateCounts.untaken!,
      pending_review: workflowStateCounts.pending_review!,
      complete: workflowStateCounts.complete!,
      settings_only: workflowStateCounts.settings_only!,
      preview: workflowStateCounts.preview!,
    },
    proof: {
      method: "GET /api/v1/courses/:course_id/quizzes/:quiz_id/submissions",
      complete: true,
      pagination_complete: true,
      pages_read: Number(proof.pages_read),
      response_row_count: attempts,
      needs_grading_count_proven: false,
    },
  };
}

export function projectCanvasClassicQuizSubmissionSummaryBrowserResult(
  browserData: unknown,
  expected: CanvasClassicQuizSubmissionSummaryExpectation,
): JsonObject {
  return projectCanvasClassicQuizSubmissionSummary(browserData, expected) as JsonObject;
}
