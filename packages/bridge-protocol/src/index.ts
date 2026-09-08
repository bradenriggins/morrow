import {
  isJsonObject,
  normalizeInputSchema,
  normalizeSourceId,
  normalizeToolName,
  sha256Json,
  type JsonObject,
} from "@morrow/contracts";
import { createHash } from "node:crypto";

export const BRIDGE_PROTOCOL_VERSION = 1 as const;
export const BRIDGE_PATH = "/morrow-bridge/v1" as const;
export const MAX_BRIDGE_MESSAGE_BYTES = 2 * 1024 * 1024;
export const MIN_BRIDGE_TOKEN_LENGTH = 32;
export const MAX_BRIDGE_TOKEN_LENGTH = 512;
export const MAX_BRIDGE_BINDINGS = 500;
export const MAX_BRIDGE_EDIT_CATEGORIES = 500;
export const MAX_BRIDGE_EDIT_OPTIONS = 600;
export const MAX_BRIDGE_EDIT_RULES = 500;
export const MAX_BRIDGE_EDIT_FIELDS = 100;
export const MAX_BRIDGE_PRIVATE_FILE_BYTES = 1024 * 1024;
export const MAX_BRIDGE_PRIVATE_FILE_BASE64_BYTES = 4 * Math.ceil(MAX_BRIDGE_PRIVATE_FILE_BYTES / 3);
export const MAX_BRIDGE_PRIVATE_FILE_ATTACHMENTS = 8;
export const MAX_BRIDGE_PRIVATE_CONVERSATION_RECIPIENTS = 5_000;

export const BRIDGE_SCHEMAS = Object.freeze({
  hello: "morrow.bridge.hello.v1",
  ready: "morrow.bridge.ready.v1",
  command: "morrow.bridge.command.v1",
  result: "morrow.bridge.result.v1",
  bindings: "morrow.bridge.bindings.v1",
  ping: "morrow.bridge.ping.v1",
  pong: "morrow.bridge.pong.v1",
} as const);

export type BridgeCommandKind =
  | "invoke_read"
  | "invoke_write"
  | "stage_write"
  | "task_get"
  | "bindings_get"
  | "edit_policy_set"
  | "edit_policy_options_get"
  /** Private desktop-to-Bridge maintenance control. Never a catalog capability. */
  | "bridge_maintenance";

export type BridgeProvider = "canvas" | "moodle" | "blackboard";

export interface BridgeEditPermissionRule {
  readonly operationKey: string;
  readonly toolName: string;
  readonly allowedChangedFields: readonly string[];
  /** Legacy Page-only permission rule. */
  readonly requiresPageGuard?: boolean;
  /** Legacy Page-only permission rule. */
  readonly pageGuardKind?: "text" | "image_alt";
  readonly requiresCanvasContentGuard?: boolean;
  readonly canvasContentGuardKind?: "page_text" | "page_image_alt" | "assignment_image_alt" | "discussion_image_alt" | "classic_quiz_description_image_alt" | "classic_quiz_question_image_alt" | "new_quiz_item_image_alt" | "new_quiz_choice_image_alt" | "new_quiz_answer_feedback_image_alt" | "new_quiz_feedback_image_alt";
}

export interface BridgeEditPermission {
  readonly schema: "morrow.bridge.edit-permission.v1";
  readonly revision: number;
  readonly scopeDigest: string;
  readonly catalogDigest: string;
  readonly sourceBindingId: string;
  /** Present only for a short-lived conversational Edit permission. */
  readonly expiresAt?: number;
  readonly enabledCategories: readonly string[];
  readonly rules: readonly BridgeEditPermissionRule[];
}

export interface BridgeEditPermissionSummary {
  readonly schema: "morrow.bridge.edit-permission.v1";
  readonly revision: number;
  readonly scopeDigest: string;
  readonly catalogDigest: string;
  readonly sourceBindingId: string;
  readonly expiresAt?: number;
}

