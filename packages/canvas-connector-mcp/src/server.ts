import { McpServer, fromJsonSchema as validateJsonSchema } from "@modelcontextprotocol/server";
import { augmentBridgeInputSchema } from "@morrow/bridge-protocol";
import { canvasCatalogTools } from "@morrow/canvas-api-catalog";
import { isJsonObject, type JsonObject, type JsonSchema } from "@morrow/contracts";
import * as z from "zod/v4";
import { SourceMcpPrivacyBoundary, sourcePrivacyInputSchema } from "@morrow/gateway-core";
import { canvasBrowserCatalogTools, moodleCatalogTools } from "./browser-catalog.js";
import {
  PRIVATE_MOODLE_ENROLMENT_CANDIDATE_OPERATION,
  PRIVATE_MOODLE_ENROLMENT_CANDIDATE_TOOL,
  type CanvasConnectorRuntime,
} from "./runtime.js";
const fromJsonSchema = (schema: JsonObject) => validateJsonSchema(sourcePrivacyInputSchema(schema));


export function canvasConnectorSummary(value: JsonObject): string {
  const platform = value.provider === "moodle" ? "Moodle" : "Canvas";
  if (value.ok === false) return `Morrow could not complete the ${platform} request.`;
  if (value.schema === "morrow.canvas-connector.health.v1") {
    const bridge = isJsonObject(value.bridge) ? value.bridge : null;
    const problem = bridge && isJsonObject(bridge.problem) ? bridge.problem : null;
    if (typeof problem?.message === "string") return `Morrow checked the connection. ${problem.message}`;
    return value.ready === true
      ? "Morrow checked the connection. The extension is connected to Morrow."
      : "Morrow checked the connection. The extension is not connected to Morrow.";
  }
  if (value.schema === "morrow.canvas-bindings.v1") {
    return "Morrow checked the available Canvas connections.";
  }
  if (value.schema === "morrow.browser-bindings.v1") {
    return "Morrow checked the available learning-platform connections.";
  }
  if (value.schema === "morrow.bridge.edit-options.v1") {
    return "Morrow read the available Edit actions for this exact course connection.";
  }
  if (value.schema !== "morrow.canvas-connector.result.v1") {
    return "Morrow checked the Canvas connection.";
  }
  if (value.commandKind === "invoke_read") return `Morrow read ${platform} data.`;
  if (value.commandKind !== "invoke_write") return "Morrow checked the Canvas connection.";

  const browser = isJsonObject(value.result) ? value.result : null;
  const verification = browser && isJsonObject(browser.verification)
    && browser.verification.schema === "morrow.browser-verification.v1"
    ? browser.verification
    : null;
  if (verification?.status === "verified") {
    return `Morrow confirmed the ${platform} change with a fresh ${platform} check.`;
  }
  if (verification?.status === "mismatch") {
    return `Morrow could not confirm this change because ${platform} returned a different result. Ask your assistant to check the existing request. Do not repeat this change.`;
  }
  return "Morrow could not confirm this change. Ask your assistant to check the existing request. Do not repeat this change.";
}

