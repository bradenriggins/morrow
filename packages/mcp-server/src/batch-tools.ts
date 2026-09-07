import type { McpServer, CallToolResult, ServerContext } from "@modelcontextprotocol/server";
import {
  BATCH_MODES,
  BATCH_RECOVERY_MODES,
  BATCH_STATES,
  CANVAS_RESULT_BINDING_KINDS,
  CANVAS_RESULT_BINDING_SCHEMA,
} from "@morrow/batch-engine";
import { sha256Text, type JsonObject } from "@morrow/contracts";
import * as z from "zod/v4";
import { batchWindowHolderLabel } from "./activity-tools.js";
import { recoverGatewayBatch } from "./batch-recovery.js";
import {
  BatchWindowQueueAbortedError,
  BatchWindowQueueFullError,
  BatchWindowQueueTimeoutError,
  type BatchWindowHolder,
  type BatchWindowMode,
} from "./batch-window-scheduler.js";
import { programInventoryInputSchema } from "./course-inventory.js";
import type { BatchChildProgress, BatchChildProgressReporter, MorrowRuntime } from "./morrow-runtime.js";

function textAndStructured(summary: string, structuredContent: JsonObject): CallToolResult {
  return {
    content: [{ type: "text", text: summary }],
    structuredContent,
  };
}

function safeFailure(error: unknown): CallToolResult {
  const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
  return {
    content: [{ type: "text", text: "Morrow could not complete this action for the group. Check the saved requests before trying again." }],
    isError: true,
    structuredContent: {
      schema: "morrow.problem.v1",
      code: "batch_operation_failed",
      recoverable: true,
      detailDigest: sha256Text(detail),
    },
  };
}

/**
 * Names the assistant that asked for a batch window, so a person can tell two
 * clients apart. The client name is the one that assistant reported; the session
 * id is Morrow's own. Falls back to the session alone when no client is named.
 * morrow_activity builds the same label, so it can say which connected session
 * holds a window.
 */
function holderLabel(runtime: MorrowRuntime, context: { readonly sessionId?: string | undefined }): string {
  const session = typeof context.sessionId === "string" && context.sessionId
    ? context.sessionId
    : "stdio-single-client";
  return batchWindowHolderLabel(
    (runtime as { gateway?: { requestedBy?: { clientName: string } } }).gateway?.requestedBy,
    session,
  );
}

/**
 * Sizes the window claim from the frozen record, so read groups whose approved request rates fit
 * together run together and a write group runs alone. A batch this cannot read claims the strictest
 * window; the run itself then reports the real reason.
 */
function windowClaim(
  runtime: MorrowRuntime,
  batchId: string,
): { readonly mode: BatchWindowMode; readonly concurrency: number } {
  try {
    const batch = runtime.batches.getBatch(batchId);
    return {
      mode: batch.mode === "stage_writes" ? "stage_writes" : "read_only",
      concurrency: batch.concurrency,
    };
  } catch {
    return { mode: "stage_writes", concurrency: 1 };
  }
}

function windowHolderText(activeBatches: readonly BatchWindowHolder[]): string {
  const current = activeBatches[0];
  if (!current) return "No group holds a batch window now.";
  return `Group ${current.batchId} has been running since ${current.startedAt} for ${current.holder}.`;
}

/** Answers a refused queue wait plainly, instead of leaving the caller waiting with no explanation. */
function windowQueueProblem(error: unknown): CallToolResult | undefined {
  if (error instanceof BatchWindowQueueTimeoutError) {
    return {
      content: [{
        type: "text",
        text: `Morrow did not start this run. It waited ${Math.round(error.waitedMs / 1000)} seconds for a batch window. `
          + `${windowHolderText(error.activeBatches)} This run sent nothing to the selected learning platform. `
          + "Check morrow_batch_health, then run this group again when a window is free.",
      }],
      isError: true,
      structuredContent: {
        schema: "morrow.problem.v1",
        code: error.code,
        recoverable: true,
        batchId: error.batchId,
        waitedMs: error.waitedMs,
        queueDepth: error.queueDepth,
        activeBatches: error.activeBatches,
      },
    };
  }
  if (error instanceof BatchWindowQueueFullError) {
    return {
      content: [{
        type: "text",
        text: `Morrow did not start this run. ${error.queueDepth} runs already wait for a batch window, `
          + `and Morrow allows ${error.maxQueuedWindows}. ${windowHolderText(error.activeBatches)} `
          + "This run sent nothing to the selected learning platform. Check morrow_batch_health before trying again.",
      }],
      isError: true,
      structuredContent: {
        schema: "morrow.problem.v1",
        code: error.code,
        recoverable: true,
        batchId: error.batchId,
        queueDepth: error.queueDepth,
        maxQueuedWindows: error.maxQueuedWindows,
        activeBatches: error.activeBatches,
      },
    };
  }
  if (error instanceof BatchWindowQueueAbortedError) {
    return {
      content: [{
        type: "text",
        text: "Morrow stopped waiting for a batch window because this request was cancelled. "
          + "This run sent nothing to the selected learning platform, and the saved group is unchanged.",
      }],
      isError: true,
      structuredContent: {
        schema: "morrow.problem.v1",
        code: error.code,
        recoverable: true,
        batchId: error.batchId,
      },
    };
  }
  return undefined;
}