export interface BridgeEditCategory {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export interface BridgeEditOption {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly description: string;
  readonly availability: "edit" | "review";
  readonly reviewReason?: string;
  readonly tier?: "standard" | "destructive";
  readonly destructive?: boolean;
  readonly verification?: "checked" | "unchecked";
  readonly verificationReason?: string;
  readonly requiresFieldSelection?: boolean;
}

export interface BridgeEditOptionsResult {
  readonly schema: "morrow.bridge.edit-options.v1";
  readonly sourceBindingId: string;
  readonly provider: BridgeProvider;
  readonly catalogDigest: string;
  readonly policyRevision: number;
  readonly runtimeVerified: boolean;
  readonly options: readonly BridgeEditOption[];
  readonly editPermission?: BridgeEditPermission;
}

export interface BridgeEditPolicySelection {
  readonly sourceBindingId: string;
  readonly expectedPolicyRevision: number;
  readonly enabledCategories?: readonly string[];
}

export interface BridgeEditPolicySet {
  readonly mode: "edit" | "plan";
  readonly selections: readonly BridgeEditPolicySelection[];
}

/**
 * The desktop owner sends these only on the authenticated local bridge. They
 * contain no filesystem path, release asset, or user-controlled update URL.
 */
export type BridgeMaintenanceControl =
  | { readonly action: "status" }
  | { readonly action: "quiesce" }
  | { readonly action: "resume"; readonly quiesceEpoch: string; readonly fileLayerRestored: true }
  | { readonly action: "readback" };

export interface BridgePrivateFileManifest {
  readonly filename: string;
  readonly size_bytes: number;
  readonly sha256: string;
}

/**
 * Transient dispatch-only bytes for one exact Moodle resource-file write.
 * This field must never be placed in BridgeCommand.arguments.
 */
export interface BridgePrivateAttachment {
  readonly schema: "morrow.private-file-attachment.v1";
  readonly handle: string;
  readonly manifest: BridgePrivateFileManifest;
  /**
   * Present only for the exact private Canvas course-file transfer route.
   * Moodle Resource transfers intentionally omit it.
   */
  readonly content_type?: string;
  readonly bytes_base64: string;
}

/**
 * Browser-only Canvas Inbox data. It is never part of catalog arguments.
 * Recipient ids are already resolved under one current course binding before
 * this value crosses the local bridge.
 */
export interface BridgePrivateConversation {
  readonly schema: "morrow.canvas-conversation.private.v1";
  readonly action: "create" | "reply";
  readonly courseId: string;
  readonly recipients: readonly string[];
  readonly body: string;
  readonly subject?: string;
  readonly groupConversation?: boolean;
  readonly forceNew?: boolean;
  readonly conversationId?: string;
}

export interface BridgeBinding {
  readonly sourceBindingId: string;
  readonly provider: BridgeProvider;
  readonly courseId?: string;
  readonly courseName?: string;
  readonly origin?: string;
  readonly siteUrl?: string;
  readonly principalFingerprint?: string;
  readonly sessionGeneration?: number;
  readonly catalogDigest?: string;
  readonly editPolicyRevision?: number;
  /** Present when detailed options can be read for this one exact binding. */
  readonly editOptionsAvailable?: true;
  /** Compact binding proof. Full rules are read on demand for one binding. */
  readonly editPermission?: BridgeEditPermissionSummary;
  readonly runtimeVerified: boolean;
  readonly lastSeenAt?: number;
}

export interface BridgeHello {
  readonly schema: typeof BRIDGE_SCHEMAS.hello;
  readonly protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  readonly token: string;
  readonly extensionId: string;
  readonly runtimeRevision: string;
  readonly catalogDigest: string;
  readonly bindings: readonly BridgeBinding[];
  readonly sentAt: number;
}

export interface BridgeReady {
  readonly schema: typeof BRIDGE_SCHEMAS.ready;
  readonly protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  readonly generation: number;
  readonly acceptedExtensionId: string;
  readonly catalogDigest: string;
  readonly connectedAt: number;
}

export interface BridgeCommand {
  readonly schema: typeof BRIDGE_SCHEMAS.command;
  readonly protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly operationId: string;
  readonly kind: BridgeCommandKind;
  readonly toolName?: string;
  readonly operationKey?: string;
  readonly arguments?: JsonObject;
  readonly privateAttachment?: BridgePrivateAttachment;
  /** Transient dispatch-only bytes for the one reviewed multi-file Folder route. */
  readonly privateAttachments?: readonly BridgePrivateAttachment[];
  readonly privateConversation?: BridgePrivateConversation;
  readonly sourceBindingId?: string;
  readonly taskId?: string;
  readonly editPolicySet?: BridgeEditPolicySet;
  readonly maintenance?: BridgeMaintenanceControl;
  /** Gateway-owned evidence for a dispatched outer effect. */
  readonly outerGrant?: BridgeOuterGrant;
  readonly generation: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface BridgeOuterGrant {
  readonly planDigest: string;
  readonly approvalGrantDigest: string;
  readonly effectReceiptId: string;
  readonly dispatchAttempt: 1;
  readonly gatewayProcessId: string;
  readonly authorization?: BridgeOuterGrantAuthorization;
}

export type BridgeOuterGrantAuthorization =
  | { readonly kind: "review" }
  | { readonly kind: "edit_scope"; readonly policyDigest: string; readonly policyRevision: number };

export interface BridgeEditPermissionMatchInput {
  readonly provider: BridgeProvider;
  readonly catalogDigest: string;
  readonly operationKey: string;
  readonly toolName: string;
  readonly arguments: JsonObject;
}

export interface BridgeProblem {
  readonly schema: "morrow.bridge.problem.v1";
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
  readonly detailDigest?: string;
}

export interface BridgeResult {
  readonly schema: typeof BRIDGE_SCHEMAS.result;
  readonly protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly operationId: string;
  readonly generation: number;
  readonly ok: boolean;
  readonly result?: JsonObject;
  readonly problem?: BridgeProblem;
  readonly completedAt: number;
}

export interface BridgeBindingsMessage {
  readonly schema: typeof BRIDGE_SCHEMAS.bindings;
  readonly protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  readonly generation: number;
  readonly bindings: readonly BridgeBinding[];
  readonly sentAt: number;
}

export interface BridgePing {
  readonly schema: typeof BRIDGE_SCHEMAS.ping;
  readonly protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  readonly generation: number;
  readonly sentAt: number;
}

export interface BridgePong {
  readonly schema: typeof BRIDGE_SCHEMAS.pong;
  readonly protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  readonly generation: number;
  readonly sentAt: number;
}

export type BridgeClientMessage = BridgeHello | BridgeResult | BridgeBindingsMessage | BridgePong;
export type BridgeServerMessage = BridgeReady | BridgeCommand | BridgePing;

export interface MorrowBridgeCallOptions {
  readonly sourceBindingId?: string;
  readonly operationId?: string;
  readonly outerGrant?: BridgeOuterGrant;
  readonly canvasContentGuard?: JsonObject;
  /** Legacy Page-only routing control. */
  readonly pageGuard?: JsonObject;
  /** Bounded standard-list resume for one read. `nextPage` continues an earlier read. */
  readonly listResume?: { readonly nextPage?: string };
}

const IMAGE_ALT_PROPERTIES: JsonObject = {
  image_index: { type: "integer", minimum: 1, maximum: MAX_BRIDGE_MESSAGE_BYTES },
  image_start: { type: "integer", minimum: 0, maximum: MAX_BRIDGE_MESSAGE_BYTES },
  image_end: { type: "integer", minimum: 0, maximum: MAX_BRIDGE_MESSAGE_BYTES },
  image_tag_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
  image_src_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
  alt_text: { type: "string", maxLength: 500 },
  decorative: { type: "boolean" },
};

const IMAGE_ALT_REQUIRED = ["image_index", "image_start", "image_end", "image_tag_sha256", "image_src_sha256", "alt_text", "decorative"];

export const CANVAS_CONTENT_GUARD_SCHEMA: JsonObject = {
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { const: "page_text" },
        course_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        page_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        revision_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        body_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        find_text: { type: "string", minLength: 1, maxLength: 10000 },
        replace_text: { type: "string", maxLength: 10000 },
        fields: {
          type: "object",
          properties: { url: { type: "string" }, title: { type: "string" }, published: { type: "boolean" }, front_page: { type: "boolean" }, editing_roles: { type: "string" }, publish_at: { type: ["string", "null"] } },
          required: ["url", "title", "published", "front_page", "editing_roles", "publish_at"],
          additionalProperties: false,
        },
      },
      required: ["kind", "course_id", "page_id", "revision_id", "body_sha256", "find_text", "replace_text", "fields"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "page_image_alt" },
        course_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        page_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        revision_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        body_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        fields: {
          type: "object",
          properties: { url: { type: "string" }, title: { type: "string" }, published: { type: "boolean" }, front_page: { type: "boolean" }, editing_roles: { type: "string" }, publish_at: { type: ["string", "null"] } },
          required: ["url", "title", "published", "front_page", "editing_roles", "publish_at"],
          additionalProperties: false,
        },
        ...IMAGE_ALT_PROPERTIES,
      },
      required: ["kind", "course_id", "page_id", "revision_id", "body_sha256", "fields", ...IMAGE_ALT_REQUIRED],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "assignment_image_alt" },
        course_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        assignment_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        body_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        protected_state_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        ...IMAGE_ALT_PROPERTIES,
      },
      required: ["kind", "course_id", "assignment_id", "body_sha256", "protected_state_sha256", ...IMAGE_ALT_REQUIRED],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "discussion_image_alt" },
        course_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        topic_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        body_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        protected_state_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        ...IMAGE_ALT_PROPERTIES,
      },
      required: ["kind", "course_id", "topic_id", "body_sha256", "protected_state_sha256", ...IMAGE_ALT_REQUIRED],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "new_quiz_item_image_alt" },
        course_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        assignment_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        item_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        body_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        protected_state_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        ...IMAGE_ALT_PROPERTIES,
      },
      required: ["kind", "course_id", "assignment_id", "item_id", "body_sha256", "protected_state_sha256", ...IMAGE_ALT_REQUIRED],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "new_quiz_choice_image_alt" },
        course_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        assignment_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        item_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        choice_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$" },
        body_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        protected_state_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        ...IMAGE_ALT_PROPERTIES,
      },
      required: ["kind", "course_id", "assignment_id", "item_id", "choice_id", "body_sha256", "protected_state_sha256", ...IMAGE_ALT_REQUIRED],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "new_quiz_answer_feedback_image_alt" },
        course_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        assignment_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        item_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        choice_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$" },
        body_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        protected_state_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        ...IMAGE_ALT_PROPERTIES,
      },
      required: ["kind", "course_id", "assignment_id", "item_id", "choice_id", "body_sha256", "protected_state_sha256", ...IMAGE_ALT_REQUIRED],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "new_quiz_feedback_image_alt" },
        course_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        assignment_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        item_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        feedback_type: { enum: ["correct", "incorrect", "neutral"] },
        body_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        protected_state_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        ...IMAGE_ALT_PROPERTIES,
      },
      required: ["kind", "course_id", "assignment_id", "item_id", "feedback_type", "body_sha256", "protected_state_sha256", ...IMAGE_ALT_REQUIRED],
      additionalProperties: false,
    },
  ],
};

export const PAGE_GUARD_SCHEMA: JsonObject = {
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { const: "text" },
        page_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        revision_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        body_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        find_text: { type: "string", minLength: 1, maxLength: 10000 },
        replace_text: { type: "string", maxLength: 10000 },
        fields: {
          type: "object",
          properties: { url: { type: "string" }, title: { type: "string" }, published: { type: "boolean" }, front_page: { type: "boolean" }, editing_roles: { type: "string" }, publish_at: { type: ["string", "null"] } },
          required: ["url", "title", "published", "front_page", "editing_roles", "publish_at"],
          additionalProperties: false,
        },
      },
      required: ["kind", "page_id", "revision_id", "body_sha256", "find_text", "replace_text", "fields"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "image_alt" },
        page_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        revision_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
        body_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        fields: {
          type: "object",
          properties: { url: { type: "string" }, title: { type: "string" }, published: { type: "boolean" }, front_page: { type: "boolean" }, editing_roles: { type: "string" }, publish_at: { type: ["string", "null"] } },
          required: ["url", "title", "published", "front_page", "editing_roles", "publish_at"],
          additionalProperties: false,
        },
        ...IMAGE_ALT_PROPERTIES,
      },
      required: ["kind", "page_id", "revision_id", "body_sha256", "fields", ...IMAGE_ALT_REQUIRED],
      additionalProperties: false,
    },
  ],
};

const TOOL_OR_SOURCE = /^[A-Za-z0-9_.:@-]{1,160}$/;
const REQUEST_ID = /^[A-Za-z0-9_.:-]{8,160}$/;
const EXTENSION_ID = /^[a-p]{32}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const DECIMAL_ID = /^[1-9][0-9]{0,18}$/;
const EDIT_FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,159}$/;
const PRINTABLE_TEXT = /^[\x20-\x7e]+$/;
const PRIVATE_ATTACHMENT_HANDLE = /^file:[A-Za-z0-9_.:-]{1,160}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CANVAS_CONVERSATION_RECIPIENT = /^(?:[1-9][0-9]{0,18}|(?:course|section|group)_[1-9][0-9]{0,18}(?:_(?:students|teachers|tas|observers|designers))?)$/;
const STRUCTURAL_EDIT_FIELDS = new Set(["course_id", "url_or_id", "id", "topic_id", "module_id", "section_id", "target_section_id", "assignment_id", "item_id", "quiz_id", "expected_digest", "chapter_id", "after_chapter_id", "category_id", "grade_item_id", "slot_id", "section_number", "section_name", "bank_id", "bank_entry_id", "_morrow", "morrow_canvas_content_guard", "morrow_item_bank_guard", "morrow_page_guard"]);

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new TypeError(`${label} must contain 1 to ${maxLength} characters`);
  }
  return normalized;
}

function requiredInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new TypeError(`${label} must be a safe integer greater than or equal to ${minimum}`);
  }
  return Number(value);
}

function optionalString(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, label, maxLength);
}

function privateFilename(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 255 || value !== value.trim()
    || value === "." || value === ".." || /[\\/\u0000-\u001f]/.test(value)) {
    throw new TypeError("privateAttachment.manifest.filename is invalid");
  }
  return value;
}

function privateContentType(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim()
    || !/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(value)) {
    throw new TypeError("privateAttachment.content_type is invalid");
  }
  return value;
}

