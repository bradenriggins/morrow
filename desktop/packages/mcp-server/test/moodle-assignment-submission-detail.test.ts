import { describe, expect, it } from "vitest";
import {
  MOODLE_ASSIGNMENT_FEEDBACK_SCHEMA,
  MOODLE_ASSIGNMENT_SUBMISSION_SCHEMA,
  projectMoodleAssignmentFeedbackSource,
  projectMoodleAssignmentSubmissionSource,
  projectPublicMoodleAssignmentFeedback,
  projectPublicMoodleAssignmentSubmission,
} from "../src/moodle-assignment-submission-detail.js";

const STATUS_METHOD = "mod_assign_get_submission_status";
const TOKEN = "Student A1";

const submissionBody = {
  schema: MOODLE_ASSIGNMENT_SUBMISSION_SCHEMA,
  provider: "moodle",
  course_id: 2,
  module_id: 8,
  assignment_id: 71,
  attempt: {
    attempt_number: 1,
    status: "submitted",
    time_created: 1_700_000_000,
    time_modified: 1_700_000_600,
    time_started: 1_699_999_000,
  },
  grading_status: "readyforrelease",
  locked: false,
  graded: true,
  blind_marking: false,
  extension_due_date: null,
  submission_types: [
    { type: "file", has_content: true, file_count: 1 },
    { type: "onlinetext", has_content: true, file_count: 0 },
  ],
  files: [{
    plugin_type: "file",
    area: "submission_files",
    file_name: "essay.pdf",
    file_path: "/",
    file_size: 18_321,
    mime_type: "application/pdf",
    time_modified: 1_700_000_600,
  }],
  proof: {
    method: STATUS_METHOD,
    complete: true,
    exact_module_binding: "course_modedit_form",
    required_capability: "mod/assign:viewgrades",
    submission_type_limit: 20,
    file_limit: 200,
    file_count: 1,
    includes_file_bytes: false,
  },
};

const feedbackBody = {
  schema: MOODLE_ASSIGNMENT_FEEDBACK_SCHEMA,
  provider: "moodle",
  course_id: 2,
  module_id: 8,
  assignment_id: 71,
  grading_status: "readyforrelease",
  marking_workflow_state: "readyforrelease",
  graded: true,
  grade_value: 85,
  grade_attempt_number: 1,
  graded_date: 1_700_001_200,
  feedback_types: [
    { type: "comments", comment_present: true, file_count: 0 },
    { type: "file", comment_present: false, file_count: 1 },
  ],
  files: [{
    plugin_type: "file",
    area: "feedback_files",
    file_name: "marked.pdf",
    file_path: "/",
    file_size: 4_096,
    mime_type: "application/pdf",
    time_modified: 1_700_001_200,
  }],
  proof: {
    method: STATUS_METHOD,
    complete: true,
    exact_module_binding: "course_modedit_form",
    required_capability: "mod/assign:grade",
    feedback_type_limit: 20,
    file_limit: 200,
    file_count: 1,
    includes_feedback_text: false,
    includes_file_bytes: false,
  },
};

const sourceSubmission = { ...submissionBody, learner: { user_id: "7" } };
const publicSubmission = { ...submissionBody, learner: { learnerToken: TOKEN } };
const sourceFeedback = { ...feedbackBody, learner: { user_id: "7" } };
const publicFeedback = { ...feedbackBody, learner: { learnerToken: TOKEN } };

const learnerTarget = { courseId: 2, moduleId: 8, userId: 7 };
const moduleTarget = { courseId: 2, moduleId: 8 };

