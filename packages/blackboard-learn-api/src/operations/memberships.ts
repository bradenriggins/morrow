import { canonicalJson, isJsonObject, sha256Text, type JsonObject, type SourceCapabilityMetadata } from "@morrow/contracts";
import * as z from "zod/v4";
import type { BlackboardEffectGrant } from "../effect-grant.js";
import type { BlackboardCourseRead, BlackboardLearnRuntime } from "../runtime.js";
import { BlackboardApiError, withBlackboardDispatchState, type BlackboardDispatchState } from "../types.js";
import { blackboardTool, effectGrantInput, patchInput, scopeInput, type BlackboardOperationModule } from "./definition.js";
import { READ_ANNOTATIONS, READ_BEHAVIOR, READ_PROFILES } from "./course-read.js";

const MEMBERSHIPS_ROUTE = "/learn/api/public/v1/courses/{course_id}/users";
const MEMBERSHIP_ROUTE = `${MEMBERSHIPS_ROUTE}/{user_id}`;
const ACCOUNT_ROUTE = "/learn/api/public/v1/users/{principal_id}";

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * One protected learner reference, as `LearnerVault` mints it
 * (packages/gateway-core/src/privacy.ts). Every route here addresses a person by
 * one of these and by nothing else, so a caller cannot name a Blackboard account
 * Morrow has not tokenized for this exact course.
 */
const LEARNER_REFERENCE = /^Student A[1-9][0-9]*$/;

/**
 * One Blackboard course role id, such as `Instructor`, `Student`, or a role an
 * administrator defined for this tenant. Course roles are tenant-defined and no
 * tenant has been read, so Morrow checks the shape of the value and nothing
 * about its meaning: a role this site does not define is refused by Blackboard,
 * and the readback below then reports the change as unverified.
 */
const COURSE_ROLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** One short provider value as it may leave Morrow, such as `Student` or `Yes`. */
const PROVIDER_VALUE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/** The two membership fields one reviewed change may set. */
const PATCH_FIELDS = ["courseRoleId", "availability"] as const;
type PatchField = (typeof PATCH_FIELDS)[number];

/** Where each supported patch field lands in the protected projection. */
const PATCHED_PROTECTED_FIELDS: Record<PatchField, string> = {
  courseRoleId: "courseRoleId",
  availability: "availability.available",
};

/**
 * The provider fields Morrow freezes before a membership PATCH and re-checks
 * after it. The person, the course, and the membership record itself have to
 * come back unchanged, and the two changed fields have to come back as the
 * reviewed request, so a provider that moves a membership while it applies a
 * role change fails the readback instead of being reported as verified.
 */
const PROTECTED_FIELDS: readonly (readonly string[])[] = [
  ["id"],
  ["userId"],
  ["courseId"],
  ["courseRoleId"],
  ["availability", "available"],
];

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

const membershipScopeInput = scopeInput.extend({ learner_reference: learnerReferenceInput });
const membershipPatchInput = membershipScopeInput.extend({ patch: patchInput });
const membershipApplyInput = membershipPatchInput.extend({
  expected_plan_digest: z.string().regex(SHA256),
  _morrow: z.strictObject({ outer_grant: effectGrantInput }),
});

type MembershipScope = z.output<typeof membershipScopeInput>;
type MembershipPatch = z.output<typeof membershipPatchInput>;

function membershipsPath(courseId: string): string {
  return `/learn/api/public/v1/courses/${encodeURIComponent(courseId)}/users`;
}

function membershipPath(courseId: string, userId: string): string {
  return `${membershipsPath(courseId)}/${encodeURIComponent(userId)}`;
}

function accountPath(principalId: string): string {
  return `/learn/api/public/v1/users/${encodeURIComponent(principalId)}`;
}

/**
 * The reference a request names a person by. A Blackboard user id is refused
 * here, before any request, so a caller cannot address a person through this
 * server that Morrow has not already tokenized for this course.
 */
function reviewedReference(value: string): string {
  if (!LEARNER_REFERENCE.test(value)) {
    throw new BlackboardApiError(
      "blackboard_scope_binding_required",
      "Name the person by the protected reference Morrow returned for them in this Blackboard course (for example, Student A1). Morrow does not accept a Blackboard user id here.",
    );
  }
  return value;
}

