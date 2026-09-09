import { isJsonObject, type JsonObject } from "@morrow/contracts";

export const MOODLE_COURSE_PARTICIPANTS_OPERATION = "moodle.form.enrol.participants.read.v1";
export const MOODLE_COURSE_PARTICIPANTS_TOOL = "moodle_get_course_participants";
export const MOODLE_COURSE_PARTICIPANTS_SCHEMA = "morrow.moodle-course-participants.v1";

export const MOODLE_ENROLMENT_METHODS_OPERATION = "moodle.form.enrol.methods.read.v1";
export const MOODLE_ENROLMENT_METHODS_TOOL = "moodle_get_enrolment_methods";
export const MOODLE_ENROLMENT_METHODS_SCHEMA = "morrow.moodle-enrolment-methods.v1";

export const MOODLE_PARTICIPANT_ENROLMENT_OPERATION = "moodle.form.enrol.participant.read.v1";
export const MOODLE_PARTICIPANT_ENROLMENT_TOOL = "moodle_get_participant_enrolment";
export const MOODLE_PARTICIPANT_ENROLMENT_SCHEMA = "morrow.moodle-participant-enrolment.v1";

/** The participants table both learner reads use. */
const TABLE_METHOD = "core_table_get_dynamic_table_content";
/** The native enrolment-methods page the course-level read uses. */
const PAGE_METHOD = "native_enrol_instances_page";
const REQUIRED_CAPABILITIES = ["moodle/course:viewparticipants", "moodle/course:enrolreview"] as const;
const PARTICIPANT_LIMIT = 500;
const PAGE_SIZE = 100;
const PAGE_REQUEST_LIMIT = PARTICIPANT_LIMIT / PAGE_SIZE;
const METHOD_LIMIT = 100;
const USER_LIMIT = 1_000_000;
const ROLE_LIMIT = 20;
const ENROLMENT_LIMIT = 20;
const LABEL_MAX = 200;
const LEARNER_TOKEN = /^Student A[1-9][0-9]*$/u;
const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;

export type MoodleCourseParticipantSource = Readonly<{
  user_id: string;
  roles: readonly string[];
  enrolment_methods: readonly string[];
}>;

export type MoodleCourseParticipant = Readonly<{
  learnerToken: string;
  roles: readonly string[];
  enrolment_methods: readonly string[];
}>;

type MoodleCourseParticipantsProof = Readonly<{
  method: typeof TABLE_METHOD;
  complete: true;
  required_capabilities: readonly [string, string];
  participant_limit: typeof PARTICIPANT_LIMIT;
  page_size: typeof PAGE_SIZE;
  page_request_limit: typeof PAGE_REQUEST_LIMIT;
  page_request_count: number;
  total_rows: number;
}>;

type MoodleCourseParticipantsBody = Readonly<{
  schema: typeof MOODLE_COURSE_PARTICIPANTS_SCHEMA;
  provider: "moodle";
  course_id: number;
  participant_count: number;
  proof: MoodleCourseParticipantsProof;
}>;

/** The browser shape, before the runtime projects each identity through the roster. */
export type MoodleCourseParticipantsSource = MoodleCourseParticipantsBody & Readonly<{
  participants: readonly MoodleCourseParticipantSource[];
}>;

/** The only public shape. Every identity exists here as a vault token only. */
export type MoodleCourseParticipants = MoodleCourseParticipantsBody & Readonly<{
  participants: readonly MoodleCourseParticipant[];
}>;

export type MoodleEnrolmentMethod = Readonly<{
  name: string;
  enabled: boolean;
  participant_count: number;
}>;

export type MoodleEnrolmentMethods = Readonly<{
  schema: typeof MOODLE_ENROLMENT_METHODS_SCHEMA;
  provider: "moodle";
  course_id: number;
  method_count: number;
  methods: readonly MoodleEnrolmentMethod[];
  proof: Readonly<{
    method: typeof PAGE_METHOD;
    complete: true;
    required_capabilities: readonly [string, string];
    method_limit: typeof METHOD_LIMIT;
  }>;
}>;

export type MoodleParticipantEnrolmentRecord = Readonly<{
  method: string;
  status: string;
  start: string | null;
  end: string | null;
}>;

