#!/usr/bin/env node
import { loadGatewayConfig } from "./config.js";
import { MorrowRuntime } from "./morrow-runtime.js";
import { RuntimeStateLease } from "./state-lease.js";

const config = await loadGatewayConfig();
const lease = RuntimeStateLease.acquire(config.operationJournal.path);
const runtime = await MorrowRuntime.connect(config);
let closing = false;

async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await runtime.close();
  } finally {
    lease.release();
  }
}

process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
process.once("exit", () => lease.release());
process.stdout.write(`${runtime.approval.baseUrl}\n`);
process.stdin.resume();