describe("Moodle Assignment submission projection", () => {
  it("keeps metadata only when the browser data still carries text and file URLs", () => {
    const result = projectMoodleAssignmentSubmissionSource({
      ...sourceSubmission,
      files: [{ ...submissionBody.files[0], fileurl: "https://moodle.example.edu/pluginfile.php/99/x/essay.pdf?forcedownload=1", isexternalfile: false }],
      submission_text: "<p>Jane Moodle wrote this essay.</p>",
      gradefordisplay: "85.00 / 100.00",
    }, learnerTarget);
    expect(result).toEqual(sourceSubmission);
    const serialized = JSON.stringify(result);
    for (const value of ["pluginfile.php", "fileurl", "isexternalfile", "Jane Moodle", "gradefordisplay"]) {
      expect(serialized).not.toContain(value);
    }
  });

  it("accepts a learner with no submission record", () => {
    const result = projectMoodleAssignmentSubmissionSource({
      ...sourceSubmission,
      attempt: null,
      grading_status: "notmarked",
      graded: false,
      submission_types: [],
      files: [],
      proof: { ...submissionBody.proof, file_count: 0 },
    }, learnerTarget);
    expect(result.attempt).toBeNull();
    expect(result.files).toEqual([]);
    expect(result.grading_status).toBe("notmarked");
  });

  it("refuses a different module, a different learner, and an invented state", () => {
    expect(() => projectMoodleAssignmentSubmissionSource(sourceSubmission, { ...learnerTarget, moduleId: 9 })).toThrow("moodle_assignment_submission_invalid");
    expect(() => projectMoodleAssignmentSubmissionSource(sourceSubmission, { ...learnerTarget, userId: 8 })).toThrow("moodle_assignment_submission_invalid");
    expect(() => projectMoodleAssignmentSubmissionSource({ ...sourceSubmission, grading_status: "invented" }, learnerTarget)).toThrow("moodle_assignment_submission_invalid");
    expect(() => projectMoodleAssignmentSubmissionSource({
      ...sourceSubmission,
      attempt: { ...submissionBody.attempt, status: "returned" },
    }, learnerTarget)).toThrow("moodle_assignment_submission_invalid");
  });

  it("refuses a file list that the declared counts do not account for", () => {
    expect(() => projectMoodleAssignmentSubmissionSource({
      ...sourceSubmission,
      submission_types: [{ type: "file", has_content: true, file_count: 2 }],
    }, learnerTarget)).toThrow("moodle_assignment_submission_invalid");
    expect(() => projectMoodleAssignmentSubmissionSource({
      ...sourceSubmission,
      proof: { ...submissionBody.proof, file_count: 2 },
    }, learnerTarget)).toThrow("moodle_assignment_submission_invalid");
  });

  it("separates the source boundary from the public boundary", () => {
    expect(() => projectMoodleAssignmentSubmissionSource(publicSubmission, learnerTarget)).toThrow("moodle_assignment_submission_invalid");
    expect(() => projectPublicMoodleAssignmentSubmission(sourceSubmission, moduleTarget)).toThrow("moodle_assignment_submission_invalid");
    expect(projectPublicMoodleAssignmentSubmission(publicSubmission, moduleTarget)).toEqual(publicSubmission);
    expect(() => projectPublicMoodleAssignmentSubmission({
      ...submissionBody,
      learner: { learnerToken: TOKEN, user_id: "7" },
    }, moduleTarget)).toThrow("moodle_assignment_submission_invalid");
  });
});

describe("Moodle Assignment feedback projection", () => {
  it("keeps the grade and the presence of a comment without the comment text", () => {
    const result = projectMoodleAssignmentFeedbackSource({
      ...sourceFeedback,
      feedback_comment: "<p>Good work, Jane Moodle.</p>",
      grader: 3,
      files: [{ ...feedbackBody.files[0], fileurl: "https://moodle.example.edu/pluginfile.php/99/y/marked.pdf" }],
    }, learnerTarget);
    expect(result).toEqual(sourceFeedback);
    const serialized = JSON.stringify(result);
    for (const value of ["Jane Moodle", "feedback_comment", "grader", "pluginfile.php"]) {
      expect(serialized).not.toContain(value);
    }
  });

  it("reports no marking-workflow state when Moodle answers graded or notgraded", () => {
    const result = projectMoodleAssignmentFeedbackSource({
      ...sourceFeedback,
      grading_status: "graded",
      marking_workflow_state: null,
    }, learnerTarget);
    expect(result.grading_status).toBe("graded");
    expect(result.marking_workflow_state).toBeNull();
  });

  it("refuses a marking-workflow state that contradicts the grading status", () => {
    expect(() => projectMoodleAssignmentFeedbackSource({
      ...sourceFeedback,
      grading_status: "graded",
    }, learnerTarget)).toThrow("moodle_assignment_feedback_invalid");
    expect(() => projectMoodleAssignmentFeedbackSource({
      ...sourceFeedback,
      marking_workflow_state: "released",
    }, learnerTarget)).toThrow("moodle_assignment_feedback_invalid");
  });

  it("accepts an ungraded record and refuses a negative grade", () => {
    const ungraded = projectMoodleAssignmentFeedbackSource({
      ...sourceFeedback,
      graded: false,
      grade_value: null,
      grade_attempt_number: null,
      graded_date: null,
    }, learnerTarget);
    expect(ungraded.grade_value).toBeNull();
    expect(ungraded.graded).toBe(false);
    expect(() => projectMoodleAssignmentFeedbackSource({ ...sourceFeedback, grade_value: -1 }, learnerTarget)).toThrow("moodle_assignment_feedback_invalid");
  });

  it("separates the source boundary from the public boundary", () => {
    expect(() => projectMoodleAssignmentFeedbackSource(publicFeedback, learnerTarget)).toThrow("moodle_assignment_feedback_invalid");
    expect(() => projectPublicMoodleAssignmentFeedback(sourceFeedback, moduleTarget)).toThrow("moodle_assignment_feedback_invalid");
    expect(projectPublicMoodleAssignmentFeedback(publicFeedback, moduleTarget)).toEqual(publicFeedback);
  });
});
