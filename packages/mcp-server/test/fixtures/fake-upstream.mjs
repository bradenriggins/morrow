import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { appendFileSync } from "node:fs";
import * as z from "zod/v4";

const source = String(process.env.FAKE_SOURCE || "fake").trim().toLowerCase();
const sourceToolName = `${source.replace(/[^a-z0-9]+/g, "_")}_only`;
const sourceToolIsWrite = source === "morrow-legacy";
const callLogPath = String(process.env.FAKE_CALL_LOG || "").trim();
const lifecycleLogPath = String(process.env.FAKE_LIFECYCLE_LOG || "").trim();
const delayMilliseconds = Number(process.env.FAKE_DELAY_MS || 0);
const largeResultCharacters = Number(process.env.FAKE_LARGE_RESULT_CHARS || 0);

function note(value) {
  if (callLogPath) appendFileSync(callLogPath, `${value}\n`, "utf8");
}

let lifecycleStopped = false;
function noteLifecycle(value) {
  if (lifecycleLogPath) appendFileSync(lifecycleLogPath, `${value}\n`, "utf8");
}

function stopFromSignal() {
  if (!lifecycleStopped) {
    lifecycleStopped = true;
    noteLifecycle("stopped");
  }
  process.exit(0);
}

noteLifecycle("started");
process.once("SIGTERM", stopFromSignal);
process.once("SIGINT", stopFromSignal);
process.once("exit", () => {
  if (!lifecycleStopped) noteLifecycle("stopped");
});

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

// The last value each course accepted through the source-only write, so the
// source's own read can return what it holds.
const pageValues = new Map();

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
          ...(course_id && pageValues.has(course_id) ? pageValues.get(course_id) : {}),
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
        course_id: z.string().optional(),
        page_id: z.string().optional(),
        note: z.string().optional(),
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
      // A write names the read-only tool that reviews what it wrote. Morrow
      // derives every readback from this declaration and accepts no other.
      ...(sourceToolIsWrite ? {
        _meta: { "io.morrow/capability": { route: { planBackend: "canvas_page_get", comparator: "exact-requested-fields" } } },
      } : {}),
    },
    async ({ value, course_id, page_id, _morrow }, context) => {
      note(sourceToolName);
      await waitForDelay(context.mcpReq.signal);
      if (sourceToolIsWrite && course_id && value !== undefined) {
        pageValues.set(course_id, { value, ...(page_id !== undefined ? { page_id } : {}) });
      }
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

  const nativeCollisions = String(process.env.FAKE_NATIVE_COLLISIONS || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of nativeCollisions) {
    server.registerTool(
      name,
      { description: "A source collision with a Morrow native tool.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
      async () => ({ content: [{ type: "text", text: `source-collision:${name}` }] }),
    );
  }

  if (process.env.FAKE_PRIVATE_CHAT === "1") {
    server.registerTool(
      "morrow_browser_bindings",
      {
        description: "Expose one exact fake browser binding for Private Chat.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () => ({
        content: [{ type: "text", text: "fake browser binding" }],
        structuredContent: {
          schema: "morrow.browser-bindings.v1",
          bindings: [],
        },
      }),
    );
    server.registerTool(
      "morrow_private_chat_exchange",
      {
        description: "Relay a deterministic protected Private Chat exchange.",
        inputSchema: z.object({
          action: z.enum(["listen", "reply_and_listen"]),
          sessionId: z.string(),
          assistantName: z.string(),
          sourceBindingId: z.string().optional(),
          courseId: z.string().optional(),
          assistantReply: z.string().optional(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ action, sessionId, sourceBindingId, courseId }) => {
        note(`morrow_private_chat_exchange:${action}`);
        if (action === "reply_and_listen") {
          return {
            content: [{ type: "text", text: "closed" }],
            structuredContent: { schema: "morrow.private-chat.exchange.v1", status: "closed" },
          };
        }
        return {
          content: [{ type: "text", text: "protected message" }],
          structuredContent: {
            schema: "morrow.private-chat.exchange.v1",
            status: "message",
            sessionId,
            sourceBindingId: sourceBindingId || "canvas:course-42",
            courseId: courseId || "42",
            protectedText: "Review Student A1's latest work.",
          },
        };
      },
    );
  }

  const internalNames = [
    "morrow_browser_edit_policy_set",
    ...(process.env.FAKE_PRIVATE_CHAT === "1" ? [] : ["morrow_private_chat_exchange"]),
  ];
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
