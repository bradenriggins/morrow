import { randomBytes } from "node:crypto";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import type {
  BrowserEditAccessPrepared,
  BrowserEditAccessResult,
  BrowserEditAccessSelection,
} from "./runtime.js";

/**
 * Edit asked for in a conversation. The assistant names the courses and the kinds of change, and
 * Morrow shows them on its own review page. Edit turns on only when the person selects Turn on
 * Edit there, and the review server accepts that only with Morrow Bridge's signature over the
 * click (see `reviewApprovalProof`). An MCP client that answers a form, or any local program that
 * posts the page's form, cannot turn Edit on.
 */

export const EDIT_ACCESS_REVIEW_TTL_MS = 15 * 60_000;
const ENDED_REVIEW_RETENTION_MS = 60 * 60_000;
const MAX_EDIT_ACCESS_REVIEWS = 50;
const EDIT_ACCESS_ID = /^[A-Za-z0-9_-]{43}$/;

/** The sentence the tool, the review page and the Bridge settings all use for a removal action. */
export const DESTRUCTIVE_EDIT_REFUSAL = "Actions that remove content are turned on only in Morrow Bridge Plan and Edit settings.";

/**
 * Why a conversation cannot ask for an action whose Bridge option needs a field choice: its grant
 * allows no field, so Edit on it alone would change nothing, and settings never offers it either.
 */
export const FIELD_SELECTION_EDIT_REFUSAL = "This action can change many different settings, so Edit does not cover it, and Morrow asks before each change. A task bundle in Morrow Bridge Plan and Edit settings may cover the change you need.";

export type EditAccessReviewState =
  | "awaiting_approval"
  | "applying"
  | "enabled"
  | "unconfirmed"
  | "not_sent"
  | "declined"
  | "expired";

interface EditAccessReview {
  readonly editAccessId: string;
  readonly approvalUrl: string;
  readonly prepared: BrowserEditAccessPrepared;
  readonly expiresAt: number;
  state: EditAccessReviewState;
  endedAt: number | null;
  result: BrowserEditAccessResult | null;
  selections: readonly JsonObject[] | null;
}

export class EditAccessReviewUnavailableError extends Error {
  constructor() {
    super("edit_access_review_unavailable");
  }
}

/** Every reviewed kind is in the saved grant, which also keeps what the course already had. */
function holdsCategoryIds(requested: readonly { readonly id: string }[], saved: unknown): boolean {
  return Array.isArray(saved) && requested.every((category) => saved.includes(category.id));
}

function currentBindingMatches(selection: BrowserEditAccessSelection, binding: JsonObject | undefined): boolean {
  const site = selection.provider === "canvas" ? binding?.origin : binding?.siteUrl;
  return binding?.sourceBindingId === selection.sourceBindingId
    && binding.provider === selection.provider
    && binding.courseId === selection.courseId
    && site === selection.site
    && binding.principalFingerprint === selection.principalFingerprint
    && binding.sessionGeneration === selection.sessionGeneration
    && binding.catalogDigest === selection.catalogDigest
    && binding.runtimeVerified === true;
}

function actualSelection(selection: BrowserEditAccessSelection, result: BrowserEditAccessResult): JsonObject {
  const binding = result.bindings.find((candidate) => candidate.sourceBindingId === selection.sourceBindingId);
  const permission = binding && isJsonObject(binding.editPermission) ? binding.editPermission : null;
  const actualMode = !binding ? "unavailable" : permission ? "edit" : "plan";
  const revision = binding?.editPolicyRevision;
  const expiresAt = permission?.expiresAt;
  const confirmed = result.outcome === "received" && currentBindingMatches(selection, binding) && (selection.enabledCategories.length > 0
    ? permission?.sourceBindingId === selection.sourceBindingId
      && permission.revision === selection.expectedPolicyRevision + 1
      && permission.catalogDigest === selection.catalogDigest
      // A grant has no end time. Only a grant saved before that rule carries one, and it counts
      // only while that time is still ahead.
      && (expiresAt === undefined || (typeof expiresAt === "number" && Number.isSafeInteger(expiresAt) && expiresAt > Date.now()))
      && holdsCategoryIds(selection.enabledCategories, permission.enabledCategories)
    : !permission && (revision === selection.expectedPolicyRevision || revision === selection.expectedPolicyRevision + 1));
  return {
    sourceBindingId: selection.sourceBindingId,
    provider: selection.provider,
    courseId: selection.courseId,
    courseName: selection.courseName,
    site: selection.site,
    requestedMode: selection.enabledCategories.length ? "edit" : "plan",
    actualMode,
    ...(Number.isSafeInteger(revision) ? { editPolicyRevision: revision } : {}),
    confirmed,
  };
}

