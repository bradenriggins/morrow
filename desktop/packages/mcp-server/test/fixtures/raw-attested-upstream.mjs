import { createInterface } from "node:readline";

const source = String(process.env.FAKE_SOURCE || "meridian").trim().toLowerCase();
const tools = [
  {
    name: "canvas_page_get",
    description: `Read a fake page from ${source}.`,
    inputSchema: {
      type: "object",
      properties: { course_id: { type: "string" } },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: `${source.replace(/[^a-z0-9]+/g, "_")}_only`,
    description: `A source-only fake read tool from ${source}.`,
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  ...["mindtap_hidden", "connect_hidden"].map((name) => ({
    name,
    description: "A held-provider fixture that must not reach the merged catalog.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  })),
  ...["morrow_browser_edit_policy_set", "morrow_private_chat_exchange"].map((name) => ({
    name,
    description: "An internal Morrow browser control that must not reach the public catalog.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  })),
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

createInterface({ input: process.stdin, terminal: false }).on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "raw-attested-upstream", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools } });
    return;
  }
  if (message.method === "tools/call") {
    const name = String(message.params?.name || "");
    const args = message.params?.arguments || {};
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: `${source}:${args.course_id || args.value || "none"}` }],
        structuredContent: {
          source,
          course_id: args.course_id || null,
          value: args.value || null,
        },
      },
    });
    return;
  }
  if (message.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Method not found: ${message.method}` },
    });
  }
});
