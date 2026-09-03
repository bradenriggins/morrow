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
  type ExcludedCatalogTool,
} from "@morrow/contracts";

export interface CatalogMergeOptions {
  readonly excludeNames?: readonly string[];
  readonly excludePrefixes?: readonly string[];
  readonly reservedNames?: readonly string[];
  readonly generatedAt?: string;
}

const DEFAULT_EXCLUDED_NAMES = Object.freeze([
  "morrow_batch_recover",
]);

const DEFAULT_RESERVED_NAMES = Object.freeze([
  "morrow_health",
  "morrow_catalog",
]);

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
      const tool: CatalogTool = {
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

  return {
    schema: "morrow.catalog.v1",
    digest,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    tools,
    collisions,
    excluded,
    countsBySource,
  };
}
