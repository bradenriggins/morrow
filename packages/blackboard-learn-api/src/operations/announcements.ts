import { canonicalJson, isJsonObject, sha256Text, type JsonObject, type SourceCapabilityMetadata } from "@morrow/contracts";
import * as z from "zod/v4";
import type { BlackboardLearnClient } from "../client.js";
import type { BlackboardEffectGrant } from "../effect-grant.js";
import { redactInto, type BlackboardCourseRead, type BlackboardLearnRuntime, type PreparedRoster } from "../runtime.js";
import { BLACKBOARD_ID, BlackboardApiError, withBlackboardDispatchState, type BlackboardDispatchState } from "../types.js";
import { blackboardTool, effectGrantInput, scopeInput, type BlackboardOperationModule } from "./definition.js";
import { READ_ANNOTATIONS, READ_BEHAVIOR, READ_PROFILES } from "./course-read.js";
// One date is read, frozen, and compared as one instant everywhere in this
// server, and one field list is pinned on a read the same way, so this module
// uses the same two helpers the gradebook routes use rather than a second copy.
import { instant, withFields } from "./gradebook.js";

/**
 * The one course-announcement path Morrow uses. Anthology's Learn REST reference
 * publishes an announcement service, and the swagger-generated endpoint index
 * this lane read lists the site-wide `/announcements` collection by name and
 * course announcements only in words. **No tenant Swagger has been read**, so
 * this exact course-scoped path is not proved against any Learn site.
 *
 * Morrow therefore resolves it against the site itself, before every
 * announcement read and before every announcement change: a Learn site that
 * answers this collection serves it, and a site that answers `404` or `405`
 * does not. A site that does not serve it gets `blackboard_operation_unavailable`
 * and the sentence below. Morrow never falls back to the site-wide collection,
 * and it guesses no second path.
 * https://developer.blackboard.com/portal/displayApi/Learn
 */
const ANNOUNCEMENTS_ROUTE = "/learn/api/public/v1/courses/{course_id}/announcements";
const ANNOUNCEMENT_ROUTE = `${ANNOUNCEMENTS_ROUTE}/{announcement_id}`;

/**
 * The site-wide announcement collection, which Morrow does not call. It is named
 * here only so a refusal can say what Morrow refused to do instead of falling
 * back to it: an announcement posted there reaches the whole Learn site, not the
 * one selected course.
 */
const SITE_ANNOUNCEMENTS_ROUTE = "/learn/api/public/v1/announcements";

const ROUTE_UNAVAILABLE = `This Blackboard site did not answer the course announcement collection at ${ANNOUNCEMENTS_ROUTE}. Morrow reads and writes course announcements at that one path and nowhere else. It does not fall back to the site-wide ${SITE_ANNOUNCEMENTS_ROUTE} collection, which would announce to the whole Blackboard site instead of this one course, and it guesses no other path. Ask your Blackboard administrator which announcement routes this site's Swagger publishes.`;

/**
 * What Morrow cannot do once an announcement has been sent, in the words every
 * announcement tool states. Blackboard can notify enrolled learners when an
 * announcement is posted, and Morrow holds no route that recalls a notification
 * a person has already received.
 */
const RECALL_LIMIT = "Morrow cannot recall a sent announcement. Blackboard can notify every enrolled learner when an announcement is posted, and no Morrow route takes that back. Whether a given Blackboard site sends e-mail for an announcement is one of that site's own settings, which Morrow cannot read and has not tested on a live tenant.";

/**
 * The request and response field names this module sends and reads. No tenant
 * Swagger has been read, so every name here is unverified against a live Learn
 * site. Nothing treats a missing field as an answer: a readback names each field
 * it compared and each field the site did not return under that name.
 */
const TITLE_FIELD = "title";
const BODY_FIELD = "body";
const AVAILABILITY_FIELD = "availability";
const DURATION_FIELD = "duration";
const SHOW_AT_TOP_FIELD = "showAtTopOfCourse";
const CREATED_FIELD = "created";

/** The exact fields every announcement read asks for, so no read is open-ended. */
const ANNOUNCEMENT_FIELDS = [
  "id", TITLE_FIELD, BODY_FIELD, AVAILABILITY_FIELD, SHOW_AT_TOP_FIELD, CREATED_FIELD,
];

/**
 * The two visibility windows Morrow reviews. `Continuous` is an announcement
 * shown from the moment it is posted until a person removes it. `DateRange` is
 * an announcement shown between one exact start and one exact end. Anthology's
 * announcement schema carries other duration values; Morrow sends neither of
 * them nor a partial window, because an announcement whose window it did not
 * review decides who reads it and when.
 */
const DURATION_CONTINUOUS = "Continuous";
const DURATION_RANGE = "DateRange";

/**
 * Morrow's own bounds on one reviewed announcement. They are not tenant limits:
 * no tenant Swagger has been read. They exist so a pasted document or a mistyped
 * value is refused here, before review, instead of being sent to every learner
 * in a course.
 */
const MAX_TITLE = 255;
const MAX_BODY = 10_000;

const SHA256 = /^[0-9a-f]{64}$/;

/** One short provider vocabulary value, such as `Continuous` or `DateRange`. */
const PROVIDER_ENUM = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

/** What every reviewed Blackboard change reports about itself, by Morrow profile. */
const WRITE_PROFILES = {
  "private-full": { state: "supported" },
  "public-canvas": { state: "profile_limited", reason: "This action needs a configured Blackboard REST tenant." },
  sandbox: { state: "profile_limited", reason: "This action needs a configured Blackboard REST tenant." },
  "read-only": { state: "profile_limited", reason: "This action requires an approved Morrow effect." },
} as const;

const COMPARATOR_PROFILES = {
  "private-full": { state: "supported" },
  "public-canvas": { state: "profile_limited", reason: "This action needs a configured Blackboard REST tenant." },
  sandbox: { state: "profile_limited", reason: "This action needs a configured Blackboard REST tenant." },
  "read-only": { state: "private_only", reason: "Gateway-only Blackboard verification." },
} as const;

