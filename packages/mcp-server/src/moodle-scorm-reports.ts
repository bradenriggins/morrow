import { isJsonObject, type JsonObject } from "@morrow/contracts";

export const MOODLE_SCORM_ATTEMPT_SUMMARY_OPERATION = "moodle.form.scorm.attempt_summary.read.v1";
export const MOODLE_SCORM_ATTEMPT_SUMMARY_TOOL = "moodle_get_scorm_attempt_summary";
export const MOODLE_SCORM_ATTEMPT_SUMMARY_SCHEMA = "morrow.moodle-scorm-attempt-summary.v1";

export const MOODLE_SCORM_LEARNER_REPORT_OPERATION = "moodle.form.scorm.learner_report.read.v1";
export const MOODLE_SCORM_LEARNER_REPORT_TOOL = "moodle_get_scorm_learner_report";
export const MOODLE_SCORM_LEARNER_REPORT_SCHEMA = "morrow.moodle-scorm-learner-report.v1";

const SUMMARY_METHOD = "core_table_get_dynamic_table_content+mod_scorm_get_scorm_scoes+mod_scorm_get_scorm_attempt_count+mod_scorm_get_scorm_sco_tracks";
const REPORT_METHOD = "mod_scorm_get_scorm_scoes+mod_scorm_get_scorm_attempt_count+mod_scorm_get_scorm_sco_tracks";
const REQUIRED_CAPABILITY = "mod/scorm:viewreport";
const MODULE_BINDING = "course_modedit_form";

const SUMMARY_PARTICIPANT_LIMIT = 10_000;
const SUMMARY_SCO_LIMIT = 200;
const SUMMARY_ATTEMPT_LIMIT = 50;
const SUMMARY_TOTAL_ATTEMPT_LIMIT = 5_000;
const SUMMARY_TRACK_REQUEST_LIMIT = 2_000;
const REPORT_ATTEMPT_LIMIT = 50;
const REPORT_SCO_LIMIT = 200;
const REPORT_TRACK_REQUEST_LIMIT = 500;

/** Moodle normalizes every SCORM 1.2 and 2004 status to one of these in scorm_format_interactions(). */
const STATUSES = ["passed", "completed", "failed", "incomplete", "browsed", "notattempted", "unknown"] as const;
const BUCKETS = ["0-19", "20-39", "40-59", "60-79", "80-100", "unscored"] as const;
const LEARNER_TOKEN = /^Student A[1-9][0-9]*$/u;

type ScormStatus = (typeof STATUSES)[number];
type ScormBucket = (typeof BUCKETS)[number];

export type MoodleScormAttemptSummary = Readonly<{
  schema: typeof MOODLE_SCORM_ATTEMPT_SUMMARY_SCHEMA;
  provider: "moodle";
  course_id: number;
  module_id: number;
  scorm_id: number;
  participant_count: number;
  attempted_participant_count: number;
  total_attempt_count: number;
  tracked_sco_count: number;
  tracked_record_count: number;
  sco_status_counts: Readonly<Record<ScormStatus, number>>;
  score_bucket_counts: Readonly<Record<ScormBucket, number>>;
  proof: Readonly<{
    method: typeof SUMMARY_METHOD;
    complete: true;
    exact_module_binding: typeof MODULE_BINDING;
    required_capability: typeof REQUIRED_CAPABILITY;
    participant_limit: typeof SUMMARY_PARTICIPANT_LIMIT;
    participant_response_rows: number;
    sco_limit: typeof SUMMARY_SCO_LIMIT;
    per_participant_attempt_limit: typeof SUMMARY_ATTEMPT_LIMIT;
    total_attempt_limit: typeof SUMMARY_TOTAL_ATTEMPT_LIMIT;
    track_request_limit: typeof SUMMARY_TRACK_REQUEST_LIMIT;
    track_request_count: number;
  }>;
}>;

export type MoodleScormLearnerRecord = Readonly<{
  sco_id: number;
  status: ScormStatus;
  score_percent: number | null;
}>;

export type MoodleScormLearnerAttempt = Readonly<{
  attempt: number;
  records: readonly MoodleScormLearnerRecord[];
}>;

type MoodleScormLearnerReportBody = Readonly<{
  schema: typeof MOODLE_SCORM_LEARNER_REPORT_SCHEMA;
  provider: "moodle";
  course_id: number;
  module_id: number;
  scorm_id: number;
  attempt_count: number;
  tracked_sco_count: number;
  attempts: readonly MoodleScormLearnerAttempt[];
  proof: Readonly<{
    method: typeof REPORT_METHOD;
    complete: true;
    exact_module_binding: typeof MODULE_BINDING;
    required_capability: typeof REQUIRED_CAPABILITY;
    attempt_limit: typeof REPORT_ATTEMPT_LIMIT;
    sco_limit: typeof REPORT_SCO_LIMIT;
    track_request_limit: typeof REPORT_TRACK_REQUEST_LIMIT;
    track_request_count: number;
  }>;
}>;

