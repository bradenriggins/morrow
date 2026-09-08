import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { augmentBridgeInputSchema } from "@morrow/bridge-protocol";
import { canvasCatalogTools } from "@morrow/canvas-api-catalog";
import { isJsonObject, type JsonObject, type JsonSchema, type SourceCapabilityMetadata } from "@morrow/contracts";
import * as z from "zod/v4";
import { canvasBrowserCatalogTools, moodleCatalogTools } from "./browser-catalog.js";
import type { CanvasConnectorRuntime } from "./runtime.js";

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

/**
 * The generic Item Bank question write stays held everywhere it is described:
 * `canvasOperationAdmission` refuses it, and every profile in the generated
 * capability says so. Morrow sends this one route in exactly one shape — the
 * guarded image alternative-text repair planned by
 * `morrow_plan_item_bank_question_image_alt_repair` — so the connector publishes
 * that shape alone, and nothing else. `PRIVATE_SOURCE_TOOL_NAMES` in
 * packages/mcp-server/src/runtime.ts keeps this tool out of every client tool
 * list, so the planner is the only way in.
 */
const ITEM_BANK_GUARDED_WRITE_TOOL = "canvas_item_bank_update_item";

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

const ITEM_BANK_GUARD_PROPERTIES: JsonObject = {
  kind: { const: "item_bank_entry_image_alt" },
  course_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
  bank_id: { type: "string", minLength: 1, maxLength: 128 },
  bank_entry_id: { type: "string", minLength: 1, maxLength: 128 },
  item_id: { type: "string", minLength: 1, maxLength: 128 },
  entry_type: { const: "Item" },
  item_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
  protected_state_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
  image_index: { type: "integer", minimum: 1 },
  image_src_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
  alt_text: { type: "string", minLength: 1, maxLength: 500 },
  fan_out: { type: "object", additionalProperties: true },
  acknowledged_course_ids: { type: "array", items: { type: "string", pattern: "^[1-9][0-9]{0,18}$" }, maxItems: 200 },
};

/**
 * The published shape of the guarded repair: the bank, the question, and the
 * guard. There is no question body here on purpose — the Item Banks frame reads
 * the current question inside the signed-in session and builds the changed body
 * itself, so a body sent from outside could only disagree with what the frame
 * saw. The frame checks every field of this guard again before it sends
 * anything; this schema is the shape only.
 */
function itemBankGuardedWriteSchema(inputSchema: JsonSchema): JsonObject {
  const augmented = augmentBridgeInputSchema(inputSchema, false, false);
  const properties = isJsonObject(augmented.properties) ? augmented.properties : {};
  return {
    ...augmented,
    properties: {
      ...(properties.bank_id ? { bank_id: properties.bank_id } : {}),
      ...(properties.item_id ? { item_id: properties.item_id } : {}),
      morrow_item_bank_guard: {
        type: "object",
        description: "The exact question and affected-course evidence this repair was planned against. Morrow's item bank repair planner produces it; nothing else does.",
        properties: ITEM_BANK_GUARD_PROPERTIES,
        required: Object.keys(ITEM_BANK_GUARD_PROPERTIES),
        additionalProperties: false,
      },
      ...(properties._morrow ? { _morrow: properties._morrow } : {}),
    },
    required: ["bank_id", "item_id", "morrow_item_bank_guard"],
    additionalProperties: false,
  };
}

/**
 * The generated capability describes the held generic write, so it reports the
 * hold in every profile and no readback. This one guarded shape is different in
 * exactly two ways, and only where a signed-in Item Banks frame exists: it is
 * admitted, and the frame reads the question again after its single change and
 * compares it. Every other profile keeps the hold sentence a person reads.
 */
function itemBankGuardedWriteCapability(capability: SourceCapabilityMetadata | undefined): SourceCapabilityMetadata | undefined {
  if (!capability) return capability;
  return {
    ...capability,
    behavior: { ...capability.behavior, supportsReadback: true },
    profiles: { ...capability.profiles, "private-full": { state: "supported" } },
    evidence: {
      ...capability.evidence,
      admission: { state: "known", reason: "Admitted only as the guarded image alternative-text repair, with a complete affected-course record confirmed by the person." },
      readback: { state: "known", reason: "The Item Banks frame reads the question again after its single change and compares it. Live provider readback remains required." },
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

export function createCanvasConnectorMcpServer(runtime: CanvasConnectorRuntime): McpServer {
  const server = new McpServer({ name: "morrow-canvas-connector", version: "1.0.0" });
  server.registerTool("morrow_canvas_connector_health", {
    title: "Check the Chrome connection",
    description: "Report the local Morrow Canvas connector, full Canvas catalog, and signed-in browser-session state.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => toolResult(runtime.health()));
  server.registerTool("morrow_canvas_bindings", {
    title: "Show saved Canvas connections",
    description: "List the runtime-verified Canvas accounts available through the local Chrome connector.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => toolResult({ schema: "morrow.canvas-bindings.v1", ok: true, bindings: runtime.canvasBindings(), count: runtime.canvasBindings().length }));
  server.registerTool("morrow_browser_bindings", {
    title: "Show saved learning-platform connections",
    description: "List the runtime-verified Canvas and Moodle accounts available through the local Chrome connector.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => toolResult({ schema: "morrow.browser-bindings.v1", ok: true, bindings: runtime.bindings(), count: runtime.bindings().length }));
  server.registerTool("morrow_browser_edit_options", {
    title: "Show course Edit actions",
    description: "Read the current individual Edit and Review-only actions for one exact saved browser course connection.",
    inputSchema: z.strictObject({ source_binding_id: z.string().min(1).max(160) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => toolResult(await runtime.editOptions(input.source_binding_id)));
  server.registerTool("morrow_browser_edit_policy_set", {
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
  server.registerTool("morrow_bridge_maintenance", {
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
  server.registerTool("canvas_send_private_conversation", {
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
  server.registerTool("canvas_transfer_course_file", {
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

  for (const tool of canvasCatalogTools(runtime.catalog)) {
    const guardedItemBank = tool.name === ITEM_BANK_GUARDED_WRITE_TOOL;
    server.registerTool(tool.name, {
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: fromJsonSchema(guardedItemBank
        ? itemBankGuardedWriteSchema(tool.inputSchema)
        : tool.name === "canvas_update_single_quiz" ? newQuizSettingsWriteSchema(tool.inputSchema)
        : augmentBridgeInputSchema(tool.inputSchema, [
          "canvas_update_create_page_courses",
          "canvas_edit_assignment",
          "canvas_update_topic_courses",
        ].includes(tool.name), false, tool.name === "canvas_update_create_page_courses")),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      _meta: { "io.morrow/capability": guardedItemBank ? itemBankGuardedWriteCapability(tool.capability) : tool.capability },
    }, async (argumentsValue) => toolResult(await runtime.call(tool.name, isJsonObject(argumentsValue) ? argumentsValue : {})));
  }
  for (const tool of canvasBrowserCatalogTools(runtime.canvasBrowserCatalog)) {
    server.registerTool(tool.name, {
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: fromJsonSchema(augmentBridgeInputSchema(tool.inputSchema, false, false)),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      _meta: { "io.morrow/capability": tool.capability },
    }, async (argumentsValue) => toolResult(await runtime.call(tool.name, isJsonObject(argumentsValue) ? argumentsValue : {})));
  }
  for (const tool of moodleCatalogTools(runtime.moodleCatalog)) {
    server.registerTool(tool.name, {
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
