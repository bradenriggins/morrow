import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { augmentBridgeInputSchema } from "@morrow/bridge-protocol";
import { canvasCatalogTools } from "@morrow/canvas-api-catalog";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import * as z from "zod/v4";
import type { CanvasConnectorRuntime } from "./runtime.js";

export function canvasConnectorSummary(value: JsonObject): string {
  if (value.ok === false) return "Morrow could not complete the Canvas request.";
  if (value.schema === "morrow.canvas-connector.health.v1") {
    return value.ready === true
      ? "Morrow checked the connection. The extension is connected to Morrow."
      : "Morrow checked the connection. The extension is not connected to Morrow.";
  }
  if (value.schema === "morrow.canvas-bindings.v1") {
    return "Morrow checked the available Canvas connections.";
  }
  if (value.schema !== "morrow.canvas-connector.result.v1") {
    return "Morrow checked the Canvas connection.";
  }
  if (value.commandKind === "invoke_read") return "Morrow read Canvas data.";
  if (value.commandKind !== "invoke_write") return "Morrow checked the Canvas connection.";

  const browser = isJsonObject(value.result) ? value.result : null;
  const verification = browser && isJsonObject(browser.verification)
    && browser.verification.schema === "morrow.browser-verification.v1"
    ? browser.verification
    : null;
  if (verification?.status === "verified") {
    return "Morrow confirmed the Canvas change with a fresh Canvas check.";
  }
  if (verification?.status === "mismatch") {
    return "Morrow could not confirm this change because Canvas returned a different result. Ask your assistant to check the existing request. Do not repeat this change.";
  }
  return "Morrow could not confirm this change. Ask your assistant to check the existing request. Do not repeat this change.";
}

function toolResult(value: JsonObject) {
  const ok = value.ok !== false;
  return {
    content: [{ type: "text" as const, text: canvasConnectorSummary(value) }],
    structuredContent: value,
    ...(!ok ? { isError: true } : {}),
  };
}

export function createCanvasConnectorMcpServer(runtime: CanvasConnectorRuntime): McpServer {
  const server = new McpServer({ name: "morrow-canvas-connector", version: "1.0.0-rc.0" });
  server.registerTool("morrow_canvas_connector_health", {
    title: "Check the Chrome connection",
    description: "Report the local Morrow Canvas connector, full Canvas catalog, and signed-in browser-session state.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => toolResult(runtime.health()));
  server.registerTool("morrow_canvas_bindings", {
    title: "Show saved Canvas connections",
    description: "List the runtime-verified Canvas accounts available through the local Chrome connector.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => toolResult({ schema: "morrow.canvas-bindings.v1", ok: true, bindings: runtime.bindings(), count: runtime.bindings().length }));

  for (const tool of canvasCatalogTools(runtime.catalog)) {
    server.registerTool(tool.name, {
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: fromJsonSchema(augmentBridgeInputSchema(tool.inputSchema, tool.name === "canvas_update_create_page_courses")),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      _meta: { "io.morrow/capability": tool.capability },
    }, async (argumentsValue) => toolResult(await runtime.call(tool.name, isJsonObject(argumentsValue) ? argumentsValue : {})));
  }
  return server;
}
