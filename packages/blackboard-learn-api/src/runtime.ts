import { canonicalJson, isJsonObject, sha256Text, type JsonObject } from "@morrow/contracts";
import { LearnerRoster, LearnerVault, redactLearnerEgress, type LearnerIdentity, type LearnerScope } from "@morrow/gateway-core";
import { BlackboardLearnClient } from "./client.js";
import { deriveBlackboardSourceBindingId } from "./binding.js";
import { blackboardEffectGrantAccepted, type BlackboardEffectGrant } from "./effect-grant.js";
import { BLACKBOARD_EFFECT_STATE_IN_MEMORY, BlackboardEffectReceipts, type BlackboardEffectTarget } from "./operations/effect-receipts.js";
import { BLACKBOARD_SESSION_STATE_IN_MEMORY, BlackboardSessionGenerations, blackboardEffectScope } from "./operations/effect-scope.js";
import { BLACKBOARD_ID, BLACKBOARD_SOURCE_BINDING_ID, BlackboardApiError, blackboardPrincipalVerification, withBlackboardDispatchState, type BlackboardApiFailureCode, type BlackboardContentPatchPlan, type BlackboardCourseBinding, type BlackboardDispatchState, type BlackboardPublicTenant, type BlackboardTenant } from "./types.js";

const PATCH_FIELDS = ["title", "description", "availability"] as const;
type PatchField = (typeof PATCH_FIELDS)[number];

/**
 * The one Blackboard content handler Morrow changes, and the folder handler it
 * refuses. Blackboard's content-handler reference states that an Ultra document
 * body is a `resource/x-bb-document` child of a `resource/x-bb-folder` whose
 * `isBbPage` is true, so a change addressed to the wrapper edits the container
 * around the document.
 * https://docs.blackboard.com/docs/blackboard/rest-apis/advanced/content-handler
 */
const DOCUMENT_HANDLER = "resource/x-bb-document";
const FOLDER_HANDLER = "resource/x-bb-folder";

/**
 * The provider fields Morrow freezes before a Blackboard PATCH and re-checks
 * after it. Public Blackboard documentation does not settle whether a PATCH
 * merges or replaces a nested object such as `availability`, so an unpatched
 * protected field that comes back changed — a reset `availability.adaptiveRelease`,
 * a moved `parentId` — has to fail the readback instead of being reported as
 * verified. docs/research/blackboard-recovery-contract.md:217-221
 */
const PROTECTED_FIELDS: readonly (readonly string[])[] = [
  ["id"],
  ["parentId"],
  ["courseId"],
  ["contentHandler", "id"],
  ["title"],
  ["description"],
  ["position"],
  ["availability", "available"],
  ["availability", "allowGuests"],
  ["availability", "adaptiveRelease"],
];

/**
 * Protected fields left out of the readback comparison. Only a field a live
 * tenant read proves Blackboard rewrites on every change belongs here. No live
 * Blackboard tenant has been read, so this list is empty and every protected
 * field is compared.
 */
const VOLATILE_PROTECTED_FIELDS: readonly string[] = [];

/** Where each supported patch field lands in the protected projection. */
const PATCHED_PROTECTED_FIELDS: Record<PatchField, string> = {
  title: "title",
  description: "description",
  availability: "availability.available",
};

interface ScopeResolution {
  readonly tenant: BlackboardTenant;
  readonly client: BlackboardLearnClient;
  readonly courseId: string;
  readonly sourceBindingId: string;
}

interface RosterMember {
  readonly membership: JsonObject;
  readonly identity: LearnerIdentity;
}

export interface PreparedRoster {
  readonly learnerScope: LearnerScope;
  readonly learnerRoster: LearnerRoster;
  readonly learnerVault: LearnerVault;
  readonly members: readonly RosterMember[];
}

/**
 * One started Blackboard course read, for an operation module in
 * `src/operations/`. Holding one of these means the account this server
 * credential acts as and that account's membership of the selected course were
 * both checked, and the roster the read redacts its text against is prepared.
 * The module then reads the routes it exists to read through this exact tenant's
 * client, and reports what the whole call cost.
 */
export interface BlackboardCourseRead {
  readonly tenantId: string;
  readonly sourceBindingId: string;
  readonly courseId: string;
  /** The Learn account this server credential acts as, as the tenant configures it. */
  readonly principalId: string;
  /** Every course connection this tenant is configured for, so a listing can mark them. */
  readonly courseBindings: readonly BlackboardCourseBinding[];
  readonly client: BlackboardLearnClient;
  readonly roster: PreparedRoster;
  /** Every request this call has sent to the tenant so far, as a result reports it. */
  readonly cost: () => JsonObject;
}

/**
 * How long Morrow reuses one prepared course roster to redact course text. A
 * read needs the roster to recognize a learner in a title or a description, and
 * re-reading up to 5,000 course memberships for each course, listing, and item
 * is the cost this bound removes. Anything that writes reads the roster again:
 * a plan and the readback after a change both refresh it, so the text a person
 * reviews and the text Morrow returns after a change are checked against a
 * roster read inside that same operation. A read up to this long after the last
 * roster read does not know a person enrolled since then.
 */
const ROSTER_CACHE_MS = 60_000;

/**
 * One prepared roster held for reuse, with the credential that read it. The
 * generation is compared rather than written into the key, so a new access
 * token drops the held roster instead of leaving a second copy of a course's
 * learner identities in memory.
 */
interface HeldRoster {
  readonly tokenGeneration: number;
  readonly readAt: number;
  readonly roster: PreparedRoster;
}

/**
 * Why one course membership did not become a learner identity. Each value is a
 * separate Blackboard condition, so a refusal names the one that was hit
 * instead of reporting one unusable roster.
 */
type MembershipGap = "outside_course_scope" | "user_record_missing" | "user_record_mismatch";

const MEMBERSHIP_GAP_DETAIL: Record<MembershipGap, string> = {
  outside_course_scope: "outside this exact course",
  user_record_missing: "with no expanded user record, which is what Blackboard returns for a disabled or deleted account",
  user_record_mismatch: "with an expanded user record for a different account",
};

