import {
  isJsonObject,
  normalizeAnnotations,
  normalizeInputSchema,
  normalizeSourceId,
  normalizeToolName,
  sha256Json,
  sha256Text,
  type ToolAnnotations,
  type UpstreamTool,
} from "@morrow/contracts";

export type SourceCatalogKind = "mcp-stdio" | "donor-export" | "synthetic";

export interface SourceCatalogDescriptor {
  readonly id: string;
  readonly label: string;
  readonly kind: SourceCatalogKind;
  readonly repository?: string;
  readonly revision?: string;
  readonly capturedAt?: string;
}

export interface SourceCatalogSnapshot {
  readonly schema: "morrow.source-catalog.v1";
  readonly digest: string;
  readonly source: {
    readonly id: string;
    readonly label: string;
    readonly kind: SourceCatalogKind;
    readonly repository?: string;
    readonly revision?: string;
    readonly capturedAt: string;
  };
  readonly count: number;
  readonly tools: readonly UpstreamTool[];
}

export interface CatalogAliasMember {
  readonly sourceId: string;
  readonly toolName: string;
}

export interface CatalogAliasRule {
  readonly id: string;
  readonly publicName: string;
  readonly preferredSourceId: string;
  readonly members: readonly CatalogAliasMember[];
  readonly reason: string;
}

export interface CatalogToolEvidence {
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly toolName: string;
  readonly title?: string;
  readonly descriptionSha256?: string;
  readonly inputSchemaSha256: string;
  readonly outputSchemaSha256?: string;
  readonly annotationsSha256: string;
  readonly contractSha256: string;
}

export type ReconciliationRowKind = "alias" | "exact_name" | "source_only";
export type ReconciliationRowStatus = "compatible" | "contract_drift" | "single";

export interface CatalogSelection {
  readonly sourceId: string;
  readonly toolName: string;
}

export interface CatalogReconciliationRow {
  readonly id: string;
  readonly kind: ReconciliationRowKind;
  readonly status: ReconciliationRowStatus;
  readonly publicName: string;
  readonly selected: CatalogSelection | null;
  readonly reviewRequired: boolean;
  readonly annotationsAligned: boolean;
  readonly descriptionsAligned: boolean;
  readonly reason?: string;
  readonly members: readonly CatalogToolEvidence[];
}

export interface CatalogReconciliationReport {
  readonly schema: "morrow.catalog-reconciliation.v1";
  readonly digest: string;
  readonly generatedAt: string;
  readonly sources: readonly {
    readonly id: string;
    readonly label: string;
    readonly repository?: string;
    readonly revision?: string;
    readonly catalogDigest: string;
    readonly toolCount: number;
  }[];
  readonly sourcePriority: readonly string[];
  readonly counts: {
    readonly catalogs: number;
    readonly sourceTools: number;
    readonly rows: number;
    readonly exactShared: number;
    readonly aliasGroups: number;
    readonly compatible: number;
    readonly contractDrift: number;
    readonly sourceOnly: number;
    readonly reviewRequired: number;
    readonly sourceOnlyBySource: Readonly<Record<string, number>>;
  };
  readonly rows: readonly CatalogReconciliationRow[];
}

export interface ReconcileCatalogOptions {
  readonly aliases?: readonly CatalogAliasRule[];
  readonly sourcePriority?: readonly string[];
  readonly generatedAt?: string;
}

const CATALOG_KINDS = new Set<SourceCatalogKind>([
  "mcp-stdio",
  "donor-export",
  "synthetic",
]);

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requiredText(value: unknown, field: string, maximum = 500): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maximum) {
    throw new TypeError(`${field} must be a non-empty string no longer than ${maximum} characters`);
  }
  return text;
}

function optionalText(value: unknown, field: string, maximum = 500): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredText(value, field, maximum);
}

function normalizeCapturedAt(value: string | undefined): string {
  const timestamp = value ?? new Date().toISOString();
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("source.capturedAt must be a valid timestamp");
  }
  return date.toISOString();
}

function normalizeCatalogTool(value: unknown): UpstreamTool {
  if (!isJsonObject(value)) {
    throw new TypeError("source catalog tools must be objects");
  }
  const annotations = normalizeAnnotations(value.annotations);
  const title = optionalText(value.title, "tool.title", 300);
  const description = optionalText(value.description, "tool.description", 20_000);
  return {
    name: normalizeToolName(value.name),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    inputSchema: normalizeInputSchema(value.inputSchema),
    ...(isJsonObject(value.outputSchema)
      ? { outputSchema: normalizeInputSchema(value.outputSchema) }
      : {}),
    ...(annotations ? { annotations } : {}),
  };
}

