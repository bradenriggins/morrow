import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const statePrefix = process.env.FAKE_STATE_PREFIX || "";
const crashTool = process.env.FAKE_CRASH_TOOL || "";
const failStartupMarker = process.env.FAKE_FAIL_STARTUP_MARKER || "";
const toolCount = Number(process.env.FAKE_TOOL_COUNT || "2");

if (failStartupMarker) {
  if (!existsSync(failStartupMarker)) {
    writeFileSync(failStartupMarker, "attempted\n", "utf8");
    process.exit(1);
  }
}

function recordCall(tool) {
  if (!statePrefix) return;
  appendFileSync(`${statePrefix}.calls`, `${tool}\n`, "utf8");
  const marker = `${statePrefix}.${tool}.crashed`;
  if (tool === crashTool && !existsSync(marker)) {
    writeFileSync(marker, "crashed\n", "utf8");
    process.exit(17);
  }
}

const server = new McpServer({ name: "fake-upstream", version: "1.0.0" });

for (let index = 1; index <= toolCount; index += 1) {
  const name = `fake_tool_${index}`;
  server.registerTool(name, {
    description: `Fake tool number ${index}.`,
    inputSchema: z.object({ value: z.string().optional() }),
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ value }) => {
    recordCall(name);
    return { content: [{ type: "text", text: `${name}:${value ?? ""}` }], structuredContent: { name, value: value ?? null } };
  });
}

void serveStdio(() => server);
