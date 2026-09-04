import {
  McpServer,
  fromJsonSchema,
  type CallToolResult,
  type ToolAnnotations as McpToolAnnotations,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { sha256Text, type JsonObject } from "@morrow/contracts";
import { GATEWAY_OPERATION_STATES } from "@morrow/operation-journal";
import type { GatewayRuntime } from "./runtime.js";
import { MORROW_SERVER_INSTRUCTIONS } from "./server-instructions.js";

function textAndStructured(summary: string, structuredContent: JsonObject): CallToolResult {
  return {
    content: [{ type: "text", text: summary }],
    structuredContent,
  };
}

function safeInspectionFailure(error: unknown): CallToolResult {
  const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
  return {
    content: [{ type: "text", text: "Morrow could not find the requested gateway operation." }],
    isError: true,
    structuredContent: {
      schema: "morrow.problem.v1",
      code: "gateway_operation_unavailable",
      detailDigest: sha256Text(detail),
    },
  };
}

export function createMorrowServer(runtime: GatewayRuntime): McpServer {
  const server = new McpServer(
    {
      name: "morrow",
      version: "1.0.0-alpha.1",
    },
    {
      instructions: MORROW_SERVER_INSTRUCTIONS,
    },
  );

  server.registerTool(
    "morrow_health",
    {
      description: "Return Morrow gateway readiness, catalog identity, source status, and durable operation-journal status without exposing commands or credentials.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const health = runtime.health();
      return textAndStructured(
        health.ready
          ? `Morrow is ready with ${health.publicToolCount} public tools.`
          : "Morrow is not ready. Inspect the structured source status.",
        health as unknown as JsonObject,
      );
    },
  );

  server.registerTool(
    "morrow_catalog",
    {
      description: "Search a bounded projection of the merged Morrow tool catalog and inspect source mappings, collisions, and exclusions without returning full schemas.",
      inputSchema: z.object({
        query: z.string().optional().describe("Optional case-insensitive name or description search."),
        source: z.string().optional().describe("Optional upstream source id, such as meridian."),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(50),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const result = runtime.searchCatalog(input);
      return textAndStructured(
        `Found ${result.totalMatches} matching tools and returned ${result.returned} from offset ${result.offset}.`,
        result as unknown as JsonObject,
      );
    },
  );

  server.registerTool(
    "morrow_catalog_search",
    {
      description: "Search the current profile's supported capability catalog without returning full schemas.",
      inputSchema: z.object({
        query: z.string().optional(),
        source: z.string().optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(50),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const result = runtime.searchCatalog(input);
      return textAndStructured(
        `Found ${result.totalMatches} matching capabilities and returned ${result.returned}.`,
        result as unknown as JsonObject,
      );
    },
  );

  server.registerTool(
    "morrow_capability_get",
    {
      description: "Return one canonical capability descriptor and its profile availability.",
      inputSchema: z.object({ name: z.string().min(1).max(128) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name }) => textAndStructured(
      `Loaded capability ${name}.`,
      runtime.capabilityGet(name),
    ),
  );

  server.registerTool(
    "morrow_profile_status",
    {
      description: "Return active profile authority identity and the capabilities unavailable in that profile.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => textAndStructured("Loaded current Morrow profile status.", runtime.profileStatus()),
  );

  server.registerTool(
    "morrow_operation_get",
    {
      description: "Inspect one durable gateway operation record by its opaque operation id. This does not query or change the source provider.",
      inputSchema: z.object({
        operation_id: z.string().min(8).max(160),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ operation_id }) => {
      try {
        return textAndStructured(
          `Loaded gateway operation ${operation_id}.`,
          runtime.operationGet(operation_id),
        );
      } catch (error) {
        return safeInspectionFailure(error);
      }
    },
  );

  server.registerTool(
    "morrow_operations_recent",
    {
      description: "List recent durable gateway operations with optional exact source, tool, and state filters. Stored records contain digests and bounded status, not raw provider payloads.",
      inputSchema: z.object({
        source: z.string().min(1).max(160).optional(),
        tool: z.string().min(1).max(160).optional(),
        state: z.enum(GATEWAY_OPERATION_STATES).optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const result = runtime.operationsRecent(input);
      const returned = typeof result.returned === "number" ? result.returned : 0;
      return textAndStructured(`Returned ${returned} gateway operations.`, result);
    },
  );

  for (const tool of runtime.catalog.tools) {
    server.registerTool(
      tool.publicName,
      {
        ...(tool.title ? { title: tool.title } : {}),
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: fromJsonSchema(tool.inputSchema),
        ...(tool.annotations
          ? { annotations: tool.annotations as McpToolAnnotations }
          : {}),
        _meta: {
          "io.morrow/source": {
            upstreamId: tool.upstreamId,
            upstreamToolName: tool.upstreamName,
            catalogDigest: runtime.catalog.digest,
          },
        },
      },
      async (input): Promise<CallToolResult> => {
        const result = await runtime.call(tool.publicName, input as Record<string, unknown>);
        return result as unknown as CallToolResult;
      },
    );
  }

  return server;
}

export function serveMorrow(runtime: GatewayRuntime): void {
  void serveStdio(() => createMorrowServer(runtime));
}
