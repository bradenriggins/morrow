import { isJsonObject, type JsonObject } from "@morrow/contracts";

export const MOODLE_GRADE_REPORT_SUMMARY_OPERATION = "moodle.form.grade.report.summary.read.v1";
export const MOODLE_GRADE_REPORT_SUMMARY_TOOL = "moodle_get_grade_report_summary";
export const MOODLE_GRADE_REPORT_SUMMARY_SCHEMA = "morrow.moodle-grade-report-summary.v1";

export const MOODLE_LEARNER_GRADE_REPORT_OPERATION = "moodle.form.grade.report.learner.read.v1";
export const MOODLE_LEARNER_GRADE_REPORT_TOOL = "moodle_get_learner_grade_report";
export const MOODLE_LEARNER_GRADE_REPORT_SCHEMA = "morrow.moodle-learner-grade-report.v1";

const METHOD = "grade_report_grader_index";
const REQUIRED_CAPABILITIES = ["gradereport/grader:view", "moodle/grade:viewall"] as const;
const PARTICIPANT_LIMIT = 10_000;
const GRADE_ITEM_LIMIT = 500;
const PAGE_REQUEST_LIMIT = 500;

/** The three grade-item kinds the grader report's own column classes name. */
const KINDS = ["item", "category_total", "course_total"] as const;
/** Percentage bands. The bridge returns a band so no grade value leaves the page. */
const BUCKETS = ["0-19", "20-39", "40-59", "60-79", "80-100"] as const;
/** How the browser derived a percentage from the rendered grader report. */
const PERCENT_SOURCES = ["percentage_display", "range_row"] as const;
/** The exact reasons the browser can state instead of a statistic. */
const STATISTICS_UNAVAILABLE = ["unreadable_cells", "no_graded_values", "grade_values_not_numeric"] as const;
const STATES = ["graded", "ungraded", "unreadable"] as const;
const LEARNER_TOKEN = /^Student A[1-9][0-9]*$/u;

type GradeItemKind = (typeof KINDS)[number];
type GradeBucket = (typeof BUCKETS)[number];
type PercentSource = (typeof PERCENT_SOURCES)[number];
type StatisticsUnavailable = (typeof STATISTICS_UNAVAILABLE)[number];
type GradeItemState = (typeof STATES)[number];

export type MoodleGradeReportItemSummary = Readonly<{
  item_id: number;
  kind: GradeItemKind;
  graded_count: number;
  ungraded_count: number;
  unreadable_count: number;
  percent_source: PercentSource | null;
  statistics: Readonly<{ mean: GradeBucket; median: GradeBucket; minimum: GradeBucket; maximum: GradeBucket }> | null;
  statistics_unavailable: StatisticsUnavailable | null;
}>;

export type MoodleGradeReportSummary = Readonly<{
  schema: typeof MOODLE_GRADE_REPORT_SUMMARY_SCHEMA;
  provider: "moodle";
  course_id: number;
  participant_count: number;
  grade_item_count: number;
  items: readonly MoodleGradeReportItemSummary[];
  proof: Readonly<{
    method: typeof METHOD;
    complete: true;
    required_capabilities: readonly [string, string];
    participant_limit: typeof PARTICIPANT_LIMIT;
    participant_response_rows: number;
    grade_item_limit: typeof GRADE_ITEM_LIMIT;
    page_size: number;
    page_request_limit: typeof PAGE_REQUEST_LIMIT;
    page_request_count: number;
  }>;
}>;

export type MoodleLearnerGradeReportItem = Readonly<{
  item_id: number;
  kind: GradeItemKind;
  state: GradeItemState;
  percent: number | null;
  percent_source: PercentSource | null;
}>;

