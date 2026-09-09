import { canonicalJson, isJsonObject, sha256Text, type JsonObject, type SourceCapabilityMetadata } from "@morrow/contracts";
import * as z from "zod/v4";
import type { BlackboardLearnClient } from "../client.js";
import type { BlackboardEffectGrant } from "../effect-grant.js";
import { redactInto, type BlackboardCourseRead, type BlackboardLearnRuntime, type PreparedRoster } from "../runtime.js";
import { BLACKBOARD_ID, BlackboardApiError, withBlackboardDispatchState, type BlackboardDispatchState } from "../types.js";
import { blackboardTool, effectGrantInput, patchInput, scopeInput, type BlackboardOperationModule } from "./definition.js";
import { READ_ANNOTATIONS, READ_BEHAVIOR, READ_PROFILES } from "./course-read.js";
// One field list is pinned on a single-record read the same way everywhere in
// this server, so this module uses that helper rather than a second copy.
import { withFields } from "./gradebook.js";

/**
 * The two Learn versions Morrow asks for a course group route. Anthology pins
 * its published API set to a Learn version, and **no tenant Swagger has been
 * read**, so which of these a given site answers is not settled here and Morrow
 * does not assume either one.
 *
 * Morrow therefore resolves it against the site itself, on every call: it asks
 * `v2` first and falls back to `v1` only when the site answers `404` or `405`,
 * which is that site saying it does not serve the route. Every result records
 * the version that answered, and a site that answers neither gets
 * `blackboard_operation_unavailable` naming both paths. Morrow guesses no third
 * path.
 * https://developer.blackboard.com/portal/displayApi/Learn
 */
const GROUP_API_VERSIONS = ["v2", "v1"] as const;
type GroupApiVersion = (typeof GROUP_API_VERSIONS)[number];

/**
 * The route templates the generated catalog records, written at the version
 * Morrow asks for first. The row is the route, not a claim about which version a
 * site answers; each result states that.
 */
const GROUPS_ROUTE = "/learn/api/public/v2/courses/{course_id}/groups";
const GROUP_ROUTE = `${GROUPS_ROUTE}/{group_id}`;
const GROUP_SETS_ROUTE = `${GROUPS_ROUTE}/sets`;

/**
 * The group membership routes, written at the current version Morrow asks for
 * first. Morrow resolves the collection before it addresses one membership, so
 * a missing version can fall back without treating a missing person as a
 * missing route.
 */
const GROUP_MEMBERS_ROUTE = "/learn/api/public/v2/courses/{course_id}/groups/{group_id}/users";
const GROUP_MEMBERSHIP_ROUTE = `${GROUP_MEMBERS_ROUTE}/{user_id}`;

/** The exact fields every group and group-set read asks for, so no read is open-ended. */
const GROUP_FIELDS = ["id", "name", "description", "availability", "groupSetId"];

/** The exact fields every group membership read asks for. */
const MEMBER_FIELDS = ["id", "groupId", "userId"];

/**
 * Morrow's own bounds on one reviewed group. They are not tenant limits: no
 * tenant Swagger has been read. They exist so a pasted document or a mistyped
 * value is refused here, before review, instead of being sent to a Learn site.
 */
const MAX_NAME = 255;
const MAX_DESCRIPTION = 10_000;

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * One protected learner reference, as `LearnerVault` mints it
 * (packages/gateway-core/src/privacy.ts). Every group membership route addresses
 * a person by one of these and by nothing else, so a caller cannot name a
 * Blackboard account Morrow has not tokenized for this exact course.
 */
const LEARNER_REFERENCE = /^Student A[1-9][0-9]*$/;

/** One short provider value as it may leave Morrow, such as `Yes`. */
const PROVIDER_VALUE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/** The three group fields one reviewed change may set. */
const PATCH_FIELDS = ["name", "description", "availability"] as const;
type PatchField = (typeof PATCH_FIELDS)[number];

/** Where each supported patch field lands in the protected projection. */
const PATCHED_PROTECTED_FIELDS: Record<PatchField, string> = {
  name: "name",
  description: "description",
  availability: "availability.available",
};

/**
 * The provider fields Morrow freezes before a group change and re-checks after
 * it. The group record itself has to come back as the same group, and the three
 * reviewed fields have to come back as the reviewed request, so a site that
 * clears a description while it renames a group fails the readback instead of
 * being reported as verified.
 */
const PROTECTED_FIELDS: readonly (readonly string[])[] = [
  ["id"],
  ["name"],
  ["description"],
  ["availability", "available"],
];

/**
 * What Morrow will not do to a Blackboard group, in the words every group tool
 * states. Deleting a group or a group set is held: Morrow can prove a group has
 * no members, but the public Learn REST API has no route that tells it whether a
 * group still holds group content, a group assignment, or work learners
 * submitted through it, and none that says what deleting a group set does to the
 * groups inside it. Morrow holds no route that restores either, so it sends
 * neither request.
 */
const DELETION_HELD = "Morrow does not delete a Blackboard group or a group set. It can read whether a group has members, but the public Learn REST API gives it no way to tell whether a group still holds group content or work a learner submitted through it, and Morrow holds no route that restores a deleted group.";

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
const learnerReferenceInput = z.string().regex(LEARNER_REFERENCE).max(200);

const groupIdInput = z.string().regex(BLACKBOARD_ID);

const groupScopeInput = scopeInput.extend({ group_id: groupIdInput });
const groupCreateInput = scopeInput.extend({
  name: z.string().min(1).max(MAX_NAME),
  description: z.string().min(1).max(MAX_DESCRIPTION).optional(),
  available: z.enum(["Yes", "No"]),
});
const groupCreateApplyInput = groupCreateInput.extend({
  expected_plan_digest: z.string().regex(SHA256),
  _morrow: z.strictObject({ outer_grant: effectGrantInput }),
});
const groupPatchInput = groupScopeInput.extend({ patch: patchInput });
const groupPatchApplyInput = groupPatchInput.extend({
  expected_plan_digest: z.string().regex(SHA256),
  _morrow: z.strictObject({ outer_grant: effectGrantInput }),
});
const groupMembershipInput = groupScopeInput.extend({ learner_reference: learnerReferenceInput });
const groupMembershipApplyInput = groupMembershipInput.extend({
  expected_plan_digest: z.string().regex(SHA256),
  _morrow: z.strictObject({ outer_grant: effectGrantInput }),
});

type GroupScope = z.output<typeof groupScopeInput>;
type GroupCreateInput = z.output<typeof groupCreateInput>;
type GroupPatchInput = z.output<typeof groupPatchInput>;
type GroupMembershipInput = z.output<typeof groupMembershipInput>;

function groupsPath(version: GroupApiVersion, courseId: string): string {
  return `/learn/api/public/${version}/courses/${encodeURIComponent(courseId)}/groups`;
}

function groupPath(version: GroupApiVersion, courseId: string, groupId: string): string {
  return `${groupsPath(version, courseId)}/${encodeURIComponent(groupId)}`;
}

function groupSetsPath(version: GroupApiVersion, courseId: string): string {
  return `${groupsPath(version, courseId)}/sets`;
}

function groupMembersPath(version: GroupApiVersion, courseId: string, groupId: string): string {
  return `/learn/api/public/${version}/courses/${encodeURIComponent(courseId)}/groups/${encodeURIComponent(groupId)}/users`;
}

function groupMembershipPath(version: GroupApiVersion, courseId: string, groupId: string, userId: string): string {
  return `${groupMembersPath(version, courseId, groupId)}/${encodeURIComponent(userId)}`;
}

/** One Blackboard record identifier Morrow can name a record by, or `null`. */
function exactId(value: unknown): string | null {
  return typeof value === "string" && BLACKBOARD_ID.test(value) ? value : null;
}

/** One short provider value as it may leave Morrow, or `null` when Blackboard reported none. */
function providerValue(value: unknown): string | null {
  return typeof value === "string" && PROVIDER_VALUE.test(value) ? value : null;
}