export function newQuizSettingsWriteSchema(inputSchema: JsonSchema): JsonObject {
  const schema = augmentBridgeInputSchema(inputSchema);
  return {
    ...schema,
    properties: {
      ...(isJsonObject(schema.properties) ? schema.properties : {}),
      morrow_new_quiz_settings_guard: {
        type: "object",
        description: "Fresh complete quiz_settings digest from morrow_plan_new_quiz_settings. Required when this request changes a New Quiz setting.",
        properties: { current_quiz_settings_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" } },
        required: ["current_quiz_settings_sha256"],
        additionalProperties: false,
      },
    },
  };
}

export function newQuizItemWriteSchema(inputSchema: JsonSchema): JsonObject {
  const schema = augmentBridgeInputSchema(inputSchema, true);
  return {
    ...schema,
    properties: {
      ...(isJsonObject(schema.properties) ? schema.properties : {}),
      morrow_new_quiz_item_position_guard: {
        type: "object",
        description: "Complete current and expected New Quiz item order from the reviewed reorder planner. Required when this request changes item_position.",
        properties: {
          kind: { const: "new_quiz_item_position" },
          before_item_ids_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
          expected_item_ids: {
            type: "array", minItems: 1, maxItems: 10_000, uniqueItems: true,
            items: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
          },
          expected_item_ids_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        },
        required: ["kind", "before_item_ids_sha256", "expected_item_ids", "expected_item_ids_sha256"],
        additionalProperties: false,
      },
    },
  };
}

export function newQuizItemLifecycleWriteSchema(inputSchema: JsonSchema): JsonObject {
  const schema = augmentBridgeInputSchema(inputSchema);
  const digest = { type: "string", pattern: "^[0-9a-f]{64}$" };
  return {
    ...schema,
    properties: {
      ...(isJsonObject(schema.properties) ? schema.properties : {}),
      morrow_new_quiz_item_lifecycle_guard: {
        description: "Fresh complete item-list state from a New Quiz lifecycle planner. Required for item create and delete.",
        oneOf: [
          {
            type: "object",
            properties: {
              kind: { const: "create" },
              before_items_sha256: digest,
              payload_sha256: digest,
            },
            required: ["kind", "before_items_sha256", "payload_sha256"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { const: "delete" },
              before_items_sha256: digest,
              target_item_sha256: digest,
              item_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
              entry_type: { const: "Item" },
            },
            required: ["kind", "before_items_sha256", "target_item_sha256", "item_id", "entry_type"],
            additionalProperties: false,
          },
        ],
      },
    },
  };
}

export function newQuizLifecycleWriteSchema(inputSchema: JsonSchema): JsonObject {
  const schema = augmentBridgeInputSchema(inputSchema);
  const digest = { type: "string", pattern: "^[0-9a-f]{64}$" };
  return {
    ...schema,
    properties: {
      ...(isJsonObject(schema.properties) ? schema.properties : {}),
      morrow_new_quiz_lifecycle_guard: {
        description: "Fresh complete course quiz membership from a reviewed New Quiz lifecycle plan.",
        oneOf: [
          {
            type: "object",
            properties: {
              kind: { const: "create" },
              before_quiz_ids: { type: "array", maxItems: 10_000, uniqueItems: true, items: { type: "string", pattern: "^[1-9][0-9]{0,18}$" } },
              before_quiz_ids_sha256: digest, payload_sha256: digest,
            },
            required: ["kind", "before_quiz_ids", "before_quiz_ids_sha256", "payload_sha256"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { const: "delete" }, before_quiz_ids_sha256: digest, target_quiz_sha256: digest,
              before_quiz_ids: { type: "array", maxItems: 10_000, uniqueItems: true, items: { type: "string", pattern: "^[1-9][0-9]{0,18}$" } },
              target_items_sha256: digest, target_assignment_sha256: digest,
              quiz_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
            },
            required: ["kind", "before_quiz_ids", "before_quiz_ids_sha256", "target_quiz_sha256", "target_items_sha256", "target_assignment_sha256", "quiz_id"],
            additionalProperties: false,
          },
        ],
      },
    },
  };
}

export function newQuizEffectWriteSchema(inputSchema: JsonSchema): JsonObject {
  const schema = augmentBridgeInputSchema(inputSchema);
  return {
    ...schema,
    properties: {
      ...(isJsonObject(schema.properties) ? schema.properties : {}),
      morrow_new_quiz_effect_guard: {
        type: "object",
        properties: {
          kind: { enum: ["accommodation", "report"] },
          payload_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        },
        required: ["kind", "payload_sha256"],
        additionalProperties: false,
      },
    },
  };
}

function toolResult(value: JsonObject) {
  const ok = value.ok !== false;
  return {
    content: [{ type: "text" as const, text: canvasConnectorSummary(value) }],
    structuredContent: value,
    ...(!ok ? { isError: true } : {}),
  };
}

export function privateMoodleEnrolmentCandidateInputSchema(): JsonObject {
  return augmentBridgeInputSchema({
    type: "object",
    properties: {
      course_id: { type: "integer", minimum: 1 },
      query: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description: "Exact full name as Moodle renders it in the native manual-enrolment candidate selector.",
      },
    },
    required: ["course_id", "query"],
    additionalProperties: false,
  }, false, false);
}

