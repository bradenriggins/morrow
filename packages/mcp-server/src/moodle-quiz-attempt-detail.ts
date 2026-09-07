import { isJsonObject, type JsonObject } from "@morrow/contracts";

export const MOODLE_QUIZ_ATTEMPT_OPERATION = "moodle.form.quiz.attempt_detail.read.v1";
export const MOODLE_QUIZ_ATTEMPT_TOOL = "moodle_get_quiz_attempt";
export const MOODLE_QUIZ_ATTEMPT_SCHEMA = "morrow.moodle-quiz-attempt.v1";

export const MOODLE_QUIZ_MANUAL_GRADING_QUEUE_OPERATION = "moodle.form.quiz.manual_grading_queue.read.v1";
export const MOODLE_QUIZ_MANUAL_GRADING_QUEUE_TOOL = "moodle_get_quiz_manual_grading_queue";
export const MOODLE_QUIZ_MANUAL_GRADING_QUEUE_SCHEMA = "morrow.moodle-quiz-manual-grading-queue.v1";

export const MOODLE_QUIZ_REGRADE_REPORT_OPERATION = "moodle.form.quiz.regrade_report.read.v1";
export const MOODLE_QUIZ_REGRADE_REPORT_TOOL = "moodle_get_quiz_regrade_report";
export const MOODLE_QUIZ_REGRADE_REPORT_SCHEMA = "morrow.moodle-quiz-regrade-report.v1";

const ATTEMPT_METHOD = "quiz_report_overview_page";
const ATTEMPT_ROUTE = "/mod/quiz/report.php?mode=overview";
const QUEUE_METHOD = "quiz_report_grading_index";
const QUEUE_ROUTE = "/mod/quiz/report.php?mode=grading";
const REGRADE_METHOD = "quiz_report_overview_regraded_filter";
const REGRADE_ROUTE = "/mod/quiz/report.php?mode=overview&onlyregraded=1";
const MODULE_BINDING = "quiz_report_page";
const VIEW_REPORTS_CAPABILITY = "mod/quiz:viewreports";
const GRADE_CAPABILITY = "mod/quiz:grade";
const AVOIDED_ROUTES = "/mod/quiz/attempt.php+/mod/quiz/review.php+/mod/quiz/reviewquestion.php";

const ATTEMPT_PAGE_SIZE = 100;
const ATTEMPT_PAGE_LIMIT = 10;
const ATTEMPT_SLOT_LIMIT = 100;
const ATTEMPT_ROW_LIMIT = ATTEMPT_PAGE_SIZE * ATTEMPT_PAGE_LIMIT;
const QUEUE_QUESTION_LIMIT = 200;
const QUEUE_RESPONSE_LIMIT = 1_000_000;
const REGRADE_ATTEMPT_LIMIT = ATTEMPT_PAGE_SIZE * ATTEMPT_PAGE_LIMIT;
const DISPLAY_LIMIT = 120;
const MARK_LIMIT = 100_000;

/** quiz_attempt state constants, as attempts_report_options::$statefields lists them. */
const ATTEMPT_STATES = ["notstarted", "inprogress", "overdue", "submitted", "finished", "abandoned"] as const;
/** question_state::get_state_class(true) in public/question/engine/states.php. */
const SLOT_STATES = [
  "notyetanswered", "invalidanswer", "answersaved", "requiresgrading", "complete",
  "correct", "partiallycorrect", "incorrect", "notanswered",
] as const;
const LEARNER_TOKEN = /^learner_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

type AttemptState = (typeof ATTEMPT_STATES)[number];
type SlotState = (typeof SLOT_STATES)[number];

export type MoodleQuizAttemptSlot = Readonly<{
  slot: number;
  state: SlotState | null;
  mark: number | null;
  regraded: boolean;
}>;

