import { isJsonObject, type JsonObject } from "@morrow/contracts";

export const CANVAS_ASSIGNMENT_SUBMISSION_SUMMARY_OPERATION = "canvas.api.v1.course.assignment.submissions.aggregate.read.v1";
export const CANVAS_ASSIGNMENT_SUBMISSION_SUMMARY_TOOL = "canvas_get_assignment_submission_summary";
export const CANVAS_ASSIGNMENT_SUBMISSION_SUMMARY_SCHEMA = "morrow.canvas-assignment-submission-summary.v1";

export const CANVAS_COURSE_GRADEBOOK_SUMMARY_OPERATION = "canvas.api.v1.course.gradebook.aggregate.read.v1";
export const CANVAS_COURSE_GRADEBOOK_SUMMARY_TOOL = "canvas_get_course_gradebook_summary";
export const CANVAS_COURSE_GRADEBOOK_SUMMARY_SCHEMA = "morrow.canvas-course-gradebook-summary.v1";

export const CANVAS_COURSE_ACTIVITY_SUMMARY_OPERATION = "canvas.api.v1.course.activity.aggregate.read.v1";
export const CANVAS_COURSE_ACTIVITY_SUMMARY_TOOL = "canvas_get_course_activity_summary";
export const CANVAS_COURSE_ACTIVITY_SUMMARY_SCHEMA = "morrow.canvas-course-activity-summary.v1";

/** These bounds are the same values the page reader enforces. */
const MAX_PAGES = 25;
const MAX_SUBMISSION_PAGES = 50;
const MAX_ROWS = 10_000;
const MAX_ASSIGNMENTS = 200;
const MAX_ITEMS = 2_000;
const MAX_WINDOW_DAYS = 365;
const MINIMUM_COHORT = 5;

const SUBMISSION_STATES = ["unsubmitted", "submitted", "graded", "pending_review"] as const;
const SCORE_BUCKETS = ["below_60", "60_to_69", "70_to_79", "80_to_89", "90_and_above"] as const;
const ACTIVITY_KINDS = ["pages", "assignments", "discussions", "quizzes", "modules"] as const;
const DISTRIBUTION_STATES = ["reported", "suppressed_cohort_below_minimum", "suppressed_bucket_below_minimum", "unscored_assignment"] as const;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

type SubmissionState = typeof SUBMISSION_STATES[number];
type ScoreBucket = typeof SCORE_BUCKETS[number];
type ActivityKind = typeof ACTIVITY_KINDS[number];
type DistributionState = typeof DISTRIBUTION_STATES[number];

export type CanvasCourseSummaryExpectation = Readonly<{ courseId: number; assignmentId?: number; days?: number }>;

function positiveId(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function count(value: unknown, maximum: number): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum ? Number(value) : null;
}

function refuse(tool: string): never {
  throw new Error(`${tool}_invalid`);
}

function summaryHead(value: unknown, schema: string, expected: CanvasCourseSummaryExpectation, tool: string): JsonObject {
  if (!isJsonObject(value) || value.schema !== schema || value.provider !== "canvas"
    || positiveId(value.course_id) !== expected.courseId) refuse(tool);
  return value;
}

/**
 * Rebuilds the aggregate Canvas Assignment submission summary from fixed
 * fields. Every unknown field is dropped, including any learner row a stale or
 * compromised browser result might attach.
 */
