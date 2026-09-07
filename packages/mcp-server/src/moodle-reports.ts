import { isJsonObject, type JsonObject } from "@morrow/contracts";

/**
 * Projections for Moodle's own course reports.
 *
 * Each projection rebuilds its result from fixed fields, so a field the browser
 * added cannot reach MCP egress. Four of the five reports are aggregate only:
 * they carry counts and course-module identifiers and no learner identity of
 * any kind. The participation report is the one report that can name the people
 * it lists, and it does so only when the request asked for it; the identity
 * survives the browser projection as `user_id` so the runtime can project it
 * through the complete course participant roster, and the public projection
 * accepts a learner token and refuses a value that still carries a Moodle user
 * ID.
 *
 * Moodle's log table renders an IP address column, and a log store can add a
 * user agent column of its own. Neither is part of the log summary shape here,
 * so neither can be accepted from a browser result.
 */

export const MOODLE_COURSE_ACTIVITY_REPORT_OPERATION = "moodle.form.report.activity.read.v1";
export const MOODLE_COURSE_ACTIVITY_REPORT_TOOL = "moodle_get_course_activity_report";
export const MOODLE_COURSE_ACTIVITY_REPORT_SCHEMA = "morrow.moodle-course-activity-report.v1";

export const MOODLE_COURSE_PARTICIPATION_REPORT_OPERATION = "moodle.form.report.participation.read.v1";
export const MOODLE_COURSE_PARTICIPATION_REPORT_TOOL = "moodle_get_course_participation_report";
export const MOODLE_COURSE_PARTICIPATION_REPORT_SCHEMA = "morrow.moodle-course-participation-report.v1";

export const MOODLE_COURSE_COMPLETION_REPORT_OPERATION = "moodle.form.report.completion.read.v1";
export const MOODLE_COURSE_COMPLETION_REPORT_TOOL = "moodle_get_course_completion_report";
export const MOODLE_COURSE_COMPLETION_REPORT_SCHEMA = "morrow.moodle-course-completion-report.v1";

export const MOODLE_COURSE_LOG_SUMMARY_OPERATION = "moodle.form.report.log_summary.read.v1";
export const MOODLE_COURSE_LOG_SUMMARY_TOOL = "moodle_get_course_log_summary";
export const MOODLE_COURSE_LOG_SUMMARY_SCHEMA = "morrow.moodle-course-log-summary.v1";

export const MOODLE_COURSE_DATES_REPORT_OPERATION = "moodle.form.report.dates.read.v1";
export const MOODLE_COURSE_DATES_REPORT_TOOL = "moodle_get_course_dates_report";
export const MOODLE_COURSE_DATES_REPORT_SCHEMA = "morrow.moodle-course-dates-report.v1";

const ACTIVITY_METHOD = "report_outline_index";
const PARTICIPATION_METHOD = "report_participation_index";
const COMPLETION_METHOD = "report_progress_index";
const LOG_METHOD = "report_log_index";
const DATES_METHOD = "core_calendar_get_calendar_monthly_view";

const ACTIVITY_CAPABILITY = "report/outline:view";
const PARTICIPATION_CAPABILITY = "report/participation:view";
const COMPLETION_CAPABILITY = "report/progress:view";
const LOG_CAPABILITY = "report/log:view";

const RESPONSE_BYTE_LIMIT = 2 * 1024 * 1024;
const ACTIVITY_LIMIT = 500;
const PARTICIPANT_LIMIT = 5_000;
const PARTICIPATION_PAGE_LIMIT = 100;
const COMPLETION_PAGE_LIMIT = 200;
const LOG_ENTRY_LIMIT = 5_000;
const LOG_PAGE_LIMIT = 50;
const MONTH_LIMIT = 12;
const EVENT_LIMIT = 2_000;
const SINCE_DAY_LIMIT = 365;
const VIEW_COUNT_LIMIT = 1_000_000_000;

