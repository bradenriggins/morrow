import { type McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { sha256Text, type JsonObject } from "@morrow/contracts";
import { canonicalMorrowResult } from "@morrow/gateway-core";
import type { GatewayRuntime } from "./runtime.js";

function failure(operationId: string, action: string, error: unknown): CallToolResult {
  const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
  return {
    content: [{ type: "text", text: `Morrow could not ${action} this operation.` }],
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
      description: "List outer Morrow operations. This only reads the local durable operation record.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ limit }) => ({
      content: [{ type: "text", text: "Loaded outer Morrow operations." }],
      structuredContent: runtime.operationList(limit),
    }),
  );

  server.registerTool(
    "morrow_operation_dispatch",
    {
      description: "Dispatch one previously frozen operation after a human grants approval through Morrow's separate loopback approval service. This never creates approval.",
      inputSchema: z.object({ operation_id: z.string().min(8).max(160) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ operation_id }) => runtime.dispatchOperation(operation_id) as unknown as CallToolResult,
  );

  server.registerTool(
    "morrow_operation_cancel",
    {
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
      description: "Return the current outer operation state and state that source-provider evidence is still required. It does not replay a provider request.",
      inputSchema: z.object({ operation_id: z.string().min(8).max(160) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ operation_id }) => {
      try {
        return runtime.reconcileOperation(operation_id) as unknown as CallToolResult;
      } catch (error) {
        return failure(operation_id, "reconcile", error);
      }
    },
  );

  server.registerTool(
    "morrow_operation_verify",
    {
      description: "Run only the frozen readback plan for an operation and compare fresh evidence to its frozen expected digest. It never infers verification from dispatch success.",
      inputSchema: z.object({ operation_id: z.string().min(8).max(160) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ operation_id }) => {
      try {
        return await runtime.verifyOperation(operation_id) as unknown as CallToolResult;
      } catch (error) {
        return failure(operation_id, "verify", error);
      }
    },
  );

  server.registerTool(
    "morrow_operation_undo",
    {
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