/**
 * Names the course and what happened to it, in one short sentence. It is built only from the frozen
 * manifest and the state the child settled with. Nothing a learning platform returned reaches it, so
 * a learner identity cannot appear in a progress notification.
 */
function progressMessage(update: BatchChildProgress): string {
  const subject = update.courseId ? `course ${update.courseId}` : `request ${update.childId}`;
  if (update.outcome === "succeeded") return `Finished ${subject}.`;
  if (update.outcome === "failed") return `Could not complete ${subject}.`;
  return `Morrow could not confirm the result for ${subject}.`;
}

/** The progress channel for one tool call, present only when the caller asked for progress. */
interface BatchProgressChannel {
  readonly report: BatchChildProgressReporter;
  /** Waits for the queued notifications, so they reach the caller before the result. */
  readonly flush: () => Promise<void>;
}

/**
 * Sends one MCP progress notification for each child a run finishes, but only when the caller
 * supplied a progress token. A caller that supplies none sees no change and no extra work. Sends
 * are queued in the order the children finished. A client that cannot take a notification does not
 * fail a run that is already working.
 */
function batchProgress(context: ServerContext): BatchProgressChannel | undefined {
  const progressToken = context.mcpReq._meta?.progressToken;
  if (progressToken === undefined) return undefined;
  let queue: Promise<void> = Promise.resolve();
  const report: BatchChildProgressReporter = (update) => {
    const params = {
      progressToken,
      progress: update.settled,
      total: update.total,
      message: progressMessage(update),
    };
    queue = queue
      .then(() => context.mcpReq.notify({ method: "notifications/progress", params }))
      .catch(() => undefined);
  };
  return { report, flush: () => queue };
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
  result_binding: z.strictObject({
    schema: z.literal(CANVAS_RESULT_BINDING_SCHEMA),
    source_child_id: z.string().regex(/^[A-Za-z0-9_.:@-]{1,160}$/),
    kind: z.enum(CANVAS_RESULT_BINDING_KINDS),
  }).optional(),
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
  request_cost: z.number().min(0).max(1_000_000).optional(),
  rate_limit_remaining: z.number().min(0).max(1_000_000).optional(),
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
  const scheduler = runtime.batchScheduler;

  server.registerTool(
    "morrow_program_inventory_create",
    {
      title: "Prepare a selected-program inventory",
      description: "Freeze one read-only, durable inventory child for each explicitly selected Canvas or Moodle course. Running the returned batch saves each completed course inventory, including coverage gaps and eligible exact audit targets. This tool does not read or change the selected learning platform.",
      inputSchema: programInventoryInputSchema.and(z.object({
        name: z.string().min(1).max(200),
        concurrency: z.number().int().min(1).max(8).default(1),
      })),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ name, concurrency, ...inventory }) => {
      try {
        const result = await runtime.programInventoryCreate({ name, concurrency, inventory });
        return textAndStructured("Prepared the durable selected-program inventory. The selected learning platform has not changed.", result);
      } catch (error) {
        return safeFailure(error);
      }
    },
  );

  server.registerTool(
    "morrow_program_inventory_create_audit_batch",
    {
      title: "Prepare audits from a saved program inventory",
      description: "Create one read-only native audit batch from selected eligible targets in a saved selected-program inventory. Incomplete lists remain explicit coverage gaps. Eligible exact targets from other readable lists remain auditable. This tool does not read or change the selected learning platform.",
      inputSchema: z.object({
        inventory_batch_id: z.string().min(8).max(160),
        name: z.string().min(1).max(200),
        concurrency: z.number().int().min(1).max(8).default(1),
        target_ids: z.array(z.string().min(1).max(160)).max(10_000).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ inventory_batch_id, name, concurrency, target_ids }) => {
      try {
        const result = await runtime.programInventoryCreateAuditBatch({
          inventoryBatchId: inventory_batch_id,
          name,
          concurrency,
          ...(target_ids ? { targetIds: target_ids } : {}),
        });
        return textAndStructured("Prepared the durable audit batch from the saved inventory. The selected learning platform has not changed.", result);
      } catch (error) {
        return safeFailure(error);
      }
    },
  );

  server.registerTool(
    "morrow_batch_health",
    {
      title: "Check group request status",
      description: "Report bounded local batch-store, source-settlement, and scheduler status, including which group holds each batch window, when it started, which assistant session asked for it, and which runs are waiting. This does not read or change Canvas.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => textAndStructured("Here is the status of saved request groups.", {
      ...runtime.batchHealth(),
      scheduler: scheduler.health(),
    }),
  );

  server.registerTool(
    "morrow_batch_create",
    {
      title: "Prepare a group of requests",
      description: "Freeze an explicit multi-operation manifest against the current Morrow catalog. For legacy Canvas module placement, result_binding kind canvas_page_url_to_module_item_page_url binds a canvas_create_page_courses result to a Page canvas_create_module_item, and canvas_assignment_id_to_module_item_content_id binds a canvas_create_assignment result to an Assignment canvas_create_module_item. The placement must explicitly depend on its source, use the same course and connection, and omit the target field. Binding uses only a verified source result; it never accepts a caller-supplied target. Discovered course sets remain unavailable until a gateway-owned resolver receipt exists. stage_writes creates no provider mutation at this step.",
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
        const result = await runtime.batchCreate({
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
            ...(operation.result_binding ? {
              resultBinding: {
                schema: operation.result_binding.schema,
                sourceChildId: operation.result_binding.source_child_id,
                kind: operation.result_binding.kind,
              },
            } : {}),
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
        return textAndStructured("Prepared a group of requests. Canvas has not changed.", result);
      } catch (error) {
        return safeFailure(error);
      }
    },
  );

  server.registerTool(
    "morrow_batch_get",
    {
      title: "Review a group of requests",
      description: "Inspect one batch, an encrypted manifest reference, its source-settlement summary, and a bounded page of child records. The batch names the assistant that asked for it, as that assistant reported itself, and names its project without giving its path. The full manifest and decrypted child arguments are never returned.",
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
          `Here is group ${batch_id}.`,
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
      title: "Review recent request groups",
      description: "List recent durable Morrow batches with an optional exact orchestration-state filter. Each batch names the assistant that asked for it, as that assistant reported itself, includes a separate source-settlement summary, and never returns child arguments.",
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
        return textAndStructured(`Found ${returned} saved request groups.`, result);
      } catch (error) {
        return safeFailure(error);
      }
    },
  );

  server.registerTool(
    "morrow_batch_results_page",
    {
      title: "Review group request results",
      description: "Return one bounded page of durable child results and source-settlement facts for a frozen batch. An optional returned native audit child reveals only its own encrypted saved audit report.",
      inputSchema: z.object({
        batch_id: z.string().min(8).max(160),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(500).default(100),
        result_child_id: z.string().min(1).max(160).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ batch_id, offset, limit, result_child_id }, context) => {
      try {
        const result = await runtime.batchResultsPageEgress({
          batchId: batch_id,
          offset,
          limit,
          ...(result_child_id ? { resultChildId: result_child_id } : {}),
        }, context.mcpReq.signal);
        return textAndStructured(`Here is one saved result page for group ${batch_id}.`, result);
      } catch (error) {
        return safeFailure(error);
      }
    },
  );

  server.registerTool(
    "morrow_batch_run",
    {
      title: "Run a group of requests",
      description: "Run or resume a bounded window of one frozen batch. The approved manifest fixes concurrency and rate controls. read_only children perform reads. stage_writes children consume their approved provider-effect grants and dispatch once. A write batch succeeds only after every child has verified fresh readback. Morrow serializes control for one batch and caps active windows across batches. Two read groups run at the same time when their approved request rates fit inside the Bridge limit of eight requests at once. A write group runs alone. When a different group holds the window, this waits up to 60 seconds and then reports which group holds it instead of waiting longer. Two runs of the same group still take turns. A caller that supplies a progress token receives one progress notification for each child this run finishes, naming the course and its outcome; whether an assistant displays them is that assistant's own behaviour.",
      inputSchema: z.object({
        batch_id: z.string().min(8).max(160),
        max_children: z.number().int().min(1).max(500).default(50),
        course_set_digest: z.string().regex(/^[0-9a-f]{64}$/),
        profile_digest: z.string().regex(/^[0-9a-f]{64}$/),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ batch_id, max_children, course_set_digest, profile_digest }, context) => {
      const progress = batchProgress(context);
      try {
        const result = await scheduler.run(batch_id, () => runtime.batchRun({
          batchId: batch_id,
          maxChildren: max_children,
          courseSetDigest: course_set_digest,
          profileDigest: profile_digest,
          signal: context.mcpReq.signal,
          ...(progress ? { onChildSettled: progress.report } : {}),
        }), { signal: context.mcpReq.signal, holder: holderLabel(runtime, context), ...windowClaim(runtime, batch_id) });
        return textAndStructured(
          "Here is the current status of this group. Check each request's result before continuing.",
          result,
        );
      } catch (error) {
        return windowQueueProblem(error) ?? safeFailure(error);
      } finally {
        await progress?.flush();
      }
    },
  );

  server.registerTool(
    "morrow_batch_resume",
    {
      title: "Resume a group of requests",
      description: "Resume a paused frozen batch only after its supplied course-set and profile facts still match the encrypted manifest. The caller cannot replace its approved concurrency or rate controls. A caller that supplies a progress token receives one progress notification for each child this run finishes.",
      inputSchema: z.object({
        batch_id: z.string().min(8).max(160),
        max_children: z.number().int().min(1).max(500).default(50),
        course_set_digest: z.string().regex(/^[0-9a-f]{64}$/),
        profile_digest: z.string().regex(/^[0-9a-f]{64}$/),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ batch_id, max_children, course_set_digest, profile_digest }, context) => {
      const progress = batchProgress(context);
      try {
        const result = await scheduler.run(batch_id, () => runtime.batchResume({
          batchId: batch_id,
          maxChildren: max_children,
          courseSetDigest: course_set_digest,
          profileDigest: profile_digest,
          signal: context.mcpReq.signal,
          ...(progress ? { onChildSettled: progress.report } : {}),
        }), { signal: context.mcpReq.signal, holder: holderLabel(runtime, context), ...windowClaim(runtime, batch_id) });
        return textAndStructured(`Resumed part of group ${batch_id}.`, result);
      } catch (error) {
        return windowQueueProblem(error) ?? safeFailure(error);
      } finally {
        await progress?.flush();
      }
    },
  );

  server.registerTool(
    "morrow_batch_reconcile",
    {
      title: "Update group request status",
      description: "Update source-settlement evidence for staged writes that use a source-owned task. Direct Canvas connector writes settle from their verified readback and need no source-task poll. This tool never approves, denies, resumes, undoes, or dispatches a task.",
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
    async ({ batch_id, offset, max_children, include_terminal }, context) => {
      try {
        const result = await scheduler.run(batch_id, () => runtime.batchReconcile({
          batchId: batch_id,
          offset,
          maxChildren: max_children,
          includeTerminal: include_terminal,
        }), { signal: context.mcpReq.signal, holder: holderLabel(runtime, context), ...windowClaim(runtime, batch_id) });
        const processed = typeof result.processed === "number" ? result.processed : 0;
        return textAndStructured(
          `Checked ${processed} requests for updated results. Review each result before continuing.`,
          result,
        );
      } catch (error) {
        return windowQueueProblem(error) ?? safeFailure(error);
      }
    },
  );

  server.registerTool(
    "morrow_batch_recover",
    {
      title: "Recover an interrupted group",
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
    async ({ batch_id, mode, after_ordinal, max_children }, context) => {
      try {
        const result = await scheduler.run(batch_id, async () => recoverGatewayBatch(runtime, {
          batchId: batch_id,
          mode,
          afterOrdinal: after_ordinal,
          maxChildren: max_children,
        }), { signal: context.mcpReq.signal, holder: holderLabel(runtime, context), ...windowClaim(runtime, batch_id) });
        return textAndStructured(
          mode === "inspect"
            ? `Reviewed interrupted group ${batch_id} without changing it.`
            : `Updated the saved records for group ${batch_id}. This action sent no changes to Canvas.`,
          result,
        );
      } catch (error) {
        return windowQueueProblem(error) ?? safeFailure(error);
      }
    },
  );

  server.registerTool(
    "morrow_batch_pause",
    {
      title: "Pause a group of requests",
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
        const result = runtime.batchPause(batch_id);
        return textAndStructured(
          `Paused group ${batch_id} when its current status allowed pausing.`,
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
      title: "Cancel unsent group requests",
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
        const result = runtime.batchCancel(batch_id);
        return textAndStructured(
          `Cancelled unsent requests in group ${batch_id}.`,
          result,
        );
      } catch (error) {
        return safeFailure(error);
      }
    },
  );
}
