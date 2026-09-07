import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SCHEMAS,
  MAX_BRIDGE_MESSAGE_BYTES,
  augmentBridgeInputSchema,
  matchesBridgeEditPermission,
  normalizeBridgeMaintenanceControl,
  normalizeBridgeEditOptionsResult,
  normalizeBridgePrivateAttachment,
  normalizeBridgePrivateConversation,
  normalizeBridgeBindings,
  parseBridgeHello,
  serializeBridgeMessage,
  splitBridgeCallArguments,
} from "../src/index.js";

const digest = "a".repeat(64);
const assignmentOperationKey = "PUT /v1/courses/{course_id}/assignments/{id}#edit_assignment";
const pageOperationKey = "PUT /v1/courses/{course_id}/pages/{url_or_id}#update_create_page_courses";
const newQuizItemOperationKey = "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item";
const classicQuizOperationKey = "PUT /v1/courses/{course_id}/quizzes/{id}#edit_quiz";
const assignmentImageAltGuard = {
  kind: "assignment_image_alt",
  course_id: "42",
  assignment_id: "9",
  body_sha256: "c".repeat(64),
  protected_state_sha256: "d".repeat(64),
  image_index: 1,
  image_start: 3,
  image_end: 21,
  image_tag_sha256: "e".repeat(64),
  image_src_sha256: "f".repeat(64),
  alt_text: "Cell membrane diagram",
  decorative: false,
};

function assignmentBinding(expiresAt?: number) {
  return {
    sourceBindingId: "canvas-assignment-42",
    provider: "canvas" as const,
    courseId: "42",
    runtimeVerified: true,
    editPermission: {
      schema: "morrow.bridge.edit-permission.v1" as const,
      revision: 1,
      scopeDigest: "b".repeat(64),
      catalogDigest: digest,
      sourceBindingId: "canvas-assignment-42",
      ...(expiresAt === undefined ? {} : { expiresAt }),
      enabledCategories: ["canvas_assignment_due_date"],
      rules: [{
        operationKey: assignmentOperationKey,
        toolName: "canvas_edit_assignment",
        allowedChangedFields: ["assignment_due_at"],
      }],
    },
  };
}

function assignmentImageAltBinding() {
  return {
    sourceBindingId: "canvas-assignment-42",
    provider: "canvas" as const,
    courseId: "42",
    runtimeVerified: true,
    editPermission: {
      schema: "morrow.bridge.edit-permission.v1" as const,
      revision: 1,
      scopeDigest: "b".repeat(64),
      catalogDigest: digest,
      sourceBindingId: "canvas-assignment-42",
      enabledCategories: ["canvas_assignment_image_alt"],
      rules: [{
        operationKey: assignmentOperationKey,
        toolName: "canvas_edit_assignment",
        allowedChangedFields: [],
        requiresCanvasContentGuard: true,
        canvasContentGuardKind: "assignment_image_alt" as const,
      }],
    },
  };
}

const legacyPageTextGuard = {
  kind: "text",
  page_id: "91",
  revision_id: "2",
  body_sha256: "a".repeat(64),
  fields: { url: "lesson", title: "Cells", published: true, front_page: false, editing_roles: "teachers", publish_at: null },
  find_text: "Cells", replace_text: "Cell",
};

const pageTextGuard = { ...legacyPageTextGuard, kind: "page_text", course_id: "42" };

function legacyPageTextBinding() {
  return {
    sourceBindingId: "canvas-page-42",
    provider: "canvas" as const,
    courseId: "42",
    runtimeVerified: true,
    editPermission: {
      schema: "morrow.bridge.edit-permission.v1" as const,
      revision: 1,
      scopeDigest: "b".repeat(64),
      catalogDigest: digest,
      sourceBindingId: "canvas-page-42",
      enabledCategories: ["canvas_page_content"],
      rules: [{ operationKey: pageOperationKey, toolName: "canvas_update_create_page_courses", allowedChangedFields: [], requiresPageGuard: true, pageGuardKind: "text" as const }],
    },
  };
}

