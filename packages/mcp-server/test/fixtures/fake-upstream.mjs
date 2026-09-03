import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const source = String(process.env.FAKE_SOURCE || "fake").trim().toLowerCase();
const sourceToolName = `${source.replace(/[^a-z0-9]+/g, "_")}_only`;

function createServer() {
  const server = new McpServer({
    name: `fake-${source}`,
    version: "1.0.0",
  });

  server.registerTool(
    "canvas_page_get",
    {
      description: `Read a fake page from ${source}.`,
      inputSchema: z.object({
        course_id: z.string().optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        secret: "catalog-metadata-must-not-pass",
      },
    },
    async ({ course_id }) => ({
      content: [{ type: "text", text: `${source}:${course_id || "none"}` }],
      structuredContent: {
        source,
        course_id: course_id || null,
      },
      _meta: {
        secret: "result-metadata-must-not-pass",
      },
    }),
  );

  server.registerTool(
    sourceToolName,
    {
      description: `A source-only fake tool from ${source}.`,
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({
      content: [{ type: "text", text: sourceToolName }],
      structuredContent: { source, tool: sourceToolName },
    }),
  );

  for (const heldName of ["mindtap_hidden", "connect_hidden"]) {
    server.registerTool(
      heldName,
      {
        description: "A held-provider fixture that must not reach the merged catalog.",
        inputSchema: z.object({}),
      },
      async () => ({ content: [{ type: "text", text: "not reachable" }] }),
    );
  }

  return server;
}

void serveStdio(createServer);