type MembershipResolution =
  | { readonly state: "resolved"; readonly identity: LearnerIdentity }
  | { readonly state: "unresolvable"; readonly gap: MembershipGap };

/** Failures that mean Morrow did not read every course membership. */
const ROSTER_INCOMPLETE_CODES: readonly BlackboardApiFailureCode[] = [
  "blackboard_response_incomplete",
  "blackboard_response_oversized",
  "blackboard_pagination_refused",
];

function exactString(value: unknown, label: string, max = 500_000): string {
  if (typeof value !== "string" || value.length > max) throw new BlackboardApiError("blackboard_response_invalid", `${label} is invalid.`);
  return value;
}

function scopeFor(tenant: BlackboardTenant, courseId: string): LearnerScope {
  return {
    canvasOrigin: tenant.baseUrl,
    account: tenant.id,
    course: courseId,
    principal: tenant.principalId,
    profile: "blackboard-learn-api",
  };
}

/**
 * One course membership as a learner identity, or the named condition that
 * stopped it. One unusable membership does not discard the whole roster here:
 * `preparedRoster` counts every condition and then refuses, so the person reads
 * which one Blackboard returned and how often.
 */
function resolveMembership(entry: JsonObject, courseId: string): MembershipResolution {
  if (entry.courseId !== courseId || typeof entry.userId !== "string" || !BLACKBOARD_ID.test(entry.userId)) {
    return { state: "unresolvable", gap: "outside_course_scope" };
  }
  const user = entry.user;
  if (!isJsonObject(user)) return { state: "unresolvable", gap: "user_record_missing" };
  if (user.id !== entry.userId) return { state: "unresolvable", gap: "user_record_mismatch" };
  const name = isJsonObject(user.name)
    ? [user.name.given, user.name.family].filter((part): part is string => typeof part === "string" && Boolean(part.trim())).join(" ")
    : undefined;
  const email = isJsonObject(user.contact) && typeof user.contact.email === "string" ? user.contact.email : undefined;
  const loginId = typeof user.userName === "string" ? user.userName : undefined;
  return {
    state: "resolved",
    identity: {
      id: entry.userId,
      ...(name ? { name } : {}),
      ...(email ? { email } : {}),
      ...(loginId ? { loginId } : {}),
    },
  };
}

/** What an incomplete roster means for the call that asked for it. */
function rosterRefusal(intent: "read" | "write", detail: string): BlackboardApiError {
  const preamble = intent === "write"
    ? "Morrow did not build a complete learner roster for this Blackboard course, so it changed nothing in it."
    : "Morrow did not build a complete learner roster for this Blackboard course, so it returned nothing from it.";
  return new BlackboardApiError("blackboard_response_incomplete", `${preamble} ${detail}`);
}

/** One refusal that names every membership condition Blackboard returned. */
function rosterGapRefusal(gaps: ReadonlyMap<MembershipGap, number>, total: number, intent: "read" | "write"): BlackboardApiError {
  const conditions = [...gaps.entries()]
    .map(([gap, count]) => `${count} came back ${MEMBERSHIP_GAP_DETAIL[gap]}`)
    .join("; ");
  return rosterRefusal(intent, `Of ${total} course memberships Blackboard returned, ${conditions}.`);
}

function stablePatch(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new BlackboardApiError("blackboard_response_invalid", "The Blackboard content patch is invalid.");
  if (Object.hasOwn(value, "body")) {
    throw new BlackboardApiError(
      "blackboard_operation_unavailable",
      "Morrow does not change a Blackboard document body. Original HTML and Ultra BbML are separate native contracts, and Morrow holds neither.",
    );
  }
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !PATCH_FIELDS.includes(key as PatchField))) {
    throw new BlackboardApiError("blackboard_response_invalid", "The Blackboard content patch contains unsupported fields.");
  }
  const output: JsonObject = {};
  for (const field of PATCH_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    const candidate = value[field];
    if (field === "availability") {
      if (!isJsonObject(candidate) || Object.keys(candidate).some((key) => key !== "available") || typeof candidate.available !== "string" || !["Yes", "No"].includes(candidate.available)) {
        throw new BlackboardApiError("blackboard_response_invalid", "The Blackboard content availability patch is invalid.");
      }
      output[field] = { available: candidate.available };
      continue;
    }
    output[field] = exactString(candidate, `Blackboard content ${field}`, field === "description" ? 750 : 500_000);
  }
  return output;
}

/** The frozen protected values of one exact content item, absent fields omitted. */
function protectedContent(value: JsonObject): JsonObject {
  const output: JsonObject = {};
  for (const path of PROTECTED_FIELDS) {
    const key = path.join(".");
    if (VOLATILE_PROTECTED_FIELDS.includes(key)) continue;
    let current: unknown = value;
    for (const segment of path) current = isJsonObject(current) ? current[segment] : undefined;
    if (current !== undefined) output[key] = current;
  }
  return output;
}

/** The protected projection an exact provider returns after this exact patch. */
function expectedProtectedContent(frozen: JsonObject, patch: JsonObject): JsonObject {
  const output: JsonObject = { ...frozen };
  for (const field of PATCH_FIELDS) {
    if (!Object.hasOwn(patch, field)) continue;
    const key = PATCHED_PROTECTED_FIELDS[field];
    if (VOLATILE_PROTECTED_FIELDS.includes(key)) continue;
    const value = patch[field];
    output[key] = field === "availability" && isJsonObject(value) ? value.available : value;
  }
  return output;
}

/** Whether one fresh read already carries every requested patch value. */
function patchedFieldsMatch(content: JsonObject, patch: JsonObject): boolean {
  const current = protectedContent(content);
  const expected = expectedProtectedContent({}, patch);
  return Object.keys(expected).every((key) => (
    Object.hasOwn(current, key) && canonicalJson(current[key]) === canonicalJson(expected[key])
  ));
}

/**
 * The admission rules for one content change, from the recovery contract
 * (docs/research/blackboard-recovery-contract.md:199-203). Morrow changes one
 * document inside the selected course: not a folder, not the Ultra wrapper
 * around a document, and not an item whose handler it cannot read.
 */