type MoodleLearnerGradeReportBody = Readonly<{
  schema: typeof MOODLE_LEARNER_GRADE_REPORT_SCHEMA;
  provider: "moodle";
  course_id: number;
  grade_item_count: number;
  items: readonly MoodleLearnerGradeReportItem[];
  proof: Readonly<{
    method: typeof METHOD;
    complete: true;
    required_capabilities: readonly [string, string];
    participant_limit: typeof PARTICIPANT_LIMIT;
    grade_item_limit: typeof GRADE_ITEM_LIMIT;
    page_request_limit: typeof PAGE_REQUEST_LIMIT;
    page_request_count: number;
  }>;
}>;

/** The browser shape, before the runtime projects the identity through the roster. */
export type MoodleLearnerGradeReportSource = MoodleLearnerGradeReportBody & Readonly<{
  learner: Readonly<{ user_id: string }>;
}>;

/** The only public shape. The learner identity exists here as a vault token only. */
export type MoodleLearnerGradeReport = MoodleLearnerGradeReportBody & Readonly<{
  learner: Readonly<{ learnerToken: string }>;
}>;

export type MoodleGradeReportSummaryExpectation = Readonly<{ courseId: number }>;
export type MoodleLearnerGradeReportExpectation = Readonly<{ courseId: number; userId: number }>;

function positiveId(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function count(value: unknown, maximum: number): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum ? Number(value) : null;
}

function member<Value extends string>(value: unknown, allowed: readonly Value[]): Value | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as Value) : null;
}

function capabilities(value: unknown): boolean {
  return Array.isArray(value) && value.length === REQUIRED_CAPABILITIES.length
    && REQUIRED_CAPABILITIES.every((capability, index) => value[index] === capability);
}

function summaryItem(value: unknown, participantCount: number, error: string): MoodleGradeReportItemSummary {
  const source = isJsonObject(value) ? value : null;
  const itemId = source ? positiveId(source.item_id) : null;
  const kind = source ? member(source.kind, KINDS) : null;
  const graded = source ? count(source.graded_count, participantCount) : null;
  const ungraded = source ? count(source.ungraded_count, participantCount) : null;
  const unreadable = source ? count(source.unreadable_count, participantCount) : null;
  if (!source || !itemId || !kind || graded === null || ungraded === null || unreadable === null
    || graded + ungraded + unreadable !== participantCount) {
    throw new Error(error);
  }
  const unavailable = source.statistics_unavailable === null
    ? null
    : member(source.statistics_unavailable, STATISTICS_UNAVAILABLE);
  if (source.statistics_unavailable !== null && unavailable === null) throw new Error(error);
  // A statistic and a stated reason are exclusive: the browser returns one or
  // the other, so a result can never carry a band it could not derive.
  if (unavailable !== null) {
    if (source.statistics !== null || source.percent_source !== null) throw new Error(error);
    return {
      item_id: itemId,
      kind,
      graded_count: graded,
      ungraded_count: ungraded,
      unreadable_count: unreadable,
      percent_source: null,
      statistics: null,
      statistics_unavailable: unavailable,
    };
  }
  const statistics = isJsonObject(source.statistics) ? source.statistics : null;
  const percentSource = member(source.percent_source, PERCENT_SOURCES);
  const mean = statistics ? member(statistics.mean, BUCKETS) : null;
  const median = statistics ? member(statistics.median, BUCKETS) : null;
  const minimum = statistics ? member(statistics.minimum, BUCKETS) : null;
  const maximum = statistics ? member(statistics.maximum, BUCKETS) : null;
  if (!statistics || !percentSource || !mean || !median || !minimum || !maximum
    || Object.keys(statistics).length !== 4 || graded === 0 || unreadable !== 0) {
    throw new Error(error);
  }
  return {
    item_id: itemId,
    kind,
    graded_count: graded,
    ungraded_count: ungraded,
    unreadable_count: unreadable,
    percent_source: percentSource,
    statistics: { mean, median, minimum, maximum },
    statistics_unavailable: null,
  };
}

/**
 * Creates the only public representation allowed for a Moodle grader-report
 * aggregate. The grader report is a whole-course table of learner rows and
 * grade values; this projection rebuilds counts and percentage bands from fixed
 * fields, so no learner row and no grade value can reach MCP egress.
 */
