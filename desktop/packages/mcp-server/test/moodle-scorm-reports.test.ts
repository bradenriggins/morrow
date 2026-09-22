import { describe, expect, it } from "vitest";
import {
  MOODLE_SCORM_ATTEMPT_SUMMARY_SCHEMA,
  MOODLE_SCORM_LEARNER_REPORT_SCHEMA,
  projectMoodleScormAttemptSummary,
  projectMoodleScormLearnerReportSource,
  projectPublicMoodleScormLearnerReport,
} from "../src/moodle-scorm-reports.js";

const SUMMARY_METHOD = "core_table_get_dynamic_table_content+mod_scorm_get_scorm_scoes+mod_scorm_get_scorm_attempt_count+mod_scorm_get_scorm_sco_tracks";
const REPORT_METHOD = "mod_scorm_get_scorm_scoes+mod_scorm_get_scorm_attempt_count+mod_scorm_get_scorm_sco_tracks";
const TOKEN = "Student A1";

const aggregate = {
  schema: MOODLE_SCORM_ATTEMPT_SUMMARY_SCHEMA,
  provider: "moodle",
  course_id: 2,
  module_id: 8,
  scorm_id: 71,
  participant_count: 2,
  attempted_participant_count: 2,
  total_attempt_count: 3,
  tracked_sco_count: 2,
  tracked_record_count: 6,
  sco_status_counts: { passed: 1, completed: 1, failed: 1, incomplete: 1, browsed: 1, notattempted: 1, unknown: 0 },
  score_bucket_counts: { "0-19": 0, "20-39": 1, "40-59": 1, "60-79": 1, "80-100": 1, unscored: 2 },
  proof: {
    method: SUMMARY_METHOD,
    complete: true,
    exact_module_binding: "course_modedit_form",
    required_capability: "mod/scorm:viewreport",
    participant_limit: 10_000,
    participant_response_rows: 2,
    sco_limit: 200,
    per_participant_attempt_limit: 50,
    total_attempt_limit: 5_000,
    track_request_limit: 2_000,
    track_request_count: 6,
  },
};

const reportBody = {
  schema: MOODLE_SCORM_LEARNER_REPORT_SCHEMA,
  provider: "moodle",
  course_id: 2,
  module_id: 8,
  scorm_id: 71,
  attempt_count: 2,
  tracked_sco_count: 2,
  attempts: [
    { attempt: 1, records: [{ sco_id: 31, status: "completed", score_percent: 90 }, { sco_id: 33, status: "incomplete", score_percent: null }] },
    { attempt: 2, records: [{ sco_id: 31, status: "passed", score_percent: 55 }, { sco_id: 33, status: "notattempted", score_percent: null }] },
  ],
  proof: {
    method: REPORT_METHOD,
    complete: true,
    exact_module_binding: "course_modedit_form",
    required_capability: "mod/scorm:viewreport",
    attempt_limit: 50,
    sco_limit: 200,
    track_request_limit: 500,
    track_request_count: 4,
  },
};

const sourceReport = { ...reportBody, learner: { user_id: "7" } };
const publicReport = { ...reportBody, learner: { learnerToken: TOKEN } };

