import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonObject, type JsonObject, type JsonSchema, type SourceCapabilityMetadata, type UpstreamTool } from "@morrow/contracts";
import type { CanvasApiCatalog } from "@morrow/canvas-api-catalog";

export type BrowserCatalogProvider = "canvas" | "moodle";

export const BROWSER_CATALOG_DATA_CLASSES = ["public", "course", "learner"] as const;

export type BrowserCatalogDataClass = (typeof BROWSER_CATALOG_DATA_CLASSES)[number];

export interface BrowserCatalogOperation<Provider extends BrowserCatalogProvider> {
  readonly key: string;
  readonly toolName: string;
  readonly provider: Provider;
  readonly summary: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly reviewTool?: string;
  readonly destructive?: boolean;
  readonly irreversible?: boolean;
  readonly dataClass?: BrowserCatalogDataClass;
  readonly family?: string;
  /**
   * Marks an entry Morrow calls only for itself. The Gateway hides these tools
   * by name; `packages/mcp-server/test/moodle-private-tools.test.ts` holds the
   * marker and that list to the same set.
   */
  readonly morrowPrivate?: boolean;
  readonly inputSchema: JsonSchema;
  readonly documentation: string;
}

export type CanvasBrowserOperation = BrowserCatalogOperation<"canvas">;
export type MoodleBrowserOperation = BrowserCatalogOperation<"moodle">;

export interface BrowserCatalog<Provider extends BrowserCatalogProvider> {
  readonly schema: "morrow.browser-catalog.v1";
  readonly provider: Provider;
  readonly operations: readonly BrowserCatalogOperation<Provider>[];
  readonly rawDigest: string;
}

export type CanvasBrowserCatalog = BrowserCatalog<"canvas">;
export type MoodleBrowserCatalog = BrowserCatalog<"moodle">;

export const CANVAS_BROWSER_CATALOG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../connector/extension/generated/canvas-browser-catalog.json",
);

export const MOODLE_BROWSER_CATALOG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../connector/extension/generated/moodle-browser-catalog.json",
);

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value.trim();
}

function flag(value: unknown, label: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new TypeError(`${label} is invalid`);
  return value;
}

function dataClassOf(value: unknown, label: string): BrowserCatalogDataClass | undefined {
  if (value === undefined || value === null) return undefined;
  const known = BROWSER_CATALOG_DATA_CLASSES.find((entry) => entry === text(value, label, 40));
  if (!known) throw new TypeError(`${label} is invalid`);
  return known;
}

function operation<Provider extends BrowserCatalogProvider>(value: unknown, provider: Provider): BrowserCatalogOperation<Provider> {
  const label = provider === "canvas" ? "Canvas" : "Moodle";
  if (!isJsonObject(value)) throw new TypeError(`${label} browser catalog operation is invalid`);
  const key = text(value.key, `${label} browser catalog operation key`, 240);
  const toolName = text(value.toolName, `${label} browser catalog tool name`, 160);
  if (!/^[a-z][a-z0-9_]{1,159}$/.test(toolName) || !toolName.startsWith(`${provider}_`)) {
    throw new TypeError(`${label} browser catalog tool name is invalid`);
  }
  if (value.provider !== provider || typeof value.readOnly !== "boolean" || !isJsonObject(value.inputSchema)) {
    throw new TypeError(`${label} browser catalog operation is invalid`);
  }
  const reviewTool = value.reviewTool === undefined || value.reviewTool === null
    ? undefined
    : text(value.reviewTool, `${label} browser catalog reviewTool`, 160);
  if (!value.readOnly && !reviewTool) throw new TypeError(`${label} browser catalog writes require reviewTool`);
  const destructive = flag(value.destructive, `${label} browser catalog destructive`);
  const irreversible = flag(value.irreversible, `${label} browser catalog irreversible`);
  if (value.readOnly && (destructive || irreversible)) {
    throw new TypeError(`${label} browser catalog reads cannot be destructive or irreversible`);
  }
  const dataClass = dataClassOf(value.dataClass, `${label} browser catalog dataClass`);
  const family = value.family === undefined || value.family === null
    ? undefined
    : text(value.family, `${label} browser catalog family`, 80);
  const morrowPrivate = flag(value.morrowPrivate, `${label} browser catalog morrowPrivate`);
  return {
    key,
    toolName,
    provider,
    summary: text(value.summary, `${label} browser catalog summary`, 500),
    description: text(value.description, `${label} browser catalog description`, 10_000),
    readOnly: value.readOnly,
    ...(reviewTool ? { reviewTool } : {}),
    ...(destructive ? { destructive } : {}),
    ...(irreversible ? { irreversible } : {}),
    ...(dataClass ? { dataClass } : {}),
    ...(family ? { family } : {}),
    ...(morrowPrivate ? { morrowPrivate } : {}),
    inputSchema: structuredClone(value.inputSchema),
    documentation: text(value.documentation, `${label} browser catalog documentation`, 2_000),
  };
}