type MoodleQuizAttemptBody = Readonly<{
  schema: typeof MOODLE_QUIZ_ATTEMPT_SCHEMA;
  provider: "moodle";
  course_id: number;
  module_id: number;
  attempt_id: number;
  state: AttemptState;
  started_display: string | null;
  completed_display: string | null;
  duration_display: string | null;
  slot_count: number;
  slots: readonly MoodleQuizAttemptSlot[];
  proof: Readonly<{
    method: typeof ATTEMPT_METHOD;
    route: typeof ATTEMPT_ROUTE;
    complete: true;
    exact_module_binding: typeof MODULE_BINDING;
    required_capability: typeof VIEW_REPORTS_CAPABILITY;
    avoided_routes: typeof AVOIDED_ROUTES;
    records_learner_state: false;
    records_report_viewed_event: true;
    sesskey_sent: false;
    page_size: typeof ATTEMPT_PAGE_SIZE;
    page_count: number;
    row_count: number;
    slot_limit: typeof ATTEMPT_SLOT_LIMIT;
  }>;
}>;

/** The browser shape, before the runtime projects the identity through the roster. */
export type MoodleQuizAttemptSource = MoodleQuizAttemptBody & Readonly<{
  learner: Readonly<{ user_id: string }>;
}>;

/** The only public shape. The learner identity exists here as a vault token only. */
export type MoodleQuizAttempt = MoodleQuizAttemptBody & Readonly<{
  learner: Readonly<{ learnerToken: string }>;
}>;

export type MoodleQuizManualGradingQuestion = Readonly<{
  slot: number;
  question_id: number;
  needs_grading: number;
  manually_graded: number;
  total: number;
}>;

export type MoodleQuizManualGradingQueue = Readonly<{
  schema: typeof MOODLE_QUIZ_MANUAL_GRADING_QUEUE_SCHEMA;
  provider: "moodle";
  course_id: number;
  module_id: number;
  question_count: number;
  needs_grading_count: number;
  manually_graded_count: number;
  response_count: number;
  questions: readonly MoodleQuizManualGradingQuestion[];
  proof: Readonly<{
    method: typeof QUEUE_METHOD;
    route: typeof QUEUE_ROUTE;
    complete: true;
    exact_module_binding: typeof MODULE_BINDING;
    required_capability: typeof GRADE_CAPABILITY;
    avoided_routes: typeof AVOIDED_ROUTES;
    records_learner_state: false;
    records_report_viewed_event: true;
    sesskey_sent: false;
    includes_automatically_graded: false;
    question_limit: typeof QUEUE_QUESTION_LIMIT;
    listed_question_rows: number;
  }>;
}>;

export type MoodleQuizRegradeReport = Readonly<{
  schema: typeof MOODLE_QUIZ_REGRADE_REPORT_SCHEMA;
  provider: "moodle";
  course_id: number;
  module_id: number;
  regraded_attempt_count: number;
  commit_pending: boolean;
  proof: Readonly<{
    method: typeof REGRADE_METHOD;
    route: typeof REGRADE_ROUTE;
    complete: true;
    exact_module_binding: typeof MODULE_BINDING;
    required_capability: typeof VIEW_REPORTS_CAPABILITY;
    regrade_capability_marker: "onlyregraded_filter";
    avoided_routes: typeof AVOIDED_ROUTES;
    records_learner_state: false;
    records_report_viewed_event: true;
    sesskey_sent: false;
    regrade_parameter_sent: false;
    page_size: typeof ATTEMPT_PAGE_SIZE;
    page_count: number;
    attempt_limit: typeof REGRADE_ATTEMPT_LIMIT;
  }>;
}>;

export type MoodleQuizModuleExpectation = Readonly<{ courseId: number; moduleId: number }>;
export type MoodleQuizAttemptExpectation = MoodleQuizModuleExpectation & Readonly<{ attemptId: number }>;

function positiveId(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function count(value: unknown, maximum: number): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum ? Number(value) : null;
}

function displayText(value: unknown, error: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value || value.length > DISPLAY_LIMIT || /[<>]/u.test(value)) throw new Error(error);
  return value;
}

