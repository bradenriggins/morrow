#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadGatewayConfig } from "./config.js";
import { createFullMorrowServer } from "./full-server.js";
import { MorrowRuntime } from "./morrow-runtime.js";
import {
  RuntimeStateLease,
  hardenMorrowStateFiles,
} from "./state-lease.js";

const config = await loadGatewayConfig();
const lease = RuntimeStateLease.acquire(config.operationJournal.path);
let runtime: MorrowRuntime | null = null;
let closing = false;

async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    if (runtime) await runtime.close();
  } finally {
    lease.release();
  }
}

process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
process.once("exit", () => lease.release());

try {
  runtime = await MorrowRuntime.connect(config);
  hardenMorrowStateFiles(config.operationJournal.path);
  console.error(
    `[morrow] connected ${runtime.gateway.catalog.tools.length} upstream tools; `
      + `catalog=${runtime.gateway.catalog.digest}; state=${config.operationJournal.path}; lease=active`,
  );
  await serveStdio(() => createFullMorrowServer(runtime!));
} finally {
  await close();
}