const EVIDENCE = {
  live: { state: "unknown", reason: "api_configured_live_untested" },
  credentialBoundary: { state: "known" },
} as const;

const announcementIdInput = z.string().regex(BLACKBOARD_ID);

/** The exact announcement one plan reviews and one dispatch sends, in full. */
const announcementInput = {
  title: z.string().min(1).max(MAX_TITLE),
  body: z.string().min(1).max(MAX_BODY),
  duration_type: z.enum([DURATION_CONTINUOUS, DURATION_RANGE]),
  duration_start: z.string().min(1).max(64).optional(),
  duration_end: z.string().min(1).max(64).optional(),
  show_at_top_of_course: z.boolean(),
};

const announcementScopeInput = scopeInput.extend({ announcement_id: announcementIdInput });
const announcementPlanInput = scopeInput.extend(announcementInput);
const announcementApplyInput = announcementPlanInput.extend({
  expected_plan_digest: z.string().regex(SHA256),
  _morrow: z.strictObject({ outer_grant: effectGrantInput }),
});
const announcementPatchPlanInput = announcementScopeInput.extend(announcementInput);
const announcementPatchApplyInput = announcementPatchPlanInput.extend({
  expected_plan_digest: z.string().regex(SHA256),
  _morrow: z.strictObject({ outer_grant: effectGrantInput }),
});

type AnnouncementPlanInput = z.output<typeof announcementPlanInput>;
type AnnouncementPatchPlanInput = z.output<typeof announcementPatchPlanInput>;

/** One announcement as a plan freezes it, with every Morrow bound applied. */
interface ReviewedAnnouncement {
  readonly title: string;
  readonly body: string;
  readonly durationType: string;
  /** `null` for a continuous announcement, which Morrow gives no start or end. */
  readonly durationStart: string | null;
  readonly durationEnd: string | null;
  readonly showAtTopOfCourse: boolean;
}

function announcementsPath(courseId: string): string {
  return `/learn/api/public/v1/courses/${encodeURIComponent(courseId)}/announcements`;
}

function announcementPath(courseId: string, announcementId: string): string {
  return `${announcementsPath(courseId)}/${encodeURIComponent(announcementId)}`;
}

/** One Blackboard record identifier Morrow can name a record by, or `null`. */
function exactId(value: unknown): string | null {
  return typeof value === "string" && BLACKBOARD_ID.test(value) ? value : null;
}

/** One reviewed text value. Morrow sends the text it was given, with nothing trimmed off it. */
function reviewedText(value: string, label: string, max: number): string {
  if (!value || value.length > max || value !== value.trim()
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new BlackboardApiError("blackboard_response_invalid", `The Blackboard ${label} is invalid.`);
  }
  return value;
}

/**
 * The exact announcement one plan reviews and one dispatch sends. A window
 * Morrow did not review is refused here, before any Blackboard request: a
 * `DateRange` needs both an exact start and an exact end, in that order, and a
 * `Continuous` announcement takes neither.
 */
function reviewedAnnouncement(input: AnnouncementPlanInput | AnnouncementPatchPlanInput): ReviewedAnnouncement {
  const range = input.duration_type === DURATION_RANGE;
  const start = input.duration_start === undefined ? null : instant(input.duration_start);
  const end = input.duration_end === undefined ? null : instant(input.duration_end);
  if (range && (!start || !end)) {
    throw new BlackboardApiError(
      "blackboard_response_invalid",
      `A Blackboard announcement shown between two dates needs one exact start and one exact end, each written as one instant such as 2026-09-30T23:59:00.000Z.`,
    );
  }
  if (range && start && end && start >= end) {
    throw new BlackboardApiError(
      "blackboard_response_invalid",
      "A Blackboard announcement's end has to come after its start.",
    );
  }
  if (!range && (input.duration_start !== undefined || input.duration_end !== undefined)) {
    throw new BlackboardApiError(
      "blackboard_response_invalid",
      `A ${DURATION_CONTINUOUS} Blackboard announcement is shown from the moment it is posted until a person removes it, so Morrow sets no start and no end on one. Use ${DURATION_RANGE} to give it a window.`,
    );
  }
  return {
    title: reviewedText(input.title, "announcement title", MAX_TITLE),
    body: reviewedText(input.body, "announcement body", MAX_BODY),
    durationType: input.duration_type,
    durationStart: range ? start : null,
    durationEnd: range ? end : null,
    showAtTopOfCourse: input.show_at_top_of_course,
  };
}

/**
 * Refuses one reviewed announcement that names a person on this course's roster.
 *
 * An announcement goes to every enrolled learner, and Morrow's privacy boundary
 * replaces a roster identity in provider text with a protected reference before
 * that text leaves this server. Both are true of the text a person approves
 * here, so an announcement naming a learner would be reviewed as a token and
 * sent as a name: what a person read would not be what Blackboard receives.
 * Morrow refuses that announcement rather than send text nobody reviewed.
 */
function assertReviewable(announcement: ReviewedAnnouncement, roster: PreparedRoster): void {
  const redacted: JsonObject = {};
  redactInto(redacted, { [TITLE_FIELD]: announcement.title, [BODY_FIELD]: announcement.body }, [TITLE_FIELD, BODY_FIELD], roster, "announcement");
  if (redacted[TITLE_FIELD] === announcement.title && redacted[BODY_FIELD] === announcement.body) return;
  throw new BlackboardApiError(
    "blackboard_operation_unavailable",
    "This announcement names a person enrolled in the selected Blackboard course. An announcement goes to every enrolled learner, and Morrow shows a person on this course's roster as a protected reference rather than by name, so the text you would review is not the text Blackboard would receive. Write the announcement without the name, or post it in Blackboard.",
  );
}

/** The `availability.duration` object of one announcement record, or nothing. */
function durationOf(record: JsonObject): JsonObject | undefined {
  const availability = record[AVAILABILITY_FIELD];
  if (!isJsonObject(availability)) return undefined;
  const duration = availability[DURATION_FIELD];
  return isJsonObject(duration) ? duration : undefined;
}