function sourceDigestShape(snapshot: Omit<SourceCatalogSnapshot, "digest">): unknown {
  return {
    schema: snapshot.schema,
    source: {
      id: snapshot.source.id,
      label: snapshot.source.label,
      kind: snapshot.source.kind,
      repository: snapshot.source.repository ?? null,
      revision: snapshot.source.revision ?? null,
    },
    count: snapshot.count,
    tools: snapshot.tools,
  };
}

export function buildSourceCatalog(
  descriptor: SourceCatalogDescriptor,
  tools: readonly UpstreamTool[],
): SourceCatalogSnapshot {
  const id = normalizeSourceId(descriptor.id);
  const label = requiredText(descriptor.label, "source.label", 200);
  if (!CATALOG_KINDS.has(descriptor.kind)) {
    throw new TypeError(`Unsupported source catalog kind: ${String(descriptor.kind)}`);
  }
  const repository = optionalText(descriptor.repository, "source.repository", 300);
  const revision = optionalText(descriptor.revision, "source.revision", 300);
  const capturedAt = normalizeCapturedAt(descriptor.capturedAt);

  const normalizedTools = tools
    .map((tool) => normalizeCatalogTool(tool))
    .sort((left, right) => compareAscii(left.name, right.name));
  const seen = new Set<string>();
  for (const tool of normalizedTools) {
    if (seen.has(tool.name)) {
      throw new Error(`Source ${id} defines ${tool.name} more than once`);
    }
    seen.add(tool.name);
  }

  const withoutDigest: Omit<SourceCatalogSnapshot, "digest"> = {
    schema: "morrow.source-catalog.v1",
    source: {
      id,
      label,
      kind: descriptor.kind,
      ...(repository ? { repository } : {}),
      ...(revision ? { revision } : {}),
      capturedAt,
    },
    count: normalizedTools.length,
    tools: normalizedTools,
  };

  return {
    ...withoutDigest,
    digest: sha256Json(sourceDigestShape(withoutDigest)),
  };
}

export function parseSourceCatalog(value: unknown): SourceCatalogSnapshot {
  if (!isJsonObject(value) || value.schema !== "morrow.source-catalog.v1") {
    throw new TypeError("Expected morrow.source-catalog.v1");
  }
  if (!isJsonObject(value.source) || !Array.isArray(value.tools)) {
    throw new TypeError("Source catalog source and tools are required");
  }
  const source = value.source;
  const built = buildSourceCatalog({
    id: requiredText(source.id, "source.id", 64),
    label: requiredText(source.label, "source.label", 200),
    kind: requiredText(source.kind, "source.kind", 30) as SourceCatalogKind,
    ...(source.repository ? { repository: requiredText(source.repository, "source.repository", 300) } : {}),
    ...(source.revision ? { revision: requiredText(source.revision, "source.revision", 300) } : {}),
    capturedAt: requiredText(source.capturedAt, "source.capturedAt", 100),
  }, value.tools.map((tool) => normalizeCatalogTool(tool)));

  if (value.count !== built.count) {
    throw new Error(`Source catalog count mismatch: declared ${String(value.count)}, actual ${built.count}`);
  }
  if (value.digest !== built.digest) {
    throw new Error("Source catalog digest mismatch");
  }
  return built;
}

function toolEvidence(catalog: SourceCatalogSnapshot, tool: UpstreamTool): CatalogToolEvidence {
  const inputSchemaSha256 = sha256Json(tool.inputSchema);
  const outputSchemaSha256 = tool.outputSchema ? sha256Json(tool.outputSchema) : undefined;
  const annotationsSha256 = sha256Json(tool.annotations ?? null);
  const contractSha256 = sha256Json({
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema ?? null,
  });
  return {
    sourceId: catalog.source.id,
    sourceLabel: catalog.source.label,
    toolName: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    ...(tool.description ? { descriptionSha256: sha256Text(tool.description) } : {}),
    inputSchemaSha256,
    ...(outputSchemaSha256 ? { outputSchemaSha256 } : {}),
    annotationsSha256,
    contractSha256,
  };
}

function alignment(members: readonly CatalogToolEvidence[], field: "annotationsSha256" | "descriptionSha256"): boolean {
  const values = new Set(members.map((member) => member[field] ?? null));
  return values.size <= 1;
}

