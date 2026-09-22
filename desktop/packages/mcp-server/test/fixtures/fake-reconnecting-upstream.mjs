import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const statePrefix = process.env.FAKE_STATE_PREFIX || "";
const crashTool = process.env.FAKE_CRASH_TOOL || "";

function recordCall(tool) {
  if (!statePrefix) return;
  appendFileSync(`${statePrefix}.calls`, `${tool}\n`, "utf8");
  const marker = `${statePrefix}.${tool}.crashed`;
  if (tool === crashTool && !existsSync(marker)) {
    writeFileSync(marker, "crashed\n", "utf8");
    process.exit(17);
  }
}

const server = new McpServer({ name: "fake-meridian", version: "1.0.0" });

server.registerTool("canvas_page_get", {
  inputSchema: z.object({ course_id: z.string() }),
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ course_id }) => {
  recordCall("canvas_page_get");
  return {
    content: [{ type: "text", text: `read:${course_id}` }],
    structuredContent: { course_id },
  };
});

server.registerTool("canvas_page_update", {
  inputSchema: z.object({ course_id: z.string(), body: z.string() }),
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ course_id }) => {
  recordCall("canvas_page_update");
  return {
    content: [{ type: "text", text: `updated:${course_id}` }],
    structuredContent: { course_id, updated: true },
  };
});

for (const name of ["mindtap_hidden", "connect_hidden"]) {
  server.registerTool(name, {
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async () => ({ content: [{ type: "text", text: "held" }] }));
}

void serveStdio(() => server);
