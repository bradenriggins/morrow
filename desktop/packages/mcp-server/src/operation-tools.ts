import { type McpServer, type CallToolResult, type ServerContext } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { isJsonObject, sha256Text, type JsonObject } from "@morrow/contracts";
import { canonicalMorrowResult } from "@morrow/gateway-core";
import type { GatewayRuntime } from "./runtime.js";

function failure(operationId: string, action: string, error: unknown): CallToolResult {
  const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
  return {
    content: [{ type: "text", text: `Morrow could not ${action} this request. Check the saved request before trying again.` }],
    isError: true,
    structuredContent: {
      schema: "morrow.result.v1",
      operationId,
      phase: "rejected",
      verification: { status: "not_requested" },
      data: { schema: "morrow.problem.v1", code: "operation_unavailable", detailDigest: sha256Text(detail) },
    },
  };
}

/** A runtime that can also report a saved batch's approval status. GatewayRuntime does not carry this
 * method itself (it lives on the wider MorrowRuntime, which wraps a GatewayRuntime); the wait tool reads
 * it only when the server that registered it supplied one, so a caller polling a batch on a server that
 * did not gets a clear "unavailable" failure instead of a crash. */
interface BatchStatusCapableRuntime {
  batchApprovalStatus?(batchId: string): JsonObject;
}

/** A runtime that can also mint a link to the review server's `/recent` page (WI-6.4, F20). The
 * one-time entry code has to come from the same LoopbackApprovalServer instance that will later
 * exchange it for a cookie, so GatewayRuntime alone cannot build this link; a server composition
 * that started a review server reads this the same optional way morrow_operation_wait already
 * reads BatchStatusCapableRuntime above, so a composition that did not gets a clear "unavailable"
 * failure instead of a crash. */
interface RecentChangesCapableRuntime {
  recentChangesUrl?(): string;
}

/** The operation states `morrow_operation_wait` keeps polling through. Any other reported state,
 * known or not, ends the wait: the point of this tool is to sleep through a review a person has not
 * answered yet and the work Morrow is applying, not to model every state an operation can reach. */
const OPERATION_REVIEW_OPEN_STATES: ReadonlySet<string> = new Set(["awaiting_approval"]);
const OPERATION_APPLYING_STATES: ReadonlySet<string> = new Set(["approved", "dispatching"]);

const REVIEW_OPEN_ATTENTION = "The person has not approved yet. Say that the review is still open. Call morrow_operation_wait again when they are ready. Do not call it more than 6 times in a row.";
const APPLYING_ATTENTION = "The person approved. Morrow is still applying what they approved. Call morrow_operation_wait again to wait for the result.";
const WORKING_ATTENTION = "Morrow is still working on this. Call morrow_operation_wait again to wait for the result.";
const EDIT_ACCESS_OPEN_ATTENTION = "The person has not turned on Edit yet. Say that the Edit access review is still open. Call morrow_operation_wait again when they are ready. Do not call it more than 6 times in a row.";
const EDIT_ACCESS_APPLYING_ATTENTION = "The person selected Turn on Edit. Morrow is saving it in Morrow Bridge. Call morrow_operation_wait again to wait for the result.";
const EDIT_CHANGE_NOT_SENT = "Edit already allows this change, and nothing has sent it yet. Send it with morrow_operation_dispatch. If it belongs to a group, run the group with morrow_batch_run instead.";
const EDIT_BATCH_NOT_STARTED = "Edit already allows these changes, and nothing has sent them yet. Run them with morrow_batch_run.";
const APPROVED_BATCH_NOT_RUNNING = "The person approved these changes, and nothing is sending them now. Run them with morrow_batch_run.";
const BATCH_NOT_RUNNING = "Nothing is running this group now. Run its remaining requests with morrow_batch_run.";

const WAIT_POLL_INTERVAL_MS = 500;
const WAIT_PROGRESS_INTERVAL_MS = 5000;

/** Resolves after `ms`, or as soon as `signal` aborts, whichever comes first. Never rejects: an abort
 * ends the wait loop through its own check of `signal.aborted`, not through a thrown error. */
function waitDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