function parseBrowserCatalog<Provider extends BrowserCatalogProvider>(
  value: unknown,
  rawDigest: string,
  provider: Provider,
): BrowserCatalog<Provider> {
  const label = provider === "canvas" ? "Canvas" : "Moodle";
  if (!isJsonObject(value) || value.schema !== "morrow.browser-catalog.v1" || value.provider !== provider || !Array.isArray(value.operations)) {
    throw new TypeError(`${label} browser catalog is invalid`);
  }
  if (!/^[0-9a-f]{64}$/.test(rawDigest)) throw new TypeError(`${label} browser catalog digest is invalid`);
  const operations = value.operations.map((entry) => operation(entry, provider));
  const tools = new Set<string>();
  const keys = new Set<string>();
  for (const item of operations) {
    if (tools.has(item.toolName) || keys.has(item.key)) throw new TypeError(`${label} browser catalog has duplicate operations`);
    tools.add(item.toolName);
    keys.add(item.key);
  }
  for (const item of operations) {
    if (item.reviewTool && (!tools.has(item.reviewTool) || !operations.find((candidate) => candidate.toolName === item.reviewTool)?.readOnly)) {
      throw new TypeError(`${label} browser catalog reviewTool is invalid`);
    }
  }
  return { schema: "morrow.browser-catalog.v1", provider, operations, rawDigest };
}

export function parseCanvasBrowserCatalog(value: unknown, rawDigest: string): CanvasBrowserCatalog {
  return parseBrowserCatalog(value, rawDigest, "canvas");
}

export function parseMoodleBrowserCatalog(value: unknown, rawDigest: string): MoodleBrowserCatalog {
  return parseBrowserCatalog(value, rawDigest, "moodle");
}

export function loadCanvasBrowserCatalog(path = CANVAS_BROWSER_CATALOG_PATH): CanvasBrowserCatalog {
  const raw = readFileSync(path);
  return parseCanvasBrowserCatalog(JSON.parse(raw.toString("utf8")) as unknown, sha256(raw));
}

export function loadMoodleBrowserCatalog(path = MOODLE_BROWSER_CATALOG_PATH): MoodleBrowserCatalog {
  const raw = readFileSync(path);
  return parseMoodleBrowserCatalog(JSON.parse(raw.toString("utf8")) as unknown, sha256(raw));
}

export function bridgeCatalogDigest(
  canvasCatalog: CanvasApiCatalog,
  canvasBrowserCatalog: CanvasBrowserCatalog,
  moodleCatalog: MoodleBrowserCatalog,
): string {
  return sha256(`${canvasCatalog.catalogDigest}\n${canvasBrowserCatalog.rawDigest}\n${moodleCatalog.rawDigest}`);
}

function capability<Provider extends BrowserCatalogProvider>(
  operation: BrowserCatalogOperation<Provider>,
  catalog: BrowserCatalog<Provider>,
): SourceCapabilityMetadata {
  const canvas = operation.provider === "canvas";
  const destructive = operation.destructive === true;
  return {
    family: operation.family || (canvas ? "assessment-summary" : "course-content"),
    provider: operation.provider,
    sourcePath: canvas
      ? "connector/extension/generated/canvas-browser-catalog.json"
      : "connector/extension/generated/moodle-browser-catalog.json",
    sourceExport: operation.key,
    sourceDigest: catalog.rawDigest,
    behavior: {
      readOnly: operation.readOnly,
      mutating: !operation.readOnly,
      destructive,
      irreversible: operation.irreversible === true,
      supportsDryRun: false,
      supportsReadback: true,
      supportsUndo: false,
      supportsBatch: false,
      requiresBrowser: true,
      requiresLiveCanvas: canvas,
    },
    authority: {
      scopeClass: "course",
      approvalClass: operation.readOnly ? "none" : destructive ? "destructive" : "standard",
      dataClass: operation.dataClass || (canvas ? "learner" : "course"),
    },
    route: {
      backend: "canvas-connector",
      ...(operation.reviewTool ? { planBackend: operation.reviewTool } : {}),
      dispatchBackend: "chrome-session-connector",
      readbackBackend: "chrome-session-connector",
      comparator: "exact-requested-fields",
    },
    profiles: {
      "private-full": { state: "supported" },
      "public-canvas": { state: "profile_limited", reason: `This action requires a signed-in ${canvas ? "Canvas" : "Moodle"} session.` },
      sandbox: { state: "profile_limited", reason: `This action requires a signed-in ${canvas ? "Canvas" : "Moodle"} session.` },
      "read-only": { state: "profile_limited", reason: `This action requires a signed-in ${canvas ? "Canvas" : "Moodle"} session.` },
    },
    evidence: {
      transport: { state: "known" },
      credentialBoundary: { state: "known" },
    },
  };
}

function browserCatalogTools<Provider extends BrowserCatalogProvider>(catalog: BrowserCatalog<Provider>): readonly UpstreamTool[] {
  return catalog.operations.map((operation) => ({
    name: operation.toolName,
    title: operation.summary,
    description: operation.description,
    inputSchema: operation.inputSchema,
    annotations: {
      readOnlyHint: operation.readOnly,
      destructiveHint: operation.destructive === true,
      idempotentHint: operation.readOnly,
      openWorldHint: true,
    },
    capability: capability(operation, catalog),
  }));
}

export function canvasBrowserCatalogTools(catalog: CanvasBrowserCatalog): readonly UpstreamTool[] {
  return browserCatalogTools(catalog);
}

export function moodleCatalogTools(catalog: MoodleBrowserCatalog): readonly UpstreamTool[] {
  return browserCatalogTools(catalog);
}