/** Validates the exact byte payload at a transport admission boundary. */
export function normalizeBridgePrivateAttachment(value: unknown): BridgePrivateAttachment {
  if (!isJsonObject(value) || Object.keys(value).some((key) => !["schema", "handle", "manifest", "content_type", "bytes_base64"].includes(key))) {
    throw new TypeError("privateAttachment has unsupported fields");
  }
  if (value.schema !== "morrow.private-file-attachment.v1") throw new TypeError("privateAttachment schema is invalid");
  const handle = requiredString(value.handle, "privateAttachment.handle", 200);
  if (value.handle !== handle || !PRIVATE_ATTACHMENT_HANDLE.test(handle)) throw new TypeError("privateAttachment.handle is invalid");
  if (!isJsonObject(value.manifest) || Object.keys(value.manifest).some((key) => !["filename", "size_bytes", "sha256"].includes(key))) {
    throw new TypeError("privateAttachment.manifest has unsupported fields");
  }
  const manifest = {
    filename: privateFilename(value.manifest.filename),
    size_bytes: requiredInteger(value.manifest.size_bytes, "privateAttachment.manifest.size_bytes", 1),
    sha256: requiredString(value.manifest.sha256, "privateAttachment.manifest.sha256", 64),
  };
  if (value.manifest.sha256 !== manifest.sha256 || manifest.size_bytes > MAX_BRIDGE_PRIVATE_FILE_BYTES || !HEX_SHA256.test(manifest.sha256)) {
    throw new TypeError("privateAttachment.manifest is invalid");
  }
  const bytesBase64 = typeof value.bytes_base64 === "string" ? value.bytes_base64 : "";
  if (bytesBase64.length < 4 || bytesBase64.length > MAX_BRIDGE_PRIVATE_FILE_BASE64_BYTES || !BASE64.test(bytesBase64)) {
    throw new TypeError("privateAttachment.bytes_base64 is invalid");
  }
  const bytes = Buffer.from(bytesBase64, "base64");
  if (bytes.byteLength !== manifest.size_bytes || bytes.byteLength < 1 || bytes.byteLength > MAX_BRIDGE_PRIVATE_FILE_BYTES
    || bytes.toString("base64") !== bytesBase64
    || createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) {
    throw new TypeError("privateAttachment bytes do not match the manifest");
  }
  return {
    schema: "morrow.private-file-attachment.v1",
    handle,
    manifest,
    ...(value.content_type === undefined ? {} : { content_type: privateContentType(value.content_type) }),
    bytes_base64: bytesBase64,
  };
}

/** Validates the bounded, ordered set used only for one Moodle Folder add. */
export function normalizeBridgePrivateAttachments(value: unknown): readonly BridgePrivateAttachment[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BRIDGE_PRIVATE_FILE_ATTACHMENTS) {
    throw new TypeError("privateAttachments is invalid");
  }
  const attachments = value.map(normalizeBridgePrivateAttachment);
  const totalBytes = attachments.reduce((total, attachment) => total + attachment.manifest.size_bytes, 0);
  if (totalBytes > MAX_BRIDGE_PRIVATE_FILE_BYTES
    || new Set(attachments.map((attachment) => attachment.manifest.filename)).size !== attachments.length
    || new Set(attachments.map((attachment) => attachment.handle)).size !== attachments.length) {
    throw new TypeError("privateAttachments is invalid");
  }
  return attachments;
}

function privateConversationId(value: unknown, label: string): string {
  const normalized = typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : typeof value === "string" ? value : "";
  if (!DECIMAL_ID.test(normalized)) throw new TypeError(`${label} is invalid`);
  return normalized;
}

function privateConversationRecipients(value: unknown, required: boolean): readonly string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.length > MAX_BRIDGE_PRIVATE_CONVERSATION_RECIPIENTS || (required && value.length === 0)) {
    throw new TypeError("privateConversation.recipients is invalid");
  }
  const recipients = value.map((entry) => {
    if (typeof entry !== "string" || !CANVAS_CONVERSATION_RECIPIENT.test(entry)) {
      throw new TypeError("privateConversation.recipients is invalid");
    }
    return entry;
  });
  if (new Set(recipients).size !== recipients.length) throw new TypeError("privateConversation.recipients must be unique");
  return recipients;
}