export function projectCanvasAssignmentSubmissionSummary(
  value: unknown,
  expected: CanvasCourseSummaryExpectation,
): JsonObject {
  const tool = CANVAS_ASSIGNMENT_SUBMISSION_SUMMARY_TOOL;
  const source = summaryHead(value, CANVAS_ASSIGNMENT_SUBMISSION_SUMMARY_SCHEMA, expected, tool);
  const assignmentId = positiveId(source.assignment_id);
  if (assignmentId === null || assignmentId !== expected.assignmentId) refuse(tool);
  const submissions = count(source.submission_count, MAX_ROWS);
  const states = isJsonObject(source.workflow_state_counts) ? source.workflow_state_counts : null;
  const proof = isJsonObject(source.proof) ? source.proof : null;
  if (submissions === null || !states || !proof || Object.keys(states).length !== SUBMISSION_STATES.length) refuse(tool);
  const stateCounts = Object.fromEntries(SUBMISSION_STATES.map((state) => [state, count(states[state], submissions)])) as Record<SubmissionState, number | null>;
  const late = count(source.late_count, submissions);
  const missing = count(source.missing_count, submissions);
  const excused = count(source.excused_count, submissions);
  const needsGrading = source.needs_grading_count === null ? null : count(source.needs_grading_count, MAX_ROWS);
  const pagesRead = count(proof.pages_read, MAX_PAGES);
  if (Object.values(stateCounts).some((entry) => entry === null)
    || Object.values(stateCounts).reduce<number>((total, entry) => total + (entry ?? 0), 0) !== submissions
    || late === null || missing === null || excused === null
    || (source.needs_grading_count !== null && needsGrading === null)
    || pagesRead === null || pagesRead < 1
    || proof.method !== "GET /api/v1/courses/:course_id/assignments/:assignment_id/submissions"
    || proof.complete !== true || proof.pagination_complete !== true
    || proof.response_row_count !== submissions
    || proof.needs_grading_count_source !== (needsGrading === null ? "unavailable" : "assignment_record")) refuse(tool);
  return {
    schema: CANVAS_ASSIGNMENT_SUBMISSION_SUMMARY_SCHEMA,
    provider: "canvas",
    course_id: expected.courseId,
    assignment_id: assignmentId,
    submission_count: submissions,
    workflow_state_counts: {
      unsubmitted: stateCounts.unsubmitted!,
      submitted: stateCounts.submitted!,
      graded: stateCounts.graded!,
      pending_review: stateCounts.pending_review!,
    },
    late_count: late,
    missing_count: missing,
    excused_count: excused,
    needs_grading_count: needsGrading,
    proof: {
      method: "GET /api/v1/courses/:course_id/assignments/:assignment_id/submissions",
      complete: true,
      pagination_complete: true,
      pages_read: pagesRead,
      response_row_count: submissions,
      needs_grading_count_source: needsGrading === null ? "unavailable" : "assignment_record",
    },
  };
}

/**
 * Rebuilds the aggregate Canvas gradebook summary and re-applies the
 * suppression rule at this boundary: a published band holds at least
 * MINIMUM_COHORT scores, and an assignment with fewer scored submissions than
 * that publishes no distribution at all. A source result that breaks either
 * rule is refused rather than trimmed, because a distribution that thin can
 * identify one learner's score.
 */
