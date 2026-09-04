import { createHash } from "node:crypto";

export type JsonObject = Record<string, unknown>;
export type JsonSchema = JsonObject;

export const RUNTIME_PROFILES = [
  "private-full",
  "public-canvas",
  "sandbox",
  "read-only",
] as const;

export type RuntimeProfile = (typeof RUNTIME_PROFILES)[number];
export type CapabilityProfileState =
  | "supported"
  | "profile_limited"
  | "rights_hold"
  | "private_only"
  | "broken_at_baseline";

export interface CapabilityFieldEvidence {
  readonly state: "known" | "unknown" | "blocked";
  readonly reason?: string;
}

export interface SourceCapabilityMetadata {
  readonly family?: string;
  readonly provider?: "canvas" | "local" | "mindtap" | "connect";
  readonly sourcePath?: string;
  readonly sourceExport?: string;
  readonly sourceDigest?: string;
  readonly behavior?: Partial<MorrowCapabilityDescriptorV1["behavior"]>;
  readonly authority?: Partial<MorrowCapabilityDescriptorV1["authority"]>;
  readonly route?: Partial<MorrowCapabilityDescriptorV1["route"]>;
  readonly profiles?: Partial<Record<RuntimeProfile, CapabilityProfileAvailability>>;
  readonly evidence?: Readonly<Record<string, CapabilityFieldEvidence>>;
}

export interface CapabilityProfileAvailability {
  readonly state: CapabilityProfileState;
  readonly reason?: string;
}

export interface MorrowCapabilityDescriptorV1 {
  readonly schema: "morrow.capability.v1";
  readonly canonicalName: string;
  readonly aliases: readonly string[];
  readonly family: string;
  readonly provider: "canvas" | "local";
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly sourceImplementations: readonly {
    readonly system: "morrow" | "meridian";
    readonly toolName: string;
    readonly revision: string;
    readonly sourcePath: string;
    readonly sourceExport: string;
    readonly sourceDigest: string;
    readonly schemaDigest: string;
  }[];
  readonly behavior: {
    readonly readOnly: boolean;
    readonly mutating: boolean;
    readonly destructive: boolean;
    readonly irreversible: boolean;
    readonly supportsDryRun: boolean;
    readonly supportsReadback: boolean;
    readonly supportsUndo: boolean;
    readonly supportsBatch: boolean;
    readonly requiresBrowser: boolean;
    readonly requiresLiveCanvas: boolean;
  };
  readonly authority: {
    readonly scopeClass: string;
    readonly approvalClass: "none" | "standard" | "destructive" | "learner" | "grade" | "blueprint";
    readonly dataClass: string;
  };
  readonly route: {
    readonly backend: "meridian" | "morrow-node" | "morrow-extension" | "composite";
    readonly planBackend?: string;
    readonly dispatchBackend?: string;
    readonly readbackBackend?: string;
    readonly comparator?: string;
  };
  readonly profiles: Readonly<Record<RuntimeProfile, CapabilityProfileAvailability>>;
  readonly catalogDigest: string;
  readonly evidence: Readonly<Record<string, CapabilityFieldEvidence>>;
}

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
  readonly capability?: SourceCapabilityMetadata;
}

