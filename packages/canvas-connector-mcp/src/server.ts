import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { augmentBridgeInputSchema } from "@morrow/bridge-protocol";
import { canvasCatalogTools } from "@morrow/canvas-api-catalog";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import * as z from "zod/v4";
import type { CanvasConnectorRuntime } from "./runtime.js";

function toolResult(value: JsonObject) {
  const ok = value.ok !== false;
  return {
    content: [{ type: "text" as const, text: ok ? "Morrow completed the Canvas connector request." : "Morrow could not complete the Canvas connector request." }],
    structuredContent: value,
    ...(!ok ? { isError: true } : {}),
  };
}

export function createCanvasConnectorMcpServer(runtime: CanvasConnectorRuntime): McpServer {
  const server = new McpServer({ name: "morrow-canvas-connector", version: "1.0.0-rc.0" });
  server.registerTool("morrow_canvas_connector_health", {
    description: "Report the local Morrow Canvas connector, full Canvas catalog, and signed-in browser-session state.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => toolResult(runtime.health()));
  server.registerTool("morrow_canvas_bindings", {
    description: "List the runtime-verified Canvas accounts available through the local Chrome connector.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => toolResult({ schema: "morrow.canvas-bindings.v1", ok: true, bindings: runtime.bindings(), count: runtime.bindings().length }));

  for (const tool of canvasCatalogTools(runtime.catalog)) {
    server.registerTool(tool.name, {
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: fromJsonSchema(augmentBridgeInputSchema(tool.inputSchema)),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      _meta: { "io.morrow/capability": tool.capability },
    }, async (argumentsValue) => toolResult(await runtime.call(tool.name, isJsonObject(argumentsValue) ? argumentsValue : {})));
  }
  return server;
}
