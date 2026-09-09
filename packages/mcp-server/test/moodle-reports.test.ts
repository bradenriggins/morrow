import { describe, expect, it } from "vitest";
import {
  MOODLE_COURSE_ACTIVITY_REPORT_SCHEMA,
  MOODLE_COURSE_COMPLETION_REPORT_SCHEMA,
  MOODLE_COURSE_DATES_REPORT_SCHEMA,
  MOODLE_COURSE_LOG_SUMMARY_SCHEMA,
  MOODLE_COURSE_PARTICIPATION_REPORT_SCHEMA,
  moodleCourseReportReadByTool,
  projectMoodleCourseActivityReport,
  projectMoodleCourseCompletionReport,
  projectMoodleCourseDatesReport,
  projectMoodleCourseLogSummary,
  projectMoodleCourseParticipationReportSource,
  projectPublicMoodleCourseParticipationReport,
} from "../src/moodle-reports.js";

const COURSE = { courseId: 2 };
const LEARNER_TOKEN = "Student A1";
const SECOND_TOKEN = "Student A2";

const activityReport = {
  schema: MOODLE_COURSE_ACTIVITY_REPORT_SCHEMA,
  provider: "moodle",
  course_id: 2,
  activity_count: 2,
  total_view_count: 12,
  unreadable_count: 1,
  activities: [
    { module_id: 77, modname: "quiz", view_count: 12 },
    { module_id: 78, modname: "assign", view_count: null },
  ],
  proof: {
    method: "report_outline_index",
    complete: true,
    required_capability: "report/outline:view",
    activity_limit: 500,
    response_byte_limit: 2 * 1024 * 1024,
    request_count: 1,
  },
};

const participationProof = {
  method: "report_participation_index",
  complete: true,
  required_capability: "report/participation:view",
  participant_limit: 5_000,
  page_size: 2,
  page_request_limit: 100,
  page_request_count: 2,
};
const participationBody = {
  schema: MOODLE_COURSE_PARTICIPATION_REPORT_SCHEMA,
  provider: "moodle",
  course_id: 2,
  module_id: 77,
  role_id: 5,
  action: "view",
  since_days: 30,
  time_from: 1_785_000_000,
  participant_count: 2,
  performed_count: 1,
  not_performed_count: 1,
  total_action_count: 3,
  proof: participationProof,
};
const aggregateParticipation = { ...participationBody, includes_participants: false, participants: [] };
const namedParticipation = {
  ...participationBody,
  includes_participants: true,
  participants: [{ user_id: "9", action_count: 3 }, { user_id: "10", action_count: 0 }],
};
const tokenizedParticipation = {
  ...participationBody,
  includes_participants: true,
  participants: [{ learnerToken: LEARNER_TOKEN, action_count: 3 }, { learnerToken: SECOND_TOKEN, action_count: 0 }],
};

const completionReport = {
  schema: MOODLE_COURSE_COMPLETION_REPORT_SCHEMA,
  provider: "moodle",
  course_id: 2,
  participant_count: 3,
  activity_count: 1,
  activities: [{ module_id: 77, modname: "quiz", complete_count: 2, incomplete_count: 1, unreadable_count: 0 }],
  proof: {
    method: "report_progress_index",
    complete: true,
    required_capability: "report/progress:view",
    participant_limit: 5_000,
    activity_limit: 500,
    page_size: 2,
    page_request_limit: 200,
    page_request_count: 2,
  },
};

const logSummary = {
  schema: MOODLE_COURSE_LOG_SUMMARY_SCHEMA,
  provider: "moodle",
  course_id: 2,
  entry_count: 4,
  course_context_count: 1,
  other_context_count: 1,
  origin_counts: { web: 2, ws: 1, cli: 0, restore: 1, other: 0 },
  activity_counts: [{ module_id: 77, modname: "quiz", count: 2 }],
  proof: {
    method: "report_log_index",
    complete: true,
    required_capability: "report/log:view",
    entry_limit: 5_000,
    page_size: 3,
    page_request_limit: 50,
    page_request_count: 2,
    omitted_columns: ["time", "user", "related_user", "component", "event_name", "description", "ip_address", "user_agent"],
  },
};