export function createCanvasConnectorMcpServer(runtime: CanvasConnectorRuntime, options: { readonly internalSourceCapability?: string; readonly learnerVaultPath?: string } = {}): McpServer {
  const server = new McpServer({ name: "morrow-canvas-connector", version: "1.0.0" });
  const privacy = new SourceMcpPrivacyBoundary({
    source: "canvas-connector-mcp",
    internalSourceCapability: options.internalSourceCapability,
    learnerVaultPath: options.learnerVaultPath,
    bindings: () => runtime.bindings(),
    acceptsCourseRequest: (name, args, binding) => runtime.acceptsPublicPrivacyScope(name, args, binding),
    loadRoster: (binding) => runtime.privacyRoster(binding),
  });
  const registerTool: typeof server.registerTool = ((...registration: Parameters<typeof server.registerTool>) => {
    const [name, config, callback] = registration;
    return server.registerTool(name, config, async (args, ctx) => await privacy.invoke(name,
      isJsonObject(args) ? args : {}, ctx.mcpReq._meta,
      async (resolved) => callback(resolved, ctx)) as Awaited<ReturnType<typeof callback>>);
  }) as typeof server.registerTool;

  const privateChatBase = {
    schema: z.literal("morrow.private-chat.exchange.v1"),
    sessionId: z.string().min(8).max(160).regex(/^[A-Za-z0-9_.:@-]+$/),
    assistantName: z.string().min(1).max(200),
  };
  registerTool("morrow_private_chat_exchange", {
    title: "Relay one local Private Chat exchange",
    description: "Internal Morrow control that waits on the authenticated local Bridge drawer. This tool is not a catalog capability.",
    inputSchema: z.discriminatedUnion("action", [
      z.strictObject({ ...privateChatBase, action: z.literal("listen") }),
      z.strictObject({
        ...privateChatBase,
        action: z.literal("reply_and_listen"),
        assistantReply: z.string().min(1).max(100_000),
        sourceBindingId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:@-]+$/),
        courseId: z.string().regex(/^[1-9][0-9]{0,18}$/),
      }),
    ]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input, context) => toolResult(await runtime.privateChatExchange(input as unknown as JsonObject, context.mcpReq.signal)));

  registerTool("morrow_canvas_connector_health", {
    title: "Check the Chrome connection",
    description: "Report the local Morrow Canvas connector, full Canvas catalog, and signed-in browser-session state.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => toolResult(runtime.health()));
  registerTool("morrow_canvas_bindings", {
    title: "Show saved Canvas connections",
    description: "List the runtime-verified Canvas accounts available through the local Chrome connector.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => toolResult({ schema: "morrow.canvas-bindings.v1", ok: true, bindings: runtime.canvasBindings(), count: runtime.canvasBindings().length }));
  registerTool("morrow_browser_bindings", {
    title: "Show saved learning-platform connections",
    description: "List the runtime-verified Canvas and Moodle accounts available through the local Chrome connector.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => toolResult({ schema: "morrow.browser-bindings.v1", ok: true, bindings: runtime.bindings(), count: runtime.bindings().length }));
  registerTool("morrow_browser_edit_options", {
    title: "Show course Edit actions",
    description: "Read the current individual Edit and Review-only actions for one exact saved browser course connection.",
    inputSchema: z.strictObject({ source_binding_id: z.string().min(1).max(160) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => toolResult(await runtime.editOptions(input.source_binding_id)));
  registerTool("morrow_browser_edit_policy_set", {
    title: "Set selected course Edit access",
    description: "Internal Morrow control for one current set of exact browser course bindings. This tool is not a catalog capability.",
    inputSchema: z.discriminatedUnion("mode", [
      z.strictObject({
        mode: z.literal("edit"),
        selections: z.array(z.strictObject({
          sourceBindingId: z.string().min(1).max(160),
          expectedPolicyRevision: z.number().int().min(0),
          enabledCategories: z.array(z.string().min(1).max(160)).min(1).max(500),
        })).min(1).max(500),
      }),
      z.strictObject({
        mode: z.literal("plan"),
        selections: z.array(z.strictObject({
          sourceBindingId: z.string().min(1).max(160),
          expectedPolicyRevision: z.number().int().min(0),
        })).min(1).max(500),
      }),
    ]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => toolResult(await runtime.editPolicySet(input)));
  registerTool("morrow_bridge_maintenance", {
    title: "Maintain paired Morrow Bridge",
    description: "Internal Morrow control for authenticated paired-Bridge status, quiescence, recovery, and reload readback. This tool is not a catalog capability.",
    inputSchema: z.discriminatedUnion("action", [
      z.strictObject({ action: z.literal("status") }),
      z.strictObject({ action: z.literal("quiesce") }),
      z.strictObject({ action: z.literal("readback") }),
      z.strictObject({
        action: z.literal("resume"),
        quiesceEpoch: z.string().min(16).max(256).regex(/^[A-Za-z0-9._-]+$/),
        fileLayerRestored: z.literal(true),
      }),
    ]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => toolResult(await runtime.bridgeMaintenance(input)));
  registerTool(PRIVATE_MOODLE_ENROLMENT_CANDIDATE_TOOL, {
    title: "Find one private Moodle enrolment candidate",
    description: "Internal Morrow read that resolves one exact full name through this course's native manual-enrolment candidate selector. Only the numeric Moodle user ID leaves the signed-in browser session.",
    inputSchema: fromJsonSchema(privateMoodleEnrolmentCandidateInputSchema()),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: {
      "io.morrow/capability": {
        family: "learner-data",
        provider: "moodle",
        sourcePath: "connector/extension/src/moodle-enrolment-executor.js",
        sourceExport: PRIVATE_MOODLE_ENROLMENT_CANDIDATE_OPERATION,
        behavior: {
          readOnly: true, mutating: false, destructive: false, irreversible: false,
          supportsDryRun: false, supportsReadback: true, supportsUndo: false, supportsBatch: false,
          requiresBrowser: true, requiresLiveCanvas: false,
        },
        authority: { scopeClass: "course", approvalClass: "none", dataClass: "learner" },
        route: { backend: "canvas-connector", dispatchBackend: "chrome-session-connector", readbackBackend: "chrome-session-connector", comparator: "native-exact-query" },
        profiles: {
          "private-full": { state: "supported" },
          "public-canvas": { state: "profile_limited", reason: "This private source read is available only to Morrow's internal Moodle planning path." },
          sandbox: { state: "profile_limited", reason: "This read requires a signed-in Moodle session." },
          "read-only": { state: "supported" },
        },
        evidence: { transport: { state: "known" }, credentialBoundary: { state: "known" } },
      },
    },
  }, async (argumentsValue) => toolResult(await runtime.call(
    PRIVATE_MOODLE_ENROLMENT_CANDIDATE_TOOL,
    isJsonObject(argumentsValue) ? argumentsValue : {},
  )));
  registerTool("canvas_send_private_conversation", {
    title: "Send reviewed Canvas Inbox message",
    description: "Internal Morrow route for one reviewed Canvas Inbox conversation or reply. Recipient identities and message content are private transport data and cannot be supplied through public Morrow capability arguments.",
    inputSchema: fromJsonSchema(augmentBridgeInputSchema({
      type: "object",
      properties: {
        course_id: { type: "integer", minimum: 1 },
        privateConversation: {
          type: "object",
          properties: {
            schema: { const: "morrow.canvas-conversation.private.v1" },
            action: { enum: ["create", "reply"] },
            courseId: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
            recipients: {
              type: "array",
              minItems: 0,
              maxItems: 500,
              items: { type: "string", pattern: "^(?:[1-9][0-9]{0,18}|(?:course|section|group)_[1-9][0-9]{0,18}(?:_(?:students|teachers|tas|observers|designers))?)$" },
            },
            subject: { type: "string", maxLength: 255 },
            body: { type: "string", minLength: 1, maxLength: 1_000_000 },
            groupConversation: { type: "boolean" },
            forceNew: { type: "boolean" },
            conversationId: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
          },
          required: ["schema", "action", "courseId", "body"],
          additionalProperties: false,
        },
      },
      required: ["course_id", "privateConversation"],
      additionalProperties: false,
    })),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: {
      "io.morrow/capability": {
        family: "inbox",
        provider: "canvas",
        sourcePath: "connector/extension/src/canvas-conversations.js",
        sourceExport: "canvas.private.conversation.send.v1",
        behavior: {
          readOnly: false, mutating: true, destructive: false, irreversible: false,
          supportsDryRun: false, supportsReadback: true, supportsUndo: false, supportsBatch: false,
          requiresBrowser: true, requiresLiveCanvas: true,
        },
        authority: { scopeClass: "course", approvalClass: "standard", dataClass: "course" },
        route: { backend: "canvas-connector", dispatchBackend: "chrome-session-connector", readbackBackend: "chrome-session-connector", comparator: "conversation-message-id" },
        profiles: {
          "private-full": { state: "supported" },
          "public-canvas": { state: "profile_limited", reason: "This action requires a signed-in Canvas session." },
          sandbox: { state: "profile_limited", reason: "This action requires a signed-in Canvas session." },
          "read-only": { state: "profile_limited", reason: "This action changes a Canvas course." },
        },
        evidence: { transport: { state: "known" }, credentialBoundary: { state: "known" } },
      },
    },
  }, async (argumentsValue) => toolResult(await runtime.call("canvas_send_private_conversation", isJsonObject(argumentsValue) ? argumentsValue : {})));
  registerTool("canvas_transfer_course_file", {
    title: "Transfer reviewed Canvas course file",
    description: "Internal Morrow route that transfers one staged, reviewed material to one current Canvas course folder. File bytes are private transport data and cannot be supplied in public tool arguments.",
    inputSchema: fromJsonSchema(augmentBridgeInputSchema({
      type: "object",
      properties: {
        course_id: { type: "integer", minimum: 1 },
        folder_id: { type: "integer", minimum: 1 },
        filename: { type: "string", minLength: 1, maxLength: 255 },
        size_bytes: { type: "integer", minimum: 1, maximum: 1024 * 1024 },
        sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        content_type: { type: "string", pattern: "^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$" },
      },
      required: ["course_id", "folder_id", "filename", "size_bytes", "sha256", "content_type"],
      additionalProperties: false,
    }, false, true)),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: {
      "io.morrow/capability": {
        family: "course-files",
        provider: "canvas",
        sourcePath: "connector/extension/src/canvas-file-transfer.js",
        sourceExport: "canvas.private.course_file.transfer.v1",
        behavior: {
          readOnly: false, mutating: true, destructive: false, irreversible: false,
          supportsDryRun: false, supportsReadback: true, supportsUndo: false, supportsBatch: false,
          requiresBrowser: true, requiresLiveCanvas: true,
        },
        authority: { scopeClass: "course-folder", approvalClass: "standard", dataClass: "course" },
        route: { backend: "canvas-connector", dispatchBackend: "chrome-session-connector", readbackBackend: "chrome-session-connector", comparator: "saved-file-bytes" },
        profiles: {
          "private-full": { state: "supported" },
          "public-canvas": { state: "profile_limited", reason: "This action requires a signed-in Canvas session." },
          sandbox: { state: "profile_limited", reason: "This action requires a signed-in Canvas session." },
          "read-only": { state: "profile_limited", reason: "This action changes a Canvas course." },
        },
        evidence: { transport: { state: "known" }, credentialBoundary: { state: "known" } },
      },
    },
  }, async (argumentsValue) => toolResult(await runtime.call("canvas_transfer_course_file", isJsonObject(argumentsValue) ? argumentsValue : {})));
  registerTool("canvas_create_new_quiz_hot_spot", {
    title: "Create reviewed New Quiz Hot Spot question",
    description: "Internal Morrow route that creates one reviewed New Quizzes Hot Spot question with its reviewed image. Canvas requires a signed media upload URL, one PUT of the exact image bytes, and a create that carries that URL without its query string. Image bytes are private transport data and cannot be supplied in public tool arguments.",
    inputSchema: fromJsonSchema(augmentBridgeInputSchema({
      type: "object",
      properties: {
        course_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        assignment_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        item: { type: "object" },
        before_items_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        payload_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        filename: { type: "string", minLength: 1, maxLength: 255 },
        size_bytes: { type: "integer", minimum: 1, maximum: 1024 * 1024 },
        sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        content_type: { type: "string", enum: ["image/png", "image/jpeg", "image/gif"] },
      },
      required: ["course_id", "assignment_id", "item", "before_items_sha256", "payload_sha256", "filename", "size_bytes", "sha256", "content_type"],
      additionalProperties: false,
    }, false, true)),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: {
      "io.morrow/capability": {
        family: "new-quizzes",
        provider: "canvas",
        sourcePath: "connector/extension/src/canvas-new-quiz-hot-spot.js",
        sourceExport: "canvas.private.new_quiz.hot_spot.create.v1",
        behavior: {
          readOnly: false, mutating: true, destructive: false, irreversible: false,
          supportsDryRun: false, supportsReadback: true, supportsUndo: false, supportsBatch: false,
          requiresBrowser: true, requiresLiveCanvas: true,
        },
        authority: { scopeClass: "course-quiz", approvalClass: "standard", dataClass: "course" },
        route: { backend: "canvas-connector", dispatchBackend: "chrome-session-connector", readbackBackend: "chrome-session-connector", comparator: "new-quiz-item-membership" },
        profiles: {
          "private-full": { state: "supported" },
          "public-canvas": { state: "profile_limited", reason: "This action requires a signed-in Canvas session." },
          sandbox: { state: "profile_limited", reason: "This action requires a signed-in Canvas session." },
          "read-only": { state: "profile_limited", reason: "This action changes a Canvas course." },
        },
        evidence: { transport: { state: "known" }, credentialBoundary: { state: "known" } },
      },
    },
  }, async (argumentsValue) => toolResult(await runtime.call("canvas_create_new_quiz_hot_spot", isJsonObject(argumentsValue) ? argumentsValue : {})));

  for (const tool of canvasCatalogTools(runtime.catalog)) {
    registerTool(tool.name, {
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: fromJsonSchema(tool.name === "canvas_update_single_quiz" ? newQuizSettingsWriteSchema(tool.inputSchema)
        : tool.name === "canvas_update_quiz_item" ? newQuizItemWriteSchema(tool.inputSchema)
        : ["canvas_create_quiz_item", "canvas_delete_quiz_item"].includes(tool.name) ? newQuizItemLifecycleWriteSchema(tool.inputSchema)
        : ["canvas_create_new_quiz", "canvas_delete_new_quiz"].includes(tool.name) ? newQuizLifecycleWriteSchema(tool.inputSchema)
        : ["canvas_set_course_level_accommodations", "canvas_set_quiz_level_accommodations", "canvas_create_quiz_report_course_id_quizzes_assignment_id_reports_post"].includes(tool.name) ? newQuizEffectWriteSchema(tool.inputSchema)
        : augmentBridgeInputSchema(tool.inputSchema, [
          "canvas_update_create_page_courses",
          "canvas_edit_assignment",
          "canvas_update_topic_courses",
        ].includes(tool.name), false, tool.name === "canvas_update_create_page_courses")),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      _meta: { "io.morrow/capability": tool.capability },
    }, async (argumentsValue) => toolResult(await runtime.call(tool.name, isJsonObject(argumentsValue) ? argumentsValue : {})));
  }
  for (const tool of canvasBrowserCatalogTools(runtime.canvasBrowserCatalog)) {
    registerTool(tool.name, {
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: fromJsonSchema(augmentBridgeInputSchema(tool.inputSchema, false, false)),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      _meta: { "io.morrow/capability": tool.capability },
    }, async (argumentsValue) => toolResult(await runtime.call(tool.name, isJsonObject(argumentsValue) ? argumentsValue : {})));
  }
  for (const tool of moodleCatalogTools(runtime.moodleCatalog)) {
    registerTool(tool.name, {
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: fromJsonSchema(augmentBridgeInputSchema(
        tool.inputSchema,
        false,
        tool.name === "moodle_create_resource_file" || tool.name === "moodle_create_folder_file" || tool.name === "moodle_create_imscp_package" || tool.name === "moodle_create_scorm_package" || tool.name === "moodle_replace_resource_file" || tool.name === "moodle_replace_scorm_package" || tool.name === "moodle_create_h5pactivity" || tool.name === "moodle_replace_h5pactivity_package",
        false,
        tool.name === "moodle_add_folder_files",
      )),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      _meta: { "io.morrow/capability": tool.capability },
    }, async (argumentsValue) => toolResult(await runtime.call(tool.name, isJsonObject(argumentsValue) ? argumentsValue : {})));
  }
  return server;
}