const LOG_ORIGINS = ["web", "ws", "cli", "restore", "other"] as const;
const LOG_OMITTED_COLUMNS = [
  "time", "user", "related_user", "component", "event_name", "description", "ip_address", "user_agent",
] as const;
const PARTICIPATION_ACTIONS = ["view", "post"] as const;
const MODNAME = /^[a-z][a-z0-9_]{0,30}$/u;
const MONTH_LABEL = /^[0-9]{4}-(?:0[1-9]|1[0-2])$/u;
const LEARNER_TOKEN = /^learner_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type MoodleCourseReportExpectation = Readonly<{ courseId: number }>;

export type MoodleCourseReportRead = Readonly<{
  operation: string;
  tool: string;
  schema: string;
  /** The error prefix the runtime raises for this read. */
  prefix: string;
  /** True when the browser result can carry a learner identity the roster must resolve. */
  learnerRows: boolean;
  summary: string;
  project: (value: unknown, expected: MoodleCourseReportExpectation) => JsonObject;
  /** Present only for a read whose public shape differs from the browser shape. */
  projectPublic?: (value: unknown, expected: MoodleCourseReportExpectation) => JsonObject;
}>;

function positiveId(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function count(value: unknown, maximum: number): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum ? Number(value) : null;
}

function header(value: unknown, schema: string, expected: MoodleCourseReportExpectation, error: string): JsonObject {
  if (!isJsonObject(value) || value.schema !== schema || value.provider !== "moodle"
    || positiveId(value.course_id) !== expected.courseId) throw new Error(error);
  return value;
}

function proofOf(
  value: JsonObject,
  method: string,
  capability: string | null,
  extra: Readonly<Record<string, unknown>>,
  error: string,
): JsonObject {
  const proof = isJsonObject(value.proof) ? value.proof : null;
  if (!proof || proof.method !== method || proof.complete !== true
    || (proof.required_capability ?? null) !== capability) throw new Error(error);
  for (const [key, entry] of Object.entries(extra)) {
    if (Array.isArray(entry)) {
      const actual = proof[key];
      if (!Array.isArray(actual) || actual.length !== entry.length
        || actual.some((item, index) => item !== entry[index])) throw new Error(error);
      continue;
    }
    if (proof[key] !== entry) throw new Error(error);
  }
  return { method, complete: true, required_capability: capability, ...structuredClone(extra) } as JsonObject;
}

/** The paging counters a paged report must state, re-validated against its own bounds. */
function pagingOf(
  value: JsonObject,
  pageLimit: number,
  rowLimit: number,
  error: string,
): Readonly<{ page_size: number; page_request_count: number }> {
  const proof = isJsonObject(value.proof) ? value.proof : null;
  const pageSize = proof ? count(proof.page_size, rowLimit) : null;
  const requestCount = proof ? count(proof.page_request_count, pageLimit) : null;
  if (pageSize === null || requestCount === null || requestCount < 1) throw new Error(error);
  return { page_size: pageSize, page_request_count: requestCount };
}

function moduleRows(
  value: unknown,
  limit: number,
  error: string,
  row: (source: JsonObject, moduleId: number, modname: string) => JsonObject,
): JsonObject[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(error);
  const rows = value.map((entry) => {
    const source = isJsonObject(entry) ? entry : null;
    const moduleId = source ? positiveId(source.module_id) : null;
    const modname = source && typeof source.modname === "string" && MODNAME.test(source.modname) ? source.modname : null;
    if (!source || !moduleId || !modname) throw new Error(error);
    return row(source, moduleId, modname);
  });
  if (new Set(rows.map((entry) => entry.module_id)).size !== rows.length) throw new Error(error);
  return rows;
}

/**
 * The bounded aggregate activity report: one row per activity with the view
 * count Moodle's own outline report rendered. It carries no learner identity,
 * because the outline report itself lists none.
 */