/** Validates the exact resolved Canvas Inbox payload at a bridge boundary. */
export function normalizeBridgePrivateConversation(value: unknown): BridgePrivateConversation {
  if (!isJsonObject(value) || value.schema !== "morrow.canvas-conversation.private.v1") {
    throw new TypeError("privateConversation has an invalid schema");
  }
  const action = value.action;
  if (action !== "create" && action !== "reply") throw new TypeError("privateConversation.action is invalid");
  const allowed = action === "create"
    ? ["schema", "action", "courseId", "recipients", "subject", "body", "groupConversation", "forceNew"]
    : ["schema", "action", "courseId", "conversationId", "recipients", "body"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new TypeError("privateConversation has unsupported fields");
  const courseId = privateConversationId(value.courseId, "privateConversation.courseId");
  const body = requiredString(value.body, "privateConversation.body", MAX_BRIDGE_MESSAGE_BYTES);
  if (action === "create") {
    if (value.subject !== undefined && (typeof value.subject !== "string" || value.subject.length > 255)) {
      throw new TypeError("privateConversation.subject is invalid");
    }
    if (value.groupConversation !== undefined && typeof value.groupConversation !== "boolean") {
      throw new TypeError("privateConversation.groupConversation is invalid");
    }
    if (value.forceNew !== undefined && typeof value.forceNew !== "boolean") {
      throw new TypeError("privateConversation.forceNew is invalid");
    }
    return {
      schema: "morrow.canvas-conversation.private.v1",
      action,
      courseId,
      recipients: privateConversationRecipients(value.recipients, true),
      body,
      ...(value.subject === undefined ? {} : { subject: value.subject }),
      ...(value.groupConversation === undefined ? {} : { groupConversation: value.groupConversation }),
      ...(value.forceNew === undefined ? {} : { forceNew: value.forceNew }),
    };
  }
  return {
    schema: "morrow.canvas-conversation.private.v1",
    action,
    courseId,
    conversationId: privateConversationId(value.conversationId, "privateConversation.conversationId"),
    recipients: privateConversationRecipients(value.recipients, false),
    body,
  };
}

export function normalizeBridgeMaintenanceControl(value: unknown): BridgeMaintenanceControl {
  if (!isJsonObject(value) || typeof value.action !== "string") {
    throw new TypeError("bridge maintenance control is invalid");
  }
  if (value.action === "status" || value.action === "quiesce" || value.action === "readback") {
    if (Object.keys(value).length !== 1) throw new TypeError("bridge maintenance control has unsupported fields");
    return { action: value.action };
  }
  if (value.action !== "resume" || Object.keys(value).length !== 3 || value.fileLayerRestored !== true) {
    throw new TypeError("bridge maintenance control is invalid");
  }
  const quiesceEpoch = requiredString(value.quiesceEpoch, "bridge maintenance quiesceEpoch", 256);
  if (!/^[A-Za-z0-9._-]{16,256}$/.test(quiesceEpoch)) {
    throw new TypeError("bridge maintenance quiesceEpoch is invalid");
  }
  return { action: "resume", quiesceEpoch, fileLayerRestored: true };
}

function parseOuterAuthorization(value: unknown): BridgeOuterGrantAuthorization {
  if (!isJsonObject(value)) throw new TypeError("_morrow.outer_grant.authorization must be an object");
  if (value.kind === "review") {
    if (Object.keys(value).some((key) => key !== "kind")) throw new TypeError("_morrow.outer_grant.authorization has unsupported fields");
    return { kind: "review" };
  }
  if (value.kind === "edit_scope") {
    if (Object.keys(value).some((key) => !["kind", "policy_digest", "policy_revision"].includes(key))) {
      throw new TypeError("_morrow.outer_grant.authorization has unsupported fields");
    }
    const policyDigest = requiredString(value.policy_digest, "_morrow.outer_grant.authorization.policy_digest", 64);
    if (!HEX_SHA256.test(policyDigest)) throw new TypeError("_morrow.outer_grant.authorization.policy_digest must be a SHA-256 digest");
    return {
      kind: "edit_scope",
      policyDigest,
      policyRevision: requiredInteger(value.policy_revision, "_morrow.outer_grant.authorization.policy_revision", 1),
    };
  }
  throw new TypeError("_morrow.outer_grant.authorization.kind is invalid");
}

function parseOuterGrant(value: unknown): BridgeOuterGrant {
  if (!isJsonObject(value)) throw new TypeError("_morrow.outer_grant must be an object");
  if (Object.keys(value).some((key) => !["plan_digest", "approval_grant_digest", "effect_receipt_id", "dispatch_attempt", "gateway_process_id", "authorization"].includes(key))) {
    throw new TypeError("_morrow.outer_grant has unsupported fields");
  }
  const planDigest = requiredString(value.plan_digest, "_morrow.outer_grant.plan_digest", 64);
  const approvalGrantDigest = requiredString(value.approval_grant_digest, "_morrow.outer_grant.approval_grant_digest", 64);
  const effectReceiptId = requiredString(value.effect_receipt_id, "_morrow.outer_grant.effect_receipt_id", 160);
  const gatewayProcessId = requiredString(value.gateway_process_id, "_morrow.outer_grant.gateway_process_id", 160);
  if (!HEX_SHA256.test(planDigest) || !HEX_SHA256.test(approvalGrantDigest)) {
    throw new TypeError("_morrow.outer_grant digests must be SHA-256 values");
  }
  if (!TOOL_OR_SOURCE.test(effectReceiptId) || !TOOL_OR_SOURCE.test(gatewayProcessId)) {
    throw new TypeError("_morrow.outer_grant receipt and gateway id have invalid formats");
  }
  if (value.dispatch_attempt !== 1) throw new TypeError("_morrow.outer_grant.dispatch_attempt must be 1");
  const authorization = value.authorization === undefined ? undefined : parseOuterAuthorization(value.authorization);
  return { planDigest, approvalGrantDigest, effectReceiptId, dispatchAttempt: 1, gatewayProcessId, ...(authorization ? { authorization } : {}) };
}

function parseEditPermissionRule(value: unknown, index: number): BridgeEditPermissionRule {
  const label = `editPermission.rules[${index}]`;
  if (!isJsonObject(value) || Object.keys(value).some((key) => !["operationKey", "toolName", "allowedChangedFields", "requiresPageGuard", "pageGuardKind", "requiresCanvasContentGuard", "canvasContentGuardKind"].includes(key))) {
    throw new TypeError(`${label} has unsupported fields`);
  }
  const operationKey = requiredString(value.operationKey, `${label}.operationKey`, 500);
  const toolName = requiredString(value.toolName, `${label}.toolName`, 160);
  if (!PRINTABLE_TEXT.test(operationKey) || !TOOL_OR_SOURCE.test(toolName)) {
    throw new TypeError(`${label} operation or tool identity is invalid`);
  }
  if (!Array.isArray(value.allowedChangedFields) || value.allowedChangedFields.length > MAX_BRIDGE_EDIT_FIELDS) {
    throw new TypeError(`${label}.allowedChangedFields exceeds the bridge limit`);
  }
  const allowedChangedFields = value.allowedChangedFields.map((field, fieldIndex) => {
    const name = requiredString(field, `${label}.allowedChangedFields[${fieldIndex}]`, 160);
    if (!EDIT_FIELD.test(name) || STRUCTURAL_EDIT_FIELDS.has(name)) {
      throw new TypeError(`${label}.allowedChangedFields contains an invalid field`);
    }
    return name;
  });
  if (new Set(allowedChangedFields).size !== allowedChangedFields.length
    || allowedChangedFields.some((field, fieldIndex) => fieldIndex > 0 && allowedChangedFields[fieldIndex - 1]! >= field)) {
    throw new TypeError(`${label}.allowedChangedFields must be sorted and unique`);
  }
  if (value.requiresPageGuard !== undefined && typeof value.requiresPageGuard !== "boolean") {
    throw new TypeError(`${label}.requiresPageGuard must be boolean`);
  }
  if (value.pageGuardKind !== undefined && value.pageGuardKind !== "text" && value.pageGuardKind !== "image_alt") {
    throw new TypeError(`${label}.pageGuardKind is invalid`);
  }
  if (value.pageGuardKind !== undefined && value.requiresPageGuard !== true) {
    throw new TypeError(`${label}.pageGuardKind requires a Page guard`);
  }
  if (value.requiresCanvasContentGuard !== undefined && typeof value.requiresCanvasContentGuard !== "boolean") {
    throw new TypeError(`${label}.requiresCanvasContentGuard must be boolean`);
  }
  if (value.canvasContentGuardKind !== undefined && !["page_text", "page_image_alt", "assignment_image_alt", "discussion_image_alt", "classic_quiz_description_image_alt", "classic_quiz_question_image_alt", "new_quiz_item_image_alt", "new_quiz_choice_image_alt", "new_quiz_answer_feedback_image_alt", "new_quiz_feedback_image_alt"].includes(String(value.canvasContentGuardKind))) {
    throw new TypeError(`${label}.canvasContentGuardKind is invalid`);
  }
  if (value.canvasContentGuardKind !== undefined && value.requiresCanvasContentGuard !== true) {
    throw new TypeError(`${label}.canvasContentGuardKind requires a Canvas content guard`);
  }
  if ((value.requiresPageGuard !== undefined || value.pageGuardKind !== undefined)
    && (value.requiresCanvasContentGuard !== undefined || value.canvasContentGuardKind !== undefined)) {
    throw new TypeError(`${label} cannot mix Page and Canvas content guards`);
  }
  return {
    operationKey,
    toolName,
    allowedChangedFields,
    ...(value.requiresPageGuard === undefined ? {} : { requiresPageGuard: value.requiresPageGuard }),
    ...(value.pageGuardKind === undefined ? {} : { pageGuardKind: value.pageGuardKind as BridgeEditPermissionRule["pageGuardKind"] }),
    ...(value.requiresCanvasContentGuard === undefined ? {} : { requiresCanvasContentGuard: value.requiresCanvasContentGuard }),
    ...(value.canvasContentGuardKind === undefined ? {} : { canvasContentGuardKind: value.canvasContentGuardKind as BridgeEditPermissionRule["canvasContentGuardKind"] }),
  };
}

function parseEditPermission(value: unknown, sourceBindingId: string): BridgeEditPermission {
  if (!isJsonObject(value) || Object.keys(value).some((key) => !["schema", "revision", "scopeDigest", "catalogDigest", "sourceBindingId", "expiresAt", "enabledCategories", "rules"].includes(key))) {
    throw new TypeError("editPermission has unsupported fields");
  }
  if (value.schema !== "morrow.bridge.edit-permission.v1") throw new TypeError("editPermission schema is invalid");
  const scopeDigest = requiredString(value.scopeDigest, "editPermission.scopeDigest", 64);
  const catalogDigest = requiredString(value.catalogDigest, "editPermission.catalogDigest", 64);
  const policyBindingId = requiredString(value.sourceBindingId, "editPermission.sourceBindingId", 160);
  if (!HEX_SHA256.test(scopeDigest) || !HEX_SHA256.test(catalogDigest) || !TOOL_OR_SOURCE.test(policyBindingId) || policyBindingId !== sourceBindingId) {
    throw new TypeError("editPermission binding or digest is invalid");
  }
  if (!Array.isArray(value.enabledCategories) || value.enabledCategories.length > MAX_BRIDGE_EDIT_CATEGORIES) {
    throw new TypeError("editPermission.enabledCategories exceeds the bridge limit");
  }
  const enabledCategories = value.enabledCategories.map((category, index) => {
    const name = requiredString(category, `editPermission.enabledCategories[${index}]`, 160);
    if (!TOOL_OR_SOURCE.test(name)) throw new TypeError("editPermission.enabledCategories contains an invalid category");
    return name;
  });
  if (new Set(enabledCategories).size !== enabledCategories.length) throw new TypeError("editPermission.enabledCategories must be unique");
  if (!Array.isArray(value.rules) || value.rules.length > MAX_BRIDGE_EDIT_RULES) {
    throw new TypeError("editPermission.rules exceeds the bridge limit");
  }
  const rules = value.rules.map((rule, index) => parseEditPermissionRule(rule, index));
  if (new Set(rules.map((rule) => `${rule.operationKey}\u0000${rule.toolName}\u0000${rule.pageGuardKind || rule.canvasContentGuardKind || ""}`)).size !== rules.length) {
    throw new TypeError("editPermission.rules must have unique operation and tool identities");
  }
  const expiresAt = value.expiresAt === undefined
    ? undefined
    : requiredInteger(value.expiresAt, "editPermission.expiresAt", 1);
  return {
    schema: "morrow.bridge.edit-permission.v1",
    revision: requiredInteger(value.revision, "editPermission.revision", 1),
    scopeDigest,
    catalogDigest,
    sourceBindingId: policyBindingId,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    enabledCategories,
    rules,
  };
}

function parseEditPermissionSummary(value: unknown, sourceBindingId: string): BridgeEditPermissionSummary {
  if (!isJsonObject(value) || Object.keys(value).some((key) => !["schema", "revision", "scopeDigest", "catalogDigest", "sourceBindingId", "expiresAt"].includes(key))) {
    throw new TypeError("editPermission summary has unsupported fields");
  }
  if (value.schema !== "morrow.bridge.edit-permission.v1") throw new TypeError("editPermission summary schema is invalid");
  const scopeDigest = requiredString(value.scopeDigest, "editPermission.scopeDigest", 64);
  const catalogDigest = requiredString(value.catalogDigest, "editPermission.catalogDigest", 64);
  const policyBindingId = requiredString(value.sourceBindingId, "editPermission.sourceBindingId", 160);
  if (!HEX_SHA256.test(scopeDigest) || !HEX_SHA256.test(catalogDigest) || !TOOL_OR_SOURCE.test(policyBindingId) || policyBindingId !== sourceBindingId) {
    throw new TypeError("editPermission summary binding or digest is invalid");
  }
  const expiresAt = value.expiresAt === undefined ? undefined : requiredInteger(value.expiresAt, "editPermission.expiresAt", 1);
  return {
    schema: "morrow.bridge.edit-permission.v1",
    revision: requiredInteger(value.revision, "editPermission.revision", 1),
    scopeDigest,
    catalogDigest,
    sourceBindingId: policyBindingId,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function parseEditOption(value: unknown, index: number): BridgeEditOption {
  const label = `editOptions[${index}]`;
  if (!isJsonObject(value) || Object.keys(value).some((key) => !["id", "group", "label", "description", "availability", "reviewReason", "tier", "destructive", "verification", "verificationReason", "requiresFieldSelection"].includes(key))) {
    throw new TypeError(`${label} has unsupported fields`);
  }
  const id = requiredString(value.id, `${label}.id`, 160);
  const availability = value.availability;
  if (!TOOL_OR_SOURCE.test(id) || (availability !== "edit" && availability !== "review")) throw new TypeError(`${label} id or availability is invalid`);
  const reviewReason = value.reviewReason === undefined ? undefined : requiredString(value.reviewReason, `${label}.reviewReason`, 1_000);
  if ((availability === "review") !== Boolean(reviewReason)) throw new TypeError(`${label} review availability requires one reason`);
  const tier = value.tier;
  if (tier !== undefined && tier !== "standard" && tier !== "destructive") throw new TypeError(`${label}.tier is invalid`);
  const destructive = value.destructive;
  if (destructive !== undefined && typeof destructive !== "boolean") throw new TypeError(`${label}.destructive is invalid`);
  const verification = value.verification;
  if (verification !== undefined && verification !== "checked" && verification !== "unchecked") throw new TypeError(`${label}.verification is invalid`);
  const verificationReason = value.verificationReason === undefined ? undefined : requiredString(value.verificationReason, `${label}.verificationReason`, 1_000);
  if ((verification === "unchecked") !== Boolean(verificationReason)) throw new TypeError(`${label} unchecked verification requires one reason`);
  if (value.requiresFieldSelection !== undefined && value.requiresFieldSelection !== true) throw new TypeError(`${label}.requiresFieldSelection is invalid`);
  return {
    id,
    group: requiredString(value.group, `${label}.group`, 300),
    label: requiredString(value.label, `${label}.label`, 300),
    description: requiredString(value.description, `${label}.description`, 1_000),
    availability,
    ...(reviewReason ? { reviewReason } : {}),
    ...(tier === undefined ? {} : { tier }),
    ...(destructive === undefined ? {} : { destructive }),
    ...(verification === undefined ? {} : { verification }),
    ...(verificationReason ? { verificationReason } : {}),
    ...(value.requiresFieldSelection === true ? { requiresFieldSelection: true } : {}),
  };
}

export function normalizeBridgeEditOptionsResult(value: unknown, expectedSourceBindingId?: string): BridgeEditOptionsResult {
  if (!isJsonObject(value) || Object.keys(value).some((key) => !["schema", "sourceBindingId", "provider", "catalogDigest", "policyRevision", "runtimeVerified", "options", "editPermission"].includes(key))) {
    throw new TypeError("edit options result has unsupported fields");
  }
  if (value.schema !== "morrow.bridge.edit-options.v1") throw new TypeError("edit options result schema is invalid");
  const sourceBindingId = requiredString(value.sourceBindingId, "edit options sourceBindingId", 160);
  if (!TOOL_OR_SOURCE.test(sourceBindingId) || (expectedSourceBindingId && sourceBindingId !== expectedSourceBindingId)) throw new TypeError("edit options result binding is invalid");
  const provider = value.provider;
  if (provider !== "canvas" && provider !== "moodle" && provider !== "blackboard") throw new TypeError("edit options provider is invalid");
  const catalogDigest = requiredString(value.catalogDigest, "edit options catalogDigest", 64);
  if (!HEX_SHA256.test(catalogDigest)) throw new TypeError("edit options catalog digest is invalid");
  if (!Array.isArray(value.options) || value.options.length > MAX_BRIDGE_EDIT_OPTIONS) throw new TypeError("edit options exceed the bridge limit");
  const options = value.options.map(parseEditOption);
  if (new Set(options.map((option) => option.id)).size !== options.length) throw new TypeError("edit options must have unique ids");
  if (typeof value.runtimeVerified !== "boolean") throw new TypeError("edit options runtime verification is invalid");
  return {
    schema: "morrow.bridge.edit-options.v1",
    sourceBindingId,
    provider,
    catalogDigest,
    policyRevision: requiredInteger(value.policyRevision, "edit options policyRevision"),
    runtimeVerified: value.runtimeVerified,
    options,
    ...(value.editPermission === undefined ? {} : { editPermission: parseEditPermission(value.editPermission, sourceBindingId) }),
  };
}

function parseEditCategories(value: unknown): readonly BridgeEditCategory[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_BRIDGE_EDIT_CATEGORIES) {
    throw new TypeError("editCategories exceeds the bridge limit");
  }
  const categories = value.map((entry, index) => {
    const label = `editCategories[${index}]`;
    if (!isJsonObject(entry) || Object.keys(entry).some((key) => !["id", "label", "description"].includes(key))) {
      throw new TypeError(`${label} has unsupported fields`);
    }
    const id = requiredString(entry.id, `${label}.id`, 160);
    if (!TOOL_OR_SOURCE.test(id)) throw new TypeError(`${label}.id is invalid`);
    return {
      id,
      label: requiredString(entry.label, `${label}.label`, 300),
      description: requiredString(entry.description, `${label}.description`, 1_000),
    };
  });
  if (new Set(categories.map((category) => category.id)).size !== categories.length) {
    throw new TypeError("editCategories must have unique ids");
  }
  return categories;
}

export function normalizeBridgeEditPolicySet(value: unknown): BridgeEditPolicySet {
  if (!isJsonObject(value) || Object.keys(value).some((key) => !["mode", "selections"].includes(key))) {
    throw new TypeError("editPolicySet has unsupported fields");
  }
  const mode = value.mode;
  if (mode !== "edit" && mode !== "plan") throw new TypeError("editPolicySet.mode is invalid");
  if (!Array.isArray(value.selections) || value.selections.length === 0 || value.selections.length > MAX_BRIDGE_BINDINGS) {
    throw new TypeError("editPolicySet.selections exceeds the bridge limit");
  }
  const selections = value.selections.map((entry, index) => {
    const label = `editPolicySet.selections[${index}]`;
    if (!isJsonObject(entry) || Object.keys(entry).some((key) => !["sourceBindingId", "expectedPolicyRevision", "enabledCategories"].includes(key))) {
      throw new TypeError(`${label} has unsupported fields`);
    }
    const sourceBindingId = requiredString(entry.sourceBindingId, `${label}.sourceBindingId`, 160);
    if (!TOOL_OR_SOURCE.test(sourceBindingId)) throw new TypeError(`${label}.sourceBindingId is invalid`);
    const expectedPolicyRevision = requiredInteger(entry.expectedPolicyRevision, `${label}.expectedPolicyRevision`);
    if (mode === "plan") {
      if (entry.enabledCategories !== undefined) throw new TypeError(`${label}.enabledCategories is invalid for Plan`);
      return { sourceBindingId, expectedPolicyRevision };
    }
    if (!Array.isArray(entry.enabledCategories) || entry.enabledCategories.length === 0 || entry.enabledCategories.length > MAX_BRIDGE_EDIT_CATEGORIES) {
      throw new TypeError(`${label}.enabledCategories exceeds the bridge limit`);
    }
    const enabledCategories = entry.enabledCategories.map((category, categoryIndex) => {
      const id = requiredString(category, `${label}.enabledCategories[${categoryIndex}]`, 160);
      if (!TOOL_OR_SOURCE.test(id)) throw new TypeError(`${label}.enabledCategories contains an invalid id`);
      return id;
    });
    if (new Set(enabledCategories).size !== enabledCategories.length
      || enabledCategories.some((id, categoryIndex) => categoryIndex > 0 && enabledCategories[categoryIndex - 1]! >= id)) {
      throw new TypeError(`${label}.enabledCategories must be sorted and unique`);
    }
    return { sourceBindingId, expectedPolicyRevision, enabledCategories };
  });
  if (new Set(selections.map((selection) => selection.sourceBindingId)).size !== selections.length
    || selections.some((selection, index) => index > 0 && selections[index - 1]!.sourceBindingId >= selection.sourceBindingId)) {
    throw new TypeError("editPolicySet.selections must be sorted and unique");
  }
  return { mode, selections };
}

function parseBinding(value: unknown): BridgeBinding {
  if (!isJsonObject(value)) throw new TypeError("bridge binding must be an object");
  const sourceBindingId = requiredString(value.sourceBindingId, "sourceBindingId", 160);
  if (!TOOL_OR_SOURCE.test(sourceBindingId)) {
    throw new TypeError("sourceBindingId has an invalid format");
  }
  const provider = value.provider;
  if (provider !== "canvas" && provider !== "moodle" && provider !== "blackboard") {
    throw new TypeError("bridge binding provider is invalid");
  }
  const courseId = optionalString(value.courseId, "courseId", 24);
  if (provider === "canvas" && courseId && !DECIMAL_ID.test(courseId)) {
    throw new TypeError("Canvas courseId must be an exact positive decimal string");
  }
  if (provider === "moodle" && (!courseId || !DECIMAL_ID.test(courseId))) {
    throw new TypeError("Moodle courseId must be an exact positive decimal string");
  }
  if (provider === "blackboard" && courseId && !/^_[0-9]+_[0-9]+$/.test(courseId)) {
    throw new TypeError("Blackboard courseId must be an exact _digits_digits string");
  }
  const origin = optionalString(value.origin, "origin", 500);
  if (origin) {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" || parsed.origin !== origin) {
      throw new TypeError("origin must be one canonical HTTPS origin");
    }
  }
  const siteUrl = optionalString(value.siteUrl, "siteUrl", 500);
  if (siteUrl) {
    let parsed: URL;
    try {
      parsed = new URL(siteUrl);
    } catch {
      throw new TypeError("siteUrl must be one canonical HTTPS URL");
    }
    if (parsed.protocol !== "https:" || parsed.href !== siteUrl || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new TypeError("siteUrl must be one canonical HTTPS URL");
    }
  }
  if (provider === "moodle") {
    if (!origin || !siteUrl) throw new TypeError("Moodle binding requires origin and siteUrl");
    if (new URL(siteUrl).origin !== origin) throw new TypeError("Moodle siteUrl must match binding origin");
  }
  const principalFingerprint = optionalString(value.principalFingerprint, "principalFingerprint", 64);
  if (principalFingerprint && !HEX_SHA256.test(principalFingerprint)) {
    throw new TypeError("principalFingerprint must be a SHA-256 digest");
  }
  const sessionGeneration = value.sessionGeneration === undefined
    ? undefined
    : requiredInteger(value.sessionGeneration, "sessionGeneration", 1);
  const catalogDigest = optionalString(value.catalogDigest, "catalogDigest", 64);
  if (catalogDigest && !HEX_SHA256.test(catalogDigest)) {
    throw new TypeError("catalogDigest must be a SHA-256 digest");
  }
  const editPolicyRevision = value.editPolicyRevision === undefined
    ? undefined
    : requiredInteger(value.editPolicyRevision, "editPolicyRevision");
  const editOptionsAvailable = value.editOptionsAvailable === undefined
    ? undefined
    : value.editOptionsAvailable === true ? true : (() => { throw new TypeError("editOptionsAvailable must be true"); })();
  const editCategories = parseEditCategories(value.editCategories);
  const editPermission = value.editPermission === undefined ? undefined : parseEditPermissionSummary(value.editPermission, sourceBindingId);
  if (typeof value.runtimeVerified !== "boolean") {
    throw new TypeError("runtimeVerified must be boolean");
  }
  const lastSeenAt = value.lastSeenAt === undefined
    ? undefined
    : requiredInteger(value.lastSeenAt, "lastSeenAt");
  return {
    sourceBindingId,
    provider,
    ...(courseId ? { courseId } : {}),
    ...(typeof value.courseName === "string" && value.courseName.trim()
      ? { courseName: value.courseName.trim().slice(0, 300) }
      : {}),
    ...(origin ? { origin } : {}),
    ...(siteUrl ? { siteUrl } : {}),
    ...(principalFingerprint ? { principalFingerprint } : {}),
    ...(sessionGeneration !== undefined ? { sessionGeneration } : {}),
    ...(catalogDigest ? { catalogDigest } : {}),
    ...(editPolicyRevision !== undefined ? { editPolicyRevision } : {}),
    ...(editOptionsAvailable ? { editOptionsAvailable } : {}),
    ...(editCategories ? { editCategories } : {}),
    ...(editPermission ? { editPermission } : {}),
    runtimeVerified: value.runtimeVerified,
    ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
  };
}

export function normalizeBridgeBindings(value: unknown): readonly BridgeBinding[] {
  if (!Array.isArray(value)) throw new TypeError("bindings must be an array");
  if (value.length > MAX_BRIDGE_BINDINGS) throw new TypeError("bindings exceed the bridge limit");
  const byId = new Map<string, BridgeBinding>();
  for (const entry of value) {
    const binding = parseBinding(entry);
    if (byId.has(binding.sourceBindingId)) {
      throw new TypeError(`duplicate sourceBindingId ${binding.sourceBindingId}`);
    }
    byId.set(binding.sourceBindingId, binding);
  }
  return [...byId.values()].sort((left, right) => (
    left.sourceBindingId < right.sourceBindingId ? -1 : left.sourceBindingId > right.sourceBindingId ? 1 : 0
  ));
}

function validPageFields(fields: unknown): fields is JsonObject {
  return isJsonObject(fields)
    && !Object.keys(fields).some((key) => !["url", "title", "published", "front_page", "editing_roles", "publish_at"].includes(key))
    && typeof fields.url === "string" && typeof fields.title === "string"
    && typeof fields.published === "boolean" && typeof fields.front_page === "boolean"
    && typeof fields.editing_roles === "string" && (typeof fields.publish_at === "string" || fields.publish_at === null);
}

function validLegacyPageGuard(value: unknown): value is JsonObject {
  if (!isJsonObject(value) || typeof value.page_id !== "string" || !DECIMAL_ID.test(value.page_id)
    || typeof value.revision_id !== "string" || !DECIMAL_ID.test(value.revision_id)
    || typeof value.body_sha256 !== "string" || !HEX_SHA256.test(value.body_sha256)
    || !validPageFields(value.fields)) return false;
  if (value.kind === "text") {
    return !Object.keys(value).some((key) => !["kind", "page_id", "revision_id", "body_sha256", "fields", "find_text", "replace_text"].includes(key))
      && typeof value.find_text === "string" && Boolean(value.find_text) && value.find_text.length <= 10000
      && typeof value.replace_text === "string" && value.replace_text.length <= 10000;
  }
  return value.kind === "image_alt"
    && typeof value.image_index === "number" && Number.isSafeInteger(value.image_index) && value.image_index >= 1 && value.image_index <= MAX_BRIDGE_MESSAGE_BYTES
    && typeof value.image_start === "number" && Number.isSafeInteger(value.image_start) && value.image_start >= 0 && value.image_start <= MAX_BRIDGE_MESSAGE_BYTES
    && typeof value.image_end === "number" && Number.isSafeInteger(value.image_end) && value.image_end >= value.image_start && value.image_end <= MAX_BRIDGE_MESSAGE_BYTES
    && typeof value.image_tag_sha256 === "string" && HEX_SHA256.test(value.image_tag_sha256)
    && typeof value.image_src_sha256 === "string" && HEX_SHA256.test(value.image_src_sha256)
    && typeof value.alt_text === "string" && value.alt_text.length <= 500
    && typeof value.decorative === "boolean" && (value.decorative ? value.alt_text === "" : value.alt_text.trim().length > 0)
    && !Object.keys(value).some((key) => !["kind", "page_id", "revision_id", "body_sha256", "fields", ...IMAGE_ALT_REQUIRED].includes(key));
}

function validCanvasContentGuard(value: unknown): value is JsonObject {
  const validFields = (fields: unknown): fields is JsonObject => isJsonObject(fields)
    && !Object.keys(fields).some((key) => !["url", "title", "published", "front_page", "editing_roles", "publish_at"].includes(key))
    && typeof fields.url === "string" && typeof fields.title === "string"
    && typeof fields.published === "boolean" && typeof fields.front_page === "boolean"
    && typeof fields.editing_roles === "string" && (typeof fields.publish_at === "string" || fields.publish_at === null);
  const validImageAlt = (guard: JsonObject, keys: readonly string[]): boolean => (
    !Object.keys(guard).some((key) => !keys.includes(key))
    && typeof guard.image_index === "number" && Number.isSafeInteger(guard.image_index) && guard.image_index >= 1 && guard.image_index <= MAX_BRIDGE_MESSAGE_BYTES
    && typeof guard.image_start === "number" && Number.isSafeInteger(guard.image_start) && guard.image_start >= 0 && guard.image_start <= MAX_BRIDGE_MESSAGE_BYTES
    && typeof guard.image_end === "number" && Number.isSafeInteger(guard.image_end) && guard.image_end >= guard.image_start && guard.image_end <= MAX_BRIDGE_MESSAGE_BYTES
    && typeof guard.image_tag_sha256 === "string" && HEX_SHA256.test(guard.image_tag_sha256)
    && typeof guard.image_src_sha256 === "string" && HEX_SHA256.test(guard.image_src_sha256)
    && typeof guard.alt_text === "string" && guard.alt_text.length <= 500
    && typeof guard.decorative === "boolean" && (guard.decorative ? guard.alt_text === "" : guard.alt_text.trim().length > 0)
  );
  if (!isJsonObject(value) || typeof value.kind !== "string"
    || typeof value.course_id !== "string" || !DECIMAL_ID.test(value.course_id)
    || typeof value.body_sha256 !== "string" || !HEX_SHA256.test(value.body_sha256)) return false;
  if (value.kind === "page_text") {
    return typeof value.page_id === "string" && DECIMAL_ID.test(value.page_id)
      && typeof value.revision_id === "string" && DECIMAL_ID.test(value.revision_id) && validFields(value.fields)
      && !Object.keys(value).some((key) => !["kind", "course_id", "page_id", "revision_id", "body_sha256", "fields", "find_text", "replace_text"].includes(key))
      && typeof value.find_text === "string" && Boolean(value.find_text) && value.find_text.length <= 10000
      && typeof value.replace_text === "string" && value.replace_text.length <= 10000;
  }
  if (value.kind === "page_image_alt") {
    return typeof value.page_id === "string" && DECIMAL_ID.test(value.page_id)
      && typeof value.revision_id === "string" && DECIMAL_ID.test(value.revision_id) && validFields(value.fields)
      && validImageAlt(value, ["kind", "course_id", "page_id", "revision_id", "body_sha256", "fields", ...IMAGE_ALT_REQUIRED]);
  }
  const itemIdFields = value.kind === "assignment_image_alt" ? ["assignment_id"]
    : value.kind === "discussion_image_alt" ? ["topic_id"]
      : value.kind === "classic_quiz_description_image_alt" ? ["quiz_id"]
      : value.kind === "classic_quiz_question_image_alt" ? ["quiz_id", "question_id"]
      : ["new_quiz_item_image_alt", "new_quiz_choice_image_alt", "new_quiz_answer_feedback_image_alt", "new_quiz_feedback_image_alt"].includes(value.kind) ? ["assignment_id", "item_id"] : null;
  const selectorFields = value.kind === "new_quiz_choice_image_alt" || value.kind === "new_quiz_answer_feedback_image_alt" ? ["choice_id"]
    : value.kind === "new_quiz_feedback_image_alt" ? ["feedback_type"]
      : value.kind === "classic_quiz_question_image_alt" ? ["answer_id", "answer_field"] : [];
  // A Classic Quiz question repair names one answer or none: the image is in the
  // question text, or in exactly one answer field of one identified answer.
  const classicQuizAnswerSelected = Object.hasOwn(value, "answer_id") || Object.hasOwn(value, "answer_field");
  const selectorIsValid = value.kind === "new_quiz_choice_image_alt" || value.kind === "new_quiz_answer_feedback_image_alt"
    ? typeof value.choice_id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value.choice_id)
    : value.kind === "new_quiz_feedback_image_alt"
      ? typeof value.feedback_type === "string" && ["correct", "incorrect", "neutral"].includes(value.feedback_type)
      : value.kind === "classic_quiz_question_image_alt"
        ? !classicQuizAnswerSelected || (typeof value.answer_id === "string" && DECIMAL_ID.test(value.answer_id)
          && typeof value.answer_field === "string" && ["answer_text", "answer_html"].includes(value.answer_field))
        : true;
  return itemIdFields !== null && itemIdFields.every((field) => typeof value[field] === "string" && DECIMAL_ID.test(value[field]))
    && selectorIsValid && typeof value.protected_state_sha256 === "string" && HEX_SHA256.test(value.protected_state_sha256)
    && validImageAlt(value, ["kind", "course_id", ...itemIdFields, ...selectorFields, "body_sha256", "protected_state_sha256", ...IMAGE_ALT_REQUIRED]);
}

