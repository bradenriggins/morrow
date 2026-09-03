import {
  isJsonObject,
  normalizeSourceId,
  normalizeToolName,
  sha256Json,
  sha256Text,
  type CatalogSnapshot,
  type CatalogTool,
  type ExcludedCatalogTool,
  type JsonObject,
  type PublicationPolicyHealth,
  type ToolAnnotations,
} from "@morrow/contracts";

export const PUBLICATION_MANIFEST_SCHEMA = "morrow.publication-policy.v1" as const;
export const PUBLICATION_PROFILE = "public-canvas" as const;

export interface PublicationManifestSource {
  readonly sourceId: string;
  readonly catalogDigest: string;
  readonly toolCount: number;
}

export interface PublicationManifestTool {
  readonly publicName: string;
  readonly sourceId: string;
  readonly sourceToolName: string;
  readonly inputSchemaSha256: string;
  readonly outputSchemaSha256: string | null;
  readonly descriptionSha256: string | null;
  readonly annotationsSha256: string;
}

export interface PublicationManifest {
  readonly schema: typeof PUBLICATION_MANIFEST_SCHEMA;
  readonly profile: typeof PUBLICATION_PROFILE;
  readonly release: string;
  readonly sources: readonly PublicationManifestSource[];
  readonly tools: readonly PublicationManifestTool[];
}

export interface PublicationSourceEvidence {
  readonly sourceId: string;
  readonly catalogDigest: string;
  readonly toolCount: number;
}

export interface ApplyPublicationPolicyOptions {
  readonly reservedNames?: readonly string[];
  readonly deniedPrefixes?: readonly string[];
}

export interface AppliedPublicationPolicy {
  readonly catalog: CatalogSnapshot;
  readonly receipt: PublicationPolicyHealth;
  readonly manifest: PublicationManifest;
}