function attemptBody(value: JsonObject, expected: MoodleQuizAttemptExpectation): MoodleQuizAttemptBody {
  const error = "moodle_quiz_attempt_invalid";
  if (value.schema !== MOODLE_QUIZ_ATTEMPT_SCHEMA || value.provider !== "moodle"
    || positiveId(value.course_id) !== expected.courseId || positiveId(value.module_id) !== expected.moduleId
    || positiveId(value.attempt_id) !== expected.attemptId) {
    throw new Error(error);
  }
  const state = value.state;
  const slotCount = count(value.slot_count, ATTEMPT_SLOT_LIMIT);
  const proof = isJsonObject(value.proof) ? value.proof : null;
  const pageCount = proof ? count(proof.page_count, ATTEMPT_PAGE_LIMIT) : null;
  const rowCount = proof ? count(proof.row_count, ATTEMPT_ROW_LIMIT) : null;
  if (typeof state !== "string" || !(ATTEMPT_STATES as readonly string[]).includes(state)
    || slotCount === null || !Array.isArray(value.slots) || value.slots.length !== slotCount
    || !proof || pageCount === null || rowCount === null || pageCount < 1
    || proof.method !== ATTEMPT_METHOD || proof.route !== ATTEMPT_ROUTE || proof.complete !== true
    || proof.exact_module_binding !== MODULE_BINDING || proof.required_capability !== VIEW_REPORTS_CAPABILITY
    || proof.avoided_routes !== AVOIDED_ROUTES || proof.records_learner_state !== false
    || proof.records_report_viewed_event !== true || proof.sesskey_sent !== false
    || proof.page_size !== ATTEMPT_PAGE_SIZE || proof.slot_limit !== ATTEMPT_SLOT_LIMIT) {
    throw new Error(error);
  }
  const slots = value.slots.map((entry) => {
    const source = isJsonObject(entry) ? entry : null;
    const slot = source ? positiveId(source.slot) : null;
    const slotState = source?.state;
    const mark = source?.mark;
    if (!source || !slot || Object.keys(source).length !== 4 || typeof source.regraded !== "boolean"
      || (slotState !== null && (typeof slotState !== "string" || !(SLOT_STATES as readonly string[]).includes(slotState)))
      || (mark !== null && (typeof mark !== "number" || !Number.isFinite(mark) || Math.abs(mark) > MARK_LIMIT))) {
      throw new Error(error);
    }
    return {
      slot,
      state: slotState === null ? null : slotState as SlotState,
      mark: mark === null ? null : Number(mark),
      regraded: source.regraded,
    };
  });
  if (new Set(slots.map((slot) => slot.slot)).size !== slots.length
    || slots.some((slot, index) => index > 0 && slot.slot <= slots[index - 1]!.slot)) {
    throw new Error(error);
  }
  return {
    schema: MOODLE_QUIZ_ATTEMPT_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    module_id: expected.moduleId,
    attempt_id: expected.attemptId,
    state: state as AttemptState,
    started_display: displayText(value.started_display, error),
    completed_display: displayText(value.completed_display, error),
    duration_display: displayText(value.duration_display, error),
    slot_count: slotCount,
    slots,
    proof: {
      method: ATTEMPT_METHOD,
      route: ATTEMPT_ROUTE,
      complete: true,
      exact_module_binding: MODULE_BINDING,
      required_capability: VIEW_REPORTS_CAPABILITY,
      avoided_routes: AVOIDED_ROUTES,
      records_learner_state: false,
      records_report_viewed_event: true,
      sesskey_sent: false,
      page_size: ATTEMPT_PAGE_SIZE,
      page_count: pageCount,
      row_count: rowCount,
      slot_limit: ATTEMPT_SLOT_LIMIT,
    },
  };
}

/**
 * Rebuilds the browser result for one requested attempt. Moodle's Grades report
 * row carries the learner name, a profile link, and a link to every review
 * route; this projection keeps the identity only as `learner.user_id` so the
 * runtime can project it through the complete course roster, and carries no
 * other source field.
 */
export function projectMoodleQuizAttemptSource(
  value: unknown,
  expected: MoodleQuizAttemptExpectation,
): MoodleQuizAttemptSource {
  const error = "moodle_quiz_attempt_invalid";
  if (!isJsonObject(value)) throw new Error(error);
  const learner = isJsonObject(value.learner) ? value.learner : null;
  if (!learner || Object.keys(learner).length !== 1 || typeof learner.user_id !== "string"
    || !/^[1-9][0-9]{0,18}$/u.test(learner.user_id)) {
    throw new Error(error);
  }
  return { ...attemptBody(value, expected), learner: { user_id: learner.user_id } };
}

