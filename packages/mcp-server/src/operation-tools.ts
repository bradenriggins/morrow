import { type McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { sha256Text, type JsonObject } from "@morrow/contracts";
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

export function registerOperationTools(server: McpServer, runtime: GatewayRuntime): void {
  server.registerTool(
    "morrow_operation_list",
    {
      title: "Review saved requests",
      description: "List outer Morrow operations. Each record names the assistant that asked for it, as that assistant reported itself at connect time, and names its project without giving its path. This only reads the local durable operation record.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ limit }) => ({
      content: [{ type: "text", text: "Here are the saved Morrow requests." }],
      structuredContent: runtime.operationList(limit),
    }),
  );

  server.registerTool(
    "morrow_operation_dispatch",
    {
      title: "Send approved changes",
      description: "Send a frozen, approved operation only if it has not started. The local review normally starts it automatically. Check its saved state first; never dispatch an already running or uncertain operation. This never creates approval.",
      inputSchema: z.object({ operation_id: z.string().min(8).max(160) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ operation_id }) => runtime.dispatchOperation(operation_id) as unknown as CallToolResult,
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
      title: "Close a request you checked yourself",
      description: "Close one unresolved change after a person has read the item and confirmed its saved state. It requires the exact result digest of a fresh Morrow read of that item and an explicit person confirmation. Morrow does not check the change itself here and never sends anything.",
      inputSchema: z.object({
        operation_id: z.string().min(8).max(160),
        observed_state: z.string().regex(/^[0-9a-f]{64}$/, "observed_state must be the SHA-256 digest a fresh Morrow read returned"),
        confirmed_by_person: z.literal(true),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ operation_id, observed_state, confirmed_by_person }) => {
      try {
        return runtime.closeUnresolvedOperation(
          operation_id,
          observed_state,
          confirmed_by_person,
        ) as unknown as CallToolResult;
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
}