export function matchesBridgeEditPermission(
  binding: Omit<BridgeBinding, "editPermission"> & { readonly editPermission?: BridgeEditPermission },
  input: BridgeEditPermissionMatchInput,
): boolean {
  if (Object.hasOwn(input.arguments, "morrow_new_quiz_settings_guard")) return false;
  const permission = binding.editPermission;
  if (!permission || binding.runtimeVerified !== true || binding.provider !== input.provider
    || permission.sourceBindingId !== binding.sourceBindingId || permission.catalogDigest !== input.catalogDigest
    || (permission.expiresAt !== undefined && permission.expiresAt <= Date.now())) return false;
  const canvasContentGuard = isJsonObject(input.arguments.morrow_canvas_content_guard) ? input.arguments.morrow_canvas_content_guard : null;
  const pageGuard = isJsonObject(input.arguments.morrow_page_guard) ? input.arguments.morrow_page_guard : null;
  if (canvasContentGuard && pageGuard) return false;
  const canvasContentGuardKind = canvasContentGuard?.kind;
  const pageGuardKind = pageGuard?.kind;
  const legacyPageKind = canvasContentGuardKind === "page_text" ? "text"
    : canvasContentGuardKind === "page_image_alt" ? "image_alt" : undefined;
  const canonicalPageKind = pageGuardKind === "text" ? "page_text"
    : pageGuardKind === "image_alt" ? "page_image_alt" : undefined;
  const matchingRules = permission.rules.filter((rule) => rule.operationKey === input.operationKey && rule.toolName === input.toolName
    && (canvasContentGuard
      ? (rule.canvasContentGuardKind || undefined) === canvasContentGuardKind || (legacyPageKind !== undefined && (rule.pageGuardKind || undefined) === legacyPageKind)
      : pageGuard
        ? (rule.pageGuardKind || undefined) === pageGuardKind || (canonicalPageKind !== undefined && (rule.canvasContentGuardKind || undefined) === canonicalPageKind)
        : !rule.canvasContentGuardKind && !rule.pageGuardKind));
  if (matchingRules.length !== 1) return false;
  const rule = matchingRules[0]!;
  const canvasContentGuardPresent = Object.hasOwn(input.arguments, "morrow_canvas_content_guard");
  const pageGuardPresent = Object.hasOwn(input.arguments, "morrow_page_guard");
  const compatibleLegacyPageGuard = canvasContentGuard !== null && legacyPageKind !== undefined
    && rule.requiresPageGuard === true && rule.pageGuardKind === legacyPageKind;
  const compatibleCanvasPageGuard = pageGuard !== null && canonicalPageKind !== undefined
    && rule.requiresCanvasContentGuard === true && rule.canvasContentGuardKind === canonicalPageKind;
  if (rule.requiresCanvasContentGuard === true
    ? !(validCanvasContentGuard(canvasContentGuard) || (compatibleCanvasPageGuard && validLegacyPageGuard(pageGuard)))
    : canvasContentGuardPresent && !compatibleLegacyPageGuard) return false;
  if (rule.requiresPageGuard === true
    ? !(validLegacyPageGuard(pageGuard) || (compatibleLegacyPageGuard && validCanvasContentGuard(canvasContentGuard)))
    : pageGuardPresent && !compatibleCanvasPageGuard) return false;
  const changedFields = Object.keys(input.arguments).filter((field) => !STRUCTURAL_EDIT_FIELDS.has(field));
  if (changedFields.some((field) => !EDIT_FIELD.test(field))) return false;
  if (rule.allowedChangedFields.length > 0 && changedFields.length === 0) return false;
  return changedFields.every((field) => rule.allowedChangedFields.includes(field));
}

