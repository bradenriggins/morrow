#!/usr/bin/env node
import { serveStdio, StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { loadCanvasConnectorConfig } from "./config.js";
import { CanvasConnectorRuntime } from "./runtime.js";
import { createCanvasConnectorMcpServer } from "./server.js";

/** How long the bridge server has to close before this process leaves anyway. */
const SHUTDOWN_DEADLINE_MS = 2_000;
/** How often the connector checks that the process that started it is still there. */
const PARENT_CHECK_INTERVAL_MS = 2_000;
/** How often a connector without the Bridge port tries to take it again. */
const BRIDGE_REBIND_INTERVAL_MS = 2_000;

const config = await loadCanvasConnectorConfig();
const runtime = await CanvasConnectorRuntime.start(config);
const health = runtime.health();
const bridge = health.bridge as {
  host: string;
  port: number | null;
  path: string;
  problem?: { code: string; message: string };
};
// A held Bridge port is a named state, not a crash. This connector keeps serving
// its tools, so the assistant still starts and can read the reason from health.
console.error(bridge.problem
  ? `[morrow-canvas-connector] ${bridge.problem.code}: Morrow's Chrome bridge port ${config.port} is already in use. ${bridge.problem.message}`
  : `[morrow-canvas-connector] ws://${bridge.host}:${bridge.port}${bridge.path} catalog=${health.catalogDigest}`);
let closing = false;
function readyLine(address: { host: string; port: number; path: string }): string {
  return `[morrow-canvas-connector] ws://${address.host}:${address.port}${address.path} catalog=${health.catalogDigest}`;
}
// The named state tells the person to close the other Morrow. This takes the
// port as soon as that happens, so the person does not start this Morrow again.
const rebind = bridge.problem
  ? setInterval(() => void runtime.bridge.start().then(
      (address) => {
        clearInterval(rebind!);
        console.error(readyLine(address));
      },
      () => undefined,
    ), BRIDGE_REBIND_INTERVAL_MS)
  : null;
rebind?.unref();
let serverHandle: StdioServerHandle | null = null;
// A parent that dies without a signal leaves this process reparented, so its
// parent id changes. That is POSIX behaviour; Windows keeps the recorded parent
// id, where the end of stdin remains the signal that the assistant is gone.
const startParentPid = process.ppid;
const parentCheck = startParentPid > 1
  ? setInterval(() => { if (process.ppid !== startParentPid) shutdown(); }, PARENT_CHECK_INTERVAL_MS)
  : null;
parentCheck?.unref();
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  if (parentCheck) clearInterval(parentCheck);
  if (rebind) clearInterval(rebind);
  // An extension socket that never answers the close frame can hold the
  // listening handle open, so the process leaves on its own deadline instead.
  setTimeout(() => process.exit(0), SHUTDOWN_DEADLINE_MS).unref();
  const handle = serverHandle;
  serverHandle = null;
  if (handle) await handle.close().catch(() => undefined);
  await runtime.close().catch(() => undefined);
}
function shutdown(): void {
  void close();
}
/** Ends the connector when the stdio connection itself closes. */
class ConnectorStdioTransport extends StdioServerTransport {
  override async close(): Promise<void> {
    await super.close();
    shutdown();
  }
}
process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
process.once("exit", () => { if (!closing) void runtime.close(); });
process.stdin.once("end", shutdown);
process.stdin.once("close", shutdown);
serverHandle = serveStdio(() => createCanvasConnectorMcpServer(runtime), { transport: new ConnectorStdioTransport() });

export { loadCanvasConnectorConfig } from "./config.js";
export { CanvasConnectorRuntime } from "./runtime.js";
export { createCanvasConnectorMcpServer } from "./server.js";
