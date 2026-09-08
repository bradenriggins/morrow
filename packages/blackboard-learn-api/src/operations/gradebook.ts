import { canonicalJson, isJsonObject, sha256Text, type JsonObject, type SourceCapabilityMetadata } from "@morrow/contracts";
import * as z from "zod/v4";
import type { BlackboardEffectGrant } from "../effect-grant.js";
import { redactInto, type BlackboardCourseRead, type BlackboardLearnRuntime } from "../runtime.js";
import { BLACKBOARD_ID, BlackboardApiError, withBlackboardDispatchState, type BlackboardDispatchState } from "../types.js";
import { blackboardTool, effectGrantInput, patchInput, scopeInput, type BlackboardOperationModule } from "./definition.js";
import { READ_ANNOTATIONS, READ_BEHAVIOR, READ_PROFILES } from "./course-read.js";

/**
 * The Learn gradebook routes Morrow calls. Anthology publishes the gradebook
 * under `v2`, and Morrow calls that version and no other: it does not fall back
 * to the deprecated `v1` gradebook routes, because a 404 from a site cannot be
 * told apart from a 404 for a column that does not exist, and a second request
 * after a change has left Morrow would be a second dispatch. A Learn site that
 * does not serve these routes answers 404 and Morrow reports that answer. No
 * tenant Swagger has been read.
 */
const COLUMNS_ROUTE = "/learn/api/public/v2/courses/{course_id}/gradebook/columns";
const COLUMN_ROUTE = `${COLUMNS_ROUTE}/{column_id}`;
const ATTEMPTS_ROUTE = `${COLUMN_ROUTE}/attempts`;
const ATTEMPT_ROUTE = `${ATTEMPTS_ROUTE}/{attempt_id}`;
const GRADE_ROUTE = `${COLUMN_ROUTE}/users/{user_id}`;

/**
 * The fields Morrow asks each gradebook route for. Asking for an explicit list
 * is what keeps a learner's submitted work and an instructor's feedback out of
 * this process altogether, rather than only out of its output: `studentSubmission`,
 * `studentComments`, `feedback`, and `notes` are never requested and never read.
 * Every name here is a documented Blackboard field on these records, and no
 * tenant Swagger has been read, so which of them a given Learn version answers
 * stays live-unverified: a field a site does not return is reported as absent.
 */
export const COLUMN_FIELDS = ["id", "name", "description", "externalGrade", "contentId", "score", "availability", "grading"];
const ATTEMPT_FIELDS = ["id", "userId", "status", "score", "created", "attemptDate", "modified", "exempt"];
const GRADE_FIELDS = ["userId", "columnId", "status", "score", "text", "exempt"];

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * One protected learner reference, as `LearnerVault` mints it
 * (packages/gateway-core/src/privacy.ts). A grade addresses a person by one of
 * these and by nothing else, so a caller cannot name a Blackboard account Morrow
 * has not tokenized for this exact course.
 */
const LEARNER_REFERENCE = /^learner_[A-Za-z0-9_-]{1,160}$/;

/** One short provider value as it may leave Morrow, such as `Completed` or `Yes`. */
const PROVIDER_VALUE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/**
 * One instant, as Blackboard writes a gradebook date. The offset form is
 * accepted as well as `Z`, because a site that answers with one form after a
 * change written in the other has not changed the date, and reporting that as an
 * unconfirmed change would be false.
 */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Morrow's own bounds on the values one reviewed change may carry. They are not
 * tenant limits: no tenant Swagger has been read. They exist so a mistyped
 * points value or a pasted paragraph is refused here, before review, instead of
 * being sent to a course.
 */
const MAX_POINTS = 1_000_000;
const MAX_COLUMN_NAME = 255;
const MAX_COLUMN_DESCRIPTION = 750;
const MAX_GRADE_TEXT = 64;

/** The five column fields one reviewed change may set. */
const COLUMN_PATCH_FIELDS = ["name", "description", "score", "availability", "grading"] as const;
type ColumnPatchField = (typeof COLUMN_PATCH_FIELDS)[number];

/** Where each supported column field lands in the protected projection. */
const PATCHED_COLUMN_FIELDS: Record<ColumnPatchField, string> = {
  name: "name",
  description: "description",
  score: "score.possible",
  availability: "availability.available",
  grading: "grading.due",
};

/**
 * The provider fields Morrow freezes before a column PATCH and re-checks after
 * it. Public Blackboard documentation does not settle whether a PATCH merges or
 * replaces a nested object, so the siblings of the two nested values a change
 * can set — the rest of `grading`, and the column's own identity — are frozen
 * too. A site that clears the grading schema or the attempt limit while it
 * applies a due date fails this readback instead of being reported as verified.
 */
const PROTECTED_COLUMN_FIELDS: readonly (readonly string[])[] = [
  ["id"],
  ["contentId"],
  ["externalGrade"],
  ["name"],
  ["description"],
  ["score", "possible"],
  ["availability", "available"],
  ["grading", "type"],
  ["grading", "due"],
  ["grading", "attemptsAllowed"],
  ["grading", "schemaId"],
  ["grading", "scoringModel"],
  ["grading", "anonymousGrading"],
];

/** The two grade fields one reviewed change may set. */
const GRADE_PATCH_FIELDS = ["score", "text"] as const;
type GradePatchField = (typeof GRADE_PATCH_FIELDS)[number];

/**
 * The provider values Morrow freezes before a grade PATCH. The precondition is
 * wider than the readback below on purpose: a grade that moved after review is
 * refused before anything is sent, which costs a person one more review, while a
 * value Blackboard derives from the change itself must not be reported as a
 * failed change.
 */
const PROTECTED_GRADE_FIELDS: readonly (readonly string[])[] = [
  ["userId"],
  ["columnId"],
  ["score"],
  ["text"],
  ["status"],
  ["exempt"],
];

/**
 * The grade values one fresh read has to return unchanged after a change, on top
 * of the values that change set. Nothing else is compared: Blackboard sets a
 * grade's status itself when a score is saved, and no live tenant has been read
 * to prove what it becomes, so the readback reports those values instead of
 * failing on them.
 */
const COMPARED_GRADE_FIELDS: readonly string[] = ["userId", "columnId"];

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

/**
 * How a person is named in a request. The field is not called `learner_token`
 * on purpose: Morrow's Gateway resolves a request field of that exact name
 * against its own learner vault before it forwards the request
 * (`resolveLearnerTokens`, packages/mcp-server/src/runtime.ts). A Blackboard
 * reference is minted inside this server, for this course, so the Gateway holds
 * no entry for it and a field of that name would never reach this source.
 */