function parseProblem(value: unknown): BridgeProblem {
  if (!isJsonObject(value) || value.schema !== "morrow.bridge.problem.v1") {
    throw new TypeError("bridge problem has an invalid schema");
  }
  if (typeof value.recoverable !== "boolean") throw new TypeError("problem.recoverable must be boolean");
  const detailDigest = optionalString(value.detailDigest, "problem.detailDigest", 64);
  if (detailDigest && !HEX_SHA256.test(detailDigest)) {
    throw new TypeError("problem.detailDigest must be a SHA-256 digest");
  }
  return {
    schema: "morrow.bridge.problem.v1",
    code: requiredString(value.code, "problem.code", 120),
    message: requiredString(value.message, "problem.message", 1000),
    recoverable: value.recoverable,
    ...(detailDigest ? { detailDigest } : {}),
  };
}

export function parseBridgeHello(value: unknown): BridgeHello {
  if (!isJsonObject(value) || value.schema !== BRIDGE_SCHEMAS.hello) {
    throw new TypeError("bridge hello has an invalid schema");
  }
  if (value.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    throw new TypeError("bridge protocol version is unsupported");
  }
  const token = requiredString(value.token, "token", MAX_BRIDGE_TOKEN_LENGTH);
  if (token.length < MIN_BRIDGE_TOKEN_LENGTH) throw new TypeError("bridge token is too short");
  const extensionId = requiredString(value.extensionId, "extensionId", 32);
  if (!EXTENSION_ID.test(extensionId)) throw new TypeError("extensionId is invalid");
  const catalogDigest = requiredString(value.catalogDigest, "catalogDigest", 64);
  if (!HEX_SHA256.test(catalogDigest)) throw new TypeError("catalogDigest must be a SHA-256 digest");
  return {
    schema: BRIDGE_SCHEMAS.hello,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    token,
    extensionId,
    runtimeRevision: requiredString(value.runtimeRevision, "runtimeRevision", 160),
    catalogDigest,
    bindings: normalizeBridgeBindings(value.bindings),
    sentAt: requiredInteger(value.sentAt, "sentAt"),
  };
}

