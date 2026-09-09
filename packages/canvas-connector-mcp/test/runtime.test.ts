import { once } from "node:events";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { augmentBridgeInputSchema, BRIDGE_PROTOCOL_VERSION, BRIDGE_SCHEMAS, parseBridgeJson, serializeBridgeMessage, type BridgeBinding, type BridgeCommand } from "@morrow/bridge-protocol";
import type { CanvasConnectorConfig } from "../src/config.js";
import {
  CanvasConnectorRuntime,
  ITEM_BANK_GUARD_FIELDS,
  PRIVATE_MOODLE_ENROLMENT_CANDIDATE_OPERATION,
  PRIVATE_MOODLE_ENROLMENT_CANDIDATE_TOOL,
} from "../src/runtime.js";
// The guard field list the connector checks at its boundary is the extension's list. A change to
// one without the other would let a differently shaped guard through here and be refused later.
import { ITEM_BANK_GUARD_FIELDS as EXTENSION_ITEM_BANK_GUARD_FIELDS } from "../../../connector/extension/src/item-bank-guard.js";

const token = "connector-secret-".repeat(4);
const extensionId = "a".repeat(32);
const runtimes: CanvasConnectorRuntime[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const runtime of runtimes.splice(0)) await runtime.close();
});

async function start(bindings: readonly BridgeBinding[] = [{
  sourceBindingId: "canvas:test-account",
  provider: "canvas",
  origin: "https://school.instructure.com",
  principalFingerprint: "b".repeat(64),
  courseId: "42",
  sessionGeneration: 1,
  runtimeVerified: true,
}], runtimeRevision = "1.0.0-rc.0"): Promise<CanvasConnectorRuntime> {
  const config: CanvasConnectorConfig = {
    statePath: ":memory:",
    catalogPath: resolve("../../artifacts/canvas-api/canvas-api-catalog.json"),
    token,
    port: 0,
    runtimeRevision,
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
    runtimeRevision,
    catalogDigest: runtime.catalogDigest,
    bindings,
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

function privateAttachment() {
  const bytes = Buffer.from("private Moodle resource\n", "utf8");
  return {
    schema: "morrow.private-file-attachment.v1",
    handle: "file:resource-attachment-42",
    manifest: {
      filename: "week-1.txt",
      size_bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    bytes_base64: bytes.toString("base64"),
  };
}

function canvasPrivateAttachment() {
  const bytes = Buffer.from("private Canvas course material\n", "utf8");
  return {
    schema: "morrow.private-file-attachment.v1" as const,
    handle: "file:canvas-course-material-42",
    manifest: {
      filename: "week-1.txt",
      size_bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    content_type: "text/plain",
    bytes_base64: bytes.toString("base64"),
  };
}

describe("CanvasConnectorRuntime", () => {
  it("relays only the strict protected Private chat result over a local Bridge command", async () => {
    const runtime = await start();
    const socket = sockets.at(-1)!;
    socket.on("message", (raw) => {
      const value = parseBridgeJson(raw.toString()) as { schema?: string };
      if (value.schema !== BRIDGE_SCHEMAS.command) return;
      const command = value as BridgeCommand;
      expect(command.kind).toBe("private_chat_exchange");
      expect(command.toolName).toBeUndefined();
      expect(command.arguments).toEqual({
        schema: "morrow.private-chat.exchange.v1",
        action: "listen",
        sessionId: "session:private-chat-1",
        assistantName: "Codex",
      });
      socket.send(serializeBridgeMessage({
        schema: BRIDGE_SCHEMAS.result,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        requestId: command.requestId,
        operationId: command.operationId,
        generation: command.generation,
        ok: true,
        result: {
          schema: "morrow.private-chat.exchange.v1",
          status: "message",
          sessionId: "session:private-chat-1",
          sourceBindingId: "canvas:test-account",
          courseId: "42",
          protectedText: "Review Student A1.",
        },
        completedAt: Date.now(),
      }));
    });
    await expect(runtime.privateChatExchange({
      schema: "morrow.private-chat.exchange.v1",
      action: "listen",
      sessionId: "session:private-chat-1",
      assistantName: "Codex",
    })).resolves.toMatchObject({ status: "message", protectedText: "Review Student A1." });
  });

  it("routes private Bridge maintenance outside the course catalog", async () => {
    const runtime = await start([]);
    const socket = sockets.at(-1)!;
    socket.on("message", (raw) => {
      const value = parseBridgeJson(raw.toString()) as { schema?: string };
      if (value.schema !== BRIDGE_SCHEMAS.command) return;
      const command = value as BridgeCommand;
      expect(command.kind).toBe("bridge_maintenance");
      expect(command.maintenance).toEqual({ action: "readback" });
      expect(command.toolName).toBeUndefined();
      socket.send(serializeBridgeMessage({
        schema: BRIDGE_SCHEMAS.result,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        requestId: command.requestId,
        operationId: command.operationId,
        generation: command.generation,
        ok: true,
        result: {
          schema: "morrow.bridge.update-readback.v1",
          extensionId,
          manifestVersion: "1.0.2",
          installType: "development",
          activeFolderProof: { schema: "morrow.bridge.active-folder-proof.v1" },
        },
        completedAt: Date.now(),
      }));
    });
    await expect(runtime.bridgeMaintenance({ action: "readback" })).resolves.toMatchObject({
      schema: "morrow.bridge.update-readback.v1",
      installType: "development",
    });
    await expect(runtime.bridgeMaintenance({ action: "resume", quiesceEpoch: "short", fileLayerRestored: true } as never))
      .resolves.toMatchObject({ ok: false, problem: { code: "bridge_maintenance_control_invalid" } });
  });

  it("reads individual Edit options only for one exact current browser binding", async () => {
    const runtime = await start();
    const socket = sockets.at(-1)!;
    socket.on("message", (raw) => {
      const value = parseBridgeJson(raw.toString()) as { schema?: string };
      if (value.schema !== BRIDGE_SCHEMAS.command) return;
      const command = value as BridgeCommand;
      expect(command.kind).toBe("edit_policy_options_get");
      expect(command.sourceBindingId).toBe("canvas:test-account");
      socket.send(serializeBridgeMessage({
        schema: BRIDGE_SCHEMAS.result,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        requestId: command.requestId,
        operationId: command.operationId,
        generation: command.generation,
        ok: true,
        result: {
          schema: "morrow.bridge.edit-options.v1",
          sourceBindingId: "canvas:test-account",
          provider: "canvas",
          catalogDigest: runtime.catalogDigest,
          policyRevision: 0,
          runtimeVerified: true,
          options: [{ id: "canvas_assignment_due_date", group: "Focused Canvas repairs", label: "Change Canvas Assignment due date only", description: "Change one due date.", availability: "edit" }],
        },
        completedAt: Date.now(),
      }));
    });
    await expect(runtime.editOptions("canvas:test-account")).resolves.toMatchObject({
      schema: "morrow.bridge.edit-options.v1",
      sourceBindingId: "canvas:test-account",
      options: [{ id: "canvas_assignment_due_date", availability: "edit" }],
    });
    await expect(runtime.editOptions("missing-binding")).rejects.toThrow("course connection");
  });

  it("routes and privacy-projects one private Moodle enrolment candidate read outside every catalog", async () => {
    const runtime = await start([{
      sourceBindingId: "moodle:course-42",
      provider: "moodle",
      origin: "https://school.example.edu",
      siteUrl: "https://school.example.edu/moodle",
      courseId: "42",
      principalFingerprint: "b".repeat(64),
      sessionGeneration: 1,
      runtimeVerified: true,
    }]);
    expect(runtime.operations.has(PRIVATE_MOODLE_ENROLMENT_CANDIDATE_TOOL)).toBe(false);
    expect(runtime.moodleCatalog.operations.some((entry) => entry.toolName === PRIVATE_MOODLE_ENROLMENT_CANDIDATE_TOOL)).toBe(false);
    const socket = sockets.at(-1)!;
    let commands = 0;
    let invalidResult = false;
    socket.on("message", (raw) => {
      const value = parseBridgeJson(raw.toString()) as { schema?: string };
      if (value.schema !== BRIDGE_SCHEMAS.command) return;
      const command = value as BridgeCommand;
      commands += 1;
      expect(command.kind).toBe("invoke_read");
      expect(command.toolName).toBe(PRIVATE_MOODLE_ENROLMENT_CANDIDATE_TOOL);
      expect(command.operationKey).toBe(PRIVATE_MOODLE_ENROLMENT_CANDIDATE_OPERATION);
      expect(command.sourceBindingId).toBe("moodle:course-42");
      expect(command.arguments).toEqual({ course_id: 42, query: "Mary Jackson" });
      expect(command.outerGrant).toBeUndefined();
      socket.send(serializeBridgeMessage({
        schema: BRIDGE_SCHEMAS.result,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        requestId: command.requestId,
        operationId: command.operationId,
        generation: command.generation,
        ok: true,
        result: {
          schema: "morrow.canvas-browser-result.v1",
          ok: true,
          sent: false,
          status: 200,
          complete: true,
          provider: "moodle",
          privateUnexpectedName: "Mary Jackson",
          data: {
            schema: "morrow.moodle-enrolment-candidate.private.v1",
            provider: "moodle",
            course_id: 42,
            candidate: invalidResult ? { user_id: "not-an-id", email: "mary@example.edu" } : { user_id: "21", email: "mary@example.edu" },
            match: { kind: "exact_native_query", candidate_count: 1, query: "Mary Jackson" },
            proof: {
              method: "native_manual_enrolment_candidate_search",
              route: "/enrol/manual/manage.php",
              complete: true,
              dispatch_count: 0,
              read_request_count: 2,
              candidate_limit: 100,
            },
          },
        },
        completedAt: Date.now(),
      }));
    });
    const input = {
      course_id: 42,
      query: "Mary Jackson",
      _morrow: { source_binding_id: "moodle:course-42", operation_id: "operation:moodle-candidate-42" },
    };
    const resolved = await runtime.call(PRIVATE_MOODLE_ENROLMENT_CANDIDATE_TOOL, input);
    expect(resolved).toMatchObject({
      schema: "morrow.canvas-connector.result.v1",
      ok: true,
      provider: "moodle",
      toolName: PRIVATE_MOODLE_ENROLMENT_CANDIDATE_TOOL,
      operationKey: PRIVATE_MOODLE_ENROLMENT_CANDIDATE_OPERATION,
      commandKind: "invoke_read",
      result: {
        schema: "morrow.canvas-browser-result.v1",
        ok: true,
        sent: false,
        complete: true,
        provider: "moodle",
        data: {
          schema: "morrow.moodle-enrolment-candidate.private.v1",
          course_id: 42,
          candidate: { user_id: "21" },
          match: { kind: "exact_native_query", candidate_count: 1 },
          proof: { dispatch_count: 0, read_request_count: 2, candidate_limit: 100 },
        },
      },
    });
    for (const privateValue of ["Mary Jackson", "mary@example.edu"]) expect(JSON.stringify(resolved)).not.toContain(privateValue);

    const beforeRefusals = commands;
    await expect(runtime.call(PRIVATE_MOODLE_ENROLMENT_CANDIDATE_TOOL, { ...input, query: " Mary Jackson" }))
      .resolves.toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "moodle_enrolment_candidate_arguments_invalid" } });
    await expect(runtime.call(PRIVATE_MOODLE_ENROLMENT_CANDIDATE_TOOL, { ...input, course_id: 9 }))
      .resolves.toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "moodle_binding_course_mismatch" } });
    await expect(runtime.call(PRIVATE_MOODLE_ENROLMENT_CANDIDATE_TOOL, { course_id: 42, query: "Mary Jackson" }))
      .resolves.toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "moodle_binding_required" } });
    await expect(runtime.call(PRIVATE_MOODLE_ENROLMENT_CANDIDATE_TOOL, {
      ...input,
      _morrow: { ...input._morrow, outer_grant: {
        plan_digest: "a".repeat(64), approval_grant_digest: "b".repeat(64), effect_receipt_id: "effect:moodle-candidate-42",
        dispatch_attempt: 1, gateway_process_id: "gateway:connector-test", authorization: { kind: "review" },
      } },
    })).resolves.toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "moodle_enrolment_candidate_arguments_invalid" } });
    expect(commands).toBe(beforeRefusals);

    invalidResult = true;
    await expect(runtime.call(PRIVATE_MOODLE_ENROLMENT_CANDIDATE_TOOL, {
      ...input,
      _morrow: { ...input._morrow, operation_id: "operation:moodle-candidate-invalid-result" },
    })).resolves.toMatchObject({ ok: false, problem: { code: "moodle_enrolment_candidate_result_invalid" } });
    expect(commands).toBe(beforeRefusals + 1);
  });

  it("forwards one verified private file attachment only to its exact Moodle Resource write", async () => {
    const runtime = await start([{
      sourceBindingId: "moodle:course-42",
      provider: "moodle",
      origin: "https://school.example.edu",
      siteUrl: "https://school.example.edu/moodle",
      courseId: "42",
      principalFingerprint: "b".repeat(64),
      sessionGeneration: 1,
      runtimeVerified: true,
    }]);
    const socket = sockets.at(-1)!;
    const attachment = privateAttachment();
    let commands = 0;
    respond(socket, (command) => {
      commands += 1;
      expect(command.toolName).toBe("moodle_create_resource_file");
      expect(command.privateAttachment).toEqual(attachment);
      expect(command.arguments).toEqual({
        course_id: 42,
        section_id: 7,
        name: "Week 1 resource",
        filename: attachment.manifest.filename,
        size_bytes: attachment.manifest.size_bytes,
        sha256: attachment.manifest.sha256,
        expected_digest: "d".repeat(64),
      });
      expect(JSON.stringify(command.arguments)).not.toContain(attachment.bytes_base64);
    });
    const input = {
      course_id: 42,
      section_id: 7,
      name: "Week 1 resource",
      filename: attachment.manifest.filename,
      size_bytes: attachment.manifest.size_bytes,
      sha256: attachment.manifest.sha256,
      expected_digest: "d".repeat(64),
      privateAttachment: attachment,
      _morrow: {
        source_binding_id: "moodle:course-42",
        operation_id: "operation:resource-file-42",
        outer_grant: {
          plan_digest: "a".repeat(64),
          approval_grant_digest: "b".repeat(64),
          effect_receipt_id: "effect:resource-file-42",
          dispatch_attempt: 1,
          gateway_process_id: "gateway:connector-test",
          authorization: { kind: "review" },
        },
      },
    };
    expect(await runtime.call("moodle_create_resource_file", input)).toMatchObject({ ok: true });
    expect(await runtime.call("moodle_create_resource_file", {
      ...input,
      privateAttachment: { ...attachment, manifest: { ...attachment.manifest, sha256: "f".repeat(64) } },
    })).toMatchObject({ ok: false, problem: { code: "moodle_private_attachment_invalid" } });
    expect(await runtime.call("moodle_update_page", {
      course_id: 42,
      privateAttachment: attachment,
      _morrow: input._morrow,
    })).toMatchObject({ ok: false, problem: { code: "moodle_private_attachment_refused" } });
    expect(commands).toBe(1);
  });

  it("refuses direct Canvas file calls and forwards one exact reserved private Canvas file transfer", async () => {
    const runtime = await start();
    const socket = sockets.at(-1)!;
    const attachment = canvasPrivateAttachment();
    let commands = 0;
    respond(socket, (command) => {
      commands += 1;
      expect(command.toolName).toBe("canvas_transfer_course_file");
      expect(command.operationKey).toBe("canvas.private.course_file.transfer.v1");
      expect(command.sourceBindingId).toBe("canvas:test-account");
      expect(command.privateAttachment).toEqual(attachment);
      expect(command.arguments).toEqual({
        course_id: 42,
        folder_id: 81,
        filename: attachment.manifest.filename,
        size_bytes: attachment.manifest.size_bytes,
        sha256: attachment.manifest.sha256,
        content_type: attachment.content_type,
      });
      expect(JSON.stringify(command.arguments)).not.toContain(attachment.bytes_base64);
    });
    const base = {
      course_id: 42,
      folder_id: 81,
      filename: attachment.manifest.filename,
      size_bytes: attachment.manifest.size_bytes,
      sha256: attachment.manifest.sha256,
      content_type: attachment.content_type,
      privateAttachment: attachment,
    };
    expect(await runtime.call("canvas_transfer_course_file", base)).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "canvas_private_file_reservation_required" },
    });
    expect(await runtime.call("canvas_transfer_course_file", {
      ...base,
      privateAttachments: [attachment],
      _morrow: {
        source_binding_id: "canvas:test-account",
        operation_id: "operation:canvas-file-mixed-42",
        outer_grant: {
          plan_digest: "a".repeat(64),
          approval_grant_digest: "b".repeat(64),
          effect_receipt_id: "effect:canvas-file-mixed-42",
          dispatch_attempt: 1,
          gateway_process_id: "gateway:connector-test",
          authorization: { kind: "review" },
        },
      },
    })).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "canvas_private_attachment_refused" },
    });
    const dispatched = await runtime.call("canvas_transfer_course_file", {
      ...base,
      _morrow: {
        source_binding_id: "canvas:test-account",
        operation_id: "operation:canvas-file-42",
        outer_grant: {
          plan_digest: "a".repeat(64),
          approval_grant_digest: "b".repeat(64),
          effect_receipt_id: "effect:canvas-file-42",
          dispatch_attempt: 1,
          gateway_process_id: "gateway:connector-test",
          authorization: { kind: "review" },
        },
      },
    });
    expect(dispatched).toMatchObject({ ok: true });
    expect(commands).toBe(1);
  });

  it("refuses private file payloads on public Canvas routes before dispatch", async () => {
    const runtime = await start();
    const attachment = canvasPrivateAttachment();
    expect(await runtime.call("canvas_update_course", {
      id: "42",
      privateAttachment: {},
    })).toMatchObject({
      ok: false,
      provider: "canvas",
      resultState: "not_sent",
      problem: { code: "canvas_private_attachment_invalid" },
    });
    expect(await runtime.call("canvas_update_course", {
      id: "42",
      privateAttachment: attachment,
    })).toMatchObject({
      ok: false,
      provider: "canvas",
      resultState: "not_sent",
      problem: { code: "canvas_private_attachment_refused" },
    });
  });

  it("forwards one exact private Canvas Inbox command with no public recipients", async () => {
    const runtime = await start();
    const socket = sockets.at(-1)!;
    const conversation = {
      schema: "morrow.canvas-conversation.private.v1" as const,
      action: "create" as const,
      courseId: "42",
      recipients: ["201", "group_9_students"],
      subject: "Week 3",
      body: "Please review the lab notes.",
      groupConversation: true,
    };
    let commands = 0;
    respond(socket, (command) => {
      commands += 1;
      expect(command.kind).toBe("invoke_write");
      expect(command.toolName).toBe("canvas_send_private_conversation");
      expect(command.operationKey).toBe("canvas.private.conversation.send.v1");
      expect(command.arguments).toEqual({});
      expect(command.privateConversation).toEqual(conversation);
      expect(JSON.stringify(command.arguments)).not.toContain("201");
    });
    const grant = {
      plan_digest: "a".repeat(64),
      approval_grant_digest: "b".repeat(64),
      effect_receipt_id: "effect:canvas-conversation-42",
      dispatch_attempt: 1,
      gateway_process_id: "gateway:connector-test",
      authorization: { kind: "review" as const },
    };
    expect(await runtime.call("canvas_send_private_conversation", {
      course_id: "42",
      privateConversation: conversation,
      _morrow: {
        source_binding_id: "canvas:test-account",
        operation_id: "operation:canvas-conversation-42",
        outer_grant: grant,
      },
    })).toMatchObject({ ok: true, result: { status: 200 } });
    expect(await runtime.call("canvas_send_private_conversation", {
      course_id: "42",
      _morrow: {
        source_binding_id: "canvas:test-account",
        operation_id: "operation:canvas-conversation-wrong-action",
        outer_grant: { ...grant, effect_receipt_id: "effect:canvas-conversation-wrong-action" },
      },
    })).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "canvas_private_conversation_required" } });
    expect(await runtime.call("canvas_send_private_conversation", {
      course_id: "42",
      privateConversation: conversation,
      privateAttachments: [canvasPrivateAttachment()],
      _morrow: {
        source_binding_id: "canvas:test-account",
        operation_id: "operation:canvas-conversation-mixed-payload",
        outer_grant: { ...grant, effect_receipt_id: "effect:canvas-conversation-mixed-payload" },
      },
    })).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "canvas_private_conversation_refused" } });
    expect(await runtime.call("canvas_create_conversation", {
      body: "Raw public message",
      recipients: ["201"],
      _morrow: {
        source_binding_id: "canvas:test-account",
        operation_id: "operation:canvas-conversation-raw-public",
        outer_grant: { ...grant, effect_receipt_id: "effect:canvas-conversation-raw-public" },
      },
    })).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "course_scope_required" } });
    expect(await runtime.call("canvas_create_conversation", {
      body: "Forged private payload",
      recipients: ["201"],
      privateConversation: conversation,
      _morrow: {
        source_binding_id: "canvas:test-account",
        operation_id: "operation:canvas-conversation-forged-public",
        outer_grant: { ...grant, effect_receipt_id: "effect:canvas-conversation-forged-public" },
      },
    })).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "canvas_private_conversation_refused" } });
    expect(commands).toBe(1);
  });

  it("routes an exact Canvas courses/{id} read through its selected course binding", async () => {
    const runtime = await start();
    const socket = sockets.at(-1)!;
    let commands = 0;
    respond(socket, (command) => {
      commands += 1;
      expect(command.kind).toBe("invoke_read");
      expect(command.operationKey).toBe(runtime.operations.get("canvas_get_single_course_courses")?.key);
      expect(command.sourceBindingId).toBe("canvas:test-account");
    });
    const result = await runtime.call("canvas_get_single_course_courses", {
      id: "42",
      _morrow: { source_binding_id: "canvas:test-account" },
    });
    expect(result).toMatchObject({ ok: true, result: { status: 200 } });
    expect(await runtime.call("canvas_get_single_course_courses", {
      id: "7",
      _morrow: { source_binding_id: "canvas:test-account" },
    })).toMatchObject({ ok: false, problem: { code: "course_binding_course_mismatch" } });
    expect(commands).toBe(1);
  });

  it("preserves extension before-send and unknown write outcomes", async () => {
    const runtime = await start();
    const socket = sockets.at(-1)!;
    let responseIndex = 0;
    socket.on("message", (raw) => {
      const value = parseBridgeJson(raw.toString()) as { schema?: string };
      if (value.schema !== BRIDGE_SCHEMAS.command) return;
      const command = value as BridgeCommand;
      const unknown = responseIndex++ === 1;
      socket.send(serializeBridgeMessage({
        schema: BRIDGE_SCHEMAS.result,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        requestId: command.requestId,
        operationId: command.operationId,
        generation: command.generation,
        ok: false,
        ...(unknown ? {
          result: {
            readDescriptor: {
              schema: "morrow.canvas-recovery-descriptor.v1",
              strategy: "canvas-operation-readback",
            },
          },
        } : {}),
        problem: {
          schema: "morrow.bridge.problem.v1",
          code: unknown ? "write_outcome_unknown" : "edit_policy_stale",
          message: unknown ? "The write outcome is unknown." : "The Edit permission changed before dispatch.",
          recoverable: !unknown,
        },
        completedAt: Date.now(),
      }));
    });
    const outerGrant = (suffix: string) => ({
      plan_digest: "a".repeat(64),
      approval_grant_digest: "b".repeat(64),
      effect_receipt_id: `effect:outcome-${suffix}`,
      dispatch_attempt: 1,
      gateway_process_id: "gateway:connector-test",
      authorization: { kind: "review" as const },
    });

    expect(await runtime.call("canvas_update_course", {
      id: "42",
      _morrow: {
        source_binding_id: "canvas:test-account",
        operation_id: "operation:outcome-before-send",
        outer_grant: outerGrant("before-send"),
      },
    })).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "edit_policy_stale" },
    });
    expect(await runtime.call("canvas_update_course", {
      id: "42",
      _morrow: {
        source_binding_id: "canvas:test-account",
        operation_id: "operation:outcome-unknown",
        outer_grant: outerGrant("unknown"),
      },
    })).toMatchObject({
      ok: false,
      resultState: "unknown",
      readDescriptor: { schema: "morrow.canvas-recovery-descriptor.v1" },
      problem: { code: "write_outcome_unknown" },
    });
    expect(responseIndex).toBe(2);
  });

  it("uses the shared course admission contract for direct and held Canvas writes", async () => {
    const runtime = await start();
    const socket = sockets.at(-1)!;
    let commands = 0;
    respond(socket, (command) => {
      commands += 1;
      expect(command.toolName).toBe("canvas_update_course");
      expect(command.arguments).toEqual({ id: "42" });
    });
    const grant = {
      plan_digest: "a".repeat(64),
      approval_grant_digest: "b".repeat(64),
      effect_receipt_id: "effect:course-admission",
      dispatch_attempt: 1,
      gateway_process_id: "gateway:connector-test",
    };
    expect(await runtime.call("canvas_update_course", {
      id: "42",
      _morrow: { source_binding_id: "canvas:test-account", outer_grant: grant },
    })).toMatchObject({ ok: true });
    // The refusal carries the sentence for the class this write is held in, not one generic line
    // for every held route.
    expect(await runtime.call("canvas_set_course_nickname", {
      course_id: "42",
      nickname: "Renamed course",
      _morrow: { source_binding_id: "canvas:test-account", outer_grant: grant },
    })).toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: {
        code: "course_scope_required",
        message: "Morrow does not change your personal Canvas bookmarks or course nicknames. It only changes content inside a selected course.",
      },
    });
    expect(await runtime.call("canvas_clear_course_nicknames", {
      course_id: "42",
      _morrow: { source_binding_id: "canvas:test-account", outer_grant: grant },
    })).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "course_scope_required" } });
    expect(await runtime.call("canvas_get_course_nickname", {
      course_id: "7",
      _morrow: { source_binding_id: "canvas:test-account" },
    })).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "course_binding_course_mismatch" } });
    expect(commands).toBe(1);
  });

  it("forwards one exact guarded Assignment image repair only through the current extension", async () => {
    const runtime = await start(undefined, "1.0.0-rc.2");
    const socket = sockets.at(-1)!;
    let calls = 0;
    const guard = {
      kind: "assignment_image_alt",
      course_id: "42",
      assignment_id: "9",
      body_sha256: "a".repeat(64),
      protected_state_sha256: "b".repeat(64),
      image_index: 1,
      image_start: 3,
      image_end: 21,
      image_tag_sha256: "c".repeat(64),
      image_src_sha256: "d".repeat(64),
      alt_text: "Cell membrane diagram",
      decorative: false,
    };
    respond(socket, (command) => {
      calls += 1;
      expect(command.toolName).toBe("canvas_edit_assignment");
      expect(command.arguments).toEqual({ course_id: "42", id: "9", morrow_canvas_content_guard: guard });
    });
    expect(await runtime.call("canvas_edit_assignment", {
      course_id: "42",
      id: "9",
      _morrow: {
        source_binding_id: "canvas:test-account",
        canvas_content_guard: guard,
        outer_grant: {
          plan_digest: "a".repeat(64),
          approval_grant_digest: "b".repeat(64),
          effect_receipt_id: "effect:assignment-image-alt",
          dispatch_attempt: 1,
          gateway_process_id: "gateway:connector-test",
        },
      },
    })).toMatchObject({ ok: true });
    expect(calls).toBe(1);
    expect(await runtime.call("canvas_edit_assignment", {
      course_id: "42",
      id: "9",
      _morrow: {
        source_binding_id: "canvas:test-account",
        canvas_content_guard: guard,
      },
    })).toMatchObject({ ok: false });
    expect(calls).toBe(1);
  });

  it("forwards only the three exact guarded New Quiz nested image repairs", async () => {
    const runtime = await start(undefined, "1.0.0-rc.2");
    const socket = sockets.at(-1)!;
    const guards = [
      { kind: "new_quiz_choice_image_alt", choice_id: "choice:1" },
      { kind: "new_quiz_answer_feedback_image_alt", choice_id: "choice-2" },
      { kind: "new_quiz_feedback_image_alt", feedback_type: "incorrect" },
    ].map((selector) => ({
      ...selector,
      course_id: "42",
      assignment_id: "77",
      item_id: "145",
      body_sha256: "a".repeat(64),
      protected_state_sha256: "b".repeat(64),
      image_index: 1,
      image_start: 3,
      image_end: 21,
      image_tag_sha256: "c".repeat(64),
      image_src_sha256: "d".repeat(64),
      alt_text: "Cell membrane diagram",
      decorative: false,
    }));
    let calls = 0;
    respond(socket, (command) => {
      calls += 1;
      expect(command.toolName).toBe("canvas_update_quiz_item");
      expect(command.arguments).toEqual({
        course_id: "42",
        assignment_id: "77",
        item_id: "145",
        morrow_canvas_content_guard: guards[calls - 1],
      });
    });
    for (const [index, guard] of guards.entries()) {
      expect(await runtime.call("canvas_update_quiz_item", {
        course_id: "42",
        assignment_id: "77",
        item_id: "145",
        _morrow: {
          source_binding_id: "canvas:test-account",
          canvas_content_guard: guard,
          outer_grant: {
            plan_digest: "a".repeat(64),
            approval_grant_digest: "b".repeat(64),
            effect_receipt_id: `effect:new-quiz-nested-image-alt-${index}`,
            dispatch_attempt: 1,
            gateway_process_id: "gateway:connector-test",
          },
        },
      })).toMatchObject({ ok: true });
    }
    expect(calls).toBe(3);
  });

  it("forwards only one exact guarded Classic Quiz description image repair", async () => {
    const runtime = await start(undefined, "1.0.0-rc.2");
    const socket = sockets.at(-1)!;
    const guard = {
      kind: "classic_quiz_description_image_alt",
      course_id: "42",
      quiz_id: "77",
      body_sha256: "a".repeat(64),
      protected_state_sha256: "b".repeat(64),
      image_index: 1,
      image_start: 3,
      image_end: 21,
      image_tag_sha256: "c".repeat(64),
      image_src_sha256: "d".repeat(64),
      alt_text: "Cell membrane diagram",
      decorative: false,
    };
    let calls = 0;
    respond(socket, (command) => {
      calls += 1;
      expect(command.toolName).toBe("canvas_edit_quiz");
      expect(command.arguments).toEqual({ course_id: "42", id: "77", morrow_canvas_content_guard: guard });
    });
    expect(await runtime.call("canvas_edit_quiz", {
      course_id: "42",
      id: "77",
      _morrow: {
        source_binding_id: "canvas:test-account",
        canvas_content_guard: guard,
        outer_grant: {
          plan_digest: "a".repeat(64),
          approval_grant_digest: "b".repeat(64),
          effect_receipt_id: "effect:classic-quiz-description-image-alt",
          dispatch_attempt: 1,
          gateway_process_id: "gateway:connector-test",
        },
      },
    })).toMatchObject({ ok: true });
    expect(calls).toBe(1);
    expect(await runtime.call("canvas_edit_quiz", {
      course_id: "42",
      id: "77",
      _morrow: { source_binding_id: "canvas:test-account", canvas_content_guard: guard },
    })).toMatchObject({ ok: false });
    expect(calls).toBe(1);
  });

  it("holds legacy Item Bank guard calls before provider I/O", async () => {
    const runtime = await start();
    const socket = sockets.at(-1)!;
    const guard = {
      kind: "item_bank_entry_image_alt",
      course_id: "42",
      bank_id: "91",
      bank_entry_id: "701",
      item_id: "501",
      entry_type: "Item",
      item_sha256: "a".repeat(64),
      protected_state_sha256: "b".repeat(64),
      image_index: 1,
      image_src_sha256: "c".repeat(64),
      alt_text: "Diagram of the heart",
      fan_out: { schema: "morrow.canvas.item-bank.fan-out.v1" },
      acknowledged_course_ids: ["77"],
    };
    expect([...ITEM_BANK_GUARD_FIELDS].sort()).toEqual([...EXTENSION_ITEM_BANK_GUARD_FIELDS].sort());
    expect(Object.keys(guard).sort()).toEqual([...ITEM_BANK_GUARD_FIELDS].sort());
    let calls = 0;
    respond(socket, (command) => {
      calls += 1;
      expect(command.toolName).toBe("canvas_item_bank_update_item");
      expect(command.arguments).toEqual({ bank_id: "91", item_id: "501", morrow_item_bank_guard: guard });
    });
    const outerGrant = {
      plan_digest: "a".repeat(64),
      approval_grant_digest: "b".repeat(64),
      effect_receipt_id: "effect:item-bank-question-image-alt",
      dispatch_attempt: 1,
      gateway_process_id: "gateway:connector-test",
    };
    expect(await runtime.call("canvas_item_bank_update_item", {
      bank_id: "91",
      item_id: "501",
      morrow_item_bank_guard: guard,
      _morrow: { source_binding_id: "canvas:test-account", outer_grant: outerGrant },
    })).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "course_binding_course_mismatch" } });
    expect(calls).toBe(0);
    expect(await runtime.call("canvas_item_bank_update_item", {
      bank_id: "91",
      item_id: "501",
      _morrow: { source_binding_id: "canvas:test-account", outer_grant: outerGrant },
    })).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "course_binding_course_mismatch" } });
    expect(await runtime.call("canvas_item_bank_update_item", {
      bank_id: "91",
      item_id: "501",
      morrow_item_bank_guard: { ...guard, course_id: "77" },
      _morrow: { source_binding_id: "canvas:test-account", outer_grant: outerGrant },
    })).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "course_binding_course_mismatch" } });
    expect(await runtime.call("canvas_item_bank_archive_bank", {
      bank_id: "91",
      morrow_item_bank_guard: guard,
      _morrow: { source_binding_id: "canvas:test-account", outer_grant: outerGrant },
    })).toMatchObject({ ok: false, resultState: "not_sent", problem: { code: "course_binding_course_mismatch" } });
    expect(calls).toBe(0);
  });

  it("refuses writes without an outer grant and dispatches one granted write", async () => {
    const runtime = await start();
    const write = runtime.operations.get("canvas_create_assignment")!;
    const refused = await runtime.call(write.toolName, {
      course_id: "42",
      _morrow: { source_binding_id: "canvas:test-account" },
    });
    expect(refused).toMatchObject({ ok: false });
    const socket = sockets.at(-1)!;
    let calls = 0;
    respond(socket, (command) => {
      calls += 1;
      expect(command.kind).toBe("invoke_write");
      expect(command.outerGrant?.effectReceiptId).toBe("effect:connector-test");
    });
    const granted = await runtime.call(write.toolName, {
      course_id: "42",
      _morrow: {
        source_binding_id: "canvas:test-account",
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
    const unscopedWrite = runtime.catalog.operations.find((operation) => !operation.readOnly && !operation.path.includes("/courses/{course_id}") && !operation.path.includes("/courses/{id}"))!;
    expect(await runtime.call(unscopedWrite.toolName, {
      _morrow: {
        source_binding_id: "canvas:test-account",
        operation_id: "operation:connector-unscoped",
        outer_grant: {
          plan_digest: "a".repeat(64),
          approval_grant_digest: "b".repeat(64),
          effect_receipt_id: "effect:connector-unscoped",
          dispatch_attempt: 1,
          gateway_process_id: "gateway:connector-test",
        },
      },
    })).toMatchObject({ ok: false, problem: { code: "course_scope_required" } });
    expect(calls).toBe(1);
    const held = runtime.catalog.operations.find((operation) => operation.service === "item_bank" && operation.nickname === "update_item")!;
    expect(await runtime.call(held.toolName, { bank_id: "91", item_id: "501", item: { title: "Updated" } }))
      .toMatchObject({ ok: false, problem: { code: "course_binding_required" } });
    const attach = runtime.catalog.operations.find((operation) => operation.service === "item_bank" && operation.nickname === "attach_item")!;
    expect(await runtime.call(attach.toolName, { bank_id: "91", entry_id: "501" }))
      .toMatchObject({ ok: false, problem: { code: "course_binding_required" } });
    expect(calls).toBe(1);
  });

  it("carries a bounded list resume to the page as a routing control and refuses one on a write", async () => {
    const runtime = await start();
    const socket = sockets.at(-1)!;
    const commands: BridgeCommand[] = [];
    socket.on("message", (raw) => {
      const value = parseBridgeJson(raw.toString()) as { schema?: string };
      if (value.schema !== BRIDGE_SCHEMAS.command) return;
      const command = value as BridgeCommand;
      commands.push(command);
      socket.send(serializeBridgeMessage({
        schema: BRIDGE_SCHEMAS.result,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        requestId: command.requestId,
        operationId: command.operationId,
        generation: command.generation,
        ok: true,
        result: {
          ok: true,
          sent: true,
          status: 200,
          data: [{ page_id: "11", url: "welcome" }],
          truncated: true,
          pageCount: 1,
          morrow_pages_read: 1,
          morrow_unread_pages: 2,
          morrow_next_page: "bW9ycm93LW5leHQtcGFnZQ",
        },
        completedAt: Date.now(),
      }));
    });

    const first = await runtime.call("canvas_list_pages_courses", {
      course_id: "42",
      morrow_max_pages: 1,
      _morrow: { source_binding_id: "canvas:test-account", list_resume: {} },
    });
    expect(commands.at(-1)?.arguments).toMatchObject({ course_id: "42", morrow_list_resume: {} });
    expect(first).toMatchObject({
      ok: true,
      commandKind: "invoke_read",
      result: { truncated: true, morrow_unread_pages: 2, morrow_next_page: "bW9ycm93LW5leHQtcGFnZQ" },
    });

    const resumed = await runtime.call("canvas_list_pages_courses", {
      course_id: "42",
      morrow_max_pages: 1,
      _morrow: { source_binding_id: "canvas:test-account", list_resume: { next_page: "bW9ycm93LW5leHQtcGFnZQ" } },
    });
    expect(commands.at(-1)?.arguments).toMatchObject({ morrow_list_resume: { next_page: "bW9ycm93LW5leHQtcGFnZQ" } });
    expect(resumed).toMatchObject({ ok: true });

    // The resume control is gateway routing, never a model-settable argument on
    // the operation itself, and the published schema still refuses new arguments.
    const pages = runtime.catalog.operations.find((operation) => operation.toolName === "canvas_list_pages_courses")!;
    const published = augmentBridgeInputSchema(pages.inputSchema, false, false);
    expect(published.additionalProperties).toBe(false);
    expect(Object.keys(published.properties as Record<string, unknown>)).not.toContain("morrow_list_resume");
    const validate = fromJsonSchema(published)["~standard"].validate;
    expect((await validate({ course_id: "42", _morrow: { list_resume: { next_page: "bW9ycm93LW5leHQtcGFnZQ" } } })).issues).toBeUndefined();
    expect((await validate({ course_id: "42", morrow_list_resume: {} })).issues).toBeTruthy();

    await expect(runtime.call("canvas_update_create_page_courses", {
      course_id: "42",
      url_or_id: "welcome",
      wiki_page_title: "Welcome",
      _morrow: {
        source_binding_id: "canvas:test-account",
        list_resume: {},
        outer_grant: {
          plan_digest: "a".repeat(64),
          approval_grant_digest: "b".repeat(64),
          effect_receipt_id: "effect:connector-list-resume",
          dispatch_attempt: 1,
          gateway_process_id: "gateway:connector-test",
        },
      },
    })).resolves.toMatchObject({
      ok: false,
      resultState: "not_sent",
      problem: { code: "bounded_list_resume_write_refused" },
    });
  });
});