const learnerReferenceInput = z.string().min(1).max(200);
const blackboardIdInput = z.string().regex(BLACKBOARD_ID);

const columnScopeInput = scopeInput.extend({ column_id: blackboardIdInput });
const attemptScopeInput = columnScopeInput.extend({ attempt_id: blackboardIdInput });
const gradeScopeInput = columnScopeInput.extend({ learner_reference: learnerReferenceInput });
const columnPatchInput = columnScopeInput.extend({ patch: patchInput });
const columnApplyInput = columnPatchInput.extend({
  expected_plan_digest: z.string().regex(SHA256),
  _morrow: z.strictObject({ outer_grant: effectGrantInput }),
});
const gradePatchInput = gradeScopeInput.extend({ patch: patchInput });
const gradeApplyInput = gradePatchInput.extend({
  expected_plan_digest: z.string().regex(SHA256),
  _morrow: z.strictObject({ outer_grant: effectGrantInput }),
});

type ColumnScope = z.output<typeof columnScopeInput>;
type ColumnPatch = z.output<typeof columnPatchInput>;
type GradeScope = z.output<typeof gradeScopeInput>;
type GradePatch = z.output<typeof gradePatchInput>;

export function columnsPath(courseId: string): string {
  return `/learn/api/public/v2/courses/${encodeURIComponent(courseId)}/gradebook/columns`;
}

export function columnPath(courseId: string, columnId: string): string {
  return `${columnsPath(courseId)}/${encodeURIComponent(columnId)}`;
}

function attemptsPath(courseId: string, columnId: string): string {
  return `${columnPath(courseId, columnId)}/attempts`;
}

function attemptPath(courseId: string, columnId: string, attemptId: string): string {
  return `${attemptsPath(courseId, columnId)}/${encodeURIComponent(attemptId)}`;
}

function gradePath(courseId: string, columnId: string, userId: string): string {
  return `${columnPath(courseId, columnId)}/users/${encodeURIComponent(userId)}`;
}

/** One single-record read, asking for the exact fields Morrow reads and no others. */
export function withFields(path: string, fields: readonly string[]): string {
  return `${path}?fields=${fields.join(",")}`;
}

/** One Blackboard record identifier Morrow can name a record by, or `null`. */
function exactId(value: unknown): string | null {
  return typeof value === "string" && BLACKBOARD_ID.test(value) ? value : null;
}

/** One short provider value as it may leave Morrow, or `null` when Blackboard reported none it reads. */
function providerValue(value: unknown): string | null {
  return typeof value === "string" && PROVIDER_VALUE.test(value) ? value : null;
}

