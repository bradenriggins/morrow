import { describe, expect, it } from "vitest";
import {
  MOODLE_QUIZ_ATTEMPT_SUMMARY_SCHEMA,
  projectMoodleQuizAttemptSummary,
} from "../src/moodle-quiz-attempt-summaries.js";

const aggregate = {
  schema: MOODLE_QUIZ_ATTEMPT_SUMMARY_SCHEMA,
  provider: "moodle",
  course_id: 2,
  module_id: 8,
  quiz_id: 71,
  participant_count: 2,
  total_attempt_count: 3,
  attempt_state_counts: { notstarted: 0, inprogress: 1, overdue: 0, submitted: 1, finished: 1, abandoned: 0 },
  proof: {
    method: "core_table_get_dynamic_table_content+mod_quiz_get_user_quiz_attempts",
    complete: true,
    exact_module_binding: "course_modedit_form",
    participant_page_size: 50,
    participant_response_rows: 2,
    per_participant_attempt_limit: 50,
    total_attempt_limit: 500,
    attempt_response_rows: 3,
    attempt_request_count: 2,
  },
};

describe("Moodle Quiz attempt-summary projection", () => {
  it("keeps only aggregate fields when browser data includes learner attempts", () => {
    const result = projectMoodleQuizAttemptSummary({
      ...aggregate,
      raw_roster: [{ id: 7, fullname: "Jane Moodle", email: "jane@example.edu" }],
      raw_attempts: [{ id: 501, userid: 7, sumgrades: 100, answers: "private answer", feedback: "private feedback" }],
    }, { courseId: 2, moduleId: 8 });
    expect(result).toEqual(aggregate);
    expect(JSON.stringify(result)).not.toContain("Jane Moodle");
    expect(JSON.stringify(result)).not.toContain("private answer");
    expect(JSON.stringify(result)).not.toContain('"id":501');
  });

  it("refuses a changed scope, incomplete proof, and inconsistent state counts", () => {
    expect(() => projectMoodleQuizAttemptSummary({ ...aggregate, module_id: 9 }, { courseId: 2, moduleId: 8 }))
      .toThrow("moodle_quiz_attempt_summary_invalid");
    expect(() => projectMoodleQuizAttemptSummary({ ...aggregate, proof: { ...aggregate.proof, complete: false } }, { courseId: 2, moduleId: 8 }))
      .toThrow("moodle_quiz_attempt_summary_invalid");
    expect(() => projectMoodleQuizAttemptSummary({ ...aggregate, attempt_state_counts: { ...aggregate.attempt_state_counts, finished: 2 } }, { courseId: 2, moduleId: 8 }))
      .toThrow("moodle_quiz_attempt_summary_invalid");
    expect(() => projectMoodleQuizAttemptSummary({ ...aggregate, raw_roster: [{ id: 7, name: "Jane Moodle" }], participant_count: 51 }, { courseId: 2, moduleId: 8 }))
      .toThrow("moodle_quiz_attempt_summary_invalid");
  });
});