interface WaitSnapshot {
  readonly record: JsonObject;
  readonly state: string;
  /** Whether the person still has to answer the review, Morrow is applying the work, nothing runs
   * work that is ready to start, or the work ended. */
  readonly phase: "review_open" | "applying" | "idle" | "ended";
  /** What to tell the assistant: while the wait runs out, or when it ends because nothing runs. */
  readonly attention?: string;
}

function editAllowed(record: JsonObject): boolean {
  const plan = record.plan;
  return isJsonObject(plan) && isJsonObject(plan.authorization) && plan.authorization.kind === "edit_scope";
}

/** Reads the current state of the one id the caller named, from whichever store holds it. An
 * operation id is read with `operationGet`, the same call `morrow_operation_get` makes. A batch id
 * needs `batchApprovalStatus`, read from the batch's own `state` field, because a batch has no single
 * outer operation record of its own. An Edit access id is read from the runtime's open Edit access
 * reviews. Work a person approved is started by the review page; work that Edit allows, or a
 * group's next window, is started only by the assistant's own call. */
function readWaitSnapshot(runtime: GatewayRuntime, composition: OperationToolComposition, operationId: string | undefined, batchId: string | undefined, editAccessId?: string): WaitSnapshot {
  if (editAccessId !== undefined) {
    const record = runtime.editAccessReviewResult(editAccessId);
    const state = typeof record.state === "string" ? record.state : "unknown";
    if (state === "awaiting_approval") return { record, state, phase: "review_open", attention: EDIT_ACCESS_OPEN_ATTENTION };
    if (state === "applying") return { record, state, phase: "applying", attention: EDIT_ACCESS_APPLYING_ATTENTION };
    return { record, state, phase: "ended" };
  }
  if (operationId !== undefined) {
    const record = runtime.operationGet(operationId);
    const state = typeof record.state === "string" ? record.state : "unknown";
    if (OPERATION_REVIEW_OPEN_STATES.has(state)) return { record, state, phase: "review_open", attention: REVIEW_OPEN_ATTENTION };
    if (!OPERATION_APPLYING_STATES.has(state)) return { record, state, phase: "ended" };
    if (!editAllowed(record)) return { record, state, phase: "applying", attention: APPLYING_ATTENTION };
    return state === "approved"
      ? { record, state, phase: "idle", attention: EDIT_CHANGE_NOT_SENT }
      : { record, state, phase: "applying", attention: WORKING_ATTENTION };
  }
  if (typeof composition.batchApprovalStatus !== "function") {
    throw new Error("this server cannot report a batch's approval status");
  }
  const record = composition.batchApprovalStatus(batchId as string);
  const batch = record.batch;
  const state = isJsonObject(batch) && typeof batch.state === "string" ? batch.state : "unknown";
  if (state !== "planned" && state !== "running") return { record, state, phase: "ended" };
  if (state === "planned" && record.approval === "awaiting_approval") return { record, state, phase: "review_open", attention: REVIEW_OPEN_ATTENTION };
  // `applying` says a batch window runs this batch now or a run waits for one. A planned or running
  // batch that no window holds does not change until the assistant runs it.
  if (record.applying === true) {
    return { record, state, phase: "applying", attention: record.approval === "approved" ? APPLYING_ATTENTION : WORKING_ATTENTION };
  }
  const attention = state === "running" ? BATCH_NOT_RUNNING
    : record.approval === "edit" ? EDIT_BATCH_NOT_STARTED
      : record.approval === "approved" ? APPROVED_BATCH_NOT_RUNNING
        : BATCH_NOT_RUNNING;
  return { record, state, phase: "idle", attention };
}

/** What the wider server composition adds to a GatewayRuntime for these tools. */
export type OperationToolComposition = BatchStatusCapableRuntime & RecentChangesCapableRuntime;