function normalizeAliasRule(value: CatalogAliasRule): CatalogAliasRule {
  const id = requiredText(value.id, "alias.id", 128).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id)) {
    throw new TypeError(`Invalid alias id: ${id}`);
  }
  const members = value.members.map((member) => ({
    sourceId: normalizeSourceId(member.sourceId),
    toolName: normalizeToolName(member.toolName),
  }));
  if (members.length < 2) {
    throw new Error(`Alias ${id} must contain at least two members`);
  }
  const memberKeys = new Set(members.map((member) => `${member.sourceId}\0${member.toolName}`));
  if (memberKeys.size !== members.length) {
    throw new Error(`Alias ${id} repeats a member`);
  }
  const sourceIds = new Set(members.map((member) => member.sourceId));
  if (sourceIds.size !== members.length) {
    throw new Error(`Alias ${id} may contain only one member per source`);
  }
  const preferredSourceId = normalizeSourceId(value.preferredSourceId);
  if (!sourceIds.has(preferredSourceId)) {
    throw new Error(`Alias ${id} preferred source is not a member`);
  }
  return {
    id,
    publicName: normalizeToolName(value.publicName),
    preferredSourceId,
    members,
    reason: requiredText(value.reason, "alias.reason", 1000),
  };
}

export function parseCatalogAliasRules(value: unknown): readonly CatalogAliasRule[] {
  if (!isJsonObject(value) || value.schema !== "morrow.catalog-aliases.v1" || !Array.isArray(value.rules)) {
    throw new TypeError("Expected morrow.catalog-aliases.v1");
  }
  return value.rules.map((rule) => {
    if (!isJsonObject(rule) || !Array.isArray(rule.members)) {
      throw new TypeError("Alias rules must be objects with members");
    }
    return normalizeAliasRule({
      id: requiredText(rule.id, "alias.id", 128),
      publicName: requiredText(rule.publicName, "alias.publicName", 128),
      preferredSourceId: requiredText(rule.preferredSourceId, "alias.preferredSourceId", 64),
      reason: requiredText(rule.reason, "alias.reason", 1000),
      members: rule.members.map((member) => {
        if (!isJsonObject(member)) throw new TypeError("Alias members must be objects");
        return {
          sourceId: requiredText(member.sourceId, "alias.member.sourceId", 64),
          toolName: requiredText(member.toolName, "alias.member.toolName", 128),
        };
      }),
    });
  });
}