export function projectMoodleCourseActivityReport(
  value: unknown,
  expected: MoodleCourseReportExpectation,
): JsonObject {
  const error = "moodle_course_activity_report_invalid";
  const source = header(value, MOODLE_COURSE_ACTIVITY_REPORT_SCHEMA, expected, error);
  const activityCount = count(source.activity_count, ACTIVITY_LIMIT);
  const totalViews = count(source.total_view_count, Number.MAX_SAFE_INTEGER);
  const unreadable = count(source.unreadable_count, ACTIVITY_LIMIT);
  if (activityCount === null || totalViews === null || unreadable === null
    || !Array.isArray(source.activities) || source.activities.length !== activityCount) throw new Error(error);
  let summed = 0;
  const activities = moduleRows(source.activities, ACTIVITY_LIMIT, error, (entry, moduleId, modname) => {
    const views = entry.view_count === null ? null : count(entry.view_count, VIEW_COUNT_LIMIT);
    if (entry.view_count !== null && views === null) throw new Error(error);
    summed += views ?? 0;
    return { module_id: moduleId, modname, view_count: views };
  });
  const missing = activities.filter((entry) => entry.view_count === null).length;
  if (summed !== totalViews || unreadable > missing) throw new Error(error);
  return {
    schema: MOODLE_COURSE_ACTIVITY_REPORT_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    activity_count: activityCount,
    total_view_count: totalViews,
    unreadable_count: unreadable,
    activities,
    proof: proofOf(source, ACTIVITY_METHOD, ACTIVITY_CAPABILITY, {
      activity_limit: ACTIVITY_LIMIT,
      response_byte_limit: RESPONSE_BYTE_LIMIT,
      request_count: 1,
    }, error),
  };
}

function participationBody(
  value: unknown,
  expected: MoodleCourseReportExpectation,
  error: string,
): Readonly<{ body: JsonObject; participantCount: number; includes: boolean; rows: readonly unknown[] }> {
  const source = header(value, MOODLE_COURSE_PARTICIPATION_REPORT_SCHEMA, expected, error);
  const moduleId = positiveId(source.module_id);
  const roleId = positiveId(source.role_id);
  const action = typeof source.action === "string" && (PARTICIPATION_ACTIONS as readonly string[]).includes(source.action)
    ? source.action
    : null;
  const sinceDays = count(source.since_days, SINCE_DAY_LIMIT);
  const timeFrom = count(source.time_from, Number.MAX_SAFE_INTEGER);
  const participantCount = count(source.participant_count, PARTICIPANT_LIMIT);
  const performed = participantCount === null ? null : count(source.performed_count, participantCount);
  const notPerformed = participantCount === null ? null : count(source.not_performed_count, participantCount);
  const totalActions = count(source.total_action_count, Number.MAX_SAFE_INTEGER);
  const includes = source.includes_participants;
  if (!moduleId || !roleId || action === null || sinceDays === null || sinceDays < 1 || timeFrom === null
    || participantCount === null || performed === null || notPerformed === null || totalActions === null
    || typeof includes !== "boolean"
    || performed + notPerformed !== participantCount || !Array.isArray(source.participants)) throw new Error(error);
  if (!includes && source.participants.length !== 0) throw new Error(error);
  if (includes && source.participants.length !== participantCount) throw new Error(error);
  return {
    participantCount,
    includes,
    rows: source.participants,
    body: {
      schema: MOODLE_COURSE_PARTICIPATION_REPORT_SCHEMA,
      provider: "moodle",
      course_id: expected.courseId,
      module_id: moduleId,
      role_id: roleId,
      action,
      since_days: sinceDays,
      time_from: timeFrom,
      participant_count: participantCount,
      performed_count: performed,
      not_performed_count: notPerformed,
      total_action_count: totalActions,
      includes_participants: includes,
      proof: proofOf(source, PARTICIPATION_METHOD, PARTICIPATION_CAPABILITY, {
        participant_limit: PARTICIPANT_LIMIT,
        ...pagingOf(source, PARTICIPATION_PAGE_LIMIT, PARTICIPANT_LIMIT, error),
        page_request_limit: PARTICIPATION_PAGE_LIMIT,
      }, error),
    },
  };
}

function participationCount(entry: unknown, error: string): number {
  const source = isJsonObject(entry) ? entry : null;
  const actions = source ? count(source.action_count, Number.MAX_SAFE_INTEGER) : null;
  if (!source || actions === null) throw new Error(error);
  return actions;
}

/**
 * Rebuilds the browser participation report. When the request asked for the
 * people it lists, each identity survives this step as `user_id` only, so the
 * runtime can project it through the complete course participant roster.
 */
