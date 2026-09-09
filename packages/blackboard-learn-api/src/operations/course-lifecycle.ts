import { canonicalJson, isJsonObject, sha256Text, type JsonObject, type SourceCapabilityMetadata } from "@morrow/contracts";
import * as z from "zod/v4";
import type { BlackboardLearnClient } from "../client.js";
import type { BlackboardEffectGrant } from "../effect-grant.js";
import { safeContent, safeCourse, type BlackboardCourseRead, type BlackboardLearnRuntime, type PreparedRoster } from "../runtime.js";
import { BLACKBOARD_ID, BlackboardApiError, withBlackboardDispatchState, type BlackboardDispatchState } from "../types.js";
import { blackboardTool, contentScopeInput, effectGrantInput, scopeInput, type BlackboardOperationModule } from "./definition.js";
import { READ_ANNOTATIONS, READ_BEHAVIOR } from "./course-read.js";
// One date is read, frozen, and compared as one instant everywhere in this
// server, and one field list is pinned on a single-record read the same way, so
// this module uses those helpers rather than a second copy of either.
import { instant, withFields } from "./gradebook.js";

/**
 * The course fields this module reads, freezes, and compares. The recovery
 * contract pins the first five (docs/research/blackboard-recovery-contract.md:178)
 * and this module adds `availability`, which holds both values it changes.
 */
const COURSE_FIELDS = ["id", "courseId", "name", "ultraStatus", "closedComplete", "availability"];

/** The route templates the generated catalog records. */
const COURSE_PATCH_ROUTE = "/learn/api/public/v3/courses/{course_id}";
const COURSE_READ_ROUTE = `${COURSE_PATCH_ROUTE}?fields=${COURSE_FIELDS.join(",")}`;
const CONTENT_ROUTE = "/learn/api/public/v1/courses/{course_id}/contents/{content_id}";
const COURSE_COPY_ROUTE = "/learn/api/public/v2/courses/{course_id}/copy";
const COURSE_COPY_TASK_ROUTE = "/learn/api/public/v1/courses/{course_id}/tasks/{task_id}";

const AVAILABILITY_FIELD = "availability";
const DURATION_FIELD = "duration";
const ADAPTIVE_RELEASE_FIELD = "adaptiveRelease";

/**
 * The two course windows Morrow reviews. `Continuous` is a course open from the
 * moment it is available until a person closes it. `DateRange` is a course open
 * between one exact start and one exact end. Anthology's course schema carries
 * other duration values: a term, and a fixed number of days from each learner's
 * enrolment. Morrow sends neither because both decide when learners reach a course
 * from a record Morrow has not read.
 */
const DURATION_CONTINUOUS = "Continuous";
const DURATION_RANGE = "DateRange";

/**
 * The Blackboard content handler this module changes, and the folder handler it
 * refuses, on the same contract as the content patch
 * (docs/research/blackboard-recovery-contract.md:199-203). An Ultra document
 * body is a `resource/x-bb-document` child of a `resource/x-bb-folder` whose
 * `isBbPage` is true, so dates addressed to the wrapper are dates on the
 * container around the document.
 * https://docs.blackboard.com/docs/blackboard/rest-apis/advanced/content-handler
 */
const DOCUMENT_HANDLER = "resource/x-bb-document";
const FOLDER_HANDLER = "resource/x-bb-folder";

/**
 * The course fields Morrow freezes before a course change and re-checks after
 * it. Public Blackboard documentation does not settle whether a `PATCH` merges
 * or replaces a nested object such as `availability`, so a course whose name or
 * dates come back changed fails the readback instead of being reported as
 * verified. docs/research/blackboard-recovery-contract.md:217-221
 */
const PROTECTED_COURSE_FIELDS: readonly (readonly string[])[] = [
  ["id"],
  ["courseId"],
  ["name"],
  ["ultraStatus"],
  ["closedComplete"],
  [AVAILABILITY_FIELD, "available"],
  [AVAILABILITY_FIELD, DURATION_FIELD, "type"],
  [AVAILABILITY_FIELD, DURATION_FIELD, "start"],
  [AVAILABILITY_FIELD, DURATION_FIELD, "end"],
  [AVAILABILITY_FIELD, DURATION_FIELD, "daysOfUse"],
];

/**
 * The frozen course fields a reviewed duration change may legitimately move, so
 * Morrow names them instead of comparing them. A course changed to `Continuous`
 * keeps or clears its old dates by a rule no tenant has shown Morrow, and a
 * course changed to `DateRange` may lose the day count a term-length course
 * carried. Every readback lists the ones it did not compare, so a value Morrow
 * did not check is never reported as one it did.
 */
const DURATION_DEPENDENT_FIELDS = [
  `${AVAILABILITY_FIELD}.${DURATION_FIELD}.start`,
  `${AVAILABILITY_FIELD}.${DURATION_FIELD}.end`,
  `${AVAILABILITY_FIELD}.${DURATION_FIELD}.daysOfUse`,
];

/**
 * The content fields Morrow freezes before a dated-visibility change and
 * re-checks after it. It is the content patch's protected set with
 * `availability.adaptiveRelease` opened into the two dates this module writes,
 * so a site that clears the end date while it sets the start date fails the
 * readback. packages/blackboard-learn-api/src/runtime.ts
 */
const PROTECTED_CONTENT_FIELDS: readonly (readonly string[])[] = [
  ["id"],
  ["parentId"],
  ["courseId"],
  ["contentHandler", "id"],
  ["title"],
  ["description"],
  ["position"],
  [AVAILABILITY_FIELD, "available"],
  [AVAILABILITY_FIELD, "allowGuests"],
  [AVAILABILITY_FIELD, ADAPTIVE_RELEASE_FIELD, "start"],
  [AVAILABILITY_FIELD, ADAPTIVE_RELEASE_FIELD, "end"],
];

const ADAPTIVE_START = `${AVAILABILITY_FIELD}.${ADAPTIVE_RELEASE_FIELD}.start`;
const ADAPTIVE_END = `${AVAILABILITY_FIELD}.${ADAPTIVE_RELEASE_FIELD}.end`;

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

const SHA256 = /^[0-9a-f]{64}$/;

/** One short provider vocabulary value, such as `Ultra`, `Yes`, or `DateRange`. */
const PROVIDER_ENUM = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

/** The Blackboard course role Morrow counts as a learner in what it states about access. */
const LEARNER_ROLE = "Student";

/** One date as a request carries it, or `null` to clear a date the item holds. */
const dateInput = z.union([z.string().min(1).max(64), z.null()]);

const courseAvailabilityInput = scopeInput.extend({
  available: z.enum(["Yes", "No"]).optional(),
  duration_type: z.enum([DURATION_CONTINUOUS, DURATION_RANGE]).optional(),
  duration_start: z.string().min(1).max(64).optional(),
  duration_end: z.string().min(1).max(64).optional(),
});
const courseAvailabilityApplyInput = courseAvailabilityInput.extend({
  expected_plan_digest: z.string().regex(SHA256),
  _morrow: z.strictObject({ outer_grant: effectGrantInput }),
});

const contentDatesInput = contentScopeInput.extend({
  start: dateInput.optional(),
  end: dateInput.optional(),
});
const contentDatesApplyInput = contentDatesInput.extend({
  expected_plan_digest: z.string().regex(SHA256),
  _morrow: z.strictObject({ outer_grant: effectGrantInput }),
});

