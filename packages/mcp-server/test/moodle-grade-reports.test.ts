import { describe, expect, it } from "vitest";
import {
  MOODLE_GRADE_REPORT_SUMMARY_SCHEMA,
  MOODLE_LEARNER_GRADE_REPORT_SCHEMA,
  projectMoodleGradeReportSummary,
  projectMoodleLearnerGradeReportSource,
  projectPublicMoodleLearnerGradeReport,
} from "../src/moodle-grade-reports.js";

const CAPABILITIES = ["gradereport/grader:view", "moodle/grade:viewall"];
const LEARNER_TOKEN = "learner_0f2b7c41-9a3d-4e51-8b6c-1d2e3f4a5b6c";

const quizItem = {
  item_id: 200,
  kind: "item",
  graded_count: 3,
  ungraded_count: 0,
  unreadable_count: 0,
  percent_source: "percentage_display",
  statistics: { mean: "60-79", median: "60-79", minimum: "40-59", maximum: "80-100" },
  statistics_unavailable: null,
};
const courseTotalItem = {
  item_id: 300,
  kind: "course_total",
  graded_count: 1,
  ungraded_count: 2,
  unreadable_count: 0,
  percent_source: "range_row",
  statistics: { mean: "60-79", median: "60-79", minimum: "60-79", maximum: "60-79" },
  statistics_unavailable: null,
};
const aggregate = {
  schema: MOODLE_GRADE_REPORT_SUMMARY_SCHEMA,
  provider: "moodle",
  course_id: 2,
  participant_count: 3,
  grade_item_count: 2,
  items: [quizItem, courseTotalItem],
  proof: {
    method: "grade_report_grader_index",
    complete: true,
    required_capabilities: CAPABILITIES,
    participant_limit: 10_000,
    participant_response_rows: 3,
    grade_item_limit: 500,
    page_size: 3,
    page_request_limit: 500,
    page_request_count: 1,
  },
};

const gradedCell = { item_id: 200, kind: "item", state: "graded", percent: 80, percent_source: "percentage_display" };
const ungradedCell = { item_id: 300, kind: "course_total", state: "ungraded", percent: null, percent_source: null };
const learnerBody = {
  schema: MOODLE_LEARNER_GRADE_REPORT_SCHEMA,
  provider: "moodle",
  course_id: 2,
  grade_item_count: 2,
  items: [gradedCell, ungradedCell],
  proof: {
    method: "grade_report_grader_index",
    complete: true,
    required_capabilities: CAPABILITIES,
    participant_limit: 10_000,
    grade_item_limit: 500,
    page_request_limit: 500,
    page_request_count: 1,
  },
};

describe("Moodle grade-report-summary projection", () => {
  it("keeps only counts and bands when the browser data carries learner rows and grades", () => {
    const result = projectMoodleGradeReportSummary({
      ...aggregate,
      raw_rows: [{ user_id: 7, fullname: "Jane Moodle", email: "jane@example.edu", grades: ["80.00", "105.00"] }],
    }, { courseId: 2 });
    expect(result).toEqual(aggregate);
    const text = JSON.stringify(result);
    for (const privateValue of ["Jane Moodle", "jane@example.edu", "80.00", "105.00", "user_id", "raw_rows"]) {
      expect(text, `the summary leaked ${privateValue}`).not.toContain(privateValue);
    }
  });

  it("refuses a changed course, an incomplete proof, a short capability list, and an unsupported band", () => {
    expect(() => projectMoodleGradeReportSummary(aggregate, { courseId: 3 }))
      .toThrow("moodle_grade_report_summary_invalid");
    expect(() => projectMoodleGradeReportSummary({ ...aggregate, proof: { ...aggregate.proof, complete: false } }, { courseId: 2 }))
      .toThrow("moodle_grade_report_summary_invalid");
    expect(() => projectMoodleGradeReportSummary({ ...aggregate, proof: { ...aggregate.proof, required_capabilities: ["gradereport/grader:view"] } }, { courseId: 2 }))
      .toThrow("moodle_grade_report_summary_invalid");
    expect(() => projectMoodleGradeReportSummary({
      ...aggregate,
      items: [{ ...quizItem, statistics: { ...quizItem.statistics, mean: 72 } }, courseTotalItem],
    }, { courseId: 2 })).toThrow("moodle_grade_report_summary_invalid");
  });

  it("refuses counts that do not add up to the participant count and a repeated grade item", () => {
    expect(() => projectMoodleGradeReportSummary({
      ...aggregate,
      items: [{ ...quizItem, graded_count: 2 }, courseTotalItem],
    }, { courseId: 2 })).toThrow("moodle_grade_report_summary_invalid");
    expect(() => projectMoodleGradeReportSummary({ ...aggregate, items: [quizItem, quizItem] }, { courseId: 2 }))
      .toThrow("moodle_grade_report_summary_invalid");
  });

  it("refuses a band that the browser also said it could not derive", () => {
    expect(() => projectMoodleGradeReportSummary({
      ...aggregate,
      items: [{ ...quizItem, statistics_unavailable: "unreadable_cells" }, courseTotalItem],
    }, { courseId: 2 })).toThrow("moodle_grade_report_summary_invalid");
  });

  it("accepts a stated reason in place of a band", () => {
    const unreadable = {
      item_id: 200, kind: "item", graded_count: 2, ungraded_count: 0, unreadable_count: 1,
      percent_source: null, statistics: null, statistics_unavailable: "unreadable_cells",
    };
    const result = projectMoodleGradeReportSummary({ ...aggregate, items: [unreadable, courseTotalItem] }, { courseId: 2 });
    expect(result.items).toEqual([unreadable, courseTotalItem]);
  });
});