/**
 * Re-validates an attempt record that already carries the public shape, which
 * MCP egress sees. That shape holds a vault token and no Moodle user ID, so a
 * value that still carries an identifier did not come from the roster boundary
 * and is refused.
 */
export function projectPublicMoodleQuizAttempt(
  value: unknown,
  expected: MoodleQuizAttemptExpectation,
): MoodleQuizAttempt {
  const error = "moodle_quiz_attempt_invalid";
  if (!isJsonObject(value)) throw new Error(error);
  const learner = isJsonObject(value.learner) ? value.learner : null;
  if (!learner || Object.keys(learner).length !== 1
    || typeof learner.learnerToken !== "string" || !LEARNER_TOKEN.test(learner.learnerToken)) {
    throw new Error(error);
  }
  return { ...attemptBody(value, expected), learner: { learnerToken: learner.learnerToken } };
}

export function projectMoodleQuizAttemptBrowserResult(
  browserData: unknown,
  expected: MoodleQuizAttemptExpectation,
): JsonObject {
  return projectMoodleQuizAttemptSource(browserData, expected) as unknown as JsonObject;
}

export function projectPublicMoodleQuizAttemptResult(
  publicData: unknown,
  expected: MoodleQuizAttemptExpectation,
): JsonObject {
  return projectPublicMoodleQuizAttempt(publicData, expected) as unknown as JsonObject;
}

/**
 * Creates the only public representation allowed for the manual grading index.
 * The index names no learner, and this projection recomputes every total from
 * the listed rows, so a site that adds a column or a row cannot report a total
 * its own rows contradict.
 */
export function projectMoodleQuizManualGradingQueue(
  value: unknown,
  expected: MoodleQuizModuleExpectation,
): MoodleQuizManualGradingQueue {
  const error = "moodle_quiz_manual_grading_queue_invalid";
  if (!isJsonObject(value) || value.schema !== MOODLE_QUIZ_MANUAL_GRADING_QUEUE_SCHEMA || value.provider !== "moodle"
    || positiveId(value.course_id) !== expected.courseId || positiveId(value.module_id) !== expected.moduleId) {
    throw new Error(error);
  }
  const questionCount = count(value.question_count, QUEUE_QUESTION_LIMIT);
  const proof = isJsonObject(value.proof) ? value.proof : null;
  if (questionCount === null || !Array.isArray(value.questions) || value.questions.length !== questionCount || !proof
    || proof.method !== QUEUE_METHOD || proof.route !== QUEUE_ROUTE || proof.complete !== true
    || proof.exact_module_binding !== MODULE_BINDING || proof.required_capability !== GRADE_CAPABILITY
    || proof.avoided_routes !== AVOIDED_ROUTES || proof.records_learner_state !== false
    || proof.records_report_viewed_event !== true || proof.sesskey_sent !== false
    || proof.includes_automatically_graded !== false || proof.question_limit !== QUEUE_QUESTION_LIMIT
    || proof.listed_question_rows !== questionCount) {
    throw new Error(error);
  }
  const questions = value.questions.map((entry) => {
    const source = isJsonObject(entry) ? entry : null;
    const slot = source ? positiveId(source.slot) : null;
    const questionId = source ? positiveId(source.question_id) : null;
    const total = source ? count(source.total, QUEUE_RESPONSE_LIMIT) : null;
    const needsGrading = source && total !== null ? count(source.needs_grading, total) : null;
    const manuallyGraded = source && total !== null ? count(source.manually_graded, total) : null;
    if (!source || Object.keys(source).length !== 5 || !slot || !questionId
      || total === null || needsGrading === null || manuallyGraded === null || needsGrading + manuallyGraded > total) {
      throw new Error(error);
    }
    return { slot, question_id: questionId, needs_grading: needsGrading, manually_graded: manuallyGraded, total };
  });
  if (new Set(questions.map((question) => question.slot)).size !== questions.length
    || questions.some((question, index) => index > 0 && question.slot <= questions[index - 1]!.slot)) {
    throw new Error(error);
  }
  const sum = (field: "needs_grading" | "manually_graded" | "total") => questions.reduce((total, question) => total + question[field], 0);
  if (count(value.needs_grading_count, QUEUE_RESPONSE_LIMIT) !== sum("needs_grading")
    || count(value.manually_graded_count, QUEUE_RESPONSE_LIMIT) !== sum("manually_graded")
    || count(value.response_count, QUEUE_RESPONSE_LIMIT) !== sum("total")) {
    throw new Error(error);
  }
  return {
    schema: MOODLE_QUIZ_MANUAL_GRADING_QUEUE_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    module_id: expected.moduleId,
    question_count: questionCount,
    needs_grading_count: sum("needs_grading"),
    manually_graded_count: sum("manually_graded"),
    response_count: sum("total"),
    questions,
    proof: {
      method: QUEUE_METHOD,
      route: QUEUE_ROUTE,
      complete: true,
      exact_module_binding: MODULE_BINDING,
      required_capability: GRADE_CAPABILITY,
      avoided_routes: AVOIDED_ROUTES,
      records_learner_state: false,
      records_report_viewed_event: true,
      sesskey_sent: false,
      includes_automatically_graded: false,
      question_limit: QUEUE_QUESTION_LIMIT,
      listed_question_rows: questionCount,
    },
  };
}

