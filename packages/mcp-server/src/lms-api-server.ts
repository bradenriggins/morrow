import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import * as z from "zod/v4";
import { lmsTool, type LmsApiRuntime } from "./lms-api.js";

function result(value: JsonObject) {
  const verification = isJsonObject(value.verification) ? value.verification : {};
  return {
    content: [{ type: "text" as const, text: value.ok === false ? String(value.message)
      : verification.status === "verified" ? "Morrow checked the saved change and confirmed the requested result."
      : verification.status ? "Morrow could not confirm the requested result. Do not repeat the change."
      : "Morrow read the learning-platform information." }],
    structuredContent: value,
    ...(value.ok === false ? { isError: true } : {}),
  };
}

export function createLmsApiServer(runtime: LmsApiRuntime): McpServer {
  const server = new McpServer({ name: "morrow-lms-api", version: "1.0.0-rc.0" });
  server.registerTool("morrow_lms_connections", {
    title: "Show Moodle and Blackboard connections",
    description: "List locally configured connections without credentials. A saved connection is not proof that sign-in or course access still works. Use a course read to check it.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { "io.morrow/capability": { provider: "local", route: { backend: "lms-api" } } },
  }, () => result(runtime.connectionList()));
  for (const operation of runtime.operations) {
    const tool = lmsTool(operation);
    server.registerTool(tool.name, {
      title: tool.title!, description: tool.description!, inputSchema: fromJsonSchema(tool.inputSchema),
      annotations: tool.annotations, _meta: { "io.morrow/capability": tool.capability },
    }, async (args, ctx) => result(await runtime.call(tool.name, args as JsonObject, ctx.mcpReq.signal)));
  }
  return server;
}