export interface CatalogSource {
  readonly id: string;
  readonly label: string;
  readonly priority: number;
  readonly tools: readonly UpstreamTool[];
  readonly revision?: string;
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
  readonly aliases?: readonly string[];
  readonly capability?: MorrowCapabilityDescriptorV1;
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
  readonly reason: "excluded_name" | "excluded_prefix" | "held_provider" | "profile_unavailable" | "publication_policy";
  readonly detail?: string;
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

export interface SourceAttestationHealth {
  readonly schema: "morrow.source-attestation.v1";
  readonly kind: "local-git";
  readonly verified: true;
  readonly sourceId: string;
  readonly repository?: string;
  readonly expectedRevision: string;
  readonly actualRevision: string;
  readonly trackedClean: boolean;
  readonly trackedChangeCount: number;
  readonly requireTrackedClean: boolean;
  readonly allowedTrackedPathsDigest?: string;
  readonly trackedPatchDigest?: string;
  readonly expectedTrackedPatchDigest?: string;
  readonly rootDigest: string;
  readonly verifiedAt: string;
  readonly expectedToolCount?: number;
  readonly expectedCatalogDigest?: string;
}

export interface GatewaySourceHealth {
  readonly id: string;
  readonly label: string;
  readonly required: boolean;
  readonly connected: boolean;
  readonly toolCount: number;
  readonly catalogDigest?: string;
  readonly expectedToolCount?: number;
  readonly expectedCatalogDigest?: string;
  readonly catalogAttested?: boolean;
  readonly sourceAttestation?: SourceAttestationHealth;
  readonly errorDigest?: string;
}

export interface GatewayOperationJournalHealth {
  readonly schema: "morrow.gateway-operation-journal.health.v1";
  readonly path: string;
  readonly open: boolean;
  readonly totalOperations: number;
  readonly unresolvedOperations: number;
  readonly unknownOperations: number;
}

export interface PublicationPolicyHealth {
  readonly schema: "morrow.publication-policy.health.v1";
  readonly applied: true;
  readonly profile: "public-canvas";
  readonly manifestDigest: string;
  readonly sourceCount: number;
  readonly allowedToolCount: number;
  readonly omittedToolCount: number;
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
  readonly operationJournal: GatewayOperationJournalHealth;
  readonly publicationPolicy?: PublicationPolicyHealth;
}

export interface GatewayCallMeta {
  readonly schema: "morrow.gateway.call.v1";
  readonly publicToolName: string;
  readonly upstreamId: string;
  readonly upstreamToolName: string;
  readonly catalogDigest: string;
  readonly upstreamResultSha256: string;
  readonly gatewayOperationId?: string;
  readonly gatewayOperationState?: string;
  readonly sourceOperationId?: string;
  readonly sourceResultState?: string;
  readonly sourceTaskId?: string;
  readonly profile?: RuntimeProfile;
  readonly authorityDigest?: string;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredDescriptorString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

export function parseMorrowCapabilityDescriptorV1(value: unknown): MorrowCapabilityDescriptorV1 {
  if (!isJsonObject(value) || value.schema !== "morrow.capability.v1") {
    throw new TypeError("Expected morrow.capability.v1");
  }
  requiredDescriptorString(value.canonicalName, "canonicalName");
  requiredDescriptorString(value.family, "family");
  if (value.provider !== "canvas" && value.provider !== "local") {
    throw new TypeError("provider must be canvas or local");
  }
  if (!Array.isArray(value.aliases) || value.aliases.some((alias) => typeof alias !== "string")) {
    throw new TypeError("aliases must be a string array");
  }
  if (!isJsonObject(value.inputSchema) || !Array.isArray(value.sourceImplementations)) {
    throw new TypeError("inputSchema and sourceImplementations are required");
  }
  if (!isJsonObject(value.behavior) || !isJsonObject(value.authority) || !isJsonObject(value.route)) {
    throw new TypeError("behavior, authority, and route are required");
  }
  for (const key of [
    "readOnly", "mutating", "destructive", "irreversible", "supportsDryRun", "supportsReadback",
    "supportsUndo", "supportsBatch", "requiresBrowser", "requiresLiveCanvas",
  ]) {
    if (typeof value.behavior[key] !== "boolean") throw new TypeError(`behavior.${key} must be boolean`);
  }
  if (!isJsonObject(value.profiles)) throw new TypeError("profiles are required");
  for (const profile of RUNTIME_PROFILES) {
    const entry = value.profiles[profile];
    if (!isJsonObject(entry) || !["supported", "profile_limited", "rights_hold", "private_only", "broken_at_baseline"].includes(String(entry.state))) {
      throw new TypeError(`profiles.${profile} is invalid`);
    }
  }
  requiredDescriptorString(value.catalogDigest, "catalogDigest");
  if (!isJsonObject(value.evidence)) throw new TypeError("evidence is required");
  return value as unknown as MorrowCapabilityDescriptorV1;
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

export function upstreamCatalogDigest(
  sourceId: string,
  tools: readonly UpstreamTool[],
): string {
  return sha256Json({
    schema: "morrow.upstream-catalog.v1",
    sourceId: normalizeSourceId(sourceId),
    tools,
  });
}