function assertPatchableContent(content: JsonObject, courseId: string): void {
  if (content.courseId !== courseId) {
    throw new BlackboardApiError("blackboard_scope_binding_mismatch", "Blackboard did not return this content item as part of the selected course.");
  }
  if (content.parentId !== undefined && (typeof content.parentId !== "string" || !BLACKBOARD_ID.test(content.parentId))) {
    throw new BlackboardApiError("blackboard_response_invalid", "Blackboard returned an invalid parent for this content item.");
  }
  const handler = content.contentHandler;
  if (!isJsonObject(handler) || typeof handler.id !== "string" || !handler.id) {
    throw new BlackboardApiError("blackboard_operation_unavailable", "Blackboard did not name a content handler for this item, so Morrow cannot tell what a change would edit.");
  }
  if (handler.id === FOLDER_HANDLER) {
    throw new BlackboardApiError(
      "blackboard_operation_unavailable",
      handler.isBbPage === true
        ? `This item is the Ultra document wrapper (${FOLDER_HANDLER} with isBbPage true). Morrow changes the ${DOCUMENT_HANDLER} inside it, never the wrapper.`
        : `This item is a Blackboard folder (${FOLDER_HANDLER}). Morrow changes one document, not a folder.`,
    );
  }
  if (handler.id !== DOCUMENT_HANDLER) {
    throw new BlackboardApiError("blackboard_operation_unavailable", `Morrow changes only a Blackboard document (${DOCUMENT_HANDLER}). This item is ${handler.id}.`);
  }
}

/**
 * One provider field as it may leave Morrow. `absent` is a field Blackboard did
 * not return, which stays absent. `withheld` is a value the privacy boundary
 * did not return as text, which keeps its `<field>Withheld` marker. A redaction
 * that fails is neither: it refuses the whole result, because a field Morrow
 * could not check against the roster must not be reported as merely withheld.
 */
type RedactedField =
  | { readonly state: "text"; readonly text: string }
  | { readonly state: "absent" }
  | { readonly state: "withheld" };

/**
 * A privacy-boundary reason is a code. Anything else could carry the provider
 * text the refusal exists to hold back, so it is reported as one plain reason.
 */
const PRIVACY_REASON = /^[a-z][a-z0-9_]{0,60}$/;

function redactedField(value: unknown, roster: PreparedRoster, label: string): RedactedField {
  // Blackboard writes an unset text field as `null` as well as by omitting it.
  if (value === undefined || value === null) return { state: "absent" };
  let result: unknown;
  try {
    result = redactLearnerEgress(value, roster);
  } catch (error) {
    const reason = error instanceof Error && PRIVACY_REASON.test(error.message) ? error.message : "privacy_redaction_failed";
    throw new BlackboardApiError(
      "blackboard_response_incomplete",
      `Morrow could not remove every learner identity from the Blackboard ${label}, so it returned nothing from this Blackboard course (${reason}).`,
    );
  }
  return typeof result === "string" ? { state: "text", text: result } : { state: "withheld" };
}

/**
 * Copies the named provider text fields onto a result, each redacted against
 * this course's roster. An operation module in `src/operations/` that returns a
 * provider record this file has no projection for — a file attachment's name —
 * writes its own projection with this, so every provider text that leaves
 * Morrow passes the same privacy boundary.
 */
export function redactInto(output: JsonObject, value: JsonObject, fields: readonly string[], roster: PreparedRoster, label: string): void {
  for (const field of fields) {
    const redacted = redactedField(value[field], roster, `${label} ${field}`);
    if (redacted.state === "text") output[field] = redacted.text;
    else if (redacted.state === "withheld") output[`${field}Withheld`] = true;
  }
}

export function safeContent(value: JsonObject, roster: PreparedRoster): JsonObject {
  const id = typeof value.id === "string" ? value.id : undefined;
  if (!id || !BLACKBOARD_ID.test(id)) throw new BlackboardApiError("blackboard_response_invalid", "Blackboard content identity is invalid.");
  const output: JsonObject = { id };
  redactInto(output, value, ["title", "description", "body", "parentId"], roster, "content");
  if (isJsonObject(value.availability) && typeof value.availability.available === "string") {
    output.availability = { available: value.availability.available };
  }
  if (typeof value.position === "number" && Number.isSafeInteger(value.position)) output.position = value.position;
  return output;
}

export function safeCourse(value: JsonObject, roster: PreparedRoster): JsonObject {
  const output: JsonObject = {};
  redactInto(output, value, ["id", "courseId", "name", "description"], roster, "course");
  return output;
}

/**
 * What this one call cost the tenant: every request it sent, the credential
 * exchange included. A call that reused a roster it had already read reports
 * the smaller number, so a reviewer reads the cost beside the result instead of
 * counting requests in a provider log.
 */
function providerCost(scope: ScopeResolution, requestsBefore: number): JsonObject {
  return { providerRequests: scope.client.requestCount - requestsBefore };
}

/**
 * The exact Blackboard item one content change is addressed to, as the durable
 * effect record keys it. It names a course and a content item and nothing else,
 * so no protected learner value reaches that record.
 */
function contentEffectTarget(scope: ScopeResolution, contentId: string): BlackboardEffectTarget {
  return { tenantId: scope.tenant.id, courseId: scope.courseId, contentId };
}

export class BlackboardLearnRuntime {
  private readonly tenants = new Map<string, BlackboardTenant>();
  private readonly clients = new Map<string, BlackboardLearnClient>();
  private readonly learnerVault: LearnerVault;
  private readonly effectDispatchSecret: string | undefined;
  /**
   * Every effect receipt this installation has spent, and how far the change it
   * paid for got. It is durable, so a receipt stays one-use across a restart of
   * this server, and a change Morrow could not confirm keeps the item it was
   * sent to until a person or a fresh read settles it.
   */
  private readonly effects: BlackboardEffectReceipts;
  /** At most one held roster for each configured tenant and course. */
  private readonly heldRosters = new Map<string, HeldRoster>();
  /** Which Blackboard account and credential each tenant acts as, and since when. */
  private readonly sessions: BlackboardSessionGenerations;

