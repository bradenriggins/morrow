#!/usr/bin/env node
import { loadGatewayConfig } from "./config.js";
import { MorrowRuntime } from "./morrow-runtime.js";
import { RuntimeStateLease } from "./state-lease.js";

const config = await loadGatewayConfig();
let lease: RuntimeStateLease | null = null;
let runtime: MorrowRuntime | null = null;
let closePromise: Promise<void> | null = null;

function close(): Promise<void> {
  closePromise ??= (async () => {
    try {
      if (runtime) await runtime.close();
    } finally {
      lease?.release();
    }
  })();
  return closePromise;
}

lease = RuntimeStateLease.acquire(config.operationJournal.path, {
  onOwnershipLost: (error) => {
    console.error(`[morrow] runtime state lease lost: ${error.message}`);
    return close().finally(() => process.exit(1));
  },
});
try {
  runtime = await MorrowRuntime.connect(config, { statePath: lease.statePath });
} catch (error) {
  await close();
  throw error;
}
process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
process.once("exit", () => lease?.release());
process.stdout.write(`${runtime.approval.baseUrl}\n`);
process.stdin.resume();
