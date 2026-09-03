import {
  McpServer,
  fromJsonSchema,
  type CallToolResult,
  type ToolAnnotations as McpToolAnnotations,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import type { JsonObject } from "@morrow/contracts";
import type { GatewayRuntime } from "./runtime.js";

function textAndStructured(summary: string, structuredContent: JsonObject): CallToolResult {
  return {
    content: [{ type: "text", text: summary }],
    structuredContent,
  };
}

export function createMorrowServer(runtime: GatewayRuntime): McpServer {
  const server = new McpServer({
    name: "morrow",
    version: "1.0.0-alpha.1",
  });

  server.registerTool(
    "morrow_health",
    {
      description: "Return Morrow gateway readiness, catalog identity, and source status without exposing commands or credentials.",
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
      description: "Search the merged Morrow tool catalog and inspect exact upstream mappings, collisions, and exclusions.",
      inputSchema: z.object({
        query: z.string().optional().describe("Optional case-insensitive name or description search."),
        source: z.string().optional().describe("Optional upstream source id, such as meridian."),
        limit: z.number().int().min(1).max(500).default(100),
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
        `Found ${result.totalMatches} matching tools and returned ${result.returned}.`,
        result as unknown as JsonObject,
      );
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
