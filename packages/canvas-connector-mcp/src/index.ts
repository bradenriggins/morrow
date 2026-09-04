#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadCanvasConnectorConfig } from "./config.js";
import { CanvasConnectorRuntime } from "./runtime.js";
import { createCanvasConnectorMcpServer } from "./server.js";

const config = await loadCanvasConnectorConfig();
const runtime = await CanvasConnectorRuntime.start(config);
const health = runtime.health();
const bridge = health.bridge as { host: string; port: number; path: string };
console.error(`[morrow-canvas-connector] ws://${bridge.host}:${bridge.port}${bridge.path} catalog=${health.catalogDigest}`);
let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await runtime.close().catch(() => undefined);
}
process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
process.once("exit", () => { if (!closing) void runtime.close(); });
await serveStdio(() => createCanvasConnectorMcpServer(runtime));

export { loadCanvasConnectorConfig } from "./config.js";
export { CanvasConnectorRuntime } from "./runtime.js";
export { createCanvasConnectorMcpServer } from "./server.js";