describe("Moodle SCORM attempt-summary projection", () => {
  it("keeps only aggregate fields when browser data still carries SCORM tracks", () => {
    const result = projectMoodleScormAttemptSummary({
      ...aggregate,
      raw_roster: [{ id: 7, fullname: "Jane Moodle", email: "jane@example.edu" }],
      raw_tracks: [{ element: "cmi.core.student_name", value: "Moodle, Jane" }, { element: "cmi.suspend_data", value: "private suspend data" }],
    }, { courseId: 2, moduleId: 8 });
    expect(result).toEqual(aggregate);
    const serialized = JSON.stringify(result);
    for (const privateValue of ["Jane Moodle", "jane@example.edu", "Moodle, Jane", "private suspend data", "cmi."]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("refuses a changed target, an incomplete proof, and counts that do not add up", () => {
    expect(() => projectMoodleScormAttemptSummary({ ...aggregate, module_id: 9 }, { courseId: 2, moduleId: 8 }))
      .toThrow("moodle_scorm_attempt_summary_invalid");
    expect(() => projectMoodleScormAttemptSummary({ ...aggregate, proof: { ...aggregate.proof, complete: false } }, { courseId: 2, moduleId: 8 }))
      .toThrow("moodle_scorm_attempt_summary_invalid");
    expect(() => projectMoodleScormAttemptSummary({ ...aggregate, sco_status_counts: { ...aggregate.sco_status_counts, unknown: 1 } }, { courseId: 2, moduleId: 8 }))
      .toThrow("moodle_scorm_attempt_summary_invalid");
    expect(() => projectMoodleScormAttemptSummary({ ...aggregate, score_bucket_counts: { ...aggregate.score_bucket_counts, unscored: 1 } }, { courseId: 2, moduleId: 8 }))
      .toThrow("moodle_scorm_attempt_summary_invalid");
    expect(() => projectMoodleScormAttemptSummary({ ...aggregate, attempted_participant_count: 3 }, { courseId: 2, moduleId: 8 }))
      .toThrow("moodle_scorm_attempt_summary_invalid");
    expect(() => projectMoodleScormAttemptSummary({ ...aggregate, proof: { ...aggregate.proof, track_request_count: 5 } }, { courseId: 2, moduleId: 8 }))
      .toThrow("moodle_scorm_attempt_summary_invalid");
  });
});

describe("Moodle SCORM learner-report projection", () => {
  it("carries exactly one requested identity and drops every raw SCORM value", () => {
    const result = projectMoodleScormLearnerReportSource({
      ...sourceReport,
      raw_tracks: [{ element: "cmi.suspend_data", value: "private suspend data" }],
      learner_email: "jane@example.edu",
    }, { courseId: 2, moduleId: 8, userId: 7 });
    expect(result).toEqual(sourceReport);
    const serialized = JSON.stringify(result);
    for (const privateValue of ["jane@example.edu", "private suspend data", "cmi."]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("refuses a different learner, a different module, and a malformed record", () => {
    expect(() => projectMoodleScormLearnerReportSource(sourceReport, { courseId: 2, moduleId: 8, userId: 8 }))
      .toThrow("moodle_scorm_learner_report_invalid");
    expect(() => projectMoodleScormLearnerReportSource(sourceReport, { courseId: 2, moduleId: 9, userId: 7 }))
      .toThrow("moodle_scorm_learner_report_invalid");
    expect(() => projectMoodleScormLearnerReportSource({ ...sourceReport, learner: { user_id: "7", name: "Jane Moodle" } }, { courseId: 2, moduleId: 8, userId: 7 }))
      .toThrow("moodle_scorm_learner_report_invalid");
    expect(() => projectMoodleScormLearnerReportSource({
      ...sourceReport,
      attempts: [sourceReport.attempts[0]!, { attempt: 2, records: [{ sco_id: 31, status: "mystery", score_percent: null }, { sco_id: 33, status: "passed", score_percent: null }] }],
    }, { courseId: 2, moduleId: 8, userId: 7 })).toThrow("moodle_scorm_learner_report_invalid");
    expect(() => projectMoodleScormLearnerReportSource({
      ...sourceReport,
      attempts: [sourceReport.attempts[0]!, { attempt: 2, records: [{ sco_id: 31, status: "passed", score_percent: 101 }, { sco_id: 33, status: "passed", score_percent: null }] }],
    }, { courseId: 2, moduleId: 8, userId: 7 })).toThrow("moodle_scorm_learner_report_invalid");
    expect(() => projectMoodleScormLearnerReportSource({ ...sourceReport, attempt_count: 1 }, { courseId: 2, moduleId: 8, userId: 7 }))
      .toThrow("moodle_scorm_learner_report_invalid");
  });

  it("accepts only a vault token at egress and refuses a report that still carries a user ID", () => {
    expect(projectPublicMoodleScormLearnerReport(publicReport, { courseId: 2, moduleId: 8 })).toEqual(publicReport);
    expect(() => projectPublicMoodleScormLearnerReport(sourceReport, { courseId: 2, moduleId: 8 }))
      .toThrow("moodle_scorm_learner_report_invalid");
    expect(() => projectPublicMoodleScormLearnerReport({ ...publicReport, learner: { learnerToken: TOKEN, user_id: "7" } }, { courseId: 2, moduleId: 8 }))
      .toThrow("moodle_scorm_learner_report_invalid");
    expect(() => projectPublicMoodleScormLearnerReport({ ...publicReport, learner: { learnerToken: "7" } }, { courseId: 2, moduleId: 8 }))
      .toThrow("moodle_scorm_learner_report_invalid");
    expect(() => projectPublicMoodleScormLearnerReport({ ...publicReport, proof: { ...reportBody.proof, complete: false } }, { courseId: 2, moduleId: 8 }))
      .toThrow("moodle_scorm_learner_report_invalid");
  });
});
