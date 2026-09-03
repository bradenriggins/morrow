import { once } from "node:events";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SCHEMAS,
  parseBridgeJson,
  serializeBridgeMessage,
  type BridgeCommand,
} from "@morrow/bridge-protocol";
import { buildSourceCatalog } from "@morrow/gateway-core";
import { LegacyBridgeRuntime } from "../src/runtime.js";

const token = "secret-".repeat(8);
const revision = "7".repeat(40);
const extensionId = "a".repeat(32);
const runtimes: LegacyBridgeRuntime[] = [];
const sockets: WebSocket[] = [];

const catalog = buildSourceCatalog({
  id: "morrow-legacy",
  label: "Morrow legacy",
  kind: "donor-export",
  repository: "bradenriggins/morrow-legacy",
  revision,
}, [
  {
    name: "list_pages",
    description: "List pages.",
    inputSchema: { type: "object", properties: { course_id: { type: "string" } }, required: ["course_id"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "edit_page",
    description: "Edit a page.",
    inputSchema: { type: "object", properties: { course_id: { type: "string" } }, required: ["course_id"] },
    annotations: { readOnlyHint: false },
  },
]);

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const runtime of runtimes.splice(0)) await runtime.close();
});

async function startRuntime(): Promise<LegacyBridgeRuntime> {
  const runtime = await LegacyBridgeRuntime.start({
    catalogPath: "/unused",
    sourceCatalog: catalog,
    token,
    port: 0,
    expectedRevision: revision,
    allowedExtensionIds: [extensionId],
  });
  runtimes.push(runtime);
  const health = runtime.health();
  const socket = new WebSocket(`ws://${health.bridge.host}:${health.bridge.port}${health.bridge.path}`, {
    origin: `chrome-extension://${extensionId}`,
  });
  sockets.push(socket);
  await once(socket, "open");
  socket.send(serializeBridgeMessage({
    schema: BRIDGE_SCHEMAS.hello,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    token,
    extensionId,
    donorRevision: revision,
    catalogDigest: catalog.digest,
    bindings: [{ sourceBindingId: "binding-42", provider: "canvas", courseId: "42", runtimeVerified: true }],
    sentAt: Date.now(),
  }));
  await once(socket, "message");
  socket.on("message", (raw) => {
    const value = parseBridgeJson(raw.toString());
    if (!value || typeof value !== "object" || (value as { schema?: string }).schema !== BRIDGE_SCHEMAS.command) return;
    const command = value as BridgeCommand;
    const result = command.kind === "invoke_read"
      ? { pages: [{ id: "1" }] }
      : command.kind === "stage_write"
        ? { approvalRequired: true, taskId: "task-1", status: "awaiting_confirmation" }
        : { taskId: command.taskId, status: "awaiting_confirmation" };
    socket.send(serializeBridgeMessage({
      schema: BRIDGE_SCHEMAS.result,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: command.requestId,
      operationId: command.operationId,
      generation: command.generation,
      ok: true,
      result,
      completedAt: Date.now(),
    }));
  });
  return runtime;
}

describe("LegacyBridgeRuntime", () => {
  it("routes reads directly and stages writes without exposing approval", async () => {
    const runtime = await startRuntime();
    const read = await runtime.call("list_pages", {
      course_id: "42",
      _morrow: { source_binding_id: "binding-42" },
    });
    expect(read.commandKind).toBe("invoke_read");
    expect((read.result as { pages?: unknown[] }).pages).toHaveLength(1);

    const write = await runtime.call("edit_page", {
      course_id: "42",
      _morrow: { source_binding_id: "binding-42", operation_id: "operation:edit-page-1" },
    });
    expect(write.commandKind).toBe("stage_write");
    expect((write.result as { approvalRequired?: boolean }).approvalRequired).toBe(true);

    const task = await runtime.taskGet("task-1", "binding-42");
    expect((task.task as { status?: string }).status).toBe("awaiting_confirmation");
  });
});
