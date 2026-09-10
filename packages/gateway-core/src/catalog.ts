import {
  normalizeAnnotations,
  normalizeInputSchema,
  normalizeSourceId,
  normalizeToolName,
  sha256Json,
  sha256Text,
  type CatalogCollision,
  type CatalogSnapshot,
  type CatalogSource,
  type CatalogTool,
  type CapabilityProfileAvailability,
  type ExcludedCatalogTool,
  type MorrowCapabilityDescriptorV1,
  type RuntimeProfile,
  type SourceCapabilityMetadata,
  parseMorrowCapabilityDescriptorV1,
} from "@morrow/contracts";

export interface CatalogMergeOptions {
  readonly excludeNames?: readonly string[];
  readonly excludePrefixes?: readonly string[];
  readonly reservedNames?: readonly string[];
  readonly heldProviderIds?: readonly string[];
  readonly generatedAt?: string;
}

const DEFAULT_EXCLUDED_NAMES = Object.freeze([
  "morrow_batch_recover",
  "morrow_check_new_quiz",
]);

const DEFAULT_RESERVED_NAMES = Object.freeze([
  "morrow_health",
  "morrow_check_new_quiz",
  "morrow_catalog",
  "morrow_catalog_search",
  "morrow_capability_get",
  "morrow_profile_status",
]);
const DEFAULT_HELD_PROVIDER_IDS = Object.freeze(["mindtap", "connect"]);
const PENDING_CATALOG_DIGEST = "pending";