export function parseBridgeResult(value: unknown): BridgeResult {
  if (!isJsonObject(value) || value.schema !== BRIDGE_SCHEMAS.result) {
    throw new TypeError("bridge result has an invalid schema");
  }
  if (value.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    throw new TypeError("bridge protocol version is unsupported");
  }
  const requestId = requiredString(value.requestId, "requestId", 160);
  const operationId = requiredString(value.operationId, "operationId", 160);
  if (!REQUEST_ID.test(requestId) || !REQUEST_ID.test(operationId)) {
    throw new TypeError("bridge request or operation id has an invalid format");
  }
  if (typeof value.ok !== "boolean") throw new TypeError("bridge result ok must be boolean");
  const result = value.result === undefined ? undefined : value.result;
  if (result !== undefined && !isJsonObject(result)) throw new TypeError("bridge result payload must be an object");
  const problem = value.problem === undefined ? undefined : parseProblem(value.problem);
  if (value.ok && !result) throw new TypeError("successful bridge result requires result");
  if (!value.ok && !problem) throw new TypeError("failed bridge result requires problem");
  return {
    schema: BRIDGE_SCHEMAS.result,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    requestId,
    operationId,
    generation: requiredInteger(value.generation, "generation", 1),
    ok: value.ok,
    ...(result ? { result: structuredClone(result) } : {}),
    ...(problem ? { problem } : {}),
    completedAt: requiredInteger(value.completedAt, "completedAt"),
  };
}

export function parseBridgeClientMessage(value: unknown): BridgeClientMessage {
  if (!isJsonObject(value)) throw new TypeError("bridge client message must be an object");
  if (value.schema === BRIDGE_SCHEMAS.hello) return parseBridgeHello(value);
  if (value.schema === BRIDGE_SCHEMAS.result) return parseBridgeResult(value);
  if (value.schema === BRIDGE_SCHEMAS.bindings) {
    if (value.protocolVersion !== BRIDGE_PROTOCOL_VERSION) throw new TypeError("bridge protocol version is unsupported");
    return {
      schema: BRIDGE_SCHEMAS.bindings,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      generation: requiredInteger(value.generation, "generation", 1),
      bindings: normalizeBridgeBindings(value.bindings),
      sentAt: requiredInteger(value.sentAt, "sentAt"),
    };
  }
  if (value.schema === BRIDGE_SCHEMAS.pong) {
    if (value.protocolVersion !== BRIDGE_PROTOCOL_VERSION) throw new TypeError("bridge protocol version is unsupported");
    return {
      schema: BRIDGE_SCHEMAS.pong,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      generation: requiredInteger(value.generation, "generation", 1),
      sentAt: requiredInteger(value.sentAt, "sentAt"),
    };
  }
  throw new TypeError("unsupported bridge client message schema");
}