/** The browser shape, before the runtime projects the identity through the roster. */
export type MoodleScormLearnerReportSource = MoodleScormLearnerReportBody & Readonly<{
  learner: Readonly<{ user_id: string }>;
}>;

/** The only public shape. The learner identity exists here as a vault token only. */
export type MoodleScormLearnerReport = MoodleScormLearnerReportBody & Readonly<{
  learner: Readonly<{ learnerToken: string }>;
}>;

export type MoodleScormAttemptSummaryExpectation = Readonly<{ courseId: number; moduleId: number }>;
export type MoodleScormLearnerReportExpectation = Readonly<{ courseId: number; moduleId: number; userId: number }>;

function positiveId(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function count(value: unknown, maximum: number): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum ? Number(value) : null;
}

function countsFor<Key extends string>(
  value: unknown,
  keys: readonly Key[],
  total: number,
  error: string,
): Readonly<Record<Key, number>> {
  const source = isJsonObject(value) ? value : null;
  if (!source || Object.keys(source).length !== keys.length) throw new Error(error);
  const entries = keys.map((key) => [key, count(source[key], total)] as const);
  if (entries.some(([, entry]) => entry === null)
    || entries.reduce((sum, [, entry]) => sum + entry!, 0) !== total) throw new Error(error);
  return Object.fromEntries(entries.map(([key, entry]) => [key, entry!])) as Record<Key, number>;
}

/**
 * Creates the only public representation allowed for a Moodle SCORM attempt
 * response. Moodle's track rows carry the learner ID, the SCO ID, and every raw
 * SCORM element the package wrote; this projection rebuilds the aggregate from
 * fixed fields, so an unknown source field cannot reach MCP egress.
 */
export function projectMoodleScormAttemptSummary(
  value: unknown,
  expected: MoodleScormAttemptSummaryExpectation,
): MoodleScormAttemptSummary {
  const error = "moodle_scorm_attempt_summary_invalid";
  if (!isJsonObject(value) || value.schema !== MOODLE_SCORM_ATTEMPT_SUMMARY_SCHEMA || value.provider !== "moodle"
    || positiveId(value.course_id) !== expected.courseId || positiveId(value.module_id) !== expected.moduleId) {
    throw new Error(error);
  }
  const scormId = positiveId(value.scorm_id);
  const participantCount = count(value.participant_count, SUMMARY_PARTICIPANT_LIMIT);
  const attemptedCount = count(value.attempted_participant_count, participantCount ?? -1);
  const totalAttemptCount = count(value.total_attempt_count, SUMMARY_TOTAL_ATTEMPT_LIMIT);
  const trackedScoCount = count(value.tracked_sco_count, SUMMARY_SCO_LIMIT);
  const trackedRecordCount = count(value.tracked_record_count, SUMMARY_TRACK_REQUEST_LIMIT);
  const proof = isJsonObject(value.proof) ? value.proof : null;
  if (!scormId || participantCount === null || attemptedCount === null || totalAttemptCount === null
    || trackedScoCount === null || trackedRecordCount === null || !proof
    || proof.method !== SUMMARY_METHOD || proof.complete !== true
    || proof.exact_module_binding !== MODULE_BINDING || proof.required_capability !== REQUIRED_CAPABILITY
    || proof.participant_limit !== SUMMARY_PARTICIPANT_LIMIT || proof.participant_response_rows !== participantCount
    || proof.sco_limit !== SUMMARY_SCO_LIMIT || proof.per_participant_attempt_limit !== SUMMARY_ATTEMPT_LIMIT
    || proof.total_attempt_limit !== SUMMARY_TOTAL_ATTEMPT_LIMIT || proof.track_request_limit !== SUMMARY_TRACK_REQUEST_LIMIT
    || proof.track_request_count !== trackedRecordCount) {
    throw new Error(error);
  }
  return {
    schema: MOODLE_SCORM_ATTEMPT_SUMMARY_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    module_id: expected.moduleId,
    scorm_id: scormId,
    participant_count: participantCount,
    attempted_participant_count: attemptedCount,
    total_attempt_count: totalAttemptCount,
    tracked_sco_count: trackedScoCount,
    tracked_record_count: trackedRecordCount,
    sco_status_counts: countsFor(value.sco_status_counts, STATUSES, trackedRecordCount, error),
    score_bucket_counts: countsFor(value.score_bucket_counts, BUCKETS, trackedRecordCount, error),
    proof: {
      method: SUMMARY_METHOD,
      complete: true,
      exact_module_binding: MODULE_BINDING,
      required_capability: REQUIRED_CAPABILITY,
      participant_limit: SUMMARY_PARTICIPANT_LIMIT,
      participant_response_rows: participantCount,
      sco_limit: SUMMARY_SCO_LIMIT,
      per_participant_attempt_limit: SUMMARY_ATTEMPT_LIMIT,
      total_attempt_limit: SUMMARY_TOTAL_ATTEMPT_LIMIT,
      track_request_limit: SUMMARY_TRACK_REQUEST_LIMIT,
      track_request_count: trackedRecordCount,
    },
  };
}

