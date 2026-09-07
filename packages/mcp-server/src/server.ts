import { randomBytes } from "node:crypto";
import { basename } from "node:path";
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
import {
  isJsonObject,
  normalizeRequestedBy,
  sha256Text,
  type JsonObject,
  type RequestedByIdentity,
} from "@morrow/contracts";
import { GATEWAY_OPERATION_STATES } from "@morrow/operation-journal";
import { isPrivateSourceTool, type GatewayRuntime } from "./runtime.js";
import { registerActivityTool, type ActivityGroups } from "./activity-tools.js";
import { MORROW_SERVER_INSTRUCTIONS } from "./server-instructions.js";
import { registerLessonReviewTool, type LessonReviewState } from "./lesson-review.js";
import { registerEditAccessTool, type EditAccessRequestState } from "./edit-access.js";
import { registerCourseAuditResource, registerCourseAuditTool } from "./course-audit.js";
import { registerCourseInventoryTool } from "./course-inventory.js";
import { registerProgramLedgerResource, registerProgramLedgerTool } from "./program-ledger.js";
import { registerMoodleResourceFileTool } from "./moodle-resource-file.js";
import { registerCanvasCourseFileUploadTool } from "./canvas-file-transfer.js";

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

type PublicInputValidator = {
  readonly "~standard": {
    readonly validate: (value: unknown) => unknown | Promise<unknown>;
  };
};

function publicCapabilityDescriptor(runtime: GatewayRuntime, name: string): JsonObject {
  const result = runtime.capabilityGet(name);
  const mapping = runtime.catalog.tools.find((tool) => tool.publicName === name.trim() && !isPrivateSourceTool(tool));
  if (!mapping || !isJsonObject(result.descriptor)) return result;
  return {
    ...result,
    descriptor: {
      ...result.descriptor,
      inputSchema: publicToolInputSchema(mapping.inputSchema),
    },
  };
}

function safeCapabilityInvocationFailure(code: "capability_not_found" | "capability_input_invalid" | "capability_mode_mismatch"): CallToolResult {
  return {
    content: [{ type: "text", text: "Morrow could not invoke the selected capability." }],
    isError: true,
    structuredContent: {
      schema: "morrow.problem.v1",
      code,
    },
  };
}

async function validatePublicCapabilityInput(
  validator: PublicInputValidator,
  value: unknown,
): Promise<Record<string, unknown> | undefined> {
  const result = await validator["~standard"].validate(value);
  if (!isJsonObject(result) || !isJsonObject(result.value)) return undefined;
  return result.value as Record<string, unknown>;
}

type PublicToolHandler = (input: unknown, context: ServerContext) => Promise<CallToolResult> | CallToolResult;
type ToolRegistrar = {
  registerTool: (name: string, config: unknown, handler: PublicToolHandler) => unknown;
};

function egressInput(name: string, input: unknown): Record<string, unknown> {
  if (!isJsonObject(input)) return {};
  if (["morrow_capability_read", "morrow_capability_change"].includes(name)
    && isJsonObject(input.arguments)) {
    return input.arguments;
  }
  return input;
}

/** What Morrow knows about the assistant on the other end of one connection. */
export interface MorrowServerContext {
  /** The admitted project directory for this connection. Never sent to an assistant. */
  readonly workspaceRoot?: string;
  /** The stdio process this connection arrived through. */
  readonly proxyPid?: number;
}

/**
 * Names the assistant that sent this call. The name and version are what the
 * client reported at initialize; Morrow does not verify them. The workspace is
 * named and digested here so no absolute path can reach an assistant.
 */
function requestedByIdentity(
  server: McpServer,
  sessionId: string,
  serverContext: MorrowServerContext,
): RequestedByIdentity | undefined {
  const workspaceRoot = serverContext.workspaceRoot;
  const reported = server.server.getClientVersion();
  const clientName = typeof reported?.name === "string" ? reported.name.trim() : "";
  if (!workspaceRoot || !clientName) return undefined;
  const clientVersion = typeof reported?.version === "string" && reported.version.trim()
    ? reported.version.trim()
    : "unstated";
  return normalizeRequestedBy({
    schema: "morrow.requested-by.v1",
    clientName,
    clientVersion,
    proxyPid: serverContext.proxyPid ?? process.pid,
    workspaceName: basename(workspaceRoot) || workspaceRoot,
    workspaceDigest: sha256Text(workspaceRoot),
    sessionId,
  });
}

function sessionIdOf(context: ServerContext): string {
  return typeof context.sessionId === "string" && context.sessionId ? context.sessionId : "stdio-single-client";
}

function artifactAudience(context: ServerContext): string {
  const session = typeof context.sessionId === "string" && context.sessionId ? context.sessionId : "stdio-single-client";
  const client = typeof context.http?.authInfo?.clientId === "string" && context.http.authInfo.clientId
    ? context.http.authInfo.clientId
    : "local";
  return session + "\0" + client;
}

