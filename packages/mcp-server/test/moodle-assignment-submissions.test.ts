import { describe, expect, it } from "vitest";
import {
  MOODLE_ASSIGNMENT_SUBMISSION_SUMMARY_SCHEMA,
  projectMoodleAssignmentSubmissionSummary,
} from "../src/moodle-assignment-submissions.js";

const aggregate = {
  schema: MOODLE_ASSIGNMENT_SUBMISSION_SUMMARY_SCHEMA,
  provider: "moodle",
  course_id: 2,
  module_id: 8,
  assignment_id: 70,
  participant_count: 4,
  submitted_count: 1,
  requires_grading_count: 2,
  granted_extension_count: 1,
  submission_status_counts: { new: 1, reopened: 1, draft: 1, submitted: 1 },
  proof: {
    method: "mod_assign_list_participants",
    complete: true,
    exact_module_binding: "course_modedit_form",
    requested_limit: 0,
    response_row_count: 4,
  },
};

describe("Moodle Assignment submission-summary projection", () => {
  it("keeps only aggregate fields when browser data includes learner information", () => {
    const result = projectMoodleAssignmentSubmissionSummary({
      ...aggregate,
      raw_rows: [{ id: 7, fullname: "Jane Moodle", grade: 100, commenttext: "private feedback", url: "https://example.edu/submission/7" }],
      learner: { id: 7, name: "Jane Moodle" },
    }, { courseId: 2, moduleId: 8 });
    expect(result).toEqual(aggregate);
    expect(JSON.stringify(result)).not.toContain("Jane Moodle");
    expect(JSON.stringify(result)).not.toContain("private feedback");
    expect(JSON.stringify(result)).not.toContain('"id":7');
  });

  it("refuses a changed target, incomplete proof, and inconsistent aggregates", () => {
    expect(() => projectMoodleAssignmentSubmissionSummary({ ...aggregate, course_id: 3 }, { courseId: 2, moduleId: 8 }))
      .toThrow("moodle_assignment_submission_summary_invalid");
    expect(() => projectMoodleAssignmentSubmissionSummary({ ...aggregate, proof: { ...aggregate.proof, complete: false } }, { courseId: 2, moduleId: 8 }))
      .toThrow("moodle_assignment_submission_summary_invalid");
    expect(() => projectMoodleAssignmentSubmissionSummary({ ...aggregate, submission_status_counts: { new: 1, reopened: 1, draft: 1, submitted: 0 } }, { courseId: 2, moduleId: 8 }))
      .toThrow("moodle_assignment_submission_summary_invalid");
    expect(() => projectMoodleAssignmentSubmissionSummary({ ...aggregate, submitted_count: 5 }, { courseId: 2, moduleId: 8 }))
      .toThrow("moodle_assignment_submission_summary_invalid");
  });
});