type MoodleParticipantEnrolmentBody = Readonly<{
  schema: typeof MOODLE_PARTICIPANT_ENROLMENT_SCHEMA;
  provider: "moodle";
  course_id: number;
  enrolment_count: number;
  enrolments: readonly MoodleParticipantEnrolmentRecord[];
  proof: Readonly<{
    method: typeof TABLE_METHOD;
    complete: true;
    required_capabilities: readonly [string, string];
    participant_limit: typeof PARTICIPANT_LIMIT;
    page_size: typeof PAGE_SIZE;
    page_request_limit: typeof PAGE_REQUEST_LIMIT;
    page_request_count: number;
  }>;
}>;

export type MoodleParticipantEnrolmentSource = MoodleParticipantEnrolmentBody & Readonly<{
  learner: Readonly<{ user_id: string }>;
}>;

export type MoodleParticipantEnrolment = MoodleParticipantEnrolmentBody & Readonly<{
  learner: Readonly<{ learnerToken: string }>;
}>;

export type MoodleCourseExpectation = Readonly<{ courseId: number }>;
export type MoodleParticipantExpectation = Readonly<{ courseId: number; userId: number }>;

function positiveId(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function count(value: unknown, maximum: number): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum ? Number(value) : null;
}

function capabilities(value: unknown): boolean {
  return Array.isArray(value) && value.length === REQUIRED_CAPABILITIES.length
    && REQUIRED_CAPABILITIES.every((capability, index) => value[index] === capability);
}

/**
 * A short source label: a role name, an enrolment-method name, or the status
 * word the site itself rendered. Control characters and untrimmed whitespace
 * are refused so a label cannot smuggle layout or markup into a result.
 */
function label(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= LABEL_MAX
    && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function labels(value: unknown, maximum: number): readonly string[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null;
  const projected = value.map(label);
  return projected.every((entry): entry is string => entry !== null) ? projected : null;
}

/** An exact UTC instant that round-trips, or null for an enrolment with no bound. */
function instant(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || !INSTANT.test(value)) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : undefined;
}

function participantsBody(value: JsonObject, expected: MoodleCourseExpectation, error: string): MoodleCourseParticipantsBody {
  const participantCount = count(value.participant_count, PARTICIPANT_LIMIT);
  const proof = isJsonObject(value.proof) ? value.proof : null;
  if (value.schema !== MOODLE_COURSE_PARTICIPANTS_SCHEMA || value.provider !== "moodle"
    || positiveId(value.course_id) !== expected.courseId || participantCount === null || !proof
    || !Array.isArray(value.participants) || value.participants.length !== participantCount) {
    throw new Error(error);
  }
  const pageRequestCount = count(proof.page_request_count, PAGE_REQUEST_LIMIT);
  // The table's own total row count must equal the list Morrow returns. A list
  // shorter than the table is an incomplete read, never a whole-course answer.
  if (proof.method !== TABLE_METHOD || proof.complete !== true || !capabilities(proof.required_capabilities)
    || proof.participant_limit !== PARTICIPANT_LIMIT || proof.page_size !== PAGE_SIZE
    || proof.page_request_limit !== PAGE_REQUEST_LIMIT || pageRequestCount === null || pageRequestCount < 1
    || proof.total_rows !== participantCount) {
    throw new Error(error);
  }
  return {
    schema: MOODLE_COURSE_PARTICIPANTS_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    participant_count: participantCount,
    proof: {
      method: TABLE_METHOD,
      complete: true,
      required_capabilities: [REQUIRED_CAPABILITIES[0], REQUIRED_CAPABILITIES[1]],
      participant_limit: PARTICIPANT_LIMIT,
      page_size: PAGE_SIZE,
      page_request_limit: PAGE_REQUEST_LIMIT,
      page_request_count: pageRequestCount,
      total_rows: participantCount,
    },
  };
}

function participantFields(value: unknown, error: string): Readonly<{ source: JsonObject; roles: readonly string[]; methods: readonly string[] }> {
  const source = isJsonObject(value) ? value : null;
  const roles = source ? labels(source.roles, ROLE_LIMIT) : null;
  const methods = source ? labels(source.enrolment_methods, ENROLMENT_LIMIT) : null;
  // An enrolment column Morrow could not read is an unauthorized read, not an
  // unenrolled participant, so an empty method list is refused here.
  if (!source || !roles || !methods || methods.length === 0 || Object.keys(source).length !== 3) throw new Error(error);
  return { source, roles, methods };
}

/**
 * Rebuilds the browser participant list. Each identity survives this step as
 * `user_id` only so the runtime can project it through the complete course
 * roster; no other source field is carried.
 */
