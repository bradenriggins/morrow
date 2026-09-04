import type { McpServer, CallToolResult } from "@modelcontextprotocol/server";
import {
  BATCH_MODES,
  BATCH_RECOVERY_MODES,
  BATCH_STATES,
} from "@morrow/batch-engine";
import { sha256Text, type JsonObject } from "@morrow/contracts";
import * as z from "zod/v4";
import { recoverGatewayBatch } from "./batch-recovery.js";
import { BatchWindowScheduler } from "./batch-window-scheduler.js";
import type { MorrowRuntime } from "./morrow-runtime.js";

function textAndStructured(summary: string, structuredContent: JsonObject): CallToolResult {
  return {
    content: [{ type: "text", text: summary }],
    structuredContent,
  };
}

function safeFailure(error: unknown): CallToolResult {
  const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
  return {
    content: [{ type: "text", text: "Morrow could not complete the local batch operation." }],
    isError: true,
    structuredContent: {
      schema: "morrow.problem.v1",
      code: "batch_operation_failed",
      recoverable: true,
      detailDigest: sha256Text(detail),
    },
  };
}

const BatchOperationSchema = z.object({
  child_id: z.string().min(1).max(160).optional(),
  course_id: z.string().min(1).max(160).optional(),
  tool: z.string().min(1).max(128),
  arguments: z.record(z.string(), z.unknown()).default({}),
  source_binding_id: z.string().min(1).max(160).optional(),
  depends_on: z.array(z.string().min(1).max(160)).max(10_000).default([]),
  source_observation_digest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  readback_spec_digest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  correction_facts_digest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

const BatchCourseSetSchema = z.object({
  source: z.enum([
    "explicit",
    "saved_project",
    "account_search",
    "term_state_filter",
    "blueprint_associations",
    "prior_cross_course_search",
  ]),
  course_ids: z.array(z.string().min(1).max(160)).min(1).max(10_000),
  complete: z.boolean(),
  all_courses_requested: z.boolean().default(false),
  pagination_complete: z.boolean().default(false),
  snapshot_digest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

const BatchRatePolicySchema = z.object({
  retry_after_ms: z.number().int().min(0).max(300_000).optional(),
  request_cost: z.number().int().min(0).max(1_000_000).optional(),
  rate_limit_remaining: z.number().int().min(0).max(1_000_000).optional(),
  jitter_ratio: z.number().min(0).max(1).optional(),
});

function ratePolicy(value: z.infer<typeof BatchRatePolicySchema> | undefined) {
  if (!value) return undefined;
  return {
    ...(value.retry_after_ms === undefined ? {} : { retryAfterMs: value.retry_after_ms }),
    ...(value.request_cost === undefined ? {} : { requestCost: value.request_cost }),
    ...(value.rate_limit_remaining === undefined ? {} : { rateLimitRemaining: value.rate_limit_remaining }),
    ...(value.jitter_ratio === undefined ? {} : { jitterRatio: value.jitter_ratio }),
  };
}

export function registerBatchTools(server: McpServer, runtime: MorrowRuntime): void {
  const scheduler = new BatchWindowScheduler({
    maxConcurrentWindows: runtime.gateway.config.batchScheduler.maxConcurrentWindows,
  });

  server.registerTool(
    "morrow_batch_health",
    {
      description: "Report bounded local batch-store, source-settlement, and scheduler status. This does not read or change Canvas.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => textAndStructured("Loaded Morrow batch-store status.", {
      ...runtime.batchHealth(),
      scheduler: scheduler.health(),
    }),
  );

  server.registerTool(
    "morrow_batch_create",
    {
      description: "Freeze an explicit multi-operation manifest against the current Morrow catalog. read_only batches may use any admitted read tool. stage_writes batches accept Morrow legacy write tools with an exact source binding and create no provider mutation at this step.",
      inputSchema: z.object({
        name: z.string().min(1).max(200),
        mode: z.enum(BATCH_MODES),
        concurrency: z.number().int().min(1).max(8).default(2),
        operations: z.array(BatchOperationSchema).min(1).max(10_000),
        operation_family: z.string().min(1).max(160),
        course_set: BatchCourseSetSchema.optional(),
        profile_digest: z.string().regex(/^[0-9a-f]{64}$/),
        plan_digest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        approval_preview_digest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        request_estimate: z.number().int().min(0).max(1_000_000).optional(),
        readback_spec_digest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        correction_facts_digest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        expires_at: z.string().datetime(),
        rate_policy: BatchRatePolicySchema.optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({
      name,
      mode,
      concurrency,
      operations,
      operation_family,
      course_set,
      profile_digest,
      plan_digest,
      approval_preview_digest,
      request_estimate,
      readback_spec_digest,
      correction_facts_digest,
      expires_at,
      rate_policy,
    }) => {
      try {
        const result = runtime.batchCreate({
          name,
          mode,
          concurrency,
          operations: operations.map((operation) => ({
            ...(operation.child_id ? { childId: operation.child_id } : {}),
            ...(operation.course_id ? { courseId: operation.course_id } : {}),
            tool: operation.tool,
            arguments: operation.arguments,
            ...(operation.source_binding_id
              ? { sourceBindingId: operation.source_binding_id }
              : {}),
            ...(operation.depends_on.length > 0 ? { dependencyChildIds: operation.depends_on } : {}),
            ...(operation.source_observation_digest ? { sourceObservationDigest: operation.source_observation_digest } : {}),
            ...(operation.readback_spec_digest ? { readbackSpecDigest: operation.readback_spec_digest } : {}),
            ...(operation.correction_facts_digest ? { correctionFactsDigest: operation.correction_facts_digest } : {}),
          })),
          operationFamily: operation_family,
          ...(course_set ? {
            courseSet: {
              source: course_set.source,
              courseIds: course_set.course_ids,
              complete: course_set.complete,
              allCoursesRequested: course_set.all_courses_requested,
              paginationComplete: course_set.pagination_complete,
              ...(course_set.snapshot_digest ? { snapshotDigest: course_set.snapshot_digest } : {}),
            },
          } : {}),
          profileDigest: profile_digest,
          ...(plan_digest ? { planDigest: plan_digest } : {}),
          ...(approval_preview_digest ? { approvalPreviewDigest: approval_preview_digest } : {}),
          ...(request_estimate === undefined ? {} : { requestEstimate: request_estimate }),
          ...(readback_spec_digest ? { readbackSpecDigest: readback_spec_digest } : {}),
          ...(correction_facts_digest ? { correctionFactsDigest: correction_facts_digest } : {}),
          expiresAt: expires_at,
          ...(ratePolicy(rate_policy) ? { ratePolicy: ratePolicy(rate_policy)! } : {}),
        });
        return textAndStructured("Created a frozen Morrow batch manifest.", result);
      } catch (error) {
        return safeFailure(error);
      }
    },
  );

  server.registerTool(
    "morrow_batch_get",
    {
      description: "Inspect one batch, its source-settlement summary, and a bounded page of child records. Decrypted child arguments are never returned.",
      inputSchema: z.object({
        batch_id: z.string().min(8).max(160),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ batch_id, offset, limit }) => {
      try {
        return textAndStructured(
          `Loaded batch ${batch_id}.`,
          runtime.batchGet({ batchId: batch_id, offset, limit }),
        );
      } catch (error) {
        return safeFailure(error);
      }
    },
  );

  server.registerTool(
    "morrow_batches_recent",
    {
      description: "List recent durable Morrow batches with an optional exact orchestration-state filter. Each batch includes a separate source-settlement summary and never returns child arguments.",
      inputSchema: z.object({
        state: z.enum(BATCH_STATES).optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ state, limit }) => {
      try {
        const result = runtime.batchesRecent({
          ...(state ? { state } : {}),
          limit,
        });
        const returned = typeof result.returned === "number" ? result.returned : 0;
        return textAndStructured(`Returned ${returned} Morrow batches.`, result);
      } catch (error) {
        return safeFailure(error);
      }
    },
  );

  server.registerTool(
    "morrow_batch_results_page",
    {
      description: "Return one bounded page of durable child results and source-settlement facts for a frozen batch.",
      inputSchema: z.object({
        batch_id: z.string().min(8).max(160),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ batch_id, offset, limit }) => {
      try {
        const result = runtime.batchResultsPage({ batchId: batch_id, offset, limit });
        return textAndStructured(`Loaded one bounded result page for batch ${batch_id}.`, result);
      } catch (error) {
        return safeFailure(error);
      }
    },
  );

  server.registerTool(
    "morrow_batch_run",
    {
      description: "Run or resume a bounded window of one frozen batch. read_only children perform reads. stage_writes children only stage existing Morrow tasks for separate human approval. Batch completion means orchestration finished, not that Canvas changes were approved or verified. Morrow serializes control for one batch and caps active windows across batches.",
      inputSchema: z.object({
        batch_id: z.string().min(8).max(160),
        max_children: z.number().int().min(1).max(500).default(50),
        course_set_digest: z.string().regex(/^[0-9a-f]{64}$/),
        profile_digest: z.string().regex(/^[0-9a-f]{64}$/),
        rate_policy: BatchRatePolicySchema.optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ batch_id, max_children, course_set_digest, profile_digest, rate_policy }) => {
      try {
        const result = await scheduler.run(batch_id, () => runtime.batchRun({
          batchId: batch_id,
          maxChildren: max_children,
          courseSetDigest: course_set_digest,
          profileDigest: profile_digest,
          ...(ratePolicy(rate_policy) ? { ratePolicy: ratePolicy(rate_policy)! } : {}),
        }));
        const batch = result.batch;
        const state = batch && typeof batch === "object" && !Array.isArray(batch)
          ? String((batch as Record<string, unknown>).state || "unknown")
          : "unknown";
        const sourceSettlement = result.sourceSettlement;
        const sourceOutcome = sourceSettlement
          && typeof sourceSettlement === "object"
          && !Array.isArray(sourceSettlement)
          ? String((sourceSettlement as Record<string, unknown>).outcome || "not_applicable")
          : "not_applicable";
        return textAndStructured(
          `Processed a bounded batch window. Orchestration is ${state}; source outcome is ${sourceOutcome}.`,
          result,
        );
      } catch (error) {
        return safeFailure(error);
      }
    },
  );

  server.registerTool(
    "morrow_batch_resume",
    {
      description: "Resume a paused frozen batch only after its supplied course-set and profile facts still match the encrypted manifest.",
      inputSchema: z.object({
        batch_id: z.string().min(8).max(160),
        max_children: z.number().int().min(1).max(500).default(50),
        course_set_digest: z.string().regex(/^[0-9a-f]{64}$/),
        profile_digest: z.string().regex(/^[0-9a-f]{64}$/),
        rate_policy: BatchRatePolicySchema.optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ batch_id, max_children, course_set_digest, profile_digest, rate_policy }) => {
      try {
        const result = await scheduler.run(batch_id, () => runtime.batchResume({
          batchId: batch_id,
          maxChildren: max_children,
          courseSetDigest: course_set_digest,
          profileDigest: profile_digest,
          ...(ratePolicy(rate_policy) ? { ratePolicy: ratePolicy(rate_policy)! } : {}),
        }));
        return textAndStructured(`Resumed a bounded batch window for ${batch_id}.`, result);
      } catch (error) {
        return safeFailure(error);
      }
    },
  );

  server.registerTool(
    "morrow_batch_reconcile",
    {
      description: "Read the current state of staged Morrow legacy tasks and update the batch source-settlement ledger. This never approves, denies, resumes, undoes, or dispatches a task. Use include_terminal to recheck tasks that were previously recorded as final, such as after a later user-initiated undo.",
      inputSchema: z.object({
        batch_id: z.string().min(8).max(160),
        offset: z.number().int().min(0).default(0),
        max_children: z.number().int().min(1).max(500).default(50),
        include_terminal: z.boolean().default(false),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ batch_id, offset, max_children, include_terminal }) => {
      try {
        const result = await scheduler.run(batch_id, () => runtime.batchReconcile({
          batchId: batch_id,
          offset,
          maxChildren: max_children,
          includeTerminal: include_terminal,
        }));
        const sourceSettlement = result.sourceSettlement;
        const sourceOutcome = sourceSettlement
          && typeof sourceSettlement === "object"
          && !Array.isArray(sourceSettlement)
          ? String((sourceSettlement as Record<string, unknown>).outcome || "unknown")
          : "unknown";
        const processed = typeof result.processed === "number" ? result.processed : 0;
        return textAndStructured(
          `Reconciled ${processed} source tasks. The batch source outcome is ${sourceOutcome}.`,
          result,
        );
      } catch (error) {
        return safeFailure(error);
      }
    },
  );

  server.registerTool(
    "morrow_batch_recover",
    {
      description: "Inspect or safely repair interrupted local batch orchestration. apply_safe may reset unknown read-only children for retry, recover a known staged task from the gateway journal, or settle a proven pre-send failure. It performs zero provider dispatches and never retries an uncertain write.",
      inputSchema: z.object({
        batch_id: z.string().min(8).max(160),
        mode: z.enum(BATCH_RECOVERY_MODES).default("inspect"),
        after_ordinal: z.number().int().min(0).default(0),
        max_children: z.number().int().min(1).max(500).default(100),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ batch_id, mode, after_ordinal, max_children }) => {
      try {
        const result = await scheduler.run(batch_id, async () => recoverGatewayBatch(runtime, {
          batchId: batch_id,
          mode,
          afterOrdinal: after_ordinal,
          maxChildren: max_children,
        }));
        return textAndStructured(
          mode === "inspect"
            ? `Inspected interrupted batch ${batch_id} without changing it.`
            : `Applied safe local recovery to batch ${batch_id} with zero provider dispatches.`,
          result,
        );
      } catch (error) {
        return safeFailure(error);
      }
    },
  );

  server.registerTool(
    "morrow_batch_pause",
    {
      description: "Pause a planned or running batch before another child window is claimed. Already running children are not cancelled or repeated.",
      inputSchema: z.object({ batch_id: z.string().min(8).max(160) }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ batch_id }) => {
      try {
        const result = await scheduler.run(batch_id, async () => runtime.batchPause(batch_id));
        return textAndStructured(
          `Paused batch ${batch_id} when its orchestration state allowed pausing.`,
          result,
        );
      } catch (error) {
        return safeFailure(error);
      }
    },
  );

  server.registerTool(
    "morrow_batch_cancel",
    {
      description: "Cancel every undispatched child in a batch. Running, unknown, or already staged source tasks remain visible and retain their independent settlement state.",
      inputSchema: z.object({ batch_id: z.string().min(8).max(160) }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ batch_id }) => {
      try {
        const result = await scheduler.run(batch_id, async () => runtime.batchCancel(batch_id));
        return textAndStructured(
          `Cancelled undispatched children in batch ${batch_id}.`,
          result,
        );
      } catch (error) {
        return safeFailure(error);
      }
    },
  );
}