/**
 * One membership value as it may leave Morrow. A field Blackboard did not
 * report is `Unknown`, which is what the roster read already states for these
 * same two fields. A value Blackboard did report that Morrow cannot state as one
 * exact value is neither: it refuses the read, so a value Morrow could not read
 * never leaves as "Unknown".
 */
function providerValue(value: unknown, label: string): string {
  if (value === undefined || value === null) return "Unknown";
  if (typeof value !== "string" || !PROVIDER_VALUE.test(value)) {
    throw new BlackboardApiError("blackboard_response_invalid", `Blackboard returned a ${label} Morrow cannot state as one exact value.`);
  }
  return value;
}

function availabilityOf(record: JsonObject): unknown {
  return isJsonObject(record.availability) ? record.availability.available : undefined;
}

/**
 * One course membership as this module returns it: the person as a protected
 * reference, their course role, and whether the membership is available. The
 * Blackboard account id, the name, and the contact details stay in this server.
 */
function safeMembership(record: JsonObject, learnerToken: string): JsonObject {
  return {
    learnerToken,
    courseRoleId: providerValue(record.courseRoleId, "course role"),
    availability: providerValue(availabilityOf(record), "membership availability"),
  };
}

/** The frozen protected values of one exact membership, absent fields omitted. */
function protectedMembership(value: JsonObject): JsonObject {
  const output: JsonObject = {};
  for (const path of PROTECTED_FIELDS) {
    let current: unknown = value;
    for (const segment of path) current = isJsonObject(current) ? current[segment] : undefined;
    if (current !== undefined) output[path.join(".")] = current;
  }
  return output;
}

/** The protected projection an exact provider returns after this exact change. */
function expectedProtectedMembership(frozen: JsonObject, patch: JsonObject): JsonObject {
  const output: JsonObject = { ...frozen };
  for (const field of PATCH_FIELDS) {
    if (!Object.hasOwn(patch, field)) continue;
    const value = patch[field];
    output[PATCHED_PROTECTED_FIELDS[field]] = field === "availability" && isJsonObject(value) ? value.available : value;
  }
  return output;
}

/** Whether one fresh read already carries every reviewed value. */
function membershipFieldsMatch(record: JsonObject, patch: JsonObject): boolean {
  const current = protectedMembership(record);
  const expected = expectedProtectedMembership({}, patch);
  return Object.keys(expected).every((key) => (
    Object.hasOwn(current, key) && canonicalJson(current[key]) === canonicalJson(expected[key])
  ));
}

/**
 * A membership change sets a course role, availability, or both. Everything
 * else, including the person, the course, the membership record, and the enrolment itself,
 * is refused here, before any request.
 */
function reviewedPatch(value: unknown): JsonObject {
  if (!isJsonObject(value)) {
    throw new BlackboardApiError("blackboard_response_invalid", "The Blackboard membership change is invalid.");
  }
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !PATCH_FIELDS.includes(key as PatchField))) {
    throw new BlackboardApiError(
      "blackboard_response_invalid",
      "A Blackboard membership change sets the course role, availability, or both, and nothing else.",
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
          "Morrow sets a Blackboard course membership to available Yes or No. It sets no other availability value.",
        );
      }
      output[field] = { available: candidate.available };
      continue;
    }
    if (typeof candidate !== "string" || !COURSE_ROLE_ID.test(candidate)) {
      throw new BlackboardApiError("blackboard_response_invalid", "The Blackboard course role id is invalid.");
    }
    output[field] = candidate;
  }
  return output;
}

/**
 * The Blackboard account one request names, resolved before anything is read.
 * The reference has to be one this server minted for this exact course, so a
 * request Morrow cannot honour costs the tenant no request at all.
 */
function reviewedAccount(
  runtime: BlackboardLearnRuntime,
  input: { tenant_id: string; source_binding_id: string; course_id: string; learner_reference: string },
): { readonly reference: string; readonly userId: string } {
  const reference = reviewedReference(input.learner_reference);
  return {
    reference,
    userId: runtime.learnerAccountId({
      tenantId: input.tenant_id,
      sourceBindingId: input.source_binding_id,
      courseId: input.course_id,
      reference,
    }),
  };
}