export function projectMoodleCourseParticipantsSource(
  value: unknown,
  expected: MoodleCourseExpectation,
): MoodleCourseParticipantsSource {
  const error = "moodle_course_participants_invalid";
  if (!isJsonObject(value)) throw new Error(error);
  const body = participantsBody(value, expected, error);
  const participants = (value.participants as readonly unknown[]).map((entry) => {
    const { source, roles, methods } = participantFields(entry, error);
    const userId = typeof source.user_id === "string" ? positiveId(Number(source.user_id)) : null;
    if (userId === null) throw new Error(error);
    return { user_id: source.user_id as string, roles, enrolment_methods: methods };
  });
  if (new Set(participants.map((entry) => entry.user_id)).size !== participants.length) throw new Error(error);
  return { ...body, participants };
}

/**
 * Re-validates a participant list that already carries the public shape, which
 * MCP egress sees. That shape holds a vault token and no Moodle user ID, so a
 * value that still carries an identifier did not come from the roster boundary
 * and is refused.
 */
export function projectPublicMoodleCourseParticipants(
  value: unknown,
  expected: MoodleCourseExpectation,
): MoodleCourseParticipants {
  const error = "moodle_course_participants_invalid";
  if (!isJsonObject(value)) throw new Error(error);
  const body = participantsBody(value, expected, error);
  const participants = (value.participants as readonly unknown[]).map((entry) => {
    const { source, roles, methods } = participantFields(entry, error);
    const learnerToken = typeof source.learnerToken === "string" && LEARNER_TOKEN.test(source.learnerToken)
      ? source.learnerToken
      : null;
    if (!learnerToken) throw new Error(error);
    return { learnerToken, roles, enrolment_methods: methods };
  });
  if (new Set(participants.map((entry) => entry.learnerToken)).size !== participants.length) throw new Error(error);
  return { ...body, participants };
}

export function projectMoodleCourseParticipantsBrowserResult(
  browserData: unknown,
  expected: MoodleCourseExpectation,
): JsonObject {
  return projectMoodleCourseParticipantsSource(browserData, expected) as unknown as JsonObject;
}

export function projectPublicMoodleCourseParticipantsResult(
  publicData: unknown,
  expected: MoodleCourseExpectation,
): JsonObject {
  return projectPublicMoodleCourseParticipants(publicData, expected) as unknown as JsonObject;
}

/**
 * The course's enrolment methods. This read carries no learner identity, so it
 * has one shape at the browser boundary and at MCP egress.
 */
export function projectMoodleEnrolmentMethods(
  value: unknown,
  expected: MoodleCourseExpectation,
): MoodleEnrolmentMethods {
  const error = "moodle_enrolment_methods_invalid";
  if (!isJsonObject(value) || value.schema !== MOODLE_ENROLMENT_METHODS_SCHEMA || value.provider !== "moodle"
    || positiveId(value.course_id) !== expected.courseId) {
    throw new Error(error);
  }
  const methodCount = count(value.method_count, METHOD_LIMIT);
  const proof = isJsonObject(value.proof) ? value.proof : null;
  if (methodCount === null || !proof || !Array.isArray(value.methods) || value.methods.length !== methodCount) {
    throw new Error(error);
  }
  if (proof.method !== PAGE_METHOD || proof.complete !== true || !capabilities(proof.required_capabilities)
    || proof.method_limit !== METHOD_LIMIT) {
    throw new Error(error);
  }
  const methods = value.methods.map((entry) => {
    const source = isJsonObject(entry) ? entry : null;
    const name = source ? label(source.name) : null;
    const participantCount = source ? count(source.participant_count, USER_LIMIT) : null;
    if (!source || !name || participantCount === null || typeof source.enabled !== "boolean"
      || Object.keys(source).length !== 3) {
      throw new Error(error);
    }
    return { name, enabled: source.enabled, participant_count: participantCount };
  });
  return {
    schema: MOODLE_ENROLMENT_METHODS_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    method_count: methodCount,
    methods,
    proof: {
      method: PAGE_METHOD,
      complete: true,
      required_capabilities: [REQUIRED_CAPABILITIES[0], REQUIRED_CAPABILITIES[1]],
      method_limit: METHOD_LIMIT,
    },
  };
}

export function projectMoodleEnrolmentMethodsBrowserResult(
  browserData: unknown,
  expected: MoodleCourseExpectation,
): JsonObject {
  return projectMoodleEnrolmentMethods(browserData, expected) as unknown as JsonObject;
}