/** One reviewed text value. Morrow sends the text it was given, with nothing trimmed off it. */
function reviewedText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value || value.length > max || value !== value.trim()
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new BlackboardApiError("blackboard_response_invalid", `The Blackboard ${label} is invalid.`);
  }
  return value;
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

function routeUnavailable(label: string, paths: readonly string[]): BlackboardApiError {
  return new BlackboardApiError(
    "blackboard_operation_unavailable",
    `This Blackboard site did not answer the ${label} at ${paths.join(" or at ")}. Morrow reads and writes course groups at those paths and nowhere else, and it guesses no other path. Ask your Blackboard administrator which group routes this site's Swagger publishes.`,
  );
}

/** One Learn group collection, with the API version that answered it. */
interface ResolvedCollection {
  readonly apiVersion: GroupApiVersion;
  readonly records: readonly JsonObject[];
}

/**
 * Reads one group collection to its end at the first Learn version that answers
 * it, and reports which one that was. A site that answers neither version does
 * not serve the collection, and that is what the caller reports: Morrow never
 * reports a route it could not reach as an empty course.
 */
async function collectVersioned(
  client: BlackboardLearnClient,
  label: string,
  path: (version: GroupApiVersion) => string,
  signal?: AbortSignal,
): Promise<ResolvedCollection> {
  for (const apiVersion of GROUP_API_VERSIONS) {
    try {
      return { apiVersion, records: await client.collect(path(apiVersion), { label, fields: GROUP_FIELDS, signal }) };
    } catch (error) {
      if (!routeMissing(error)) throw error;
    }
  }
  throw routeUnavailable(label, GROUP_API_VERSIONS.map((version) => path(version)));
}

function collectGroups(client: BlackboardLearnClient, courseId: string, signal?: AbortSignal): Promise<ResolvedCollection> {
  return collectVersioned(client, "course group", (version) => groupsPath(version, courseId), signal);
}

function collectGroupSets(client: BlackboardLearnClient, courseId: string, signal?: AbortSignal): Promise<ResolvedCollection> {
  return collectVersioned(client, "course group set", (version) => groupSetsPath(version, courseId), signal);
}

/**
 * Every membership of one group, read to the end or refused. It is also how
 * Morrow resolves the group membership route: a site that does not answer this
 * collection does not serve group memberships, and every membership tool here
 * reports that rather than reading a `404` on one membership as a person who is
 * not in the group.
 *
 * Morrow reads this collection through the same guarded reader as every other
 * Blackboard collection, which requires each record to carry an `id`. Whether a
 * Learn site returns a group membership record with one is not settled by
 * Anthology's public documentation and has not been tested on a live tenant. A
 * site that returns records without one gets `blackboard_response_incomplete`
 * rather than a list Morrow cannot check.
 */
async function collectGroupMembers(
  client: BlackboardLearnClient,
  courseId: string,
  groupId: string,
  signal?: AbortSignal,
): Promise<ResolvedCollection> {
  for (const apiVersion of GROUP_API_VERSIONS) {
    try {
      return {
        apiVersion,
        records: await client.collect(groupMembersPath(apiVersion, courseId, groupId), {
          label: "group membership", fields: MEMBER_FIELDS, signal,
        }),
      };
    } catch (error) {
      if (!routeMissing(error)) throw error;
    }
  }
  throw routeUnavailable(
    "group membership collection",
    GROUP_API_VERSIONS.map((version) => groupMembersPath(version, courseId, groupId)),
  );
}

async function collectGroupMembersAt(
  client: BlackboardLearnClient,
  apiVersion: GroupApiVersion,
  courseId: string,
  groupId: string,
  signal?: AbortSignal,
): Promise<readonly JsonObject[]> {
  const path = groupMembersPath(apiVersion, courseId, groupId);
  try {
    return await client.collect(path, { label: "group membership", fields: MEMBER_FIELDS, signal });
  } catch (error) {
    if (routeMissing(error)) throw routeUnavailable("group membership collection", [path]);
    throw error;
  }
}

/** One group of the selected course, with the API version that answered it. */
interface ResolvedGroup {
  readonly apiVersion: GroupApiVersion;
  readonly record: JsonObject;
}

/**
 * One group of the selected course, by its exact id. A `404` here is either a
 * site that does not serve course groups at that version or a group this course
 * does not hold, and those are different answers to a person. Morrow therefore
 * asks each version in turn, and when neither answers it reads the group
 * collection to tell a missing route from a missing group rather than reporting
 * one as the other. The course binding is the path itself: this record is read
 * under the selected course, through the client that refuses any other origin.
 */
async function readGroup(
  client: BlackboardLearnClient,
  courseId: string,
  groupId: string,
  signal?: AbortSignal,
): Promise<ResolvedGroup> {
  for (const apiVersion of GROUP_API_VERSIONS) {
    let record: JsonObject;
    try {
      record = await client.get(withFields(groupPath(apiVersion, courseId, groupId), GROUP_FIELDS), signal);
    } catch (error) {
      if (routeMissing(error)) continue;
      throw error;
    }
    if (exactId(record.id) !== groupId) {
      throw new BlackboardApiError("blackboard_content_mismatch", "Blackboard returned a different group than the one Morrow asked for.");
    }
    return { apiVersion, record };
  }
  await collectGroups(client, courseId, signal);
  throw new BlackboardApiError("blackboard_content_mismatch", "Blackboard has no group with this id in the selected course.");
}

/**
 * One group as this module returns it. The group name and description are
 * provider text. A group can be named after a person, so they leave through
 * the same privacy boundary as every other Blackboard text.
 */
function safeGroup(record: JsonObject, roster: PreparedRoster): JsonObject {
  const id = exactId(record.id);
  if (!id) throw new BlackboardApiError("blackboard_response_invalid", "Blackboard returned a group with no identifier Morrow can name it by.");
  const output: JsonObject = { id };
  redactInto(output, record, ["name", "description"], roster, "group");
  const available = isJsonObject(record.availability) ? providerValue(record.availability.available) : null;
  if (available) output.availability = { available };
  const groupSetId = exactId(record.groupSetId);
  if (groupSetId) output.groupSetId = groupSetId;
  return output;
}

/**
 * The protected reference for one Blackboard account, from the roster this call
 * just read. A person that roster does not hold exactly once has no reference.
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
 * The Blackboard account one group membership record names. A record that names
 * nobody Morrow can identify is a refusal rather than a member it leaves out: a
 * caller cannot tell a short membership list from a complete one.
 */
function memberAccountId(record: JsonObject, groupId: string): string {
  const userId = exactId(record.userId);
  if (!userId) {
    throw new BlackboardApiError("blackboard_response_invalid", "Blackboard returned a group membership that names no account Morrow can read.");
  }
  const recordGroup = exactId(record.groupId);
  if (recordGroup !== null && recordGroup !== groupId) {
    throw new BlackboardApiError("blackboard_membership_mismatch", "Blackboard returned a membership of a different group than the one Morrow asked for.");
  }
  return userId;
}

/** Every account in one group, in the order Blackboard returned them. */
function memberAccountIds(records: readonly JsonObject[], groupId: string): readonly string[] {
  return records.map((record) => memberAccountId(record, groupId));
}

/** The frozen protected values of one exact group, absent fields omitted. */
function protectedGroup(value: JsonObject): JsonObject {
  const output: JsonObject = {};
  for (const path of PROTECTED_FIELDS) {
    let current: unknown = value;
    for (const segment of path) current = isJsonObject(current) ? current[segment] : undefined;
    if (current !== undefined) output[path.join(".")] = current;
  }
  return output;
}

/** The protected projection an exact provider returns after this exact change. */
function expectedProtectedGroup(frozen: JsonObject, patch: JsonObject): JsonObject {
  const output: JsonObject = { ...frozen };
  for (const field of PATCH_FIELDS) {
    if (!Object.hasOwn(patch, field)) continue;
    const value = patch[field];
    output[PATCHED_PROTECTED_FIELDS[field]] = field === "availability" && isJsonObject(value) ? value.available : value;
  }
  return output;
}