const courseCopyInput = scopeInput.extend({
  // The documented copy request receives the new course's external Course ID,
  // not a generated Blackboard primary key.
  destination_course_id: z.string().trim().min(1).max(255).regex(/^[^\u0000-\u001f\u007f]+$/),
});
const courseCopyVerificationInput = courseCopyInput.extend({
  task_reference: z.string().regex(/^bbcopy:[A-Za-z0-9_-]{1,140}$/).optional(),
});
const courseCopyApplyInput = courseCopyInput.extend({
  expected_plan_digest: z.string().regex(SHA256),
  _morrow: z.strictObject({ outer_grant: effectGrantInput }),
});

type CourseAvailabilityInput = z.output<typeof courseAvailabilityInput>;
type ContentDatesInput = z.output<typeof contentDatesInput>;
type CourseCopyInput = z.output<typeof courseCopyInput>;
type CourseCopyVerificationInput = z.output<typeof courseCopyVerificationInput>;

function coursePath(courseId: string): string {
  return `/learn/api/public/v3/courses/${encodeURIComponent(courseId)}`;
}

function externalCoursePath(courseId: string): string {
  return coursePath(`externalId:${courseId}`);
}

function courseCopyTaskReference(taskPath: string): string {
  const encoded = Buffer.from(taskPath, "utf8").toString("base64url");
  const reference = `bbcopy:${encoded}`;
  if (!/^bbcopy:[A-Za-z0-9_-]{1,140}$/.test(reference)) {
    throw new BlackboardApiError("blackboard_response_invalid", "Blackboard returned a course-copy task identifier Morrow cannot retain.");
  }
  return reference;
}

function courseCopyTaskPath(reference: string): string {
  const encoded = reference.slice("bbcopy:".length);
  const path = Buffer.from(encoded, "base64url").toString("utf8");
  if (courseCopyTaskReference(path) !== reference) {
    throw new BlackboardApiError("blackboard_response_invalid", "The retained Blackboard course-copy task identifier is invalid.");
  }
  return path;
}

function contentPath(courseId: string, contentId: string): string {
  return `/learn/api/public/v1/courses/${encodeURIComponent(courseId)}/contents/${encodeURIComponent(contentId)}`;
}

/** One short provider value as it may leave Morrow, or `null` when Blackboard reported none. */
function providerValue(value: unknown): string | null {
  return typeof value === "string" && PROVIDER_ENUM.test(value) ? value : null;
}

function mismatch(detail: string, dispatchState: BlackboardDispatchState): BlackboardApiError {
  return new BlackboardApiError("blackboard_content_mismatch", detail, undefined, dispatchState);
}

/** One reviewed date, as one exact instant. */
function reviewedDate(value: string, label: string): string {
  const parsed = instant(value);
  if (!parsed) {
    throw new BlackboardApiError(
      "blackboard_response_invalid",
      `The Blackboard ${label} is not one exact date and time. Write it as one instant, such as 2026-09-30T23:59:00.000Z.`,
    );
  }
  return parsed;
}

/** Refuses a window that ends before it starts, which no course and no item can hold. */
function assertOrderedWindow(start: string | null, end: string | null, label: string): void {
  if (start && end && Date.parse(end) <= Date.parse(start)) {
    throw new BlackboardApiError("blackboard_response_invalid", `The Blackboard ${label} ends before it starts.`);
  }
}

/** The `availability.duration` object of one course record, or nothing. */
function durationOf(record: JsonObject): JsonObject | undefined {
  const availability = record[AVAILABILITY_FIELD];
  if (!isJsonObject(availability)) return undefined;
  const duration = availability[DURATION_FIELD];
  return isJsonObject(duration) ? duration : undefined;
}

/** The `availability.adaptiveRelease` object of one content record, or nothing. */
function adaptiveReleaseOf(record: JsonObject): JsonObject | undefined {
  const availability = record[AVAILABILITY_FIELD];
  if (!isJsonObject(availability)) return undefined;
  const release = availability[ADAPTIVE_RELEASE_FIELD];
  return isJsonObject(release) ? release : undefined;
}

/**
 * The frozen protected values of one record, absent fields omitted. A date is
 * frozen as one instant, so the same moment written two ways is one value here.
 *
 * A date the record does not hold is one value however the site writes it. Learn
 * may drop a cleared date from the object or return it as `null`, and both mean
 * the same thing: no date. Freezing them as one value is what keeps a cleared
 * date from reading back as a change Morrow cannot confirm.
 */
function protectedProjection(record: JsonObject, fields: readonly (readonly string[])[]): JsonObject {
  const output: JsonObject = {};
  for (const path of fields) {
    let current: unknown = record;
    for (const segment of path) current = isJsonObject(current) ? current[segment] : undefined;
    if (current === undefined) continue;
    const key = path.join(".");
    const last = path[path.length - 1];
    if (last === "start" || last === "end") {
      if (current === null) continue;
      output[key] = instant(current) ?? current;
      continue;
    }
    output[key] = current;
  }
  return output;
}

/** One frozen text value from a protected projection, or `null` when the record holds none. */
function frozenString(projection: JsonObject, key: string): string | null {
  const value = projection[key];
  return typeof value === "string" ? value : null;
}

/** One projection with the named keys left out, so a value Morrow did not check is not compared. */
function comparable(projection: JsonObject, ignored: readonly string[]): JsonObject {
  const output = { ...projection };
  for (const key of ignored) delete output[key];
  return output;
}

/** One reviewed course availability change, with every Morrow bound applied. */
interface ReviewedCourseAvailability {
  /** `null` when this change leaves whether the course is available as it is. */
  readonly available: string | null;
  /** `null` when this change leaves the course's window as it is. */
  readonly durationType: string | null;
  readonly durationStart: string | null;
  readonly durationEnd: string | null;
}

/**
 * A course change sets whether the course is available, the window it is open
 * in, or both. Everything else about a course, including its name, its id, and whether it is
 * closed and complete, is refused here, before any request.
 */
function reviewedCourseAvailability(input: CourseAvailabilityInput): ReviewedCourseAvailability {
  const range = input.duration_type === DURATION_RANGE;
  if (input.available === undefined && input.duration_type === undefined) {
    throw new BlackboardApiError(
      "blackboard_response_invalid",
      "A Blackboard course availability change sets whether the course is available, when it opens and closes, or both. This change sets neither.",
    );
  }
  if (input.duration_type === undefined && (input.duration_start !== undefined || input.duration_end !== undefined)) {
    throw new BlackboardApiError(
      "blackboard_response_invalid",
      `A Blackboard course date belongs to a window. Ask for ${DURATION_RANGE} with the dates, or for ${DURATION_CONTINUOUS} with none.`,
    );
  }
  if (!range && (input.duration_start !== undefined || input.duration_end !== undefined)) {
    throw new BlackboardApiError(
      "blackboard_response_invalid",
      `A ${DURATION_CONTINUOUS} Blackboard course is open from the moment it is available, so it carries no start and no end.`,
    );
  }
  if (range && input.duration_start === undefined && input.duration_end === undefined) {
    throw new BlackboardApiError(
      "blackboard_response_invalid",
      `A Blackboard course open between dates needs a start, an end, or both, each written as one instant such as 2026-09-30T23:59:00.000Z.`,
    );
  }
  const start = range && input.duration_start !== undefined ? reviewedDate(input.duration_start, "course start date") : null;
  const end = range && input.duration_end !== undefined ? reviewedDate(input.duration_end, "course end date") : null;
  assertOrderedWindow(start, end, "course window");
  return {
    available: input.available ?? null,
    durationType: input.duration_type ?? null,
    durationStart: start,
    durationEnd: end,
  };
}