export function projectCanvasCourseGradebookSummary(
  value: unknown,
  expected: CanvasCourseSummaryExpectation,
): JsonObject {
  const tool = CANVAS_COURSE_GRADEBOOK_SUMMARY_TOOL;
  const source = summaryHead(value, CANVAS_COURSE_GRADEBOOK_SUMMARY_SCHEMA, expected, tool);
  const submissions = count(source.submission_count, MAX_ROWS);
  const assignmentCount = count(source.assignment_count, MAX_ASSIGNMENTS);
  const rows = Array.isArray(source.assignments) ? source.assignments : null;
  const proof = isJsonObject(source.proof) ? source.proof : null;
  if (submissions === null || assignmentCount === null || !rows || !proof
    || rows.length !== assignmentCount || source.minimum_cohort !== MINIMUM_COHORT) refuse(tool);
  let previousId = 0;
  const assignments = rows.map((entry) => {
    if (!isJsonObject(entry)) refuse(tool);
    const assignmentId = positiveId(entry.assignment_id);
    const submitted = count(entry.submitted_count, submissions);
    const graded = count(entry.graded_count, submissions);
    const ungraded = count(entry.ungraded_count, submissions);
    const scored = graded === null ? null : count(entry.scored_count, graded);
    const state = DISTRIBUTION_STATES.find((candidate) => candidate === entry.score_distribution_state);
    if (assignmentId === null || assignmentId <= previousId || submitted === null || graded === null
      || ungraded === null || ungraded < submitted || scored === null || !state) refuse(tool);
    previousId = assignmentId;
    if (state !== "reported") {
      if (entry.score_distribution !== null) refuse(tool);
      if (state === "suppressed_bucket_below_minimum" && scored < MINIMUM_COHORT) refuse(tool);
      if (state === "suppressed_cohort_below_minimum" && scored >= MINIMUM_COHORT) refuse(tool);
      if (state === "unscored_assignment" && scored !== 0) refuse(tool);
      return {
        assignment_id: assignmentId,
        submitted_count: submitted,
        graded_count: graded,
        ungraded_count: ungraded,
        scored_count: scored,
        score_distribution_state: state,
        score_distribution: null,
      };
    }
    const distribution = isJsonObject(entry.score_distribution) ? entry.score_distribution : null;
    if (!distribution || Object.keys(distribution).length !== SCORE_BUCKETS.length || scored < MINIMUM_COHORT) refuse(tool);
    const buckets = Object.fromEntries(SCORE_BUCKETS.map((bucket) => [bucket, count(distribution[bucket], scored)])) as Record<ScoreBucket, number | null>;
    const values = Object.values(buckets);
    if (values.some((bucket) => bucket === null || (bucket > 0 && bucket < MINIMUM_COHORT))
      || values.reduce<number>((total, bucket) => total + (bucket ?? 0), 0) !== scored) refuse(tool);
    return {
      assignment_id: assignmentId,
      submitted_count: submitted,
      graded_count: graded,
      ungraded_count: ungraded,
      scored_count: scored,
      score_distribution_state: state,
      score_distribution: {
        below_60: buckets.below_60!,
        "60_to_69": buckets["60_to_69"]!,
        "70_to_79": buckets["70_to_79"]!,
        "80_to_89": buckets["80_to_89"]!,
        "90_and_above": buckets["90_and_above"]!,
      },
    };
  });
  const assignmentPages = count(proof.assignment_pages_read, MAX_PAGES);
  const submissionPages = count(proof.submission_pages_read, MAX_SUBMISSION_PAGES);
  if (assignmentPages === null || assignmentPages < 1 || submissionPages === null || submissionPages < 1
    || proof.method !== "GET /api/v1/courses/:course_id/students/submissions"
    || proof.complete !== true || proof.pagination_complete !== true
    || proof.response_row_count !== submissions
    || proof.ungraded_definition !== "submitted_and_pending_review"
    || proof.score_scale !== "percentage_of_points_possible"
    || proof.minimum_bucket_population !== MINIMUM_COHORT) refuse(tool);
  return {
    schema: CANVAS_COURSE_GRADEBOOK_SUMMARY_SCHEMA,
    provider: "canvas",
    course_id: expected.courseId,
    assignment_count: assignmentCount,
    submission_count: submissions,
    minimum_cohort: MINIMUM_COHORT,
    assignments,
    proof: {
      method: "GET /api/v1/courses/:course_id/students/submissions",
      complete: true,
      pagination_complete: true,
      assignment_pages_read: assignmentPages,
      submission_pages_read: submissionPages,
      response_row_count: submissions,
      ungraded_definition: "submitted_and_pending_review",
      score_scale: "percentage_of_points_possible",
      minimum_bucket_population: MINIMUM_COHORT,
    },
  };
}

/**
 * Rebuilds the aggregate Canvas course activity summary. A kind that the
 * provider rows cannot place in the window keeps its `timestamp_unavailable`
 * state and a null count; it never becomes a zero.
 */