/**
 * Each selected course as the Bridge reports it after the change, and whether every one of them
 * now holds the access that was asked for.
 */
export function confirmedEditAccess(prepared: BrowserEditAccessPrepared, result: BrowserEditAccessResult): {
  readonly allConfirmed: boolean;
  readonly selections: readonly JsonObject[];
} {
  const selections = prepared.selections.map((selection) => actualSelection(selection, result));
  return {
    allConfirmed: result.outcome === "received" && selections.every((selection) => selection.confirmed === true),
    selections,
  };
}

/** The kinds of change a course's saved grant holds, by their labels, and its end time if it has one. */
function savedGrant(selection: BrowserEditAccessSelection, result: BrowserEditAccessResult | null): {
  readonly actions: readonly { readonly label: string; readonly unchecked: boolean }[];
  readonly grantEndsAt?: number;
} | null {
  const binding = result?.bindings.find((candidate) => candidate.sourceBindingId === selection.sourceBindingId);
  const permission = binding && isJsonObject(binding.editPermission) ? binding.editPermission : null;
  if (!permission || !Array.isArray(permission.enabledCategories)) return null;
  const options = new Map<string, JsonObject>();
  for (const option of Array.isArray(binding?.editCategories) ? binding.editCategories : []) {
    if (isJsonObject(option) && typeof option.id === "string") options.set(option.id, option);
  }
  const requested = new Map(selection.enabledCategories.map((category) => [category.id, category]));
  const actions = permission.enabledCategories.filter((id): id is string => typeof id === "string").map((id) => {
    const option = options.get(id);
    const label = typeof option?.label === "string" && option.label ? option.label : requested.get(id)?.label ?? id;
    return { label, unchecked: option ? option.verification === "unchecked" : requested.get(id)?.unchecked === true };
  });
  const endsAt = permission.expiresAt;
  return { actions, ...(typeof endsAt === "number" && Number.isSafeInteger(endsAt) ? { grantEndsAt: endsAt } : {}) };
}

function requestedSelections(prepared: BrowserEditAccessPrepared): JsonObject[] {
  return prepared.selections.map((selection) => ({
    sourceBindingId: selection.sourceBindingId,
    provider: selection.provider,
    courseId: selection.courseId,
    courseName: selection.courseName,
    site: selection.site,
    requestedMode: "edit",
    enabledCategories: selection.enabledCategories.map((category) => category.id),
  }));
}

const STATE_TEXT: Readonly<Record<EditAccessReviewState, string>> = {
  awaiting_approval: "The person has not turned on Edit yet. Edit turns on only when they select Turn on Edit on the review page in Chrome with Morrow Bridge connected.",
  applying: "The person selected Turn on Edit. Morrow is saving it in Morrow Bridge.",
  enabled: "Morrow confirmed Edit access for every selected course connection.",
  unconfirmed: "Morrow could not confirm every selected course connection. Review each current state before any change.",
  not_sent: "The selected course connections changed before Morrow could save Edit. Morrow left access unchanged.",
  declined: "The person kept these courses in Plan. Morrow left access unchanged.",
  expired: "The Edit access review expired before the person answered it. Morrow left access unchanged.",
};

/**
 * The Edit access reviews this Morrow has open, and the answer to each one for a while after it
 * ends, so a wait that asks after the person answered still reads that answer.
 */
export class EditAccessReviews {
  private readonly reviews = new Map<string, EditAccessReview>();

  constructor(private readonly apply: (
    prepared: BrowserEditAccessPrepared,
    options: { readonly merge: true },
  ) => Promise<BrowserEditAccessResult>) {}

  create(prepared: BrowserEditAccessPrepared, baseUrl: string | null): JsonObject {
    if (!baseUrl) throw new EditAccessReviewUnavailableError();
    if (prepared.mode !== "edit" || prepared.selections.length === 0
      || prepared.selections.some((selection) => selection.enabledCategories.length === 0
        || selection.enabledCategories.some((category) => category.destructive || category.requiresFieldSelection === true))) {
      throw new Error("An Edit access review needs at least one selected action, no action that removes content, and no action that needs a field choice.");
    }
    this.prune();
    if (this.reviews.size >= MAX_EDIT_ACCESS_REVIEWS) {
      throw new Error("Too many Edit access reviews are open. Answer one before asking for another.");
    }
    let editAccessId: string;
    do editAccessId = randomBytes(32).toString("base64url"); while (this.reviews.has(editAccessId));
    const review: EditAccessReview = {
      editAccessId,
      approvalUrl: `${baseUrl}/edit-access/${editAccessId}`,
      prepared,
      expiresAt: Date.now() + EDIT_ACCESS_REVIEW_TTL_MS,
      state: "awaiting_approval",
      endedAt: null,
      result: null,
      selections: null,
    };
    this.reviews.set(editAccessId, review);
    return this.result(editAccessId);
  }