/** Whether one fresh read already carries every reviewed value. */
function groupFieldsMatch(record: JsonObject, patch: JsonObject): boolean {
  const current = protectedGroup(record);
  const expected = expectedProtectedGroup({}, patch);
  return Object.keys(expected).every((key) => (
    Object.hasOwn(current, key) && canonicalJson(current[key]) === canonicalJson(expected[key])
  ));
}

/**
 * A group change sets the group's name, its description, whether it is
 * available, or any combination of those three. Everything else, including the group set
 * it belongs to, its enrolment rules, and the group itself, is refused here, before
 * any request.
 */
function reviewedPatch(value: unknown): JsonObject {
  if (!isJsonObject(value)) {
    throw new BlackboardApiError("blackboard_response_invalid", "The Blackboard group change is invalid.");
  }
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !PATCH_FIELDS.includes(key as PatchField))) {
    throw new BlackboardApiError(
      "blackboard_response_invalid",
      `A Blackboard group change sets the group name, its description, whether it is available, or any combination of those three, and nothing else. ${DELETION_HELD}`,
    );
  }
  const output: JsonObject = {};
  for (const field of PATCH_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    const candidate = value[field];
    if (field === "availability") {
      if (!isJsonObject(candidate) || Object.keys(candidate).some((key) => key !== "available")
        || typeof candidate.available !== "string" || !["Yes", "No"].includes(candidate.available)) {
        throw new BlackboardApiError(
          "blackboard_response_invalid",
          "Morrow sets a Blackboard group to available Yes or No. It sets no other availability value.",
        );
      }
      output[field] = { available: candidate.available };
      continue;
    }
    output[field] = reviewedText(candidate, field === "name" ? "group name" : "group description", field === "name" ? MAX_NAME : MAX_DESCRIPTION);
  }
  return output;
}

/** One new group as a plan freezes it, with every Morrow bound applied. */
interface ReviewedGroup {
  readonly name: string;
  /** `null` for a group Morrow gives no description. */
  readonly description: string | null;
  readonly available: string;
}

function reviewedGroup(input: GroupCreateInput): ReviewedGroup {
  return {
    name: reviewedText(input.name, "group name", MAX_NAME),
    description: input.description === undefined ? null : reviewedText(input.description, "group description", MAX_DESCRIPTION),
    available: input.available,
  };
}

/** The exact request one approved create dispatch sends. */
function groupRequest(group: ReviewedGroup): JsonObject {
  return {
    name: group.name,
    ...(group.description === null ? {} : { description: group.description }),
    availability: { available: group.available },
  };
}

/** The reviewed group as one plan and one dispatch both hash it. */
function frozenGroup(group: ReviewedGroup): JsonObject {
  return { name: group.name, description: group.description, available: group.available };
}

/**
 * Refuses reviewed group text that names a person on this course's roster.
 *
 * Morrow's privacy boundary replaces a roster identity in provider text with a
 * protected reference before that text leaves this server, and the plan a person
 * reviews carries that text. A group named after a learner would therefore be
 * reviewed as a token and sent as a name: what a person read would not be what
 * Blackboard receives. Morrow refuses that group rather than send text nobody
 * reviewed.
 */
function assertReviewable(text: JsonObject, roster: PreparedRoster): void {
  const fields = Object.keys(text);
  const redacted: JsonObject = {};
  redactInto(redacted, text, fields, roster, "group");
  if (fields.every((field) => redacted[field] === text[field])) return;
  throw new BlackboardApiError(
    "blackboard_operation_unavailable",
    "This group names a person enrolled in the selected Blackboard course. Morrow shows a person on this course's roster as a protected reference rather than by name, so the text you would review is not the text Blackboard would receive. Name the group without the person's name, or make the group in Blackboard.",
  );
}

