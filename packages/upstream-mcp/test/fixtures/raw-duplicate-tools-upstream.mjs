// A minimal, hand-rolled MCP stdio server that answers tools/list with a
// genuine duplicate tool name. The real McpServer wrapper refuses to
// register a duplicate name at all, so exercising StdioMcpUpstream's own
// rejection of a duplicate needs a server that does not go through it -
// standing in for a misbehaving or non-SDK upstream implementation.
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, terminal: false });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", (line) => {
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
        serverInfo: { name: "fake-duplicate-tools-upstream", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "duplicate_tool",
            description: "First registration of the duplicate name.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
          {
            name: "duplicate_tool",
            description: "Second registration of the same duplicate name.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      },
    });
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
});
