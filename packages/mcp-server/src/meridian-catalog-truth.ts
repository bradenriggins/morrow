import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  upstreamCatalogDigest,
  type CatalogTruthHealth,
  type UpstreamTool,
} from "@morrow/contracts";
import { parseSourceCatalog } from "@morrow/gateway-core";
import type { ExamplePlatformSshUpstreamConfig } from "./config.js";

export interface ExamplePlatformCatalogTruth {
  readonly health: CatalogTruthHealth;
  readonly tools: readonly UpstreamTool[];
}

export function loadExamplePlatformCatalogTruth(
  config: ExamplePlatformSshUpstreamConfig,
  filters: {
    readonly excludePrefixes: readonly string[];
    readonly excludeNames: readonly string[];
  },
): ExamplePlatformCatalogTruth {
  let bytes: Buffer;
  try {
    bytes = readFileSync(config.catalogTruth.path);
  } catch {
    throw new Error("The configured ExamplePlatform catalog truth is unavailable.");
  }
  const fileSha256 = createHash("sha256").update(bytes).digest("hex");
  if (fileSha256 !== config.catalogTruth.fileSha256) {
    throw new Error("The configured ExamplePlatform catalog truth file digest does not match.");
  }

  let catalog;
  try {
    catalog = parseSourceCatalog(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch {
    throw new Error("The configured ExamplePlatform catalog truth is invalid.");
  }
  if (catalog.source.id !== config.id) {
    throw new Error("The configured ExamplePlatform catalog truth names a different source.");
  }
  if (catalog.source.revision?.toLowerCase() !== config.revision.toLowerCase()) {
    throw new Error("The configured ExamplePlatform catalog truth names a different revision.");
  }

  const excludedNames = new Set(filters.excludeNames);
  const eligibleTools = catalog.tools.filter((tool) => (
    !excludedNames.has(tool.name)
    && !filters.excludePrefixes.some((prefix) => tool.name.startsWith(prefix))
  ));
  const upstreamDigest = upstreamCatalogDigest(config.id, catalog.tools);
  const eligibleCatalogDigest = upstreamCatalogDigest(config.id, eligibleTools);
  return {
    tools: catalog.tools,
    health: {
      schema: "morrow.catalog-truth.health.v1",
      verified: true,
      fileSha256,
      sourceCatalogDigest: catalog.digest,
      totalToolCount: catalog.count,
      upstreamCatalogDigest: upstreamDigest,
      eligibleToolCount: eligibleTools.length,
      eligibleCatalogDigest,
      heldToolCount: catalog.count - eligibleTools.length,
    },
  };
}