/**
 * The exact request one approved dispatch sends. Morrow sends the whole
 * announcement, and the whole `availability.duration` object inside it, on a
 * create and on a change alike: public Blackboard documentation does not settle
 * whether a `PATCH` merges or replaces a nested object, and sending a partial
 * window could leave a date nobody reviewed deciding who reads this.
 */
function announcementRequest(announcement: ReviewedAnnouncement): JsonObject {
  return {
    [TITLE_FIELD]: announcement.title,
    [BODY_FIELD]: announcement.body,
    [AVAILABILITY_FIELD]: {
      [DURATION_FIELD]: {
        type: announcement.durationType,
        ...(announcement.durationStart ? { start: announcement.durationStart, end: announcement.durationEnd } : {}),
      },
    },
    [SHOW_AT_TOP_FIELD]: announcement.showAtTopOfCourse,
  };
}

/** The reviewed announcement as one plan and one dispatch both hash it. */
function frozenAnnouncement(announcement: ReviewedAnnouncement): JsonObject {
  return {
    title: announcement.title,
    body: announcement.body,
    durationType: announcement.durationType,
    durationStart: announcement.durationStart,
    durationEnd: announcement.durationEnd,
    showAtTopOfCourse: announcement.showAtTopOfCourse,
  };
}

/**
 * The frozen values of one existing announcement: the six fields a change
 * reviews, plus the record's own identity. A `PATCH` that clears one of them
 * fails the readback instead of being reported as a saved change.
 */
function protectedAnnouncement(record: JsonObject): JsonObject {
  const duration = durationOf(record);
  const output: JsonObject = {};
  if (record.id !== undefined) output.id = record.id;
  if (record[TITLE_FIELD] !== undefined) output.title = record[TITLE_FIELD];
  if (record[BODY_FIELD] !== undefined) output.body = record[BODY_FIELD];
  if (duration?.type !== undefined) output.durationType = duration.type;
  // A date is frozen and compared as one instant, so the same moment written two
  // ways is one value here.
  if (duration?.start !== undefined) output.durationStart = instant(duration.start) ?? duration.start;
  if (duration?.end !== undefined) output.durationEnd = instant(duration.end) ?? duration.end;
  if (record[SHOW_AT_TOP_FIELD] !== undefined) output.showAtTopOfCourse = record[SHOW_AT_TOP_FIELD];
  return output;
}

/**
 * One announcement as this module returns it. The title and the body pass the
 * same privacy boundary every other Blackboard text passes, so a learner named
 * in an announcement written in Blackboard leaves as a protected reference.
 */
function safeAnnouncement(record: JsonObject, roster: PreparedRoster): JsonObject {
  const id = exactId(record.id);
  if (!id) throw new BlackboardApiError("blackboard_response_invalid", "Blackboard announcement identity is invalid.");
  const output: JsonObject = { id };
  redactInto(output, record, [TITLE_FIELD, BODY_FIELD], roster, "announcement");
  const duration = durationOf(record);
  if (duration) {
    const type = typeof duration.type === "string" && PROVIDER_ENUM.test(duration.type) ? duration.type : undefined;
    const start = instant(duration.start);
    const end = instant(duration.end);
    output[AVAILABILITY_FIELD] = {
      [DURATION_FIELD]: { ...(type ? { type } : {}), ...(start ? { start } : {}), ...(end ? { end } : {}) },
    };
  }
  if (typeof record[SHOW_AT_TOP_FIELD] === "boolean") output[SHOW_AT_TOP_FIELD] = record[SHOW_AT_TOP_FIELD];
  const created = instant(record[CREATED_FIELD]);
  if (created) output[CREATED_FIELD] = created;
  return output;
}

function mismatch(detail: string, dispatchState: BlackboardDispatchState): BlackboardApiError {
  return new BlackboardApiError("blackboard_content_mismatch", detail, undefined, dispatchState);
}

/** Whether one failure is this Learn site saying it does not serve this route. */
function routeMissing(error: unknown): boolean {
  return error instanceof BlackboardApiError
    && error.code === "blackboard_request_failed"
    && (error.status === 404 || error.status === 405);
}

function routeUnavailable(): BlackboardApiError {
  return new BlackboardApiError("blackboard_operation_unavailable", ROUTE_UNAVAILABLE);
}

/**
 * Every announcement of the selected course, read to the end or refused. It is
 * also how Morrow resolves the course-announcement route: a site that does not
 * answer this collection does not serve course announcements, and every tool
 * here reports that instead of trying a second path.
 */
async function collectAnnouncements(
  client: BlackboardLearnClient,
  courseId: string,
  signal?: AbortSignal,
): Promise<readonly JsonObject[]> {
  try {
    return await client.collect(announcementsPath(courseId), { label: "course announcement", fields: ANNOUNCEMENT_FIELDS, signal });
  } catch (error) {
    if (routeMissing(error)) throw routeUnavailable();
    throw error;
  }
}

/**
 * One announcement of the selected course, by its exact id. A `404` here is
 * either a site that does not serve course announcements or an announcement this
 * course does not hold, and those are different answers to a person, so Morrow
 * reads the collection to tell them apart rather than reporting one as the
 * other. The course binding is the path itself: this record is read under the
 * selected course, through the client that refuses any other origin.
 */
async function readAnnouncement(
  client: BlackboardLearnClient,
  courseId: string,
  announcementId: string,
  signal?: AbortSignal,
): Promise<JsonObject> {
  let record: JsonObject;
  try {
    record = await client.get(withFields(announcementPath(courseId, announcementId), ANNOUNCEMENT_FIELDS), signal);
  } catch (error) {
    if (!routeMissing(error)) throw error;
    await collectAnnouncements(client, courseId, signal);
    throw new BlackboardApiError(
      "blackboard_content_mismatch",
      "Blackboard has no announcement with this id in the selected course.",
    );
  }
  if (record.id !== announcementId) {
    throw new BlackboardApiError("blackboard_content_mismatch", "Blackboard returned a different announcement than the one Morrow asked for.");
  }
  return record;
}

