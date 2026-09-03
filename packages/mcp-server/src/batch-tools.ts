import type { McpServer, CallToolResult } from "@modelcontextprotocol/server";
import { BATCH_MODES, BATCH_STATES } from "@morrow/batch-engine";
import { sha256Text, type JsonObject } from "@morrow/contracts";
import * as z from "zod/v4";
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
  tool: z.string().min(1).max(128),
  arguments: z.record(z.string(), z.unknown()).default({}),
  source_binding_id: z.string().min(1).max(160).optional(),
});

export function registerBatchTools(server: McpServer, runtime: MorrowRuntime): void {
  server.registerTool(
    "morrow_batch_health",
    {
      description: "Report bounded local batch-store status. This does not read or change Canvas.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => textAndStructured("Loaded Morrow batch-store status.", runtime.batchHealth()),
  );

  server.registerTool(
    "morrow_batch_create",
    {
      description: "Freeze an explicit multi-operation manifest against the current Morrow catalog. read_only batches may use any admitted read tool. stage_writes batches currently accept only Morrow legacy write tools and create no provider mutation at this step.",
      inputSchema: z.object({
        name: z.string().min(1).max(200),
        mode: z.enum(BATCH_MODES),
        concurrency: z.number().int().min(1).max(16).default(2),
        operations: z.array(BatchOperationSchema).min(1).max(10_000),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ name, mode, concurrency, operations }) => {
      try {
        const result = runtime.batchCreate({
          name,
          mode,
          concurrency,
          operations: operations.map((operation) => ({
            ...(operation.child_id ? { childId: operation.child_id } : {}),
            tool: operation.tool,
            arguments: operation.arguments,
            ...(operation.source_binding_id
              ? { sourceBindingId: operation.source_binding_id }
              : {}),
          })),
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
      description: "Inspect one batch and a bounded page of child operation records. Decrypted child arguments are never returned.",
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
      description: "List recent durable Morrow batches with an optional exact state filter. This never returns child arguments.",
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
    "morrow_batch_run",
    {
      description: "Run or resume a bounded window of one frozen batch. read_only children perform reads. stage_writes children only stage existing Morrow tasks for separate human approval and never approve or dispatch them.",
      inputSchema: z.object({
        batch_id: z.string().min(8).max(160),
        max_children: z.number().int().min(1).max(500).default(50),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ batch_id, max_children }) => {
      try {
        const result = await runtime.batchRun({
          batchId: batch_id,
          maxChildren: max_children,
        });
        const batch = result.batch;
        const state = batch && typeof batch === "object" && !Array.isArray(batch)
          ? String((batch as Record<string, unknown>).state || "unknown")
          : "unknown";
        return textAndStructured(`Processed a bounded batch window. Batch state is ${state}.`, result);
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
        return textAndStructured(`Paused batch ${batch_id} when its state allowed pausing.`, runtime.batchPause(batch_id));
      } catch (error) {
        return safeFailure(error);
      }
    },
  );

  server.registerTool(
    "morrow_batch_cancel",
    {
      description: "Cancel every undispatched child in a batch. Running or unknown children remain visible and force partial or inspection-required truth.",
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
        return textAndStructured(`Cancelled undispatched children in batch ${batch_id}.`, runtime.batchCancel(batch_id));
      } catch (error) {
        return safeFailure(error);
      }
    },
  );
}