/** One score as Blackboard reported it, or `null`. A grade written as text is `text`, not a score. */
function exactScore(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * One Blackboard date as one exact instant. Morrow compares the instant rather
 * than the text a site wrote it in, so a due date that comes back with
 * milliseconds it was not sent with is the same date, not a failed change.
 */
export function instant(value: unknown): string | null {
  if (typeof value !== "string" || !INSTANT.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** One reviewed text value. Morrow sends the text it was given, with nothing trimmed off it. */
function reviewedText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value || value.length > max || value !== value.trim()
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new BlackboardApiError("blackboard_response_invalid", `The Blackboard ${label} is invalid.`);
  }
  return value;
}

/**
 * The reference a request names a person by. A Blackboard user id is refused
 * here, before any request, so a caller cannot address a person through this
 * server that Morrow has not already tokenized for this course.
 */
function reviewedAccount(
  runtime: BlackboardLearnRuntime,
  input: { tenant_id: string; source_binding_id: string; course_id: string; learner_reference: string },
): { readonly reference: string; readonly userId: string } {
  if (!LEARNER_REFERENCE.test(input.learner_reference)) {
    throw new BlackboardApiError(
      "blackboard_scope_binding_required",
      "Name the person by the protected reference Morrow returned for them in this Blackboard course (learner_…). Morrow does not accept a Blackboard user id here.",
    );
  }
  return {
    reference: input.learner_reference,
    userId: runtime.learnerAccountId({
      tenantId: input.tenant_id,
      sourceBindingId: input.source_binding_id,
      courseId: input.course_id,
      reference: input.learner_reference,
    }),
  };
}

/**
 * The protected reference for one Blackboard account, from the roster this call
 * just read. A person that roster does not hold exactly once has no reference,
 * so this returns `null` and the caller decides what to do about it: a listing
 * names the record it left out, and a single read refuses.
 */
function rosterReference(read: BlackboardCourseRead, userId: unknown): string | null {
  const id = exactId(userId);
  if (!id) return null;
  const enrolled = read.roster.members.filter((member) => member.identity.id === id);
  return enrolled.length === 1 ? read.roster.learnerVault.tokenize(read.roster.learnerScope, enrolled[0]!.identity) : null;
}

const UNNAMEABLE_PERSON = "Blackboard did not return exactly one course membership for this person in the selected course, so Morrow cannot name them by a protected reference.";

/** The same reference, where Morrow cannot answer at all without it. */
function exactReference(read: BlackboardCourseRead, userId: unknown): string {
  const reference = rosterReference(read, userId);
  if (!reference) throw new BlackboardApiError("blackboard_membership_mismatch", UNNAMEABLE_PERSON);
  return reference;
}

/**
 * The person a grade route names has to be in the course now. A protected
 * reference resolves against this server's vault, which holds a person it
 * tokenized earlier; the roster this call just read is what says whether they
 * are still enrolled.
 */
function assertEnrolled(read: BlackboardCourseRead, userId: string): void {
  if (!rosterReference(read, userId)) throw new BlackboardApiError("blackboard_membership_mismatch", UNNAMEABLE_PERSON);
}

/**
 * One gradebook column as this module returns it. The column name and
 * description are provider text — a column can be named after a person — so they
 * leave through the same privacy boundary as every other Blackboard text.
 */
export function safeColumn(record: JsonObject, read: BlackboardCourseRead): JsonObject {
  const id = exactId(record.id);
  if (!id) throw new BlackboardApiError("blackboard_response_invalid", "Blackboard returned a gradebook column with no identifier Morrow can name it by.");
  const output: JsonObject = { id };
  redactInto(output, record, ["name", "description"], read.roster, "gradebook column");
  const contentId = exactId(record.contentId);
  if (contentId) output.contentId = contentId;
  const possible = isJsonObject(record.score) ? exactScore(record.score.possible) : null;
  if (possible !== null) output.score = { possible };
  const available = isJsonObject(record.availability) ? providerValue(record.availability.available) : null;
  if (available) output.availability = { available };
  const grading: JsonObject = {};
  if (isJsonObject(record.grading)) {
    const type = providerValue(record.grading.type);
    const due = instant(record.grading.due);
    if (type) grading.type = type;
    if (due) grading.due = due;
  }
  if (Object.keys(grading).length > 0) output.grading = grading;
  if (typeof record.externalGrade === "boolean") output.externalGrade = record.externalGrade;
  return output;
}

/**
 * One attempt as this module returns it: who made it as a protected reference,
 * what it scored, where it stands, and when it happened. The submitted work
 * itself is not here and is not read: `ATTEMPT_FIELDS` never asks for it.
 */
function safeAttempt(record: JsonObject, reference: string): JsonObject {
  const id = exactId(record.id);
  if (!id) throw new BlackboardApiError("blackboard_response_invalid", "Blackboard returned an attempt with no identifier Morrow can name it by.");
  const output: JsonObject = { id, learnerToken: reference };
  const status = providerValue(record.status);
  if (status) output.status = status;
  const score = exactScore(record.score);
  if (score !== null) output.score = score;
  for (const field of ["created", "attemptDate", "modified"]) {
    const at = instant(record[field]);
    if (at) output[field] = at;
  }
  if (typeof record.exempt === "boolean") output.exempt = record.exempt;
  return output;
}

/**
 * One person's grade in one column as this module returns it. The grade text is
 * provider text and leaves through the privacy boundary; the instructor feedback
 * and the private notes on a grade are not here and are not read.
 */
function safeGrade(record: JsonObject, reference: string, read: BlackboardCourseRead): JsonObject {
  const output: JsonObject = { learnerToken: reference };
  const score = exactScore(record.score);
  if (score !== null) output.score = score;
  redactInto(output, record, ["text"], read.roster, "grade");
  const status = providerValue(record.status);
  if (status) output.status = status;
  if (typeof record.exempt === "boolean") output.exempt = record.exempt;
  return output;
}

/** The frozen protected values of one exact record, absent fields omitted. */
function protectedValues(value: JsonObject, paths: readonly (readonly string[])[]): JsonObject {
  const output: JsonObject = {};
  for (const path of paths) {
    let current: unknown = value;
    for (const segment of path) current = isJsonObject(current) ? current[segment] : undefined;
    if (current === undefined) continue;
    const key = path.join(".");
    // A date is frozen and compared as one instant, so the same moment written
    // two ways is one value here.
    output[key] = key === "grading.due" ? instant(current) ?? current : current;
  }
  return output;
}

/** The protected projection an exact provider returns after this exact change. */
function expectedValues(
  frozen: JsonObject,
  patch: JsonObject,
  fields: readonly string[],
  landing: Readonly<Record<string, string>>,
): JsonObject {
  const output: JsonObject = { ...frozen };
  for (const field of fields) {
    if (!Object.hasOwn(patch, field)) continue;
    const value = patch[field];
    const key = landing[field]!;
    output[key] = key === "score.possible" && isJsonObject(value) ? value.possible
      : key === "availability.available" && isJsonObject(value) ? value.available
      : key === "grading.due" && isJsonObject(value) ? value.due
      : value;
  }
  return output;
}

/** Whether one fresh read already carries every reviewed value. */
function savedValues(
  record: JsonObject,
  patch: JsonObject,
  paths: readonly (readonly string[])[],
  fields: readonly string[],
  landing: Readonly<Record<string, string>>,
): boolean {
  const current = protectedValues(record, paths);
  const expected = expectedValues({}, patch, fields, landing);
  return Object.keys(expected).every((key) => (
    Object.hasOwn(current, key) && canonicalJson(current[key]) === canonicalJson(expected[key])
  ));
}

/**
 * A gradebook column change sets the name, the description, the points possible,
 * whether the column is available, the due date, or any of those together.
 * Everything else — the grading type, the grading schema, the attempt limit, the
 * content item the column grades — is refused here, before any request.
 */
function reviewedColumnPatch(value: unknown): JsonObject {
  if (!isJsonObject(value)) {
    throw new BlackboardApiError("blackboard_response_invalid", "The Blackboard gradebook column change is invalid.");
  }
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !COLUMN_PATCH_FIELDS.includes(key as ColumnPatchField))) {
    throw new BlackboardApiError(
      "blackboard_response_invalid",
      "A Blackboard gradebook column change sets the name, the description, the points possible, whether the column is available, the due date, or any of those together, and nothing else.",
    );
  }
  const output: JsonObject = {};
  for (const field of COLUMN_PATCH_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    const candidate = value[field];
    if (field === "name" || field === "description") {
      output[field] = reviewedText(candidate, `gradebook column ${field}`, field === "name" ? MAX_COLUMN_NAME : MAX_COLUMN_DESCRIPTION);
      continue;
    }
    if (field === "score") {
      const possible = isJsonObject(candidate) && Object.keys(candidate).length === 1 ? exactScore(candidate.possible) : null;
      if (possible === null || possible < 0 || possible > MAX_POINTS) {
        throw new BlackboardApiError(
          "blackboard_response_invalid",
          `Morrow sets the points possible on a Blackboard gradebook column to one number between 0 and ${MAX_POINTS}. It sets no other score value.`,
        );
      }
      output.score = { possible };
      continue;
    }
    if (field === "availability") {
      if (!isJsonObject(candidate) || Object.keys(candidate).some((key) => key !== "available")
        || typeof candidate.available !== "string" || !["Yes", "No"].includes(candidate.available)) {
        throw new BlackboardApiError(
          "blackboard_response_invalid",
          "Morrow sets a Blackboard gradebook column to available Yes or No. It sets no other availability value.",
        );
      }
      output.availability = { available: candidate.available };
      continue;
    }
    const due = isJsonObject(candidate) && Object.keys(candidate).length === 1 ? instant(candidate.due) : null;
    if (!due) {
      throw new BlackboardApiError(
        "blackboard_response_invalid",
        "Morrow sets one due date on a Blackboard gradebook column, written as one exact instant such as 2026-09-30T23:59:00.000Z. It sets no other grading value.",
      );
    }
    output.grading = { due };
  }
  return output;
}

/**
 * A grade change sets the score, the grade text, or both. Everything else — the
 * status, whether the grade is exempt, the feedback a learner reads — is refused
 * here, before any request.
 */