/**
 * The one course membership one Blackboard account holds in this course. That
 * account has to hold exactly one membership in the roster this call just read,
 * and the membership itself is then read again from the exact route a change
 * would use. More than one membership for one person is a refusal: Morrow could
 * not say which one a change would address.
 */
async function membershipFor(
  read: BlackboardCourseRead,
  userId: string,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const enrolled = read.roster.members.filter((member) => member.identity.id === userId);
  if (enrolled.length === 0) {
    throw new BlackboardApiError(
      "blackboard_membership_mismatch",
      "Blackboard did not return a membership for this person in the selected course.",
    );
  }
  if (enrolled.length > 1) {
    throw new BlackboardApiError(
      "blackboard_membership_mismatch",
      "Blackboard returned more than one membership for this person in the selected course, so Morrow cannot tell which one a change would address.",
    );
  }
  const record = await read.client.get(membershipPath(read.courseId, userId), signal);
  if (record.courseId !== read.courseId || record.userId !== userId) {
    throw new BlackboardApiError(
      "blackboard_membership_mismatch",
      "Blackboard returned a different course membership than the one Morrow asked for.",
    );
  }
  return record;
}

interface FrozenMembershipPlan {
  readonly record: JsonObject;
  readonly beforeDigest: string;
  readonly planDigest: string;
}

/**
 * One fresh read of the exact membership, frozen as the precondition this change
 * is reviewed against. The digest binds the tenant, the course connection, the
 * course, the Blackboard account the reference resolved to, that membership's
 * protected values, and the exact reviewed change.
 */
