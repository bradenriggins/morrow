import { describe, expect, it } from "vitest";
import {
  MOODLE_QUIZ_ATTEMPT_SCHEMA,
  MOODLE_QUIZ_MANUAL_GRADING_QUEUE_SCHEMA,
  MOODLE_QUIZ_REGRADE_REPORT_SCHEMA,
  projectMoodleQuizAttemptSource,
  projectMoodleQuizManualGradingQueue,
  projectMoodleQuizRegradeReport,
  projectPublicMoodleQuizAttempt,
} from "../src/moodle-quiz-attempt-detail.js";

const TOKEN = "learner_2f1c9a70-8b1e-4c66-9d0a-51f1c4d2e7a3";
const AVOIDED_ROUTES = "/mod/quiz/attempt.php+/mod/quiz/review.php+/mod/quiz/reviewquestion.php";
const ATTEMPT_TARGET = { courseId: 2, moduleId: 8, attemptId: 41 };
const MODULE_TARGET = { courseId: 2, moduleId: 8 };

const attemptBody = {
  schema: MOODLE_QUIZ_ATTEMPT_SCHEMA,
  provider: "moodle",
  course_id: 2,
  module_id: 8,
  attempt_id: 41,
  state: "finished",
  started_display: "Monday, 1 September 2026, 10:04 AM",
  completed_display: "Monday, 1 September 2026, 10:31 AM",
  duration_display: "27 mins",
  slot_count: 3,
  slots: [
    { slot: 1, state: "correct", mark: 1, regraded: false },
    { slot: 2, state: "requiresgrading", mark: null, regraded: false },
    { slot: 3, state: "partiallycorrect", mark: 0.5, regraded: true },
  ],
  proof: {
    method: "quiz_report_overview_page",
    route: "/mod/quiz/report.php?mode=overview",
    complete: true,
    exact_module_binding: "quiz_report_page",
    required_capability: "mod/quiz:viewreports",
    avoided_routes: AVOIDED_ROUTES,
    records_learner_state: false,
    records_report_viewed_event: true,
    sesskey_sent: false,
    page_size: 100,
    page_count: 1,
    row_count: 2,
    slot_limit: 100,
  },
};

const queue = {
  schema: MOODLE_QUIZ_MANUAL_GRADING_QUEUE_SCHEMA,
  provider: "moodle",
  course_id: 2,
  module_id: 8,
  question_count: 2,
  needs_grading_count: 3,
  manually_graded_count: 3,
  response_count: 7,
  questions: [
    { slot: 2, question_id: 55, needs_grading: 3, manually_graded: 1, total: 5 },
    { slot: 4, question_id: 57, needs_grading: 0, manually_graded: 2, total: 2 },
  ],
  proof: {
    method: "quiz_report_grading_index",
    route: "/mod/quiz/report.php?mode=grading",
    complete: true,
    exact_module_binding: "quiz_report_page",
    required_capability: "mod/quiz:grade",
    avoided_routes: AVOIDED_ROUTES,
    records_learner_state: false,
    records_report_viewed_event: true,
    sesskey_sent: false,
    includes_automatically_graded: false,
    question_limit: 200,
    listed_question_rows: 2,
  },
};

const regrade = {
  schema: MOODLE_QUIZ_REGRADE_REPORT_SCHEMA,
  provider: "moodle",
  course_id: 2,
  module_id: 8,
  regraded_attempt_count: 2,
  commit_pending: true,
  proof: {
    method: "quiz_report_overview_regraded_filter",
    route: "/mod/quiz/report.php?mode=overview&onlyregraded=1",
    complete: true,
    exact_module_binding: "quiz_report_page",
    required_capability: "mod/quiz:viewreports",
    regrade_capability_marker: "onlyregraded_filter",
    avoided_routes: AVOIDED_ROUTES,
    records_learner_state: false,
    records_report_viewed_event: true,
    sesskey_sent: false,
    regrade_parameter_sent: false,
    page_size: 100,
    page_count: 1,
    attempt_limit: 1000,
  },
};