export function projectMoodleCourseParticipationReportSource(
  value: unknown,
  expected: MoodleCourseReportExpectation,
): JsonObject {
  const error = "moodle_course_participation_report_invalid";
  const { body, rows } = participationBody(value, expected, error);
  const participants = rows.map((entry) => {
    const source = isJsonObject(entry) ? entry : null;
    const userId = source && typeof source.user_id === "string" ? positiveId(Number(source.user_id)) : null;
    if (!source || !userId || Object.keys(source).length !== 2) throw new Error(error);
    return { user_id: source.user_id as string, action_count: participationCount(source, error) };
  });
  if (new Set(participants.map((entry) => entry.user_id)).size !== participants.length) throw new Error(error);
  return { ...body, participants };
}

/**
 * Re-validates a participation report that already carries the public shape.
 * That shape holds a vault token and no Moodle user ID, so a value that still
 * carries an identifier did not come from the roster boundary and is refused.
 */
export function projectPublicMoodleCourseParticipationReport(
  value: unknown,
  expected: MoodleCourseReportExpectation,
): JsonObject {
  const error = "moodle_course_participation_report_invalid";
  const { body, rows } = participationBody(value, expected, error);
  const participants = rows.map((entry) => {
    const source = isJsonObject(entry) ? entry : null;
    const token = source && typeof source.learnerToken === "string" && LEARNER_TOKEN.test(source.learnerToken)
      ? source.learnerToken
      : null;
    if (!source || !token || Object.keys(source).length !== 2) throw new Error(error);
    return { learnerToken: token, action_count: participationCount(source, error) };
  });
  if (new Set(participants.map((entry) => entry.learnerToken)).size !== participants.length) throw new Error(error);
  return { ...body, participants };
}

/**
 * The bounded aggregate activity-completion report: per activity, how many of
 * the listed people Moodle shows as complete, how many as incomplete, and how
 * many cells this read could not state. It carries no learner row.
 */
export function projectMoodleCourseCompletionReport(
  value: unknown,
  expected: MoodleCourseReportExpectation,
): JsonObject {
  const error = "moodle_course_completion_report_invalid";
  const source = header(value, MOODLE_COURSE_COMPLETION_REPORT_SCHEMA, expected, error);
  const participantCount = count(source.participant_count, PARTICIPANT_LIMIT);
  const activityCount = count(source.activity_count, ACTIVITY_LIMIT);
  if (participantCount === null || activityCount === null || activityCount < 1
    || !Array.isArray(source.activities) || source.activities.length !== activityCount) throw new Error(error);
  const activities = moduleRows(source.activities, ACTIVITY_LIMIT, error, (entry, moduleId, modname) => {
    const complete = count(entry.complete_count, participantCount);
    const incomplete = count(entry.incomplete_count, participantCount);
    const unreadable = count(entry.unreadable_count, participantCount);
    if (complete === null || incomplete === null || unreadable === null
      || complete + incomplete + unreadable !== participantCount) throw new Error(error);
    return {
      module_id: moduleId,
      modname,
      complete_count: complete,
      incomplete_count: incomplete,
      unreadable_count: unreadable,
    };
  });
  return {
    schema: MOODLE_COURSE_COMPLETION_REPORT_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    participant_count: participantCount,
    activity_count: activityCount,
    activities,
    proof: proofOf(source, COMPLETION_METHOD, COMPLETION_CAPABILITY, {
      participant_limit: PARTICIPANT_LIMIT,
      activity_limit: ACTIVITY_LIMIT,
      ...pagingOf(source, COMPLETION_PAGE_LIMIT, PARTICIPANT_LIMIT, error),
      page_request_limit: COMPLETION_PAGE_LIMIT,
    }, error),
  };
}

/**
 * The bounded aggregate log summary. It holds counts by request origin and by
 * activity context only. The shape has no field for a time, a user, an event
 * description, an IP address, or a user agent, so a browser result cannot bring
 * one through.
 */
