import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { augmentBridgeInputSchema } from "@morrow/bridge-protocol";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import * as z from "zod/v4";
import type { LegacyBridgeRuntime } from "./runtime.js";

function toolResult(value: JsonObject): {
  content: { type: "text"; text: string }[];
  structuredContent: JsonObject;
  isError?: boolean;
} {
  const ok = value.ok !== false;
  const summary = ok
    ? "Morrow legacy completed the bridge request."
    : "Morrow legacy could not complete the bridge request.";
  return {
    content: [{ type: "text", text: summary }],
    structuredContent: value,
    ...(!ok ? { isError: true } : {}),
  };
}

function toolMeta(runtime: LegacyBridgeRuntime, sourceToolName: string): Record<string, unknown> {
  return {
    "io.morrow/source": {
      schema: "morrow.source-tool.v1",
      sourceId: runtime.catalog.source.id,
      sourceToolName,
      sourceRevision: runtime.catalog.source.revision || null,
      sourceCatalogDigest: runtime.catalog.digest,
    },
  };
}

export function createLegacyBridgeMcpServer(runtime: LegacyBridgeRuntime): McpServer {
  const server = new McpServer({ name: "example-legacy-bridge", version: "1.0.0-alpha.1" });

  server.registerTool(
    "morrow_legacy_bridge_health",
    {
      description: "Report the local Morrow legacy bridge, source catalog, and live extension connection state.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => toolResult(runtime.health() as unknown as JsonObject),
  );

  server.registerTool(
    "morrow_legacy_bindings",
    {
      description: "List the currently connected, runtime-verified Canvas source bindings visible to the local Morrow legacy extension.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => toolResult({
      schema: "morrow.legacy-bridge.bindings.v1",
      bindings: runtime.bindings(),
      count: runtime.bindings().length,
    }),
  );

  server.registerTool(
    "morrow_legacy_task_get",
    {
      description: "Inspect one previously staged Morrow legacy task. This tool cannot approve, deny, resume, undo, or otherwise change the task.",
      inputSchema: z.object({
        task_id: z.string().min(1).max(160),
        source_binding_id: z.string().min(1).max(160).optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ task_id, source_binding_id }) => toolResult(await runtime.taskGet(task_id, source_binding_id)),
  );

  for (const tool of runtime.catalog.tools) {
    server.registerTool(
      tool.name,
      {
        ...(tool.title ? { title: tool.title } : {}),
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: fromJsonSchema(augmentBridgeInputSchema(tool.inputSchema)),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        _meta: toolMeta(runtime, tool.name),
      },
      async (argumentsValue) => {
        const args = isJsonObject(argumentsValue) ? argumentsValue : {};
        return toolResult(await runtime.call(tool.name, args));
      },
    );
  }

  return server;
}