async function freezeMembershipPlan(
  write: BlackboardCourseRead,
  userId: string,
  patch: JsonObject,
  signal?: AbortSignal,
): Promise<FrozenMembershipPlan> {
  const record = await membershipFor(write, userId, signal);
  const beforeDigest = sha256Text(canonicalJson(protectedMembership(record)));
  const planDigest = sha256Text(canonicalJson({
    tenantId: write.tenantId,
    sourceBindingId: write.sourceBindingId,
    courseId: write.courseId,
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

function membershipEffectTarget(runtime: BlackboardLearnRuntime, input: MembershipScope, userId: string) {
  return runtime.effectTarget({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, "course-membership", { userId });
}

/** What the readback after a membership change proves, in plain words. */
const READBACK_DETAIL = "Morrow re-read the membership and compared the membership record, the account, the course, the course role, and availability against the reviewed plan.";

const READBACK_STATE = "protected_fields";

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

/** One person's membership of the selected course, named by a protected reference. */
async function readCourseMembership(
  runtime: BlackboardLearnRuntime,
  input: MembershipScope,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const { reference, userId } = reviewedAccount(runtime, input);
  const read = await runtime.beginCourseRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const record = await membershipFor(read, userId, signal);
  return {
    schema: "morrow.blackboard.course-membership.v1",
    ok: true,
    tenantId: read.tenantId,
    sourceBindingId: read.sourceBindingId,
    courseId: read.courseId,
    membership: safeMembership(record, reference),
    status: "api_configured_live_untested",
    diagnostics: read.cost(),
  };
}

/**
 * The Learn account this connection's server credential acts as, read from
 * Blackboard's own account route. It reads the configured integration principal
 * and no other account, and it returns that account's id and availability only:
 * the name and the contact details Blackboard holds for it stay in this server.
 */
async function readIntegrationAccount(
  runtime: BlackboardLearnRuntime,
  input: z.output<typeof scopeInput>,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const read = await runtime.beginCourseRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const record = await read.client.get(accountPath(read.principalId), signal);
  if (record.id !== read.principalId) {
    throw new BlackboardApiError("blackboard_account_mismatch", "Blackboard did not return the configured integration account.");
  }
  return {
    schema: "morrow.blackboard.integration-account.v1",
    ok: true,
    tenantId: read.tenantId,
    sourceBindingId: read.sourceBindingId,
    courseId: read.courseId,
    account: { id: read.principalId, availability: providerValue(availabilityOf(record), "account availability") },
    status: "api_configured_live_untested",
    diagnostics: read.cost(),
  };
}

/** One reviewed membership change, frozen against a fresh read of that exact membership. */
async function planMembershipPatch(
  runtime: BlackboardLearnRuntime,
  input: MembershipPatch,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const patch = reviewedPatch(input.patch);
  const { reference, userId } = reviewedAccount(runtime, input);
  runtime.assertEffectTargetFree(membershipEffectTarget(runtime, input, userId));
  // A plan exists only to be dispatched, so it carries the write condition. An
  // instructor is refused before review instead of after approving a change
  // Morrow would then refuse to send.
  const write = await runtime.beginCourseWrite({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const frozen = await freezeMembershipPlan(write, userId, patch, signal);
  return {
    schema: "morrow.blackboard.membership-patch.plan.v1",
    ok: true,
    tenantId: write.tenantId,
    sourceBindingId: write.sourceBindingId,
    courseId: write.courseId,
    before: safeMembership(frozen.record, reference),
    beforeDigest: frozen.beforeDigest,
    patch,
    planDigest: frozen.planDigest,
    reviewRequired: true,
    limits: { fields: ["courseRoleId", "availability.available"], memberships: 1 },
    readback: READBACK_STATE,
    readbackDetail: READBACK_DETAIL,
    status: "api_configured_live_untested",
    effect_scope: runtime.effectScope({
      tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
    }),
  };
}

/**
 * The one dispatch: it re-reads the exact membership, refuses when anything it
 * froze changed after review, sends one PATCH, and reads the membership back.
 * Everything it can refuse it refuses before the PATCH leaves this process, and
 * the one-use receipt is spent before the first provider request, so two
 * dispatches of one approval cannot both pass the precondition and write.
 */
async function applyReviewedMembershipPatch(
  runtime: BlackboardLearnRuntime,
  input: z.output<typeof membershipApplyInput>,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const grant = reservedGrant(input._morrow.outer_grant);
  runtime.assertReservedEffectGrant(grant);
  if (grant.planDigest !== input.expected_plan_digest) {
    throw new BlackboardApiError("blackboard_patch_review_required", "The Blackboard effect grant does not match this exact reviewed plan.");
  }
  const patch = reviewedPatch(input.patch);
  const { reference, userId } = reviewedAccount(runtime, input);
  const dispatch = runtime.claimReservedEffectGrant(grant, membershipEffectTarget(runtime, input, userId));
  const write = await runtime.beginCourseWrite({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const frozen = await freezeMembershipPlan(write, userId, patch, signal);
  if (frozen.planDigest !== input.expected_plan_digest) {
    // One digest binds the person, the frozen membership, and the change, so a
    // membership changed after review and a request that names another person
    // both fail here. The refusal names both, because this route cannot tell
    // them apart and must not report the wrong one.
    throw new BlackboardApiError(
      "blackboard_content_mismatch",
      "The Blackboard membership Morrow read does not match the reviewed plan. It changed after review, or this request names a different person. The change was not sent.",
    );
  }
  const expected = expectedProtectedMembership(protectedMembership(frozen.record), patch);
  // Morrow cannot prove a change did not land once the PATCH request has left
  // this process. The marker is set on the line before that request, so every
  // failure from here on is reported as applied_or_unknown, and every refusal
  // raised above this point keeps not_sent.
  let dispatchState: BlackboardDispatchState = "not_sent";
  dispatch.markSent();
  try {
    dispatchState = "applied_or_unknown";
    await write.client.patch(membershipPath(write.courseId, userId), patch, signal);
    const readback = await write.client.get(membershipPath(write.courseId, userId), signal);
    if (canonicalJson(protectedMembership(readback)) !== canonicalJson(expected)) {
      throw new BlackboardApiError(
        "blackboard_content_mismatch",
        "Blackboard did not return every reviewed and protected membership value after the change.",
        undefined,
        dispatchState,
      );
    }
    dispatch.markVerified();
    return {
      schema: "morrow.blackboard.membership-patch.readback.v1",
      ok: true,
      // Morrow's operation journal reads this marker to decide what reached
      // Blackboard. The read payloads keep `status`, which is an evidence label.
      resultState: "applied",
      tenantId: write.tenantId,
      sourceBindingId: write.sourceBindingId,
      courseId: write.courseId,
      membership: safeMembership(readback, reference),
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
 * The Gateway's fresh-read comparator for one reviewed membership change. It
 * holds no frozen snapshot, so it states only whether the reviewed role and
 * availability are saved on that membership now. The precondition that catches a
 * membership changed after review belongs to the dispatch above, which sent the
 * change and holds that snapshot.
 *
 * It prepares no roster and reads no course membership list: the reference it is
 * given was already resolved inside this server, and this route returns one
 * boolean and the identifiers the Gateway already holds. It carries no
 * `diagnostics` either, because the Gateway freezes this exact payload when it
 * plans the operation.
 */
async function verifyMembershipPatch(
  runtime: BlackboardLearnRuntime,
  input: MembershipPatch,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const patch = reviewedPatch(input.patch);
  const { reference, userId } = reviewedAccount(runtime, input);
  const comparator = await runtime.beginComparatorRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const record = await comparator.client.get(membershipPath(comparator.courseId, userId), signal);
  const exact = record.courseId === comparator.courseId && record.userId === userId;
  const verified = exact && membershipFieldsMatch(record, patch);
  runtime.recordEffectComparison(membershipEffectTarget(runtime, input, userId), verified);
  return {
    schema: "morrow.blackboard.membership-patch.comparator.v1",
    ok: true,
    tenantId: comparator.tenantId,
    sourceBindingId: comparator.sourceBindingId,
    courseId: comparator.courseId,
    learnerToken: reference,
    verified,
    readback: READBACK_STATE,
    status: "api_configured_live_untested",
  };
}

/**
 * Blackboard course memberships and the account this connection acts as: who is
 * in the selected course, one person's membership of it, the integration account
 * itself, and one reviewed change to a person's course role or availability.
 *
 * Every person leaves this server as a protected reference from the learner
 * vault, and every route accepts a person only as one of those references, so a
 * caller cannot address a Blackboard account Morrow has not already tokenized
 * for this exact course.
 *
 * Adding a person to a course and removing one (`PUT` and `DELETE` on the same
 * membership route) are held: Morrow has no reviewed contract for adding or
 * removing a person from a course. This module sends neither.
 *
 * A change here is three separate routes, as every Morrow provider change is:
 * the plan an instructor reviews, the dispatch the Gateway makes once against a
 * signed one-use effect grant, and the fresh-read comparator. The change is not
 * reachable yet: Morrow's Gateway has no public plan tool for a Blackboard
 * membership, so nothing can dispatch this route until that wiring exists.
 *
 * Naming one person is not reachable from an MCP client either. A reference is
 * minted by the roster read, and Morrow's native MCP egress replaces that whole
 * `learners` list with `[redacted]` (`strictNativeEgress`,
 * packages/mcp-server/src/runtime.ts), so no client holds one to send. The
 * routes below are proved inside this server, where the roster read returns
 * those references. docs/implementation/BLACKBOARD-REST-SCOPE.md records this.
 *
 * Course role ids are tenant-defined and no live Blackboard tenant has been
 * read, so which role id a site means by a given name is live-unverified. Morrow
 * checks the shape of the value it is given, sends it unchanged, and reports the
 * change as verified only when the site returns that exact role on the readback.
 */
export const blackboardMembershipsModule: BlackboardOperationModule = {
  id: "memberships",
  tools: [
    blackboardTool({
      name: "blackboard_course_roster_summary",
      title: "Read protected Blackboard learner references",
      description: "Read protected learner references for one selected Blackboard Learn course. Names, identifiers, and contact details stay on this server.",
      private: false,
      gatewayDispatchOnly: false,
      inputSchema: scopeInput,
      annotations: READ_ANNOTATIONS,
      capability: readCapability(`GET ${MEMBERSHIPS_ROUTE}`, "learner"),
      rest: {
        method: "GET",
        pathTemplate: MEMBERSHIPS_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => runtime.rosterSummary({
        tenantId: input.tenant_id,
        sourceBindingId: input.source_binding_id,
        courseId: input.course_id,
      }, signal),
    }),
    blackboardTool({
      name: "blackboard_read_course_membership",
      title: "Read one Blackboard course membership",
      description: "Read one person's membership of the selected Blackboard Learn course: their course role and whether the membership is available. Name the person by the protected reference the Blackboard roster read returned for them (for example, Student A1); this tool does not accept a Blackboard user id.",
      private: false,
      gatewayDispatchOnly: false,
      inputSchema: membershipScopeInput,
      annotations: READ_ANNOTATIONS,
      capability: readCapability(`GET ${MEMBERSHIP_ROUTE}`, "learner"),
      rest: {
        method: "GET",
        pathTemplate: MEMBERSHIP_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => readCourseMembership(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_read_integration_account",
      title: "Read the Blackboard account this connection acts as",
      description: "Read the Learn account this Blackboard connection's server credential acts as: its account id and whether Blackboard reports it as available. It reads the configured integration account and no other account, and it returns no name and no contact details.",
      private: false,
      gatewayDispatchOnly: false,
      inputSchema: scopeInput,
      annotations: READ_ANNOTATIONS,
      capability: readCapability(`GET ${ACCOUNT_ROUTE}`, "course"),
      rest: {
        method: "GET",
        pathTemplate: ACCOUNT_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => readIntegrationAccount(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_plan_membership_patch",
      title: "Plan one Blackboard course membership change",
      description: "Prepare one change to a person's Blackboard course role, their membership availability, or both, for Morrow review. Name the person by the protected reference the Blackboard roster read returned for them (for example, Student A1). This tool does not send a Blackboard PATCH request, and it never adds a person to a course or removes one.",
      private: true,
      gatewayDispatchOnly: false,
      inputSchema: membershipPatchInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: {
        family: "membership-update",
        provider: "blackboard",
        sourceExport: `PATCH ${MEMBERSHIP_ROUTE}`,
        behavior: {
          readOnly: true, mutating: false, destructive: false, irreversible: false,
          supportsDryRun: false, supportsReadback: true, supportsUndo: false, supportsBatch: false,
          requiresBrowser: false, requiresLiveCanvas: false,
        },
        authority: { scopeClass: "tenant-course", approvalClass: "standard", dataClass: "learner" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: WRITE_PROFILES,
        evidence: EVIDENCE,
      },
      rest: {
        method: "GET",
        pathTemplate: MEMBERSHIP_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => planMembershipPatch(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_apply_reviewed_membership_patch",
      title: "Apply one reserved Blackboard course membership change",
      description: "Internal Morrow dispatch route. This request requires an exact signed Gateway effect grant.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: membershipApplyInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: {
        family: "membership-update",
        provider: "blackboard",
        sourceExport: `PATCH ${MEMBERSHIP_ROUTE}`,
        behavior: {
          readOnly: false, mutating: true, destructive: false, irreversible: false,
          supportsDryRun: false, supportsReadback: true, supportsUndo: false, supportsBatch: false,
          requiresBrowser: false, requiresLiveCanvas: false,
        },
        authority: { scopeClass: "tenant-course", approvalClass: "standard", dataClass: "learner" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: WRITE_PROFILES,
        evidence: EVIDENCE,
      },
      rest: {
        method: "PATCH",
        pathTemplate: MEMBERSHIP_ROUTE,
        access: "write",
        entitlement: "unknown",
        reviewRoute: "blackboard_plan_membership_patch",
        readbackComparator: "blackboard_verify_membership_patch",
      },
      run: (runtime, input, signal) => applyReviewedMembershipPatch(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_verify_membership_patch",
      title: "Verify one Blackboard course membership change",
      description: "Internal Morrow fresh-read comparator for one reviewed Blackboard course membership change. It re-reads the membership and states whether the reviewed course role and availability are saved on it now.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: membershipPatchInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      capability: {
        family: "course-read",
        provider: "blackboard",
        sourceExport: `GET ${MEMBERSHIP_ROUTE}`,
        behavior: READ_BEHAVIOR,
        authority: { scopeClass: "tenant-course", approvalClass: "none", dataClass: "learner" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: COMPARATOR_PROFILES,
        evidence: EVIDENCE,
      },
      rest: {
        method: "GET",
        pathTemplate: MEMBERSHIP_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => verifyMembershipPatch(runtime, input, signal),
    }),
  ],
};