function participantEnrolmentBody(
  value: JsonObject,
  expected: MoodleCourseExpectation,
  error: string,
): MoodleParticipantEnrolmentBody {
  const enrolmentCount = count(value.enrolment_count, ENROLMENT_LIMIT);
  const proof = isJsonObject(value.proof) ? value.proof : null;
  if (value.schema !== MOODLE_PARTICIPANT_ENROLMENT_SCHEMA || value.provider !== "moodle"
    || positiveId(value.course_id) !== expected.courseId || enrolmentCount === null || enrolmentCount === 0
    || !proof || !Array.isArray(value.enrolments) || value.enrolments.length !== enrolmentCount) {
    throw new Error(error);
  }
  const pageRequestCount = count(proof.page_request_count, PAGE_REQUEST_LIMIT);
  if (proof.method !== TABLE_METHOD || proof.complete !== true || !capabilities(proof.required_capabilities)
    || proof.participant_limit !== PARTICIPANT_LIMIT || proof.page_size !== PAGE_SIZE
    || proof.page_request_limit !== PAGE_REQUEST_LIMIT || pageRequestCount === null || pageRequestCount < 1) {
    throw new Error(error);
  }
  const enrolments = value.enrolments.map((entry) => {
    const source = isJsonObject(entry) ? entry : null;
    const method = source ? label(source.method) : null;
    const status = source ? label(source.status) : null;
    const start = source ? instant(source.start) : undefined;
    const end = source ? instant(source.end) : undefined;
    if (!source || !method || !status || start === undefined || end === undefined
      || Object.keys(source).length !== 4 || (start !== null && end !== null && end < start)) {
      throw new Error(error);
    }
    return { method, status, start, end };
  });
  return {
    schema: MOODLE_PARTICIPANT_ENROLMENT_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    enrolment_count: enrolmentCount,
    enrolments,
    proof: {
      method: TABLE_METHOD,
      complete: true,
      required_capabilities: [REQUIRED_CAPABILITIES[0], REQUIRED_CAPABILITIES[1]],
      participant_limit: PARTICIPANT_LIMIT,
      page_size: PAGE_SIZE,
      page_request_limit: PAGE_REQUEST_LIMIT,
      page_request_count: pageRequestCount,
    },
  };
}

/**
 * Rebuilds the browser result for one requested learner. The identity survives
 * this step as `learner.user_id` only, so the runtime can project it through
 * the complete course roster.
 */
export function projectMoodleParticipantEnrolmentSource(
  value: unknown,
  expected: MoodleParticipantExpectation,
): MoodleParticipantEnrolmentSource {
  const error = "moodle_participant_enrolment_invalid";
  if (!isJsonObject(value)) throw new Error(error);
  const learner = isJsonObject(value.learner) ? value.learner : null;
  if (!learner || Object.keys(learner).length !== 1 || typeof learner.user_id !== "string"
    || positiveId(Number(learner.user_id)) !== expected.userId) {
    throw new Error(error);
  }
  return { ...participantEnrolmentBody(value, expected, error), learner: { user_id: learner.user_id } };
}

/**
 * Re-validates an enrolment record that already carries the public shape. That
 * shape holds a vault token and no Moodle user ID, so a value that still
 * carries an identifier did not come from the roster boundary and is refused.
 */
export function projectPublicMoodleParticipantEnrolment(
  value: unknown,
  expected: MoodleCourseExpectation,
): MoodleParticipantEnrolment {
  const error = "moodle_participant_enrolment_invalid";
  if (!isJsonObject(value)) throw new Error(error);
  const learner = isJsonObject(value.learner) ? value.learner : null;
  if (!learner || Object.keys(learner).length !== 1 || typeof learner.learnerToken !== "string"
    || !LEARNER_TOKEN.test(learner.learnerToken)) {
    throw new Error(error);
  }
  return { ...participantEnrolmentBody(value, expected, error), learner: { learnerToken: learner.learnerToken } };
}

export function projectMoodleParticipantEnrolmentBrowserResult(
  browserData: unknown,
  expected: MoodleParticipantExpectation,
): JsonObject {
  return projectMoodleParticipantEnrolmentSource(browserData, expected) as unknown as JsonObject;
}

export function projectPublicMoodleParticipantEnrolmentResult(
  publicData: unknown,
  expected: MoodleCourseExpectation,
): JsonObject {
  return projectPublicMoodleParticipantEnrolment(publicData, expected) as unknown as JsonObject;
}
