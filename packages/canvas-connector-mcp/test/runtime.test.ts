import { once } from "node:events";
import { resolve } from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { BRIDGE_PROTOCOL_VERSION, BRIDGE_SCHEMAS, parseBridgeJson, serializeBridgeMessage, type BridgeCommand } from "@morrow/bridge-protocol";
import type { CanvasConnectorConfig } from "../src/config.js";
import { CanvasConnectorRuntime } from "../src/runtime.js";

const token = "connector-secret-".repeat(4);
const extensionId = "a".repeat(32);
const runtimes: CanvasConnectorRuntime[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const runtime of runtimes.splice(0)) await runtime.close();
});

async function start(): Promise<CanvasConnectorRuntime> {
  const config: CanvasConnectorConfig = {
    statePath: ":memory:",
    catalogPath: resolve("../../artifacts/canvas-api/canvas-api-catalog.json"),
    token,
    port: 0,
    runtimeRevision: "1.0.0-rc.0",
    allowedExtensionIds: [extensionId],
    approveExtensionId: async () => undefined,
  };
  const runtime = await CanvasConnectorRuntime.start(config);
  runtimes.push(runtime);
  const address = runtime.bridge.health();
  const socket = new WebSocket(`ws://${address.host}:${address.port}${address.path}`, { origin: `chrome-extension://${extensionId}` });
  sockets.push(socket);
  await once(socket, "open");
  socket.send(serializeBridgeMessage({
    schema: BRIDGE_SCHEMAS.hello,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    token,
    extensionId,
    runtimeRevision: "1.0.0-rc.0",
    catalogDigest: runtime.catalogDigest,
    bindings: [{
      sourceBindingId: "canvas:test-account",
      provider: "canvas",
      origin: "https://school.instructure.com",
      principalFingerprint: "b".repeat(64),
      sessionGeneration: 1,
      runtimeVerified: true,
    }],
    sentAt: Date.now(),
  }));
  await once(socket, "message");
  return runtime;
}

function respond(socket: WebSocket, onCommand: (command: BridgeCommand) => void): void {
  socket.on("message", (raw) => {
    const value = parseBridgeJson(raw.toString()) as { schema?: string };
    if (value.schema !== BRIDGE_SCHEMAS.command) return;
    const command = value as BridgeCommand;
    onCommand(command);
    socket.send(serializeBridgeMessage({
      schema: BRIDGE_SCHEMAS.result,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: command.requestId,
      operationId: command.operationId,
      generation: command.generation,
      ok: true,
      result: { ok: true, status: 200, data: { id: "42" } },
      completedAt: Date.now(),
    }));
  });
}

describe("CanvasConnectorRuntime", () => {
  it("routes an official Canvas read by immutable operation key", async () => {
    const runtime = await start();
    const socket = sockets.at(-1)!;
    respond(socket, (command) => {
      expect(command.kind).toBe("invoke_read");
      expect(command.operationKey).toBe(runtime.operations.get("canvas_get_new_quiz")?.key);
      expect(command.sourceBindingId).toBe("canvas:test-account");
    });
    const result = await runtime.call("canvas_get_new_quiz", {
      course_id: "42",
      assignment_id: "77",
      _morrow: { source_binding_id: "canvas:test-account" },
    });
    expect(result).toMatchObject({ ok: true, result: { status: 200 } });
  });

  it("refuses writes without an outer grant and dispatches one granted write", async () => {
    const runtime = await start();
    const write = runtime.catalog.operations.find((operation) => !operation.readOnly)!;
    const refused = await runtime.call(write.toolName, {});
    expect(refused).toMatchObject({ ok: false });
    const socket = sockets.at(-1)!;
    let calls = 0;
    respond(socket, (command) => {
      calls += 1;
      expect(command.kind).toBe("invoke_write");
      expect(command.outerGrant?.effectReceiptId).toBe("effect:connector-test");
    });
    const granted = await runtime.call(write.toolName, {
      _morrow: {
        operation_id: "operation:connector-test",
        outer_grant: {
          plan_digest: "a".repeat(64),
          approval_grant_digest: "b".repeat(64),
          effect_receipt_id: "effect:connector-test",
          dispatch_attempt: 1,
          gateway_process_id: "gateway:connector-test",
        },
      },
    });
    expect(granted).toMatchObject({ ok: true });
    expect(calls).toBe(1);
    const held = runtime.catalog.operations.find((operation) => operation.service === "item_bank" && operation.nickname === "update_item")!;
    expect(await runtime.call(held.toolName, { bank_id: "91", item_id: "501", item: { title: "Updated" } }))
      .toMatchObject({ ok: false, problem: { code: "item_bank_dependency_review_required" } });
    expect(calls).toBe(1);
  });
});