function canonicalPageTextBinding() {
  return {
    ...legacyPageTextBinding(),
    editPermission: {
      ...legacyPageTextBinding().editPermission,
      rules: [{ operationKey: pageOperationKey, toolName: "canvas_update_create_page_courses", allowedChangedFields: [], requiresCanvasContentGuard: true, canvasContentGuardKind: "page_text" as const }],
    },
  };
}

describe("bridge protocol", () => {
  it("admits only exact private Bridge maintenance controls", () => {
    expect(normalizeBridgeMaintenanceControl({ action: "quiesce" })).toEqual({ action: "quiesce" });
    expect(normalizeBridgeMaintenanceControl({
      action: "resume",
      quiesceEpoch: "quiesce-12345678-1234-1234-1234-123456789abc",
      fileLayerRestored: true,
    })).toEqual({
      action: "resume",
      quiesceEpoch: "quiesce-12345678-1234-1234-1234-123456789abc",
      fileLayerRestored: true,
    });
    expect(() => normalizeBridgeMaintenanceControl({ action: "resume", quiesceEpoch: "quiesce-12345678-1234", fileLayerRestored: false }))
      .toThrow("bridge maintenance control");
    expect(() => normalizeBridgeMaintenanceControl({ action: "status", path: "/tmp/bridge" }))
      .toThrow("unsupported fields");
  });

  it("admits one exact private Moodle file attachment without placing bytes in public arguments", () => {
    const bytes = Buffer.from("Morrow private file\n", "utf8");
    const attachment = {
      schema: "morrow.private-file-attachment.v1",
      handle: "file:resource-42",
      manifest: {
        filename: "week-1.txt",
        size_bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      bytes_base64: bytes.toString("base64"),
    };
    expect(normalizeBridgePrivateAttachment(attachment)).toEqual(attachment);
    const canvasAttachment = { ...attachment, content_type: "text/plain" };
    expect(normalizeBridgePrivateAttachment(canvasAttachment)).toEqual(canvasAttachment);
    expect(() => normalizeBridgePrivateAttachment({ ...attachment, content_type: "Text/Plain" }))
      .toThrow("privateAttachment.content_type is invalid");
    const zeroBytes = Buffer.alloc(3);
    const binaryAttachment = {
      ...attachment,
      manifest: { filename: "binary.bin", size_bytes: zeroBytes.byteLength, sha256: createHash("sha256").update(zeroBytes).digest("hex") },
      bytes_base64: zeroBytes.toString("base64"),
    };
    expect(normalizeBridgePrivateAttachment(binaryAttachment)).toEqual(binaryAttachment);
    expect(() => normalizeBridgePrivateAttachment({
      ...attachment,
      manifest: { ...attachment.manifest, sha256: "f".repeat(64) },
    })).toThrow("privateAttachment bytes do not match the manifest");
    expect(() => normalizeBridgePrivateAttachment({
      ...attachment,
      handle: ` ${attachment.handle}`,
    })).toThrow("privateAttachment.handle is invalid");
    const schema = augmentBridgeInputSchema({ type: "object", properties: {}, additionalProperties: false }, false, true);
    expect((schema.properties as Record<string, unknown>).privateAttachment).toBeTruthy();
  });

  it("admits only resolved Canvas Inbox payloads", () => {
    const create = {
      schema: "morrow.canvas-conversation.private.v1",
      action: "create",
      courseId: "42",
      recipients: ["27", "group_9_students", "section_4_tas", "course_42_teachers"],
      subject: "Week 3",
      body: "Please review the lab notes.",
      groupConversation: true,
    } as const;
    expect(normalizeBridgePrivateConversation(create)).toEqual(create);
    expect(normalizeBridgePrivateConversation({
      schema: "morrow.canvas-conversation.private.v1",
      action: "reply",
      courseId: 42,
      conversationId: "91",
      body: "Thanks for the update.",
    })).toEqual({
      schema: "morrow.canvas-conversation.private.v1",
      action: "reply",
      courseId: "42",
      conversationId: "91",
      recipients: [],
      body: "Thanks for the update.",
    });
    expect(() => normalizeBridgePrivateConversation({ ...create, recipients: ["Student_A1"] }))
      .toThrow("privateConversation.recipients");
    expect(() => normalizeBridgePrivateConversation({ ...create, recipients: ["27", "27"] }))
      .toThrow("must be unique");
    expect(() => normalizeBridgePrivateConversation({ ...create, rawRecipientId: "27" }))
      .toThrow("unsupported fields");
  });

  it("normalizes and sorts binding snapshots", () => {
    expect(normalizeBridgeBindings([
      { sourceBindingId: "canvas:22", provider: "canvas", courseId: "42", runtimeVerified: true },
      { sourceBindingId: "a-binding", provider: "canvas", runtimeVerified: false },
    ]).map((binding) => binding.sourceBindingId)).toEqual(["a-binding", "canvas:22"]);
  });

  it("keeps 500 ordinary binding summaries below the bridge limit and reads full options on demand", () => {
    const bindings = Array.from({ length: 500 }, (_, index) => {
      const sourceBindingId = `canvas:course-${index + 1}`;
      return {
        sourceBindingId,
        provider: "canvas" as const,
        courseId: String(index + 1),
        catalogDigest: digest,
        editPolicyRevision: 1,
        editOptionsAvailable: true as const,
        editPermission: {
          schema: "morrow.bridge.edit-permission.v1" as const,
          revision: 1,
          scopeDigest: "b".repeat(64),
          catalogDigest: digest,
          sourceBindingId,
        },
        runtimeVerified: true,
      };
    });
    const serialized = serializeBridgeMessage({
      schema: BRIDGE_SCHEMAS.hello,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      token: "x".repeat(48),
      extensionId: "a".repeat(32),
      runtimeRevision: "revision-1",
      catalogDigest: digest,
      bindings,
      sentAt: 1,
    });
    expect(Buffer.byteLength(serialized)).toBeLessThan(MAX_BRIDGE_MESSAGE_BYTES);
    const sourceBindingId = bindings[0]!.sourceBindingId;
    const details = normalizeBridgeEditOptionsResult({
      schema: "morrow.bridge.edit-options.v1",
      sourceBindingId,
      provider: "canvas",
      catalogDigest: digest,
      policyRevision: 1,
      runtimeVerified: true,
      options: Array.from({ length: 500 }, (_, index) => ({
        id: `action:canvas:operation${index + 1}`,
        group: "Canvas course actions",
        label: `Operation ${index + 1}`,
        description: "A bounded course-scoped action.",
        availability: "edit",
      })),
      editPermission: {
        schema: "morrow.bridge.edit-permission.v1",
        revision: 1,
        scopeDigest: "b".repeat(64),
        catalogDigest: digest,
        sourceBindingId,
        enabledCategories: ["action:canvas:operation1"],
        rules: [{ operationKey: "PUT /v1/courses/{course_id}/items/{id}#edit", toolName: "canvas_edit_item", allowedChangedFields: ["title"] }],
      },
    }, sourceBindingId);
    expect(details.options).toHaveLength(500);
    expect(details.editPermission?.rules).toHaveLength(1);
  });

  it("accepts one exact Moodle binding without accepting a cross-site course", () => {
    expect(normalizeBridgeBindings([{
      sourceBindingId: "moodle:course:42",
      provider: "moodle",
      courseId: "42",
      origin: "https://school.example",
      siteUrl: "https://school.example/moodle",
      runtimeVerified: true,
    }])).toMatchObject([{ provider: "moodle", courseId: "42", siteUrl: "https://school.example/moodle" }]);
    expect(() => normalizeBridgeBindings([{
      sourceBindingId: "moodle:course:42",
      provider: "moodle",
      courseId: "42",
      origin: "https://school.example",
      siteUrl: "https://other.example/moodle",
      runtimeVerified: true,
    }])).toThrow("siteUrl");
  });

  it("validates an authenticated hello", () => {
    const hello = parseBridgeHello({
      schema: BRIDGE_SCHEMAS.hello,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      token: "x".repeat(48),
      extensionId: "a".repeat(32),
      runtimeRevision: "revision-1",
      catalogDigest: digest,
      bindings: [],
      sentAt: 1,
    });
    expect(hello.catalogDigest).toBe(digest);
  });

  it("adds routing controls without weakening an additionalProperties false schema", () => {
    const schema = augmentBridgeInputSchema({
      type: "object",
      properties: { course_id: { type: "string" } },
      required: ["course_id"],
      additionalProperties: false,
    });
    expect((schema.properties as Record<string, unknown>)._morrow).toBeTruthy();
    expect(schema.additionalProperties).toBe(false);
  });

  it("strips local routing controls before donor execution", () => {
    const split = splitBridgeCallArguments({
      course_id: "42",
      _morrow: {
        source_binding_id: "binding-42",
        operation_id: "operation:12345678",
        outer_grant: {
          plan_digest: digest,
          approval_grant_digest: "b".repeat(64),
          effect_receipt_id: "effect:12345678",
          dispatch_attempt: 1,
          gateway_process_id: "gateway:12345678",
          authorization: {
            kind: "edit_scope",
            policy_digest: "c".repeat(64),
            policy_revision: 3,
          },
        },
      },
    });
    expect(split.arguments).toEqual({ course_id: "42" });
    expect(split.options).toEqual({
      sourceBindingId: "binding-42",
      operationId: "operation:12345678",
      outerGrant: {
        planDigest: digest,
        approvalGrantDigest: "b".repeat(64),
        effectReceiptId: "effect:12345678",
        dispatchAttempt: 1,
        gatewayProcessId: "gateway:12345678",
        authorization: {
          kind: "edit_scope",
          policyDigest: "c".repeat(64),
          policyRevision: 3,
        },
      },
    });
  });

  it("admits one guarded Assignment image repair and refuses an ambiguous legacy guard", () => {
    const input = {
      course_id: "42",
      id: "9",
      _morrow: {
        source_binding_id: "canvas-assignment-42",
        canvas_content_guard: assignmentImageAltGuard,
      },
    };
    const split = splitBridgeCallArguments(input);
    expect(split.arguments).toEqual({ course_id: "42", id: "9" });
    expect(split.options.canvasContentGuard).toEqual(assignmentImageAltGuard);
    expect(matchesBridgeEditPermission(assignmentImageAltBinding(), {
      provider: "canvas",
      catalogDigest: digest,
      operationKey: assignmentOperationKey,
      toolName: "canvas_edit_assignment",
      arguments: { course_id: "42", id: "9", morrow_canvas_content_guard: assignmentImageAltGuard },
    })).toBe(true);
    expect(matchesBridgeEditPermission(assignmentBinding(), {
      provider: "canvas",
      catalogDigest: digest,
      operationKey: assignmentOperationKey,
      toolName: "canvas_edit_assignment",
      arguments: { course_id: "42", id: "9", morrow_canvas_content_guard: assignmentImageAltGuard },
    })).toBe(false);
    expect(() => splitBridgeCallArguments({
      ...input,
      _morrow: {
        ...input._morrow,
        page_guard: {
          kind: "text", page_id: "91", revision_id: "1", body_sha256: "a".repeat(64),
          fields: { url: "lesson", title: "Cells", published: true, front_page: false, editing_roles: "teachers", publish_at: null },
          find_text: "Cells", replace_text: "Cell",
        },
      },
    })).toThrow("either a Canvas content guard or a legacy Page guard");
  });

  it("admits one exact guarded New Quiz item image repair", () => {
    const guard = { ...assignmentImageAltGuard, kind: "new_quiz_item_image_alt", item_id: "12" };
    const binding = {
      ...assignmentImageAltBinding(),
      editPermission: {
        ...assignmentImageAltBinding().editPermission,
        enabledCategories: ["canvas_new_quiz_item_image_alt"],
        rules: [{
          operationKey: newQuizItemOperationKey,
          toolName: "canvas_update_quiz_item",
          allowedChangedFields: [],
          requiresCanvasContentGuard: true,
          canvasContentGuardKind: "new_quiz_item_image_alt" as const,
        }],
      },
    };
    const input = {
      provider: "canvas" as const,
      catalogDigest: digest,
      operationKey: newQuizItemOperationKey,
      toolName: "canvas_update_quiz_item",
      arguments: { course_id: "42", assignment_id: "9", item_id: "12", morrow_canvas_content_guard: guard },
    };
    expect(matchesBridgeEditPermission(binding, input)).toBe(true);
    expect(matchesBridgeEditPermission(binding, {
      ...input,
      arguments: { ...input.arguments, morrow_canvas_content_guard: { ...guard, unreviewed_field: "refused" } },
    })).toBe(false);
  });

  it("admits one exact guarded Classic Quiz description image repair", () => {
    const { assignment_id: _assignmentId, ...guardBase } = assignmentImageAltGuard;
    const guard = { ...guardBase, kind: "classic_quiz_description_image_alt", quiz_id: "77" };
    const binding = {
      ...assignmentImageAltBinding(),
      editPermission: {
        ...assignmentImageAltBinding().editPermission,
        enabledCategories: ["canvas_classic_quiz_description_image_alt"],
        rules: [{
          operationKey: classicQuizOperationKey,
          toolName: "canvas_edit_quiz",
          allowedChangedFields: [],
          requiresCanvasContentGuard: true,
          canvasContentGuardKind: "classic_quiz_description_image_alt" as const,
        }],
      },
    };
    const input = {
      provider: "canvas" as const,
      catalogDigest: digest,
      operationKey: classicQuizOperationKey,
      toolName: "canvas_edit_quiz",
      arguments: { course_id: "42", id: "77", morrow_canvas_content_guard: guard },
    };
    expect(matchesBridgeEditPermission(binding, input)).toBe(true);
    expect(matchesBridgeEditPermission(binding, {
      ...input,
      arguments: { ...input.arguments, quiz_description: "unreviewed" },
    })).toBe(false);
  });

  it("admits only one exact guarded New Quiz choice or feedback image repair", () => {
    const guards = [
      { ...assignmentImageAltGuard, kind: "new_quiz_choice_image_alt", item_id: "12", choice_id: "choice:1" },
      { ...assignmentImageAltGuard, kind: "new_quiz_answer_feedback_image_alt", item_id: "12", choice_id: "choice-2" },
      { ...assignmentImageAltGuard, kind: "new_quiz_feedback_image_alt", item_id: "12", feedback_type: "incorrect" },
    ] as const;
    const binding = {
      ...assignmentImageAltBinding(),
      editPermission: {
        ...assignmentImageAltBinding().editPermission,
        enabledCategories: ["canvas_new_quiz_nested_image_alt"],
        rules: guards.map((guard) => ({
          operationKey: newQuizItemOperationKey,
          toolName: "canvas_update_quiz_item",
          allowedChangedFields: [],
          requiresCanvasContentGuard: true,
          canvasContentGuardKind: guard.kind,
        })),
      },
    };
    for (const guard of guards) {
      const input = {
        provider: "canvas" as const,
        catalogDigest: digest,
        operationKey: newQuizItemOperationKey,
        toolName: "canvas_update_quiz_item",
        arguments: { course_id: "42", assignment_id: "9", item_id: "12", morrow_canvas_content_guard: guard },
      };
      expect(matchesBridgeEditPermission(binding, input)).toBe(true);
      expect(splitBridgeCallArguments({
        course_id: "42",
        assignment_id: "9",
        item_id: "12",
        _morrow: { source_binding_id: "canvas-assignment-42", canvas_content_guard: guard },
      }).options.canvasContentGuard).toEqual(guard);
    }
    expect(matchesBridgeEditPermission({
      ...assignmentImageAltBinding(),
      editPermission: {
        ...assignmentImageAltBinding().editPermission,
        rules: [{ operationKey: newQuizItemOperationKey, toolName: "canvas_update_quiz_item", allowedChangedFields: [], requiresCanvasContentGuard: true, canvasContentGuardKind: "new_quiz_choice_image_alt" as const }],
      },
    }, {
      provider: "canvas",
      catalogDigest: digest,
      operationKey: newQuizItemOperationKey,
      toolName: "canvas_update_quiz_item",
      arguments: { course_id: "42", assignment_id: "9", item_id: "12", morrow_canvas_content_guard: { ...guards[0], choice_id: "" } },
    })).toBe(false);
    expect(matchesBridgeEditPermission({
      ...assignmentImageAltBinding(),
      editPermission: {
        ...assignmentImageAltBinding().editPermission,
        rules: [{ operationKey: newQuizItemOperationKey, toolName: "canvas_update_quiz_item", allowedChangedFields: [], requiresCanvasContentGuard: true, canvasContentGuardKind: "new_quiz_feedback_image_alt" as const }],
      },
    }, {
      provider: "canvas",
      catalogDigest: digest,
      operationKey: newQuizItemOperationKey,
      toolName: "canvas_update_quiz_item",
      arguments: { course_id: "42", assignment_id: "9", item_id: "12", morrow_canvas_content_guard: { ...guards[2], feedback_type: "other" } },
    })).toBe(false);
  });

  it("keeps legacy and canonical Page guards compatible with their matching Page-only policy rules", () => {
    const input = { provider: "canvas" as const, catalogDigest: digest, operationKey: pageOperationKey, toolName: "canvas_update_create_page_courses" };
    expect(matchesBridgeEditPermission(legacyPageTextBinding(), {
      ...input,
      arguments: { course_id: "42", url_or_id: "lesson", morrow_page_guard: legacyPageTextGuard },
    })).toBe(true);
    expect(matchesBridgeEditPermission(legacyPageTextBinding(), {
      ...input,
      arguments: { course_id: "42", url_or_id: "lesson", morrow_canvas_content_guard: pageTextGuard },
    })).toBe(true);
    expect(matchesBridgeEditPermission(canonicalPageTextBinding(), {
      ...input,
      arguments: { course_id: "42", url_or_id: "lesson", morrow_page_guard: legacyPageTextGuard },
    })).toBe(true);
    expect(matchesBridgeEditPermission(canonicalPageTextBinding(), {
      ...input,
      arguments: { course_id: "42", url_or_id: "lesson", morrow_canvas_content_guard: pageTextGuard },
    })).toBe(true);
  });

  it("requires exactly one ISO assignment due-date field for Edit scope", () => {
    const binding = assignmentBinding();
    const base = {
      provider: "canvas" as const,
      catalogDigest: digest,
      operationKey: assignmentOperationKey,
      toolName: "canvas_edit_assignment",
    };
    expect(matchesBridgeEditPermission(binding, {
      ...base,
      arguments: { course_id: "42", id: "9" },
    })).toBe(false);
    expect(matchesBridgeEditPermission(binding, {
      ...base,
      arguments: { course_id: "42", id: "9", assignment_due_at: "2026-10-15T17:00:00Z" },
    })).toBe(true);
    expect(matchesBridgeEditPermission(binding, {
      ...base,
      arguments: { course_id: "42", id: "9", assignment_due_at: "2026-10-15T17:00:00Z", published: true },
    })).toBe(false);
  });

  it("rejects an expired conversational Edit permission", () => {
    expect(matchesBridgeEditPermission(assignmentBinding(Date.now() - 1), {
      provider: "canvas",
      catalogDigest: digest,
      operationKey: assignmentOperationKey,
      toolName: "canvas_edit_assignment",
      arguments: { course_id: "42", id: "9", assignment_due_at: "2026-10-15T17:00:00Z" },
    })).toBe(false);
  });
});
