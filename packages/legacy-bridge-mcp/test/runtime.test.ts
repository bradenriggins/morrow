import { once } from "node:events";
import { createHmac, randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SCHEMAS,
  bridgeAuthenticationProofPayload,
  parseBridgeJson,
  serializeBridgeMessage,
  type BridgeCommand,
} from "@morrow/bridge-protocol";
import { buildSourceCatalog } from "@morrow/gateway-core";
import { legacyBridgeRuntimeRevision } from "../src/identity.js";
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
  repository: "example-org/morrow-legacy-source",
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
  const authentication = {
    schema: BRIDGE_SCHEMAS.authenticate,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    clientNonce: randomBytes(32).toString("hex"),
    extensionId,
    runtimeRevision: legacyBridgeRuntimeRevision(revision),
    catalogDigest: catalog.digest,
    sentAt: Date.now(),
  } as const;
  socket.send(serializeBridgeMessage(authentication));
  const [challengeRaw] = await once(socket, "message");
  const challenge = parseBridgeJson(challengeRaw.toString()) as { serverNonce: string };
  socket.send(serializeBridgeMessage({
    schema: BRIDGE_SCHEMAS.hello,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    clientNonce: authentication.clientNonce,
    serverNonce: challenge.serverNonce,
    clientProof: createHmac("sha256", token)
      .update(bridgeAuthenticationProofPayload("client", authentication, challenge.serverNonce), "utf8")
      .digest("hex"),
    extensionId,
    runtimeRevision: authentication.runtimeRevision,
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
  it("rejects a stale overlay that claims only the donor revision", async () => {
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
      schema: BRIDGE_SCHEMAS.authenticate,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      clientNonce: randomBytes(32).toString("hex"),
      extensionId,
      runtimeRevision: revision,
      catalogDigest: catalog.digest,
      sentAt: Date.now(),
    }));
    const [code] = await once(socket, "close");
    expect(code).toBe(4403);
    expect(runtime.health().bridge.connected).toBe(false);
  });

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

  it("preserves acknowledged stage cancellation truth", async () => {
    const runtime = Object.create(LegacyBridgeRuntime.prototype) as LegacyBridgeRuntime;
    Object.defineProperty(runtime, "catalog", { value: catalog });
    const invoke = vi.fn();
    Object.defineProperty(runtime, "bridge", { value: { invoke } });
    const controller = new AbortController();
    invoke.mockResolvedValueOnce({
      ok: false,
      operationId: "operation:cancelled-before-stage",
      problem: { schema: "morrow.bridge.problem.v1", code: "request_cancelled_before_dispatch", message: "cancelled", recoverable: true },
    });
    await expect(runtime.call("edit_page", { course_id: "42" }, controller.signal)).resolves.toMatchObject({
      ok: false,
      resultState: "not_sent",
      operationId: "operation:cancelled-before-stage",
    });
    expect(invoke).toHaveBeenLastCalledWith(expect.objectContaining({ signal: controller.signal }));
    invoke.mockResolvedValueOnce({
      ok: false,
      operationId: "operation:cancelled-during-stage",
      problem: { schema: "morrow.bridge.problem.v1", code: "write_outcome_unknown", message: "unknown", recoverable: false },
    });
    await expect(runtime.call("edit_page", { course_id: "42" })).resolves.toMatchObject({
      ok: false,
      resultState: "unknown",
      operationId: "operation:cancelled-during-stage",
    });
  });

  it("forwards task cancellation to the exact loopback invocation", async () => {
    const runtime = Object.create(LegacyBridgeRuntime.prototype) as LegacyBridgeRuntime;
    const invoke = vi.fn(async () => ({ ok: true, result: { taskId: "task-1" } }));
    Object.defineProperty(runtime, "bridge", { value: { invoke } });
    const controller = new AbortController();

    await runtime.taskGet("task-1", "binding-42", controller.signal);

    expect(invoke).toHaveBeenCalledWith({
      kind: "task_get",
      taskId: "task-1",
      sourceBindingId: "binding-42",
      signal: controller.signal,
    });
  });
});