export function projectMoodleCourseLogSummary(
  value: unknown,
  expected: MoodleCourseReportExpectation,
): JsonObject {
  const error = "moodle_course_log_summary_invalid";
  const source = header(value, MOODLE_COURSE_LOG_SUMMARY_SCHEMA, expected, error);
  const entryCount = count(source.entry_count, LOG_ENTRY_LIMIT);
  const courseContext = entryCount === null ? null : count(source.course_context_count, entryCount);
  const otherContext = entryCount === null ? null : count(source.other_context_count, entryCount);
  const origins = isJsonObject(source.origin_counts) ? source.origin_counts : null;
  if (entryCount === null || courseContext === null || otherContext === null
    || !origins || Object.keys(origins).length !== LOG_ORIGINS.length) throw new Error(error);
  const originCounts: Record<string, number> = {};
  let originTotal = 0;
  for (const origin of LOG_ORIGINS) {
    const entry = count(origins[origin], entryCount);
    if (entry === null) throw new Error(error);
    originCounts[origin] = entry;
    originTotal += entry;
  }
  if (originTotal !== entryCount) throw new Error(error);
  let activityTotal = 0;
  const activityCounts = moduleRows(source.activity_counts, ACTIVITY_LIMIT, error, (entry, moduleId, modname) => {
    const entryTotal = count(entry.count, entryCount);
    if (entryTotal === null) throw new Error(error);
    activityTotal += entryTotal;
    return { module_id: moduleId, modname, count: entryTotal };
  });
  if (activityTotal + courseContext + otherContext !== entryCount) throw new Error(error);
  return {
    schema: MOODLE_COURSE_LOG_SUMMARY_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    entry_count: entryCount,
    course_context_count: courseContext,
    other_context_count: otherContext,
    origin_counts: originCounts,
    activity_counts: activityCounts,
    proof: proofOf(source, LOG_METHOD, LOG_CAPABILITY, {
      entry_limit: LOG_ENTRY_LIMIT,
      ...pagingOf(source, LOG_PAGE_LIMIT, LOG_ENTRY_LIMIT, error),
      page_request_limit: LOG_PAGE_LIMIT,
      omitted_columns: [...LOG_OMITTED_COLUMNS],
    }, error),
  };
}

/**
 * The bounded course dates report. Moodle 5.2.2 ships no core dates report, so
 * this read counts the entries in the course calendar month by month. It holds
 * counts only: no date and no event name, because a civil date needs the
 * signed-in person's time zone and `moodle_list_course_events` already reports
 * each entry with the civil values Moodle itself rendered. A personal or group
 * entry is counted as skipped in the page world and never counted as a date.
 */
export function projectMoodleCourseDatesReport(
  value: unknown,
  expected: MoodleCourseReportExpectation,
): JsonObject {
  const error = "moodle_course_dates_report_invalid";
  const source = header(value, MOODLE_COURSE_DATES_REPORT_SCHEMA, expected, error);
  const months = count(source.months, MONTH_LIMIT);
  const dated = count(source.dated_entry_count, EVENT_LIMIT);
  const courseEvents = dated === null ? null : count(source.course_event_count, dated);
  const unattributed = dated === null ? null : count(source.unattributed_activity_event_count, dated);
  const skipped = count(source.skipped_event_count, EVENT_LIMIT);
  const firstMonth = typeof source.first_month === "string" && MONTH_LABEL.test(source.first_month) ? source.first_month : null;
  const lastMonth = typeof source.last_month === "string" && MONTH_LABEL.test(source.last_month) ? source.last_month : null;
  if (months === null || months < 1 || dated === null || courseEvents === null || unattributed === null
    || skipped === null || !firstMonth || !lastMonth
    || !Array.isArray(source.month_counts) || source.month_counts.length !== months) throw new Error(error);
  let monthTotal = 0;
  const monthCounts = source.month_counts.map((entry) => {
    const record = isJsonObject(entry) ? entry : null;
    const label = record && typeof record.month === "string" && MONTH_LABEL.test(record.month) ? record.month : null;
    const monthEntries = record ? count(record.count, dated) : null;
    if (!record || !label || monthEntries === null || Object.keys(record).length !== 2) throw new Error(error);
    monthTotal += monthEntries;
    return { month: label, count: monthEntries };
  });
  if (monthTotal !== dated || monthCounts.at(0)?.month !== firstMonth
    || monthCounts.at(-1)?.month !== lastMonth) throw new Error(error);
  let activityTotal = 0;
  const activityCounts = moduleRows(source.activity_counts, ACTIVITY_LIMIT, error, (entry, moduleId, modname) => {
    const entryTotal = count(entry.count, dated);
    if (entryTotal === null) throw new Error(error);
    activityTotal += entryTotal;
    return { module_id: moduleId, modname, count: entryTotal };
  });
  if (activityTotal + courseEvents + unattributed !== dated) throw new Error(error);
  return {
    schema: MOODLE_COURSE_DATES_REPORT_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    first_month: firstMonth,
    last_month: lastMonth,
    months,
    dated_entry_count: dated,
    course_event_count: courseEvents,
    unattributed_activity_event_count: unattributed,
    skipped_event_count: skipped,
    month_counts: monthCounts,
    activity_counts: activityCounts,
    proof: proofOf(source, DATES_METHOD, null, {
      access_rule: "course_calendar_visibility",
      event_limit: EVENT_LIMIT,
      month_limit: MONTH_LIMIT,
      request_count: months,
    }, error),
  };
}