export function projectMoodleGradeReportSummary(
  value: unknown,
  expected: MoodleGradeReportSummaryExpectation,
): MoodleGradeReportSummary {
  const error = "moodle_grade_report_summary_invalid";
  if (!isJsonObject(value) || value.schema !== MOODLE_GRADE_REPORT_SUMMARY_SCHEMA || value.provider !== "moodle"
    || positiveId(value.course_id) !== expected.courseId) {
    throw new Error(error);
  }
  const participantCount = count(value.participant_count, PARTICIPANT_LIMIT);
  const gradeItemCount = count(value.grade_item_count, GRADE_ITEM_LIMIT);
  const proof = isJsonObject(value.proof) ? value.proof : null;
  if (participantCount === null || gradeItemCount === null || !Array.isArray(value.items)
    || value.items.length !== gradeItemCount || !proof) {
    throw new Error(error);
  }
  const pageSize = count(proof.page_size, participantCount);
  const pageRequestCount = count(proof.page_request_count, PAGE_REQUEST_LIMIT);
  if (proof.method !== METHOD || proof.complete !== true || !capabilities(proof.required_capabilities)
    || proof.participant_limit !== PARTICIPANT_LIMIT || proof.participant_response_rows !== participantCount
    || proof.grade_item_limit !== GRADE_ITEM_LIMIT || proof.page_request_limit !== PAGE_REQUEST_LIMIT
    || pageSize === null || pageRequestCount === null || pageRequestCount < 1) {
    throw new Error(error);
  }
  const items = value.items.map((item) => summaryItem(item, participantCount, error));
  if (new Set(items.map((item) => item.item_id)).size !== items.length) throw new Error(error);
  return {
    schema: MOODLE_GRADE_REPORT_SUMMARY_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    participant_count: participantCount,
    grade_item_count: gradeItemCount,
    items,
    proof: {
      method: METHOD,
      complete: true,
      required_capabilities: [REQUIRED_CAPABILITIES[0], REQUIRED_CAPABILITIES[1]],
      participant_limit: PARTICIPANT_LIMIT,
      participant_response_rows: participantCount,
      grade_item_limit: GRADE_ITEM_LIMIT,
      page_size: pageSize,
      page_request_limit: PAGE_REQUEST_LIMIT,
      page_request_count: pageRequestCount,
    },
  };
}

export function projectMoodleGradeReportSummaryBrowserResult(
  browserData: unknown,
  expected: MoodleGradeReportSummaryExpectation,
): JsonObject {
  return projectMoodleGradeReportSummary(browserData, expected) as unknown as JsonObject;
}

function learnerReportItem(value: unknown, error: string): MoodleLearnerGradeReportItem {
  const source = isJsonObject(value) ? value : null;
  const itemId = source ? positiveId(source.item_id) : null;
  const kind = source ? member(source.kind, KINDS) : null;
  const state = source ? member(source.state, STATES) : null;
  if (!source || !itemId || !kind || !state) throw new Error(error);
  if (source.percent === null) {
    if (source.percent_source !== null) throw new Error(error);
    return { item_id: itemId, kind, state, percent: null, percent_source: null };
  }
  const percent = count(source.percent, 100);
  const percentSource = member(source.percent_source, PERCENT_SOURCES);
  // Only a graded item can carry a value, and a value must name where it came
  // from, so an ungraded or unreadable cell can never read as a score.
  if (percent === null || !percentSource || state !== "graded") throw new Error(error);
  return { item_id: itemId, kind, state, percent, percent_source: percentSource };
}

