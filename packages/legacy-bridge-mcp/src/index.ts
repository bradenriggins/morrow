#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadLegacyBridgeConfig } from "./config.js";
import { LegacyBridgeRuntime } from "./runtime.js";
import { createLegacyBridgeMcpServer } from "./server.js";

const config = await loadLegacyBridgeConfig();
const runtime = await LegacyBridgeRuntime.start(config);
const health = runtime.health();
console.error(
  `[morrow-legacy-bridge] ws://${health.bridge.host}:${health.bridge.port}${health.bridge.path} catalog=${health.source.digest}`,
);

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await runtime.close().catch(() => undefined);
}
process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
process.once("exit", () => {
  if (!closing) void runtime.close();
});

await serveStdio(() => createLegacyBridgeMcpServer(runtime));