export function serializeBridgeMessage(value: BridgeClientMessage | BridgeServerMessage): string {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > MAX_BRIDGE_MESSAGE_BYTES) {
    throw new RangeError("bridge message exceeds the maximum size");
  }
  return text;
}

export function parseBridgeJson(text: string): unknown {
  if (Buffer.byteLength(text, "utf8") > MAX_BRIDGE_MESSAGE_BYTES) {
    throw new RangeError("bridge message exceeds the maximum size");
  }
  return JSON.parse(text) as unknown;
}

export function augmentBridgeInputSchema(
  inputSchema: JsonObject,
  includeCanvasContentGuard = false,
  includePrivateAttachment = false,
  includeLegacyPageGuard = false,
  includePrivateAttachments = false,
): JsonObject {
  const schema = structuredClone(normalizeInputSchema(inputSchema));
  const properties = isJsonObject(schema.properties) ? schema.properties : {};
  return {
    ...schema,
    type: "object",
    properties: {
      ...properties,
      ...(includePrivateAttachment ? {
        privateAttachment: {
          type: "object",
          description: "Internal transient Morrow file transport. This never reaches Moodle as a form argument.",
          properties: {
            schema: { const: "morrow.private-file-attachment.v1" },
            handle: { type: "string", pattern: "^file:[A-Za-z0-9_.:-]{1,160}$" },
            manifest: {
              type: "object",
              properties: {
                filename: { type: "string", minLength: 1, maxLength: 255 },
                size_bytes: { type: "integer", minimum: 1, maximum: MAX_BRIDGE_PRIVATE_FILE_BYTES },
                sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
              },
              required: ["filename", "size_bytes", "sha256"],
              additionalProperties: false,
            },
            content_type: { type: "string", pattern: "^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$" },
            bytes_base64: { type: "string", minLength: 4, maxLength: MAX_BRIDGE_PRIVATE_FILE_BASE64_BYTES },
          },
          required: ["schema", "handle", "manifest", "bytes_base64"],
          additionalProperties: false,
        },
      } : {}),
      ...(includePrivateAttachments ? {
        privateAttachments: {
          type: "array",
          description: "Internal transient Morrow file transport. This never reaches Moodle as a form argument.",
          minItems: 1,
          maxItems: MAX_BRIDGE_PRIVATE_FILE_ATTACHMENTS,
          items: {
            type: "object",
            properties: {
              schema: { const: "morrow.private-file-attachment.v1" },
              handle: { type: "string", pattern: "^file:[A-Za-z0-9_.:-]{1,160}$" },
              manifest: {
                type: "object",
                properties: {
                  filename: { type: "string", minLength: 1, maxLength: 255 },
                  size_bytes: { type: "integer", minimum: 1, maximum: MAX_BRIDGE_PRIVATE_FILE_BYTES },
                  sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
                },
                required: ["filename", "size_bytes", "sha256"],
                additionalProperties: false,
              },
              bytes_base64: { type: "string", minLength: 4, maxLength: MAX_BRIDGE_PRIVATE_FILE_BASE64_BYTES },
            },
            required: ["schema", "handle", "manifest", "bytes_base64"],
            additionalProperties: false,
          },
        },
      } : {}),
      _morrow: {
        type: "object",
        description: "Optional local Morrow routing controls. These never reach Canvas.",
        properties: {
          source_binding_id: {
            type: "string",
            minLength: 1,
            maxLength: 160,
            description: "Exact live Morrow source binding when more than one Canvas course is open.",
          },
          operation_id: {
            type: "string",
            minLength: 8,
            maxLength: 160,
            description: "Optional stable caller identity for this requested operation.",
          },
          list_resume: {
            type: "object",
            description: "Bounded standard-list resume for one read. Morrow returns an opaque next-page token when a read is capped and continues the same list when that token is sent back. The token names one origin and one path and cannot widen the read.",
            properties: {
              next_page: { type: "string", minLength: 8, maxLength: 4096, pattern: "^[A-Za-z0-9_-]+$" },
            },
            additionalProperties: false,
          },
          ...(includeCanvasContentGuard ? { canvas_content_guard: CANVAS_CONTENT_GUARD_SCHEMA } : {}),
          ...(includeLegacyPageGuard ? { page_guard: PAGE_GUARD_SCHEMA } : {}),
          outer_grant: {
            type: "object",
            description: "Gateway-owned dispatch grant. Callers cannot create this grant.",
            properties: {
              plan_digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
              approval_grant_digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
              effect_receipt_id: { type: "string", minLength: 8, maxLength: 160 },
              dispatch_attempt: { type: "integer", const: 1 },
              gateway_process_id: { type: "string", minLength: 8, maxLength: 160 },
              authorization: {
                oneOf: [
                  {
                    type: "object",
                    properties: { kind: { const: "review" } },
                    required: ["kind"],
                    additionalProperties: false,
                  },
                  {
                    type: "object",
                    properties: {
                      kind: { const: "edit_scope" },
                      policy_digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
                      policy_revision: { type: "integer", minimum: 1 },
                    },
                    required: ["kind", "policy_digest", "policy_revision"],
                    additionalProperties: false,
                  },
                ],
              },
            },
            required: ["plan_digest", "approval_grant_digest", "effect_receipt_id", "dispatch_attempt", "gateway_process_id"],
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
  };
}

/**
 * A resume control carries either nothing, which asks for a next-page token, or
 * one opaque token from an earlier read of the same list. The browser page is
 * the only place the token is decoded, and it accepts a token only for the exact
 * origin and path of the request it is sent with.
 */
function parseListResume(value: unknown): { readonly nextPage?: string } | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value) || Object.keys(value).some((key) => key !== "next_page")) {
    throw new TypeError("_morrow.list_resume accepts only next_page");
  }
  if (value.next_page === undefined) return {};
  const nextPage = requiredString(value.next_page, "_morrow.list_resume.next_page", 4096);
  if (nextPage.length < 8 || !/^[A-Za-z0-9_-]+$/.test(nextPage)) {
    throw new TypeError("_morrow.list_resume.next_page has an invalid format");
  }
  return { nextPage };
}

export function splitBridgeCallArguments(value: Readonly<Record<string, unknown>>): {
  readonly arguments: JsonObject;
  readonly options: MorrowBridgeCallOptions;
} {
  const input = { ...value };
  const rawOptions = input._morrow;
  delete input._morrow;
  if (rawOptions === undefined || rawOptions === null) {
    return { arguments: input as JsonObject, options: {} };
  }
  if (!isJsonObject(rawOptions)) throw new TypeError("_morrow must be an object");
  const unknown = Object.keys(rawOptions).find((key) => !["source_binding_id", "operation_id", "outer_grant", "canvas_content_guard", "page_guard", "list_resume"].includes(key));
  if (unknown) throw new TypeError(`unsupported _morrow field ${unknown}`);
  const sourceBindingId = optionalString(rawOptions.source_binding_id, "_morrow.source_binding_id", 160);
  const operationId = optionalString(rawOptions.operation_id, "_morrow.operation_id", 160);
  const outerGrant = rawOptions.outer_grant === undefined ? undefined : parseOuterGrant(rawOptions.outer_grant);
  const canvasContentGuard = rawOptions.canvas_content_guard;
  const pageGuard = rawOptions.page_guard;
  const listResume = parseListResume(rawOptions.list_resume);
  if (canvasContentGuard !== undefined && pageGuard !== undefined) {
    throw new TypeError("Use either a Canvas content guard or a legacy Page guard, not both.");
  }
  if (canvasContentGuard !== undefined && !validCanvasContentGuard(canvasContentGuard)) {
    throw new TypeError("The Canvas content repair needs complete current source evidence.");
  }
  if (pageGuard !== undefined && !validLegacyPageGuard(pageGuard)) {
    throw new TypeError("The Page correction needs a complete source page and revision.");
  }
  if (sourceBindingId && !TOOL_OR_SOURCE.test(sourceBindingId)) {
    throw new TypeError("_morrow.source_binding_id has an invalid format");
  }
  if (operationId && !REQUEST_ID.test(operationId)) {
    throw new TypeError("_morrow.operation_id has an invalid format");
  }
  return {
    arguments: input as JsonObject,
    options: {
      ...(sourceBindingId ? { sourceBindingId } : {}),
      ...(operationId ? { operationId } : {}),
      ...(outerGrant ? { outerGrant } : {}),
      ...(validCanvasContentGuard(canvasContentGuard) ? { canvasContentGuard: structuredClone(canvasContentGuard) } : {}),
      ...(validLegacyPageGuard(pageGuard) ? { pageGuard: structuredClone(pageGuard) } : {}),
      ...(listResume ? { listResume } : {}),
    },
  };
}

export function createBridgeProblem(
  code: string,
  message: string,
  recoverable: boolean,
  detail?: unknown,
): BridgeProblem {
  return {
    schema: "morrow.bridge.problem.v1",
    code: requiredString(code, "problem code", 120),
    message: requiredString(message, "problem message", 1000),
    recoverable,
    ...(detail === undefined ? {} : { detailDigest: sha256Json(detail) }),
  };
}

export function normalizeBridgeToolName(value: unknown): string {
  return normalizeToolName(value);
}

export function normalizeBridgeSourceId(value: unknown): string {
  return normalizeSourceId(value);
}
