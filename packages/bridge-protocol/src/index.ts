import {
  isJsonObject,
  normalizeInputSchema,
  normalizeSourceId,
  normalizeToolName,
  sha256Json,
  type JsonObject,
} from "@morrow/contracts";

export const BRIDGE_PROTOCOL_VERSION = 1 as const;
export const BRIDGE_PATH = "/morrow-bridge/v1" as const;
export const MAX_BRIDGE_MESSAGE_BYTES = 2 * 1024 * 1024;
export const MIN_BRIDGE_TOKEN_LENGTH = 32;
export const MAX_BRIDGE_TOKEN_LENGTH = 512;
export const MAX_BRIDGE_BINDINGS = 500;

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
  | "bindings_get";

export interface BridgeBinding {
  readonly sourceBindingId: string;
  readonly provider: "canvas";
  readonly courseId?: string;
  readonly courseName?: string;
  readonly origin?: string;
  readonly principalFingerprint?: string;
  readonly sessionGeneration?: number;
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
  readonly sourceBindingId?: string;
  readonly taskId?: string;
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
  readonly pageGuard?: JsonObject;
}

export const PAGE_GUARD_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    page_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
    revision_id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" },
    body_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    find_text: { type: "string", minLength: 1, maxLength: 10000 },
    replace_text: { type: "string", maxLength: 10000 },
    fields: {
      type: "object",
      properties: { url: { type: "string" }, title: { type: "string" }, published: { type: "boolean" }, front_page: { type: "boolean" }, editing_roles: { type: "string" } },
      required: ["url", "title", "published", "front_page", "editing_roles"],
      additionalProperties: false,
    },
  },
  required: ["page_id", "revision_id", "body_sha256", "find_text", "replace_text", "fields"],
  additionalProperties: false,
};

const TOOL_OR_SOURCE = /^[A-Za-z0-9_.:@-]{1,160}$/;
const REQUEST_ID = /^[A-Za-z0-9_.:-]{8,160}$/;
const EXTENSION_ID = /^[a-p]{32}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const DECIMAL_ID = /^[1-9][0-9]{0,18}$/;

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

function parseOuterGrant(value: unknown): BridgeOuterGrant {
  if (!isJsonObject(value)) throw new TypeError("_morrow.outer_grant must be an object");
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
  return { planDigest, approvalGrantDigest, effectReceiptId, dispatchAttempt: 1, gatewayProcessId };
}

function parseBinding(value: unknown): BridgeBinding {
  if (!isJsonObject(value)) throw new TypeError("bridge binding must be an object");
  const sourceBindingId = requiredString(value.sourceBindingId, "sourceBindingId", 160);
  if (!TOOL_OR_SOURCE.test(sourceBindingId)) {
    throw new TypeError("sourceBindingId has an invalid format");
  }
  if (value.provider !== "canvas") throw new TypeError("bridge binding provider must be canvas");
  const courseId = optionalString(value.courseId, "courseId", 24);
  if (courseId && !DECIMAL_ID.test(courseId)) throw new TypeError("courseId must be an exact positive decimal string");
  const origin = optionalString(value.origin, "origin", 500);
  if (origin) {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" || parsed.origin !== origin) {
      throw new TypeError("origin must be one canonical HTTPS origin");
    }
  }
  const principalFingerprint = optionalString(value.principalFingerprint, "principalFingerprint", 64);
  if (principalFingerprint && !HEX_SHA256.test(principalFingerprint)) {
    throw new TypeError("principalFingerprint must be a SHA-256 digest");
  }
  const sessionGeneration = value.sessionGeneration === undefined
    ? undefined
    : requiredInteger(value.sessionGeneration, "sessionGeneration", 1);
  if (typeof value.runtimeVerified !== "boolean") {
    throw new TypeError("runtimeVerified must be boolean");
  }
  const lastSeenAt = value.lastSeenAt === undefined
    ? undefined
    : requiredInteger(value.lastSeenAt, "lastSeenAt");
  return {
    sourceBindingId,
    provider: "canvas",
    ...(courseId ? { courseId } : {}),
    ...(typeof value.courseName === "string" && value.courseName.trim()
      ? { courseName: value.courseName.trim().slice(0, 300) }
      : {}),
    ...(origin ? { origin } : {}),
    ...(principalFingerprint ? { principalFingerprint } : {}),
    ...(sessionGeneration !== undefined ? { sessionGeneration } : {}),
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

export function augmentBridgeInputSchema(inputSchema: JsonObject, includePageGuard = false): JsonObject {
  const schema = structuredClone(normalizeInputSchema(inputSchema));
  const properties = isJsonObject(schema.properties) ? schema.properties : {};
  return {
    ...schema,
    type: "object",
    properties: {
      ...properties,
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
          ...(includePageGuard ? { page_guard: PAGE_GUARD_SCHEMA } : {}),
          outer_grant: {
            type: "object",
            description: "Gateway-owned dispatch grant. Callers cannot create this grant.",
            properties: {
              plan_digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
              approval_grant_digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
              effect_receipt_id: { type: "string", minLength: 8, maxLength: 160 },
              dispatch_attempt: { type: "integer", const: 1 },
              gateway_process_id: { type: "string", minLength: 8, maxLength: 160 },
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
  const unknown = Object.keys(rawOptions).find((key) => !["source_binding_id", "operation_id", "outer_grant", "page_guard"].includes(key));
  if (unknown) throw new TypeError(`unsupported _morrow field ${unknown}`);
  const sourceBindingId = optionalString(rawOptions.source_binding_id, "_morrow.source_binding_id", 160);
  const operationId = optionalString(rawOptions.operation_id, "_morrow.operation_id", 160);
  const outerGrant = rawOptions.outer_grant === undefined ? undefined : parseOuterGrant(rawOptions.outer_grant);
  const pageGuard = rawOptions.page_guard;
  if (pageGuard !== undefined && (!isJsonObject(pageGuard)
    || Object.keys(pageGuard).some((key) => !["page_id", "revision_id", "body_sha256", "fields", "find_text", "replace_text"].includes(key))
    || typeof pageGuard.page_id !== "string" || !DECIMAL_ID.test(pageGuard.page_id)
    || typeof pageGuard.revision_id !== "string" || !DECIMAL_ID.test(pageGuard.revision_id)
    || typeof pageGuard.body_sha256 !== "string" || !HEX_SHA256.test(pageGuard.body_sha256)
    || typeof pageGuard.find_text !== "string" || !pageGuard.find_text || pageGuard.find_text.length > 10000
    || typeof pageGuard.replace_text !== "string" || pageGuard.replace_text.length > 10000
    || !isJsonObject(pageGuard.fields)
    || Object.keys(pageGuard.fields).some((key) => !["url", "title", "published", "front_page", "editing_roles"].includes(key))
    || typeof pageGuard.fields.url !== "string" || typeof pageGuard.fields.title !== "string"
    || typeof pageGuard.fields.published !== "boolean" || typeof pageGuard.fields.front_page !== "boolean" || typeof pageGuard.fields.editing_roles !== "string")) {
    throw new TypeError("The page correction needs a complete source page and revision.");
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
      ...(isJsonObject(pageGuard) ? { pageGuard: structuredClone(pageGuard) } : {}),
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
