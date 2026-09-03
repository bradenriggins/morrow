#!/usr/bin/env node
import { loadGatewayConfig } from "./config.js";
import { GatewayRuntime } from "./runtime.js";
import { serveMorrow } from "./server.js";

async function main(): Promise<void> {
  const config = await loadGatewayConfig();
  const runtime = await GatewayRuntime.connect(config);

  const shutdown = async (): Promise<void> => {
    await runtime.close();
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  const health = runtime.health();
  console.error(
    `[morrow] profile=${health.profile} tools=${health.publicToolCount} catalog=${health.catalogDigest.slice(0, 12)}`,
  );
  serveMorrow(runtime);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[morrow] startup failed: ${message}`);
  process.exitCode = 1;
});