/**
 * The exact request one approved course dispatch sends: the reviewed values and
 * nothing else. Morrow does not send back a value it was not asked to change,
 * so a course whose window it cannot model, such as a term or a fixed number of days,
 * can still be made available or unavailable. Whether this site keeps that
 * window while it applies the change is what the readback below checks.
 */
function courseRequest(change: ReviewedCourseAvailability): JsonObject {
  const availability: JsonObject = {};
  if (change.available) availability.available = change.available;
  if (change.durationType) {
    availability[DURATION_FIELD] = {
      type: change.durationType,
      ...(change.durationStart ? { start: change.durationStart } : {}),
      ...(change.durationEnd ? { end: change.durationEnd } : {}),
    };
  }
  return { [AVAILABILITY_FIELD]: availability };
}

/** The reviewed course change as one plan and one dispatch both hash it. */
function frozenCourseChange(change: ReviewedCourseAvailability): JsonObject {
  return {
    available: change.available,
    durationType: change.durationType,
    durationStart: change.durationStart,
    durationEnd: change.durationEnd,
  };
}

/** The frozen course fields this change does not settle, which the readback names. */
function courseNotCompared(change: ReviewedCourseAvailability): readonly string[] {
  if (!change.durationType) return [];
  return DURATION_DEPENDENT_FIELDS.filter((key) => (
    !(key.endsWith(".start") && change.durationStart) && !(key.endsWith(".end") && change.durationEnd)
  ));
}

/** The protected projection an exact provider returns after this exact course change. */
function expectedProtectedCourse(frozen: JsonObject, change: ReviewedCourseAvailability): JsonObject {
  const output: JsonObject = { ...frozen };
  if (change.available) output[`${AVAILABILITY_FIELD}.available`] = change.available;
  if (change.durationType) {
    output[`${AVAILABILITY_FIELD}.${DURATION_FIELD}.type`] = change.durationType;
    if (change.durationStart) output[`${AVAILABILITY_FIELD}.${DURATION_FIELD}.start`] = change.durationStart;
    if (change.durationEnd) output[`${AVAILABILITY_FIELD}.${DURATION_FIELD}.end`] = change.durationEnd;
  }
  return output;
}

/**
 * One course as this module returns it. The course name and description are
 * provider text, so they leave through the same privacy boundary as every other
 * Blackboard text; the availability values beside them are provider vocabulary
 * and dates.
 */
function safeCourseAvailability(record: JsonObject, roster: PreparedRoster): JsonObject {
  const output = safeCourse(record, roster);
  const availability = record[AVAILABILITY_FIELD];
  const available = isJsonObject(availability) ? providerValue(availability.available) : null;
  const duration = durationOf(record);
  const type = duration ? providerValue(duration.type) : null;
  const start = duration ? instant(duration.start) : null;
  const end = duration ? instant(duration.end) : null;
  const window: JsonObject = {
    ...(type ? { type } : {}),
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
  };
  const ultraStatus = providerValue(record.ultraStatus);
  return {
    ...output,
    ...(ultraStatus ? { ultraStatus } : {}),
    ...(typeof record.closedComplete === "boolean" ? { closedComplete: record.closedComplete } : {}),
    ...(available || Object.keys(window).length > 0
      ? { availability: { ...(available ? { available } : {}), ...(Object.keys(window).length > 0 ? { duration: window } : {}) } }
      : {}),
  };
}

/**
 * The two dates one request states, refused here before anything is read: a
 * date is `undefined` to keep the one the item holds, `null` to clear it, and an
 * instant to set it.
 */
interface RequestedContentDates {
  readonly start: string | null | undefined;
  readonly end: string | null | undefined;
}

/**
 * What one request asks for, checked before any provider request and before a
 * dispatch spends its one-use receipt.
 */
function requestedContentDates(input: ContentDatesInput): RequestedContentDates {
  if (input.start === undefined && input.end === undefined) {
    throw new BlackboardApiError(
      "blackboard_response_invalid",
      "A Blackboard dated-visibility change sets when an item becomes visible, when it stops being visible, or both. This change sets neither.",
    );
  }
  return {
    start: typeof input.start === "string" ? reviewedDate(input.start, "item start date") : input.start,
    end: typeof input.end === "string" ? reviewedDate(input.end, "item end date") : input.end,
  };
}

/** One reviewed dated-visibility change: the whole window the item ends up with. */
interface ReviewedContentDates {
  /** `null` is an item with no start date, which learners see from the moment it is available. */
  readonly start: string | null;
  readonly end: string | null;
  /** Whether this change sets each date at all, so a readback names what it compared. */
  readonly setsStart: boolean;
  readonly setsEnd: boolean;
}

/**
 * One dated-visibility change, as the whole window an instructor reviews. A date
 * left out of the request keeps the date the item already carries, so the plan
 * needs the item's current window before it can state the one it will end up
 * with.
 */
function reviewedContentDates(requested: RequestedContentDates, frozen: JsonObject): ReviewedContentDates {
  const start = requested.start === undefined ? frozenString(frozen, ADAPTIVE_START) : requested.start;
  const end = requested.end === undefined ? frozenString(frozen, ADAPTIVE_END) : requested.end;
  assertOrderedWindow(start, end, "dated visibility");
  return { start, end, setsStart: requested.start !== undefined, setsEnd: requested.end !== undefined };
}

/**
 * The exact request one approved dated-visibility dispatch sends. Morrow sends
 * the whole window, because public Blackboard documentation does not settle
 * whether a `PATCH` merges or replaces a nested object and a partial window
 * could leave a date nobody reviewed deciding when learners see this item. A
 * date the item does not hold and this change does not set is left out rather
 * than sent as `null`: there is nothing there to clear.
 */
function contentRequest(dates: ReviewedContentDates, frozen: JsonObject): JsonObject {
  const release: JsonObject = {};
  if (dates.start !== null) release.start = dates.start;
  else if (frozen[ADAPTIVE_START] !== undefined) release.start = null;
  if (dates.end !== null) release.end = dates.end;
  else if (frozen[ADAPTIVE_END] !== undefined) release.end = null;
  return { [AVAILABILITY_FIELD]: { [ADAPTIVE_RELEASE_FIELD]: release } };
}

/** The reviewed window as one plan and one dispatch both hash it. */
function frozenContentDates(dates: ReviewedContentDates): JsonObject {
  return { start: dates.start, end: dates.end };
}

/** The protected projection an exact provider returns after this exact window. */
function expectedProtectedContent(frozen: JsonObject, dates: ReviewedContentDates): JsonObject {
  const output: JsonObject = { ...frozen };
  if (dates.start === null) delete output[ADAPTIVE_START];
  else output[ADAPTIVE_START] = dates.start;
  if (dates.end === null) delete output[ADAPTIVE_END];
  else output[ADAPTIVE_END] = dates.end;
  return output;
}

