import { randomBytes } from "node:crypto";
import {
  McpServer,
  createRequestStateCodec,
  fromJsonSchema,
  type CallToolResult,
  type ServerContext,
  type ToolAnnotations as McpToolAnnotations,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { isJsonObject, sha256Text, type JsonObject } from "@morrow/contracts";
import { GATEWAY_OPERATION_STATES } from "@morrow/operation-journal";
import type { GatewayRuntime } from "./runtime.js";
import { MORROW_SERVER_INSTRUCTIONS } from "./server-instructions.js";
import { registerLessonReviewTool, type LessonReviewState } from "./lesson-review.js";

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

function publicToolInputSchema(schema: JsonObject): JsonObject {
  const output = structuredClone(schema);
  const properties = isJsonObject(output.properties) ? output.properties : {};
  const existing = isJsonObject(properties._morrow) ? properties._morrow : {};
  const controls = isJsonObject(existing.properties) ? existing.properties : {};
  return {
    ...output,
    type: "object",
    properties: {
      ...properties,
      _morrow: {
        ...existing,
        type: "object",
        properties: {
          ...controls,
          readback: {
            type: "object",
            description: "Optional frozen fresh-readback comparator for a mutating operation.",
            properties: {
              tool: { type: "string", minLength: 1, maxLength: 160 },
              arguments: { type: "object" },
              expected_digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
            },
            required: ["tool", "arguments", "expected_digest"],
            additionalProperties: false,
          },
          approval_ttl_ms: {
            type: "integer",
            minimum: 60000,
            maximum: 86400000,
            description: "Optional local human-approval expiry in milliseconds.",
          },
        },
        additionalProperties: false,
      },
    },
  };
}

function safeResultArtifactFailure(error: unknown): CallToolResult {
  const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
  return {
    content: [{ type: "text", text: "Morrow could not find the requested local result artifact." }],
    isError: true,
    structuredContent: {
      schema: "morrow.problem.v1",
      code: "result_artifact_unavailable",
      detailDigest: sha256Text(detail),
    },
  };
}

export function createMorrowServer(
  runtime: GatewayRuntime,
  healthProvider: () => JsonObject | Promise<JsonObject> = () => runtime.health() as unknown as JsonObject,
): McpServer {
  const reviewState = createRequestStateCodec<LessonReviewState>({
    key: randomBytes(32), ttlSeconds: 600,
    bind: (context) => `${context.mcpReq.method}\0${context.sessionId ?? ""}\0${context.http?.authInfo?.clientId ?? ""}`,
  });
  const server = new McpServer(
    {
      name: "morrow",
      version: "1.0.0-rc.0",
    },
    {
      instructions: MORROW_SERVER_INSTRUCTIONS,
      requestState: { verify: reviewState.verify },
    },
  );
  registerLessonReviewTool(server, runtime, reviewState);

  server.registerTool(
    "morrow_health",
    {
      title: "Check Morrow status",
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
      const health = await healthProvider() as unknown as ReturnType<GatewayRuntime["health"]>;
      return textAndStructured(
        health.ready
          ? `Morrow is ready with ${health.publicToolCount} public tools.`
          : "Morrow is not ready. Review the source status.",
        health as unknown as JsonObject,
      );
    },
  );

  server.registerTool(
    "morrow_result_page",
    {
      title: "Read a saved result",
      description: "Read one bounded page from a local Morrow large-result artifact. Artifacts are process-local and are not durable records.",
      inputSchema: z.object({
        handle: z.string().min(8).max(160),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(16_000).default(16_000),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ handle, offset, limit }) => {
      try {
        const page = runtime.resultPage(handle, offset, limit);
        return textAndStructured(
          `Read ${page.returned} characters from saved local result ${handle}.`,
          page,
        );
      } catch (error) {
        return safeResultArtifactFailure(error);
      }
    },
  );

  server.registerTool(
    "morrow_catalog",
    {
      title: "Browse Morrow tools",
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
        `Found ${result.totalMatches} matching tools. Showing ${result.returned} from position ${result.offset}.`,
        result as unknown as JsonObject,
      );
    },
  );

  server.registerTool(
    "morrow_catalog_search",
    {
      title: "Search Morrow tools",
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
        `Found ${result.totalMatches} matching tools. Showing ${result.returned}.`,
        result as unknown as JsonObject,
      );
    },
  );

  server.registerTool(
    "morrow_capability_get",
    {
      title: "Review a tool",
      description: "Return one canonical capability descriptor and its profile availability.",
      inputSchema: z.object({ name: z.string().min(1).max(128) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name }) => textAndStructured(
      `Here is the tool ${name}.`,
      runtime.capabilityGet(name),
    ),
  );

  server.registerTool(
    "morrow_profile_status",
    {
      title: "Review Morrow profile",
      description: "Return active profile authority identity and the capabilities unavailable in that profile.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => textAndStructured("Here is the current Morrow profile.", runtime.profileStatus()),
  );

  server.registerTool(
    "morrow_operation_get",
    {
      title: "Review a saved request",
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
          `Here is saved request ${operation_id}.`,
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
      title: "Review recent requests",
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
      return textAndStructured(`Found ${returned} saved requests.`, result);
    },
  );

  for (const tool of runtime.catalog.tools) {
    server.registerTool(
      tool.publicName,
      {
        ...(tool.title ? { title: tool.title } : {}),
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: fromJsonSchema(publicToolInputSchema(tool.inputSchema)),
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
      async (input, context: ServerContext): Promise<CallToolResult> => {
        const result = await runtime.call(tool.publicName, input as Record<string, unknown>, {
          signal: context.mcpReq.signal,
        });
        return result as unknown as CallToolResult;
      },
    );
  }

  return server;
}

export function serveMorrow(runtime: GatewayRuntime): void {
  void serveStdio(() => createMorrowServer(runtime));
}