const SHA256 = /^[0-9a-f]{64}$/;
const RELEASE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,79}$/;
const DEFAULT_DENIED_PREFIXES = Object.freeze(["mindtap_", "connect_"]);
const DEFAULT_RESERVED_NAMES = Object.freeze([
  "morrow_health",
  "morrow_catalog",
  "morrow_operation_get",
  "morrow_operations_recent",
  "morrow_batch_health",
  "morrow_batch_create",
  "morrow_batch_get",
  "morrow_batches_recent",
  "morrow_batch_run",
  "morrow_batch_reconcile",
  "morrow_batch_recover",
  "morrow_batch_pause",
  "morrow_batch_cancel",
]);

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactObject(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
): JsonObject {
  if (!isJsonObject(value)) throw new TypeError(`${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) {
    throw new TypeError(`${label} contains unknown fields: ${unknown.sort(compareAscii).join(", ")}`);
  }
  return value;
}

function exactString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new TypeError(`${label} must contain 1 to ${maximum} characters`);
  }
  return normalized;
}

function exactDigest(value: unknown, label: string): string {
  const digest = exactString(value, label, 64).toLowerCase();
  if (!SHA256.test(digest)) throw new TypeError(`${label} must be a SHA-256 digest`);
  return digest;
}

function exactDigestOrNull(value: unknown, label: string): string | null {
  if (value === null) return null;
  return exactDigest(value, label);
}

function exactCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 5_000) {
    throw new TypeError(`${label} must be a whole number from 0 through 5000`);
  }
  return Number(value);
}

function parseSource(value: unknown, index: number): PublicationManifestSource {
  const row = exactObject(
    value,
    `sources[${index}]`,
    ["sourceId", "catalogDigest", "toolCount"],
  );
  return {
    sourceId: normalizeSourceId(row.sourceId),
    catalogDigest: exactDigest(row.catalogDigest, `sources[${index}].catalogDigest`),
    toolCount: exactCount(row.toolCount, `sources[${index}].toolCount`),
  };
}

function parseTool(value: unknown, index: number): PublicationManifestTool {
  const row = exactObject(
    value,
    `tools[${index}]`,
    [
      "publicName",
      "sourceId",
      "sourceToolName",
      "inputSchemaSha256",
      "outputSchemaSha256",
      "descriptionSha256",
      "annotationsSha256",
    ],
  );
  return {
    publicName: normalizeToolName(row.publicName),
    sourceId: normalizeSourceId(row.sourceId),
    sourceToolName: normalizeToolName(row.sourceToolName),
    inputSchemaSha256: exactDigest(row.inputSchemaSha256, `tools[${index}].inputSchemaSha256`),
    outputSchemaSha256: exactDigestOrNull(
      row.outputSchemaSha256,
      `tools[${index}].outputSchemaSha256`,
    ),
    descriptionSha256: exactDigestOrNull(
      row.descriptionSha256,
      `tools[${index}].descriptionSha256`,
    ),
    annotationsSha256: exactDigest(
      row.annotationsSha256,
      `tools[${index}].annotationsSha256`,
    ),
  };
}

export function parsePublicationManifest(value: unknown): PublicationManifest {
  const root = exactObject(value, "publication manifest", [
    "schema",
    "profile",
    "release",
    "sources",
    "tools",
  ]);
  if (root.schema !== PUBLICATION_MANIFEST_SCHEMA) {
    throw new TypeError("publication manifest has an unsupported schema");
  }
  if (root.profile !== PUBLICATION_PROFILE) {
    throw new TypeError("publication manifest profile must be public-canvas");
  }
  const release = exactString(root.release, "publication release", 80);
  if (!RELEASE.test(release)) throw new TypeError("publication release has an invalid format");
  if (!Array.isArray(root.sources) || root.sources.length === 0) {
    throw new TypeError("publication manifest requires at least one source");
  }
  if (!Array.isArray(root.tools) || root.tools.length === 0) {
    throw new TypeError("publication manifest requires at least one selected tool");
  }

  const sources = root.sources.map(parseSource).sort((left, right) => (
    compareAscii(left.sourceId, right.sourceId)
  ));
  const tools = root.tools.map(parseTool).sort((left, right) => (
    compareAscii(left.publicName, right.publicName)
    || compareAscii(left.sourceId, right.sourceId)
    || compareAscii(left.sourceToolName, right.sourceToolName)
  ));

  const sourceIds = new Set<string>();
  for (const source of sources) {
    if (sourceIds.has(source.sourceId)) {
      throw new TypeError(`publication source ${source.sourceId} is duplicated`);
    }
    sourceIds.add(source.sourceId);
  }
  const publicNames = new Set<string>();
  const sourceTools = new Set<string>();
  for (const tool of tools) {
    if (!sourceIds.has(tool.sourceId)) {
      throw new TypeError(`publication tool ${tool.publicName} references an undeclared source`);
    }
    if (publicNames.has(tool.publicName)) {
      throw new TypeError(`publication public name ${tool.publicName} is duplicated`);
    }
    publicNames.add(tool.publicName);
    const sourceKey = `${tool.sourceId}\0${tool.sourceToolName}`;
    if (sourceTools.has(sourceKey)) {
      throw new TypeError(
        `publication source tool ${tool.sourceId}:${tool.sourceToolName} is selected more than once`,
      );
    }
    sourceTools.add(sourceKey);
  }

  return {
    schema: PUBLICATION_MANIFEST_SCHEMA,
    profile: PUBLICATION_PROFILE,
    release,
    sources,
    tools,
  };
}

function annotationsDigest(value: ToolAnnotations | undefined): string {
  return sha256Json(value || {});
}

export function publicationRuleForTool(
  tool: CatalogTool,
  publicName = tool.publicName,
): PublicationManifestTool {
  return {
    publicName: normalizeToolName(publicName),
    sourceId: normalizeSourceId(tool.upstreamId),
    sourceToolName: normalizeToolName(tool.upstreamName),
    inputSchemaSha256: sha256Json(tool.inputSchema),
    outputSchemaSha256: tool.outputSchema ? sha256Json(tool.outputSchema) : null,
    descriptionSha256: tool.description ? sha256Text(tool.description) : null,
    annotationsSha256: annotationsDigest(tool.annotations),
  };
}

function assertToolContract(tool: CatalogTool, rule: PublicationManifestTool): void {
  const actual = publicationRuleForTool(tool, rule.publicName);
  for (const key of [
    "inputSchemaSha256",
    "outputSchemaSha256",
    "descriptionSha256",
    "annotationsSha256",
  ] as const) {
    if (actual[key] !== rule[key]) {
      throw new Error(
        `Publication contract drift for ${rule.sourceId}:${rule.sourceToolName} at ${key}`,
      );
    }
  }
}

function sortedExcluded(values: readonly ExcludedCatalogTool[]): ExcludedCatalogTool[] {
  return [...values].sort((left, right) => (
    compareAscii(left.upstreamId, right.upstreamId)
    || compareAscii(left.upstreamName, right.upstreamName)
    || compareAscii(left.reason, right.reason)
  ));
}

export function applyPublicationPolicy(
  mergedCatalog: CatalogSnapshot,
  manifestValue: unknown,
  sourceEvidence: readonly PublicationSourceEvidence[],
  options: ApplyPublicationPolicyOptions = {},
): AppliedPublicationPolicy {
  const manifest = parsePublicationManifest(manifestValue);
  const reservedNames = new Set([
    ...DEFAULT_RESERVED_NAMES,
    ...(options.reservedNames || []).map(normalizeToolName),
  ]);
  const deniedPrefixes = [
    ...DEFAULT_DENIED_PREFIXES,
    ...(options.deniedPrefixes || []),
  ].map((value) => String(value || "").trim()).filter(Boolean);
  const evidenceBySource = new Map<string, PublicationSourceEvidence>();
  for (const evidence of sourceEvidence) {
    const sourceId = normalizeSourceId(evidence.sourceId);
    if (evidenceBySource.has(sourceId)) {
      throw new Error(`Publication source evidence ${sourceId} is duplicated`);
    }
    evidenceBySource.set(sourceId, {
      sourceId,
      catalogDigest: exactDigest(evidence.catalogDigest, `${sourceId}.catalogDigest`),
      toolCount: exactCount(evidence.toolCount, `${sourceId}.toolCount`),
    });
  }

  for (const source of manifest.sources) {
    const evidence = evidenceBySource.get(source.sourceId);
    if (!evidence) throw new Error(`Publication source ${source.sourceId} is not connected`);
    if (evidence.catalogDigest !== source.catalogDigest) {
      throw new Error(`Publication source catalog drift for ${source.sourceId}`);
    }
    if (evidence.toolCount !== source.toolCount) {
      throw new Error(`Publication source tool count drift for ${source.sourceId}`);
    }
  }

  const mergedBySourceTool = new Map<string, CatalogTool>();
  for (const tool of mergedCatalog.tools) {
    const key = `${tool.upstreamId}\0${tool.upstreamName}`;
    if (mergedBySourceTool.has(key)) {
      throw new Error(`Merged catalog contains duplicate source mapping ${key}`);
    }
    mergedBySourceTool.set(key, tool);
  }

  const selectedSourceKeys = new Set<string>();
  const selectedTools: CatalogTool[] = [];
  const countsBySource: Record<string, number> = {};
  for (const rule of manifest.tools) {
    if (reservedNames.has(rule.publicName)) {
      throw new Error(`Publication name ${rule.publicName} is reserved by Morrow`);
    }
    if (deniedPrefixes.some((prefix) => rule.publicName.startsWith(prefix))) {
      throw new Error(`Publication name ${rule.publicName} uses a denied provider prefix`);
    }
    const sourceKey = `${rule.sourceId}\0${rule.sourceToolName}`;
    const tool = mergedBySourceTool.get(sourceKey);
    if (!tool) {
      throw new Error(`Publication source tool ${rule.sourceId}:${rule.sourceToolName} is unavailable`);
    }
    assertToolContract(tool, rule);
    selectedSourceKeys.add(sourceKey);
    selectedTools.push({
      ...tool,
      publicName: rule.publicName,
    });
    countsBySource[rule.sourceId] = (countsBySource[rule.sourceId] || 0) + 1;
  }
  selectedTools.sort((left, right) => compareAscii(left.publicName, right.publicName));

  const omitted = mergedCatalog.tools
    .filter((tool) => !selectedSourceKeys.has(`${tool.upstreamId}\0${tool.upstreamName}`))
    .map((tool): ExcludedCatalogTool => ({
      upstreamId: tool.upstreamId,
      upstreamName: tool.upstreamName,
      reason: "publication_policy",
    }));
  const excluded = sortedExcluded([...mergedCatalog.excluded, ...omitted]);
  const digest = sha256Json({
    schema: "morrow.catalog.v1",
    tools: selectedTools,
    collisions: [],
    excluded,
    countsBySource,
  });
  const catalog: CatalogSnapshot = {
    schema: "morrow.catalog.v1",
    digest,
    generatedAt: mergedCatalog.generatedAt,
    tools: selectedTools,
    collisions: [],
    excluded,
    countsBySource,
  };
  const receipt: PublicationPolicyHealth = {
    schema: "morrow.publication-policy.health.v1",
    applied: true,
    profile: PUBLICATION_PROFILE,
    manifestDigest: sha256Json(manifest),
    sourceCount: manifest.sources.length,
    allowedToolCount: selectedTools.length,
    omittedToolCount: omitted.length,
  };
  return { catalog, receipt, manifest };
}
