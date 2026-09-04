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
import { BridgeOutcomeUnknownError, LoopbackBridgeServer } from "../src/index.js";

const token = "secret-".repeat(8);
const revision = "7".repeat(40);
const digest = "a".repeat(64);
const extensionId = "a".repeat(32);
const servers: LoopbackBridgeServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const server of servers.splice(0)) await server.close();
});

async function connect(server: LoopbackBridgeServer): Promise<WebSocket> {
  const address = await server.start();
  const socket = new WebSocket(`ws://${address.host}:${address.port}${address.path}`, {
    origin: `chrome-extension://${extensionId}`,
  });
  sockets.push(socket);
  await once(socket, "open");
  socket.send(serializeBridgeMessage({
    schema: BRIDGE_SCHEMAS.hello,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    token,
    extensionId,
    runtimeRevision: revision,
    catalogDigest: digest,
    bindings: [{
      sourceBindingId: "canvas-course-42",
      provider: "canvas",
      courseId: "42",
      courseName: "Course 42",
      origin: "https://school.instructure.com",
      runtimeVerified: true,
    }],
    sentAt: Date.now(),
  }));
  await once(socket, "message");
  return socket;
}

function commandHandler(socket: WebSocket, handler: (command: BridgeCommand) => object | undefined): void {
  socket.on("message", (raw) => {
    const value = parseBridgeJson(raw.toString());
    if (!value || typeof value !== "object" || (value as { schema?: string }).schema !== BRIDGE_SCHEMAS.command) return;
    const command = value as BridgeCommand;
    const result = handler(command);
    if (!result) return;
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
}

describe("LoopbackBridgeServer", () => {
  it("pairs one exact Chrome extension without copying the local token", async () => {
    const server = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      port: 0,
      pairingEnabled: true,
    });
    servers.push(server);
    const address = await server.start();
    const origin = `chrome-extension://${extensionId}`;
    const created = await fetch(`http://${address.host}:${address.port}${address.path}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ extensionId, catalogDigest: digest, runtimeRevision: revision }),
    });
    expect(created.status).toBe(201);
    const pairing = await created.json() as { approvalUrl: string; statusUrl: string };
    const decision = await fetch(`${pairing.approvalUrl}/decision`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "decision=approve",
      redirect: "manual",
    });
    expect(decision.status).toBe(303);
    const status = await fetch(pairing.statusUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ extensionId }),
    });
    expect(await status.json()).toMatchObject({ status: "approved", token });
  });

  it("authenticates a Chrome extension and routes one command exactly once", async () => {
    const server = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      allowedExtensionIds: [extensionId],
      port: 0,
    });
    servers.push(server);
    const socket = await connect(server);
    let calls = 0;
    commandHandler(socket, (command) => {
      calls += 1;
      expect(command.kind).toBe("invoke_read");
      expect(command.toolName).toBe("list_pages");
      return { pages: [{ id: "1" }] };
    });

    const result = await server.invoke({
      kind: "invoke_read",
      toolName: "list_pages",
      operationKey: "GET /v1/courses/{course_id}/pages#list_pages",
      arguments: { course_id: "42" },
      sourceBindingId: "canvas-course-42",
    });
    expect(result.result).toEqual({ pages: [{ id: "1" }] });
    expect(calls).toBe(1);
    expect(server.health().bindingCount).toBe(1);
  });

  it("does not resend a timed-out command", async () => {
    const server = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      allowedExtensionIds: [extensionId],
      port: 0,
      callTimeoutMs: 120,
    });
    servers.push(server);
    const socket = await connect(server);
    let calls = 0;
    commandHandler(socket, () => {
      calls += 1;
      return undefined;
    });

    await expect(server.invoke({
      kind: "stage_write",
      toolName: "edit_page",
      arguments: { course_id: "42" },
      operationId: "operation:timeout-1234",
      timeoutMs: 120,
    })).rejects.toBeInstanceOf(BridgeOutcomeUnknownError);
    expect(calls).toBe(1);
  });

  it("accepts a gateway outer effect receipt once", async () => {
    const server = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      allowedExtensionIds: [extensionId],
      port: 0,
    });
    servers.push(server);
    const socket = await connect(server);
    let calls = 0;
    commandHandler(socket, (command) => {
      calls += 1;
      expect(command.outerGrant).toMatchObject({ effectReceiptId: "effect:12345678", dispatchAttempt: 1 });
      return { taskId: "task-1" };
    });
    const outerGrant = {
      planDigest: digest,
      approvalGrantDigest: "b".repeat(64),
      effectReceiptId: "effect:12345678",
      dispatchAttempt: 1 as const,
      gatewayProcessId: "gateway:12345678",
    };
    await server.invoke({ kind: "invoke_write", toolName: "edit_page", operationKey: "PUT /v1/pages/{url}#edit_page", outerGrant });
    await expect(server.invoke({ kind: "invoke_write", toolName: "edit_page", operationKey: "PUT /v1/pages/{url}#edit_page", outerGrant }))
      .rejects.toBeInstanceOf(BridgeOutcomeUnknownError);
    expect(calls).toBe(1);
  });

  it("refuses a connector write without a gateway outer grant", async () => {
    const server = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      allowedExtensionIds: [extensionId],
      port: 0,
    });
    servers.push(server);
    await connect(server);
    await expect(server.invoke({
      kind: "invoke_write",
      toolName: "edit_page",
      operationKey: "PUT /v1/pages/{url}#edit_page",
    })).rejects.toThrow("outer grant");
  });
});
