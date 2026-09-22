// One Morrow gateway, started the way a client starts it, and the sandbox this harness owns.
// Everything the harness proves goes through this connection, never around it.
import { readFileSync } from "node:fs";
import { Client } from "../packages/mcp-server/node_modules/@modelcontextprotocol/client/dist/index.mjs";
import { getDefaultEnvironment, StdioClientTransport } from "../packages/mcp-server/node_modules/@modelcontextprotocol/client/dist/stdio.mjs";

export const PAYLOAD = process.env.MORROW_PAYLOAD || "/Applications/Morrow.app/Contents/Resources/MorrowPayload";
export const GATEWAY = process.env.MORROW_GATEWAY || `${PAYLOAD}/app/packages/mcp-server/dist/index.js`;
export const MATERIALS = process.env.MORROW_MATERIALS || "/Users/Braden/Library/Application Support/morrow-installer/Materials";
export const UPSTREAMS = process.env.MORROW_UPSTREAMS_FILE || "/Users/Braden/Library/Application Support/morrow-installer/State/morrow.upstreams.json";

/** The sandbox this harness owns. Every write proof happens here and nowhere else. */
export const SANDBOX = Object.freeze({
  provider: "canvas",
  courseId: process.env.MORROW_PROOF_COURSE || "89585",
  // Every object this harness creates carries this mark, so its own work is
  // distinguishable from anything another lane left in the same course.
  mark: process.env.MORROW_PROOF_MARK || "MORROWPROOF",
});

function savedBinding() {
  for (const path of ["../output/live-bt2-final-package-v35/live-proof/sweep-binding.json", "./sandbox-binding.json"]) {
    try {
      const saved = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
      if (typeof saved?.sourceBindingId === "string" && saved.sourceBindingId) return saved.sourceBindingId;
    } catch { /* try the next one */ }
  }
  return "";
}

export const SOURCE_BINDING = process.env.MORROW_SB || savedBinding();

export async function connect(name = "morrow-proof-harness", { waitForBinding = true } = {}) {
  const client = new Client({ name, version: "1.0.0" }, { capabilities: { elicitation: {} }, versionNegotiation: { mode: { pin: "2026-07-28" } } });
  const transport = new StdioClientTransport({
    command: `${PAYLOAD}/runtime/node/bin/node`,
    args: [GATEWAY],
    cwd: MATERIALS,
    env: { ...getDefaultEnvironment(), MORROW_UPSTREAMS_FILE: UPSTREAMS },
    stderr: process.env.MORROW_SHOW_STDERR ? "inherit" : "pipe",
  });
  await client.connect(transport);
  if (waitForBinding && SOURCE_BINDING) {
    // The Bridge reconnects to a freshly started gateway a few seconds later, so
    // the harness waits for the course connection it works through.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const listed = await client.callTool({ name: "morrow_capability_read", arguments: { name: "morrow_canvas_bindings", arguments: {} } }, { timeout: 60_000 }).catch(() => null);
      if ((listed?.structuredContent?.data?.bindings || []).some((entry) => entry.sourceBindingId === SOURCE_BINDING && entry.runtimeVerified)) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  return { client, transport, close: async () => { await client.close().catch(() => {}); await transport.close().catch(() => {}); } };
}
