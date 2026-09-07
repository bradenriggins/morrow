import { isJsonObject, type JsonObject } from "@morrow/contracts";

export const MOODLE_ASSIGNMENT_SUBMISSION_OPERATION = "moodle.form.assign.submission.read.v1";
export const MOODLE_ASSIGNMENT_SUBMISSION_TOOL = "moodle_get_assignment_submission";
export const MOODLE_ASSIGNMENT_SUBMISSION_SCHEMA = "morrow.moodle-assignment-submission.v1";

export const MOODLE_ASSIGNMENT_FEEDBACK_OPERATION = "moodle.form.assign.feedback.read.v1";
export const MOODLE_ASSIGNMENT_FEEDBACK_TOOL = "moodle_get_assignment_feedback";
export const MOODLE_ASSIGNMENT_FEEDBACK_SCHEMA = "morrow.moodle-assignment-feedback.v1";

const STATUS_METHOD = "mod_assign_get_submission_status";
const MODULE_BINDING = "course_modedit_form";
const SUBMISSION_CAPABILITY = "mod/assign:viewgrades";
const FEEDBACK_CAPABILITY = "mod/assign:grade";
const PLUGIN_LIMIT = 20;
const FILE_LIMIT = 200;
const ATTEMPT_LIMIT = 1_000;

/** public/mod/assign/locallib.php defines exactly these four submission states. */
const SUBMISSION_STATUSES = ["new", "reopened", "draft", "submitted"] as const;
/**
 * assign::get_grading_status() answers with a marking-workflow state when the
 * Assignment has marking workflow switched on, and with graded or notgraded
 * when it does not.
 */
const WORKFLOW_STATES = ["notmarked", "inmarking", "readyforreview", "inreview", "readyforrelease", "released"] as const;
const GRADING_STATUSES = ["graded", "notgraded", ...WORKFLOW_STATES] as const;
const LEARNER_TOKEN = /^learner_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TEXT = /^[^\u0000-\u001f\u007f]{1,255}$/u;

type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];
type GradingStatus = (typeof GRADING_STATUSES)[number];
type WorkflowState = (typeof WORKFLOW_STATES)[number];

/** File metadata only. Morrow reads no submission or feedback byte and returns no file URL. */
export type MoodleAssignmentFile = Readonly<{
  plugin_type: string;
  area: string;
  file_name: string;
  file_path: string;
  file_size: number | null;
  mime_type: string | null;
  time_modified: number;
}>;

export type MoodleAssignmentSubmissionAttempt = Readonly<{
  attempt_number: number;
  status: SubmissionStatus;
  time_created: number;
  time_modified: number;
  time_started: number | null;
}>;

export type MoodleAssignmentSubmissionType = Readonly<{
  type: string;
  has_content: boolean;
  file_count: number;
}>;

type MoodleAssignmentSubmissionBody = Readonly<{
  schema: typeof MOODLE_ASSIGNMENT_SUBMISSION_SCHEMA;
  provider: "moodle";
  course_id: number;
  module_id: number;
  assignment_id: number;
  attempt: MoodleAssignmentSubmissionAttempt | null;
  grading_status: GradingStatus;
  locked: boolean;
  graded: boolean;
  blind_marking: boolean;
  extension_due_date: number | null;
  submission_types: readonly MoodleAssignmentSubmissionType[];
  files: readonly MoodleAssignmentFile[];
  proof: Readonly<{
    method: typeof STATUS_METHOD;
    complete: true;
    exact_module_binding: typeof MODULE_BINDING;
    required_capability: typeof SUBMISSION_CAPABILITY;
    submission_type_limit: typeof PLUGIN_LIMIT;
    file_limit: typeof FILE_LIMIT;
    file_count: number;
    includes_file_bytes: false;
  }>;
}>;

export type MoodleAssignmentFeedbackType = Readonly<{
  type: string;
  comment_present: boolean;
  file_count: number;
}>;

type MoodleAssignmentFeedbackBody = Readonly<{
  schema: typeof MOODLE_ASSIGNMENT_FEEDBACK_SCHEMA;
  provider: "moodle";
  course_id: number;
  module_id: number;
  assignment_id: number;
  grading_status: GradingStatus;
  marking_workflow_state: WorkflowState | null;
  graded: boolean;
  grade_value: number | null;
  grade_attempt_number: number | null;
  graded_date: number | null;
  feedback_types: readonly MoodleAssignmentFeedbackType[];
  files: readonly MoodleAssignmentFile[];
  proof: Readonly<{
    method: typeof STATUS_METHOD;
    complete: true;
    exact_module_binding: typeof MODULE_BINDING;
    required_capability: typeof FEEDBACK_CAPABILITY;
    feedback_type_limit: typeof PLUGIN_LIMIT;
    file_limit: typeof FILE_LIMIT;
    file_count: number;
    includes_feedback_text: false;
    includes_file_bytes: false;
  }>;
}>;