export function projectMoodleScormAttemptSummaryBrowserResult(
  browserData: unknown,
  expected: MoodleScormAttemptSummaryExpectation,
): JsonObject {
  return projectMoodleScormAttemptSummary(browserData, expected) as JsonObject;
}

function learnerReportBody(
  value: JsonObject,
  expected: Readonly<{ courseId: number; moduleId: number }>,
): MoodleScormLearnerReportBody {
  const error = "moodle_scorm_learner_report_invalid";
  if (value.schema !== MOODLE_SCORM_LEARNER_REPORT_SCHEMA || value.provider !== "moodle"
    || positiveId(value.course_id) !== expected.courseId || positiveId(value.module_id) !== expected.moduleId) {
    throw new Error(error);
  }
  const scormId = positiveId(value.scorm_id);
  const attemptCount = count(value.attempt_count, REPORT_ATTEMPT_LIMIT);
  const trackedScoCount = count(value.tracked_sco_count, REPORT_SCO_LIMIT);
  const proof = isJsonObject(value.proof) ? value.proof : null;
  if (!scormId || attemptCount === null || trackedScoCount === null || !Array.isArray(value.attempts)
    || value.attempts.length !== attemptCount || attemptCount * trackedScoCount > REPORT_TRACK_REQUEST_LIMIT || !proof
    || proof.method !== REPORT_METHOD || proof.complete !== true
    || proof.exact_module_binding !== MODULE_BINDING || proof.required_capability !== REQUIRED_CAPABILITY
    || proof.attempt_limit !== REPORT_ATTEMPT_LIMIT || proof.sco_limit !== REPORT_SCO_LIMIT
    || proof.track_request_limit !== REPORT_TRACK_REQUEST_LIMIT
    || proof.track_request_count !== attemptCount * trackedScoCount) {
    throw new Error(error);
  }
  const attempts = value.attempts.map((entry, index) => {
    if (!isJsonObject(entry) || entry.attempt !== index + 1 || !Array.isArray(entry.records)
      || entry.records.length !== trackedScoCount) throw new Error(error);
    const records = entry.records.map((record) => {
      const source = isJsonObject(record) ? record : null;
      const scoId = source ? positiveId(source.sco_id) : null;
      const status = source?.status;
      const percent = source?.score_percent;
      if (!source || !scoId || typeof status !== "string" || !(STATUSES as readonly string[]).includes(status)
        || (percent !== null && count(percent, 100) === null)) throw new Error(error);
      return { sco_id: scoId, status: status as ScormStatus, score_percent: percent === null ? null : Number(percent) };
    });
    if (new Set(records.map((record) => record.sco_id)).size !== records.length) throw new Error(error);
    return { attempt: index + 1, records };
  });
  return {
    schema: MOODLE_SCORM_LEARNER_REPORT_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    module_id: expected.moduleId,
    scorm_id: scormId,
    attempt_count: attemptCount,
    tracked_sco_count: trackedScoCount,
    attempts,
    proof: {
      method: REPORT_METHOD,
      complete: true,
      exact_module_binding: MODULE_BINDING,
      required_capability: REQUIRED_CAPABILITY,
      attempt_limit: REPORT_ATTEMPT_LIMIT,
      sco_limit: REPORT_SCO_LIMIT,
      track_request_limit: REPORT_TRACK_REQUEST_LIMIT,
      track_request_count: attemptCount * trackedScoCount,
    },
  };
}

/**
 * Rebuilds the browser result for one requested learner. The identity survives
 * this step as `learner.user_id` only so the runtime can project it through the
 * complete course roster; nothing else from the source is carried.
 */
export function projectMoodleScormLearnerReportSource(
  value: unknown,
  expected: MoodleScormLearnerReportExpectation,
): MoodleScormLearnerReportSource {
  const error = "moodle_scorm_learner_report_invalid";
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
export function projectPublicMoodleScormLearnerReport(
  value: unknown,
  expected: Readonly<{ courseId: number; moduleId: number }>,
): MoodleScormLearnerReport {
  const error = "moodle_scorm_learner_report_invalid";
  if (!isJsonObject(value)) throw new Error(error);
  const learner = isJsonObject(value.learner) ? value.learner : null;
  if (!learner || Object.keys(learner).length !== 1
    || typeof learner.learnerToken !== "string" || !LEARNER_TOKEN.test(learner.learnerToken)) {
    throw new Error(error);
  }
  return { ...learnerReportBody(value, expected), learner: { learnerToken: learner.learnerToken } };
}

export function projectMoodleScormLearnerReportBrowserResult(
  browserData: unknown,
  expected: MoodleScormLearnerReportExpectation,
): JsonObject {
  return projectMoodleScormLearnerReportSource(browserData, expected) as unknown as JsonObject;
}

export function projectPublicMoodleScormLearnerReportResult(
  publicData: unknown,
  expected: Readonly<{ courseId: number; moduleId: number }>,
): JsonObject {
  return projectPublicMoodleScormLearnerReport(publicData, expected) as unknown as JsonObject;
}