/**
 * What one fresh read has to say about a reviewed announcement, field by field.
 * `matched` is a value the site returned and Morrow compared. `unreported` is a
 * value the site did not return under the name Morrow read, which Morrow says it
 * did not compare rather than counting as agreement. `not_set` is a value the
 * reviewed announcement does not carry, which is every date on a continuous one.
 */
type FieldVerification = "matched" | "unreported" | "not_set";

/**
 * Compares one fresh announcement read against the reviewed announcement, and
 * reports what it compared. A value the site returned that is not the reviewed
 * one is a mismatch. The title and the visibility-window type have to come back:
 * they are what the announcement is called and whether it is live, and a site
 * that returns neither has not shown Morrow a saved announcement.
 *
 * A continuous announcement's dates are read and reported, not compared: Morrow
 * sets neither, no live Blackboard tenant has been read, and failing on a value
 * Morrow did not set would report a saved announcement as a failed one.
 */
function compareAnnouncement(
  record: JsonObject,
  announcement: ReviewedAnnouncement,
  dispatchState: BlackboardDispatchState,
): JsonObject {
  if (record[TITLE_FIELD] !== announcement.title) {
    throw mismatch("Blackboard returned a different title for this announcement.", dispatchState);
  }
  const duration = durationOf(record);
  const type = duration && typeof duration.type === "string" ? duration.type : null;
  if (type !== announcement.durationType) {
    throw mismatch(`Blackboard did not return this announcement as ${announcement.durationType}, so Morrow cannot say when learners see it.`, dispatchState);
  }
  const returnedBody = record[BODY_FIELD];
  if (typeof returnedBody === "string" && returnedBody !== announcement.body) {
    throw mismatch("Blackboard returned a different body for this announcement.", dispatchState);
  }
  const compareDate = (value: unknown, expected: string | null, label: string): FieldVerification => {
    if (expected === null) return "not_set";
    const returned = instant(value);
    if (returned === null) return "unreported";
    if (returned !== expected) throw mismatch(`Blackboard returned a different ${label} for this announcement.`, dispatchState);
    return "matched";
  };
  const returnedTop = record[SHOW_AT_TOP_FIELD];
  if (typeof returnedTop === "boolean" && returnedTop !== announcement.showAtTopOfCourse) {
    throw mismatch("Blackboard returned a different setting for whether this announcement sits at the top of the course.", dispatchState);
  }
  return {
    title: "matched",
    body: typeof returnedBody === "string" ? "matched" : "unreported",
    durationType: "matched",
    durationStart: compareDate(duration?.start, announcement.durationStart, "start date"),
    durationEnd: compareDate(duration?.end, announcement.durationEnd, "end date"),
    showAtTopOfCourse: typeof returnedTop === "boolean" ? "matched" : "unreported",
  };
}

/**
 * Whether one fresh read already carries the reviewed announcement. It is the
 * same comparison the readback makes, so a comparator and a dispatch can never
 * disagree about one announcement. Only a mismatch answers `false`; every other
 * failure is raised, because a comparator that swallowed one would report a
 * refusal as a record that does not match.
 */
function savedAnnouncement(record: JsonObject, announcement: ReviewedAnnouncement): boolean {
  try {
    compareAnnouncement(record, announcement, "not_sent");
    return true;
  } catch (error) {
    if (error instanceof BlackboardApiError && error.code === "blackboard_content_mismatch") return false;
    throw error;
  }
}

/** What the readback after each change proves, in plain words. */
const READBACK_DETAIL = "Morrow re-read the announcement by the id Blackboard returned and compared its title, its body, its visibility window, and whether it sits at the top of the course, against the reviewed plan. It names every one of those the site did not return under that name instead of counting it as agreement.";

const READBACK_STATE = "reviewed_fields";

function readCapability(sourceExport: string): SourceCapabilityMetadata {
  return {
    family: "course-read",
    provider: "blackboard",
    sourceExport,
    behavior: READ_BEHAVIOR,
    authority: { scopeClass: "tenant-course", approvalClass: "none", dataClass: "course" },
    route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
    profiles: READ_PROFILES,
    evidence: EVIDENCE,
  };
}

async function listCourseAnnouncements(
  runtime: BlackboardLearnRuntime,
  input: z.output<typeof scopeInput>,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const read = await runtime.beginCourseRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const records = await collectAnnouncements(read.client, read.courseId, signal);
  return {
    schema: "morrow.blackboard.course-announcements.v1",
    ok: true,
    tenantId: read.tenantId,
    sourceBindingId: read.sourceBindingId,
    courseId: read.courseId,
    announcements: records.map((record) => safeAnnouncement(record, read.roster)),
    count: records.length,
    recallLimit: RECALL_LIMIT,
    status: "api_configured_live_untested",
    diagnostics: read.cost(),
  };
}

async function readCourseAnnouncement(
  runtime: BlackboardLearnRuntime,
  input: z.output<typeof announcementScopeInput>,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const read = await runtime.beginCourseRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const record = await readAnnouncement(read.client, read.courseId, input.announcement_id, signal);
  return {
    schema: "morrow.blackboard.course-announcement.v1",
    ok: true,
    tenantId: read.tenantId,
    sourceBindingId: read.sourceBindingId,
    courseId: read.courseId,
    announcementId: input.announcement_id,
    announcement: safeAnnouncement(record, read.roster),
    recallLimit: RECALL_LIMIT,
    status: "api_configured_live_untested",
    diagnostics: read.cost(),
  };
}

/**
 * One digest over the tenant, the course connection, the course, and the exact
 * reviewed announcement. A create has no earlier record to freeze, so this is
 * the whole precondition. The body is inside it, so the text a person approved
 * is the only text a dispatch can send.
 */
function createPlanDigest(write: BlackboardCourseRead, announcement: ReviewedAnnouncement): string {
  return sha256Text(canonicalJson({
    tenantId: write.tenantId,
    sourceBindingId: write.sourceBindingId,
    courseId: write.courseId,
    announcement: frozenAnnouncement(announcement),
  }));
}

