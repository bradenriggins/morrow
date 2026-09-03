import { createHash } from "node:crypto";

export type JsonObject = Record<string, unknown>;
export type JsonSchema = JsonObject;

export interface ToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface UpstreamTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly annotations?: ToolAnnotations;
}

export interface CatalogSource {
  readonly id: string;
  readonly label: string;
  readonly priority: number;
  readonly tools: readonly UpstreamTool[];
}

export interface CatalogTool {
  readonly publicName: string;
  readonly upstreamId: string;
  readonly upstreamLabel: string;
  readonly upstreamName: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly annotations?: ToolAnnotations;
}

export interface CatalogCollision {
  readonly requestedName: string;
  readonly retainedBy: string;
  readonly aliasedSource: string;
  readonly aliasedTo: string;
}

export interface ExcludedCatalogTool {
  readonly upstreamId: string;
  readonly upstreamName: string;
  readonly reason: "excluded_name" | "excluded_prefix";
}

export interface CatalogSnapshot {
  readonly schema: "morrow.catalog.v1";
  readonly digest: string;
  readonly generatedAt: string;
  readonly tools: readonly CatalogTool[];
  readonly collisions: readonly CatalogCollision[];
  readonly excluded: readonly ExcludedCatalogTool[];
  readonly countsBySource: Readonly<Record<string, number>>;
}

export interface GatewaySourceHealth {
  readonly id: string;
  readonly label: string;
  readonly required: boolean;
  readonly connected: boolean;
  readonly toolCount: number;
  readonly errorDigest?: string;
}

export interface GatewayHealth {
  readonly schema: "morrow.health.v1";
  readonly version: string;
  readonly ready: boolean;
  readonly profile: string;
  readonly catalogDigest: string;
  readonly publicToolCount: number;
  readonly collisionCount: number;
  readonly excludedToolCount: number;
  readonly sources: readonly GatewaySourceHealth[];
}

export interface GatewayCallMeta {
  readonly schema: "morrow.gateway.call.v1";
  readonly publicToolName: string;
  readonly upstreamId: string;
  readonly upstreamToolName: string;
  readonly catalogDigest: string;
  readonly upstreamResultSha256: string;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value: unknown, path: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} contains a non-finite number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalize(entry, `${path}[${index}]`));
  }
  if (isJsonObject(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} contains a non-plain object`);
    }
    const output: JsonObject = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry === undefined) {
        throw new TypeError(`${path}.${key} is undefined`);
      }
      output[key] = canonicalize(entry, `${path}.${key}`);
    }
    return output;
  }
  throw new TypeError(`${path} contains a non-JSON value`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, "$"));
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256Json(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

export function normalizeToolName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || !/^[A-Za-z0-9_.-]{1,128}$/.test(name)) {
    throw new TypeError(`Invalid MCP tool name: ${String(value)}`);
  }
  return name;
}

export function normalizeSourceId(value: unknown): string {
  const sourceId = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!sourceId || !/^(?:[a-z0-9]|[a-z0-9][a-z0-9_-]{0,62}[a-z0-9])$/.test(sourceId)) {
    throw new TypeError(`Invalid source id: ${String(value)}`);
  }
  return sourceId;
}

export function normalizeInputSchema(value: unknown): JsonSchema {
  if (!isJsonObject(value)) {
    return { type: "object", properties: {}, additionalProperties: true };
  }
  const schema = structuredClone(value);
  if (schema.type === undefined) {
    schema.type = "object";
  }
  return schema;
}

export function normalizeAnnotations(value: unknown): ToolAnnotations | undefined {
  if (!isJsonObject(value)) return undefined;
  const annotations: ToolAnnotations = {
    ...(typeof value.readOnlyHint === "boolean" ? { readOnlyHint: value.readOnlyHint } : {}),
    ...(typeof value.destructiveHint === "boolean" ? { destructiveHint: value.destructiveHint } : {}),
    ...(typeof value.idempotentHint === "boolean" ? { idempotentHint: value.idempotentHint } : {}),
    ...(typeof value.openWorldHint === "boolean" ? { openWorldHint: value.openWorldHint } : {}),
  };
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}