  /** What the tool and the wait report: the requested scope until it ends, then what the Bridge holds. */
  result(editAccessId: string): JsonObject {
    const review = this.current(editAccessId);
    const ok = review.state === "enabled";
    return {
      schema: "morrow.edit-access.v1",
      ok,
      mode: "edit",
      editAccessId: review.editAccessId,
      state: review.state,
      outcome: review.result?.outcome ?? "not_sent",
      ...(review.state === "awaiting_approval"
        ? { approvalUrl: review.approvalUrl, expiresAt: new Date(review.expiresAt).toISOString() }
        : {}),
      selections: review.selections ?? requestedSelections(review.prepared),
      ...(review.result?.command ? { command: review.result.command } : {}),
      message: STATE_TEXT[review.state],
    };
  }

  /**
   * What the review page shows. It names courses and actions only, never a key or a grant. Once
   * Edit is on, the actions are every kind the course's saved grant holds, not only the ones asked
   * for, and an end time is named while it still applies.
   */
  page(editAccessId: string): JsonObject {
    const review = this.current(editAccessId);
    const pending = review.state === "awaiting_approval" || review.state === "applying";
    return {
      state: review.state,
      expiresAt: review.expiresAt,
      selections: review.prepared.selections.map((selection) => {
        const saved = review.state === "enabled" ? savedGrant(selection, review.result) : null;
        return {
          courseName: selection.courseName,
          site: selection.site,
          provider: selection.provider,
          actions: saved?.actions
            ?? selection.enabledCategories.map((category) => ({ label: category.label, unchecked: category.unchecked })),
          ...(saved?.grantEndsAt !== undefined ? { grantEndsAt: saved.grantEndsAt }
            : pending && selection.grantEndsAt !== undefined ? { grantEndsAt: selection.grantEndsAt } : {}),
        };
      }),
    };
  }

  /**
   * The person selected Turn on Edit, and the review server proved it with the Bridge's signature.
   * `approved` is true only for the one call that moved the review on, so the save runs once.
   */
  approve(editAccessId: string): JsonObject {
    const review = this.current(editAccessId);
    const approved = review.state === "awaiting_approval";
    if (approved) review.state = "applying";
    return { ...this.page(editAccessId), approved };
  }

  /**
   * Saves the reviewed scope in Morrow Bridge once, and keeps what the Bridge reports back. The
   * reviewed kinds join the course's current grant: Edit stays on until the person turns it off,
   * so nothing they turned on in Plan and Edit settings ends here.
   */
  async run(editAccessId: string): Promise<void> {
    const review = this.current(editAccessId);
    if (review.state !== "applying") return;
    try {
      const result = await this.apply(review.prepared, { merge: true });
      const confirmed = confirmedEditAccess(review.prepared, result);
      review.result = result;
      review.selections = confirmed.selections;
      review.state = confirmed.allConfirmed ? "enabled" : result.outcome === "not_sent" ? "not_sent" : "unconfirmed";
    } catch {
      // applyBrowserEditAccess throws only before it sends anything: the connection changed.
      review.state = "not_sent";
    }
    review.endedAt = Date.now();
  }

  cancel(editAccessId: string): JsonObject {
    const review = this.current(editAccessId);
    if (review.state === "awaiting_approval") {
      review.state = "declined";
      review.endedAt = Date.now();
    }
    return this.page(editAccessId);
  }

  private current(editAccessId: string): EditAccessReview {
    const review = EDIT_ACCESS_ID.test(editAccessId) ? this.reviews.get(editAccessId) : undefined;
    if (!review) throw new Error("This Edit access review is not open on this Morrow.");
    if (review.state === "awaiting_approval" && Date.now() >= review.expiresAt) {
      review.state = "expired";
      review.endedAt = review.expiresAt;
    }
    return review;
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, review] of this.reviews) {
      this.current(id);
      if (review.endedAt !== null && now - review.endedAt > ENDED_REVIEW_RETENTION_MS) this.reviews.delete(id);
    }
    const ended = [...this.reviews.values()]
      .filter((review) => review.endedAt !== null)
      .sort((left, right) => (left.endedAt ?? 0) - (right.endedAt ?? 0));
    while (this.reviews.size >= MAX_EDIT_ACCESS_REVIEWS && ended.length) this.reviews.delete(ended.shift()!.editAccessId);
  }
}
