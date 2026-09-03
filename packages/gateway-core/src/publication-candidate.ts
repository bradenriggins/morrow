import {
  isJsonObject,
  normalizeSourceId,
  normalizeToolName,
  upstreamCatalogDigest,
  type CatalogSource,
  type CatalogTool,
  type JsonObject,
} from "@morrow/contracts";
import { mergeCatalog } from "./catalog.js";
import {
  applyPublicationPolicy,
  parsePublicationManifest,
  publicationRuleForTool,
  type PublicationManifest,
} from "./publication.js";
import type { SourceCatalogSnapshot } from "./reconcile.js";

export const PUBLICATION_SELECTION_SCHEMA = "morrow.publication-selections.v1" as const;

export interface PublicationSelection {
  readonly publicName: string;
  readonly sourceId: string;
  readonly sourceToolName: string;
}

export interface PublicationSelectionSet {
  readonly schema: typeof PUBLICATION_SELECTION_SCHEMA;
  readonly release: string;
  readonly selections: readonly PublicationSelection[];
}

const RELEASE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,79}$/;

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

function exactRelease(value: unknown): string {
  const release = typeof value === "string" ? value.trim() : "";
  if (!RELEASE.test(release)) throw new TypeError("publication selection release is invalid");
  return release;
}

function parseSelection(value: unknown, index: number): PublicationSelection {
  const row = exactObject(
    value,
    `selections[${index}]`,
    ["publicName", "sourceId", "sourceToolName"],
  );
  return {
    publicName: normalizeToolName(row.publicName),
    sourceId: normalizeSourceId(row.sourceId),
    sourceToolName: normalizeToolName(row.sourceToolName),
  };
}

export function parsePublicationSelectionSet(value: unknown): PublicationSelectionSet {
  const root = exactObject(value, "publication selections", [
    "schema",
    "release",
    "selections",
  ]);
  if (root.schema !== PUBLICATION_SELECTION_SCHEMA) {
    throw new TypeError("publication selections have an unsupported schema");
  }
  if (!Array.isArray(root.selections) || root.selections.length === 0) {
    throw new TypeError("publication selections require at least one explicit tool");
  }
  const selections = root.selections.map(parseSelection).sort((left, right) => (
    compareAscii(left.publicName, right.publicName)
    || compareAscii(left.sourceId, right.sourceId)
    || compareAscii(left.sourceToolName, right.sourceToolName)
  ));
  const publicNames = new Set<string>();
  const sourceTools = new Set<string>();
  for (const selection of selections) {
    if (publicNames.has(selection.publicName)) {
      throw new TypeError(`publication name ${selection.publicName} is selected more than once`);
    }
    publicNames.add(selection.publicName);
    const sourceKey = `${selection.sourceId}\0${selection.sourceToolName}`;
    if (sourceTools.has(sourceKey)) {
      throw new TypeError(
        `source tool ${selection.sourceId}:${selection.sourceToolName} is selected more than once`,
      );
    }
    sourceTools.add(sourceKey);
  }
  return {
    schema: PUBLICATION_SELECTION_SCHEMA,
    release: exactRelease(root.release),
    selections,
  };
}

function catalogTool(
  catalog: SourceCatalogSnapshot,
  sourceToolName: string,
  publicName: string,
): CatalogTool {
  const tools = catalog.tools.filter((tool) => tool.name === sourceToolName);
  if (tools.length !== 1) {
    throw new Error(
      `Expected one ${catalog.source.id}:${sourceToolName} tool in its captured catalog; found ${tools.length}`,
    );
  }
  const tool = tools[0]!;
  return {
    publicName,
    upstreamId: catalog.source.id,
    upstreamLabel: catalog.source.label,
    upstreamName: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  };
}

export function buildPublicationManifestCandidate(
  sourceCatalogs: readonly SourceCatalogSnapshot[],
  selectionValue: unknown,
): PublicationManifest {
  if (sourceCatalogs.length === 0) {
    throw new TypeError("At least one captured source catalog is required");
  }
  const selections = parsePublicationSelectionSet(selectionValue);
  const catalogsById = new Map<string, SourceCatalogSnapshot>();
  for (const catalog of sourceCatalogs) {
    const sourceId = normalizeSourceId(catalog.source.id);
    if (catalogsById.has(sourceId)) {
      throw new Error(`Captured source catalog ${sourceId} is duplicated`);
    }
    catalogsById.set(sourceId, catalog);
  }

  const selectedSourceIds = new Set<string>();
  const tools = selections.selections.map((selection) => {
    const catalog = catalogsById.get(selection.sourceId);
    if (!catalog) {
      throw new Error(
        `Selection ${selection.publicName} references missing source ${selection.sourceId}`,
      );
    }
    selectedSourceIds.add(selection.sourceId);
    return publicationRuleForTool(
      catalogTool(catalog, selection.sourceToolName, selection.publicName),
      selection.publicName,
    );
  });

  const sources = [...selectedSourceIds]
    .sort(compareAscii)
    .map((sourceId) => {
      const catalog = catalogsById.get(sourceId)!;
      return {
        sourceId,
        catalogDigest: upstreamCatalogDigest(sourceId, catalog.tools),
        toolCount: catalog.count,
      };
    });
  const manifest = parsePublicationManifest({
    schema: "morrow.publication-policy.v1",
    profile: "public-canvas",
    release: selections.release,
    sources,
    tools,
  });

  const allSources: CatalogSource[] = sourceCatalogs.map((catalog, index) => ({
    id: catalog.source.id,
    label: catalog.source.label,
    priority: sourceCatalogs.length - index,
    tools: catalog.tools,
  }));
  const merged = mergeCatalog(allSources, {
    excludePrefixes: ["mindtap_", "connect_"],
  });
  applyPublicationPolicy(merged, manifest, sources);
  return manifest;
}