/** The reviewed text of one group change, as the privacy check reads it. */
function patchText(patch: JsonObject): JsonObject {
  const text: JsonObject = {};
  for (const field of ["name", "description"] as const) {
    if (typeof patch[field] === "string") text[field] = patch[field];
  }
  return text;
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
      "Name the person by the protected reference Morrow returned for them in this Blackboard course (for example, Student A1). Morrow does not accept a Blackboard user id here.",
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

function groupCreateEffectTarget(runtime: BlackboardLearnRuntime, input: GroupCreateInput) {
  return runtime.effectTarget({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, "course-group-create", {});
}

function groupPatchEffectTarget(runtime: BlackboardLearnRuntime, input: GroupScope) {
  return runtime.effectTarget({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, "course-group", { groupId: input.group_id });
}

function groupMembershipEffectTarget(runtime: BlackboardLearnRuntime, input: GroupScope, userId: string) {
  return runtime.effectTarget({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, "group-membership", { groupId: input.group_id, userId });
}

/** What the readback after each change proves, in plain words. */
const CREATE_READBACK_DETAIL = "Morrow re-read the group by the id Blackboard returned and compared its name, its description, and whether it is available, against the reviewed plan.";
const PATCH_READBACK_DETAIL = "Morrow re-read the group and compared the group record, its name, its description, and whether it is available, against the reviewed plan.";
const MEMBERSHIP_READBACK_DETAIL = "Morrow re-read the group and every membership of it, and compared the group's own values and the whole list of people in it against the reviewed plan.";

const REVIEWED_FIELDS = "reviewed_fields";
const PROTECTED_STATE = "protected_fields";

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

async function listCourseGroups(
  runtime: BlackboardLearnRuntime,
  input: z.output<typeof scopeInput>,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const read = await runtime.beginCourseRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const groups = await collectGroups(read.client, read.courseId, signal);
  return {
    schema: "morrow.blackboard.course-groups.v1",
    ok: true,
    tenantId: read.tenantId,
    sourceBindingId: read.sourceBindingId,
    courseId: read.courseId,
    apiVersion: groups.apiVersion,
    groups: groups.records.map((record) => safeGroup(record, read.roster)),
    count: groups.records.length,
    deletionHeld: DELETION_HELD,
    status: "api_configured_live_untested",
    diagnostics: read.cost(),
  };
}

async function listCourseGroupSets(
  runtime: BlackboardLearnRuntime,
  input: z.output<typeof scopeInput>,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const read = await runtime.beginCourseRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const sets = await collectGroupSets(read.client, read.courseId, signal);
  return {
    schema: "morrow.blackboard.course-group-sets.v1",
    ok: true,
    tenantId: read.tenantId,
    sourceBindingId: read.sourceBindingId,
    courseId: read.courseId,
    apiVersion: sets.apiVersion,
    groupSets: sets.records.map((record) => safeGroup(record, read.roster)),
    count: sets.records.length,
    deletionHeld: DELETION_HELD,
    status: "api_configured_live_untested",
    diagnostics: read.cost(),
  };
}

async function readCourseGroup(
  runtime: BlackboardLearnRuntime,
  input: GroupScope,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const read = await runtime.beginCourseRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const group = await readGroup(read.client, read.courseId, input.group_id, signal);
  return {
    schema: "morrow.blackboard.course-group.v1",
    ok: true,
    tenantId: read.tenantId,
    sourceBindingId: read.sourceBindingId,
    courseId: read.courseId,
    apiVersion: group.apiVersion,
    groupId: input.group_id,
    group: safeGroup(group.record, read.roster),
    deletionHeld: DELETION_HELD,
    status: "api_configured_live_untested",
    diagnostics: read.cost(),
  };
}

/**
 * Everyone in one group of the selected course, each named by the protected
 * reference the roster read mints for them. A membership Blackboard returns for
 * a person this course's roster does not hold exactly once is a refusal, not a
 * member left out: a caller cannot tell a short list from a complete one.
 */
async function listGroupMembers(
  runtime: BlackboardLearnRuntime,
  input: GroupScope,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const read = await runtime.beginCourseRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const group = await readGroup(read.client, read.courseId, input.group_id, signal);
  const membership = await collectGroupMembers(read.client, read.courseId, input.group_id, signal);
  const members = memberAccountIds(membership.records, input.group_id).map((userId) => ({ learnerToken: exactReference(read, userId) }));
  return {
    schema: "morrow.blackboard.group-members.v1",
    ok: true,
    tenantId: read.tenantId,
    sourceBindingId: read.sourceBindingId,
    courseId: read.courseId,
    apiVersion: membership.apiVersion,
    groupId: input.group_id,
    group: safeGroup(group.record, read.roster),
    members,
    count: members.length,
    status: "api_configured_live_untested",
    diagnostics: read.cost(),
  };
}

/**
 * One digest over the tenant, the course connection, the course, the Learn
 * version that answered, and the exact reviewed group. A create has no earlier
 * record to freeze, so this is the whole precondition.
 */
function createPlanDigest(write: BlackboardCourseRead, apiVersion: GroupApiVersion, group: ReviewedGroup): string {
  return sha256Text(canonicalJson({
    tenantId: write.tenantId,
    sourceBindingId: write.sourceBindingId,
    courseId: write.courseId,
    apiVersion,
    group: frozenGroup(group),
  }));
}

/** One reviewed new group, frozen exactly as it will be sent. */
async function planCourseGroup(
  runtime: BlackboardLearnRuntime,
  input: GroupCreateInput,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const group = reviewedGroup(input);
  runtime.assertEffectTargetFree(groupCreateEffectTarget(runtime, input));
  // A plan exists only to be dispatched, so it carries the write condition. An
  // instructor is refused before review instead of after approving a group
  // Morrow would then refuse to make.
  const write = await runtime.beginCourseWrite({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  assertReviewable({ name: group.name, ...(group.description === null ? {} : { description: group.description }) }, write.roster);
  // The route is resolved before review, so a site that does not serve course
  // groups is named here rather than after a person approves one.
  const groups = await collectGroups(write.client, write.courseId, signal);
  return {
    schema: "morrow.blackboard.course-group.plan.v1",
    ok: true,
    tenantId: write.tenantId,
    sourceBindingId: write.sourceBindingId,
    courseId: write.courseId,
    apiVersion: groups.apiVersion,
    // The exact group one dispatch makes, in full, so whatever reviews this plan
    // reviews what Blackboard receives. The plan digest below covers it, and the
    // dispatch recomputes that digest, so no other group can be made.
    group: frozenGroup(group),
    planDigest: createPlanDigest(write, groups.apiVersion, group),
    reviewRequired: true,
    limits: { groups: 1, members: 0, learnersNamed: 0 },
    deletionHeld: DELETION_HELD,
    readback: REVIEWED_FIELDS,
    readbackDetail: CREATE_READBACK_DETAIL,
    status: "api_configured_live_untested",
    effect_scope: runtime.effectScope({
      tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
    }),
  };
}

/**
 * Compares one fresh group read against the reviewed group, and names the value
 * that did not come back. A description Morrow did not set is read and reported,
 * not compared.
 */
function compareGroup(record: JsonObject, group: ReviewedGroup, dispatchState: BlackboardDispatchState): void {
  const current = protectedGroup(record);
  if (current.name !== group.name) throw mismatch("Blackboard returned a different name for this group.", dispatchState);
  if (group.description !== null && current.description !== group.description) {
    throw mismatch("Blackboard returned a different description for this group.", dispatchState);
  }
  if (current["availability.available"] !== group.available) {
    throw mismatch(`Blackboard did not return this group as available ${group.available}.`, dispatchState);
  }
}

/**
 * Whether one fresh read already carries the reviewed group. It is the same
 * comparison the readback makes, so a comparator and a dispatch can never
 * disagree about one group. Only a mismatch answers `false`; every other failure
 * is raised, because a comparator that swallowed one would report a refusal as a
 * record that does not match.
 */
function savedGroup(record: JsonObject, group: ReviewedGroup): boolean {
  try {
    compareGroup(record, group, "not_sent");
    return true;
  } catch (error) {
    if (error instanceof BlackboardApiError && error.code === "blackboard_content_mismatch") return false;
    throw error;
  }
}

/**
 * The one dispatch for a new group: it sends one create request and then
 * re-reads the group Blackboard named. Everything it can refuse it refuses
 * before that request leaves this process, and the one-use receipt is spent
 * before the first provider request, so two dispatches of one approval cannot
 * both make a group.
 */
async function applyReviewedCourseGroup(
  runtime: BlackboardLearnRuntime,
  input: z.output<typeof groupCreateApplyInput>,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const grant = reservedGrant(input._morrow.outer_grant);
  assertReviewedPlan(runtime, grant, input.expected_plan_digest);
  const group = reviewedGroup(input);
  const dispatch = runtime.claimReservedEffectGrant(grant, groupCreateEffectTarget(runtime, input));
  const write = await runtime.beginCourseWrite({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  assertReviewable({ name: group.name, ...(group.description === null ? {} : { description: group.description }) }, write.roster);
  // The same read resolves the route and records the groups this course already
  // holds, so the dispatch can refuse to report one of them as the group it made.
  const groups = await collectGroups(write.client, write.courseId, signal);
  if (createPlanDigest(write, groups.apiVersion, group) !== input.expected_plan_digest) {
    throw new BlackboardApiError(
      "blackboard_patch_review_required",
      "This request does not describe the Blackboard group that was reviewed. Nothing was created.",
    );
  }
  const existing = groups.records.map((record) => exactId(record.id)).filter((id): id is string => id !== null);
  // Morrow cannot prove a group was not made once the create request has left
  // this process. The marker is set on the line before that request, so every
  // failure from here on is reported as applied_or_unknown, and every refusal
  // raised above this point keeps not_sent.
  let dispatchState: BlackboardDispatchState = "not_sent";
  dispatch.markSent();
  try {
    dispatchState = "applied_or_unknown";
    const created = await write.client.post(groupsPath(groups.apiVersion, write.courseId), groupRequest(group), signal);
    const groupId = created ? exactId(created.id) : null;
    if (!groupId) {
      throw mismatch("Blackboard did not name the group it created (id), so Morrow could not read it back.", dispatchState);
    }
    if (existing.includes(groupId)) {
      throw mismatch("Blackboard named a group that was already in this course before this change.", dispatchState);
    }
    const record = await write.client.get(withFields(groupPath(groups.apiVersion, write.courseId, groupId), GROUP_FIELDS), signal);
    if (exactId(record.id) !== groupId) throw mismatch("Blackboard returned a different group than the one it created.", dispatchState);
    compareGroup(record, group, dispatchState);
    dispatch.markVerified();
    return {
      schema: "morrow.blackboard.course-group.readback.v1",
      ok: true,
      // Morrow's operation journal reads this marker to decide what reached
      // Blackboard. The read payloads keep `status`, which is an evidence label.
      resultState: "applied",
      tenantId: write.tenantId,
      sourceBindingId: write.sourceBindingId,
      courseId: write.courseId,
      apiVersion: groups.apiVersion,
      groupId,
      group: safeGroup(record, write.roster),
      deletionHeld: DELETION_HELD,
      readback: REVIEWED_FIELDS,
      readbackDetail: CREATE_READBACK_DETAIL,
      status: "api_configured_live_untested",
    };
  } catch (error) {
    dispatch.markUncertain();
    throw withBlackboardDispatchState(error, dispatchState);
  }
}

/**
 * The Gateway's fresh-read comparator for one reviewed new group. It holds no id
 * from the dispatch, so it states only whether exactly one group in this course
 * now carries the reviewed values. The proof that Blackboard created that exact
 * record belongs to the dispatch above, which holds the id Blackboard returned.
 *
 * It prepares no roster and reads no course membership, and it carries no
 * `diagnostics` or resolved version, because the Gateway freezes this exact
 * payload when it plans the operation.
 */
async function verifyCourseGroup(
  runtime: BlackboardLearnRuntime,
  input: GroupCreateInput,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const group = reviewedGroup(input);
  const comparator = await runtime.beginComparatorRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const groups = await collectGroups(comparator.client, comparator.courseId, signal);
  const matches = groups.records.filter((record) => savedGroup(record, group));
  const verified = matches.length === 1;
  runtime.recordEffectComparison(groupCreateEffectTarget(runtime, input), verified);
  return {
    schema: "morrow.blackboard.course-group.comparator.v1",
    ok: true,
    tenantId: comparator.tenantId,
    sourceBindingId: comparator.sourceBindingId,
    courseId: comparator.courseId,
    verified,
    readback: REVIEWED_FIELDS,
    status: "api_configured_live_untested",
  };
}

interface FrozenGroupPatch {
  readonly apiVersion: GroupApiVersion;
  readonly record: JsonObject;
  readonly beforeDigest: string;
  readonly planDigest: string;
}

/**
 * One fresh read of the exact group, frozen as the precondition this change is
 * reviewed against. The digest binds the tenant, the course connection, the
 * course, the group, the Learn version that answered, that group's protected
 * values, and the exact reviewed change.
 */
async function freezeGroupPatch(
  write: BlackboardCourseRead,
  groupId: string,
  patch: JsonObject,
  signal?: AbortSignal,
): Promise<FrozenGroupPatch> {
  const group = await readGroup(write.client, write.courseId, groupId, signal);
  const beforeDigest = sha256Text(canonicalJson(protectedGroup(group.record)));
  const planDigest = sha256Text(canonicalJson({
    tenantId: write.tenantId,
    sourceBindingId: write.sourceBindingId,
    courseId: write.courseId,
    groupId,
    apiVersion: group.apiVersion,
    beforeDigest,
    patch,
  }));
  return { apiVersion: group.apiVersion, record: group.record, beforeDigest, planDigest };
}

/** One reviewed change to a group this course already holds. */
async function planCourseGroupPatch(
  runtime: BlackboardLearnRuntime,
  input: GroupPatchInput,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const patch = reviewedPatch(input.patch);
  runtime.assertEffectTargetFree(groupPatchEffectTarget(runtime, input));
  const write = await runtime.beginCourseWrite({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  assertReviewable(patchText(patch), write.roster);
  const frozen = await freezeGroupPatch(write, input.group_id, patch, signal);
  return {
    schema: "morrow.blackboard.course-group-patch.plan.v1",
    ok: true,
    tenantId: write.tenantId,
    sourceBindingId: write.sourceBindingId,
    courseId: write.courseId,
    apiVersion: frozen.apiVersion,
    groupId: input.group_id,
    before: safeGroup(frozen.record, write.roster),
    beforeDigest: frozen.beforeDigest,
    patch,
    planDigest: frozen.planDigest,
    reviewRequired: true,
    limits: { fields: ["name", "description", "availability.available"], groups: 1 },
    deletionHeld: DELETION_HELD,
    readback: PROTECTED_STATE,
    readbackDetail: PATCH_READBACK_DETAIL,
    status: "api_configured_live_untested",
    effect_scope: runtime.effectScope({
      tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
    }),
  };
}

/**
 * The one dispatch for a change to a group: it re-reads the exact group, refuses
 * when anything it froze changed after review, sends one `PATCH`, and reads the
 * group back.
 */
async function applyReviewedCourseGroupPatch(
  runtime: BlackboardLearnRuntime,
  input: z.output<typeof groupPatchApplyInput>,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const grant = reservedGrant(input._morrow.outer_grant);
  assertReviewedPlan(runtime, grant, input.expected_plan_digest);
  const patch = reviewedPatch(input.patch);
  const dispatch = runtime.claimReservedEffectGrant(grant, groupPatchEffectTarget(runtime, input));
  const write = await runtime.beginCourseWrite({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  assertReviewable(patchText(patch), write.roster);
  const frozen = await freezeGroupPatch(write, input.group_id, patch, signal);
  if (frozen.planDigest !== input.expected_plan_digest) {
    // One digest binds the group, its frozen values, and the change, so a group
    // changed after review and a request that names another group both fail
    // here. The refusal names both, because this route cannot tell them apart
    // and must not report the wrong one.
    throw new BlackboardApiError(
      "blackboard_content_mismatch",
      "The Blackboard group Morrow read does not match the reviewed plan. It changed after review, or this request names a different group. The change was not sent.",
    );
  }
  const expected = expectedProtectedGroup(protectedGroup(frozen.record), patch);
  let dispatchState: BlackboardDispatchState = "not_sent";
  dispatch.markSent();
  try {
    dispatchState = "applied_or_unknown";
    await write.client.patch(groupPath(frozen.apiVersion, write.courseId, input.group_id), patch, signal);
    const readback = await write.client.get(withFields(groupPath(frozen.apiVersion, write.courseId, input.group_id), GROUP_FIELDS), signal);
    if (canonicalJson(protectedGroup(readback)) !== canonicalJson(expected)) {
      throw mismatch("Blackboard did not return every reviewed and protected group value after the change.", dispatchState);
    }
    dispatch.markVerified();
    return {
      schema: "morrow.blackboard.course-group-patch.readback.v1",
      ok: true,
      resultState: "applied",
      tenantId: write.tenantId,
      sourceBindingId: write.sourceBindingId,
      courseId: write.courseId,
      apiVersion: frozen.apiVersion,
      groupId: input.group_id,
      group: safeGroup(readback, write.roster),
      deletionHeld: DELETION_HELD,
      readback: PROTECTED_STATE,
      readbackDetail: PATCH_READBACK_DETAIL,
      status: "api_configured_live_untested",
    };
  } catch (error) {
    dispatch.markUncertain();
    throw withBlackboardDispatchState(error, dispatchState);
  }
}

/**
 * The Gateway's fresh-read comparator for one reviewed group change. It holds no
 * frozen snapshot, so it states only whether the reviewed values are saved on
 * that group now. The precondition that catches a group changed after review
 * belongs to the dispatch above.
 */
async function verifyCourseGroupPatch(
  runtime: BlackboardLearnRuntime,
  input: GroupPatchInput,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const patch = reviewedPatch(input.patch);
  const comparator = await runtime.beginComparatorRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const group = await readGroup(comparator.client, comparator.courseId, input.group_id, signal);
  const verified = groupFieldsMatch(group.record, patch);
  runtime.recordEffectComparison(groupPatchEffectTarget(runtime, input), verified);
  return {
    schema: "morrow.blackboard.course-group-patch.comparator.v1",
    ok: true,
    tenantId: comparator.tenantId,
    sourceBindingId: comparator.sourceBindingId,
    courseId: comparator.courseId,
    groupId: input.group_id,
    verified,
    readback: PROTECTED_STATE,
    status: "api_configured_live_untested",
  };
}

/** Which way one reviewed group membership change goes. */
type MembershipAction = "add" | "remove";

interface FrozenGroupMembership {
  readonly apiVersion: GroupApiVersion;
  readonly record: JsonObject;
  readonly members: readonly string[];
  readonly beforeDigest: string;
  readonly planDigest: string;
}

/**
 * One fresh read of the exact group and of everyone in it, frozen as the
 * precondition one membership change is reviewed against.
 *
 * The person has to be enrolled in this course exactly once, so the protected
 * reference names one Blackboard account and one course membership. An add
 * refuses a person who is already in the group, and a removal refuses a person
 * who is not, so neither dispatch sends a request that would change nothing.
 *
 * The digest covers the whole membership list, not only that one person, so any
 * change to who is in this group between the plan and the dispatch is refused
 * before anything is sent.
 */
async function freezeGroupMembership(
  write: BlackboardCourseRead,
  groupId: string,
  userId: string,
  action: MembershipAction,
  signal?: AbortSignal,
): Promise<FrozenGroupMembership> {
  if (!rosterReference(write, userId)) throw new BlackboardApiError("blackboard_membership_mismatch", UNNAMEABLE_PERSON);
  const group = await readGroup(write.client, write.courseId, groupId, signal);
  const membership = await collectGroupMembers(write.client, write.courseId, groupId, signal);
  const members = memberAccountIds(membership.records, groupId);
  const held = members.filter((member) => member === userId).length;
  if (held > 1) {
    throw new BlackboardApiError(
      "blackboard_membership_mismatch",
      "Blackboard returned more than one membership of this group for this person, so Morrow cannot tell which one a change would address.",
    );
  }
  if (action === "add" && held === 1) {
    throw new BlackboardApiError("blackboard_membership_mismatch", "This person is already in the selected Blackboard group.");
  }
  if (action === "remove" && held === 0) {
    throw new BlackboardApiError("blackboard_membership_mismatch", "This person is not in the selected Blackboard group.");
  }
  const beforeDigest = sha256Text(canonicalJson({ group: protectedGroup(group.record), members: [...members].sort() }));
  const planDigest = sha256Text(canonicalJson({
    tenantId: write.tenantId,
    sourceBindingId: write.sourceBindingId,
    courseId: write.courseId,
    groupId,
    userId,
    action,
    apiVersion: membership.apiVersion,
    beforeDigest,
  }));
  return { apiVersion: membership.apiVersion, record: group.record, members, beforeDigest, planDigest };
}

/** The membership list one exact provider returns after this exact change. */
function expectedMembers(frozen: readonly string[], userId: string, action: MembershipAction): readonly string[] {
  return action === "add"
    ? [...frozen, userId].sort()
    : [...frozen.filter((member) => member !== userId)].sort();
}

/** One reviewed group membership change, frozen against a fresh read of that group. */
async function planGroupMembership(
  runtime: BlackboardLearnRuntime,
  input: GroupMembershipInput,
  action: MembershipAction,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const { reference, userId } = reviewedAccount(runtime, input);
  runtime.assertEffectTargetFree(groupMembershipEffectTarget(runtime, input, userId));
  const write = await runtime.beginCourseWrite({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const frozen = await freezeGroupMembership(write, input.group_id, userId, action, signal);
  return {
    schema: action === "add"
      ? "morrow.blackboard.group-membership.plan.v1"
      : "morrow.blackboard.group-membership-removal.plan.v1",
    ok: true,
    tenantId: write.tenantId,
    sourceBindingId: write.sourceBindingId,
    courseId: write.courseId,
    apiVersion: frozen.apiVersion,
    groupId: input.group_id,
    action,
    learnerToken: reference,
    before: {
      group: safeGroup(frozen.record, write.roster),
      members: frozen.members.map((member) => ({ learnerToken: exactReference(write, member) })),
      count: frozen.members.length,
    },
    beforeDigest: frozen.beforeDigest,
    planDigest: frozen.planDigest,
    reviewRequired: true,
    limits: { groups: 1, people: 1 },
    deletionHeld: DELETION_HELD,
    readback: PROTECTED_STATE,
    readbackDetail: MEMBERSHIP_READBACK_DETAIL,
    status: "api_configured_live_untested",
    effect_scope: runtime.effectScope({
      tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
    }),
  };
}

/**
 * The one dispatch for a group membership change: it re-reads the exact group
 * and everyone in it, refuses when anything it froze changed after review, sends
 * one `PUT` or one `DELETE`, and reads the group and its membership back.
 *
 * Everything it can refuse it refuses before that request leaves this process,
 * and the one-use receipt is spent before the first provider request, so two
 * dispatches of one approval cannot both change the group.
 */
async function applyReviewedGroupMembership(
  runtime: BlackboardLearnRuntime,
  input: z.output<typeof groupMembershipApplyInput>,
  action: MembershipAction,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const grant = reservedGrant(input._morrow.outer_grant);
  assertReviewedPlan(runtime, grant, input.expected_plan_digest);
  const { reference, userId } = reviewedAccount(runtime, input);
  const dispatch = runtime.claimReservedEffectGrant(grant, groupMembershipEffectTarget(runtime, input, userId));
  const write = await runtime.beginCourseWrite({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const frozen = await freezeGroupMembership(write, input.group_id, userId, action, signal);
  if (frozen.planDigest !== input.expected_plan_digest) {
    // One digest binds the group, everyone in it, the person, and which way the
    // change goes, so a membership changed after review and a request that names
    // another person or another group all fail here. The refusal names them,
    // because this route cannot tell them apart and must not report the wrong
    // one.
    throw new BlackboardApiError(
      "blackboard_content_mismatch",
      "The Blackboard group Morrow read does not match the reviewed plan. Who is in it changed after review, the group itself changed, or this request names a different person or group. The change was not sent.",
    );
  }
  const expected = expectedMembers(frozen.members, userId, action);
  const frozenGroupValues = canonicalJson(protectedGroup(frozen.record));
  // Morrow cannot prove a change did not land once the request has left this
  // process. The marker is set on the line before that request, so every failure
  // from here on is reported as applied_or_unknown, and every refusal raised
  // above this point keeps not_sent.
  let dispatchState: BlackboardDispatchState = "not_sent";
  dispatch.markSent();
  try {
    dispatchState = "applied_or_unknown";
    const path = groupMembershipPath(frozen.apiVersion, write.courseId, input.group_id, userId);
    // The membership is named in full by the path, so the create request carries
    // no body of its own.
    if (action === "add") await write.client.put(path, {}, signal);
    else await write.client.del(path, signal);
    const group = await readGroup(write.client, write.courseId, input.group_id, signal);
    const members = memberAccountIds(
      await collectGroupMembersAt(write.client, frozen.apiVersion, write.courseId, input.group_id, signal),
      input.group_id,
    );
    if (canonicalJson(protectedGroup(group.record)) !== frozenGroupValues) {
      throw mismatch("Blackboard returned different group values after this membership change.", dispatchState);
    }
    if (canonicalJson([...members].sort()) !== canonicalJson(expected)) {
      throw mismatch(
        action === "add"
          ? "Blackboard did not return this person, and only this person added, in the group after the change."
          : "Blackboard did not return this person, and only this person removed, from the group after the change.",
        dispatchState,
      );
    }
    dispatch.markVerified();
    return {
      schema: action === "add"
        ? "morrow.blackboard.group-membership.readback.v1"
        : "morrow.blackboard.group-membership-removal.readback.v1",
      ok: true,
      resultState: "applied",
      tenantId: write.tenantId,
      sourceBindingId: write.sourceBindingId,
      courseId: write.courseId,
      apiVersion: group.apiVersion,
      groupId: input.group_id,
      action,
      learnerToken: reference,
      group: safeGroup(group.record, write.roster),
      members: members.map((member) => ({ learnerToken: exactReference(write, member) })),
      count: members.length,
      readback: PROTECTED_STATE,
      readbackDetail: MEMBERSHIP_READBACK_DETAIL,
      status: "api_configured_live_untested",
    };
  } catch (error) {
    dispatch.markUncertain();
    throw withBlackboardDispatchState(error, dispatchState);
  }
}

/**
 * The Gateway's fresh-read comparator for one reviewed group membership change.
 * It holds no frozen snapshot, so it states only whether this person is in the
 * group now, which is what the reviewed change was for. The precondition that
 * catches a membership changed after review belongs to the dispatch above.
 *
 * It prepares no roster and reads no course membership list: the reference it is
 * given was already resolved inside this server, and this route returns one
 * boolean and the identifiers the Gateway already holds. It carries no
 * `diagnostics` either, because the Gateway freezes this exact payload when it
 * plans the operation.
 */
async function verifyGroupMembership(
  runtime: BlackboardLearnRuntime,
  input: GroupMembershipInput,
  action: MembershipAction,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const { reference, userId } = reviewedAccount(runtime, input);
  const comparator = await runtime.beginComparatorRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const membership = await collectGroupMembers(comparator.client, comparator.courseId, input.group_id, signal);
  const members = memberAccountIds(membership.records, input.group_id);
  const held = members.filter((member) => member === userId).length;
  const verified = action === "add" ? held === 1 : held === 0;
  runtime.recordEffectComparison(groupMembershipEffectTarget(runtime, input, userId), verified);
  return {
    schema: action === "add"
      ? "morrow.blackboard.group-membership.comparator.v1"
      : "morrow.blackboard.group-membership-removal.comparator.v1",
    ok: true,
    tenantId: comparator.tenantId,
    sourceBindingId: comparator.sourceBindingId,
    courseId: comparator.courseId,
    groupId: input.group_id,
    learnerToken: reference,
    verified,
    readback: PROTECTED_STATE,
    status: "api_configured_live_untested",
  };
}

function membershipCapability(action: MembershipAction, method: "PUT" | "DELETE"): SourceCapabilityMetadata {
  return {
    family: action === "add" ? "group-membership-add" : "group-membership-remove",
    provider: "blackboard",
    sourceExport: `${method} ${GROUP_MEMBERSHIP_ROUTE}`,
    behavior: {
      readOnly: false,
      mutating: true,
      // Taking a person out of a group can take their access to that group's
      // content and to work the group shares with it. Morrow can put them back
      // through the route beside this one, and it holds no route that restores
      // anything else.
      destructive: action === "remove",
      irreversible: false,
      supportsDryRun: false, supportsReadback: true, supportsUndo: false, supportsBatch: false,
      requiresBrowser: false, requiresLiveCanvas: false,
    },
    authority: { scopeClass: "tenant-course", approvalClass: "standard", dataClass: "learner" },
    route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
    profiles: WRITE_PROFILES,
    evidence: EVIDENCE,
  };
}

/**
 * Blackboard course groups, group sets, and who is in a group. Four reads list
 * the groups and the group sets of the selected course, read one group, and name
 * everyone in one group. Four reviewed changes make one group, change one
 * group's name, description, or availability, and put one person into a group or
 * take one person out of it.
 *
 * Every person leaves this server as a protected reference from the learner
 * vault, and every membership route accepts a person only as one of those
 * references, so a caller cannot address a Blackboard account Morrow has not
 * already tokenized for this exact course, exactly as the course membership
 * routes do.
 *
 * The Learn version is resolved against the site rather than assumed. Anthology
 * pins its published API set to a Learn version and no tenant Swagger has been
 * read here, so every group read asks `v2` first and falls back to `v1` only
 * when the site answers `404` or `405`. Each result records which one answered,
 * and a site that answers neither is reported as
 * `blackboard_operation_unavailable` naming both paths. Group memberships are read and written at `v1` and at no other version:
 * a `404` on a version Morrow guessed cannot be told apart from a person who is
 * not in the group. Which version a given Learn site answers is live-unverified.
 *
 * Deleting a group and deleting a group set are held. Morrow can read whether a
 * group has members, but the public Learn REST API gives it no route that says
 * whether a group still holds group content or work a learner submitted through
 * it, and none that says what deleting a group set does to the groups inside it.
 * Morrow holds no route that restores either, so this module sends neither
 * request and every group tool states that.
 *
 * A group named after a person on the course roster is refused before review:
 * Morrow shows a roster identity as a protected reference, so the text a person
 * would approve would not be the text Blackboard receives.
 *
 * A change here is three separate routes, as every Morrow provider change is:
 * the plan an instructor reviews, the dispatch the Gateway makes once against a
 * signed one-use effect grant, and the fresh-read comparator. None of the four
 * changes is reachable yet: Morrow's Gateway has no public plan tool for a
 * Blackboard group, so nothing can plan, approve, or dispatch one.
 * docs/implementation/BLACKBOARD-REST-SCOPE.md records this.
 */
export const blackboardGroupsModule: BlackboardOperationModule = {
  id: "groups",
  tools: [
    blackboardTool({
      name: "blackboard_list_course_groups",
      title: "List Blackboard course groups",
      description: `List the groups of one selected Blackboard Learn course: what each one is called, its description, whether it is available, and the group set it belongs to. Learner identities in a group name or description are replaced with protected references before output. The result records which Learn version answered. ${DELETION_HELD}`,
      private: false,
      gatewayDispatchOnly: false,
      inputSchema: scopeInput,
      annotations: READ_ANNOTATIONS,
      capability: readCapability(`GET ${GROUPS_ROUTE}`, "course"),
      rest: {
        method: "GET",
        pathTemplate: GROUPS_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => listCourseGroups(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_list_course_group_sets",
      title: "List Blackboard course group sets",
      description: `List the group sets of one selected Blackboard Learn course: what each set is called, its description, and whether it is available. A group set is the collection a course's groups are made in. Learner identities are replaced with protected references before output. The result records which Learn version answered. ${DELETION_HELD}`,
      private: false,
      gatewayDispatchOnly: false,
      inputSchema: scopeInput,
      annotations: READ_ANNOTATIONS,
      capability: readCapability(`GET ${GROUP_SETS_ROUTE}`, "course"),
      rest: {
        method: "GET",
        pathTemplate: GROUP_SETS_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => listCourseGroupSets(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_read_course_group",
      title: "Read one Blackboard course group",
      description: `Read one group of the selected Blackboard Learn course: what it is called, its description, whether it is available, and the group set it belongs to. Find these with blackboard_list_course_groups. Learner identities are replaced with protected references before output. ${DELETION_HELD}`,
      private: false,
      gatewayDispatchOnly: false,
      inputSchema: groupScopeInput,
      annotations: READ_ANNOTATIONS,
      capability: readCapability(`GET ${GROUP_ROUTE}`, "course"),
      rest: {
        method: "GET",
        pathTemplate: GROUP_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => readCourseGroup(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_list_group_members",
      title: "List the people in one Blackboard group",
      description: "List everyone in one group of the selected Blackboard Learn course. Each person is named by the protected reference the Blackboard roster read returns for them; no name and no contact detail leaves this server. A membership Blackboard returns for someone this course's roster does not hold is refused rather than left out, so a short list is never reported as a complete one.",
      private: false,
      gatewayDispatchOnly: false,
      inputSchema: groupScopeInput,
      annotations: READ_ANNOTATIONS,
      capability: readCapability(`GET ${GROUP_MEMBERS_ROUTE}`, "learner"),
      rest: {
        method: "GET",
        pathTemplate: GROUP_MEMBERS_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => listGroupMembers(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_plan_course_group",
      title: "Plan one new Blackboard course group",
      description: `Prepare one new group in the selected Blackboard Learn course for Morrow review: what it is called, its description, and whether it is available. The plan carries the exact group that will be made, and one approved plan makes it once. A group named after a person enrolled in the course is refused. This tool creates nothing. ${DELETION_HELD}`,
      private: true,
      gatewayDispatchOnly: false,
      inputSchema: groupCreateInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: {
        family: "group-create",
        provider: "blackboard",
        sourceExport: `POST ${GROUPS_ROUTE}`,
        behavior: {
          // This tool creates nothing. The dispatch route below is the one that
          // sends the create request.
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
        pathTemplate: GROUPS_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => planCourseGroup(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_apply_reviewed_course_group",
      title: "Create one reserved Blackboard course group",
      description: "Internal Morrow dispatch route. This request requires an exact signed Gateway effect grant.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: groupCreateApplyInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: {
        family: "group-create",
        provider: "blackboard",
        sourceExport: `POST ${GROUPS_ROUTE}`,
        behavior: {
          // Morrow holds no route that deletes a group, so a group it made stays
          // until a person removes it in Blackboard.
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
        method: "POST",
        pathTemplate: GROUPS_ROUTE,
        access: "write",
        entitlement: "unknown",
        reviewRoute: "blackboard_plan_course_group",
        readbackComparator: "blackboard_verify_course_group",
      },
      run: (runtime, input, signal) => applyReviewedCourseGroup(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_verify_course_group",
      title: "Verify one new Blackboard course group",
      description: "Internal Morrow fresh-read comparator for one reviewed new Blackboard course group. It re-reads the course's groups and states whether exactly one of them carries the reviewed values.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: groupCreateInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      capability: {
        family: "course-read",
        provider: "blackboard",
        sourceExport: `GET ${GROUPS_ROUTE}`,
        behavior: READ_BEHAVIOR,
        authority: { scopeClass: "tenant-course", approvalClass: "none", dataClass: "course" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: COMPARATOR_PROFILES,
        evidence: EVIDENCE,
      },
      rest: {
        method: "GET",
        pathTemplate: GROUPS_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => verifyCourseGroup(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_plan_course_group_patch",
      title: "Plan one Blackboard course group change",
      description: `Prepare one change to a Blackboard Learn group's name, its description, whether it is available, or any combination of those three, for Morrow review. This tool does not send a Blackboard PATCH request, and it never adds a person to a group or removes one. ${DELETION_HELD}`,
      private: true,
      gatewayDispatchOnly: false,
      inputSchema: groupPatchInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: {
        family: "group-update",
        provider: "blackboard",
        sourceExport: `PATCH ${GROUP_ROUTE}`,
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
        pathTemplate: GROUP_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => planCourseGroupPatch(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_apply_reviewed_course_group_patch",
      title: "Apply one reserved Blackboard course group change",
      description: "Internal Morrow dispatch route. This request requires an exact signed Gateway effect grant.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: groupPatchApplyInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: {
        family: "group-update",
        provider: "blackboard",
        sourceExport: `PATCH ${GROUP_ROUTE}`,
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
        pathTemplate: GROUP_ROUTE,
        access: "write",
        entitlement: "unknown",
        reviewRoute: "blackboard_plan_course_group_patch",
        readbackComparator: "blackboard_verify_course_group_patch",
      },
      run: (runtime, input, signal) => applyReviewedCourseGroupPatch(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_verify_course_group_patch",
      title: "Verify one Blackboard course group change",
      description: "Internal Morrow fresh-read comparator for one reviewed Blackboard course group change. It re-reads the group and states whether the reviewed values are saved on it now.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: groupPatchInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      capability: {
        family: "course-read",
        provider: "blackboard",
        sourceExport: `GET ${GROUP_ROUTE}`,
        behavior: READ_BEHAVIOR,
        authority: { scopeClass: "tenant-course", approvalClass: "none", dataClass: "course" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: COMPARATOR_PROFILES,
        evidence: EVIDENCE,
      },
      rest: {
        method: "GET",
        pathTemplate: GROUP_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => verifyCourseGroupPatch(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_plan_group_membership",
      title: "Plan putting one person into a Blackboard group",
      description: "Prepare putting one person into one group of the selected Blackboard Learn course, for Morrow review. Name the person by the protected reference the Blackboard roster read returned for them (for example, Student A1); this tool does not accept a Blackboard user id. It refuses a person who is already in the group, and it sends no Blackboard request.",
      private: true,
      gatewayDispatchOnly: false,
      inputSchema: groupMembershipInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: {
        ...membershipCapability("add", "PUT"),
        behavior: {
          readOnly: true, mutating: false, destructive: false, irreversible: false,
          supportsDryRun: false, supportsReadback: true, supportsUndo: false, supportsBatch: false,
          requiresBrowser: false, requiresLiveCanvas: false,
        },
      },
      rest: {
        method: "GET",
        pathTemplate: GROUP_MEMBERS_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => planGroupMembership(runtime, input, "add", signal),
    }),
    blackboardTool({
      name: "blackboard_apply_reviewed_group_membership",
      title: "Apply one reserved Blackboard group membership",
      description: "Internal Morrow dispatch route. This request requires an exact signed Gateway effect grant.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: groupMembershipApplyInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: membershipCapability("add", "PUT"),
      rest: {
        method: "PUT",
        pathTemplate: GROUP_MEMBERSHIP_ROUTE,
        access: "write",
        entitlement: "unknown",
        reviewRoute: "blackboard_plan_group_membership",
        readbackComparator: "blackboard_verify_group_membership",
      },
      run: (runtime, input, signal) => applyReviewedGroupMembership(runtime, input, "add", signal),
    }),
    blackboardTool({
      name: "blackboard_verify_group_membership",
      title: "Verify one Blackboard group membership",
      description: "Internal Morrow fresh-read comparator for one reviewed Blackboard group membership. It re-reads everyone in the group and states whether this person is in it now.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: groupMembershipInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      capability: {
        family: "course-read",
        provider: "blackboard",
        sourceExport: `GET ${GROUP_MEMBERS_ROUTE}`,
        behavior: READ_BEHAVIOR,
        authority: { scopeClass: "tenant-course", approvalClass: "none", dataClass: "learner" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: COMPARATOR_PROFILES,
        evidence: EVIDENCE,
      },
      rest: {
        method: "GET",
        pathTemplate: GROUP_MEMBERS_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => verifyGroupMembership(runtime, input, "add", signal),
    }),
    blackboardTool({
      name: "blackboard_plan_group_membership_removal",
      title: "Plan taking one person out of a Blackboard group",
      description: "Prepare taking one person out of one group of the selected Blackboard Learn course, for Morrow review. Name the person by the protected reference the Blackboard roster read returned for them (for example, Student A1); this tool does not accept a Blackboard user id. Taking a person out of a group can take their access to that group's content and to work the group shares. It refuses a person who is not in the group, it does not remove anyone from the course, and it sends no Blackboard request.",
      private: true,
      gatewayDispatchOnly: false,
      inputSchema: groupMembershipInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: {
        ...membershipCapability("remove", "DELETE"),
        behavior: {
          readOnly: true, mutating: false, destructive: false, irreversible: false,
          supportsDryRun: false, supportsReadback: true, supportsUndo: false, supportsBatch: false,
          requiresBrowser: false, requiresLiveCanvas: false,
        },
      },
      rest: {
        method: "GET",
        pathTemplate: GROUP_MEMBERS_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => planGroupMembership(runtime, input, "remove", signal),
    }),
    blackboardTool({
      name: "blackboard_apply_reviewed_group_membership_removal",
      title: "Apply one reserved Blackboard group membership removal",
      description: "Internal Morrow dispatch route. This request requires an exact signed Gateway effect grant.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: groupMembershipApplyInput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      capability: membershipCapability("remove", "DELETE"),
      rest: {
        method: "DELETE",
        pathTemplate: GROUP_MEMBERSHIP_ROUTE,
        access: "write",
        entitlement: "unknown",
        reviewRoute: "blackboard_plan_group_membership_removal",
        readbackComparator: "blackboard_verify_group_membership_removal",
      },
      run: (runtime, input, signal) => applyReviewedGroupMembership(runtime, input, "remove", signal),
    }),
    blackboardTool({
      name: "blackboard_verify_group_membership_removal",
      title: "Verify one Blackboard group membership removal",
      description: "Internal Morrow fresh-read comparator for one reviewed Blackboard group membership removal. It re-reads everyone in the group and states whether this person is out of it now.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: groupMembershipInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      capability: {
        family: "course-read",
        provider: "blackboard",
        sourceExport: `GET ${GROUP_MEMBERS_ROUTE}`,
        behavior: READ_BEHAVIOR,
        authority: { scopeClass: "tenant-course", approvalClass: "none", dataClass: "learner" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: COMPARATOR_PROFILES,
        evidence: EVIDENCE,
      },
      rest: {
        method: "GET",
        pathTemplate: GROUP_MEMBERS_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => verifyGroupMembership(runtime, input, "remove", signal),
    }),
  ],
};
