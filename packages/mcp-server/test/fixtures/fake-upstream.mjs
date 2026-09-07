import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { appendFileSync } from "node:fs";
import * as z from "zod/v4";

const source = String(process.env.FAKE_SOURCE || "fake").trim().toLowerCase();
const sourceToolName = `${source.replace(/[^a-z0-9]+/g, "_")}_only`;
const sourceToolIsWrite = source === "example-legacy";
const callLogPath = String(process.env.FAKE_CALL_LOG || "").trim();
const delayMilliseconds = Number(process.env.FAKE_DELAY_MS || 0);
const largeResultCharacters = Number(process.env.FAKE_LARGE_RESULT_CHARS || 0);

function note(value) {
  if (callLogPath) appendFileSync(callLogPath, `${value}\n`, "utf8");
}

async function waitForDelay(signal) {
  if (!Number.isFinite(delayMilliseconds) || delayMilliseconds <= 0) return;
  if (signal.aborted) throw new Error("fake upstream request aborted");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMilliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      note("aborted");
      reject(new Error("fake upstream request aborted"));
    }, { once: true });
  });
}

if (process.env.FAKE_STDOUT_CONTAMINATION === "1") {
  process.stdout.write("this is not MCP JSON-RPC\n");
}

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
    async ({ course_id }, context) => {
      note("canvas_page_get");
      await waitForDelay(context.mcpReq.signal);
      const large = Number.isSafeInteger(largeResultCharacters) && largeResultCharacters > 0
        ? "x".repeat(Math.min(largeResultCharacters, 2_000_000))
        : undefined;
      return {
        content: [{ type: "text", text: large || `${source}:${course_id || "none"}` }],
        structuredContent: {
          source,
          course_id: course_id || null,
          ...(large ? { large } : {}),
        },
        _meta: {
          secret: "result-metadata-must-not-pass",
        },
      };
    },
  );

  server.registerTool(
    sourceToolName,
    {
      description: `A source-only fake ${sourceToolIsWrite ? "write" : "read"} tool from ${source}.`,
      inputSchema: z.object({
        value: z.string().optional(),
        _morrow: z.object({
          operation_id: z.string().optional(),
          source_binding_id: z.string().optional(),
          outer_grant: z.object({
            plan_digest: z.string(),
            approval_grant_digest: z.string(),
            effect_receipt_id: z.string(),
            dispatch_attempt: z.literal(1),
            gateway_process_id: z.string(),
          }).optional(),
        }).optional(),
      }),
      annotations: {
        readOnlyHint: !sourceToolIsWrite,
        destructiveHint: false,
        idempotentHint: !sourceToolIsWrite,
        openWorldHint: false,
      },
    },
    async ({ value, _morrow }, context) => {
      note(sourceToolName);
      await waitForDelay(context.mcpReq.signal);
      return {
        content: [{ type: "text", text: sourceToolName }],
        structuredContent: {
          source,
          tool: sourceToolName,
          value: value || null,
          operation_id: _morrow?.operation_id || null,
        },
      };
    },
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

  const internalNames = ["morrow_browser_edit_policy_set"];
  if (process.env.FAKE_INTERNAL_BRIDGE_MAINTENANCE === "1") {
    internalNames.push("morrow_bridge_maintenance");
  }
  for (const internalName of internalNames) {
    server.registerTool(
      internalName,
      {
        description: "An internal Morrow browser control that must not reach the public catalog.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async () => ({ content: [{ type: "text", text: "not reachable" }] }),
    );
  }

  return server;
}

void serveStdio(createServer);