describe("Moodle learner-grade-report projection", () => {
  it("carries the requested identity alone into the roster boundary", () => {
    const result = projectMoodleLearnerGradeReportSource({
      ...learnerBody,
      learner: { user_id: "7" },
      learner_name: "Jane Moodle",
      raw_cells: [{ item_id: 200, value: "80.00", feedback: "private feedback" }],
    }, { courseId: 2, userId: 7 });
    expect(result).toEqual({ ...learnerBody, learner: { user_id: "7" } });
    const text = JSON.stringify(result);
    for (const privateValue of ["Jane Moodle", "80.00", "private feedback", "raw_cells"]) {
      expect(text, `the learner report leaked ${privateValue}`).not.toContain(privateValue);
    }
    // The identity record itself must hold the Moodle user ID and nothing else.
    expect(() => projectMoodleLearnerGradeReportSource({
      ...learnerBody,
      learner: { user_id: "7", fullname: "Jane Moodle" },
    }, { courseId: 2, userId: 7 })).toThrow("moodle_learner_grade_report_invalid");
  });

  it("refuses an identity that is not the requested learner and a report without one", () => {
    expect(() => projectMoodleLearnerGradeReportSource({ ...learnerBody, learner: { user_id: "8" } }, { courseId: 2, userId: 7 }))
      .toThrow("moodle_learner_grade_report_invalid");
    expect(() => projectMoodleLearnerGradeReportSource(learnerBody, { courseId: 2, userId: 7 }))
      .toThrow("moodle_learner_grade_report_invalid");
  });

  it("refuses a value on an item the report did not grade, and a value with no stated source", () => {
    expect(() => projectMoodleLearnerGradeReportSource({
      ...learnerBody,
      learner: { user_id: "7" },
      items: [gradedCell, { ...ungradedCell, percent: 100, percent_source: "range_row" }],
    }, { courseId: 2, userId: 7 })).toThrow("moodle_learner_grade_report_invalid");
    expect(() => projectMoodleLearnerGradeReportSource({
      ...learnerBody,
      learner: { user_id: "7" },
      items: [{ ...gradedCell, percent_source: null }, ungradedCell],
    }, { courseId: 2, userId: 7 })).toThrow("moodle_learner_grade_report_invalid");
  });

  it("requires a vault token, never a Moodle user ID, in the public shape", () => {
    expect(projectPublicMoodleLearnerGradeReport({ ...learnerBody, learner: { learnerToken: LEARNER_TOKEN } }, { courseId: 2 }))
      .toEqual({ ...learnerBody, learner: { learnerToken: LEARNER_TOKEN } });
    expect(() => projectPublicMoodleLearnerGradeReport({ ...learnerBody, learner: { user_id: "7" } }, { courseId: 2 }))
      .toThrow("moodle_learner_grade_report_invalid");
    expect(() => projectPublicMoodleLearnerGradeReport({ ...learnerBody, learner: { learnerToken: "learner_7" } }, { courseId: 2 }))
      .toThrow("moodle_learner_grade_report_invalid");
  });
});