  constructor(tenants: readonly BlackboardTenant[], options: { readonly fetcher?: typeof fetch; readonly learnerVault?: LearnerVault; readonly effectDispatchSecret?: string; readonly sessionStatePath?: string; readonly effectStatePath?: string } = {}) {
    this.learnerVault = options.learnerVault || new LearnerVault(":memory:");
    this.effectDispatchSecret = options.effectDispatchSecret;
    this.effects = new BlackboardEffectReceipts(options.effectStatePath || BLACKBOARD_EFFECT_STATE_IN_MEMORY);
    this.sessions = new BlackboardSessionGenerations(options.sessionStatePath || BLACKBOARD_SESSION_STATE_IN_MEMORY);
    for (const tenant of tenants) {
      if (this.tenants.has(tenant.id)) throw new TypeError("Blackboard tenant id is duplicated");
      for (const binding of tenant.courseBindings) {
        if (binding.sourceBindingId !== deriveBlackboardSourceBindingId(tenant.baseUrl, tenant.principalId, binding.courseId)) {
          throw new TypeError("Blackboard source binding id does not match its tenant principal and course");
        }
      }
      this.tenants.set(tenant.id, tenant);
      this.clients.set(tenant.id, new BlackboardLearnClient(tenant, options.fetcher));
    }
  }

  health(): JsonObject {
    const tenants: BlackboardPublicTenant[] = [...this.tenants.values()].map((tenant) => ({
      id: tenant.id,
      baseUrl: tenant.baseUrl,
      principalId: tenant.principalId,
      principalVerification: blackboardPrincipalVerification(tenant),
      courseBindings: tenant.courseBindings.map((binding) => ({ ...binding })),
    }));
    return {
      schema: "morrow.blackboard.health.v1",
      ok: true,
      status: "api_configured_live_untested",
      tenantCount: tenants.length,
      tenants,
    };
  }

  /**
   * What a reviewed Blackboard change is bound to. The account fingerprint
   * covers the credential revision and the session generation counts every
   * change of that credential or of the account Blackboard reports for it, so
   * the Gateway freezes a scope that a rotated secret or a repointed
   * integration account moves. It is available only after the account read that
   * proved the session, which every read and every change makes first.
   */
  effectScope(input: { tenantId: string; sourceBindingId: string; courseId: string }): JsonObject {
    const scope = this.resolveScope(input.tenantId, input.sourceBindingId, input.courseId);
    return blackboardEffectScope(scope.tenant, scope.sourceBindingId, this.sessions.binding(scope.tenant));
  }

