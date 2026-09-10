#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
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

await serveStdio(() => createLegacyBridgeMcpServer(runtime, { internalSourceCapability: process.env.MORROW_INTERNAL_SOURCE_CAPABILITY,
  learnerVaultPath: join(homedir(), ".morrow", "source-learner-vault.legacy.json") }));
