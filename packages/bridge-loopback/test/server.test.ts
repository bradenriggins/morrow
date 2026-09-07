import { once } from "node:events";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SCHEMAS,
  parseBridgeJson,
  serializeBridgeMessage,
  type BridgeCommand,
  type BridgeBinding,
} from "@morrow/bridge-protocol";
import {
  BridgeOutcomeUnknownError,
  BridgePortInUseError,
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
  socket.send(serializeBridgeMessage({
    schema: BRIDGE_SCHEMAS.hello,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    token,
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
      headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(pairing.approvalUrl).origin },
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
    const page = await fetch(pairing.approvalUrl);
    expect(await page.text()).toContain("Chrome connection approved");
    await fetch(`${pairing.approvalUrl}/decision`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(pairing.approvalUrl).origin },
      body: "decision=deny",
    });
    const unchanged = await fetch(pairing.statusUrl, { headers: { origin } });
    expect(await unchanged.json()).toMatchObject({ status: "approved" });
    const expired = await fetch(pairing.approvalUrl.replace(/[0-9a-f-]{36}$/, "00000000-0000-0000-0000-000000000000"), { headers: { accept: "text/html" } });
    expect(expired.status).toBe(404);
    expect(await expired.text()).toContain("Start a new connection");
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
