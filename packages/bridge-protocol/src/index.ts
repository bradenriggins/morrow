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
  | "stage_write"
  | "task_get"
  | "bindings_get";

export interface BridgeBinding {
  readonly sourceBindingId: string;
  readonly provider: "canvas";
  readonly courseId?: string;
  readonly courseName?: string;
  readonly origin?: string;
  readonly runtimeVerified: boolean;
  readonly lastSeenAt?: number;
}

export interface BridgeHello {
  readonly schema: typeof BRIDGE_SCHEMAS.hello;
  readonly protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  readonly token: string;
  readonly extensionId: string;
  readonly donorRevision: string;
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
  readonly arguments?: JsonObject;
  readonly sourceBindingId?: string;
  readonly taskId?: string;
  readonly generation: number;
  readonly createdAt: number;
  readonly expiresAt: number;
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
}

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
    throw new TypeError