function reviewedGradePatch(value: unknown): JsonObject {
  if (!isJsonObject(value)) {
    throw new BlackboardApiError("blackboard_response_invalid", "The Blackboard grade change is invalid.");
  }
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !GRADE_PATCH_FIELDS.includes(key as GradePatchField))) {
    throw new BlackboardApiError(
      "blackboard_response_invalid",
      "A Blackboard grade change sets the score, the grade text, or both, and nothing else. Morrow does not change feedback, notes, or whether a grade is exempt.",
    );
  }
  const output: JsonObject = {};
  if (Object.hasOwn(value, "score")) {
    const score = exactScore(value.score);
    if (score === null || score < 0 || score > MAX_POINTS) {
      throw new BlackboardApiError(
        "blackboard_response_invalid",
        `Morrow sets a Blackboard score to one number between 0 and ${MAX_POINTS}.`,
      );
    }
    output.score = score;
  }
  if (Object.hasOwn(value, "text")) output.text = reviewedText(value.text, "grade text", MAX_GRADE_TEXT);
  return output;
}

/** Blackboard has to answer a column read with the column that was asked for. */
function assertColumn(record: JsonObject, columnId: string): JsonObject {
  if (record.id !== columnId) {
    throw new BlackboardApiError("blackboard_content_mismatch", "Blackboard returned a different gradebook column than the one Morrow asked for.");
  }
  return record;
}

/** Blackboard has to answer a grade read with that person's grade in that column. */
function assertGrade(record: JsonObject, columnId: string, userId: string): JsonObject {
  if (record.userId !== userId || (record.columnId !== undefined && record.columnId !== columnId)) {
    throw new BlackboardApiError(
      "blackboard_content_mismatch",
      "Blackboard returned a grade for a different person or a different gradebook column than the one Morrow asked for.",
    );
  }
  return record;
}

interface FrozenPlan {
  readonly record: JsonObject;
  readonly beforeDigest: string;
  readonly planDigest: string;
}

/**
 * One fresh read of the exact column, frozen as the precondition a column change
 * is reviewed against. The digest binds the tenant, the course connection, the
 * course, the column, that column's protected values, and the exact reviewed
 * change.
 */
async function freezeColumnPlan(
  write: BlackboardCourseRead,
  columnId: string,
  patch: JsonObject,
  signal?: AbortSignal,
): Promise<FrozenPlan> {
  const record = assertColumn(await write.client.get(withFields(columnPath(write.courseId, columnId), COLUMN_FIELDS), signal), columnId);
  const beforeDigest = sha256Text(canonicalJson(protectedValues(record, PROTECTED_COLUMN_FIELDS)));
  const planDigest = sha256Text(canonicalJson({
    tenantId: write.tenantId,
    sourceBindingId: write.sourceBindingId,
    courseId: write.courseId,
    columnId,
    beforeDigest,
    patch,
  }));
  return { record, beforeDigest, planDigest };
}

/**
 * One fresh read of the exact grade, frozen as the precondition a grade change is
 * reviewed against. The digest binds the person the reference resolved to as
 * well as the column, so a dispatch that names another person or another column
 * fails the precondition instead of writing.
 */
