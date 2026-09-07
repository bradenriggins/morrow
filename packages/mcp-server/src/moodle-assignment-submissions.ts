import { isJsonObject, type JsonObject } from "@morrow/contracts";

export const MOODLE_ASSIGNMENT_SUBMISSION_SUMMARY_OPERATION = "moodle.form.assign.submissions.read.v1";
export const MOODLE_ASSIGNMENT_SUBMISSION_SUMMARY_TOOL = "moodle_get_assignment_submission_summary";
export const MOODLE_ASSIGNMENT_SUBMISSION_SUMMARY_SCHEMA = "morrow.moodle-assignment-submission-summary.v1";

export type MoodleAssignmentSubmissionSummary = Readonly<{
  schema: typeof MOODLE_ASSIGNMENT_SUBMISSION_SUMMARY_SCHEMA;
  provider: "moodle";
  course_id: number;
  module_id: number;
  assignment_id: number;
  participant_count: number;
  submitted_count: number;
  requires_grading_count: number;
  granted_extension_count: number;
  submission_status_counts: Readonly<{ new: number; reopened: number; draft: number; submitted: number }>;
  proof: Readonly<{
    method: "mod_assign_list_participants";
    complete: true;
    exact_module_binding: "course_modedit_form";
    requested_limit: 0;
    response_row_count: number;
  }>;
}>;

export type MoodleAssignmentSubmissionSummaryExpectation = Readonly<{ courseId: number; moduleId: number }>;

function positiveId(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function count(value: unknown, participantCount: number): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= participantCount ? Number(value) : null;
}

/**
 * Creates the only public representation allowed for the browser's aggregate
 * Assignment response. It ignores unknown source fields so learner rows cannot
 * cross the MCP boundary when a site returns additional data.
 */
export function projectMoodleAssignmentSubmissionSummary(
  value: unknown,
  expected: MoodleAssignmentSubmissionSummaryExpectation,
): MoodleAssignmentSubmissionSummary {
  if (!isJsonObject(value) || value.schema !== MOODLE_ASSIGNMENT_SUBMISSION_SUMMARY_SCHEMA || value.provider !== "moodle"
    || positiveId(value.course_id) !== expected.courseId || positiveId(value.module_id) !== expected.moduleId) {
    throw new Error("moodle_assignment_submission_summary_invalid");
  }
  const participantCount = count(value.participant_count, 10_000);
  const assignmentId = positiveId(value.assignment_id);
  const submittedCount = participantCount === null ? null : count(value.submitted_count, participantCount);
  const requiresGradingCount = participantCount === null ? null : count(value.requires_grading_count, participantCount);
  const grantedExtensionCount = participantCount === null ? null : count(value.granted_extension_count, participantCount);
  const statuses = isJsonObject(value.submission_status_counts) ? value.submission_status_counts : null;
  const proof = isJsonObject(value.proof) ? value.proof : null;
  if (participantCount === null || !assignmentId || submittedCount === null || requiresGradingCount === null || grantedExtensionCount === null
    || !statuses || !proof || Object.keys(statuses).length !== 4
    || proof.method !== "mod_assign_list_participants" || proof.complete !== true
    || proof.exact_module_binding !== "course_modedit_form" || proof.requested_limit !== 0
    || proof.response_row_count !== participantCount) {
    throw new Error("moodle_assignment_submission_summary_invalid");
  }
  const statusCounts = {
    new: count(statuses.new, participantCount),
    reopened: count(statuses.reopened, participantCount),
    draft: count(statuses.draft, participantCount),
    submitted: count(statuses.submitted, participantCount),
  };
  if (Object.values(statusCounts).some((entry) => entry === null)
    || statusCounts.new! + statusCounts.reopened! + statusCounts.draft! + statusCounts.submitted! !== participantCount) {
    throw new Error("moodle_assignment_submission_summary_invalid");
  }
  return {
    schema: MOODLE_ASSIGNMENT_SUBMISSION_SUMMARY_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    module_id: expected.moduleId,
    assignment_id: assignmentId,
    participant_count: participantCount,
    submitted_count: submittedCount,
    requires_grading_count: requiresGradingCount,
    granted_extension_count: grantedExtensionCount,
    submission_status_counts: {
      new: statusCounts.new!, reopened: statusCounts.reopened!, draft: statusCounts.draft!, submitted: statusCounts.submitted!,
    },
    proof: {
      method: "mod_assign_list_participants",
      complete: true,
      exact_module_binding: "course_modedit_form",
      requested_limit: 0,
      response_row_count: participantCount,
    },
  };
}

export function projectMoodleAssignmentSubmissionSummaryBrowserResult(
  browserData: unknown,
  expected: MoodleAssignmentSubmissionSummaryExpectation,
): JsonObject {
  return projectMoodleAssignmentSubmissionSummary(browserData, expected) as JsonObject;
}
