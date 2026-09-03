import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseSourceCatalog, type SourceCatalogSnapshot } from "@morrow/gateway-core";

export interface LegacyBridgeConfig {
  readonly catalogPath: string;
  readonly sourceCatalog: SourceCatalogSnapshot;
  readonly token: string;
  readonly port: number;
  readonly expectedRevision: string;
  readonly allowedExtensionIds: readonly string[];
}

function requiredEnvironment(name: string, environment: NodeJS.ProcessEnv): string {
  const value = String(environment[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function exactPort(value: string | undefined): number {
  if (!value) return 32145;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("MORROW_LEGACY_BRIDGE_PORT must be a whole number from 1 through 65535");
  }
  return parsed;
}

export async function loadLegacyBridgeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LegacyBridgeConfig> {
  const catalogPath = resolve(requiredEnvironment("MORROW_LEGACY_CATALOG_PATH", environment));
  const text = await readFile(catalogPath, "utf8");
  const sourceCatalog = parseSourceCatalog(JSON.parse(text) as unknown);
  if (sourceCatalog.source.id !== "example-legacy") {
    throw new Error("MORROW_LEGACY_CATALOG_PATH must contain the example-legacy source catalog");
  }
  const expectedRevision = String(
    environment.MORROW_LEGACY_EXPECTED_REVISION || sourceCatalog.source.revision || "",
  ).trim();
  if (!expectedRevision || sourceCatalog.source.revision !== expectedRevision) {
    throw new Error("Morrow legacy catalog revision does not match MORROW_LEGACY_EXPECTED_REVISION");
  }
  const token = requiredEnvironment("MORROW_LEGACY_BRIDGE_TOKEN", environment);
  if (token.length < 32 || token.length > 512) {
    throw new Error("MORROW_LEGACY_BRIDGE_TOKEN must contain 32 to 512 characters");
  }
  const allowedExtensionIds = String(environment.MORROW_LEGACY_ALLOWED_EXTENSION_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (allowedExtensionIds.some((value) => !/^[a-p]{32}$/.test(value))) {
    throw new Error("MORROW_LEGACY_ALLOWED_EXTENSION_IDS contains an invalid Chrome extension id");
  }
  return {
    catalogPath,
    sourceCatalog,
    token,
    port: exactPort(environment.MORROW_LEGACY_BRIDGE_PORT),
    expectedRevision,
    allowedExtensionIds,
  };
}