  /**
   * Refuses one reserved dispatch whose Blackboard connection is no longer the
   * connection the instructor reviewed: a rotated application secret, a
   * repointed integration account, or a site that now reports a different
   * account for this credential. It proves the current account first, so the
   * comparison is made against a session Morrow has just resolved, and it
   * refuses before anything is sent.
   */
  async assertReviewedSession(
    input: {
      tenantId: string;
      sourceBindingId: string;
      courseId: string;
      principalFingerprint: string;
      sessionGeneration: number;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    const scope = this.resolveScope(input.tenantId, input.sourceBindingId, input.courseId);
    await this.assertAuthenticatedPrincipal(scope, "write", signal);
    const binding = this.sessions.binding(scope.tenant);
    if (binding.principalFingerprint !== input.principalFingerprint || binding.sessionGeneration !== input.sessionGeneration) {
      throw new BlackboardApiError(
        "blackboard_patch_review_required",
        "This Blackboard connection changed after this change was reviewed: Morrow now signs in with a different Blackboard credential or acts as a different Blackboard account. It sent nothing. Review this change again.",
      );
    }
  }

  private resolveScope(tenantId: unknown, sourceBindingId: unknown, courseId: unknown): ScopeResolution {
    if (typeof tenantId !== "string" || !this.tenants.has(tenantId)) {
      throw new BlackboardApiError("blackboard_scope_binding_required", "Select one configured Blackboard tenant.");
    }
    if (typeof sourceBindingId !== "string" || !BLACKBOARD_SOURCE_BINDING_ID.test(sourceBindingId)
      || typeof courseId !== "string" || !BLACKBOARD_ID.test(courseId)) {
      throw new BlackboardApiError("blackboard_scope_binding_required", "Select one exact Blackboard course connection.");
    }
    const tenant = this.tenants.get(tenantId)!;
    const binding = tenant.courseBindings.find((entry) => entry.sourceBindingId === sourceBindingId);
    if (!binding || binding.courseId !== courseId) {
      throw new BlackboardApiError("blackboard_scope_binding_mismatch", "The Blackboard source connection does not match this selected course.");
    }
    return { tenant, client: this.clients.get(tenant.id)!, sourceBindingId, courseId };
  }

  /**
   * Blackboard's server credential acts as a Learn account an administrator
   * selected, so the configured principal id is a claim until the site confirms
   * it. The course-membership check below cannot confirm it: it passes for any
   * account that exists and is enrolled, including the wrong one.
   */
  private async assertAuthenticatedPrincipal(scope: ScopeResolution, intent: "read" | "write", signal?: AbortSignal): Promise<void> {
    const resolution = await scope.client.resolveAuthenticatedPrincipal(signal);
    // The account this credential acts as is one of the three inputs the session
    // generation counts, so the record is kept here, where that answer is fresh.
    await this.sessions.observe(scope.tenant, resolution);
    if (resolution.state === "verified") return;
    if (intent === "write") {
      throw new BlackboardApiError(
        "blackboard_principal_unverified",
        `Morrow did not confirm which Blackboard account this server credential acts as, so it changed nothing in this course. ${resolution.detail}`,
      );
    }
    if (blackboardPrincipalVerification(scope.tenant) !== "membership-only") {
      throw new BlackboardApiError(
        "blackboard_principal_unverified",
        `Morrow did not confirm which Blackboard account this server credential acts as, so it read nothing from this course. ${resolution.detail}`,
      );
    }
  }

  /**
   * Every course membership, or a refusal. A roster Morrow read only part of is
   * not a roster: each learner it did not read is a person it would not
   * recognize in course text and would return as Blackboard wrote it. A page or
   * record ceiling, an oversized page, and a refused pagination link therefore
   * stop the call instead of redacting against the memberships that arrived.
   */
  private async courseMemberships(scope: ScopeResolution, intent: "read" | "write", signal?: AbortSignal): Promise<readonly JsonObject[]> {
    try {
      return await scope.client.listCourseMemberships(scope.courseId, signal);
    } catch (error) {
      if (error instanceof BlackboardApiError && ROSTER_INCOMPLETE_CODES.includes(error.code)) {
        throw rosterRefusal(intent, error.message);
      }
      throw error;
    }
  }

  /**
   * The two identity checks a Blackboard course read and a Blackboard change
   * each make for themselves: which Learn account this server credential acts
   * as, and that account's exact membership of the selected course. Neither
   * answer is held between calls, because the fresh account and
   * course-membership check is what those tools state they do before they read
   * anything about the course.
   */
  private async verifyIdentity(scope: ScopeResolution, intent: "read" | "write", signal?: AbortSignal): Promise<void> {
    await this.assertAuthenticatedPrincipal(scope, intent, signal);
    await scope.client.verifyPrincipalAndMembership(scope.courseId, signal);
  }

  /**
   * The roster course text is redacted against. It is read at most once every
   * `ROSTER_CACHE_MS` for one tenant, course, and credential, so a listing and
   * the item reads after it share one roster read. `refresh` reads it again for
   * the calls where the roster itself is the answer or an operation writes:
   * `rosterSummary`, a change plan, and the readback after a change.
   *
   * Identity is not checked here. Every caller verifies the account and its
   * course membership first, so a held roster never stands in for that check.
   */
  private async preparedRoster(
    scope: ScopeResolution,
    intent: "read" | "write",
    options: { readonly refresh?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<PreparedRoster> {
    const key = `${scope.tenant.id}\u0000${scope.courseId}`;
    const held = this.heldRosters.get(key);
    if (held && !options.refresh
      && held.tokenGeneration === scope.client.tokenGeneration
      && Date.now() - held.readAt < ROSTER_CACHE_MS) {
      return held.roster;
    }
    // A roster this call will not reuse is dropped before the read that
    // replaces it, so learner identities Morrow no longer trusts as current do
    // not stay in memory behind a failed read.
    this.heldRosters.delete(key);
    const memberships = await this.courseMemberships(scope, intent, signal);
    const members: RosterMember[] = [];
    const gaps = new Map<MembershipGap, number>();
    for (const membership of memberships) {
      const resolution = resolveMembership(membership, scope.courseId);
      if (resolution.state === "resolved") members.push({ membership, identity: resolution.identity });
      else gaps.set(resolution.gap, (gaps.get(resolution.gap) || 0) + 1);
    }
    if (gaps.size > 0) throw rosterGapRefusal(gaps, memberships.length, intent);
    const learnerRoster = new LearnerRoster();
    const learnerScope = scopeFor(scope.tenant, scope.courseId);
    try {
      learnerRoster.register(learnerScope, members.map((member) => member.identity));
    } catch {
      // A roster the privacy boundary will not index holds no aliases, so the
      // call stops here instead of redacting course text against nothing.
      throw rosterRefusal(intent, "Blackboard returned course memberships Morrow could not hold as one exact roster.");
    }
    const roster: PreparedRoster = { learnerScope, learnerRoster, learnerVault: this.learnerVault, members };
    this.heldRosters.set(key, { tokenGeneration: scope.client.tokenGeneration, readAt: Date.now(), roster });
    return roster;
  }

  private async contentRaw(scope: ScopeResolution, contentId: string, signal?: AbortSignal): Promise<JsonObject> {
    const content = await scope.client.get(`/learn/api/public/v1/courses/${encodeURIComponent(scope.courseId)}/contents/${encodeURIComponent(contentId)}`, signal);
    if (content.id !== contentId) throw new BlackboardApiError("blackboard_content_mismatch", "Blackboard returned a different content item.");
    return content;
  }

  /** One fresh read of the exact item, admitted against the write contract. */
  private async patchableContent(scope: ScopeResolution, contentId: string, signal?: AbortSignal): Promise<JsonObject> {
    const content = await this.contentRaw(scope, contentId, signal);
    assertPatchableContent(content, scope.courseId);
    return content;
  }

  /**
   * One course read for a change, with the fields the recovery contract pins
   * (docs/research/blackboard-recovery-contract.md:178). A closed and complete
   * course accepts no change. A course that does not report `ultraStatus`
   * refuses it too: the Original and Ultra content contracts differ, so Morrow
   * cannot tell which one it would be writing under.
   */
  private async assertCourseAcceptsChange(scope: ScopeResolution, signal?: AbortSignal): Promise<void> {
    const course = await scope.client.get(
      `/learn/api/public/v3/courses/${encodeURIComponent(scope.courseId)}?fields=id,courseId,name,ultraStatus,closedComplete`,
      signal,
    );
    if (course.id !== scope.courseId) {
      throw new BlackboardApiError("blackboard_course_unavailable", "Blackboard returned a different course for this exact course connection.");
    }
    if (course.closedComplete === true) {
      throw new BlackboardApiError("blackboard_course_unavailable", "This Blackboard course is closed and complete, so Morrow changed nothing in it.");
    }
    if (typeof course.ultraStatus !== "string" || !course.ultraStatus) {
      throw new BlackboardApiError("blackboard_operation_unavailable", "Blackboard did not report whether this course is Original or Ultra, so Morrow cannot tell which content contract this change belongs to.");
    }
  }

  /**
   * Starts one course read for an operation module in `src/operations/`: it
   * resolves the exact configured course connection, checks which Learn account
   * this credential acts as and that account's membership of that course, and
   * prepares the roster the module redacts its text against. The reads in this
   * file make the same three checks, in the same order, before they read
   * anything about a course.
   */
  async beginCourseRead(input: { tenantId: string; sourceBindingId: string; courseId: string }, signal?: AbortSignal): Promise<BlackboardCourseRead> {
    const scope = this.resolveScope(input.tenantId, input.sourceBindingId, input.courseId);
    const requestsBefore = scope.client.requestCount;
    await this.verifyIdentity(scope, "read", signal);
    const roster = await this.preparedRoster(scope, "read", {}, signal);
    return {
      tenantId: scope.tenant.id,
      sourceBindingId: scope.sourceBindingId,
      courseId: scope.courseId,
      principalId: scope.tenant.principalId,
      courseBindings: scope.tenant.courseBindings,
      client: scope.client,
      roster,
      cost: () => providerCost(scope, requestsBefore),
    };
  }

  /**
   * Starts one Blackboard course change for an operation module in
   * `src/operations/`: the same checks `beginCourseRead` makes, under the write
   * conditions. The Learn account this credential acts as has to be proved
   * rather than assumed, the roster is read again rather than reused, because
   * the text a person reviews and the text Morrow returns after a change are
   * both redacted against a roster read inside this same operation, and the
   * course itself has to accept a change. It sends no change: the module does
   * that, once, after its own frozen precondition still matches.
   */
  async beginCourseWrite(input: { tenantId: string; sourceBindingId: string; courseId: string }, signal?: AbortSignal): Promise<BlackboardCourseRead> {
    const scope = this.resolveScope(input.tenantId, input.sourceBindingId, input.courseId);
    const requestsBefore = scope.client.requestCount;
    await this.verifyIdentity(scope, "write", signal);
    const roster = await this.preparedRoster(scope, "write", { refresh: true }, signal);
    await this.assertCourseAcceptsChange(scope, signal);
    return {
      tenantId: scope.tenant.id,
      sourceBindingId: scope.sourceBindingId,
      courseId: scope.courseId,
      principalId: scope.tenant.principalId,
      courseBindings: scope.tenant.courseBindings,
      client: scope.client,
      roster,
      cost: () => providerCost(scope, requestsBefore),
    };
  }

  /**
   * Starts one Blackboard read for a Gateway comparator: the account check, and
   * this tenant's client for the exact configured course. It prepares no roster
   * and reads no course membership, because a comparator returns identifiers the
   * Gateway already holds and one comparison Morrow made itself, and there is no
   * provider text in that to redact. Anything that returns provider text uses
   * `beginCourseRead`, which prepares the roster that text is redacted against.
   */
  async beginComparatorRead(
    input: { tenantId: string; sourceBindingId: string; courseId: string },
    signal?: AbortSignal,
  ): Promise<{ readonly tenantId: string; readonly sourceBindingId: string; readonly courseId: string; readonly client: BlackboardLearnClient }> {
    const scope = this.resolveScope(input.tenantId, input.sourceBindingId, input.courseId);
    await this.assertAuthenticatedPrincipal(scope, "read", signal);
    return { tenantId: scope.tenant.id, sourceBindingId: scope.sourceBindingId, courseId: scope.courseId, client: scope.client };
  }

  /**
   * The Blackboard account one protected learner reference names, from this
   * server's own learner vault and this exact course's scope. It sends no
   * Blackboard request: the reference was minted here, by a roster read of this
   * exact course in this installation. A reference this server did not mint, or
   * one minted for another course, is refused, so an operation module in
   * `src/operations/` cannot address a person Morrow has not tokenized.
   */
  learnerAccountId(input: { tenantId: string; sourceBindingId: string; courseId: string; reference: string }): string {
    const scope = this.resolveScope(input.tenantId, input.sourceBindingId, input.courseId);
    let identity: LearnerIdentity;
    try {
      identity = this.learnerVault.resolve(scopeFor(scope.tenant, scope.courseId), input.reference);
    } catch {
      throw new BlackboardApiError(
        "blackboard_scope_binding_required",
        "Morrow does not hold this protected learner reference for this Blackboard course. Read the course roster again and name the person by the reference it returns.",
      );
    }
    if (!BLACKBOARD_ID.test(identity.id)) {
      throw new BlackboardApiError("blackboard_response_invalid", "This protected learner reference does not name a Blackboard account.");
    }
    return identity.id;
  }

  async readCourse(input: { tenantId: string; sourceBindingId: string; courseId: string }, signal?: AbortSignal): Promise<JsonObject> {
    const scope = this.resolveScope(input.tenantId, input.sourceBindingId, input.courseId);
    const requestsBefore = scope.client.requestCount;
    await this.verifyIdentity(scope, "read", signal);
    const roster = await this.preparedRoster(scope, "read", {}, signal);
    const course = await scope.client.get(`/learn/api/public/v1/courses/${encodeURIComponent(scope.courseId)}`, signal);
    if (course.id !== scope.courseId) throw new BlackboardApiError("blackboard_scope_binding_mismatch", "Blackboard returned a different course.");
    return {
      schema: "morrow.blackboard.course.v1",
      ok: true,
      tenantId: scope.tenant.id,
      sourceBindingId: scope.sourceBindingId,
      courseId: scope.courseId,
      course: safeCourse(course, roster),
      status: "api_configured_live_untested",
      diagnostics: providerCost(scope, requestsBefore),
    };
  }

  async listContents(input: { tenantId: string; sourceBindingId: string; courseId: string }, signal?: AbortSignal): Promise<JsonObject> {
    const scope = this.resolveScope(input.tenantId, input.sourceBindingId, input.courseId);
    const requestsBefore = scope.client.requestCount;
    await this.verifyIdentity(scope, "read", signal);
    const roster = await this.preparedRoster(scope, "read", {}, signal);
    const contents = await scope.client.listContents(scope.courseId, signal);
    return {
      schema: "morrow.blackboard.contents.v1",
      ok: true,
      tenantId: scope.tenant.id,
      sourceBindingId: scope.sourceBindingId,
      courseId: scope.courseId,
      contents: contents.map((content) => safeContent(content, roster)),
      count: contents.length,
      status: "api_configured_live_untested",
      diagnostics: providerCost(scope, requestsBefore),
    };
  }

  async readContent(input: { tenantId: string; sourceBindingId: string; courseId: string; contentId: string }, signal?: AbortSignal): Promise<JsonObject> {
    const scope = this.resolveScope(input.tenantId, input.sourceBindingId, input.courseId);
    if (!BLACKBOARD_ID.test(input.contentId)) throw new BlackboardApiError("blackboard_scope_binding_required", "Select one exact Blackboard content item.");
    const requestsBefore = scope.client.requestCount;
    await this.verifyIdentity(scope, "read", signal);
    const roster = await this.preparedRoster(scope, "read", {}, signal);
    const content = await this.contentRaw(scope, input.contentId, signal);
    return {
      schema: "morrow.blackboard.content.v1",
      ok: true,
      tenantId: scope.tenant.id,
      sourceBindingId: scope.sourceBindingId,
      courseId: scope.courseId,
      contentId: input.contentId,
      content: safeContent(content, roster),
      status: "api_configured_live_untested",
      diagnostics: providerCost(scope, requestsBefore),
    };
  }

  async rosterSummary(input: { tenantId: string; sourceBindingId: string; courseId: string }, signal?: AbortSignal): Promise<JsonObject> {
    const scope = this.resolveScope(input.tenantId, input.sourceBindingId, input.courseId);
    const requestsBefore = scope.client.requestCount;
    await this.verifyIdentity(scope, "read", signal);
    // The roster is the answer here, so this call reads it again instead of
    // reporting one that could be a minute old.
    const roster = await this.preparedRoster(scope, "read", { refresh: true }, signal);
    const learners = roster.members.map(({ membership, identity }) => {
      const courseRoleId = typeof membership.courseRoleId === "string" ? membership.courseRoleId : "Unknown";
      const availability = isJsonObject(membership.availability) && typeof membership.availability.available === "string"
        ? membership.availability.available : "Unknown";
      return {
        learnerToken: roster.learnerVault.tokenize(roster.learnerScope, identity),
        courseRoleId,
        availability,
      };
    });
    return {
      schema: "morrow.blackboard.roster-summary.v1",
      ok: true,
      tenantId: scope.tenant.id,
      sourceBindingId: scope.sourceBindingId,
      courseId: scope.courseId,
      learners,
      count: learners.length,
      status: "api_configured_live_untested",
      diagnostics: providerCost(scope, requestsBefore),
    };
  }

  async planContentPatch(input: { tenantId: string; sourceBindingId: string; courseId: string; contentId: string; patch: JsonObject }, signal?: AbortSignal): Promise<BlackboardContentPatchPlan> {
    const scope = this.resolveScope(input.tenantId, input.sourceBindingId, input.courseId);
    if (!BLACKBOARD_ID.test(input.contentId)) throw new BlackboardApiError("blackboard_scope_binding_required", "Select one exact Blackboard content item.");
    const patch = stablePatch(input.patch);
    // An earlier change Morrow sent to this item and could not confirm holds it.
    // The refusal is raised here, before review, so an instructor is never asked
    // to approve a change Morrow would then refuse to send.
    this.effects.assertTargetFree(contentEffectTarget(scope, input.contentId));
    // A plan exists only to be dispatched, so it carries the write condition. An
    // instructor is refused before review instead of after approving a change
    // Morrow would then refuse to send.
    await this.verifyIdentity(scope, "write", signal);
    const roster = await this.preparedRoster(scope, "write", { refresh: true }, signal);
    await this.assertCourseAcceptsChange(scope, signal);
    const raw = await this.patchableContent(scope, input.contentId, signal);
    const beforeDigest = sha256Text(canonicalJson(protectedContent(raw)));
    const planDigest = sha256Text(canonicalJson({ tenantId: scope.tenant.id, sourceBindingId: scope.sourceBindingId, courseId: scope.courseId, contentId: input.contentId, beforeDigest, patch }));
    return {
      schema: "morrow.blackboard.content-patch.plan.v1",
      tenantId: scope.tenant.id,
      sourceBindingId: scope.sourceBindingId,
      courseId: scope.courseId,
      contentId: input.contentId,
      before: safeContent(raw, roster),
      beforeDigest,
      patch,
      planDigest,
      reviewRequired: true,
    };
  }

  assertReservedEffectGrant(grant: BlackboardEffectGrant): void {
    if (!blackboardEffectGrantAccepted(this.effectDispatchSecret, grant)) {
      throw new BlackboardApiError("blackboard_patch_review_required", "Blackboard content changes require an exact reserved Morrow effect grant.");
    }
    this.effects.assertUnspent(grant);
  }

  /**
   * Accepts one reserved grant and spends its one-use receipt, so a replay of
   * the same grant sends nothing. An operation module claims the receipt before
   * its first provider request, so two concurrent dispatches of one approval
   * cannot both pass the precondition and write. The receipt is written to the
   * durable record here, so it stays spent if this server restarts under a
   * Gateway that is still running.
   */
  claimReservedEffectGrant(grant: BlackboardEffectGrant): void {
    this.assertReservedEffectGrant(grant);
    this.effects.claim(grant);
  }

  /**
   * The Blackboard changes Morrow sent and could not confirm. Each one needs a
   * person to open that item in Blackboard and check it. This reads Morrow's own
   * record and sends no Blackboard request. When the record cannot be read it
   * refuses, because "Morrow could not find out" is not the same answer as
   * "there are none".
   */
  unresolvedEffects(): JsonObject {
    return this.effects.unresolved();
  }

  /** Called only by an outer Morrow effect reservation. This server does not register a public write tool. */
  async applyReservedContentPatch(plan: BlackboardContentPatchPlan, grant: BlackboardEffectGrant, signal?: AbortSignal): Promise<JsonObject> {
    this.assertReservedEffectGrant(grant);
    if (plan.schema !== "morrow.blackboard.content-patch.plan.v1" || !BLACKBOARD_ID.test(plan.contentId)) {
      throw new BlackboardApiError("blackboard_scope_binding_required", "The Blackboard content review plan is invalid.");
    }
    if (grant.planDigest !== plan.planDigest) {
      throw new BlackboardApiError("blackboard_patch_review_required", "The Blackboard effect grant does not match this exact reviewed plan.");
    }
    const scope = this.resolveScope(plan.tenantId, plan.sourceBindingId, plan.courseId);
    const patch = stablePatch(plan.patch);
    if (!/^[0-9a-f]{64}$/.test(plan.beforeDigest)) {
      throw new BlackboardApiError("blackboard_patch_review_required", "The Blackboard content review precondition is invalid.");
    }
    const expected = sha256Text(canonicalJson({ tenantId: scope.tenant.id, sourceBindingId: scope.sourceBindingId, courseId: scope.courseId, contentId: plan.contentId, beforeDigest: plan.beforeDigest, patch }));
    if (expected !== plan.planDigest) throw new BlackboardApiError("blackboard_patch_review_required", "The Blackboard content review plan is invalid.");
    const target = contentEffectTarget(scope, plan.contentId);
    // An earlier change to this item that Morrow could not confirm holds it, so
    // this reviewed change is refused before anything is sent.
    this.effects.assertTargetFree(target);
    // Claim the one-use receipt before any asynchronous provider operation so
    // concurrent calls cannot both pass the fresh precondition and PATCH. The
    // claim is on disk before this call returns, so a restart cannot spend it
    // again.
    const dispatch = this.effects.claim(grant, target);
    await this.verifyIdentity(scope, "write", signal);
    // The readback after the patch is redacted against this roster, so it is
    // read again inside this operation rather than reused from the plan.
    const roster = await this.preparedRoster(scope, "write", { refresh: true }, signal);
    await this.assertCourseAcceptsChange(scope, signal);
    const current = await this.patchableContent(scope, plan.contentId, signal);
    const frozen = protectedContent(current);
    if (sha256Text(canonicalJson(frozen)) !== plan.beforeDigest) {
      throw new BlackboardApiError("blackboard_content_mismatch", "Blackboard content changed after review. The patch was not sent.");
    }
    // Every patched field has to come back as the request, and every other
    // protected field as the frozen value, so a provider that resets a sibling
    // field while it applies the patch fails the readback.
    const expectedAfterPatch = expectedProtectedContent(frozen, patch);
    // Morrow cannot prove a change did not land once the PATCH request has left
    // this process. The marker is set on the line before that request, so every
    // failure from here on is reported as applied_or_unknown, and every refusal
    // raised above this point keeps not_sent.
    // The durable record moves with that marker. It is written before the
    // request and before the marker, so a run that ends inside this request
    // leaves a change this installation knows it may have sent, and a record it
    // cannot write refuses here, where nothing has been sent.
    dispatch.markSent();
    let dispatchState: BlackboardDispatchState = "not_sent";
    try {
      dispatchState = "applied_or_unknown";
      await scope.client.patch(`/learn/api/public/v1/courses/${encodeURIComponent(scope.courseId)}/contents/${encodeURIComponent(plan.contentId)}`, patch, signal);
      const readback = await this.contentRaw(scope, plan.contentId, signal);
      if (canonicalJson(protectedContent(readback)) !== canonicalJson(expectedAfterPatch)) {
        throw new BlackboardApiError("blackboard_content_mismatch", "Blackboard did not return every reviewed and protected content value after the patch.", undefined, dispatchState);
      }
      dispatch.markVerified();
      return {
        schema: "morrow.blackboard.content-patch.readback.v1",
        ok: true,
        tenantId: scope.tenant.id,
        sourceBindingId: scope.sourceBindingId,
        courseId: scope.courseId,
        contentId: plan.contentId,
        content: safeContent(readback, roster),
        status: "api_configured_live_untested",
      };
    } catch (error) {
      dispatch.markUncertain();
      throw withBlackboardDispatchState(error, dispatchState);
    }
  }

  /**
   * The Gateway's fresh-read comparator for one reviewed patch. It holds no
   * frozen snapshot, so it states only whether the requested values are present
   * now. The protected-field freeze that catches a changed sibling belongs to
   * `applyReservedContentPatch`, which sent the change and holds that snapshot.
   *
   * This route prepares no roster and reads no course membership. It returns one
   * boolean and the identifiers the Gateway already holds — no course text and
   * no learner text — so there is nothing in its result to redact against a
   * roster. It keeps the account check, because a credential that acts as
   * another Learn account is not evidence about this course. It carries no
   * `diagnostics` either: the Gateway freezes this exact payload when it plans
   * the operation and compares the whole result against that frozen digest
   * (packages/mcp-server/src/runtime.ts), so one more field would make every
   * verification fail.
   *
   * This is also the one call that lets an unconfirmed change let go of the item
   * it was sent to. It is a read: it states what Blackboard holds now, whichever
   * way that comes out, and it never sends the change again. The item stays held
   * until somebody makes this call.
   */
  async verifyContentPatch(input: { tenantId: string; sourceBindingId: string; courseId: string; contentId: string; patch: JsonObject }, signal?: AbortSignal): Promise<JsonObject> {
    const scope = this.resolveScope(input.tenantId, input.sourceBindingId, input.courseId);
    if (!BLACKBOARD_ID.test(input.contentId)) throw new BlackboardApiError("blackboard_scope_binding_required", "Select one exact Blackboard content item.");
    const patch = stablePatch(input.patch);
    await this.assertAuthenticatedPrincipal(scope, "read", signal);
    const content = await this.contentRaw(scope, input.contentId, signal);
    const verified = patchedFieldsMatch(content, patch);
    this.effects.recordComparison(contentEffectTarget(scope, input.contentId), verified);
    return {
      schema: "morrow.blackboard.content-patch.comparator.v1",
      ok: true,
      tenantId: scope.tenant.id,
      sourceBindingId: scope.sourceBindingId,
      courseId: scope.courseId,
      contentId: input.contentId,
      verified,
      status: "api_configured_live_untested",
    };
  }
}
