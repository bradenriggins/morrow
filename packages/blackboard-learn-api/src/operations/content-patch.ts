import * as z from "zod/v4";
import { BlackboardApiError } from "../types.js";
import { blackboardTool, contentScopeInput, effectGrantInput, patchInput, type BlackboardOperationModule } from "./definition.js";

const CONTENT_PATCH_ROUTE = "/learn/api/public/v1/courses/{course_id}/contents/{content_id}";

const REVIEWED_PROFILES = {
  "private-full": { state: "supported" },
  "public-canvas": { state: "profile_limited", reason: "This action needs a configured Blackboard REST tenant." },
  sandbox: { state: "profile_limited", reason: "This action needs a configured Blackboard REST tenant." },
  "read-only": { state: "profile_limited", reason: "This action requires an approved Morrow effect." },
} as const;

const EVIDENCE = {
  live: { state: "unknown", reason: "api_configured_live_untested" },
  credentialBoundary: { state: "known" },
} as const;

const planInput = contentScopeInput.extend({ patch: patchInput });

/**
 * One reviewed Blackboard content change, as three separate routes: the plan an
 * instructor reviews, the dispatch the Gateway makes once against a signed
 * one-use effect grant, and the fresh-read comparator. Only the dispatch route
 * sends a change.
 */
export const blackboardContentPatchModule: BlackboardOperationModule = {
  id: "content-patch",
  tools: [
    blackboardTool({
      name: "blackboard_plan_content_patch",
      title: "Plan Blackboard content update",
      description: "Prepare one Blackboard content update for Morrow review. This tool does not send a Blackboard PATCH request.",
      private: true,
      gatewayDispatchOnly: false,
      inputSchema: planInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: {
        family: "content-update", provider: "blackboard", sourceExport: `PATCH ${CONTENT_PATCH_ROUTE}`,
        behavior: {
          readOnly: true, mutating: false, destructive: false, irreversible: false,
          supportsDryRun: false, supportsReadback: true, supportsUndo: false, supportsBatch: false,
          requiresBrowser: false, requiresLiveCanvas: false,
        },
        authority: { scopeClass: "tenant-course", approvalClass: "standard", dataClass: "course" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: REVIEWED_PROFILES,
        evidence: EVIDENCE,
      },
      rest: {
        method: "GET",
        pathTemplate: CONTENT_PATCH_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: async (runtime, input, signal) => {
        const plan = await runtime.planContentPatch({
          tenantId: input.tenant_id,
          sourceBindingId: input.source_binding_id,
          courseId: input.course_id,
          contentId: input.content_id,
          patch: input.patch,
        }, signal);
        return { ...plan, effect_scope: runtime.effectScope({
          tenantId: input.tenant_id,
          sourceBindingId: input.source_binding_id,
          courseId: input.course_id,
        }), ok: true };
      },
    }),
    blackboardTool({
      name: "blackboard_apply_reviewed_content_patch",
      title: "Apply reserved Blackboard content update",
      description: "Internal Morrow dispatch route. This request requires an exact signed Gateway effect grant.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: contentScopeInput.extend({
        patch: patchInput,
        expected_plan_digest: z.string().regex(/^[0-9a-f]{64}$/),
        // The Blackboard connection the instructor reviewed, frozen by the
        // Gateway from the plan's effect scope. A rotated credential or a
        // repointed integration account is refused against it before anything
        // is sent.
        expected_connection: z.strictObject({
          principal_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
          session_generation: z.number().int().min(1),
        }),
        _morrow: z.strictObject({ outer_grant: effectGrantInput }),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: {
        family: "content-update", provider: "blackboard", sourceExport: `PATCH ${CONTENT_PATCH_ROUTE}`,
        behavior: {
          readOnly: false, mutating: true, destructive: false, irreversible: false,
          supportsDryRun: false, supportsReadback: true, supportsUndo: false, supportsBatch: false,
          requiresBrowser: false, requiresLiveCanvas: false,
        },
        authority: { scopeClass: "tenant-course", approvalClass: "standard", dataClass: "course" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: REVIEWED_PROFILES,
        evidence: EVIDENCE,
      },
      rest: {
        method: "PATCH",
        pathTemplate: CONTENT_PATCH_ROUTE,
        access: "write",
        entitlement: "unknown",
        reviewRoute: "blackboard_plan_content_patch",
        readbackComparator: "blackboard_verify_content_patch",
      },
      run: async (runtime, input, signal) => {
        const grant = {
          schema: input._morrow.outer_grant.schema,
          operationId: input._morrow.outer_grant.operation_id,
          planDigest: input._morrow.outer_grant.plan_digest,
          outerPlanDigest: input._morrow.outer_grant.outer_plan_digest,
          approvalGrantDigest: input._morrow.outer_grant.approval_grant_digest,
          effectReceiptId: input._morrow.outer_grant.effect_receipt_id,
          dispatchAttempt: input._morrow.outer_grant.dispatch_attempt,
          gatewayProcessId: input._morrow.outer_grant.gateway_process_id,
          dispatchToken: input._morrow.outer_grant.dispatch_token,
        };
        runtime.assertReservedEffectGrant(grant);
        if (grant.planDigest !== input.expected_plan_digest) {
          throw new BlackboardApiError("blackboard_patch_review_required", "The Blackboard effect grant does not match this exact reviewed plan.");
        }
        await runtime.assertReviewedSession({
          tenantId: input.tenant_id,
          sourceBindingId: input.source_binding_id,
          courseId: input.course_id,
          principalFingerprint: input.expected_connection.principal_fingerprint,
          sessionGeneration: input.expected_connection.session_generation,
        }, signal);
        const plan = await runtime.planContentPatch({
          tenantId: input.tenant_id,
          sourceBindingId: input.source_binding_id,
          courseId: input.course_id,
          contentId: input.content_id,
          patch: input.patch,
        }, signal);
        if (plan.planDigest !== input.expected_plan_digest) {
          throw new BlackboardApiError("blackboard_content_mismatch", "Blackboard content changed after review. The patch was not sent.");
        }
        return runtime.applyReservedContentPatch(plan, grant, signal);
      },
    }),
    blackboardTool({
      name: "blackboard_verify_content_patch",
      title: "Verify Blackboard content update",
      description: "Internal Morrow fresh-read comparator for a reviewed Blackboard content update.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: planInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      capability: {
        family: "content-read", provider: "blackboard", sourceExport: `GET ${CONTENT_PATCH_ROUTE}`,
        behavior: {
          readOnly: true, mutating: false, destructive: false, irreversible: false,
          supportsDryRun: false, supportsReadback: false, supportsUndo: false, supportsBatch: false,
          requiresBrowser: false, requiresLiveCanvas: false,
        },
        authority: { scopeClass: "tenant-course", approvalClass: "none", dataClass: "course" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: {
          "private-full": { state: "supported" },
          "public-canvas": { state: "profile_limited", reason: "This action needs a configured Blackboard REST tenant." },
          sandbox: { state: "profile_limited", reason: "This action needs a configured Blackboard REST tenant." },
          "read-only": { state: "private_only", reason: "Gateway-only Blackboard verification." },
        },
        evidence: EVIDENCE,
      },
      rest: {
        method: "GET",
        pathTemplate: CONTENT_PATCH_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => runtime.verifyContentPatch({
        tenantId: input.tenant_id,
        sourceBindingId: input.source_binding_id,
        courseId: input.course_id,
        contentId: input.content_id,
        patch: input.patch,
      }, signal),
    }),
  ],
};