export function projectCanvasCourseActivitySummary(
  value: unknown,
  expected: CanvasCourseSummaryExpectation,
): JsonObject {
  const tool = CANVAS_COURSE_ACTIVITY_SUMMARY_TOOL;
  const source = summaryHead(value, CANVAS_COURSE_ACTIVITY_SUMMARY_SCHEMA, expected, tool);
  const days = count(source.window_days, MAX_WINDOW_DAYS);
  const kinds = isJsonObject(source.kinds) ? source.kinds : null;
  const proof = isJsonObject(source.proof) ? source.proof : null;
  if (days === null || days < 1 || days !== expected.days || !kinds || !proof
    || typeof source.window_start !== "string" || !ISO_INSTANT.test(source.window_start)
    || Object.keys(kinds).length !== ACTIVITY_KINDS.length) refuse(tool);
  const projected = Object.fromEntries(ACTIVITY_KINDS.map((kind) => {
    const entry = isJsonObject(kinds[kind]) ? kinds[kind] : null;
    const items = entry ? count(entry.item_count, MAX_ITEMS) : null;
    if (!entry || items === null) refuse(tool);
    if (entry.state === "timestamp_unavailable") {
      if (entry.changed_count !== null) refuse(tool);
      return [kind, { state: "timestamp_unavailable", changed_count: null, item_count: items }];
    }
    const changed = count(entry.changed_count, items);
    if (entry.state !== "counted" || changed === null) refuse(tool);
    return [kind, { state: "counted", changed_count: changed, item_count: items }];
  })) as Record<ActivityKind, JsonObject>;
  const pagesRead = count(proof.pages_read, MAX_PAGES * ACTIVITY_KINDS.length);
  if (pagesRead === null || pagesRead < ACTIVITY_KINDS.length
    || proof.method !== "GET /api/v1/courses/:course_id/{pages,assignments,discussion_topics,quizzes,modules}"
    || proof.complete !== true || proof.pagination_complete !== true
    || proof.timestamp_field !== "updated_at" || proof.item_limit_per_kind !== MAX_ITEMS) refuse(tool);
  return {
    schema: CANVAS_COURSE_ACTIVITY_SUMMARY_SCHEMA,
    provider: "canvas",
    course_id: expected.courseId,
    window_days: days,
    window_start: source.window_start,
    kinds: projected,
    proof: {
      method: "GET /api/v1/courses/:course_id/{pages,assignments,discussion_topics,quizzes,modules}",
      complete: true,
      pagination_complete: true,
      pages_read: pagesRead,
      timestamp_field: "updated_at",
      item_limit_per_kind: MAX_ITEMS,
    },
  };
}

export type CanvasCourseSummaryRoute = Readonly<{
  tool: string;
  operation: string;
  schema: string;
  text: string;
  expectation: (courseId: number, request: Readonly<Record<string, unknown>>) => CanvasCourseSummaryExpectation | null;
  project: (value: unknown, expected: CanvasCourseSummaryExpectation) => JsonObject;
}>;

function requestedInteger(value: unknown, maximum: number): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum ? Number(value) : null;
}

const ROUTES: readonly CanvasCourseSummaryRoute[] = Object.freeze([
  {
    tool: CANVAS_ASSIGNMENT_SUBMISSION_SUMMARY_TOOL,
    operation: CANVAS_ASSIGNMENT_SUBMISSION_SUMMARY_OPERATION,
    schema: CANVAS_ASSIGNMENT_SUBMISSION_SUMMARY_SCHEMA,
    text: "Morrow read the current aggregate Canvas Assignment submission summary.",
    expectation: (courseId, request) => {
      const assignmentId = requestedInteger(request.assignment_id, Number.MAX_SAFE_INTEGER);
      return assignmentId === null ? null : { courseId, assignmentId };
    },
    project: projectCanvasAssignmentSubmissionSummary,
  },
  {
    tool: CANVAS_COURSE_GRADEBOOK_SUMMARY_TOOL,
    operation: CANVAS_COURSE_GRADEBOOK_SUMMARY_OPERATION,
    schema: CANVAS_COURSE_GRADEBOOK_SUMMARY_SCHEMA,
    text: "Morrow read the current aggregate Canvas course gradebook summary.",
    expectation: (courseId) => ({ courseId }),
    project: projectCanvasCourseGradebookSummary,
  },
  {
    tool: CANVAS_COURSE_ACTIVITY_SUMMARY_TOOL,
    operation: CANVAS_COURSE_ACTIVITY_SUMMARY_OPERATION,
    schema: CANVAS_COURSE_ACTIVITY_SUMMARY_SCHEMA,
    text: "Morrow read the current aggregate Canvas course activity summary.",
    expectation: (courseId, request) => {
      const days = requestedInteger(request.days, MAX_WINDOW_DAYS);
      return days === null ? null : { courseId, days };
    },
    project: projectCanvasCourseActivitySummary,
  },
]);

export const CANVAS_COURSE_SUMMARY_TOOLS: readonly string[] = Object.freeze(ROUTES.map((route) => route.tool));

export function canvasCourseSummaryRoute(toolName: unknown): CanvasCourseSummaryRoute | null {
  return ROUTES.find((route) => route.tool === toolName) ?? null;
}

export function canvasCourseSummaryRouteBySchema(schema: unknown): CanvasCourseSummaryRoute | null {
  return ROUTES.find((route) => route.schema === schema) ?? null;
}