function learnerReportBody(value: JsonObject, expected: Readonly<{ courseId: number }>): MoodleLearnerGradeReportBody {
  const error = "moodle_learner_grade_report_invalid";
  if (value.schema !== MOODLE_LEARNER_GRADE_REPORT_SCHEMA || value.provider !== "moodle"
    || positiveId(value.course_id) !== expected.courseId) {
    throw new Error(error);
  }
  const gradeItemCount = count(value.grade_item_count, GRADE_ITEM_LIMIT);
  const proof = isJsonObject(value.proof) ? value.proof : null;
  if (gradeItemCount === null || !Array.isArray(value.items) || value.items.length !== gradeItemCount || !proof) {
    throw new Error(error);
  }
  const pageRequestCount = count(proof.page_request_count, PAGE_REQUEST_LIMIT);
  if (proof.method !== METHOD || proof.complete !== true || !capabilities(proof.required_capabilities)
    || proof.participant_limit !== PARTICIPANT_LIMIT || proof.grade_item_limit !== GRADE_ITEM_LIMIT
    || proof.page_request_limit !== PAGE_REQUEST_LIMIT || pageRequestCount === null || pageRequestCount < 1) {
    throw new Error(error);
  }
  const items = value.items.map((item) => learnerReportItem(item, error));
  if (new Set(items.map((item) => item.item_id)).size !== items.length) throw new Error(error);
  return {
    schema: MOODLE_LEARNER_GRADE_REPORT_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    grade_item_count: gradeItemCount,
    items,
    proof: {
      method: METHOD,
      complete: true,
      required_capabilities: [REQUIRED_CAPABILITIES[0], REQUIRED_CAPABILITIES[1]],
      participant_limit: PARTICIPANT_LIMIT,
      grade_item_limit: GRADE_ITEM_LIMIT,
      page_request_limit: PAGE_REQUEST_LIMIT,
      page_request_count: pageRequestCount,
    },
  };
}

/**
 * Rebuilds the browser result for one requested learner. The identity survives
 * this step as `learner.user_id` only so the runtime can project it through the
 * complete course roster; nothing else from the source is carried.
 */
export function projectMoodleLearnerGradeReportSource(
  value: unknown,
  expected: MoodleLearnerGradeReportExpectation,
): MoodleLearnerGradeReportSource {
  const error = "moodle_learner_grade_report_invalid";
  if (!isJsonObject(value)) throw new Error(error);
  const learner = isJsonObject(value.learner) ? value.learner : null;
  if (!learner || Object.keys(learner).length !== 1
    || typeof learner.user_id !== "string" || positiveId(Number(learner.user_id)) !== expected.userId) {
    throw new Error(error);
  }
  return { ...learnerReportBody(value, expected), learner: { user_id: learner.user_id } };
}

/**
 * Re-validates a report that already carries the public shape, which MCP egress
 * sees. That shape holds a vault token and no Moodle user ID, so a value that
 * still carries an identifier did not come from the roster boundary and is
 * refused.
 */
export function projectPublicMoodleLearnerGradeReport(
  value: unknown,
  expected: Readonly<{ courseId: number }>,
): MoodleLearnerGradeReport {
  const error = "moodle_learner_grade_report_invalid";
  if (!isJsonObject(value)) throw new Error(error);
  const learner = isJsonObject(value.learner) ? value.learner : null;
  if (!learner || Object.keys(learner).length !== 1
    || typeof learner.learnerToken !== "string" || !LEARNER_TOKEN.test(learner.learnerToken)) {
    throw new Error(error);
  }
  return { ...learnerReportBody(value, expected), learner: { learnerToken: learner.learnerToken } };
}

export function projectMoodleLearnerGradeReportBrowserResult(
  browserData: unknown,
  expected: MoodleLearnerGradeReportExpectation,
): JsonObject {
  return projectMoodleLearnerGradeReportSource(browserData, expected) as unknown as JsonObject;
}

export function projectPublicMoodleLearnerGradeReportResult(
  publicData: unknown,
  expected: Readonly<{ courseId: number }>,
): JsonObject {
  return projectPublicMoodleLearnerGradeReport(publicData, expected) as unknown as JsonObject;
}