/**
 * One digest over the same values, the exact announcement being changed, and the
 * values that announcement holds now. An announcement edited after review, and a
 * request that names another announcement, both fail against it.
 */
function patchPlanDigest(
  write: BlackboardCourseRead,
  announcementId: string,
  beforeDigest: string,
  announcement: ReviewedAnnouncement,
): string {
  return sha256Text(canonicalJson({
    tenantId: write.tenantId,
    sourceBindingId: write.sourceBindingId,
    courseId: write.courseId,
    announcementId,
    beforeDigest,
    announcement: frozenAnnouncement(announcement),
  }));
}

function reservedGrant(value: z.output<typeof effectGrantInput>): BlackboardEffectGrant {
  return {
    schema: value.schema,
    operationId: value.operation_id,
    planDigest: value.plan_digest,
    outerPlanDigest: value.outer_plan_digest,
    approvalGrantDigest: value.approval_grant_digest,
    effectReceiptId: value.effect_receipt_id,
    dispatchAttempt: value.dispatch_attempt,
    gatewayProcessId: value.gateway_process_id,
    dispatchToken: value.dispatch_token,
  };
}

function announcementCreateTarget(runtime: BlackboardLearnRuntime, input: AnnouncementPlanInput) {
  return runtime.effectTarget({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, "course-announcement-create", {});
}

function announcementPatchTarget(runtime: BlackboardLearnRuntime, input: AnnouncementPatchPlanInput) {
  return runtime.effectTarget({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, "course-announcement", { announcementId: input.announcement_id });
}

/** What one approved announcement plan is bounded to: one announcement, no file, and nobody named. */
function planLimits(): JsonObject {
  return { announcements: 1, files: 0, learnersNamed: 0 };
}

/** One reviewed new announcement, frozen exactly as it will be sent. */
async function planCourseAnnouncement(
  runtime: BlackboardLearnRuntime,
  input: AnnouncementPlanInput,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const announcement = reviewedAnnouncement(input);
  runtime.assertEffectTargetFree(announcementCreateTarget(runtime, input));
  // A plan exists only to be dispatched, so it carries the write condition. An
  // instructor is refused before review instead of after approving an
  // announcement Morrow would then refuse to send.
  const write = await runtime.beginCourseWrite({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  assertReviewable(announcement, write.roster);
  // The route is resolved before review, so a site that does not serve course
  // announcements is named here rather than after a person approves one.
  await collectAnnouncements(write.client, write.courseId, signal);
  return {
    schema: "morrow.blackboard.course-announcement.plan.v1",
    ok: true,
    tenantId: write.tenantId,
    sourceBindingId: write.sourceBindingId,
    courseId: write.courseId,
    // The exact text one dispatch sends, in full, so whatever reviews this plan
    // reviews what Blackboard receives. The plan digest below covers it, and the
    // dispatch recomputes that digest, so no other text can be sent.
    announcement: frozenAnnouncement(announcement),
    planDigest: createPlanDigest(write, announcement),
    reviewRequired: true,
    limits: planLimits(),
    recallLimit: RECALL_LIMIT,
    readback: READBACK_STATE,
    readbackDetail: READBACK_DETAIL,
    status: "api_configured_live_untested",
    effect_scope: runtime.effectScope({
      tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
    }),
  };
}

/**
 * The one dispatch for a new announcement: it sends one create request and then
 * re-reads the announcement Blackboard named. Everything it can refuse it
 * refuses before that request leaves this process, and the one-use receipt is
 * spent before the first provider request, so two dispatches of one approval
 * cannot both post an announcement.
 *
 * A posted announcement cannot be taken back through this route. Once the
 * request has left Morrow, every failure below it is reported as
 * `applied_or_unknown`: an announcement Blackboard did not name, a record Morrow
 * could not read back, and a value that came back different are all conditions
 * where learners may already have been notified.
 */
async function applyReviewedCourseAnnouncement(
  runtime: BlackboardLearnRuntime,
  input: z.output<typeof announcementApplyInput>,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const grant = reservedGrant(input._morrow.outer_grant);
  runtime.assertReservedEffectGrant(grant);
  if (grant.planDigest !== input.expected_plan_digest) {
    throw new BlackboardApiError("blackboard_patch_review_required", "The Blackboard effect grant does not match this exact reviewed plan.");
  }
  const announcement = reviewedAnnouncement(input);
  const dispatch = runtime.claimReservedEffectGrant(grant, announcementCreateTarget(runtime, input));
  const write = await runtime.beginCourseWrite({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  assertReviewable(announcement, write.roster);
  if (createPlanDigest(write, announcement) !== input.expected_plan_digest) {
    throw new BlackboardApiError(
      "blackboard_patch_review_required",
      "This request does not describe the Blackboard announcement that was reviewed. Nothing was posted.",
    );
  }
  // The same read resolves the route and records the announcements this course
  // already holds, so the dispatch can refuse to report one of them as the
  // announcement it posted.
  const existing = (await collectAnnouncements(write.client, write.courseId, signal))
    .map((record) => exactId(record.id))
    .filter((id): id is string => id !== null);
  // Morrow cannot prove an announcement was not posted once the create request
  // has left this process. The marker is set on the line before that request, so
  // every failure from here on is reported as applied_or_unknown, and every
  // refusal raised above this point keeps not_sent.
  let dispatchState: BlackboardDispatchState = "not_sent";
  dispatch.markSent();
  try {
    dispatchState = "applied_or_unknown";
    const created = await write.client.post(announcementsPath(write.courseId), announcementRequest(announcement), signal);
    const announcementId = created ? exactId(created.id) : null;
    if (!announcementId) {
      throw mismatch("Blackboard did not name the announcement it created (id), so Morrow could not read it back.", dispatchState);
    }
    if (existing.includes(announcementId)) {
      throw mismatch("Blackboard named an announcement that was already in this course before this change.", dispatchState);
    }
    const record = await readAnnouncement(write.client, write.courseId, announcementId, signal);
    const verification = compareAnnouncement(record, announcement, dispatchState);
    dispatch.markVerified();
    return {
      schema: "morrow.blackboard.course-announcement.readback.v1",
      ok: true,
      // Morrow's operation journal reads this marker to decide what reached
      // Blackboard. The read payloads keep `status`, which is an evidence label.
      resultState: "applied",
      tenantId: write.tenantId,
      sourceBindingId: write.sourceBindingId,
      courseId: write.courseId,
      announcementId,
      announcement: safeAnnouncement(record, write.roster),
      verification,
      recallLimit: RECALL_LIMIT,
      readback: READBACK_STATE,
      readbackDetail: READBACK_DETAIL,
      status: "api_configured_live_untested",
    };
  } catch (error) {
    dispatch.markUncertain();
    throw withBlackboardDispatchState(error, dispatchState);
  }
}

/**
 * The Gateway's fresh-read comparator for one reviewed new announcement. It
 * holds no id from the dispatch, so it states only whether exactly one
 * announcement in this course now carries the reviewed values. The proof that
 * Blackboard created that exact record belongs to the dispatch above, which
 * holds the id Blackboard returned.
 *
 * It prepares no roster and reads no course membership, and it carries no
 * `diagnostics`, because the Gateway freezes this exact payload when it plans
 * the operation.
 */
async function verifyCourseAnnouncement(
  runtime: BlackboardLearnRuntime,
  input: AnnouncementPlanInput,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const announcement = reviewedAnnouncement(input);
  const comparator = await runtime.beginComparatorRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const records = await collectAnnouncements(comparator.client, comparator.courseId, signal);
  const matches = records.filter((record) => savedAnnouncement(record, announcement));
  const verified = matches.length === 1;
  runtime.recordEffectComparison(announcementCreateTarget(runtime, input), verified);
  return {
    schema: "morrow.blackboard.course-announcement.comparator.v1",
    ok: true,
    tenantId: comparator.tenantId,
    sourceBindingId: comparator.sourceBindingId,
    courseId: comparator.courseId,
    verified,
    readback: READBACK_STATE,
    status: "api_configured_live_untested",
  };
}

/** One fresh read of the exact announcement, frozen as the change's precondition. */
async function freezeAnnouncementPatch(
  write: BlackboardCourseRead,
  announcementId: string,
  announcement: ReviewedAnnouncement,
  signal?: AbortSignal,
): Promise<{ readonly record: JsonObject; readonly beforeDigest: string; readonly planDigest: string }> {
  const record = await readAnnouncement(write.client, write.courseId, announcementId, signal);
  const beforeDigest = sha256Text(canonicalJson(protectedAnnouncement(record)));
  return { record, beforeDigest, planDigest: patchPlanDigest(write, announcementId, beforeDigest, announcement) };
}

/** One reviewed change to an announcement this course already holds. */
async function planCourseAnnouncementPatch(
  runtime: BlackboardLearnRuntime,
  input: AnnouncementPatchPlanInput,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const announcement = reviewedAnnouncement(input);
  runtime.assertEffectTargetFree(announcementPatchTarget(runtime, input));
  const write = await runtime.beginCourseWrite({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  assertReviewable(announcement, write.roster);
  const frozen = await freezeAnnouncementPatch(write, input.announcement_id, announcement, signal);
  return {
    schema: "morrow.blackboard.course-announcement-patch.plan.v1",
    ok: true,
    tenantId: write.tenantId,
    sourceBindingId: write.sourceBindingId,
    courseId: write.courseId,
    announcementId: input.announcement_id,
    before: safeAnnouncement(frozen.record, write.roster),
    beforeDigest: frozen.beforeDigest,
    // The exact text one dispatch sends, in full, beside the announcement as it
    // is now.
    announcement: frozenAnnouncement(announcement),
    planDigest: frozen.planDigest,
    reviewRequired: true,
    limits: planLimits(),
    recallLimit: RECALL_LIMIT,
    readback: READBACK_STATE,
    readbackDetail: READBACK_DETAIL,
    status: "api_configured_live_untested",
    effect_scope: runtime.effectScope({
      tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
    }),
  };
}

/**
 * The one dispatch for a change to an announcement: it re-reads the exact
 * announcement, refuses when anything it froze changed after review, sends one
 * `PATCH`, and reads the announcement back.
 *
 * Changing an announcement does not take back the one that was already sent.
 * Learners who were notified of the earlier text keep that notification, so this
 * route reports the same `applied_or_unknown` after its request leaves Morrow
 * and offers no undo.
 */
async function applyReviewedCourseAnnouncementPatch(
  runtime: BlackboardLearnRuntime,
  input: z.output<typeof announcementPatchApplyInput>,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const grant = reservedGrant(input._morrow.outer_grant);
  runtime.assertReservedEffectGrant(grant);
  if (grant.planDigest !== input.expected_plan_digest) {
    throw new BlackboardApiError("blackboard_patch_review_required", "The Blackboard effect grant does not match this exact reviewed plan.");
  }
  const announcement = reviewedAnnouncement(input);
  const dispatch = runtime.claimReservedEffectGrant(grant, announcementPatchTarget(runtime, input));
  const write = await runtime.beginCourseWrite({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  assertReviewable(announcement, write.roster);
  const frozen = await freezeAnnouncementPatch(write, input.announcement_id, announcement, signal);
  if (frozen.planDigest !== input.expected_plan_digest) {
    // One digest binds the announcement, its frozen values, and the reviewed
    // text, so an announcement changed after review and a request that names
    // another announcement both fail here. The refusal names both, because this
    // route cannot tell them apart and must not report the wrong one.
    throw new BlackboardApiError(
      "blackboard_content_mismatch",
      "The Blackboard announcement Morrow read does not match the reviewed plan. It changed after review, or this request names a different announcement. The change was not sent.",
    );
  }
  let dispatchState: BlackboardDispatchState = "not_sent";
  dispatch.markSent();
  try {
    dispatchState = "applied_or_unknown";
    await write.client.patch(announcementPath(write.courseId, input.announcement_id), announcementRequest(announcement), signal);
    const record = await readAnnouncement(write.client, write.courseId, input.announcement_id, signal);
    const verification = compareAnnouncement(record, announcement, dispatchState);
    dispatch.markVerified();
    return {
      schema: "morrow.blackboard.course-announcement-patch.readback.v1",
      ok: true,
      resultState: "applied",
      tenantId: write.tenantId,
      sourceBindingId: write.sourceBindingId,
      courseId: write.courseId,
      announcementId: input.announcement_id,
      announcement: safeAnnouncement(record, write.roster),
      verification,
      recallLimit: RECALL_LIMIT,
      readback: READBACK_STATE,
      readbackDetail: READBACK_DETAIL,
      status: "api_configured_live_untested",
    };
  } catch (error) {
    dispatch.markUncertain();
    throw withBlackboardDispatchState(error, dispatchState);
  }
}

/**
 * The Gateway's fresh-read comparator for one reviewed announcement change. It
 * holds no frozen snapshot, so it states only whether the reviewed values are
 * saved on that announcement now. The precondition that catches an announcement
 * changed after review belongs to the dispatch above.
 */
async function verifyCourseAnnouncementPatch(
  runtime: BlackboardLearnRuntime,
  input: AnnouncementPatchPlanInput,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const announcement = reviewedAnnouncement(input);
  const comparator = await runtime.beginComparatorRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const record = await readAnnouncement(comparator.client, comparator.courseId, input.announcement_id, signal);
  const verified = savedAnnouncement(record, announcement);
  runtime.recordEffectComparison(announcementPatchTarget(runtime, input), verified);
  return {
    schema: "morrow.blackboard.course-announcement-patch.comparator.v1",
    ok: true,
    tenantId: comparator.tenantId,
    sourceBindingId: comparator.sourceBindingId,
    courseId: comparator.courseId,
    announcementId: input.announcement_id,
    verified,
    readback: READBACK_STATE,
    status: "api_configured_live_untested",
  };
}

/**
 * Blackboard course announcements. Two reads list what a course is announcing
 * and read one of them. Two reviewed changes post one announcement and change
 * one, each bound to the selected course by the path it is read and written
 * under.
 *
 * The limit every tool here states first is that Morrow cannot recall a sent
 * announcement. Blackboard can notify every enrolled learner when one is posted,
 * whether a given site sends e-mail for it is that site's own setting, which
 * Morrow cannot read and has not tested on a live tenant, and no Morrow route
 * takes a notification back. Both dispatch routes therefore declare
 * `behavior.irreversible: true`.
 *
 * The route itself is resolved against the site rather than assumed. Anthology
 * publishes an announcement service and no tenant Swagger has been read here, so
 * a site that does not answer the course-announcement collection is reported as
 * `blackboard_operation_unavailable` with the path Morrow looked for. Morrow
 * never falls back to the site-wide announcement collection, which would reach
 * the whole Learn site instead of this one course.
 *
 * An announcement that names a person on the course roster is refused before
 * review: the announcement goes to every enrolled learner, and Morrow shows a
 * roster identity as a protected reference, so the text a person would approve
 * would not be the text Blackboard receives. An announcement already written in
 * Blackboard is read back through that same privacy boundary, so a learner named
 * in one leaves Morrow as a protected reference.
 *
 * A change here is three separate routes, as every Morrow provider change is:
 * the plan an instructor reviews, the dispatch the Gateway makes once against a
 * signed one-use effect grant, and the fresh-read comparator. Neither change is
 * reachable: Morrow's Gateway has no public plan tool for a Blackboard
 * announcement, so nothing can plan, approve, or dispatch one.
 * docs/implementation/BLACKBOARD-REST-SCOPE.md records that.
 */
export const blackboardAnnouncementsModule: BlackboardOperationModule = {
  id: "announcements",
  tools: [
    blackboardTool({
      name: "blackboard_list_course_announcements",
      title: "List Blackboard course announcements",
      description: `List the announcements of one selected Blackboard Learn course: what each one is called, its text, when learners see it, and whether it sits at the top of the course. Learner identities in an announcement are replaced with protected references before output. ${RECALL_LIMIT}`,
      private: false,
      gatewayDispatchOnly: false,
      inputSchema: scopeInput,
      annotations: READ_ANNOTATIONS,
      capability: readCapability(`GET ${ANNOUNCEMENTS_ROUTE}`),
      rest: {
        method: "GET",
        pathTemplate: ANNOUNCEMENTS_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => listCourseAnnouncements(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_read_course_announcement",
      title: "Read one Blackboard course announcement",
      description: `Read one selected Blackboard Learn course announcement: what it is called, its text, when learners see it, and whether it sits at the top of the course. Find these with blackboard_list_course_announcements. Learner identities in the text are replaced with protected references before output. ${RECALL_LIMIT}`,
      private: false,
      gatewayDispatchOnly: false,
      inputSchema: announcementScopeInput,
      annotations: READ_ANNOTATIONS,
      capability: readCapability(`GET ${ANNOUNCEMENT_ROUTE}`),
      rest: {
        method: "GET",
        pathTemplate: ANNOUNCEMENT_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => readCourseAnnouncement(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_plan_course_announcement",
      title: "Plan one Blackboard course announcement",
      description: `Prepare one Blackboard Learn course announcement for Morrow review: its title, the exact text learners read, whether it is shown continuously or between two dates, and whether it sits at the top of the course. The plan carries the exact text that will be sent, and one approved plan posts it once. ${RECALL_LIMIT} An announcement that names a person enrolled in the course is refused. This tool posts nothing.`,
      private: true,
      gatewayDispatchOnly: false,
      inputSchema: announcementPlanInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: {
        family: "announcement-create",
        provider: "blackboard",
        sourceExport: `POST ${ANNOUNCEMENTS_ROUTE}`,
        behavior: {
          // This tool posts nothing. The dispatch route below is the one that
          // cannot be taken back, and it declares that.
          readOnly: true, mutating: false, destructive: false, irreversible: false,
          supportsDryRun: false, supportsReadback: true, supportsUndo: false, supportsBatch: false,
          requiresBrowser: false, requiresLiveCanvas: false,
        },
        authority: { scopeClass: "tenant-course", approvalClass: "standard", dataClass: "course" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: WRITE_PROFILES,
        evidence: EVIDENCE,
      },
      rest: {
        method: "GET",
        pathTemplate: ANNOUNCEMENTS_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => planCourseAnnouncement(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_apply_reviewed_course_announcement",
      title: "Post one reserved Blackboard course announcement",
      description: "Internal Morrow dispatch route. This request requires an exact signed Gateway effect grant.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: announcementApplyInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: {
        family: "announcement-create",
        provider: "blackboard",
        sourceExport: `POST ${ANNOUNCEMENTS_ROUTE}`,
        behavior: {
          // Blackboard can notify every enrolled learner when an announcement is
          // posted, and Morrow holds no route that takes that back.
          readOnly: false, mutating: true, destructive: false, irreversible: true,
          supportsDryRun: false, supportsReadback: true, supportsUndo: false, supportsBatch: false,
          requiresBrowser: false, requiresLiveCanvas: false,
        },
        authority: { scopeClass: "tenant-course", approvalClass: "standard", dataClass: "course" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: WRITE_PROFILES,
        evidence: EVIDENCE,
      },
      rest: {
        method: "POST",
        pathTemplate: ANNOUNCEMENTS_ROUTE,
        access: "write",
        entitlement: "unknown",
        reviewRoute: "blackboard_plan_course_announcement",
        readbackComparator: "blackboard_verify_course_announcement",
      },
      run: (runtime, input, signal) => applyReviewedCourseAnnouncement(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_verify_course_announcement",
      title: "Verify one Blackboard course announcement",
      description: "Internal Morrow fresh-read comparator for one reviewed Blackboard course announcement. It re-reads the course announcements and states whether exactly one carries the reviewed values.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: announcementPlanInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      capability: {
        family: "course-read",
        provider: "blackboard",
        sourceExport: `GET ${ANNOUNCEMENTS_ROUTE}`,
        behavior: READ_BEHAVIOR,
        authority: { scopeClass: "tenant-course", approvalClass: "none", dataClass: "course" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: COMPARATOR_PROFILES,
        evidence: EVIDENCE,
      },
      rest: {
        method: "GET",
        pathTemplate: ANNOUNCEMENTS_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => verifyCourseAnnouncement(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_plan_course_announcement_patch",
      title: "Plan one Blackboard course announcement change",
      description: `Prepare one change to an existing Blackboard Learn course announcement for Morrow review: its title, the exact text learners read, its visibility window, and whether it sits at the top of the course. The plan carries the announcement as it is now and the exact text that will replace it. ${RECALL_LIMIT} Changing an announcement does not take back the one learners already received. This tool changes nothing.`,
      private: true,
      gatewayDispatchOnly: false,
      inputSchema: announcementPatchPlanInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: {
        family: "announcement-update",
        provider: "blackboard",
        sourceExport: `PATCH ${ANNOUNCEMENT_ROUTE}`,
        behavior: {
          readOnly: true, mutating: false, destructive: false, irreversible: false,
          supportsDryRun: false, supportsReadback: true, supportsUndo: false, supportsBatch: false,
          requiresBrowser: false, requiresLiveCanvas: false,
        },
        authority: { scopeClass: "tenant-course", approvalClass: "standard", dataClass: "course" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: WRITE_PROFILES,
        evidence: EVIDENCE,
      },
      rest: {
        method: "GET",
        pathTemplate: ANNOUNCEMENT_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => planCourseAnnouncementPatch(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_apply_reviewed_course_announcement_patch",
      title: "Change one reserved Blackboard course announcement",
      description: "Internal Morrow dispatch route. This request requires an exact signed Gateway effect grant.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: announcementPatchApplyInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: {
        family: "announcement-update",
        provider: "blackboard",
        sourceExport: `PATCH ${ANNOUNCEMENT_ROUTE}`,
        behavior: {
          // The earlier announcement was already sent. Changing its text does
          // not take back a notification a learner has already received, and
          // Morrow holds no route that does.
          readOnly: false, mutating: true, destructive: false, irreversible: true,
          supportsDryRun: false, supportsReadback: true, supportsUndo: false, supportsBatch: false,
          requiresBrowser: false, requiresLiveCanvas: false,
        },
        authority: { scopeClass: "tenant-course", approvalClass: "standard", dataClass: "course" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: WRITE_PROFILES,
        evidence: EVIDENCE,
      },
      rest: {
        method: "PATCH",
        pathTemplate: ANNOUNCEMENT_ROUTE,
        access: "write",
        entitlement: "unknown",
        reviewRoute: "blackboard_plan_course_announcement_patch",
        readbackComparator: "blackboard_verify_course_announcement_patch",
      },
      run: (runtime, input, signal) => applyReviewedCourseAnnouncementPatch(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_verify_course_announcement_patch",
      title: "Verify one Blackboard course announcement change",
      description: "Internal Morrow fresh-read comparator for one reviewed Blackboard course announcement change. It re-reads that exact announcement and states whether it carries the reviewed values.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: announcementPatchPlanInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      capability: {
        family: "course-read",
        provider: "blackboard",
        sourceExport: `GET ${ANNOUNCEMENT_ROUTE}`,
        behavior: READ_BEHAVIOR,
        authority: { scopeClass: "tenant-course", approvalClass: "none", dataClass: "course" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: COMPARATOR_PROFILES,
        evidence: EVIDENCE,
      },
      rest: {
        method: "GET",
        pathTemplate: ANNOUNCEMENT_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => verifyCourseAnnouncementPatch(runtime, input, signal),
    }),
  ],
};