describe("Moodle Quiz attempt record projection", () => {
  it("keeps the bounded record and the Moodle user ID, and drops every other source field", () => {
    const projected = projectMoodleQuizAttemptSource({
      ...attemptBody,
      learner: { user_id: "7" },
      learner_name: "Jane Moodle",
      responses: [{ slot: 2, text: "the mitochondria is the powerhouse" }],
    }, ATTEMPT_TARGET);
    expect(projected).toEqual({ ...attemptBody, learner: { user_id: "7" } });
    expect(JSON.stringify(projected)).not.toContain("Jane Moodle");
    expect(JSON.stringify(projected)).not.toContain("mitochondria");
  });

  it("refuses a record that names another course, module, or attempt", () => {
    const value = { ...attemptBody, learner: { user_id: "7" } };
    expect(() => projectMoodleQuizAttemptSource(value, { ...ATTEMPT_TARGET, courseId: 3 })).toThrow("moodle_quiz_attempt_invalid");
    expect(() => projectMoodleQuizAttemptSource(value, { ...ATTEMPT_TARGET, moduleId: 9 })).toThrow("moodle_quiz_attempt_invalid");
    expect(() => projectMoodleQuizAttemptSource(value, { ...ATTEMPT_TARGET, attemptId: 42 })).toThrow("moodle_quiz_attempt_invalid");
  });

  it("refuses a source record without exactly one Moodle user ID", () => {
    expect(() => projectMoodleQuizAttemptSource(attemptBody, ATTEMPT_TARGET)).toThrow("moodle_quiz_attempt_invalid");
    expect(() => projectMoodleQuizAttemptSource({ ...attemptBody, learner: { user_id: "7", name: "Jane" } }, ATTEMPT_TARGET))
      .toThrow("moodle_quiz_attempt_invalid");
    expect(() => projectMoodleQuizAttemptSource({ ...attemptBody, learner: { learnerToken: TOKEN } }, ATTEMPT_TARGET))
      .toThrow("moodle_quiz_attempt_invalid");
  });

  it("refuses a public record that still carries a Moodle user ID", () => {
    expect(() => projectPublicMoodleQuizAttempt({ ...attemptBody, learner: { user_id: "7" } }, ATTEMPT_TARGET))
      .toThrow("moodle_quiz_attempt_invalid");
    expect(projectPublicMoodleQuizAttempt({ ...attemptBody, learner: { learnerToken: TOKEN } }, ATTEMPT_TARGET))
      .toEqual({ ...attemptBody, learner: { learnerToken: TOKEN } });
  });

  it("refuses a slot list that a site could not have rendered", () => {
    const withSlots = (slots: unknown[], slotCount = slots.length) => ({
      ...attemptBody, slot_count: slotCount, slots, learner: { user_id: "7" },
    });
    expect(() => projectMoodleQuizAttemptSource(withSlots([{ slot: 1, state: "graded", mark: 1, regraded: false }]), ATTEMPT_TARGET))
      .toThrow("moodle_quiz_attempt_invalid");
    expect(() => projectMoodleQuizAttemptSource(withSlots([{ slot: 2, state: "correct", mark: 1, regraded: false }, { slot: 1, state: "correct", mark: 1, regraded: false }]), ATTEMPT_TARGET))
      .toThrow("moodle_quiz_attempt_invalid");
    expect(() => projectMoodleQuizAttemptSource(withSlots([{ slot: 1, state: "correct", mark: 1, regraded: false }], 2), ATTEMPT_TARGET))
      .toThrow("moodle_quiz_attempt_invalid");
    expect(() => projectMoodleQuizAttemptSource(withSlots([{ slot: 1, state: "correct", mark: "1.00", regraded: false }]), ATTEMPT_TARGET))
      .toThrow("moodle_quiz_attempt_invalid");
  });

  it("refuses a record whose proof claims a different route or a recorded learner effect", () => {
    for (const proof of [
      { ...attemptBody.proof, records_learner_state: true },
      { ...attemptBody.proof, records_report_viewed_event: false },
      { ...attemptBody.proof, sesskey_sent: true },
      { ...attemptBody.proof, avoided_routes: "/mod/quiz/attempt.php" },
      { ...attemptBody.proof, route: "/mod/quiz/review.php" },
      { ...attemptBody.proof, required_capability: "mod/quiz:attempt" },
    ]) {
      expect(() => projectMoodleQuizAttemptSource({ ...attemptBody, proof, learner: { user_id: "7" } }, ATTEMPT_TARGET))
        .toThrow("moodle_quiz_attempt_invalid");
    }
  });

  it("refuses display text that carries markup or exceeds the bound", () => {
    expect(() => projectMoodleQuizAttemptSource({ ...attemptBody, started_display: "<b>now</b>", learner: { user_id: "7" } }, ATTEMPT_TARGET))
      .toThrow("moodle_quiz_attempt_invalid");
    expect(() => projectMoodleQuizAttemptSource({ ...attemptBody, duration_display: "x".repeat(121), learner: { user_id: "7" } }, ATTEMPT_TARGET))
      .toThrow("moodle_quiz_attempt_invalid");
    expect(projectMoodleQuizAttemptSource({ ...attemptBody, completed_display: null, learner: { user_id: "7" } }, ATTEMPT_TARGET).completed_display)
      .toBeNull();
  });
});