export function registerOperationTools(
  server: McpServer,
  runtime: GatewayRuntime,
  composition: OperationToolComposition = runtime as unknown as OperationToolComposition,
): void {
  server.registerTool(
    "morrow_operation_list",
    {
      title: "Review saved requests",
      description: "List outer Morrow operations. Each page includes an opaque cursor for the next older page and complete saved-operation counts. Each record names the assistant that asked for it, as that assistant reported itself at connect time, and names its project without giving its path. This only reads the local durable operation record.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).default(50),
        cursor: z.string().min(8).max(512).optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ limit, cursor }) => ({
      content: [{ type: "text", text: "Here are the saved Morrow requests." }],
      structuredContent: runtime.operationList(limit, cursor),
    }),
  );

  server.registerTool(
    "morrow_operation_wait",
    {
      title: "Wait for a review to be answered",
      description: "Poll one saved operation, batch, or Edit access review and return as soon as a person answers its review or Morrow finishes the work, or when the wait ends, whichever is first. When nothing is running work that is ready to start, it returns at once and names the call that starts it. Call this instead of asking the person whether they are done. It never sends a request to the source provider, and it never starts or changes the operation it watches.",
      inputSchema: z.object({
        operation_id: z.string().min(8).max(160).optional(),
        batch_id: z.string().min(1).max(160).optional(),
        edit_access_id: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
        max_wait_seconds: z.number().int().min(1).max(50).default(25),
      }).refine((input) => [input.operation_id, input.batch_id, input.edit_access_id].filter((value) => value !== undefined).length === 1, {
        message: "Name exactly one of operation_id, batch_id, or edit_access_id.",
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ operation_id, batch_id, edit_access_id, max_wait_seconds }, context: ServerContext) => {
      const id = (operation_id ?? batch_id ?? edit_access_id) as string;
      try {
        const startedAt = Date.now();
        const deadlineAt = startedAt + max_wait_seconds * 1000;
        const progressToken = context.mcpReq._meta?.progressToken;
        let lastProgressAt = startedAt;
        let snapshot = readWaitSnapshot(runtime, composition, operation_id, batch_id, edit_access_id);
        while ((snapshot.phase === "review_open" || snapshot.phase === "applying") && Date.now() < deadlineAt && !context.mcpReq.signal.aborted) {
          const now = Date.now();
          if (progressToken !== undefined && now - lastProgressAt >= WAIT_PROGRESS_INTERVAL_MS) {
            lastProgressAt = now;
            context.mcpReq.notify({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: Math.round((now - startedAt) / 1000),
                total: max_wait_seconds,
                message: `Still waiting for ${id}.`,
              },
            }).catch(() => undefined);
          }
          await waitDelay(Math.min(WAIT_POLL_INTERVAL_MS, Math.max(0, deadlineAt - Date.now())), context.mcpReq.signal);
          if (context.mcpReq.signal.aborted) break;
          snapshot = readWaitSnapshot(runtime, composition, operation_id, batch_id, edit_access_id);
        }
        const seconds = Math.round((Date.now() - startedAt) / 1000);
        const timedOut = !context.mcpReq.signal.aborted && (snapshot.phase === "review_open" || snapshot.phase === "applying");
        const attention = Array.isArray(snapshot.record.attention)
          ? snapshot.record.attention.filter((entry): entry is string => typeof entry === "string")
          : [];
        if ((timedOut || snapshot.phase === "idle") && snapshot.attention) attention.push(snapshot.attention);
        return {
          content: [{ type: "text", text: `Here is saved request ${id}.` }],
          structuredContent: {
            ...snapshot.record,
            ...(attention.length ? { attention } : {}),
            waited: { seconds, timedOut },
          },
        };
      } catch (error) {
        return failure(id, "wait for", error);
      }
    },
  );

  server.registerTool(
    "morrow_operation_dispatch",
    {
      title: "Send approved changes",
      description: "Send a frozen, approved operation only if it has not started. The local review normally starts it automatically. Check its saved state first; never dispatch an already running or uncertain operation. This never creates approval.",
      inputSchema: z.object({ operation_id: z.string().min(8).max(160) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ operation_id }, context) => runtime.dispatchOperation(operation_id, { signal: context.mcpReq.signal }) as unknown as CallToolResult,
  );

  server.registerTool(
    "morrow_operation_cancel",
    {
      title: "Cancel an unsent request",
      description: "Cancel one un-dispatched outer operation. This cannot cancel a source provider effect.",
      inputSchema: z.object({ operation_id: z.string().min(8).max(160) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ operation_id }) => {
      try {
        const cancelled = runtime.cancelOperation(operation_id);
        return {
          ...canonicalMorrowResult({
            operationId: operation_id,
            tool: "morrow_operation_cancel",
            phase: "cancelled",
            effectState: typeof cancelled.state === "string" ? cancelled.state : "cancelled",
            verificationStatus: "not_requested",
            result: {
              content: [{ type: "text", text: `Cancelled Morrow operation ${operation_id} before dispatch.` }],
              structuredContent: cancelled,
            },
          }),
        } as unknown as CallToolResult;
      } catch (error) {
        return failure(operation_id, "cancel", error);
      }
    },
  );

  server.registerTool(
    "morrow_operation_reconcile",
    {
      title: "Check a request's current status",
      description: "Run the frozen readback for an unsettled operation when available. It never replays a provider request.",
      inputSchema: z.object({ operation_id: z.string().min(8).max(160) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ operation_id }) => {
      try {
        return await runtime.reconcileOperation(operation_id) as unknown as CallToolResult;
      } catch (error) {
        return failure(operation_id, "check", error);
      }
    },
  );

  server.registerTool(
    "morrow_operation_verify",
    {
      title: "Check a saved change",
      description: "Run only the frozen readback plan for an operation and compare fresh evidence to its frozen expected digest. It never infers verification from dispatch success.",
      inputSchema: z.object({ operation_id: z.string().min(8).max(160) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ operation_id }) => {
      try {
        return await runtime.verifyOperation(operation_id) as unknown as CallToolResult;
      } catch (error) {
        return failure(operation_id, "confirm", error);
      }
    },
  );

  server.registerTool(
    "morrow_operation_close_unresolved",
    {
      title: "Ask the person to close a request they checked",
      description: "Prepare the close-out of one unresolved change that a person checked in the learning platform. This closes nothing. It returns the change's status page (statusUrl), where the person confirms with their own click that they checked the item, and only that click closes the request. For a change Morrow can read back, first read the item with Morrow and pass the exact result digest that read returned as observed_state. Morrow does not check the change itself here and never sends anything.",
      inputSchema: z.object({
        operation_id: z.string().min(8).max(160),
        observed_state: z.string().regex(/^[0-9a-f]{64}$/, "observed_state must be the SHA-256 digest a fresh Morrow read returned").optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ operation_id, observed_state }) => {
      try {
        return await runtime.requestPersonClose(operation_id, observed_state) as unknown as CallToolResult;
      } catch (error) {
        return failure(operation_id, "close", error);
      }
    },
  );

  server.registerTool(
    "morrow_operation_undo",
    {
      title: "Create a correction request",
      description: "Create a new, separately approved correction operation. It never replays or mutates the original operation.",
      inputSchema: z.object({
        operation_id: z.string().min(8).max(160),
        correction_tool: z.string().min(1).max(160),
        correction_arguments: z.record(z.string(), z.unknown()),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ operation_id, correction_tool, correction_arguments }) => {
      try {
        return runtime.undoOperation(
          operation_id,
          correction_tool,
          correction_arguments as JsonObject,
        ) as unknown as CallToolResult;
      } catch (error) {
        return failure(operation_id, "create a correction for", error);
      }
    },
  );

  server.registerTool(
    "morrow_recent_changes",
    {
      title: "See recent changes",
      description: "Give the person a one-time link to Morrow's recent changes page: the last 50 operations that reached an end, each with its plain label, course, item reference, time, state, and a link to its own status page. A change Morrow may have sent also carries a ready request to reverse it; a cancelled change or one that was never sent says nothing was sent and offers no reverse request. The Bridge never links here on its own; this tool and a result page's own \"See recent changes\" link are the only ways to it.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async () => {
      const capable = composition;
      if (typeof capable.recentChangesUrl !== "function") {
        return failure("recent_changes", "open", new Error("this server has no recent changes page"));
      }
      try {
        const url = capable.recentChangesUrl();
        return {
          content: [{ type: "text", text: `Here is the link to Morrow's recent changes: ${url}` }],
          structuredContent: { schema: "morrow.recent_changes_link.v1", url },
        };
      } catch (error) {
        return failure("recent_changes", "open", error);
      }
    },
  );
}
