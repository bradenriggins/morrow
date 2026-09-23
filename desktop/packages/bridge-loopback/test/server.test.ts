import { once } from "node:events";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SCHEMAS,
  MAX_BRIDGE_MESSAGE_BYTES,
  bridgeAuthenticationProofPayload,
  bridgePairingProofPayload,
  parseBridgeJson,
  serializeBridgeMessage,
  type BridgeCommand,
  type BridgeBinding,
} from "@morrow/bridge-protocol";
import {
  BridgeOutcomeUnknownError,
  BridgePortInUseError,
  BridgeRequestCapacityError,
  BridgeRequestCancelledError,
  BridgeUnavailableError,
  BridgeWriteRecordFullError,
  LoopbackBridgeServer,
  bridgeFailureResult,
  bridgePortInUseMessage,
  bridgeWriteRecordFullMessage,
} from "../src/index.js";

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

async function connect(
  server: LoopbackBridgeServer,
  bindings: readonly BridgeBinding[] = [{
    sourceBindingId: "canvas-course-42",
    provider: "canvas",
    courseId: "42",
    courseName: "Course 42",
    origin: "https://school.instructure.com",
    runtimeVerified: true,
  }],
): Promise<WebSocket> {
  const address = await server.start();
  const socket = new WebSocket(`ws://${address.host}:${address.port}${address.path}`, {
    origin: `chrome-extension://${extensionId}`,
  });
  sockets.push(socket);
  await once(socket, "open");
  const authentication = {
    schema: BRIDGE_SCHEMAS.authenticate,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    clientNonce: randomBytes(32).toString("hex"),
    extensionId,
    runtimeRevision: revision,
    catalogDigest: digest,
    sentAt: Date.now(),
  } as const;
  socket.send(serializeBridgeMessage(authentication));
  const [challengeRaw] = await once(socket, "message");
  const challenge = parseBridgeJson(challengeRaw.toString()) as { clientNonce: string; serverNonce: string; serverProof: string };
  expect(challenge.clientNonce).toBe(authentication.clientNonce);
  expect(challenge.serverProof).toBe(createHmac("sha256", token)
    .update(bridgeAuthenticationProofPayload("server", authentication, challenge.serverNonce), "utf8")
    .digest("hex"));
  const clientProof = createHmac("sha256", token)
    .update(bridgeAuthenticationProofPayload("client", authentication, challenge.serverNonce), "utf8")
    .digest("hex");
  socket.send(serializeBridgeMessage({
    schema: BRIDGE_SCHEMAS.hello,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    clientNonce: authentication.clientNonce,
    serverNonce: challenge.serverNonce,
    clientProof,
    extensionId,
    runtimeRevision: revision,
    catalogDigest: digest,
    bindings,
    sentAt: Date.now(),
  }));
  await once(socket, "message");
  return socket;
}

function editableCanvasPermission() {
  return {
    schema: "morrow.bridge.edit-permission.v1" as const,
    revision: 1,
    scopeDigest: "c".repeat(64),
    catalogDigest: digest,
    sourceBindingId: "canvas-course-42",
    enabledCategories: ["canvas_page_content"],
    rules: [{
      operationKey: "PUT /v1/courses/{course_id}/pages/{url_or_id}#update_create_page",
      toolName: "canvas_update_create_page_courses",
      allowedChangedFields: [],
      requiresPageGuard: true,
      pageGuardKind: "text" as const,
    }],
  };
}

function editableCanvasBinding(): BridgeBinding {
  const permission = editableCanvasPermission();
  return {
    sourceBindingId: "canvas-course-42",
    provider: "canvas",
    courseId: "42",
    courseName: "Course 42",
    origin: "https://school.instructure.com",
    runtimeVerified: true,
    editOptionsAvailable: true,
    editPolicyRevision: permission.revision,
    editPermission: { schema: permission.schema, revision: permission.revision, scopeDigest: permission.scopeDigest, catalogDigest: permission.catalogDigest, sourceBindingId: permission.sourceBindingId },
  };
}

function editableAssignmentPermission() {
  return {
    schema: "morrow.bridge.edit-permission.v1" as const,
    revision: 1,
    scopeDigest: "e".repeat(64),
    catalogDigest: digest,
    sourceBindingId: "canvas-course-42",
    enabledCategories: ["canvas_assignment_due_date"],
    rules: [{
      operationKey: "PUT /v1/courses/{course_id}/assignments/{id}#edit_assignment",
      toolName: "canvas_edit_assignment",
      allowedChangedFields: ["assignment_due_at"],
    }],
  };
}

function editableAssignmentBinding(): BridgeBinding {
  const permission = editableAssignmentPermission();
  return {
    sourceBindingId: "canvas-course-42",
    provider: "canvas",
    courseId: "42",
    courseName: "Course 42",
    origin: "https://school.instructure.com",
    runtimeVerified: true,
    editOptionsAvailable: true,
    editPolicyRevision: permission.revision,
    editPermission: { schema: permission.schema, revision: permission.revision, scopeDigest: permission.scopeDigest, catalogDigest: permission.catalogDigest, sourceBindingId: permission.sourceBindingId },
  };
}

function editOptions(permission: ReturnType<typeof editableCanvasPermission> | ReturnType<typeof editableAssignmentPermission>) {
  return {
    schema: "morrow.bridge.edit-options.v1",
    sourceBindingId: permission.sourceBindingId,
    provider: "canvas",
    catalogDigest: digest,
    policyRevision: permission.revision,
    runtimeVerified: true,
    options: [{ id: permission.enabledCategories[0]!, group: "Focused Canvas repairs", label: "Exact Edit action", description: "One exact test action.", availability: "edit" }],
    editPermission: permission,
  };
}

const pageGuard = {
  kind: "text",
  page_id: "7",
  revision_id: "4",
  body_sha256: "d".repeat(64),
  fields: { url: "week-1", title: "Week 1", published: true, front_page: false, editing_roles: "teachers", publish_at: null },
  find_text: "old text",
  replace_text: "new text",
};

