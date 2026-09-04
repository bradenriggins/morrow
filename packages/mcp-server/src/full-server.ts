import type { McpServer } from "@modelcontextprotocol/server";
import { registerBatchTools } from "./batch-tools.js";
import { registerOperationTools } from "./operation-tools.js";
import { createMorrowServer } from "./server.js";
import type { MorrowRuntime } from "./morrow-runtime.js";

export function createFullMorrowServer(runtime: MorrowRuntime): McpServer {
  const server = createMorrowServer(runtime.gateway, () => runtime.health());
  registerOperationTools(server, runtime.gateway);
  registerBatchTools(server, runtime);
  return server;
}