/** One content item as this module returns it, with the window it holds. */
function safeDatedContent(record: JsonObject, roster: PreparedRoster): JsonObject {
  const output = safeContent(record, roster);
  const release = adaptiveReleaseOf(record);
  const start = release ? instant(release.start) : null;
  const end = release ? instant(release.end) : null;
  return {
    ...output,
    datedVisibility: { start, end },
  };
}

/**
 * The admission rules for one dated-visibility change, from the same recovery
 * contract the content patch follows
 * (docs/research/blackboard-recovery-contract.md:199-203). Morrow sets dates on
 * one document inside the selected course: not a folder, not the Ultra wrapper
 * around a document, and not an item whose handler it cannot read.
 */
function assertDatedContent(record: JsonObject, courseId: string): void {
  if (record.courseId !== courseId) {
    throw new BlackboardApiError("blackboard_scope_binding_mismatch", "Blackboard did not return this content item as part of the selected course.");
  }
  const handler = record.contentHandler;
  if (!isJsonObject(handler) || typeof handler.id !== "string" || !handler.id) {
    throw new BlackboardApiError("blackboard_operation_unavailable", "Blackboard did not name a content handler for this item, so Morrow cannot tell what a date would apply to.");
  }
  if (handler.id === FOLDER_HANDLER) {
    throw new BlackboardApiError(
      "blackboard_operation_unavailable",
      handler.isBbPage === true
        ? `This item is the Ultra document wrapper (${FOLDER_HANDLER} with isBbPage true). Morrow sets dates on the ${DOCUMENT_HANDLER} inside it, never on the wrapper.`
        : `This item is a Blackboard folder (${FOLDER_HANDLER}). Morrow sets dates on one document, not on a folder.`,
    );
  }
  if (handler.id !== DOCUMENT_HANDLER) {
    throw new BlackboardApiError("blackboard_operation_unavailable", `Morrow sets dates on a Blackboard document (${DOCUMENT_HANDLER}). This item is ${handler.id}.`);
  }
}

/** One fresh read of the exact course, bound to the selected course by the path and by its own id. */
async function readCourseRecord(client: BlackboardLearnClient, courseId: string, signal?: AbortSignal): Promise<JsonObject> {
  const record = await client.get(withFields(coursePath(courseId), COURSE_FIELDS), signal);
  if (record.id !== courseId) {
    throw new BlackboardApiError("blackboard_scope_binding_mismatch", "Blackboard returned a different course than the one Morrow asked for.");
  }
  return record;
}

/** One fresh read of the exact content item, admitted against the write contract. */
async function readContentRecord(
  client: BlackboardLearnClient,
  courseId: string,
  contentId: string,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const record = await client.get(contentPath(courseId, contentId), signal);
  if (record.id !== contentId) throw new BlackboardApiError("blackboard_content_mismatch", "Blackboard returned a different content item.");
  assertDatedContent(record, courseId);
  return record;
}

/**
 * Who this course change reaches, as the approval page states it. Morrow counts
 * a learner as a membership with the `Student` course role; a site with its own
 * course roles is why the number of people enrolled stands beside it.
 */
function courseAccess(write: BlackboardCourseRead, frozen: JsonObject, change: ReviewedCourseAvailability): JsonObject {
  const learners = write.roster.members.filter((member) => member.membership.courseRoleId === LEARNER_ROLE).length;
  const enrolled = write.roster.members.length;
  const before = frozenString(frozen, `${AVAILABILITY_FIELD}.available`);
  const after = change.available ?? before;
  const people = `${learners} of the ${enrolled} people enrolled in this course have the ${LEARNER_ROLE} course role`;
  const window = change.durationType === DURATION_RANGE
    ? ` It sets the course open between ${change.durationStart ?? "no start date"} and ${change.durationEnd ?? "no end date"}.`
    : change.durationType === DURATION_CONTINUOUS
      ? " It sets the course open from the moment it is available, with no end date."
      : "";
  const availability = change.available === null || change.available === before
    ? `This change does not change whether the course is available; ${people}.`
    : change.available === "Yes"
      ? `Learners gain access to this course: ${people}.`
      : `Learners lose access to this course: ${people}.`;
  return {
    available: { before, after },
    learners,
    peopleEnrolled: enrolled,
    detail: `${availability}${window}`,
  };
}

