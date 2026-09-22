import { isJsonObject, type JsonObject } from "@morrow/contracts";

export const MOODLE_QUIZ_ATTEMPT_SUMMARY_OPERATION = "moodle.form.quiz.attempt_summary.read.v1";
export const MOODLE_QUIZ_ATTEMPT_SUMMARY_TOOL = "moodle_get_quiz_attempt_summary";
export const MOODLE_QUIZ_ATTEMPT_SUMMARY_SCHEMA = "morrow.moodle-quiz-attempt-summary.v1";

const STATES = ["notstarted", "inprogress", "overdue", "submitted", "finished", "abandoned"] as const;

export type MoodleQuizAttemptSummary = Readonly<{
  schema: typeof MOODLE_QUIZ_ATTEMPT_SUMMARY_SCHEMA;
  provider: "moodle";
  course_id: number;
  module_id: number;
  quiz_id: number;
  participant_count: number;
  total_attempt_count: number;
  attempt_state_counts: Readonly<Record<(typeof STATES)[number], number>>;
  proof: Readonly<{
    method: "core_table_get_dynamic_table_content+mod_quiz_get_user_quiz_attempts";
    complete: true;
    exact_module_binding: "course_modedit_form";
    participant_page_size: 50;
    participant_response_rows: number;
    per_participant_attempt_limit: 50;
    total_attempt_limit: 500;
    attempt_response_rows: number;
    attempt_request_count: number;
  }>;
}>;

export type MoodleQuizAttemptSummaryExpectation = Readonly<{ courseId: number; moduleId: number }>;

function positiveId(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function count(value: unknown, maximum: number): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum ? Number(value) : null;
}

/**
 * Creates the only public representation allowed for a Moodle Quiz attempt
 * response. It ignores unknown source fields so rows never reach MCP egress.
 */
export function projectMoodleQuizAttemptSummary(
  value: unknown,
  expected: MoodleQuizAttemptSummaryExpectation,
): MoodleQuizAttemptSummary {
  if (!isJsonObject(value) || value.schema !== MOODLE_QUIZ_ATTEMPT_SUMMARY_SCHEMA || value.provider !== "moodle"
    || positiveId(value.course_id) !== expected.courseId || positiveId(value.module_id) !== expected.moduleId) {
    throw new Error("moodle_quiz_attempt_summary_invalid");
  }
  const participantCount = count(value.participant_count, 50);
  const totalAttemptCount = count(value.total_attempt_count, 500);
  const quizId = positiveId(value.quiz_id);
  const stateCounts = isJsonObject(value.attempt_state_counts) ? value.attempt_state_counts : null;
  const proof = isJsonObject(value.proof) ? value.proof : null;
  if (participantCount === null || totalAttemptCount === null || !quizId || !stateCounts || !proof
    || Object.keys(stateCounts).length !== STATES.length
    || proof.method !== "core_table_get_dynamic_table_content+mod_quiz_get_user_quiz_attempts" || proof.complete !== true
    || proof.exact_module_binding !== "course_modedit_form" || proof.participant_page_size !== 50
    || proof.participant_response_rows !== participantCount || proof.per_participant_attempt_limit !== 50
    || proof.total_attempt_limit !== 500 || proof.attempt_response_rows !== totalAttemptCount
    || proof.attempt_request_count !== participantCount) {
    throw new Error("moodle_quiz_attempt_summary_invalid");
  }
  const counts = Object.fromEntries(STATES.map((state) => [state, count(stateCounts[state], totalAttemptCount)])) as Record<(typeof STATES)[number], number | null>;
  if (Object.values(counts).some((entry) => entry === null)
    || STATES.reduce((sum, state) => sum + counts[state]!, 0) !== totalAttemptCount) {
    throw new Error("moodle_quiz_attempt_summary_invalid");
  }
  return {
    schema: MOODLE_QUIZ_ATTEMPT_SUMMARY_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    module_id: expected.moduleId,
    quiz_id: quizId,
    participant_count: participantCount,
    total_attempt_count: totalAttemptCount,
    attempt_state_counts: {
      notstarted: counts.notstarted!, inprogress: counts.inprogress!, overdue: counts.overdue!, submitted: counts.submitted!,
      finished: counts.finished!, abandoned: counts.abandoned!,
    },
    proof: {
      method: "core_table_get_dynamic_table_content+mod_quiz_get_user_quiz_attempts",
      complete: true,
      exact_module_binding: "course_modedit_form",
      participant_page_size: 50,
      participant_response_rows: participantCount,
      per_participant_attempt_limit: 50,
      total_attempt_limit: 500,
      attempt_response_rows: totalAttemptCount,
      attempt_request_count: participantCount,
    },
  };
}

export function projectMoodleQuizAttemptSummaryBrowserResult(
  browserData: unknown,
  expected: MoodleQuizAttemptSummaryExpectation,
): JsonObject {
  return projectMoodleQuizAttemptSummary(browserData, expected) as JsonObject;
}