async function freezeGradePlan(
  write: BlackboardCourseRead,
  columnId: string,
  userId: string,
  patch: JsonObject,
  signal?: AbortSignal,
): Promise<FrozenPlan> {
  const record = assertGrade(
    await write.client.get(withFields(gradePath(write.courseId, columnId, userId), GRADE_FIELDS), signal),
    columnId,
    userId,
  );
  const beforeDigest = sha256Text(canonicalJson(protectedValues(record, PROTECTED_GRADE_FIELDS)));
  const planDigest = sha256Text(canonicalJson({
    tenantId: write.tenantId,
    sourceBindingId: write.sourceBindingId,
    courseId: write.courseId,
    columnId,
    userId,
    beforeDigest,
    patch,
  }));
  return { record, beforeDigest, planDigest };
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

function columnEffectTarget(runtime: BlackboardLearnRuntime, input: ColumnScope) {
  return runtime.effectTarget({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, "gradebook-column", { columnId: input.column_id });
}

function gradeEffectTarget(runtime: BlackboardLearnRuntime, input: GradeScope, userId: string) {
  return runtime.effectTarget({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, "gradebook-grade", { columnId: input.column_id, userId });
}

/** What the readback after each change proves, in plain words. */
const COLUMN_READBACK_DETAIL = "Morrow re-read the gradebook column and compared its identity, its name and description, the points possible, whether it is available, and every grading value it froze, against the reviewed plan.";
const GRADE_READBACK_DETAIL = "Morrow re-read the grade and compared the person, the column, and every value this change set. It reports the status and whether the grade is exempt beside that comparison and does not fail on them, because Blackboard sets those itself when a grade is saved and no live Blackboard tenant has been read.";

const COLUMN_READBACK_STATE = "protected_fields";
const GRADE_READBACK_STATE = "reviewed_fields";

function readCapability(sourceExport: string, dataClass: string): SourceCapabilityMetadata {
  return {
    family: "course-read",
    provider: "blackboard",
    sourceExport,
    behavior: READ_BEHAVIOR,
    authority: { scopeClass: "tenant-course", approvalClass: "none", dataClass },
    route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
    profiles: READ_PROFILES,
    evidence: EVIDENCE,
  };
}

/** Every gradebook column in the selected course. */
async function listGradebookColumns(
  runtime: BlackboardLearnRuntime,
  input: z.output<typeof scopeInput>,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const read = await runtime.beginCourseRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const records = await read.client.collect(columnsPath(read.courseId), { label: "gradebook column", fields: COLUMN_FIELDS, signal });
  const columns = records.map((record) => safeColumn(record, read));
  return {
    schema: "morrow.blackboard.gradebook-columns.v1",
    ok: true,
    tenantId: read.tenantId,
    sourceBindingId: read.sourceBindingId,
    courseId: read.courseId,
    columns,
    count: columns.length,
    status: "api_configured_live_untested",
    diagnostics: read.cost(),
  };
}

/** One selected gradebook column. */
async function readGradebookColumn(
  runtime: BlackboardLearnRuntime,
  input: ColumnScope,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const read = await runtime.beginCourseRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const record = assertColumn(
    await read.client.get(withFields(columnPath(read.courseId, input.column_id), COLUMN_FIELDS), signal),
    input.column_id,
  );
  return {
    schema: "morrow.blackboard.gradebook-column.v1",
    ok: true,
    tenantId: read.tenantId,
    sourceBindingId: read.sourceBindingId,
    courseId: read.courseId,
    columnId: input.column_id,
    column: safeColumn(record, read),
    status: "api_configured_live_untested",
    diagnostics: read.cost(),
  };
}

/**
 * Every attempt in one gradebook column, read through the shared bounded
 * pagination: each page has to come from this tenant's origin and this exact
 * route, and a page ceiling, a record ceiling, a repeated page, or a repeated
 * record identity refuses the whole read rather than returning part of it.
 *
 * An attempt whose person this course's roster does not hold exactly once is
 * named in `unread` instead of being returned, because Morrow will not report a
 * learner it cannot name by a protected reference.
 */
async function listGradebookAttempts(
  runtime: BlackboardLearnRuntime,
  input: ColumnScope,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const read = await runtime.beginCourseRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const records = await read.client.collect(attemptsPath(read.courseId, input.column_id), {
    label: "attempt", fields: ATTEMPT_FIELDS, signal,
  });
  const attempts: JsonObject[] = [];
  const unread: JsonObject[] = [];
  for (const record of records) {
    const reference = rosterReference(read, record.userId);
    if (!reference) {
      unread.push({
        ...(exactId(record.id) ? { id: record.id } : {}),
        reason: "learner_unread",
        detail: "Blackboard returned this attempt for a person the selected course's roster does not hold exactly once, so Morrow left it out rather than name them another way.",
      });
      continue;
    }
    attempts.push(safeAttempt(record, reference));
  }
  return {
    schema: "morrow.blackboard.gradebook-attempts.v1",
    ok: true,
    tenantId: read.tenantId,
    sourceBindingId: read.sourceBindingId,
    courseId: read.courseId,
    columnId: input.column_id,
    attempts,
    count: attempts.length,
    complete: unread.length === 0,
    unread,
    status: "api_configured_live_untested",
    diagnostics: read.cost(),
  };
}

/** One selected attempt in one gradebook column. */
async function readGradebookAttempt(
  runtime: BlackboardLearnRuntime,
  input: z.output<typeof attemptScopeInput>,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const read = await runtime.beginCourseRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const record = await read.client.get(
    withFields(attemptPath(read.courseId, input.column_id, input.attempt_id), ATTEMPT_FIELDS),
    signal,
  );
  if (record.id !== input.attempt_id) {
    throw new BlackboardApiError("blackboard_content_mismatch", "Blackboard returned a different attempt than the one Morrow asked for.");
  }
  return {
    schema: "morrow.blackboard.gradebook-attempt.v1",
    ok: true,
    tenantId: read.tenantId,
    sourceBindingId: read.sourceBindingId,
    courseId: read.courseId,
    columnId: input.column_id,
    attemptId: input.attempt_id,
    attempt: safeAttempt(record, exactReference(read, record.userId)),
    status: "api_configured_live_untested",
    diagnostics: read.cost(),
  };
}

/** One person's grade in one gradebook column, named by a protected reference. */
async function readGradebookGrade(
  runtime: BlackboardLearnRuntime,
  input: GradeScope,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const { reference, userId } = reviewedAccount(runtime, input);
  const read = await runtime.beginCourseRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  assertEnrolled(read, userId);
  const record = assertGrade(
    await read.client.get(withFields(gradePath(read.courseId, input.column_id, userId), GRADE_FIELDS), signal),
    input.column_id,
    userId,
  );
  return {
    schema: "morrow.blackboard.gradebook-grade.v1",
    ok: true,
    tenantId: read.tenantId,
    sourceBindingId: read.sourceBindingId,
    courseId: read.courseId,
    columnId: input.column_id,
    grade: safeGrade(record, reference, read),
    status: "api_configured_live_untested",
    diagnostics: read.cost(),
  };
}

/** One reviewed column change, frozen against a fresh read of that exact column. */
async function planGradebookColumnPatch(
  runtime: BlackboardLearnRuntime,
  input: ColumnPatch,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const patch = reviewedColumnPatch(input.patch);
  runtime.assertEffectTargetFree(columnEffectTarget(runtime, input));
  // A plan exists only to be dispatched, so it carries the write condition. An
  // instructor is refused before review instead of after approving a change
  // Morrow would then refuse to send.
  const write = await runtime.beginCourseWrite({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const frozen = await freezeColumnPlan(write, input.column_id, patch, signal);
  return {
    schema: "morrow.blackboard.gradebook-column-patch.plan.v1",
    ok: true,
    tenantId: write.tenantId,
    sourceBindingId: write.sourceBindingId,
    courseId: write.courseId,
    columnId: input.column_id,
    before: safeColumn(frozen.record, write),
    beforeDigest: frozen.beforeDigest,
    patch,
    planDigest: frozen.planDigest,
    reviewRequired: true,
    limits: { fields: ["name", "description", "score.possible", "availability.available", "grading.due"], columns: 1 },
    readback: COLUMN_READBACK_STATE,
    readbackDetail: COLUMN_READBACK_DETAIL,
    status: "api_configured_live_untested",
    effect_scope: runtime.effectScope({
      tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
    }),
  };
}

/**
 * The one dispatch for a column change: it re-reads the exact column, refuses
 * when anything it froze changed after review, sends one PATCH, and reads the
 * column back. Everything it can refuse it refuses before the PATCH leaves this
 * process, and the one-use receipt is spent before the first provider request,
 * so two dispatches of one approval cannot both pass the precondition and write.
 */
async function applyReviewedGradebookColumnPatch(
  runtime: BlackboardLearnRuntime,
  input: z.output<typeof columnApplyInput>,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const grant = reservedGrant(input._morrow.outer_grant);
  runtime.assertReservedEffectGrant(grant);
  if (grant.planDigest !== input.expected_plan_digest) {
    throw new BlackboardApiError("blackboard_patch_review_required", "The Blackboard effect grant does not match this exact reviewed plan.");
  }
  const patch = reviewedColumnPatch(input.patch);
  const dispatch = runtime.claimReservedEffectGrant(grant, columnEffectTarget(runtime, input));
  const write = await runtime.beginCourseWrite({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const frozen = await freezeColumnPlan(write, input.column_id, patch, signal);
  if (frozen.planDigest !== input.expected_plan_digest) {
    // One digest binds the column, its frozen values, and the change, so a
    // column changed after review and a request that names another column both
    // fail here. The refusal names both, because this route cannot tell them
    // apart and must not report the wrong one.
    throw new BlackboardApiError(
      "blackboard_content_mismatch",
      "The Blackboard gradebook column Morrow read does not match the reviewed plan. It changed after review, or this request names a different column. The change was not sent.",
    );
  }
  const expected = expectedValues(
    protectedValues(frozen.record, PROTECTED_COLUMN_FIELDS),
    patch,
    COLUMN_PATCH_FIELDS,
    PATCHED_COLUMN_FIELDS,
  );
  // Morrow cannot prove a change did not land once the PATCH request has left
  // this process. The marker is set on the line before that request, so every
  // failure from here on is reported as applied_or_unknown, and every refusal
  // raised above this point keeps not_sent.
  let dispatchState: BlackboardDispatchState = "not_sent";
  dispatch.markSent();
  try {
    dispatchState = "applied_or_unknown";
    await write.client.patch(columnPath(write.courseId, input.column_id), patch, signal);
    const readback = assertColumn(
      await write.client.get(withFields(columnPath(write.courseId, input.column_id), COLUMN_FIELDS), signal),
      input.column_id,
    );
    if (canonicalJson(protectedValues(readback, PROTECTED_COLUMN_FIELDS)) !== canonicalJson(expected)) {
      throw new BlackboardApiError(
        "blackboard_content_mismatch",
        "Blackboard did not return every reviewed and protected gradebook column value after the change.",
        undefined,
        dispatchState,
      );
    }
    dispatch.markVerified();
    return {
      schema: "morrow.blackboard.gradebook-column-patch.readback.v1",
      ok: true,
      // Morrow's operation journal reads this marker to decide what reached
      // Blackboard. The read payloads keep `status`, which is an evidence label.
      resultState: "applied",
      tenantId: write.tenantId,
      sourceBindingId: write.sourceBindingId,
      courseId: write.courseId,
      columnId: input.column_id,
      column: safeColumn(readback, write),
      readback: COLUMN_READBACK_STATE,
      readbackDetail: COLUMN_READBACK_DETAIL,
      status: "api_configured_live_untested",
    };
  } catch (error) {
    dispatch.markUncertain();
    throw withBlackboardDispatchState(error, dispatchState);
  }
}

/**
 * The Gateway's fresh-read comparator for one reviewed column change. It holds
 * no frozen snapshot, so it states only whether the reviewed values are saved on
 * that column now. The precondition that catches a column changed after review
 * belongs to the dispatch above, which sent the change and holds that snapshot.
 *
 * It prepares no roster and reads no course membership, and it carries no
 * `diagnostics`, because the Gateway freezes this exact payload when it plans
 * the operation.
 */
async function verifyGradebookColumnPatch(
  runtime: BlackboardLearnRuntime,
  input: ColumnPatch,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const patch = reviewedColumnPatch(input.patch);
  const comparator = await runtime.beginComparatorRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const record = await comparator.client.get(withFields(columnPath(comparator.courseId, input.column_id), COLUMN_FIELDS), signal);
  const verified = record.id === input.column_id
    && savedValues(record, patch, PROTECTED_COLUMN_FIELDS, COLUMN_PATCH_FIELDS, PATCHED_COLUMN_FIELDS);
  runtime.recordEffectComparison(columnEffectTarget(runtime, input), verified);
  return {
    schema: "morrow.blackboard.gradebook-column-patch.comparator.v1",
    ok: true,
    tenantId: comparator.tenantId,
    sourceBindingId: comparator.sourceBindingId,
    courseId: comparator.courseId,
    columnId: input.column_id,
    verified,
    readback: COLUMN_READBACK_STATE,
    status: "api_configured_live_untested",
  };
}

/** One reviewed grade change, frozen against a fresh read of that exact grade. */
async function planGradebookGradePatch(
  runtime: BlackboardLearnRuntime,
  input: GradePatch,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const patch = reviewedGradePatch(input.patch);
  const { reference, userId } = reviewedAccount(runtime, input);
  runtime.assertEffectTargetFree(gradeEffectTarget(runtime, input, userId));
  const write = await runtime.beginCourseWrite({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  assertEnrolled(write, userId);
  const frozen = await freezeGradePlan(write, input.column_id, userId, patch, signal);
  return {
    schema: "morrow.blackboard.gradebook-grade-patch.plan.v1",
    ok: true,
    tenantId: write.tenantId,
    sourceBindingId: write.sourceBindingId,
    courseId: write.courseId,
    columnId: input.column_id,
    before: safeGrade(frozen.record, reference, write),
    beforeDigest: frozen.beforeDigest,
    patch,
    planDigest: frozen.planDigest,
    reviewRequired: true,
    limits: { fields: ["score", "text"], grades: 1 },
    readback: GRADE_READBACK_STATE,
    readbackDetail: GRADE_READBACK_DETAIL,
    status: "api_configured_live_untested",
    effect_scope: runtime.effectScope({
      tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
    }),
  };
}

/**
 * The one dispatch for a grade change: it re-reads that person's grade in that
 * column, refuses when the grade moved after review, sends one PATCH, and reads
 * the grade back. Everything it can refuse it refuses before the PATCH leaves
 * this process, and the one-use receipt is spent before the first provider
 * request.
 */
async function applyReviewedGradebookGradePatch(
  runtime: BlackboardLearnRuntime,
  input: z.output<typeof gradeApplyInput>,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const grant = reservedGrant(input._morrow.outer_grant);
  runtime.assertReservedEffectGrant(grant);
  if (grant.planDigest !== input.expected_plan_digest) {
    throw new BlackboardApiError("blackboard_patch_review_required", "The Blackboard effect grant does not match this exact reviewed plan.");
  }
  const patch = reviewedGradePatch(input.patch);
  const { reference, userId } = reviewedAccount(runtime, input);
  const dispatch = runtime.claimReservedEffectGrant(grant, gradeEffectTarget(runtime, input, userId));
  const write = await runtime.beginCourseWrite({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  assertEnrolled(write, userId);
  const frozen = await freezeGradePlan(write, input.column_id, userId, patch, signal);
  if (frozen.planDigest !== input.expected_plan_digest) {
    // One digest binds the person, the column, the frozen grade, and the change,
    // so a grade changed after review and a request that names another person or
    // another column all fail here. The refusal names them, because this route
    // cannot tell them apart and must not report the wrong one.
    throw new BlackboardApiError(
      "blackboard_content_mismatch",
      "The Blackboard grade Morrow read does not match the reviewed plan. It changed after review, or this request names a different person or a different column. The change was not sent.",
    );
  }
  const expected = expectedValues(
    protectedValues(frozen.record, PROTECTED_GRADE_FIELDS.filter((path) => COMPARED_GRADE_FIELDS.includes(path.join(".")))),
    patch,
    GRADE_PATCH_FIELDS,
    { score: "score", text: "text" },
  );
  let dispatchState: BlackboardDispatchState = "not_sent";
  dispatch.markSent();
  try {
    dispatchState = "applied_or_unknown";
    await write.client.patch(gradePath(write.courseId, input.column_id, userId), patch, signal);
    const readback = await write.client.get(withFields(gradePath(write.courseId, input.column_id, userId), GRADE_FIELDS), signal);
    const compared = protectedValues(readback, PROTECTED_GRADE_FIELDS.filter((path) => (
      COMPARED_GRADE_FIELDS.includes(path.join(".")) || Object.hasOwn(patch, path.join("."))
    )));
    if (canonicalJson(compared) !== canonicalJson(expected)) {
      throw new BlackboardApiError(
        "blackboard_content_mismatch",
        "Blackboard did not return this person, this gradebook column, and every reviewed grade value after the change.",
        undefined,
        dispatchState,
      );
    }
    dispatch.markVerified();
    return {
      schema: "morrow.blackboard.gradebook-grade-patch.readback.v1",
      ok: true,
      resultState: "applied",
      tenantId: write.tenantId,
      sourceBindingId: write.sourceBindingId,
      courseId: write.courseId,
      columnId: input.column_id,
      grade: safeGrade(readback, reference, write),
      readback: GRADE_READBACK_STATE,
      readbackDetail: GRADE_READBACK_DETAIL,
      status: "api_configured_live_untested",
    };
  } catch (error) {
    dispatch.markUncertain();
    throw withBlackboardDispatchState(error, dispatchState);
  }
}

/**
 * The Gateway's fresh-read comparator for one reviewed grade change. It states
 * only whether the reviewed score and grade text are saved on that person's
 * grade in that column now.
 */
async function verifyGradebookGradePatch(
  runtime: BlackboardLearnRuntime,
  input: GradePatch,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const patch = reviewedGradePatch(input.patch);
  const { reference, userId } = reviewedAccount(runtime, input);
  const comparator = await runtime.beginComparatorRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const record = await comparator.client.get(withFields(gradePath(comparator.courseId, input.column_id, userId), GRADE_FIELDS), signal);
  const exact = record.userId === userId && (record.columnId === undefined || record.columnId === input.column_id);
  const verified = exact && savedValues(record, patch, PROTECTED_GRADE_FIELDS, GRADE_PATCH_FIELDS, { score: "score", text: "text" });
  runtime.recordEffectComparison(gradeEffectTarget(runtime, input, userId), verified);
  return {
    schema: "morrow.blackboard.gradebook-grade-patch.comparator.v1",
    ok: true,
    tenantId: comparator.tenantId,
    sourceBindingId: comparator.sourceBindingId,
    courseId: comparator.courseId,
    columnId: input.column_id,
    learnerToken: reference,
    verified,
    readback: GRADE_READBACK_STATE,
    status: "api_configured_live_untested",
  };
}

/**
 * The Blackboard gradebook: the columns of the selected course, the attempts in
 * one column, one person's grade, one reviewed change to a column, and one
 * reviewed change to a grade.
 *
 * Grades are learner data. Every attempt and every grade leaves this server as a
 * protected reference from the learner vault, the score, the status, and the
 * timestamps Blackboard reported, and nothing else. A learner's submitted work,
 * their comments, and an instructor's feedback and private notes are not
 * returned and are not read: `ATTEMPT_FIELDS` and `GRADE_FIELDS` never ask
 * Blackboard for them.
 *
 * A change here is three separate routes, as every Morrow provider change is:
 * the plan an instructor reviews, the dispatch the Gateway makes once against a
 * signed one-use effect grant, and the fresh-read comparator. Neither change is
 * reachable yet: Morrow's Gateway has no public plan tool for a Blackboard
 * gradebook column or grade, so nothing can dispatch these routes until that
 * wiring exists. A grade change also names one person by a protected reference,
 * which Morrow's native MCP egress does not release from the roster read, the
 * same boundary the membership routes meet.
 * docs/implementation/BLACKBOARD-REST-SCOPE.md records both.
 *
 * Creating a gradebook column (`POST` on the columns route) and deleting one
 * (`DELETE` on the column route) are held. Deleting a column removes every grade
 * in it and Morrow holds no undo contract for that. Creating one is not
 * implemented: it would need its own frozen request and a readback that re-reads
 * the created column by the id the site returned, and this module sends neither.
 *
 * Grading schemas and grading exceptions differ by Learn site, and no live
 * Blackboard tenant has been read, so the whole domain is live-unverified: which
 * of these routes a site serves, which fields it answers with, and what it does
 * to a grade's status when a score is saved are all unproven here.
 */
export const blackboardGradebookModule: BlackboardOperationModule = {
  id: "gradebook",
  tools: [
    blackboardTool({
      name: "blackboard_list_gradebook_columns",
      title: "List the Blackboard gradebook columns",
      description: "List the gradebook columns of one selected Blackboard Learn course: each column's name, description, points possible, availability, grading type, and due date. It returns no learner and no grade. Column names are redacted against the course roster before output.",
      private: false,
      gatewayDispatchOnly: false,
      inputSchema: scopeInput,
      annotations: READ_ANNOTATIONS,
      capability: readCapability(`GET ${COLUMNS_ROUTE}`, "course"),
      rest: {
        method: "GET",
        pathTemplate: COLUMNS_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => listGradebookColumns(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_read_gradebook_column",
      title: "Read one Blackboard gradebook column",
      description: "Read one selected gradebook column of one Blackboard Learn course: its name, description, points possible, availability, grading type, and due date. It returns no learner and no grade. Name the column by the id the Blackboard gradebook column list returned for it.",
      private: false,
      gatewayDispatchOnly: false,
      inputSchema: columnScopeInput,
      annotations: READ_ANNOTATIONS,
      capability: readCapability(`GET ${COLUMN_ROUTE}`, "course"),
      rest: {
        method: "GET",
        pathTemplate: COLUMN_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => readGradebookColumn(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_list_gradebook_attempts",
      title: "List the attempts in one Blackboard gradebook column",
      description: "List the attempts in one selected Blackboard Learn gradebook column. Each attempt shows who made it as a protected reference, its score, its status, and its timestamps. It returns no learner name, no submitted work, and no feedback. An attempt Morrow cannot name by a protected reference is listed as unread with the reason instead.",
      private: false,
      gatewayDispatchOnly: false,
      inputSchema: columnScopeInput,
      annotations: READ_ANNOTATIONS,
      capability: readCapability(`GET ${ATTEMPTS_ROUTE}`, "learner"),
      rest: {
        method: "GET",
        pathTemplate: ATTEMPTS_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => listGradebookAttempts(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_read_gradebook_attempt",
      title: "Read one Blackboard attempt",
      description: "Read one selected attempt in one Blackboard Learn gradebook column: who made it as a protected reference, its score, its status, and its timestamps. It returns no learner name, no submitted work, and no feedback.",
      private: false,
      gatewayDispatchOnly: false,
      inputSchema: attemptScopeInput,
      annotations: READ_ANNOTATIONS,
      capability: readCapability(`GET ${ATTEMPT_ROUTE}`, "learner"),
      rest: {
        method: "GET",
        pathTemplate: ATTEMPT_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => readGradebookAttempt(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_read_gradebook_grade",
      title: "Read one person's Blackboard grade",
      description: "Read one person's grade in one selected Blackboard Learn gradebook column: the score, the grade as text, the status, and whether the grade is exempt. Name the person by the protected reference the Blackboard roster read returned for them (learner_…); this tool does not accept a Blackboard user id. It returns no learner name, no feedback, and no submitted work.",
      private: false,
      gatewayDispatchOnly: false,
      inputSchema: gradeScopeInput,
      annotations: READ_ANNOTATIONS,
      capability: readCapability(`GET ${GRADE_ROUTE}`, "grade"),
      rest: {
        method: "GET",
        pathTemplate: GRADE_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => readGradebookGrade(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_plan_gradebook_column_patch",
      title: "Plan one Blackboard gradebook column change",
      description: "Prepare one change to a Blackboard Learn gradebook column for Morrow review: its name, its description, the points possible, whether it is available, the due date, or any of those together. It changes no learner's grade. This tool does not send a Blackboard PATCH request, and it never creates or deletes a gradebook column.",
      private: true,
      gatewayDispatchOnly: false,
      inputSchema: columnPatchInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: {
        family: "gradebook-column-update",
        provider: "blackboard",
        sourceExport: `PATCH ${COLUMN_ROUTE}`,
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
        pathTemplate: COLUMN_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => planGradebookColumnPatch(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_apply_reviewed_gradebook_column_patch",
      title: "Apply one reserved Blackboard gradebook column change",
      description: "Internal Morrow dispatch route. This request requires an exact signed Gateway effect grant.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: columnApplyInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: {
        family: "gradebook-column-update",
        provider: "blackboard",
        sourceExport: `PATCH ${COLUMN_ROUTE}`,
        behavior: {
          readOnly: false, mutating: true, destructive: false, irreversible: false,
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
        pathTemplate: COLUMN_ROUTE,
        access: "write",
        entitlement: "unknown",
        reviewRoute: "blackboard_plan_gradebook_column_patch",
        readbackComparator: "blackboard_verify_gradebook_column_patch",
      },
      run: (runtime, input, signal) => applyReviewedGradebookColumnPatch(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_verify_gradebook_column_patch",
      title: "Verify one Blackboard gradebook column change",
      description: "Internal Morrow fresh-read comparator for one reviewed Blackboard gradebook column change. It re-reads the column and states whether the reviewed values are saved on it now.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: columnPatchInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      capability: {
        family: "course-read",
        provider: "blackboard",
        sourceExport: `GET ${COLUMN_ROUTE}`,
        behavior: READ_BEHAVIOR,
        authority: { scopeClass: "tenant-course", approvalClass: "none", dataClass: "course" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: COMPARATOR_PROFILES,
        evidence: EVIDENCE,
      },
      rest: {
        method: "GET",
        pathTemplate: COLUMN_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => verifyGradebookColumnPatch(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_plan_gradebook_grade_patch",
      title: "Plan one Blackboard grade change",
      description: "Prepare one change to a person's grade in one Blackboard Learn gradebook column for Morrow review: the score, the grade as text, or both. Name the person by the protected reference the Blackboard roster read returned for them (learner_…). This tool does not send a Blackboard PATCH request, and it changes no feedback and no exemption.",
      private: true,
      gatewayDispatchOnly: false,
      inputSchema: gradePatchInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: {
        family: "grade-update",
        provider: "blackboard",
        sourceExport: `PATCH ${GRADE_ROUTE}`,
        behavior: {
          readOnly: true, mutating: false, destructive: false, irreversible: false,
          supportsDryRun: false, supportsReadback: true, supportsUndo: false, supportsBatch: false,
          requiresBrowser: false, requiresLiveCanvas: false,
        },
        authority: { scopeClass: "tenant-course", approvalClass: "grade", dataClass: "grade" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: WRITE_PROFILES,
        evidence: EVIDENCE,
      },
      rest: {
        method: "GET",
        pathTemplate: GRADE_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => planGradebookGradePatch(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_apply_reviewed_gradebook_grade_patch",
      title: "Apply one reserved Blackboard grade change",
      description: "Internal Morrow dispatch route. This request requires an exact signed Gateway effect grant.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: gradeApplyInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: {
        family: "grade-update",
        provider: "blackboard",
        sourceExport: `PATCH ${GRADE_ROUTE}`,
        behavior: {
          readOnly: false, mutating: true, destructive: false, irreversible: false,
          supportsDryRun: false, supportsReadback: true, supportsUndo: false, supportsBatch: false,
          requiresBrowser: false, requiresLiveCanvas: false,
        },
        authority: { scopeClass: "tenant-course", approvalClass: "grade", dataClass: "grade" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: WRITE_PROFILES,
        evidence: EVIDENCE,
      },
      rest: {
        method: "PATCH",
        pathTemplate: GRADE_ROUTE,
        access: "write",
        entitlement: "unknown",
        reviewRoute: "blackboard_plan_gradebook_grade_patch",
        readbackComparator: "blackboard_verify_gradebook_grade_patch",
      },
      run: (runtime, input, signal) => applyReviewedGradebookGradePatch(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_verify_gradebook_grade_patch",
      title: "Verify one Blackboard grade change",
      description: "Internal Morrow fresh-read comparator for one reviewed Blackboard grade change. It re-reads the grade and states whether the reviewed score and grade text are saved on it now.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: gradePatchInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      capability: {
        family: "course-read",
        provider: "blackboard",
        sourceExport: `GET ${GRADE_ROUTE}`,
        behavior: READ_BEHAVIOR,
        authority: { scopeClass: "tenant-course", approvalClass: "none", dataClass: "grade" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: COMPARATOR_PROFILES,
        evidence: EVIDENCE,
      },
      rest: {
        method: "GET",
        pathTemplate: GRADE_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => verifyGradebookGradePatch(runtime, input, signal),
    }),
  ],
};