function isHeldProviderIdentifier(value: string): boolean {
  return /(^|[_-])(mindtap|connect)([_-]|$)/i.test(value);
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nextAlias(sourceId: string, toolName: string, used: ReadonlySet<string>): string {
  const normalizedSource = normalizeSourceId(sourceId).replace(/-/g, "_");
  const base = `${normalizedSource}__${toolName}`.slice(0, 119);
  if (!used.has(base)) return base;
  const suffix = sha256Text(`${sourceId}\0${toolName}`).slice(0, 8);
  return `${base.slice(0, 110)}_${suffix}`;
}

function profile(state: CapabilityProfileAvailability["state"], reason?: string): CapabilityProfileAvailability {
  return { state, ...(reason ? { reason } : {}) };
}

function defaultProfiles(sourceId: string): Readonly<Record<RuntimeProfile, CapabilityProfileAvailability>> {
  const isMorrow = sourceId === "morrow-legacy";
  const isSandbox = sourceId === "sandbox";
  return {
    "private-full": profile("supported"),
    "public-canvas": profile(
      isMorrow ? "rights_hold" : "supported",
      isMorrow ? "Morrow legacy source requires an explicit publication selection." : undefined,
    ),
    sandbox: isSandbox
      ? profile("supported")
      : profile("profile_limited", "This live capability is not available in the synthetic estate."),
    "read-only": profile("profile_limited", "The read-only profile does not admit provider writes."),
  };
}

function sourceSystem(sourceId: string): "morrow" | "meridian" {
  return sourceId === "meridian" ? "meridian" : "morrow";
}

function descriptorFor(
  tool: Omit<CatalogTool, "capability">,
  source: CatalogSource,
  sourceMetadata: SourceCapabilityMetadata | undefined,
): MorrowCapabilityDescriptorV1 {
  const readOnly = tool.annotations?.readOnlyHint === true;
  const destructive = tool.annotations?.destructiveHint === true;
  const behavior = {
    readOnly,
    mutating: !readOnly,
    destructive,
    irreversible: sourceMetadata?.behavior?.irreversible === true,
    supportsDryRun: sourceMetadata?.behavior?.supportsDryRun === true,
    supportsReadback: sourceMetadata?.behavior?.supportsReadback === true,
    supportsUndo: sourceMetadata?.behavior?.supportsUndo === true,
    supportsBatch: sourceMetadata?.behavior?.supportsBatch === true,
    requiresBrowser: sourceMetadata?.behavior?.requiresBrowser === true || source.id === "morrow-legacy",
    requiresLiveCanvas: sourceMetadata?.behavior?.requiresLiveCanvas === true || source.id === "morrow-legacy",
  };
  const provider = sourceMetadata?.provider === "local" || sourceMetadata?.provider === "moodle" || sourceMetadata?.provider === "blackboard"
    ? sourceMetadata.provider : "canvas";
  const routeBackend = sourceMetadata?.route?.backend
    || (source.id === "meridian" ? "meridian" : "morrow-extension");
  const defaultProfileValues = defaultProfiles(source.id);
  const profiles: Record<RuntimeProfile, CapabilityProfileAvailability> = {
    ...defaultProfileValues,
    ...(sourceMetadata?.profiles || {}),
  };
  if (readOnly) profiles["read-only"] = profile("supported");
  return {
    schema: "morrow.capability.v1",
    canonicalName: tool.publicName,
    aliases: tool.aliases || [],
    family: sourceMetadata?.family || (provider === "local" ? "local-operation" : "canvas-operation"),
    provider,
    description: tool.description || tool.title || "No donor description was supplied.",
    inputSchema: tool.inputSchema,
    sourceImplementations: [{
      system: sourceSystem(source.id),
      toolName: tool.upstreamName,
      revision: source.revision || "unknown",
      sourcePath: sourceMetadata?.sourcePath || "unknown",
      sourceExport: sourceMetadata?.sourceExport || "unknown",
      sourceDigest: sourceMetadata?.sourceDigest || sha256Json({
        name: tool.upstreamName,
        description: tool.description || null,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema || null,
        annotations: tool.annotations || null,
      }),
      schemaDigest: sha256Json(tool.inputSchema),
    }],
    behavior: { ...behavior, ...(sourceMetadata?.behavior || {}) },
    authority: {
      scopeClass: sourceMetadata?.authority?.scopeClass || "unknown",
      approvalClass: destructive ? "destructive" : readOnly ? "none" : "standard",
      dataClass: sourceMetadata?.authority?.dataClass || "unknown",
      ...(sourceMetadata?.authority || {}),
    },
    route: {
      backend: routeBackend,
      ...(sourceMetadata?.route || {}),
    },
    profiles,
    catalogDigest: PENDING_CATALOG_DIGEST,
    evidence: {
      sourcePath: {
        state: sourceMetadata?.sourcePath ? "known" : "unknown",
        ...(!sourceMetadata?.sourcePath ? { reason: "Donor did not publish a source path." } : {}),
      },
      sourceExport: {
        state: sourceMetadata?.sourceExport ? "known" : "unknown",
        ...(!sourceMetadata?.sourceExport ? { reason: "Donor did not publish an export name." } : {}),
      },
      sourceDigest: {
        state: sourceMetadata?.sourceDigest ? "known" : "unknown",
        ...(!sourceMetadata?.sourceDigest ? { reason: "Donor did not publish a source digest." } : {}),
      },
      ...(sourceMetadata?.evidence || {}),
    },
  };
}

export function mergeCatalog(
  sources: readonly CatalogSource[],
  options: CatalogMergeOptions = {},
): CatalogSnapshot {
  const excludeNames = new Set([
    ...DEFAULT_EXCLUDED_NAMES,
    ...(options.excludeNames ?? []).map(normalizeToolName),
  ]);
  const excludePrefixes = [...(options.excludePrefixes ?? [])]
    .map((value) => String(value).trim())
    .filter(Boolean)
    .sort(compareAscii);
  const reservedNames = new Set([
    ...DEFAULT_RESERVED_NAMES,
    ...(options.reservedNames ?? []).map(normalizeToolName),
  ]);
  const heldProviderIds = new Set([
    ...DEFAULT_HELD_PROVIDER_IDS,
    ...(options.heldProviderIds || []).map(normalizeSourceId),
  ]);

  const orderedSources = [...sources]
    .map((source) => ({ ...source, id: normalizeSourceId(source.id) }))
    .sort((left, right) => right.priority - left.priority || compareAscii(left.id, right.id));

  const used = new Map<string, CatalogTool>();
  const tools: CatalogTool[] = [];
  const collisions: CatalogCollision[] = [];
  const excluded: ExcludedCatalogTool[] = [];
  const countsBySource: Record<string, number> = {};

  for (const source of orderedSources) {
    const namesWithinSource = new Set<string>();
    const sourceTools = [...source.tools].sort((left, right) => compareAscii(left.name, right.name));

    for (const sourceTool of sourceTools) {
      const upstreamName = normalizeToolName(sourceTool.name);
      if (namesWithinSource.has(upstreamName)) {
        throw new Error(`Source ${source.id} defines ${upstreamName} more than once`);
      }
      namesWithinSource.add(upstreamName);

      const heldById = heldProviderIds.has(source.id) || isHeldProviderIdentifier(source.id);
      const heldByMetadata = sourceTool.capability?.provider
        && heldProviderIds.has(sourceTool.capability.provider);
      const heldByName = isHeldProviderIdentifier(upstreamName);
      if (heldById || heldByMetadata || heldByName) {
        excluded.push({ upstreamId: source.id, upstreamName, reason: "held_provider" });
        continue;
      }

      if (excludeNames.has(upstreamName)) {
        excluded.push({ upstreamId: source.id, upstreamName, reason: "excluded_name" });
        continue;
      }
      if (excludePrefixes.some((prefix) => upstreamName.startsWith(prefix))) {
        excluded.push({ upstreamId: source.id, upstreamName, reason: "excluded_prefix" });
        continue;
      }

      const retained = used.get(upstreamName);
      let publicName = upstreamName;
      if (reservedNames.has(upstreamName) || retained) {
        publicName = nextAlias(source.id, upstreamName, new Set([...used.keys(), ...reservedNames]));
        collisions.push({
          requestedName: upstreamName,
          retainedBy: retained?.upstreamId ?? "morrow",
          aliasedSource: source.id,
          aliasedTo: publicName,
        });
      }

      const annotations = normalizeAnnotations(sourceTool.annotations);
      const withoutCapability: Omit<CatalogTool, "capability"> = {
        publicName,
        upstreamId: source.id,
        upstreamLabel: source.label,
        upstreamName,
        ...(sourceTool.title ? { title: sourceTool.title } : {}),
        ...(sourceTool.description ? { description: sourceTool.description } : {}),
        inputSchema: normalizeInputSchema(sourceTool.inputSchema),
        ...(sourceTool.outputSchema
          ? { outputSchema: normalizeInputSchema(sourceTool.outputSchema) }
          : {}),
        ...(annotations ? { annotations } : {}),
      };
      const tool: CatalogTool = {
        ...withoutCapability,
        capability: descriptorFor(withoutCapability, source, sourceTool.capability),
      };

      used.set(publicName, tool);
      tools.push(tool);
      countsBySource[source.id] = (countsBySource[source.id] ?? 0) + 1;
    }
  }

  tools.sort((left, right) => compareAscii(left.publicName, right.publicName));
  collisions.sort((left, right) => compareAscii(left.aliasedTo, right.aliasedTo));
  excluded.sort((left, right) => (
    compareAscii(left.upstreamId, right.upstreamId)
    || compareAscii(left.upstreamName, right.upstreamName)
  ));

  const digest = sha256Json({
    schema: "morrow.catalog.v1",
    tools,
    collisions,
    excluded,
    countsBySource,
  });

  const catalogTools = tools.map((tool) => {
    const capability = tool.capability
      ? parseMorrowCapabilityDescriptorV1({ ...tool.capability, catalogDigest: digest })
      : undefined;
    return { ...tool, ...(capability ? { capability } : {}) };
  });

  return {
    schema: "morrow.catalog.v1",
    digest,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    tools: catalogTools,
    collisions,
    excluded,
    countsBySource,
  };
}
