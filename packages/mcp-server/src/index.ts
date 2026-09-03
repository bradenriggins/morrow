#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadGatewayConfig } from "./config.js";
import { createFullMorrowServer } from "./full-server.js";
import { MorrowRuntime } from "./morrow-runtime.js";

const config = await loadGatewayConfig();
const runtime = await MorrowRuntime.connect(config);
console.error(
  `[morrow] connected ${runtime.gateway.catalog.tools.length} upstream tools; `
    + `catalog=${runtime.gateway.catalog.digest}; state=${config.operationJournal.path}`,
);

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await runtime.close();
}

process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
process.once("exit", () => {
  if (!closing) void runtime.close();
});

await serveStdio(() => createFullMorrowServer(runtime));