export function reconcileCatalogs(
  catalogs: readonly SourceCatalogSnapshot[],
  options: ReconcileCatalogOptions = {},
): CatalogReconciliationReport {
  if (catalogs.length < 2) {
    throw new Error("Catalog reconciliation requires at least two source catalogs");
  }

  const bySource = new Map<string, SourceCatalogSnapshot>();
  const toolIndices = new Map<string, ReadonlyMap<string, UpstreamTool>>();
  for (const inputCatalog of catalogs) {
    const catalog = parseSourceCatalog(inputCatalog);
    if (bySource.has(catalog.source.id)) {
      throw new Error(`Duplicate source catalog id ${catalog.source.id}`);
    }
    bySource.set(catalog.source.id, catalog);
    toolIndices.set(catalog.source.id, new Map(catalog.tools.map((tool) => [tool.name, tool])));
  }

  const requestedPriority = options.sourcePriority?.map(normalizeSourceId) ?? catalogs.map((catalog) => catalog.source.id);
  const priority = [...new Set([
    ...requestedPriority,
    ...catalogs.map((catalog) => catalog.source.id),
  ])];
  for (const sourceId of priority) {
    if (!bySource.has(sourceId)) throw new Error(`Unknown priority source ${sourceId}`);
  }
  const rank = new Map(priority.map((sourceId, index) => [sourceId, index]));
  const sortMembers = (members: CatalogToolEvidence[]): CatalogToolEvidence[] => members.sort((left, right) => (
    (rank.get(left.sourceId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.sourceId) ?? Number.MAX_SAFE_INTEGER)
    || compareAscii(left.toolName, right.toolName)
  ));

  const aliases = (options.aliases ?? []).map(normalizeAliasRule);
  const aliasIds = new Set<string>();
  const publicNames = new Set<string>();
  const consumed = new Set<string>();
  const rows: CatalogReconciliationRow[] = [];

  for (const alias of aliases) {
    if (aliasIds.has(alias.id)) throw new Error(`Duplicate alias id ${alias.id}`);
    if (publicNames.has(alias.publicName)) throw new Error(`Duplicate reconciled public name ${alias.publicName}`);
    aliasIds.add(alias.id);
    publicNames.add(alias.publicName);

    const members = sortMembers(alias.members.map((member) => {
      const catalog = bySource.get(member.sourceId);
      const tool = toolIndices.get(member.sourceId)?.get(member.toolName);
      if (!catalog || !tool) {
        throw new Error(`Alias ${alias.id} references missing tool ${member.sourceId}/${member.toolName}`);
      }
      const key = `${member.sourceId}\0${member.toolName}`;
      if (consumed.has(key)) throw new Error(`Tool ${member.sourceId}/${member.toolName} belongs to multiple alias groups`);
      consumed.add(key);
      return toolEvidence(catalog, tool);
    }));
    const compatible = new Set(members.map((member) => member.contractSha256)).size === 1;
    const preferred = members.find((member) => member.sourceId === alias.preferredSourceId);
    if (!preferred) throw new Error(`Alias ${alias.id} preferred source could not be resolved`);
    rows.push({
      id: `alias:${alias.id}`,
      kind: "alias",
      status: compatible ? "compatible" : "contract_drift",
      publicName: alias.publicName,
      selected: compatible
        ? { sourceId: preferred.sourceId, toolName: preferred.toolName }
        : null,
      reviewRequired: !compatible,
      annotationsAligned: alignment(members, "annotationsSha256"),
      descriptionsAligned: alignment(members, "descriptionSha256"),
      reason: alias.reason,
      members,
    });
  }

  const byName = new Map<string, CatalogToolEvidence[]>();
  for (const catalog of bySource.values()) {
    for (const tool of catalog.tools) {
      const key = `${catalog.source.id}\0${tool.name}`;
      if (consumed.has(key)) continue;
      const members = byName.get(tool.name) ?? [];
      members.push(toolEvidence(catalog, tool));
      byName.set(tool.name, members);
    }
  }

  for (const [name, unsortedMembers] of byName) {
    if (publicNames.has(name)) throw new Error(`Reconciled public name ${name} is produced more than once`);
    publicNames.add(name);
    const members = sortMembers(unsortedMembers);
    if (members.length === 1) {
      const member = members[0];
      if (!member) throw new Error(`Missing source-only member for ${name}`);
      rows.push({
        id: `source:${member.sourceId}:${member.toolName}`,
        kind: "source_only",
        status: "single",
        publicName: name,
        selected: { sourceId: member.sourceId, toolName: member.toolName },
        reviewRequired: false,
        annotationsAligned: true,
        descriptionsAligned: true,
        members,
      });
      continue;
    }

    const compatible = new Set(members.map((member) => member.contractSha256)).size === 1;
    const selectedMember = compatible ? members[0] : undefined;
    rows.push({
      id: `exact:${name}`,
      kind: "exact_name",
      status: compatible ? "compatible" : "contract_drift",
      publicName: name,
      selected: selectedMember
        ? { sourceId: selectedMember.sourceId, toolName: selectedMember.toolName }
        : null,
      reviewRequired: !compatible,
      annotationsAligned: alignment(members, "annotationsSha256"),
      descriptionsAligned: alignment(members, "descriptionSha256"),
      members,
    });
  }

  rows.sort((left, right) => compareAscii(left.publicName, right.publicName) || compareAscii(left.id, right.id));
  const sourceOnlyBySource: Record<string, number> = {};
  for (const row of rows) {
    if (row.kind !== "source_only") continue;
    const sourceId = row.members[0]?.sourceId;
    if (sourceId) sourceOnlyBySource[sourceId] = (sourceOnlyBySource[sourceId] ?? 0) + 1;
  }

  const reportWithoutDigest: Omit<CatalogReconciliationReport, "digest"> = {
    schema: "morrow.catalog-reconciliation.v1",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    sources: priority.map((sourceId) => {
      const catalog = bySource.get(sourceId);
      if (!catalog) throw new Error(`Missing source ${sourceId}`);
      return {
        id: catalog.source.id,
        label: catalog.source.label,
        ...(catalog.source.repository ? { repository: catalog.source.repository } : {}),
        ...(catalog.source.revision ? { revision: catalog.source.revision } : {}),
        catalogDigest: catalog.digest,
        toolCount: catalog.count,
      };
    }),
    sourcePriority: priority,
    counts: {
      catalogs: catalogs.length,
      sourceTools: catalogs.reduce((total, catalog) => total + catalog.count, 0),
      rows: rows.length,
      exactShared: rows.filter((row) => row.kind === "exact_name").length,
      aliasGroups: rows.filter((row) => row.kind === "alias").length,
      compatible: rows.filter((row) => row.status === "compatible").length,
      contractDrift: rows.filter((row) => row.status === "contract_drift").length,
      sourceOnly: rows.filter((row) => row.kind === "source_only").length,
      reviewRequired: rows.filter((row) => row.reviewRequired).length,
      sourceOnlyBySource,
    },
    rows,
  };

  return {
    ...reportWithoutDigest,
    digest: sha256Json({
      ...reportWithoutDigest,
      generatedAt: null,
    }),
  };
}
