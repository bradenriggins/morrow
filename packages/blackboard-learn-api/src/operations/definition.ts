import type { JsonObject, SourceCapabilityMetadata, ToolAnnotations } from "@morrow/contracts";
import * as z from "zod/v4";
import type { BlackboardLearnRuntime } from "../runtime.js";
import { BlackboardApiError } from "../types.js";

const blackboardId = z.string().regex(/^_[1-9][0-9]{0,18}_[1-9][0-9]{0,18}$/);
const sourceBindingId = z.string().regex(/^[A-Za-z0-9_.:@-]{1,160}$/);

/** The one exact tenant, course connection, and course every operation binds to. */
export const scopeInput = z.strictObject({
  tenant_id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  source_binding_id: sourceBindingId,
  course_id: blackboardId,
});

export const contentScopeInput = scopeInput.extend({ content_id: blackboardId });
export const patchInput = z.record(z.string(), z.unknown());

export const effectGrantInput = z.strictObject({
  schema: z.literal("morrow.blackboard.effect-grant.v1"),
  operation_id: z.string().regex(/^op:[A-Za-z0-9_-]{1,160}$/),
  plan_digest: z.string().regex(/^[0-9a-f]{64}$/),
  outer_plan_digest: z.string().regex(/^[0-9a-f]{64}$/),
  approval_grant_digest: z.string().regex(/^[0-9a-f]{64}$/),
  effect_receipt_id: z.string().regex(/^effect:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  dispatch_attempt: z.number().int().min(1),
  gateway_process_id: z.string().regex(/^[A-Za-z0-9:_-]{8,300}$/),
  dispatch_token: z.string().regex(/^[0-9a-f]{64}$/),
});

/**
 * What one tool sends to Blackboard, as the generated catalog records it
 * (`artifacts/blackboard/blackboard-rest-catalog.json`). It names the route the
 * tool exists to call. The tool also sends the integration-account,
 * course-membership, and roster reads it states before it answers.
 */
export interface BlackboardRestRoute {
  /** `null` for a tool that sends no Blackboard request. */
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | null;
  /** `null` for a tool that sends no Blackboard request. */
  readonly pathTemplate: string | null;
  /** Whether this tool can change the course. A plan that only reads is a read. */
  readonly access: "read" | "write";
  /**
   * The Learn entitlement this route needs. It stays `unknown` until a tenant
   * Swagger states it; no Blackboard tenant has been read. `none` marks a tool
   * that sends no Blackboard request.
   */
  readonly entitlement: "unknown" | "none";
  /** The tool that freezes and reviews this change. A read names none. */
  readonly reviewRoute: string | null;
  /** The tool that re-reads this change and compares it. A read names none. */
  readonly readbackComparator: string | null;
}

export interface BlackboardToolDefinition<Schema extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /**
   * Hidden from Morrow's merged capability catalog, so only the Gateway itself
   * can call it. `test/blackboard-registry.test.ts` holds this flag to the
   * Blackboard names in `packages/mcp-server/src/runtime.ts`.
   */
  readonly private: boolean;
  /**
   * Registered only when the Gateway starts this server for its own reserved
   * dispatch. Every other client connects to a server without these routes.
   */
  readonly gatewayDispatchOnly: boolean;
  readonly inputSchema: Schema;
  readonly annotations: ToolAnnotations;
  /**
   * The `_meta["io.morrow/capability"]` block. `null` marks a tool that is not
   * a catalog capability, such as the local configuration check.
   */
  readonly capability: SourceCapabilityMetadata | null;
  readonly rest: BlackboardRestRoute;
  run(runtime: BlackboardLearnRuntime, input: z.output<Schema>, signal?: AbortSignal): Promise<JsonObject>;
}

/** One domain of Blackboard operations. */
export interface BlackboardOperationModule {
  readonly id: string;
  readonly tools: readonly BlackboardToolDefinition[];
}

/**
 * One tool, with its `run` typed against its own input schema. The registry
 * holds every tool under one type, where the input the MCP server has already
 * validated against that same schema arrives as `unknown`.
 */
export function blackboardTool<Schema extends z.ZodType>(definition: BlackboardToolDefinition<Schema>): BlackboardToolDefinition {
  if (definition.rest.access !== "write" || definition.name === "blackboard_apply_reviewed_content_patch") return definition;
  if (!(definition.inputSchema instanceof z.ZodObject)) throw new Error("A Blackboard change requires an object input.");
  const bindingInput = z.object({
    ...scopeInput.shape,
    expected_plan_digest: z.string().regex(/^[0-9a-f]{64}$/),
    _morrow: z.strictObject({ outer_grant: effectGrantInput }),
    expected_connection: z.strictObject({
      principal_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
      session_generation: z.number().int().min(1),
    }),
  });
  const inputSchema = definition.inputSchema.extend({ expected_connection: bindingInput.shape.expected_connection });
  return {
    ...definition,
    inputSchema,
    async run(runtime, value, signal) {
      const validated = inputSchema.parse(value);
      const input = bindingInput.parse(validated);
      const envelope = input._morrow.outer_grant;
      const grant = {
        schema: envelope.schema, operationId: envelope.operation_id, planDigest: envelope.plan_digest,
        outerPlanDigest: envelope.outer_plan_digest, approvalGrantDigest: envelope.approval_grant_digest,
        effectReceiptId: envelope.effect_receipt_id, dispatchAttempt: envelope.dispatch_attempt,
        gatewayProcessId: envelope.gateway_process_id, dispatchToken: envelope.dispatch_token,
      };
      runtime.assertReservedEffectGrant(grant);
      if (grant.planDigest !== input.expected_plan_digest) {
        throw new BlackboardApiError("blackboard_patch_review_required", "The Blackboard effect grant does not match this exact reviewed plan.");
      }
      await runtime.assertReviewedSession({
        tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
        principalFingerprint: input.expected_connection.principal_fingerprint,
        sessionGeneration: input.expected_connection.session_generation,
      }, signal);
      const { expected_connection: _connection, ...request } = validated;
      return definition.run(runtime, request as z.output<Schema>, signal);
    },
  };
}