export function projectMoodleQuizManualGradingQueueBrowserResult(
  browserData: unknown,
  expected: MoodleQuizModuleExpectation,
): JsonObject {
  return projectMoodleQuizManualGradingQueue(browserData, expected) as JsonObject;
}

/**
 * Creates the only public representation allowed for the Quiz regrade state. It
 * names no learner and no attempt: the report answers how many attempts carry a
 * regrade record and whether Moodle is offering to commit a dry run.
 */
export function projectMoodleQuizRegradeReport(
  value: unknown,
  expected: MoodleQuizModuleExpectation,
): MoodleQuizRegradeReport {
  const error = "moodle_quiz_regrade_report_invalid";
  if (!isJsonObject(value) || value.schema !== MOODLE_QUIZ_REGRADE_REPORT_SCHEMA || value.provider !== "moodle"
    || positiveId(value.course_id) !== expected.courseId || positiveId(value.module_id) !== expected.moduleId) {
    throw new Error(error);
  }
  const regradedCount = count(value.regraded_attempt_count, REGRADE_ATTEMPT_LIMIT);
  const proof = isJsonObject(value.proof) ? value.proof : null;
  const pageCount = proof ? count(proof.page_count, ATTEMPT_PAGE_LIMIT) : null;
  if (regradedCount === null || typeof value.commit_pending !== "boolean" || !proof || pageCount === null || pageCount < 1
    || proof.method !== REGRADE_METHOD || proof.route !== REGRADE_ROUTE || proof.complete !== true
    || proof.exact_module_binding !== MODULE_BINDING || proof.required_capability !== VIEW_REPORTS_CAPABILITY
    || proof.regrade_capability_marker !== "onlyregraded_filter" || proof.avoided_routes !== AVOIDED_ROUTES
    || proof.records_learner_state !== false || proof.records_report_viewed_event !== true
    || proof.sesskey_sent !== false || proof.regrade_parameter_sent !== false
    || proof.page_size !== ATTEMPT_PAGE_SIZE || proof.attempt_limit !== REGRADE_ATTEMPT_LIMIT) {
    throw new Error(error);
  }
  return {
    schema: MOODLE_QUIZ_REGRADE_REPORT_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    module_id: expected.moduleId,
    regraded_attempt_count: regradedCount,
    commit_pending: value.commit_pending,
    proof: {
      method: REGRADE_METHOD,
      route: REGRADE_ROUTE,
      complete: true,
      exact_module_binding: MODULE_BINDING,
      required_capability: VIEW_REPORTS_CAPABILITY,
      regrade_capability_marker: "onlyregraded_filter",
      avoided_routes: AVOIDED_ROUTES,
      records_learner_state: false,
      records_report_viewed_event: true,
      sesskey_sent: false,
      regrade_parameter_sent: false,
      page_size: ATTEMPT_PAGE_SIZE,
      page_count: pageCount,
      attempt_limit: REGRADE_ATTEMPT_LIMIT,
    },
  };
}

export function projectMoodleQuizRegradeReportBrowserResult(
  browserData: unknown,
  expected: MoodleQuizModuleExpectation,
): JsonObject {
  return projectMoodleQuizRegradeReport(browserData, expected) as JsonObject;
}
