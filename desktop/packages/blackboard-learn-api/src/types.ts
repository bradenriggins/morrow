import type { JsonObject } from "@morrow/contracts";

export const BLACKBOARD_ID = /^_[1-9][0-9]{0,18}_[1-9][0-9]{0,18}$/;
export const BLACKBOARD_SOURCE_BINDING_ID = /^[A-Za-z0-9_.:@-]{1,160}$/;

export interface BlackboardCourseBinding {
  readonly sourceBindingId: string;
  readonly courseId: string;
}

/**
 * How far Morrow must prove the Learn account a tenant's server credential acts
 * as. `self` requires the tenant to name that account. `membership-only` accepts
 * a tenant that does not answer the account read, and then permits reads only:
 * every write stays refused, because the actor behind the change is unproven.
 */
export type BlackboardPrincipalVerification = "self" | "membership-only";

export interface BlackboardTenant {
  readonly id: string;
  readonly baseUrl: string;
  readonly applicationKey: string;
  readonly clientSecret: string;
  readonly principalId: string;
  /** Absent means the default, `self`. */
  readonly principalVerification?: BlackboardPrincipalVerification;
  readonly courseBindings: readonly BlackboardCourseBinding[];
}

export interface BlackboardPublicTenant {
  readonly id: string;
  readonly baseUrl: string;
  readonly principalId: string;
  readonly principalVerification: BlackboardPrincipalVerification;
  readonly courseBindings: readonly BlackboardCourseBinding[];
}

/** The one place the default verification mode is decided. */
export function blackboardPrincipalVerification(
  tenant: { readonly principalVerification?: BlackboardPrincipalVerification },
): BlackboardPrincipalVerification {
  return tenant.principalVerification || "self";
}

/**
 * What Morrow proved about the Learn account the current token acts as.
 * `unresolved` means the tenant did not answer the account read. That is not the
 * same finding as another account, which is refused as
 * `blackboard_account_mismatch` and never reaches this type.
 */
export type BlackboardPrincipalResolution =
  | { readonly state: "verified"; readonly principalId: string }
  | { readonly state: "unresolved"; readonly detail: string };

export interface BlackboardContentPatchPlan {
  readonly schema: "morrow.blackboard.content-patch.plan.v1";
  readonly tenantId: string;
  readonly sourceBindingId: string;
  readonly courseId: string;
  readonly contentId: string;
  readonly before: JsonObject;
  /** Hash of the unredacted provider fields used as the optimistic precondition. */
  readonly beforeDigest: string;
  readonly patch: JsonObject;
  readonly planDigest: string;
  readonly reviewRequired: true;
}

export type BlackboardApiFailureCode =
  | "api_configured_live_untested"
  | "blackboard_scope_binding_required"
  | "blackboard_scope_binding_mismatch"
  | "blackboard_account_mismatch"
  | "blackboard_principal_unverified"
  | "blackboard_membership_mismatch"
  | "blackboard_response_invalid"
  | "blackboard_response_incomplete"
  | "blackboard_response_oversized"
  | "blackboard_pagination_refused"
  | "blackboard_request_cancelled"
  | "blackboard_request_unauthorized"
  | "blackboard_request_rate_limited"
  | "blackboard_request_failed"
  | "blackboard_content_mismatch"
  // The course itself accepts no change: it is closed and complete, or the exact
  // course read did not return it. docs/research/blackboard-recovery-contract.md:248
  | "blackboard_course_unavailable"
  // Morrow holds no contract for the requested change: an unsupported content
  // handler, the Ultra document wrapper, a document body, or a course whose
  // Learn mode Blackboard did not report.
  // docs/research/blackboard-recovery-contract.md:249
  | "blackboard_operation_unavailable"
  // Morrow could not use its own durable record of which Blackboard account and
  // credential this connection acts as, so it cannot bind a change to a session
  // it can account for. Reads are unaffected; every change is refused.
  | "blackboard_session_unavailable"
  // An earlier change Morrow sent to this exact item has no confirmed outcome,
  // so a new change to it is refused until a person or a fresh read settles it.
  | "blackboard_effect_unresolved"
  // Morrow could not use its own durable record of the Blackboard changes it has
  // already sent. Reads are unaffected; every change is refused.
  | "blackboard_effect_record_unavailable"
  | "blackboard_patch_review_required";

/**
 * Whether a failed Blackboard call had already sent its provider change.
 * `not_sent` is claimed only for a refusal raised before the request left this
 * process. From the request onward Morrow cannot prove the change did not land,
 * so the state is `applied_or_unknown`.
 */
export type BlackboardDispatchState = "not_sent" | "applied_or_unknown";

/**
 * The response headers a tenant returned with a failure, such as `Retry-After`
 * and the rate-limit headers that Learn site emits. Morrow keeps them so a
 * person can read what the site said about its own limits. They are never a
 * reason to send the request again.
 */
export type BlackboardResponseDiagnostics = Readonly<Record<string, string>>;

export class BlackboardApiError extends Error {
  readonly code: BlackboardApiFailureCode;
  readonly status?: number;
  readonly dispatchState: BlackboardDispatchState;
  readonly diagnostics?: BlackboardResponseDiagnostics;
  constructor(
    code: BlackboardApiFailureCode,
    message: string,
    status?: number,
    dispatchState: BlackboardDispatchState = "not_sent",
    diagnostics?: BlackboardResponseDiagnostics,
  ) {
    super(message);
    this.name = "BlackboardApiError";
    this.code = code;
    this.status = status;
    this.dispatchState = dispatchState;
    this.diagnostics = diagnostics;
  }
}

/**
 * Re-raises a failure with the execution state its call site proved. The code,
 * message, status, and tenant diagnostics a person reads do not change; only the
 * record of what reached Blackboard does. A failure Morrow did not classify
 * becomes the same generic request failure the MCP server already reports, with
 * the given state.
 */
export function withBlackboardDispatchState(error: unknown, dispatchState: BlackboardDispatchState): BlackboardApiError {
  if (error instanceof BlackboardApiError) {
    return error.dispatchState === dispatchState
      ? error
      : new BlackboardApiError(error.code, error.message, error.status, dispatchState, error.diagnostics);
  }
  return new BlackboardApiError(
    "blackboard_request_failed",
    "Morrow could not complete the Blackboard request.",
    undefined,
    dispatchState,
  );
}