function privateAttachment() {
  const bytes = Buffer.from("private Moodle resource\n", "utf8");
  return {
    schema: "morrow.private-file-attachment.v1" as const,
    handle: "file:resource-attachment-42",
    manifest: {
      filename: "week-1.txt",
      size_bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    bytes_base64: bytes.toString("base64"),
  };
}

function privateConversation() {
  return {
    schema: "morrow.canvas-conversation.private.v1" as const,
    action: "create" as const,
    courseId: "42",
    recipients: ["27", "group_9_students"],
    subject: "Week 3",
    body: "Please review the lab notes.",
    groupConversation: true,
  };
}

function moodleBinding(): BridgeBinding {
  return {
    sourceBindingId: "moodle:course-42",
    provider: "moodle",
    courseId: "42",
    courseName: "Course 42",
    origin: "https://school.example.edu",
    siteUrl: "https://school.example.edu/moodle",
    runtimeVerified: true,
  };
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
  it("closes mixed authenticated and unauthenticated peers within the shutdown bound", async () => {
    const server = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      allowedExtensionIds: [extensionId],
      port: 0,
      authTimeoutMs: 10_000,
      callTimeoutMs: 10_000,
      shutdownGraceMs: 100,
    });
    servers.push(server);
    const authenticated = await connect(server);
    const address = await server.start();
    const unauthenticated = new WebSocket(`ws://${address.host}:${address.port}${address.path}`, {
      origin: `chrome-extension://${extensionId}`,
    });
    sockets.push(unauthenticated);
    await once(unauthenticated, "open");
    const authenticatedTransport = (authenticated as unknown as { _socket: { pause(): void; resume(): void } })._socket;
    const unauthenticatedTransport = (unauthenticated as unknown as { _socket: { pause(): void; resume(): void } })._socket;
    authenticatedTransport.pause();
    unauthenticatedTransport.pause();
    const pending = server.invoke({
      kind: "invoke_read",
      toolName: "list_pages",
      operationKey: "GET /v1/courses/{course_id}/pages#list_pages",
      arguments: { course_id: "42" },
      sourceBindingId: "canvas-course-42",
    }).then(() => null, (error: unknown) => error);
    expect(server.health().pendingCount).toBe(1);
    const state = server as unknown as {
      acceptedSockets: Set<WebSocket>;
      authenticationTimers: Map<WebSocket, NodeJS.Timeout>;
    };
    expect(state.acceptedSockets.size).toBe(2);
    expect(state.authenticationTimers.size).toBe(1);
    const terminationSpies = [...state.acceptedSockets].map((socket) => vi.spyOn(socket, "terminate"));

    const startedAt = performance.now();
    const closing = server.close();
    const late = new WebSocket(`ws://${address.host}:${address.port}${address.path}`, {
      origin: `chrome-extension://${extensionId}`,
    });
    sockets.push(late);
    const lateOutcome = new Promise<"open" | "refused">((resolve) => {
      late.once("open", () => resolve("open"));
      late.once("error", () => resolve("refused"));
      late.once("close", () => resolve("refused"));
    });
    await closing;
    const elapsedMs = performance.now() - startedAt;
    authenticatedTransport.resume();
    unauthenticatedTransport.resume();

    expect(elapsedMs).toBeLessThan(1_000);
    expect(await lateOutcome).toBe("refused");
    expect(terminationSpies.every((spy) => spy.mock.calls.length === 1)).toBe(true);
    expect(await pending).toBeInstanceOf(BridgeOutcomeUnknownError);
    expect(server.health()).toMatchObject({ listening: false, connected: false, pendingCount: 0 });
    expect(state.acceptedSockets.size).toBe(0);
    expect(state.authenticationTimers.size).toBe(0);
    await expect(server.start()).rejects.toThrow("bridge server is closed");
  });

  it("closes a server without clients before the shutdown grace expires", async () => {
    const server = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      port: 0,
      shutdownGraceMs: 100,
    });
    servers.push(server);
    await server.start();
    const startedAt = performance.now();

    await server.close();

    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(server.health()).toMatchObject({ listening: false, connected: false, pendingCount: 0 });
  });

  it("reveals no client secret before server proof and refuses a forged client proof", async () => {
    const server = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      allowedExtensionIds: [extensionId],
      port: 0,
    });
    servers.push(server);
    const address = await server.start();
    const socket = new WebSocket(`ws://${address.host}:${address.port}${address.path}`, {
      origin: `chrome-extension://${extensionId}`,
    });
    sockets.push(socket);
    await once(socket, "open");
    const authentication = {
      schema: BRIDGE_SCHEMAS.authenticate,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      clientNonce: randomBytes(32).toString("hex"),
      extensionId,
      runtimeRevision: revision,
      catalogDigest: digest,
      sentAt: Date.now(),
    } as const;
    expect(authentication).not.toHaveProperty("token");
    expect(authentication).not.toHaveProperty("bindings");
    socket.send(serializeBridgeMessage(authentication));
    const [raw] = await once(socket, "message");
    const challenge = parseBridgeJson(raw.toString()) as Record<string, unknown>;
    expect(Object.keys(challenge).sort()).toEqual([
      "clientNonce", "issuedAt", "protocolVersion", "schema", "serverNonce", "serverProof",
    ]);
    const closed = once(socket, "close");
    socket.send(serializeBridgeMessage({
      schema: BRIDGE_SCHEMAS.hello,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      clientNonce: authentication.clientNonce,
      serverNonce: String(challenge.serverNonce),
      clientProof: "0".repeat(64),
      extensionId,
      runtimeRevision: revision,
      catalogDigest: digest,
      bindings: [],
      sentAt: Date.now(),
    }));
    const [code, reason] = await closed;
    expect(code).toBe(4403);
    expect(reason.toString()).toBe("bridge_identity_refused");
    expect(server.health()).toMatchObject({ connected: false, extensionId: null, bindingCount: 0 });
  });

  // A different Morrow or Morrow Bridge version is fixed by an update and a reload, not by a new
  // connection approval, so it closes with its own reason.
  it("names a version mismatch apart from a refused identity", async () => {
    const server = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      allowedExtensionIds: [extensionId],
      port: 0,
    });
    servers.push(server);
    const address = await server.start();
    const refusal = async (fields: { runtimeRevision?: string; catalogDigest?: string; extensionId?: string }) => {
      const socket = new WebSocket(`ws://${address.host}:${address.port}${address.path}`, {
        origin: `chrome-extension://${extensionId}`,
      });
      sockets.push(socket);
      await once(socket, "open");
      const closed = once(socket, "close");
      socket.send(serializeBridgeMessage({
        schema: BRIDGE_SCHEMAS.authenticate,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        clientNonce: randomBytes(32).toString("hex"),
        extensionId,
        runtimeRevision: revision,
        catalogDigest: digest,
        sentAt: Date.now(),
        ...fields,
      }));
      const [code, reason] = await closed;
      return `${code} ${reason.toString()}`;
    };
    await expect(refusal({ runtimeRevision: "8".repeat(40) })).resolves.toBe("4403 bridge_version_mismatch");
    await expect(refusal({ catalogDigest: "b".repeat(64) })).resolves.toBe("4403 bridge_version_mismatch");
    await expect(refusal({ extensionId: "b".repeat(32) })).resolves.toBe("4403 bridge_identity_refused");
  });

  it("tells its owner each time a Bridge connection becomes active, after the ready answer", async () => {
    const activations: boolean[] = [];
    const server: LoopbackBridgeServer = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      allowedExtensionIds: [extensionId],
      port: 0,
      onActivated: () => {
        activations.push(server.health().connected);
        throw new Error("an owner failure never ends the connection it follows");
      },
    });
    servers.push(server);
    const first = await connect(server, []);
    expect(activations).toEqual([true]);
    const firstClosed = once(first, "close");
    first.close();
    await firstClosed;
    const second = await connect(server, []);
    expect(activations).toEqual([true, true]);
    expect(second.readyState).toBe(WebSocket.OPEN);
    expect(server.health()).toMatchObject({ connected: true });
  });

  it("refuses a binary WebSocket frame even when its bytes contain valid Bridge JSON", async () => {
    const server = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      allowedExtensionIds: [extensionId],
      port: 0,
    });
    servers.push(server);
    const address = await server.start();
    const socket = new WebSocket(`ws://${address.host}:${address.port}${address.path}`, {
      origin: `chrome-extension://${extensionId}`,
    });
    sockets.push(socket);
    await once(socket, "open");
    const closed = once(socket, "close");
    socket.send(Buffer.from(serializeBridgeMessage({
      schema: BRIDGE_SCHEMAS.authenticate,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      clientNonce: randomBytes(32).toString("hex"),
      extensionId,
      runtimeRevision: revision,
      catalogDigest: digest,
      sentAt: Date.now(),
    })));
    const [code, reason] = await closed;
    expect(code).toBe(4400);
    expect(reason.toString()).toBe("invalid_message");
    expect(server.health()).toMatchObject({ connected: false, extensionId: null, bindingCount: 0 });
  });

  it("sends a private Bridge maintenance control without a catalog tool or course binding", async () => {
    const server = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      allowedExtensionIds: [extensionId],
      port: 0,
    });
    servers.push(server);
    const socket = await connect(server, []);
    commandHandler(socket, (command) => {
      expect(command.kind).toBe("bridge_maintenance");
      expect(command.maintenance).toEqual({ action: "status" });
      expect(command.toolName).toBeUndefined();
      expect(command.operationKey).toBeUndefined();
      expect(command.sourceBindingId).toBeUndefined();
      return {
        schema: "morrow.bridge.update-status.v1",
        extensionId,
        manifestVersion: "1.0.2",
        installType: "development",
        quiescent: false,
        activeFolderProof: { schema: "morrow.bridge.active-folder-proof.v1" },
      };
    });
    await expect(server.invoke({ kind: "bridge_maintenance", maintenance: { action: "status" }, operationId: "bridge-maintenance:status" }))
      .resolves.toMatchObject({ ok: true, result: { schema: "morrow.bridge.update-status.v1", quiescent: false } });
    await expect(server.invoke({ kind: "bridge_maintenance", maintenance: { action: "status", path: "/tmp/bridge" } as never }))
      .rejects.toThrow("maintenance control");
  });

  it("does not add the sole course binding to a multi-binding Edit policy command", async () => {
    const server = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      allowedExtensionIds: [extensionId],
      port: 0,
    });
    servers.push(server);
    const socket = await connect(server);
    commandHandler(socket, (command) => {
      expect(command.kind).toBe("edit_policy_set");
      expect(command.sourceBindingId).toBeUndefined();
      expect(command.editPolicySet).toEqual({
        mode: "edit",
        selections: [{
          sourceBindingId: "canvas-course-42",
          expectedPolicyRevision: 0,
          enabledCategories: ["canvas_page_content"],
        }],
      });
      return { schema: "morrow.bridge.edit-policy-set.v1", mode: "edit", entries: [] };
    });
    await expect(server.invoke({
      kind: "edit_policy_set",
      editPolicySet: {
        mode: "edit",
        selections: [{
          sourceBindingId: "canvas-course-42",
          expectedPolicyRevision: 0,
          enabledCategories: ["canvas_page_content"],
        }],
      },
      operationId: "edit-policy:course-42",
    })).resolves.toMatchObject({ ok: true, result: { schema: "morrow.bridge.edit-policy-set.v1" } });
  });

  it("sends a ui_state command with no course binding and refuses an invalid review list", async () => {
    const server = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      allowedExtensionIds: [extensionId],
      port: 0,
    });
    servers.push(server);
    const socket = await connect(server, []);
    commandHandler(socket, (command) => {
      expect(command.kind).toBe("ui_state");
      expect(command.sourceBindingId).toBeUndefined();
      expect(command.toolName).toBeUndefined();
      expect(command.uiState).toEqual({
        reviews: [{ url: "http://127.0.0.1:44200/operations/operation-42", label: "Review: Update syllabus in Intro to Biology" }],
      });
      return { schema: "morrow.bridge.ui-state-set.v1" };
    });
    await expect(server.invoke({
      kind: "ui_state",
      uiState: { reviews: [{ url: "http://127.0.0.1:44200/operations/operation-42", label: "Review: Update syllabus in Intro to Biology" }] },
      operationId: "ui-state:operation-42",
    })).resolves.toMatchObject({ ok: true, result: { schema: "morrow.bridge.ui-state-set.v1" } });
    await expect(server.invoke({
      kind: "ui_state",
      uiState: { reviews: [{ url: "https://127.0.0.1:44200/operations/operation-42", label: "Review" }] },
      operationId: "ui-state:bad-scheme",
    })).rejects.toThrow("loopback operations or batches address");
    await expect(server.invoke({ kind: "ui_state" })).rejects.toThrow("uiState has unsupported fields");
  });

  it("sends a private file attachment only with exact Moodle staged-file commands", async () => {
    const server = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      allowedExtensionIds: [extensionId],
      port: 0,
    });
    servers.push(server);
    const socket = await connect(server, [moodleBinding()]);
    const attachment = privateAttachment();
    let calls = 0;
    commandHandler(socket, (command) => {
      calls += 1;
      expect(command.privateAttachment).toEqual(attachment);
      const name = command.toolName === "moodle_create_imscp_package" || command.toolName === "moodle_create_scorm_package"
        ? "Week 1 package" : "Week 1 resource";
      expect(command.arguments).toEqual({
        course_id: 42,
        section_id: 7,
        name,
        filename: attachment.manifest.filename,
        size_bytes: attachment.manifest.size_bytes,
        sha256: attachment.manifest.sha256,
        expected_digest: "d".repeat(64),
      });
      expect(JSON.stringify(command.arguments)).not.toContain(attachment.bytes_base64);
      return { ok: true, sent: true };
    });
    await server.invoke({
      kind: "invoke_write",
      toolName: "moodle_create_resource_file",
      operationKey: "moodle.form.course.modedit.resource.file.create.write.v1",
      sourceBindingId: "moodle:course-42",
      arguments: {
        course_id: 42,
        section_id: 7,
        name: "Week 1 resource",
        filename: attachment.manifest.filename,
        size_bytes: attachment.manifest.size_bytes,
        sha256: attachment.manifest.sha256,
        expected_digest: "d".repeat(64),
      },
      privateAttachment: attachment,
      outerGrant: {
        planDigest: "a".repeat(64),
        approvalGrantDigest: "b".repeat(64),
        effectReceiptId: "effect:private-file-42",
        dispatchAttempt: 1,
        gatewayProcessId: "gateway:12345678",
        authorization: { kind: "review" },
      },
    });
    await server.invoke({
      kind: "invoke_write",
      toolName: "moodle_create_folder_file",
      operationKey: "moodle.form.course.modedit.folder.file.create.write.v1",
      sourceBindingId: "moodle:course-42",
      arguments: {
        course_id: 42,
        section_id: 7,
        name: "Week 1 resource",
        filename: attachment.manifest.filename,
        size_bytes: attachment.manifest.size_bytes,
        sha256: attachment.manifest.sha256,
        expected_digest: "d".repeat(64),
      },
      privateAttachment: attachment,
      outerGrant: {
        planDigest: "a".repeat(64),
        approvalGrantDigest: "b".repeat(64),
        effectReceiptId: "effect:private-folder-file-42",
        dispatchAttempt: 1,
        gatewayProcessId: "gateway:12345678",
        authorization: { kind: "review" },
      },
    });
    await server.invoke({
      kind: "invoke_write",
      toolName: "moodle_create_imscp_package",
      operationKey: "moodle.form.course.modedit.imscp.package.create.write.v1",
      sourceBindingId: "moodle:course-42",
      arguments: {
        course_id: 42,
        section_id: 7,
        name: "Week 1 package",
        filename: attachment.manifest.filename,
        size_bytes: attachment.manifest.size_bytes,
        sha256: attachment.manifest.sha256,
        expected_digest: "d".repeat(64),
      },
      privateAttachment: attachment,
      outerGrant: {
        planDigest: "a".repeat(64),
        approvalGrantDigest: "b".repeat(64),
        effectReceiptId: "effect:private-imscp-package-42",
        dispatchAttempt: 1,
        gatewayProcessId: "gateway:12345678",
        authorization: { kind: "review" },
      },
    });
    await server.invoke({
      kind: "invoke_write",
      toolName: "moodle_create_scorm_package",
      operationKey: "moodle.form.course.modedit.scorm.package.create.write.v1",
      sourceBindingId: "moodle:course-42",
      arguments: {
        course_id: 42,
        section_id: 7,
        name: "Week 1 package",
        filename: attachment.manifest.filename,
        size_bytes: attachment.manifest.size_bytes,
        sha256: attachment.manifest.sha256,
        expected_digest: "d".repeat(64),
      },
      privateAttachment: attachment,
      outerGrant: {
        planDigest: "a".repeat(64),
        approvalGrantDigest: "b".repeat(64),
        effectReceiptId: "effect:private-scorm-package-42",
        dispatchAttempt: 1,
        gatewayProcessId: "gateway:12345678",
        authorization: { kind: "review" },
      },
    });
    await expect(server.invoke({
      kind: "invoke_write",
      toolName: "moodle_update_page",
      operationKey: "moodle.form.course.modedit.page.write.v1",
      sourceBindingId: "moodle:course-42",
      arguments: { course_id: 42 },
      privateAttachment: attachment,
      outerGrant: {
        planDigest: "a".repeat(64),
        approvalGrantDigest: "b".repeat(64),
        effectReceiptId: "effect:private-file-rejected",
        dispatchAttempt: 1,
        gatewayProcessId: "gateway:12345678",
        authorization: { kind: "review" },
      },
    })).rejects.toThrow("private file attachment");
    await expect(server.invoke({
      kind: "invoke_write",
      toolName: "moodle_create_resource_file",
      operationKey: "moodle.form.course.modedit.resource.file.create.write.v1",
      sourceBindingId: "moodle:course-42",
      arguments: {
        course_id: 42,
        privateAttachment: attachment,
      },
      outerGrant: {
        planDigest: "a".repeat(64),
        approvalGrantDigest: "b".repeat(64),
        effectReceiptId: "effect:private-file-nested",
        dispatchAttempt: 1,
        gatewayProcessId: "gateway:12345678",
        authorization: { kind: "review" },
      },
    })).rejects.toThrow("outside public bridge arguments");
    expect(calls).toBe(4);
  });

  it("sends a private Canvas Inbox payload only on its exact current course command", async () => {
    const server = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      allowedExtensionIds: [extensionId],
      port: 0,
    });
    servers.push(server);
    const socket = await connect(server);
    const payload = privateConversation();
    let calls = 0;
    commandHandler(socket, (command) => {
      calls += 1;
      expect(command.kind).toBe("invoke_write");
      expect(command.toolName).toBe("canvas_send_private_conversation");
      expect(command.operationKey).toBe("canvas.private.conversation.send.v1");
      expect(command.arguments).toEqual({});
      expect(command.privateConversation).toEqual(payload);
      expect(JSON.stringify(command.arguments)).not.toContain("27");
      return { ok: true, sent: true };
    });
    await expect(server.invoke({
      kind: "invoke_write",
      toolName: "canvas_send_private_conversation",
      operationKey: "canvas.private.conversation.send.v1",
      arguments: {},
      privateConversation: payload,
      sourceBindingId: "canvas-course-42",
      operationId: "operation:private-conversation-42",
      outerGrant: {
        planDigest: "a".repeat(64),
        approvalGrantDigest: "b".repeat(64),
        effectReceiptId: "effect:private-conversation-42",
        dispatchAttempt: 1,
        gatewayProcessId: "gateway:12345678",
        authorization: { kind: "review" },
      },
    })).resolves.toMatchObject({ ok: true, result: { ok: true } });
    await expect(server.invoke({
      kind: "invoke_write",
      toolName: "canvas_create_conversation",
      operationKey: "POST /v1/conversations#create_conversation",
      arguments: {},
      privateConversation: payload,
      sourceBindingId: "canvas-course-42",
      operationId: "operation:private-conversation-mismatch",
      outerGrant: {
        planDigest: "a".repeat(64),
        approvalGrantDigest: "b".repeat(64),
        effectReceiptId: "effect:private-conversation-mismatch",
        dispatchAttempt: 1,
        gatewayProcessId: "gateway:12345678",
        authorization: { kind: "review" },
      },
    })).rejects.toThrow("private Canvas Inbox payload");
    expect(calls).toBe(1);
  });

  /**
   * The Bridge folder Morrow set up carries a secret no HTTP request can read, and the Bridge
   * proves it holds that secret only after the educator selects Connect Morrow in the popup.
   */
  const folderSecret = {
    challengeId: "morrow-0123456789abcdef0123456789abcdef",
    nonce: randomBytes(32).toString("base64url"),
    extensionId,
  };

  function pairingProof(
    nonce: string,
    pairing: { pairingId: string; challenge: string },
    activeFolderChallengeId = folderSecret.challengeId,
    proofExtensionId = extensionId,
  ): string {
    return createHmac("sha256", Buffer.from(nonce, "utf8"))
      .update(bridgePairingProofPayload({ pairingId: pairing.pairingId, challenge: pairing.challenge, extensionId: proofExtensionId, activeFolderChallengeId }))
      .digest("base64url");
  }

  async function pairingServer(options: Partial<ConstructorParameters<typeof LoopbackBridgeServer>[0]> = {}) {
    const server = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      port: 0,
      pairingEnabled: true,
      pairingSecret: () => folderSecret,
      ...options,
    });
    servers.push(server);
    const address = await server.start();
    const base = `http://${address.host}:${address.port}${address.path}`;
    const origin = `chrome-extension://${extensionId}`;
    const request = async (id = extensionId) => fetch(`${base}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `chrome-extension://${id}` },
      body: JSON.stringify({ extensionId: id, catalogDigest: digest, runtimeRevision: revision }),
    });
    const confirm = async (pairing: { confirmUrl: string }, body: unknown) => fetch(pairing.confirmUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body),
    });
    return { server, address, base, origin, request, confirm };
  }

  it("pairs a Bridge that proves it holds its folder secret, and hands it the token once", async () => {
    const approved: string[] = [];
    const { server, base, request, confirm } = await pairingServer({ onPairApproved: (id) => { approved.push(id); } });
    const created = await request();
    expect(created.status).toBe(201);
    const pairing = await created.json() as { schema: string; pairingId: string; challenge: string; confirmUrl: string; expiresAt: number };
    expect(pairing).toEqual({
      schema: "morrow.bridge.pairing.v2",
      pairingId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      confirmUrl: `${base}/pair/${pairing.pairingId}/confirm`,
      expiresAt: expect.any(Number),
    });
    expect(JSON.stringify(pairing)).not.toContain(token);

    const confirmed = await confirm(pairing, { extensionId, activeFolderChallengeId: folderSecret.challengeId, proof: pairingProof(folderSecret.nonce, pairing) });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toEqual({ schema: "morrow.bridge.pairing-result.v2", status: "approved", token });
    expect(approved).toEqual([extensionId]);
    await connect(server);
    expect(server.health()).toMatchObject({ connected: true, extensionId });

    const again = await confirm(pairing, { extensionId, activeFolderChallengeId: folderSecret.challengeId, proof: pairingProof(folderSecret.nonce, pairing) });
    expect(again.status).toBe(404);
    expect(JSON.stringify(await again.json())).not.toContain(token);
  });

  it("refuses a pairing a local program confirms over HTTP without the folder secret", async () => {
    const approved: string[] = [];
    const { server, base, origin, request, confirm } = await pairingServer({ onPairApproved: (id) => { approved.push(id); } });
    const pairing = await (await request()).json() as { pairingId: string; challenge: string; confirmUrl: string };
    // A program that sets every header a browser would, and guesses at the secret.
    const forged = await confirm(pairing, { extensionId, activeFolderChallengeId: folderSecret.challengeId, proof: pairingProof(randomBytes(32).toString("base64url"), pairing) });
    expect(forged.status).toBe(403);
    const refusal = await forged.json();
    expect(refusal).toEqual({ error: "pairing_proof_refused" });
    // The request is spent: the real proof cannot be tried after a wrong one.
    const late = await confirm(pairing, { extensionId, activeFolderChallengeId: folderSecret.challengeId, proof: pairingProof(folderSecret.nonce, pairing) });
    expect(late.status).toBe(404);
    for (const response of [late]) expect(JSON.stringify(await response.json())).not.toContain(token);
    expect(approved).toEqual([]);

    // A proof for one pairing, or for another folder challenge, confirms nothing else.
    const first = await (await request()).json() as { pairingId: string; challenge: string; confirmUrl: string };
    const second = await (await request()).json() as { pairingId: string; challenge: string; confirmUrl: string };
    expect(second.pairingId).not.toBe(first.pairingId);
    expect(second.challenge).not.toBe(first.challenge);
    expect((await confirm(second, { extensionId, activeFolderChallengeId: folderSecret.challengeId, proof: pairingProof(folderSecret.nonce, first) })).status).toBe(403);
    expect((await confirm(first, { extensionId, activeFolderChallengeId: "morrow-ffffffffffffffffffffffffffffffff", proof: pairingProof(folderSecret.nonce, first, "morrow-ffffffffffffffffffffffffffffffff") })).status).toBe(403);
    expect(approved).toEqual([]);

    // The routes that approved a pairing and read back its token over HTTP are gone.
    for (const [path, method] of [[`/pair/${pairing.pairingId}`, "GET"], [`/pair/${pairing.pairingId}/decision`, "POST"], [`/pair/${pairing.pairingId}/status`, "GET"], [`/pair/${pairing.pairingId}/status`, "POST"]] as const) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { origin: path.endsWith("decision") ? new URL(base).origin : origin, "content-type": "application/x-www-form-urlencoded" },
        ...(method === "POST" ? { body: path.endsWith("decision") ? "decision=approve" : JSON.stringify({ extensionId }) } : {}),
        redirect: "manual",
      });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(token);
    }
    expect(server.health().connected).toBe(false);
  });

  it("pairs only the Bridge that Morrow set up, and nothing while Morrow has no Bridge folder", async () => {
    const other = "b".repeat(32);
    const pinned = await pairingServer();
    const refusedId = await pinned.request(other);
    expect(refusedId.status).toBe(403);
    expect(await refusedId.json()).toEqual({ error: "extension_identity_refused" });

    let secret: typeof folderSecret | null = null;
    const unset = await pairingServer({ pairingSecret: async () => secret });
    const early = await unset.request();
    expect(early.status).toBe(409);
    expect(await early.json()).toEqual({ error: "pairing_folder_unconfirmed" });
    secret = folderSecret;
    const pairing = await (await unset.request()).json() as { pairingId: string; challenge: string; confirmUrl: string };
    secret = null;
    const gone = await unset.confirm(pairing, { extensionId, activeFolderChallengeId: folderSecret.challengeId, proof: pairingProof(folderSecret.nonce, pairing) });
    expect(gone.status).toBe(409);
    expect(await gone.json()).toEqual({ error: "pairing_folder_unconfirmed" });

    const absent = await pairingServer({ pairingSecret: undefined });
    expect((await absent.request()).status).toBe(409);
  });

  it("refuses malformed UTF-8 in a pairing confirmation", async () => {
    const { request, confirm } = await pairingServer();
    const pairing = await (await request()).json() as { confirmUrl: string };
    const malformed = Buffer.concat([Buffer.from(`{"extensionId":"${extensionId}`), Buffer.from([0xff]), Buffer.from('"}')]);
    const status = await confirm(pairing, malformed);
    expect(status.status).toBe(400);
    expect(await status.json()).toEqual({ error: "invalid_request" });
  });

  it("hands out no token when the durable approval fails", async () => {
    const { server, request, confirm } = await pairingServer({ onPairApproved: async () => { throw new Error("state unavailable"); } });
    const pairing = await (await request()).json() as { pairingId: string; challenge: string; confirmUrl: string };
    const failed = await confirm(pairing, { extensionId, activeFolderChallengeId: folderSecret.challengeId, proof: pairingProof(folderSecret.nonce, pairing) });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "pairing_approval_failed" });
    expect(server.health().extensionId).toBeNull();
  });

  it("disconnects a client that misses two heartbeat intervals", async () => {
    const server = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      allowedExtensionIds: [extensionId],
      port: 0,
      heartbeatMs: 100,
    });
    servers.push(server);
    const socket = await connect(server);
    await once(socket, "close");
    expect(server.health()).toMatchObject({ connected: false, bindingCount: 0 });
  });

  it("names the held Bridge port instead of failing with an upstream error, and leaves the first Morrow working", async () => {
    const first = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      allowedExtensionIds: [extensionId],
      port: 0,
    });
    servers.push(first);
    const held = await first.start();

    const second = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      allowedExtensionIds: [extensionId],
      port: held.port,
    });
    servers.push(second);
    const failure = await second.start().then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(BridgePortInUseError);
    // Nothing reached the extension, so this stays in the not-sent family.
    expect(failure).toBeInstanceOf(BridgeUnavailableError);
    expect((failure as BridgePortInUseError).code).toBe("bridge_port_in_use");
    expect((failure as BridgePortInUseError).port).toBe(held.port);
    expect((failure as BridgePortInUseError).message).toBe(bridgePortInUseMessage(held.port));
    expect(bridgePortInUseMessage(32147)).toBe(
      "Another Morrow is already connected to Morrow Bridge on port 32147. Close the other Morrow, or use one Morrow for all your assistants.",
    );

    // The second Morrow can still be asked what is wrong, and every command it
    // is given answers with the same named state.
    expect(second.health()).toMatchObject({
      listening: false,
      connected: false,
      port: null,
      problem: { code: "bridge_port_in_use", port: held.port, message: bridgePortInUseMessage(held.port) },
    });
    const refused = await second.invoke({
      kind: "invoke_read",
      toolName: "list_pages",
      operationKey: "GET /v1/courses/{course_id}/pages#list_pages",
      arguments: { course_id: "42" },
      sourceBindingId: "canvas-course-42",
    }).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(BridgePortInUseError);
    expect(bridgeFailureResult(refused)).toMatchObject({
      code: "bridge_port_in_use",
      message: bridgePortInUseMessage(held.port),
      recoverable: true,
    });

    // The Morrow that holds the port is untouched: it still accepts the
    // extension and still answers commands.
    const socket = await connect(first);
    commandHandler(socket, () => ({ pages: [{ id: "1" }] }));
    expect(await first.invoke({
      kind: "invoke_read",
      toolName: "list_pages",
      operationKey: "GET /v1/courses/{course_id}/pages#list_pages",
      arguments: { course_id: "42" },
      sourceBindingId: "canvas-course-42",
    })).toMatchObject({ ok: true, result: { pages: [{ id: "1" }] } });
    expect(first.health()).toMatchObject({ listening: true, connected: true, port: held.port });
    expect(first.health().problem).toBeUndefined();
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

  it("refuses a Moodle command for a Canvas binding", async () => {
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
      kind: "invoke_read",
      toolName: "moodle_get_course",
      operationKey: "moodle.ajax.core_course_get_courses.v1",
      sourceBindingId: "canvas-course-42",
    })).rejects.toThrow("moodle binding");
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

  it("removes and cancels the exact pending Private Chat request on abort", async () => {
    const server = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      allowedExtensionIds: [extensionId],
      port: 0,
    });
    servers.push(server);
    const socket = await connect(server, []);
    const controller = new AbortController();
    let command: BridgeCommand | undefined;
    let resolveCancellation!: (value: Record<string, unknown>) => void;
    const cancellation = new Promise<Record<string, unknown>>((resolve) => {
      resolveCancellation = resolve;
    });
    socket.on("message", (raw) => {
      const message = parseBridgeJson(raw.toString()) as Record<string, unknown>;
      if (message.schema === BRIDGE_SCHEMAS.command) command = message as unknown as BridgeCommand;
      if (message.schema === BRIDGE_SCHEMAS.cancel) resolveCancellation(message);
    });

    const pending = server.invoke({
      kind: "private_chat_exchange",
      arguments: { action: "listen" },
      operationId: "private-chat:cancel-1234",
      signal: controller.signal,
    });
    while (!command) await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(BridgeRequestCancelledError);
    await expect(cancellation).resolves.toMatchObject({
      schema: BRIDGE_SCHEMAS.cancel,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: command.requestId,
      operationId: command.operationId,
      generation: command.generation,
    });
    expect(server.health().pendingCount).toBe(0);
  });

  it("waits for an exact extension acknowledgement when a provider write is cancelled", async () => {
    const server = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      allowedExtensionIds: [extensionId],
      port: 0,
    });
    servers.push(server);
    const socket = await connect(server, [editableAssignmentBinding()]);
    const controller = new AbortController();
    let command: BridgeCommand | undefined;
    socket.on("message", (raw) => {
      const message = parseBridgeJson(raw.toString()) as Record<string, unknown>;
      if (message.schema === BRIDGE_SCHEMAS.command) command = message as unknown as BridgeCommand;
      if (message.schema !== BRIDGE_SCHEMAS.cancel || !command) return;
      socket.send(serializeBridgeMessage({
        schema: BRIDGE_SCHEMAS.result,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        requestId: command.requestId,
        operationId: command.operationId,
        generation: command.generation,
        ok: false,
        problem: {
          schema: "morrow.bridge.problem.v1",
          code: "request_cancelled_before_dispatch",
          message: "Morrow cancelled this request before the provider change started.",
          recoverable: true,
        },
        completedAt: Date.now(),
      }));
    });

    const pending = server.invoke({
      kind: "invoke_write",
      toolName: "canvas_edit_assignment",
      operationKey: "PUT /v1/courses/{course_id}/assignments/{id}#edit_assignment",
      arguments: { course_id: "42", id: "7", assignment_due_at: "2026-10-01T12:00:00Z" },
      sourceBindingId: "canvas-course-42",
      operationId: "operation:cancel-write-1234",
      outerGrant: {
        planDigest: digest,
        approvalGrantDigest: "b".repeat(64),
        effectReceiptId: "effect:cancel-write-1234",
        dispatchAttempt: 1,
        gatewayProcessId: "gateway:12345678",
        authorization: { kind: "review" },
      },
      signal: controller.signal,
    });
    while (!command) await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      problem: { code: "request_cancelled_before_dispatch" },
    });
    expect(server.health().pendingCount).toBe(0);
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
    const socket = await connect(server, [editableCanvasBinding()]);
    let calls = 0;
    commandHandler(socket, (command) => {
      if (command.kind === "edit_policy_options_get") return editOptions(editableCanvasPermission());
      calls += 1;
      expect(command.outerGrant).toMatchObject({ effectReceiptId: "effect:12345678", dispatchAttempt: 1, authorization: { kind: "edit_scope" } });
      return { taskId: "task-1" };
    });
    const outerGrant = {
      planDigest: digest,
      approvalGrantDigest: "b".repeat(64),
      effectReceiptId: "effect:12345678",
      dispatchAttempt: 1 as const,
      gatewayProcessId: "gateway:12345678",
      authorization: { kind: "edit_scope" as const, policyDigest: "c".repeat(64), policyRevision: 1 },
    };
    const invocation = {
      kind: "invoke_write" as const,
      toolName: "canvas_update_create_page_courses",
      operationKey: "PUT /v1/courses/{course_id}/pages/{url_or_id}#update_create_page",
      sourceBindingId: "canvas-course-42",
      arguments: {
        course_id: "42",
        url_or_id: "week-1",
        morrow_page_guard: pageGuard,
      },
      outerGrant,
    };
    await server.invoke(invocation);
    await expect(server.invoke(invocation))
      .rejects.toBeInstanceOf(BridgeOutcomeUnknownError);
    expect(calls).toBe(1);
  });

  it("does not consume an effect receipt until its command is serialized and sent", async () => {
    const server = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      allowedExtensionIds: [extensionId],
      port: 0,
    });
    servers.push(server);
    const socket = await connect(server, [editableCanvasBinding()]);
    let writes = 0;
    commandHandler(socket, (command) => {
      if (command.kind === "edit_policy_options_get") return editOptions(editableCanvasPermission());
      writes += 1;
      return { taskId: "task-after-serialization-refusal" };
    });
    const outerGrant = {
      planDigest: digest,
      approvalGrantDigest: "b".repeat(64),
      effectReceiptId: "effect:serialize-refusal",
      dispatchAttempt: 1 as const,
      gatewayProcessId: "gateway:12345678",
      authorization: { kind: "review" as const },
    };
    const write = (body: string) => server.invoke({
      kind: "invoke_write",
      toolName: "canvas_update_create_page_courses",
      operationKey: "PUT /v1/courses/{course_id}/pages/{url_or_id}#update_create_page",
      sourceBindingId: "canvas-course-42",
      arguments: { course_id: "42", url_or_id: "week-1", wiki_page_body: body, morrow_page_guard: pageGuard },
      outerGrant,
    });

    await expect(write("x".repeat(MAX_BRIDGE_MESSAGE_BYTES))).rejects.toThrow();
    await expect(write("small body")).resolves.toMatchObject({ ok: true });
    expect(writes).toBe(1);
  });

  it("bounds aggregate pending Bridge requests before sending another command", async () => {
    const server = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      allowedExtensionIds: [extensionId],
      port: 0,
      callTimeoutMs: 100,
    });
    servers.push(server);
    await connect(server, [editableCanvasBinding()]);
    const pending = Array.from({ length: 64 }, (_, index) => server.invoke({
      kind: "invoke_read",
      toolName: "canvas_fixture_read",
      operationKey: `GET /v1/courses/{course_id}/fixture/${index}`,
      sourceBindingId: "canvas-course-42",
      arguments: { course_id: "42" },
    }).catch((error) => error));
    await expect(server.invoke({
      kind: "invoke_read",
      toolName: "canvas_fixture_read",
      operationKey: "GET /v1/courses/{course_id}/fixture/overflow",
      sourceBindingId: "canvas-course-42",
      arguments: { course_id: "42" },
    })).rejects.toBeInstanceOf(BridgeRequestCapacityError);
    expect(server.health().pendingCount).toBe(64);
    await Promise.all(pending);
    expect(server.health().pendingCount).toBe(0);
  });

  // The record of sent receipts is bounded, so a bridge that runs for days cannot grow without a
  // limit. A bounded record that dropped its oldest entry would send that change a second time, so
  // the full record refuses the new change and every earlier receipt stays refused.
  it("refuses a new write instead of forgetting a receipt it already sent", async () => {
    const server = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      allowedExtensionIds: [extensionId],
      port: 0,
      writeReceiptCapacity: 2,
    });
    servers.push(server);
    const socket = await connect(server, [editableCanvasBinding()]);
    let calls = 0;
    commandHandler(socket, (command) => {
      if (command.kind === "edit_policy_options_get") return editOptions(editableCanvasPermission());
      calls += 1;
      return { taskId: `task-${calls}` };
    });
    const write = (receipt: string) => ({
      kind: "invoke_write" as const,
      toolName: "canvas_update_create_page_courses",
      operationKey: "PUT /v1/courses/{course_id}/pages/{url_or_id}#update_create_page",
      sourceBindingId: "canvas-course-42",
      arguments: { course_id: "42", url_or_id: "week-1", morrow_page_guard: pageGuard },
      outerGrant: {
        planDigest: digest,
        approvalGrantDigest: "b".repeat(64),
        effectReceiptId: receipt,
        dispatchAttempt: 1 as const,
        gatewayProcessId: "gateway:12345678",
        authorization: { kind: "edit_scope" as const, policyDigest: "c".repeat(64), policyRevision: 1 },
      },
    });
    await server.invoke(write("effect:11111111"));
    await server.invoke(write("effect:22222222"));

    const refused = await server.invoke(write("effect:33333333")).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(BridgeWriteRecordFullError);
    expect(refused).toBeInstanceOf(BridgeUnavailableError);
    expect((refused as BridgeWriteRecordFullError).code).toBe("bridge_write_record_full");
    expect((refused as BridgeWriteRecordFullError).message).toBe(bridgeWriteRecordFullMessage(2));
    expect(bridgeFailureResult(refused)).toMatchObject({
      schema: "morrow.bridge.problem.v1",
      code: "bridge_write_record_full",
      message: bridgeWriteRecordFullMessage(2),
    });
    // Nothing was forgotten to make room, so both earlier receipts are still refused as used.
    for (const receipt of ["effect:11111111", "effect:22222222"]) {
      await expect(server.invoke(write(receipt))).rejects.toBeInstanceOf(BridgeOutcomeUnknownError);
    }
    expect(calls).toBe(2);
  });

  it("reports a write cancelled while its Edit permission is read as cancelled, not as an unreadable permission", async () => {
    const server = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      allowedExtensionIds: [extensionId],
      port: 0,
    });
    servers.push(server);
    const socket = await connect(server, [editableCanvasBinding()]);
    let optionsRead: BridgeCommand | undefined;
    let writes = 0;
    socket.on("message", (raw) => {
      const message = parseBridgeJson(raw.toString()) as { schema?: string; kind?: string } | undefined;
      if (message?.schema === BRIDGE_SCHEMAS.command) {
        const command = message as unknown as BridgeCommand;
        if (command.kind === "edit_policy_options_get") optionsRead = command;
        else writes += 1;
        return;
      }
      if (message?.schema !== BRIDGE_SCHEMAS.cancel || !optionsRead) return;
      socket.send(serializeBridgeMessage({
        schema: BRIDGE_SCHEMAS.result,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        requestId: optionsRead.requestId,
        operationId: optionsRead.operationId,
        generation: optionsRead.generation,
        ok: false,
        problem: {
          schema: "morrow.bridge.problem.v1",
          code: "request_cancelled_before_dispatch",
          message: "Morrow cancelled this request before the provider change started.",
          recoverable: true,
        },
        completedAt: Date.now(),
      }));
    });
    const abort = new AbortController();
    const pending = server.invoke({
      kind: "invoke_write",
      toolName: "canvas_update_create_page_courses",
      operationKey: "PUT /v1/courses/{course_id}/pages/{url_or_id}#update_create_page",
      sourceBindingId: "canvas-course-42",
      arguments: { course_id: "42", url_or_id: "week-1", morrow_page_guard: pageGuard },
      outerGrant: {
        planDigest: digest,
        approvalGrantDigest: "b".repeat(64),
        effectReceiptId: "effect:cancel-during-permission-read",
        dispatchAttempt: 1 as const,
        gatewayProcessId: "gateway:12345678",
        authorization: { kind: "edit_scope" as const, policyDigest: "c".repeat(64), policyRevision: 1 },
      },
      signal: abort.signal,
    });
    await vi.waitFor(() => expect(optionsRead).toBeDefined());
    abort.abort();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      problem: { code: "request_cancelled_before_dispatch" },
    });
    expect(writes).toBe(0);
    expect(server.health().pendingCount).toBe(0);
  });

  // The write is sent only after its Edit permission is read. A permission read that never answers,
  // or a Bridge that disconnects during it, leaves the write unsent, so its outcome is known.
  it.each([
    ["the permission read reaches its deadline", (_socket: WebSocket) => undefined],
    ["the Bridge disconnects during the permission read", (socket: WebSocket) => socket.terminate()],
  ])("reports a write as not sent when %s", async (_name, onOptionsRead) => {
    const server = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      allowedExtensionIds: [extensionId],
      port: 0,
      callTimeoutMs: 300,
    });
    servers.push(server);
    const socket = await connect(server, [editableCanvasBinding()]);
    let writes = 0;
    socket.on("message", (raw) => {
      const message = parseBridgeJson(raw.toString()) as { schema?: string; kind?: string } | undefined;
      if (message?.schema !== BRIDGE_SCHEMAS.command) return;
      if (message.kind === "edit_policy_options_get") onOptionsRead(socket);
      else writes += 1;
    });
    const failure = await server.invoke({
      kind: "invoke_write",
      toolName: "canvas_update_create_page_courses",
      operationKey: "PUT /v1/courses/{course_id}/pages/{url_or_id}#update_create_page",
      sourceBindingId: "canvas-course-42",
      arguments: { course_id: "42", url_or_id: "week-1", morrow_page_guard: pageGuard },
      outerGrant: {
        planDigest: digest,
        approvalGrantDigest: "b".repeat(64),
        effectReceiptId: "effect:permission-read-unanswered",
        dispatchAttempt: 1 as const,
        gatewayProcessId: "gateway:12345678",
        authorization: { kind: "edit_scope" as const, policyDigest: "c".repeat(64), policyRevision: 1 },
      },
      timeoutMs: 5_000,
    }).then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(BridgeUnavailableError);
    expect(failure).not.toBeInstanceOf(BridgeOutcomeUnknownError);
    expect((failure as Error).message).toBe("Morrow could not read the current Edit permission for this course, so it did not send the change. Create a fresh plan from the current binding.");
    expect(writes).toBe(0);
    expect(server.health().pendingCount).toBe(0);
  });

  it("refuses a revoked edit permission before sending", async () => {
    const server = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      allowedExtensionIds: [extensionId],
      port: 0,
    });
    servers.push(server);
    const socket = await connect(server, [editableCanvasBinding()]);
    let calls = 0;
    commandHandler(socket, () => {
      calls += 1;
      return { taskId: "task-1" };
    });
    socket.send(serializeBridgeMessage({
      schema: BRIDGE_SCHEMAS.bindings,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      generation: 1,
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
    for (let attempt = 0; attempt < 20 && server.listBindings()[0]?.editPermission; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    expect(server.listBindings()[0]?.editPermission).toBeUndefined();
    await expect(server.invoke({
      kind: "invoke_write",
      toolName: "canvas_update_create_page_courses",
      operationKey: "PUT /v1/courses/{course_id}/pages/{url_or_id}#update_create_page",
      sourceBindingId: "canvas-course-42",
      arguments: {
        course_id: "42",
        url_or_id: "week-1",
        morrow_page_guard: pageGuard,
      },
      outerGrant: {
        planDigest: digest,
        approvalGrantDigest: "b".repeat(64),
        effectReceiptId: "effect:revoke123",
        dispatchAttempt: 1,
        gatewayProcessId: "gateway:12345678",
        authorization: { kind: "edit_scope", policyDigest: "c".repeat(64), policyRevision: 1 },
      },
    })).rejects.toThrow("edit permission");
    expect(calls).toBe(0);
  });

  it("does not send an empty Canvas Assignment due-date Edit scope", async () => {
    const server = new LoopbackBridgeServer({
      token,
      expectedRuntimeRevision: revision,
      expectedCatalogDigest: digest,
      allowedExtensionIds: [extensionId],
      port: 0,
    });
    servers.push(server);
    const socket = await connect(server, [editableAssignmentBinding()]);
    let calls = 0;
    commandHandler(socket, (command) => {
      if (command.kind === "edit_policy_options_get") return editOptions(editableAssignmentPermission());
      calls += 1;
      return { taskId: "task-1" };
    });
    await expect(server.invoke({
      kind: "invoke_write",
      toolName: "canvas_edit_assignment",
      operationKey: "PUT /v1/courses/{course_id}/assignments/{id}#edit_assignment",
      sourceBindingId: "canvas-course-42",
      arguments: { course_id: "42", id: "88" },
      outerGrant: {
        planDigest: digest,
        approvalGrantDigest: "b".repeat(64),
        effectReceiptId: "effect:empty-due-date",
        dispatchAttempt: 1,
        gatewayProcessId: "gateway:12345678",
        authorization: { kind: "edit_scope", policyDigest: "e".repeat(64), policyRevision: 1 },
      },
    })).rejects.toThrow("edit permission");
    expect(calls).toBe(0);
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