describe("Moodle Quiz manual grading queue projection", () => {
  it("recomputes every total from the listed questions", () => {
    const projected = projectMoodleQuizManualGradingQueue({ ...queue, learner_rows: [{ id: 7, name: "Jane Moodle" }] }, MODULE_TARGET);
    expect(projected).toEqual(queue);
    expect(JSON.stringify(projected)).not.toContain("Jane Moodle");
  });

  it("refuses totals that the listed questions contradict", () => {
    expect(() => projectMoodleQuizManualGradingQueue({ ...queue, needs_grading_count: 4 }, MODULE_TARGET))
      .toThrow("moodle_quiz_manual_grading_queue_invalid");
    expect(() => projectMoodleQuizManualGradingQueue({ ...queue, response_count: 8 }, MODULE_TARGET))
      .toThrow("moodle_quiz_manual_grading_queue_invalid");
    expect(() => projectMoodleQuizManualGradingQueue({
      ...queue,
      questions: [{ slot: 2, question_id: 55, needs_grading: 4, manually_graded: 2, total: 5 }, queue.questions[1]],
    }, MODULE_TARGET)).toThrow("moodle_quiz_manual_grading_queue_invalid");
  });

  it("accepts an empty queue and refuses a count the rows contradict", () => {
    const empty = {
      ...queue, question_count: 0, needs_grading_count: 0, manually_graded_count: 0, response_count: 0, questions: [],
      proof: { ...queue.proof, listed_question_rows: 0 },
    };
    expect(projectMoodleQuizManualGradingQueue(empty, MODULE_TARGET).question_count).toBe(0);
    expect(() => projectMoodleQuizManualGradingQueue({ ...empty, question_count: 1 }, MODULE_TARGET))
      .toThrow("moodle_quiz_manual_grading_queue_invalid");
  });

  it("refuses a queue whose proof claims the automatically graded view or another capability", () => {
    for (const proof of [
      { ...queue.proof, includes_automatically_graded: true },
      { ...queue.proof, required_capability: "mod/quiz:viewreports" },
      { ...queue.proof, route: "/mod/quiz/report.php?mode=overview" },
    ]) {
      expect(() => projectMoodleQuizManualGradingQueue({ ...queue, proof }, MODULE_TARGET))
        .toThrow("moodle_quiz_manual_grading_queue_invalid");
    }
  });
});

describe("Moodle Quiz regrade report projection", () => {
  it("keeps the record count and the pending commit offer only", () => {
    const projected = projectMoodleQuizRegradeReport({ ...regrade, attempt_ids: [51, 52] }, MODULE_TARGET);
    expect(projected).toEqual(regrade);
    expect(JSON.stringify(projected)).not.toContain("51");
  });

  it("refuses a report that does not prove the regrade filter or the read-only request", () => {
    for (const proof of [
      { ...regrade.proof, regrade_capability_marker: "role_label" },
      { ...regrade.proof, sesskey_sent: true },
      { ...regrade.proof, regrade_parameter_sent: true },
      { ...regrade.proof, complete: false },
    ]) {
      expect(() => projectMoodleQuizRegradeReport({ ...regrade, proof }, MODULE_TARGET))
        .toThrow("moodle_quiz_regrade_report_invalid");
    }
    expect(() => projectMoodleQuizRegradeReport({ ...regrade, commit_pending: "yes" }, MODULE_TARGET))
      .toThrow("moodle_quiz_regrade_report_invalid");
  });
});