/** The browser shape, before the runtime projects the identity through the roster. */
export type MoodleAssignmentSubmissionSource = MoodleAssignmentSubmissionBody & Readonly<{
  learner: Readonly<{ user_id: string }>;
}>;

/** The only public shape. The learner identity exists here as a vault token only. */
export type MoodleAssignmentSubmission = MoodleAssignmentSubmissionBody & Readonly<{
  learner: Readonly<{ learnerToken: string }>;
}>;

export type MoodleAssignmentFeedbackSource = MoodleAssignmentFeedbackBody & Readonly<{
  learner: Readonly<{ user_id: string }>;
}>;

export type MoodleAssignmentFeedback = MoodleAssignmentFeedbackBody & Readonly<{
  learner: Readonly<{ learnerToken: string }>;
}>;

export type MoodleAssignmentModuleExpectation = Readonly<{ courseId: number; moduleId: number }>;
export type MoodleAssignmentLearnerExpectation = MoodleAssignmentModuleExpectation & Readonly<{ userId: number }>;

function positiveId(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function count(value: unknown, maximum: number): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum ? Number(value) : null;
}

function timestamp(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function boundedText(value: unknown): string | null {
  return typeof value === "string" && TEXT.test(value) ? value : null;
}

/**
 * Rebuilds the file list from fixed metadata fields. A source entry can carry a
 * `fileurl`, which is a credentialed page route, so this projection copies only
 * the name, path, size, type, and time and drops everything else.
 */
function files(value: unknown, error: string): readonly MoodleAssignmentFile[] {
  if (!Array.isArray(value) || value.length > FILE_LIMIT) throw new Error(error);
  return value.map((entry) => {
    const source = isJsonObject(entry) ? entry : null;
    const pluginType = source ? boundedText(source.plugin_type) : null;
    const area = source ? boundedText(source.area) : null;
    const fileName = source ? boundedText(source.file_name) : null;
    const filePath = source ? boundedText(source.file_path) : null;
    const modified = source ? timestamp(source.time_modified) : null;
    const size = source && source.file_size !== null ? timestamp(source.file_size) : null;
    const mime = source && source.mime_type !== null ? boundedText(source.mime_type) : null;
    if (!source || !pluginType || !area || !fileName || !filePath || modified === null
      || (source.file_size !== null && size === null) || (source.mime_type !== null && mime === null)) {
      throw new Error(error);
    }
    return { plugin_type: pluginType, area, file_name: fileName, file_path: filePath, file_size: size, mime_type: mime, time_modified: modified };
  });
}

function moduleFields(
  value: JsonObject,
  schema: string,
  expected: MoodleAssignmentModuleExpectation,
  error: string,
): number {
  if (value.schema !== schema || value.provider !== "moodle"
    || positiveId(value.course_id) !== expected.courseId || positiveId(value.module_id) !== expected.moduleId) {
    throw new Error(error);
  }
  const assignmentId = positiveId(value.assignment_id);
  if (!assignmentId) throw new Error(error);
  return assignmentId;
}

function gradingStatus(value: unknown, error: string): GradingStatus {
  if (typeof value !== "string" || !(GRADING_STATUSES as readonly string[]).includes(value)) throw new Error(error);
  return value as GradingStatus;
}

function submissionBody(value: JsonObject, expected: MoodleAssignmentModuleExpectation): MoodleAssignmentSubmissionBody {
  const error = "moodle_assignment_submission_invalid";
  const assignmentId = moduleFields(value, MOODLE_ASSIGNMENT_SUBMISSION_SCHEMA, expected, error);
  const status = gradingStatus(value.grading_status, error);
  const extension = value.extension_due_date === null ? null : timestamp(value.extension_due_date);
  if (typeof value.locked !== "boolean" || typeof value.graded !== "boolean" || typeof value.blind_marking !== "boolean"
    || (value.extension_due_date !== null && extension === null)) {
    throw new Error(error);
  }
  const attemptSource = value.attempt === null ? null : isJsonObject(value.attempt) ? value.attempt : undefined;
  if (attemptSource === undefined) throw new Error(error);
  let attempt: MoodleAssignmentSubmissionAttempt | null = null;
  if (attemptSource) {
    const attemptNumber = count(attemptSource.attempt_number, ATTEMPT_LIMIT);
    const created = timestamp(attemptSource.time_created);
    const modified = timestamp(attemptSource.time_modified);
    const started = attemptSource.time_started === null ? null : timestamp(attemptSource.time_started);
    const attemptStatus = attemptSource.status;
    if (attemptNumber === null || created === null || modified === null
      || (attemptSource.time_started !== null && started === null)
      || typeof attemptStatus !== "string" || !(SUBMISSION_STATUSES as readonly string[]).includes(attemptStatus)) {
      throw new Error(error);
    }
    attempt = { attempt_number: attemptNumber, status: attemptStatus as SubmissionStatus, time_created: created, time_modified: modified, time_started: started };
  }
  if (!Array.isArray(value.submission_types) || value.submission_types.length > PLUGIN_LIMIT) throw new Error(error);
  const submissionTypes = value.submission_types.map((entry) => {
    const source = isJsonObject(entry) ? entry : null;
    const type = source ? boundedText(source.type) : null;
    const fileCount = source ? count(source.file_count, FILE_LIMIT) : null;
    if (!source || !type || fileCount === null || typeof source.has_content !== "boolean") throw new Error(error);
    return { type, has_content: source.has_content, file_count: fileCount };
  });
  if (new Set(submissionTypes.map((entry) => entry.type)).size !== submissionTypes.length) throw new Error(error);
  const fileList = files(value.files, error);
  const proof = isJsonObject(value.proof) ? value.proof : null;
  if (!proof || proof.method !== STATUS_METHOD || proof.complete !== true
    || proof.exact_module_binding !== MODULE_BINDING || proof.required_capability !== SUBMISSION_CAPABILITY
    || proof.submission_type_limit !== PLUGIN_LIMIT || proof.file_limit !== FILE_LIMIT
    || proof.file_count !== fileList.length || proof.includes_file_bytes !== false
    || submissionTypes.reduce((sum, entry) => sum + entry.file_count, 0) !== fileList.length) {
    throw new Error(error);
  }
  return {
    schema: MOODLE_ASSIGNMENT_SUBMISSION_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    module_id: expected.moduleId,
    assignment_id: assignmentId,
    attempt,
    grading_status: status,
    locked: value.locked,
    graded: value.graded,
    blind_marking: value.blind_marking,
    extension_due_date: extension,
    submission_types: submissionTypes,
    files: fileList,
    proof: {
      method: STATUS_METHOD,
      complete: true,
      exact_module_binding: MODULE_BINDING,
      required_capability: SUBMISSION_CAPABILITY,
      submission_type_limit: PLUGIN_LIMIT,
      file_limit: FILE_LIMIT,
      file_count: fileList.length,
      includes_file_bytes: false,
    },
  };
}

function feedbackBody(value: JsonObject, expected: MoodleAssignmentModuleExpectation): MoodleAssignmentFeedbackBody {
  const error = "moodle_assignment_feedback_invalid";
  const assignmentId = moduleFields(value, MOODLE_ASSIGNMENT_FEEDBACK_SCHEMA, expected, error);
  const status = gradingStatus(value.grading_status, error);
  const workflow = (WORKFLOW_STATES as readonly string[]).includes(status) ? status as WorkflowState : null;
  const grade = value.grade_value === null ? null : typeof value.grade_value === "number" && Number.isFinite(value.grade_value) && value.grade_value >= 0
    ? value.grade_value
    : undefined;
  const attemptNumber = value.grade_attempt_number === null ? null : count(value.grade_attempt_number, ATTEMPT_LIMIT);
  const gradedDate = value.graded_date === null ? null : timestamp(value.graded_date);
  if (value.marking_workflow_state !== workflow || typeof value.graded !== "boolean" || grade === undefined
    || (value.grade_attempt_number !== null && attemptNumber === null)
    || (value.graded_date !== null && gradedDate === null)) {
    throw new Error(error);
  }
  if (!Array.isArray(value.feedback_types) || value.feedback_types.length > PLUGIN_LIMIT) throw new Error(error);
  const feedbackTypes = value.feedback_types.map((entry) => {
    const source = isJsonObject(entry) ? entry : null;
    const type = source ? boundedText(source.type) : null;
    const fileCount = source ? count(source.file_count, FILE_LIMIT) : null;
    if (!source || !type || fileCount === null || typeof source.comment_present !== "boolean") throw new Error(error);
    return { type, comment_present: source.comment_present, file_count: fileCount };
  });
  if (new Set(feedbackTypes.map((entry) => entry.type)).size !== feedbackTypes.length) throw new Error(error);
  const fileList = files(value.files, error);
  const proof = isJsonObject(value.proof) ? value.proof : null;
  if (!proof || proof.method !== STATUS_METHOD || proof.complete !== true
    || proof.exact_module_binding !== MODULE_BINDING || proof.required_capability !== FEEDBACK_CAPABILITY
    || proof.feedback_type_limit !== PLUGIN_LIMIT || proof.file_limit !== FILE_LIMIT
    || proof.file_count !== fileList.length || proof.includes_feedback_text !== false || proof.includes_file_bytes !== false
    || feedbackTypes.reduce((sum, entry) => sum + entry.file_count, 0) !== fileList.length) {
    throw new Error(error);
  }
  return {
    schema: MOODLE_ASSIGNMENT_FEEDBACK_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    module_id: expected.moduleId,
    assignment_id: assignmentId,
    grading_status: status,
    marking_workflow_state: workflow,
    graded: value.graded,
    grade_value: grade,
    grade_attempt_number: attemptNumber,
    graded_date: gradedDate,
    feedback_types: feedbackTypes,
    files: fileList,
    proof: {
      method: STATUS_METHOD,
      complete: true,
      exact_module_binding: MODULE_BINDING,
      required_capability: FEEDBACK_CAPABILITY,
      feedback_type_limit: PLUGIN_LIMIT,
      file_limit: FILE_LIMIT,
      file_count: fileList.length,
      includes_feedback_text: false,
      includes_file_bytes: false,
    },
  };
}

function sourceLearner(
  value: unknown,
  expected: MoodleAssignmentLearnerExpectation,
  error: string,
): { readonly value: JsonObject; readonly userId: string } {
  if (!isJsonObject(value)) throw new Error(error);
  const learner = isJsonObject(value.learner) ? value.learner : null;
  if (!learner || Object.keys(learner).length !== 1
    || typeof learner.user_id !== "string" || positiveId(Number(learner.user_id)) !== expected.userId) {
    throw new Error(error);
  }
  return { value, userId: learner.user_id };
}

function publicLearner(value: unknown, error: string): { readonly value: JsonObject; readonly learnerToken: string } {
  if (!isJsonObject(value)) throw new Error(error);
  const learner = isJsonObject(value.learner) ? value.learner : null;
  if (!learner || Object.keys(learner).length !== 1
    || typeof learner.learnerToken !== "string" || !LEARNER_TOKEN.test(learner.learnerToken)) {
    throw new Error(error);
  }
  return { value, learnerToken: learner.learnerToken };
}

/**
 * Rebuilds the browser result for one requested learner. The identity survives
 * this step as `learner.user_id` only so the runtime can project it through the
 * complete course roster; nothing else from the source is carried.
 */
export function projectMoodleAssignmentSubmissionSource(
  value: unknown,
  expected: MoodleAssignmentLearnerExpectation,
): MoodleAssignmentSubmissionSource {
  const error = "moodle_assignment_submission_invalid";
  const source = sourceLearner(value, expected, error);
  return { ...submissionBody(source.value, expected), learner: { user_id: source.userId } };
}

/**
 * Re-validates a submission that already carries the public shape, which MCP
 * egress sees. That shape holds a vault token and no Moodle user ID, so a value
 * that still carries an identifier did not come from the roster boundary and is
 * refused.
 */
export function projectPublicMoodleAssignmentSubmission(
  value: unknown,
  expected: MoodleAssignmentModuleExpectation,
): MoodleAssignmentSubmission {
  const error = "moodle_assignment_submission_invalid";
  const projected = publicLearner(value, error);
  return { ...submissionBody(projected.value, expected), learner: { learnerToken: projected.learnerToken } };
}

export function projectMoodleAssignmentFeedbackSource(
  value: unknown,
  expected: MoodleAssignmentLearnerExpectation,
): MoodleAssignmentFeedbackSource {
  const error = "moodle_assignment_feedback_invalid";
  const source = sourceLearner(value, expected, error);
  return { ...feedbackBody(source.value, expected), learner: { user_id: source.userId } };
}

export function projectPublicMoodleAssignmentFeedback(
  value: unknown,
  expected: MoodleAssignmentModuleExpectation,
): MoodleAssignmentFeedback {
  const error = "moodle_assignment_feedback_invalid";
  const projected = publicLearner(value, error);
  return { ...feedbackBody(projected.value, expected), learner: { learnerToken: projected.learnerToken } };
}

export function projectMoodleAssignmentSubmissionBrowserResult(
  browserData: unknown,
  expected: MoodleAssignmentLearnerExpectation,
): JsonObject {
  return projectMoodleAssignmentSubmissionSource(browserData, expected) as unknown as JsonObject;
}

export function projectPublicMoodleAssignmentSubmissionResult(
  publicData: unknown,
  expected: MoodleAssignmentModuleExpectation,
): JsonObject {
  return projectPublicMoodleAssignmentSubmission(publicData, expected) as unknown as JsonObject;
}

export function projectMoodleAssignmentFeedbackBrowserResult(
  browserData: unknown,
  expected: MoodleAssignmentLearnerExpectation,
): JsonObject {
  return projectMoodleAssignmentFeedbackSource(browserData, expected) as unknown as JsonObject;
}

export function projectPublicMoodleAssignmentFeedbackResult(
  publicData: unknown,
  expected: MoodleAssignmentModuleExpectation,
): JsonObject {
  return projectPublicMoodleAssignmentFeedback(publicData, expected) as unknown as JsonObject;
}