/** Who this dated-visibility change reaches, as the approval page states it. */
function contentAccess(write: BlackboardCourseRead, dates: ReviewedContentDates): JsonObject {
  const learners = write.roster.members.filter((member) => member.membership.courseRoleId === LEARNER_ROLE).length;
  const window = dates.start && dates.end
    ? `Learners see this item between ${dates.start} and ${dates.end}.`
    : dates.start
      ? `Learners see this item from ${dates.start}, with no end date.`
      : dates.end
        ? `Learners see this item until ${dates.end}.`
        : "Learners see this item whenever it is available, with no start and no end date.";
  return {
    window: { start: dates.start, end: dates.end },
    learners,
    peopleEnrolled: write.roster.members.length,
    detail: `${window} ${learners} of the ${write.roster.members.length} people enrolled in this course have the ${LEARNER_ROLE} course role.`,
  };
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

function assertReviewedPlan(runtime: BlackboardLearnRuntime, grant: BlackboardEffectGrant, expected: string): void {
  runtime.assertReservedEffectGrant(grant);
  if (grant.planDigest !== expected) {
    throw new BlackboardApiError("blackboard_patch_review_required", "The Blackboard effect grant does not match this exact reviewed plan.");
  }
}

function courseAvailabilityEffectTarget(runtime: BlackboardLearnRuntime, input: CourseAvailabilityInput) {
  return runtime.effectTarget({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, "course-availability", {});
}

function contentDatesEffectTarget(runtime: BlackboardLearnRuntime, input: ContentDatesInput) {
  return runtime.effectTarget({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, "content-dates", { contentId: input.content_id });
}

function courseCopyEffectTarget(runtime: BlackboardLearnRuntime, input: CourseCopyInput) {
  return runtime.effectTarget({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, "course-copy", { destinationCourseId: input.destination_course_id });
}

/** What the readback after each change proves, in plain words. */
const COURSE_READBACK_DETAIL = "Morrow re-read the course and compared its name, its Learn mode, whether it is closed and complete, whether it is available, and its window, against the reviewed plan. It names every frozen value this change could move that it did not compare.";
const CONTENT_READBACK_DETAIL = "Morrow re-read the content item and compared its title, its description, where it sits, whether it is available, and both dated-visibility dates, against the reviewed plan.";

const PROTECTED_STATE = "protected_fields";

interface FrozenChange {
  readonly record: JsonObject;
  readonly frozen: JsonObject;
  readonly beforeDigest: string;
  readonly planDigest: string;
}

/**
 * One fresh read of the exact course, frozen as the precondition this change is
 * reviewed against. The digest binds the tenant, the course connection, the
 * course, every protected course value, and the exact reviewed change, so a
 * course somebody else renamed or re-dated after review is refused before
 * anything is sent.
 */
async function freezeCourse(
  write: BlackboardCourseRead,
  change: ReviewedCourseAvailability,
  signal?: AbortSignal,
): Promise<FrozenChange> {
  const record = await readCourseRecord(write.client, write.courseId, signal);
  const frozen = protectedProjection(record, PROTECTED_COURSE_FIELDS);
  const beforeDigest = sha256Text(canonicalJson(frozen));
  const planDigest = sha256Text(canonicalJson({
    tenantId: write.tenantId,
    sourceBindingId: write.sourceBindingId,
    courseId: write.courseId,
    beforeDigest,
    change: frozenCourseChange(change),
  }));
  return { record, frozen, beforeDigest, planDigest };
}

/** One reviewed change to when a course is open, and to whether it is available at all. */
async function planCourseAvailability(
  runtime: BlackboardLearnRuntime,
  input: CourseAvailabilityInput,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const change = reviewedCourseAvailability(input);
  runtime.assertEffectTargetFree(courseAvailabilityEffectTarget(runtime, input));
  // A plan exists only to be dispatched, so it carries the write condition. An
  // instructor is refused before review instead of after approving a change
  // Morrow would then refuse to send.
  const write = await runtime.beginCourseWrite({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const frozen = await freezeCourse(write, change, signal);
  return {
    schema: "morrow.blackboard.course-availability-patch.plan.v1",
    ok: true,
    tenantId: write.tenantId,
    sourceBindingId: write.sourceBindingId,
    courseId: write.courseId,
    before: safeCourseAvailability(frozen.record, write.roster),
    beforeDigest: frozen.beforeDigest,
    change: frozenCourseChange(change),
    request: courseRequest(change),
    access: courseAccess(write, frozen.frozen, change),
    planDigest: frozen.planDigest,
    reviewRequired: true,
    limits: { fields: ["availability.available", "availability.duration"], courses: 1 },
    notCompared: courseNotCompared(change),
    readback: PROTECTED_STATE,
    readbackDetail: COURSE_READBACK_DETAIL,
    status: "api_configured_live_untested",
    effect_scope: runtime.effectScope({
      tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
    }),
  };
}

/**
 * The one dispatch for a course availability change: it re-reads the exact
 * course, refuses when anything it froze changed after review, sends one
 * `PATCH`, and reads the course back. The one-use receipt is spent before the
 * first provider request, so two dispatches of one approval cannot both send a
 * change.
 */
async function applyReviewedCourseAvailability(
  runtime: BlackboardLearnRuntime,
  input: z.output<typeof courseAvailabilityApplyInput>,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const grant = reservedGrant(input._morrow.outer_grant);
  assertReviewedPlan(runtime, grant, input.expected_plan_digest);
  const change = reviewedCourseAvailability(input);
  const dispatch = runtime.claimReservedEffectGrant(grant, courseAvailabilityEffectTarget(runtime, input));
  const write = await runtime.beginCourseWrite({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const frozen = await freezeCourse(write, change, signal);
  if (frozen.planDigest !== input.expected_plan_digest) {
    // One digest binds the course, every protected value it held, and the
    // change, so a course somebody else changed after review and a request that
    // describes another change both fail here. The refusal names both, because
    // this route cannot tell them apart and must not report the wrong one.
    throw new BlackboardApiError(
      "blackboard_content_mismatch",
      "The Blackboard course Morrow read does not match the reviewed plan. It changed after review, or this request describes a different change. Nothing was sent.",
    );
  }
  const notCompared = courseNotCompared(change);
  const expected = comparable(expectedProtectedCourse(frozen.frozen, change), notCompared);
  // Morrow cannot prove a change did not land once the PATCH request has left
  // this process. The marker is set on the line before that request, so every
  // failure from here on is reported as applied_or_unknown, and every refusal
  // raised above this point keeps not_sent.
  let dispatchState: BlackboardDispatchState = "not_sent";
  dispatch.markSent();
  try {
    dispatchState = "applied_or_unknown";
    await write.client.patch(coursePath(write.courseId), courseRequest(change), signal);
    const readback = await readCourseRecord(write.client, write.courseId, signal);
    const current = comparable(protectedProjection(readback, PROTECTED_COURSE_FIELDS), notCompared);
    if (canonicalJson(current) !== canonicalJson(expected)) {
      throw mismatch("Blackboard did not return every reviewed and protected course value after the change.", dispatchState);
    }
    dispatch.markVerified();
    return {
      schema: "morrow.blackboard.course-availability-patch.readback.v1",
      ok: true,
      // Morrow's operation journal reads this marker to decide what reached
      // Blackboard. The read payloads keep `status`, which is an evidence label.
      resultState: "applied",
      tenantId: write.tenantId,
      sourceBindingId: write.sourceBindingId,
      courseId: write.courseId,
      course: safeCourseAvailability(readback, write.roster),
      notCompared,
      readback: PROTECTED_STATE,
      readbackDetail: COURSE_READBACK_DETAIL,
      status: "api_configured_live_untested",
    };
  } catch (error) {
    dispatch.markUncertain();
    throw withBlackboardDispatchState(error, dispatchState);
  }
}

/**
 * The Gateway's fresh-read comparator for one reviewed course change. It holds
 * no frozen snapshot, so it states only whether the reviewed values are present
 * now. The protected-field freeze that catches a changed sibling belongs to the
 * dispatch above, which sent the change and holds that snapshot.
 *
 * It prepares no roster and reads no course membership, and it carries no
 * `diagnostics`, because the Gateway freezes this exact payload when it plans
 * the operation and compares the whole result against that frozen digest.
 */
async function verifyCourseAvailability(
  runtime: BlackboardLearnRuntime,
  input: CourseAvailabilityInput,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const change = reviewedCourseAvailability(input);
  const comparator = await runtime.beginComparatorRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const record = await readCourseRecord(comparator.client, comparator.courseId, signal);
  const current = protectedProjection(record, PROTECTED_COURSE_FIELDS);
  const expected = expectedProtectedCourse({}, change);
  const verified = Object.keys(expected).every((key) => (
    Object.hasOwn(current, key) && canonicalJson(current[key]) === canonicalJson(expected[key])
  ));
  runtime.recordEffectComparison(courseAvailabilityEffectTarget(runtime, input), verified);
  return {
    schema: "morrow.blackboard.course-availability-patch.comparator.v1",
    ok: true,
    tenantId: comparator.tenantId,
    sourceBindingId: comparator.sourceBindingId,
    courseId: comparator.courseId,
    verified,
    readback: PROTECTED_STATE,
    status: "api_configured_live_untested",
  };
}

/** One fresh read of the exact content item, frozen as this change's precondition. */
async function freezeContent(
  write: BlackboardCourseRead,
  contentId: string,
  requested: RequestedContentDates,
  signal?: AbortSignal,
): Promise<FrozenChange & { readonly dates: ReviewedContentDates }> {
  const record = await readContentRecord(write.client, write.courseId, contentId, signal);
  const frozen = protectedProjection(record, PROTECTED_CONTENT_FIELDS);
  const dates = reviewedContentDates(requested, frozen);
  const beforeDigest = sha256Text(canonicalJson(frozen));
  const planDigest = sha256Text(canonicalJson({
    tenantId: write.tenantId,
    sourceBindingId: write.sourceBindingId,
    courseId: write.courseId,
    contentId,
    beforeDigest,
    dates: frozenContentDates(dates),
  }));
  return { record, frozen, beforeDigest, planDigest, dates };
}

/** One reviewed change to when learners see one item. */
async function planContentDatedVisibility(
  runtime: BlackboardLearnRuntime,
  input: ContentDatesInput,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const requested = requestedContentDates(input);
  runtime.assertEffectTargetFree(contentDatesEffectTarget(runtime, input));
  const write = await runtime.beginCourseWrite({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const frozen = await freezeContent(write, input.content_id, requested, signal);
  return {
    schema: "morrow.blackboard.content-dates.plan.v1",
    ok: true,
    tenantId: write.tenantId,
    sourceBindingId: write.sourceBindingId,
    courseId: write.courseId,
    contentId: input.content_id,
    before: safeDatedContent(frozen.record, write.roster),
    beforeDigest: frozen.beforeDigest,
    dates: frozenContentDates(frozen.dates),
    request: contentRequest(frozen.dates, frozen.frozen),
    access: contentAccess(write, frozen.dates),
    planDigest: frozen.planDigest,
    reviewRequired: true,
    limits: { fields: [ADAPTIVE_START, ADAPTIVE_END], items: 1 },
    readback: PROTECTED_STATE,
    readbackDetail: CONTENT_READBACK_DETAIL,
    status: "api_configured_live_untested",
    effect_scope: runtime.effectScope({
      tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
    }),
  };
}

/**
 * The one dispatch for a dated-visibility change: it re-reads the exact item,
 * refuses when anything it froze changed after review, sends one `PATCH`, and
 * reads the item back.
 */
async function applyReviewedContentDatedVisibility(
  runtime: BlackboardLearnRuntime,
  input: z.output<typeof contentDatesApplyInput>,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const grant = reservedGrant(input._morrow.outer_grant);
  assertReviewedPlan(runtime, grant, input.expected_plan_digest);
  const requested = requestedContentDates(input);
  const dispatch = runtime.claimReservedEffectGrant(grant, contentDatesEffectTarget(runtime, input));
  const write = await runtime.beginCourseWrite({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const frozen = await freezeContent(write, input.content_id, requested, signal);
  if (frozen.planDigest !== input.expected_plan_digest) {
    throw new BlackboardApiError(
      "blackboard_content_mismatch",
      "The Blackboard content item Morrow read does not match the reviewed plan. It changed after review, or this request describes a different change. Nothing was sent.",
    );
  }
  const expected = expectedProtectedContent(frozen.frozen, frozen.dates);
  let dispatchState: BlackboardDispatchState = "not_sent";
  dispatch.markSent();
  try {
    dispatchState = "applied_or_unknown";
    await write.client.patch(contentPath(write.courseId, input.content_id), contentRequest(frozen.dates, frozen.frozen), signal);
    const readback = await readContentRecord(write.client, write.courseId, input.content_id, signal);
    if (canonicalJson(protectedProjection(readback, PROTECTED_CONTENT_FIELDS)) !== canonicalJson(expected)) {
      throw mismatch("Blackboard did not return every reviewed and protected content value after the change.", dispatchState);
    }
    dispatch.markVerified();
    return {
      schema: "morrow.blackboard.content-dates.readback.v1",
      ok: true,
      resultState: "applied",
      tenantId: write.tenantId,
      sourceBindingId: write.sourceBindingId,
      courseId: write.courseId,
      contentId: input.content_id,
      content: safeDatedContent(readback, write.roster),
      readback: PROTECTED_STATE,
      readbackDetail: CONTENT_READBACK_DETAIL,
      status: "api_configured_live_untested",
    };
  } catch (error) {
    dispatch.markUncertain();
    throw withBlackboardDispatchState(error, dispatchState);
  }
}

/**
 * The Gateway's fresh-read comparator for one reviewed dated-visibility change.
 * It states only whether the item's window is the reviewed one now.
 *
 * A request that leaves one date out means "keep the date this item holds", and
 * this route holds no plan, so it re-reads the item and reads that date from the
 * item itself, exactly as the plan and the dispatch do.
 */
async function verifyContentDatedVisibility(
  runtime: BlackboardLearnRuntime,
  input: ContentDatesInput,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const requested = requestedContentDates(input);
  const comparator = await runtime.beginComparatorRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const record = await readContentRecord(comparator.client, comparator.courseId, input.content_id, signal);
  const current = protectedProjection(record, PROTECTED_CONTENT_FIELDS);
  const dates = reviewedContentDates(requested, current);
  const verified = frozenString(current, ADAPTIVE_START) === dates.start && frozenString(current, ADAPTIVE_END) === dates.end;
  runtime.recordEffectComparison(contentDatesEffectTarget(runtime, input), verified);
  return {
    schema: "morrow.blackboard.content-dates.comparator.v1",
    ok: true,
    tenantId: comparator.tenantId,
    sourceBindingId: comparator.sourceBindingId,
    courseId: comparator.courseId,
    contentId: input.content_id,
    verified,
    readback: PROTECTED_STATE,
    status: "api_configured_live_untested",
  };
}

/** One copy plan binds the selected source course and the exact new Course ID. */
async function freezeCourseCopy(
  write: BlackboardCourseRead,
  destinationCourseId: string,
  signal?: AbortSignal,
): Promise<{ readonly record: JsonObject; readonly frozen: JsonObject; readonly beforeDigest: string; readonly planDigest: string }> {
  const record = await readCourseRecord(write.client, write.courseId, signal);
  if (typeof record.id !== "string" || !BLACKBOARD_ID.test(record.id)
    || typeof record.courseId !== "string" || !record.courseId) {
    throw new BlackboardApiError("blackboard_response_invalid", "Blackboard did not return the selected source course's identifiers.");
  }
  if (record.courseId === destinationCourseId) {
    throw new BlackboardApiError("blackboard_response_invalid", "The new Blackboard Course ID must differ from the selected source course's Course ID.");
  }
  const frozen = protectedProjection(record, PROTECTED_COURSE_FIELDS);
  const beforeDigest = sha256Text(canonicalJson(frozen));
  const planDigest = sha256Text(canonicalJson({
    tenantId: write.tenantId,
    sourceBindingId: write.sourceBindingId,
    sourceCourseId: write.courseId,
    destinationCourseId,
    beforeDigest,
  }));
  return { record, frozen, beforeDigest, planDigest };
}

function copiedCourseMatches(source: JsonObject, copied: JsonObject, destinationCourseId: string): boolean {
  if (copied.courseId !== destinationCourseId || typeof copied.id !== "string" || !BLACKBOARD_ID.test(copied.id)) return false;
  return canonicalJson(comparable(protectedProjection(copied, PROTECTED_COURSE_FIELDS), ["id", "courseId"]))
    === canonicalJson(comparable(source, ["id", "courseId"]));
}

async function planCourseCopy(
  runtime: BlackboardLearnRuntime,
  input: CourseCopyInput,
  signal?: AbortSignal,
): Promise<JsonObject> {
  runtime.assertEffectTargetFree(courseCopyEffectTarget(runtime, input));
  const write = await runtime.beginCourseWrite({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const frozen = await freezeCourseCopy(write, input.destination_course_id, signal);
  return {
    schema: "morrow.blackboard.course-copy.plan.v1",
    ok: true,
    tenantId: write.tenantId,
    sourceBindingId: write.sourceBindingId,
    courseId: write.courseId,
    source: safeCourseAvailability(frozen.record, write.roster),
    destinationCourseId: input.destination_course_id,
    beforeDigest: frozen.beforeDigest,
    request: { targetCourse: { courseId: input.destination_course_id } },
    planDigest: frozen.planDigest,
    reviewRequired: true,
    limits: { sourceCourses: 1, destinationCourses: 1 },
    readback: "task_location_and_copied_course",
    readbackDetail: "Morrow starts one Learn course-copy task, reads that exact task, and when Learn marks it complete, re-reads the copied course from the task location and compares the source fields Learn documents as copied.",
    status: "api_configured_live_untested",
    effect_scope: runtime.effectScope({
      tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
    }),
  };
}

async function applyReviewedCourseCopy(
  runtime: BlackboardLearnRuntime,
  input: z.output<typeof courseCopyApplyInput>,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const grant = reservedGrant(input._morrow.outer_grant);
  assertReviewedPlan(runtime, grant, input.expected_plan_digest);
  const dispatch = runtime.claimReservedEffectGrant(grant, courseCopyEffectTarget(runtime, input));
  const write = await runtime.beginCourseWrite({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const frozen = await freezeCourseCopy(write, input.destination_course_id, signal);
  if (frozen.planDigest !== input.expected_plan_digest) {
    throw new BlackboardApiError(
      "blackboard_content_mismatch",
      "The Blackboard source course Morrow read does not match the reviewed copy plan. It changed after review, or this request describes a different destination. Nothing was sent.",
    );
  }
  let dispatchState: BlackboardDispatchState = "not_sent";
  dispatch.markSent();
  try {
    dispatchState = "applied_or_unknown";
    const sourceCourseId = String(frozen.record.id);
    const taskPath = await write.client.startCourseCopy(write.courseId, input.destination_course_id, sourceCourseId, signal);
    const task = await write.client.readCourseCopyTask(taskPath, sourceCourseId, signal);
    if (task.state === "pending") {
      return {
        schema: "morrow.blackboard.course-copy.pending.v1",
        ok: true,
        resultState: "awaiting_provider",
        tenantId: write.tenantId,
        sourceBindingId: write.sourceBindingId,
        courseId: write.courseId,
        destinationCourseId: input.destination_course_id,
        taskId: courseCopyTaskReference(taskPath),
        problem: {
          code: "blackboard_response_incomplete",
          message: "Blackboard accepted the course copy, but its task is still running. Morrow did not repeat the copy. Verify this operation after Blackboard completes the task.",
        },
        status: "api_configured_live_untested",
      };
    }
    const copied = await write.client.get(task.coursePath, signal);
    if (!copiedCourseMatches(frozen.frozen, copied, input.destination_course_id)) {
      throw mismatch("Blackboard completed the course-copy task but did not return the reviewed copy of the selected source course.", dispatchState);
    }
    dispatch.markVerified();
    return {
      schema: "morrow.blackboard.course-copy.readback.v1",
      ok: true,
      resultState: "applied",
      tenantId: write.tenantId,
      sourceBindingId: write.sourceBindingId,
      courseId: write.courseId,
      destinationCourseId: input.destination_course_id,
      taskPath,
      copiedCourse: safeCourseAvailability(copied, write.roster),
      readback: "task_location_and_copied_course",
      status: "api_configured_live_untested",
    };
  } catch (error) {
    dispatch.markUncertain();
    throw withBlackboardDispatchState(error, dispatchState);
  }
}

/**
 * The Gateway's fresh-read comparator for one reviewed course copy. It runs
 * before the copy as well as after it. The Gateway freezes its comparator
 * while it plans the operation, so a destination course Blackboard does not
 * hold yet is `verified: false`, not a failure.
 */
async function verifyCourseCopy(
  runtime: BlackboardLearnRuntime,
  input: CourseCopyVerificationInput,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const comparator = await runtime.beginComparatorRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  let copied: JsonObject | undefined;
  let terminal = false;
  if (input.task_reference) {
    const source = await readCourseRecord(comparator.client, comparator.courseId, signal);
    if (typeof source.id !== "string" || !BLACKBOARD_ID.test(source.id)) {
      throw new BlackboardApiError("blackboard_response_invalid", "Blackboard did not return the selected source course's internal identifier.");
    }
    const task = await comparator.client.readCourseCopyTask(courseCopyTaskPath(input.task_reference), source.id, signal);
    if (task.state === "complete") {
      terminal = true;
      copied = await comparator.client.get(task.coursePath, signal);
    }
  } else {
    try {
      copied = await comparator.client.get(withFields(externalCoursePath(input.destination_course_id), COURSE_FIELDS), signal);
      terminal = true;
    } catch (error) {
      if (!(error instanceof BlackboardApiError) || error.status !== 404) throw error;
    }
  }
  const verified = Boolean(copied && typeof copied.id === "string" && BLACKBOARD_ID.test(copied.id)
    && copied.courseId === input.destination_course_id);
  if (verified || terminal) runtime.recordEffectComparison(courseCopyEffectTarget(runtime, input), verified);
  return {
    schema: "morrow.blackboard.course-copy.comparator.v1",
    ok: true,
    tenantId: comparator.tenantId,
    sourceBindingId: comparator.sourceBindingId,
    courseId: comparator.courseId,
    destinationCourseId: input.destination_course_id,
    verified,
    readback: "target_course_identity",
    status: "api_configured_live_untested",
  };
}

function readCapability(sourceExport: string): SourceCapabilityMetadata {
  return {
    family: "course-read",
    provider: "blackboard",
    sourceExport,
    behavior: READ_BEHAVIOR,
    authority: { scopeClass: "tenant-course", approvalClass: "none", dataClass: "course" },
    route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
    profiles: COMPARATOR_PROFILES,
    evidence: EVIDENCE,
  };
}

function planCapability(family: string, sourceExport: string): SourceCapabilityMetadata {
  return {
    family,
    provider: "blackboard",
    sourceExport,
    behavior: {
      // A plan changes nothing. The dispatch route beside it is the one that
      // sends the change.
      readOnly: true, mutating: false, destructive: false, irreversible: false,
      supportsDryRun: false, supportsReadback: true, supportsUndo: false, supportsBatch: false,
      requiresBrowser: false, requiresLiveCanvas: false,
    },
    authority: { scopeClass: "tenant-course", approvalClass: "standard", dataClass: "course" },
    route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
    profiles: WRITE_PROFILES,
    evidence: EVIDENCE,
  };
}

function dispatchCapability(family: string, sourceExport: string): SourceCapabilityMetadata {
  return {
    family,
    provider: "blackboard",
    sourceExport,
    behavior: {
      // Morrow holds no undo route for either change: it sets a course or an
      // item back only through a second reviewed change.
      readOnly: false, mutating: true, destructive: false, irreversible: false,
      supportsDryRun: false, supportsReadback: true, supportsUndo: false, supportsBatch: false,
      requiresBrowser: false, requiresLiveCanvas: false,
    },
    authority: { scopeClass: "tenant-course", approvalClass: "standard", dataClass: "course" },
    route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
    profiles: WRITE_PROFILES,
    evidence: EVIDENCE,
  };
}

/**
 * When a Blackboard course is open, when learners see one item in it, and the
 * reviewed copy of one whole course.
 *
 * Three reviewed changes: whether the course is available and the window it is
 * open in, the two dated-visibility dates on one document, and one course copy.
 * Each uses the three routes for every Morrow provider change: the plan an
 * instructor reviews, the dispatch the Gateway makes once against a signed
 * one-use effect grant, and the fresh-read comparator. Each freezes every
 * protected value of the record it reads, so a course somebody else renamed
 * between review and dispatch is refused before anything is sent.
 *
 * Dated visibility is a separate operation from the content patch on purpose:
 * the content patch sets a title, a description, and whether an item is
 * available, and neither route sets the other's fields. That is what lets an
 * approval page show the exact dates a person is approving.
 *
 * Course copy is the documented asynchronous Learn operation
 * (https://docs.blackboard.com/docs/blackboard/rest-apis/hands-on/copying-courses):
 * one `POST /learn/api/public/v2/courses/{courseId}/copy` whose answer names a
 * task at exactly `GET /learn/api/public/v1/courses/{courseId}/tasks/{taskId}`,
 * and that task answers 200 while the copy runs and 303 with the copied
 * course's location when it ends. The dispatch sends the copy once and never
 * repeats it: a task still running is returned as `applied_or_unknown` for a
 * later verification, and a completed task is read back through its own
 * Location and compared against the frozen source course.
 *
 * The source routes remain private. The Gateway derives one public plan tool
 * from each reviewed triplet, keeps dispatch private, and performs the frozen
 * comparator after the reserved write.
 */
export const blackboardCourseLifecycleModule: BlackboardOperationModule = {
  id: "course-lifecycle",
  tools: [
    blackboardTool({
      name: "blackboard_plan_course_availability",
      title: "Plan Blackboard course availability and dates",
      description: `Prepare one change to whether a Blackboard Learn course is available and to the window it is open in, for Morrow review. The plan states who gains or loses access, and the exact request one approved dispatch sends. Morrow sets a course to available Yes or No, and its window to ${DURATION_CONTINUOUS} or to ${DURATION_RANGE} with exact dates; it sets no term and no fixed number of days. This tool changes nothing.`,
      private: true,
      gatewayDispatchOnly: false,
      inputSchema: courseAvailabilityInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: planCapability("course-availability-update", `PATCH ${COURSE_PATCH_ROUTE}`),
      rest: {
        method: "GET",
        pathTemplate: COURSE_READ_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => planCourseAvailability(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_apply_reviewed_course_availability",
      title: "Apply reserved Blackboard course availability change",
      description: "Internal Morrow dispatch route. This request requires an exact signed Gateway effect grant.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: courseAvailabilityApplyInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: dispatchCapability("course-availability-update", `PATCH ${COURSE_PATCH_ROUTE}`),
      rest: {
        method: "PATCH",
        pathTemplate: COURSE_PATCH_ROUTE,
        access: "write",
        entitlement: "unknown",
        reviewRoute: "blackboard_plan_course_availability",
        readbackComparator: "blackboard_verify_course_availability",
      },
      run: (runtime, input, signal) => applyReviewedCourseAvailability(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_verify_course_availability",
      title: "Verify Blackboard course availability change",
      description: "Internal Morrow fresh-read comparator for one reviewed Blackboard course availability change. It re-reads the course and states whether the reviewed values are saved.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: courseAvailabilityInput,
      annotations: READ_ANNOTATIONS,
      capability: readCapability(`GET ${COURSE_READ_ROUTE}`),
      rest: {
        method: "GET",
        pathTemplate: COURSE_READ_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => verifyCourseAvailability(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_plan_content_dated_visibility",
      title: "Plan when learners see one Blackboard item",
      description: `Prepare the two dates that decide when learners see one Blackboard Learn content item, its ${ADAPTIVE_START} and ${ADAPTIVE_END}, for Morrow review. The plan states the whole window the item ends up with, so what is approved is what learners get. Send one date to change it and leave the other out to keep it, or send null to clear one. Morrow sets these dates on one ${DOCUMENT_HANDLER}, not on a folder and not on the Ultra document wrapper. This tool changes nothing.`,
      private: true,
      gatewayDispatchOnly: false,
      inputSchema: contentDatesInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: planCapability("content-dated-visibility", `PATCH ${CONTENT_ROUTE}`),
      rest: {
        method: "GET",
        pathTemplate: CONTENT_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => planContentDatedVisibility(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_apply_reviewed_content_dated_visibility",
      title: "Apply reserved Blackboard dated-visibility change",
      description: "Internal Morrow dispatch route. This request requires an exact signed Gateway effect grant.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: contentDatesApplyInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: dispatchCapability("content-dated-visibility", `PATCH ${CONTENT_ROUTE}`),
      rest: {
        method: "PATCH",
        pathTemplate: CONTENT_ROUTE,
        access: "write",
        entitlement: "unknown",
        reviewRoute: "blackboard_plan_content_dated_visibility",
        readbackComparator: "blackboard_verify_content_dated_visibility",
      },
      run: (runtime, input, signal) => applyReviewedContentDatedVisibility(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_verify_content_dated_visibility",
      title: "Verify Blackboard dated-visibility change",
      description: "Internal Morrow fresh-read comparator for one reviewed Blackboard dated-visibility change. It re-reads the content item and states whether its window is the reviewed one.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: contentDatesInput,
      annotations: READ_ANNOTATIONS,
      capability: readCapability(`GET ${CONTENT_ROUTE}`),
      rest: {
        method: "GET",
        pathTemplate: CONTENT_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => verifyContentDatedVisibility(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_plan_course_copy",
      title: "Plan a Blackboard course copy",
      description: "Prepare one Blackboard Learn course copy for Morrow review. The selected course is the source. Enter the Course ID Blackboard should give the new course. Morrow freezes the selected source course before review and sends no copy request while planning.",
      private: true,
      gatewayDispatchOnly: false,
      inputSchema: courseCopyInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: planCapability("course-copy", `POST ${COURSE_COPY_ROUTE}`),
      rest: {
        method: "GET",
        pathTemplate: COURSE_READ_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => planCourseCopy(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_apply_reviewed_course_copy",
      title: "Apply a reserved Blackboard course copy",
      description: "Internal Morrow dispatch route. This request requires an exact signed Gateway effect grant.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: courseCopyApplyInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: dispatchCapability("course-copy", `POST ${COURSE_COPY_ROUTE}`),
      rest: {
        method: "POST",
        pathTemplate: COURSE_COPY_ROUTE,
        access: "write",
        entitlement: "unknown",
        reviewRoute: "blackboard_plan_course_copy",
        readbackComparator: "blackboard_verify_course_copy",
      },
      run: (runtime, input, signal) => applyReviewedCourseCopy(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_verify_course_copy",
      title: "Verify a Blackboard course copy",
      description: "Internal Morrow fresh-read comparator for one reviewed Blackboard course copy. It finds the target by its reviewed Course ID and states whether Blackboard now has that course.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: courseCopyVerificationInput,
      annotations: READ_ANNOTATIONS,
      capability: readCapability(`GET ${COURSE_PATCH_ROUTE}`),
      rest: {
        method: "GET",
        pathTemplate: COURSE_COPY_TASK_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => verifyCourseCopy(runtime, input, signal),
    }),
  ],
};