const datesReport = {
  schema: MOODLE_COURSE_DATES_REPORT_SCHEMA,
  provider: "moodle",
  course_id: 2,
  first_month: "2026-09",
  last_month: "2026-10",
  months: 2,
  dated_entry_count: 3,
  course_event_count: 1,
  unattributed_activity_event_count: 0,
  skipped_event_count: 1,
  month_counts: [{ month: "2026-09", count: 2 }, { month: "2026-10", count: 1 }],
  activity_counts: [
    { module_id: 77, modname: "quiz", count: 1 },
    { module_id: 78, modname: "assign", count: 1 },
  ],
  proof: {
    method: "core_calendar_get_calendar_monthly_view",
    complete: true,
    required_capability: null,
    access_rule: "course_calendar_visibility",
    event_limit: 2_000,
    month_limit: 12,
    request_count: 2,
  },
};

describe("Moodle course-report projections", () => {
  it("registers each report read with its own operation, schema and error prefix", () => {
    for (const [tool, prefix, learnerRows] of [
      ["moodle_get_course_activity_report", "moodle_course_activity_report", false],
      ["moodle_get_course_participation_report", "moodle_course_participation_report", true],
      ["moodle_get_course_completion_report", "moodle_course_completion_report", false],
      ["moodle_get_course_log_summary", "moodle_course_log_summary", false],
      ["moodle_get_course_dates_report", "moodle_course_dates_report", false],
    ] as const) {
      const read = moodleCourseReportReadByTool(tool);
      expect(read, tool).not.toBeNull();
      expect(read?.prefix).toBe(prefix);
      expect(read?.learnerRows).toBe(learnerRows);
      expect(read?.operation.startsWith("moodle.form.report.")).toBe(true);
    }
    expect(moodleCourseReportReadByTool("moodle_get_course_participants")).toBeNull();
  });

  it("rebuilds the activity report and drops a field the browser added", () => {
    const projected = projectMoodleCourseActivityReport(
      { ...activityReport, activities: [{ ...activityReport.activities[0], last_access: "2 September 2026" }, activityReport.activities[1]] },
      COURSE,
    );
    expect(projected).toEqual(activityReport);
    expect(JSON.stringify(projected)).not.toContain("last_access");
  });

  it("refuses an activity report whose totals its own rows contradict", () => {
    expect(() => projectMoodleCourseActivityReport({ ...activityReport, total_view_count: 13 }, COURSE))
      .toThrow("moodle_course_activity_report_invalid");
    expect(() => projectMoodleCourseActivityReport({ ...activityReport, activity_count: 3 }, COURSE))
      .toThrow("moodle_course_activity_report_invalid");
    expect(() => projectMoodleCourseActivityReport(activityReport, { courseId: 5 }))
      .toThrow("moodle_course_activity_report_invalid");
  });

  it("keeps the participation report aggregate unless it says it names people", () => {
    expect(projectMoodleCourseParticipationReportSource(aggregateParticipation, COURSE)).toEqual(aggregateParticipation);
    // A report that says it names nobody may not carry a row, and one that says
    // it names people must carry one row for every person it counted.
    expect(() => projectMoodleCourseParticipationReportSource({ ...aggregateParticipation, participants: [{ user_id: "9", action_count: 3 }] }, COURSE))
      .toThrow("moodle_course_participation_report_invalid");
    expect(() => projectMoodleCourseParticipationReportSource({ ...namedParticipation, participants: [namedParticipation.participants[0]] }, COURSE))
      .toThrow("moodle_course_participation_report_invalid");
  });

  it("carries the Moodle user ID through the browser projection and refuses any other row field", () => {
    const projected = projectMoodleCourseParticipationReportSource(namedParticipation, COURSE);
    expect(projected).toEqual(namedParticipation);
    expect(projected.participants).toEqual([{ user_id: "9", action_count: 3 }, { user_id: "10", action_count: 0 }]);
    // A learner row that carries anything beyond the identity and the count is
    // refused, so a name the page held cannot ride along with the identity.
    expect(() => projectMoodleCourseParticipationReportSource(
      { ...namedParticipation, participants: namedParticipation.participants.map((entry) => ({ ...entry, fullname: "Jane Learner" })) },
      COURSE,
    )).toThrow("moodle_course_participation_report_invalid");
  });

  it("accepts only a tokenized participation report at the public boundary", () => {
    expect(projectPublicMoodleCourseParticipationReport(tokenizedParticipation, COURSE)).toEqual(tokenizedParticipation);
    // A value that still carries a Moodle user ID did not come through the
    // roster boundary and is refused rather than returned.
    expect(() => projectPublicMoodleCourseParticipationReport(namedParticipation, COURSE))
      .toThrow("moodle_course_participation_report_invalid");
    expect(() => projectPublicMoodleCourseParticipationReport(
      { ...tokenizedParticipation, participants: [{ learnerToken: "learner_not-a-uuid", action_count: 3 }, tokenizedParticipation.participants[1]] },
      COURSE,
    )).toThrow("moodle_course_participation_report_invalid");
  });

  it("rebuilds the completion report and requires each activity to account for every person", () => {
    expect(projectMoodleCourseCompletionReport(completionReport, COURSE)).toEqual(completionReport);
    expect(() => projectMoodleCourseCompletionReport(
      { ...completionReport, activities: [{ ...completionReport.activities[0], unreadable_count: 1 }] },
      COURSE,
    )).toThrow("moodle_course_completion_report_invalid");
  });

  it("rebuilds the log summary and has no field for an IP address or a user agent", () => {
    const projected = projectMoodleCourseLogSummary(
      { ...logSummary, ip_addresses: ["203.0.113.44"], user_agents: ["Mozilla/5.0"], entries: [{ description: "viewed" }] },
      COURSE,
    );
    expect(projected).toEqual(logSummary);
    const text = JSON.stringify(projected);
    for (const value of ["203.0.113.44", "Mozilla/5.0", "ip_addresses", "user_agents", "entries", "viewed"]) {
      expect(text, `the log summary carried ${value}`).not.toContain(value);
    }
  });

  it("refuses a log summary whose contexts do not account for every entry", () => {
    expect(() => projectMoodleCourseLogSummary({ ...logSummary, other_context_count: 0 }, COURSE))
      .toThrow("moodle_course_log_summary_invalid");
    expect(() => projectMoodleCourseLogSummary(
      { ...logSummary, origin_counts: { ...logSummary.origin_counts, web: 1 } },
      COURSE,
    )).toThrow("moodle_course_log_summary_invalid");
  });

  it("rebuilds the dates report as counts and refuses one whose months do not add up", () => {
    const projected = projectMoodleCourseDatesReport(
      { ...datesReport, events: [{ event_id: 501, name: "Quiz 1 closes", time_start: 1_788_000_000 }] },
      COURSE,
    );
    expect(projected).toEqual(datesReport);
    // The report is counts only, so an event list the browser added carries no
    // name and no instant through this boundary.
    const text = JSON.stringify(projected);
    for (const value of ["Quiz 1 closes", "1788000000", "events", "time_start"]) {
      expect(text, `the dates report carried ${value}`).not.toContain(value);
    }
    expect(() => projectMoodleCourseDatesReport(
      { ...datesReport, month_counts: [{ month: "2026-09", count: 1 }, { month: "2026-10", count: 1 }] },
      COURSE,
    )).toThrow("moodle_course_dates_report_invalid");
    expect(() => projectMoodleCourseDatesReport({ ...datesReport, course_event_count: 2 }, COURSE))
      .toThrow("moodle_course_dates_report_invalid");
    expect(() => projectMoodleCourseDatesReport({ ...datesReport, months: 3 }, COURSE))
      .toThrow("moodle_course_dates_report_invalid");
  });

  it("refuses a report whose proof does not state its own route, capability and bounds", () => {
    expect(() => projectMoodleCourseActivityReport(
      { ...activityReport, proof: { ...activityReport.proof, required_capability: "moodle/course:view" } },
      COURSE,
    )).toThrow("moodle_course_activity_report_invalid");
    expect(() => projectMoodleCourseLogSummary(
      { ...logSummary, proof: { ...logSummary.proof, omitted_columns: ["time"] } },
      COURSE,
    )).toThrow("moodle_course_log_summary_invalid");
    expect(() => projectMoodleCourseCompletionReport(
      { ...completionReport, proof: { ...completionReport.proof, page_request_count: 0 } },
      COURSE,
    )).toThrow("moodle_course_completion_report_invalid");
    expect(() => projectMoodleCourseDatesReport(
      { ...datesReport, proof: { ...datesReport.proof, required_capability: "report/log:view" } },
      COURSE,
    )).toThrow("moodle_course_dates_report_invalid");
  });
});