const READS: readonly MoodleCourseReportRead[] = [
  {
    operation: MOODLE_COURSE_ACTIVITY_REPORT_OPERATION,
    tool: MOODLE_COURSE_ACTIVITY_REPORT_TOOL,
    schema: MOODLE_COURSE_ACTIVITY_REPORT_SCHEMA,
    prefix: "moodle_course_activity_report",
    learnerRows: false,
    summary: "Morrow read the aggregate Moodle activity report for this course.",
    project: projectMoodleCourseActivityReport,
  },
  {
    operation: MOODLE_COURSE_PARTICIPATION_REPORT_OPERATION,
    tool: MOODLE_COURSE_PARTICIPATION_REPORT_TOOL,
    schema: MOODLE_COURSE_PARTICIPATION_REPORT_SCHEMA,
    prefix: "moodle_course_participation_report",
    learnerRows: true,
    summary: "Morrow read the Moodle participation report for one exact activity.",
    project: projectMoodleCourseParticipationReportSource,
    projectPublic: projectPublicMoodleCourseParticipationReport,
  },
  {
    operation: MOODLE_COURSE_COMPLETION_REPORT_OPERATION,
    tool: MOODLE_COURSE_COMPLETION_REPORT_TOOL,
    schema: MOODLE_COURSE_COMPLETION_REPORT_SCHEMA,
    prefix: "moodle_course_completion_report",
    learnerRows: false,
    summary: "Morrow read the aggregate Moodle activity completion report for this course.",
    project: projectMoodleCourseCompletionReport,
  },
  {
    operation: MOODLE_COURSE_LOG_SUMMARY_OPERATION,
    tool: MOODLE_COURSE_LOG_SUMMARY_TOOL,
    schema: MOODLE_COURSE_LOG_SUMMARY_SCHEMA,
    prefix: "moodle_course_log_summary",
    learnerRows: false,
    summary: "Morrow read the aggregate Moodle course log summary.",
    project: projectMoodleCourseLogSummary,
  },
  {
    operation: MOODLE_COURSE_DATES_REPORT_OPERATION,
    tool: MOODLE_COURSE_DATES_REPORT_TOOL,
    schema: MOODLE_COURSE_DATES_REPORT_SCHEMA,
    prefix: "moodle_course_dates_report",
    learnerRows: false,
    summary: "Morrow read the dated Moodle calendar entries for this course.",
    project: projectMoodleCourseDatesReport,
  },
];

export function moodleCourseReportReadByTool(toolName: unknown): MoodleCourseReportRead | null {
  return READS.find((entry) => entry.tool === toolName) ?? null;
}

export function projectMoodleCourseReportBrowserResult(
  read: MoodleCourseReportRead,
  browserData: unknown,
  expected: MoodleCourseReportExpectation,
): JsonObject {
  return read.project(browserData, expected);
}

export function projectPublicMoodleCourseReportResult(
  read: MoodleCourseReportRead,
  publicData: unknown,
  expected: MoodleCourseReportExpectation,
): JsonObject {
  return (read.projectPublic ?? read.project)(publicData, expected);
}