/** Install one last response boundary before any native or catalog tool registers. */
function installMcpEgressBoundary(
  server: McpServer,
  runtime: GatewayRuntime,
  requestedBy: (context: ServerContext) => RequestedByIdentity | undefined,
): void {
  const registrar = server as unknown as ToolRegistrar;
  const original = registrar.registerTool.bind(server);
  registrar.registerTool = (name, config, handler) => original(name, config, async (input, context) => {
    const boundaryRuntime = runtime as unknown as {
      redactMcpEgress?: (value: JsonObject, request: Readonly<Record<string, unknown>>, options: { readonly signal?: AbortSignal; readonly bound?: boolean; readonly toolName?: string }) => Promise<JsonObject>;
      bindResultArtifactAudience?: (value: JsonObject, audience: string) => JsonObject;
      runAsRequester?: (identity: RequestedByIdentity | undefined, body: () => Promise<CallToolResult>) => Promise<CallToolResult>;
    };
    const call = () => handler(input, context) as Promise<CallToolResult>;
    const result = boundaryRuntime.runAsRequester
      ? await boundaryRuntime.runAsRequester(requestedBy(context), call)
      : await call();
    if (!boundaryRuntime.redactMcpEgress || !isJsonObject(result)) return result;
    const projected = await boundaryRuntime.redactMcpEgress(result, egressInput(name, input), {
      signal: context.mcpReq.signal,
      toolName: name,
    });
    return (boundaryRuntime.bindResultArtifactAudience
      ? boundaryRuntime.bindResultArtifactAudience(projected, artifactAudience(context))
      : projected) as unknown as CallToolResult;
  });
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
  serverContext: MorrowServerContext = {},
  groups?: ActivityGroups,
): McpServer {
  const workspaceRoot = serverContext.workspaceRoot;
  const reviewState = createRequestStateCodec<LessonReviewState | EditAccessRequestState>({
    key: randomBytes(32), ttlSeconds: 600,
    bind: (context) => `${context.mcpReq.method}\0${context.sessionId ?? ""}\0${context.http?.authInfo?.clientId ?? ""}`,
  });
  const server = new McpServer(
    {
      name: "morrow",
      version: "1.0.0",
    },
    {
      instructions: MORROW_SERVER_INSTRUCTIONS,
      requestState: { verify: reviewState.verify },
    },
  );
  installMcpEgressBoundary(server, runtime, (context) => requestedByIdentity(server, sessionIdOf(context), serverContext));
  registerActivityTool(server, runtime, healthProvider, {
    identityFor: (sessionId) => requestedByIdentity(server, sessionId, serverContext),
    ...(groups ? { groups } : {}),
  });
  registerLessonReviewTool(server, runtime, reviewState);
  registerEditAccessTool(server, runtime, reviewState);
  registerCourseAuditResource(server);
  registerCourseAuditTool(server, runtime);
  registerCourseInventoryTool(server, runtime);
  registerProgramLedgerResource(server);
  registerProgramLedgerTool(server, runtime);
  registerMoodleResourceFileTool(server, runtime, workspaceRoot);
  registerCanvasCourseFileUploadTool(server, runtime, workspaceRoot);

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
      // A runtime that is not ready for a named reason states that reason here,
      // because this line is what the person reads first.
      const detail = (health as unknown as JsonObject).readyDetail;
      return textAndStructured(
        health.ready
          ? `Morrow is ready with ${health.publicToolCount} public tools.`
          : typeof detail === "string" && detail.trim().length > 0
            ? detail
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
    async ({ handle, offset, limit }, context) => {
      try {
        const page = runtime.resultPage(handle, offset, limit, artifactAudience(context));
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
      publicCapabilityDescriptor(runtime, name),
    ),
  );

  const publicInputValidators = new Map(
    runtime.catalog.tools.filter((tool) => !isPrivateSourceTool(tool)).map((tool) => [
      tool.publicName,
      fromJsonSchema(publicToolInputSchema(tool.inputSchema)) as unknown as PublicInputValidator,
    ]),
  );
  const registerCapabilityInvocation = (
    name: "morrow_capability_read" | "morrow_capability_change",
    readOnly: boolean,
  ) => {
    server.registerTool(
      name,
      {
        title: readOnly ? "Read a Morrow capability" : "Change with a Morrow capability",
        description: readOnly
          ? "Call one catalog capability that is marked read-only after validating its public input schema."
          : "Plan or carry out one catalog capability that is not marked read-only after validating its public input schema.",
        inputSchema: z.object({
          name: z.string().min(1).max(128),
          arguments: z.record(z.string(), z.unknown()),
        }),
        annotations: { readOnlyHint: readOnly },
      },
      async ({ name: publicName, arguments: argumentsValue }, context: ServerContext): Promise<CallToolResult> => {
        const mapping = runtime.catalog.tools.find((tool) => tool.publicName === publicName && !isPrivateSourceTool(tool));
        const validator = publicInputValidators.get(publicName);
        if (!mapping || !validator) return safeCapabilityInvocationFailure("capability_not_found");
        if ((mapping.annotations?.readOnlyHint === true) !== readOnly) {
          return safeCapabilityInvocationFailure("capability_mode_mismatch");
        }
        const input = await validatePublicCapabilityInput(validator, argumentsValue);
        if (!input) return safeCapabilityInvocationFailure("capability_input_invalid");
        const result = await runtime.call(publicName, input, { signal: context.mcpReq.signal });
        return result as unknown as CallToolResult;
      },
    );
  };
  registerCapabilityInvocation("morrow_capability_read", true);
  registerCapabilityInvocation("morrow_capability_change", false);

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

  if (runtime.config.toolSurface === "full") {
    for (const tool of runtime.catalog.tools) {
      if (isPrivateSourceTool(tool)) continue;
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
  }

  return server;
}

export function serveMorrow(runtime: GatewayRuntime): void {
  void serveStdio(() => createMorrowServer(runtime));
}
