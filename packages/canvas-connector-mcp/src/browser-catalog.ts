import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonObject, type JsonObject, type JsonSchema, type SourceCapabilityMetadata, type UpstreamTool } from "@morrow/contracts";
import type { CanvasApiCatalog } from "@morrow/canvas-api-catalog";

export interface MoodleBrowserOperation {
  readonly key: string;
  readonly toolName: string;
  readonly provider: "moodle";
  readonly summary: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly reviewTool?: string;
  readonly inputSchema: JsonSchema;
  readonly documentation: string;
}

export interface MoodleBrowserCatalog {
  readonly schema: "morrow.browser-catalog.v1";
  readonly provider: "moodle";
  readonly operations: readonly MoodleBrowserOperation[];
  readonly rawDigest: string;
}

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

function operation(value: unknown): MoodleBrowserOperation {
  if (!isJsonObject(value)) throw new TypeError("Moodle browser catalog operation is invalid");
  const key = text(value.key, "Moodle browser catalog operation key", 240);
  const toolName = text(value.toolName, "Moodle browser catalog tool name", 160);
  if (!/^[a-z][a-z0-9_]{1,159}$/.test(toolName) || !toolName.startsWith("moodle_")) {
    throw new TypeError("Moodle browser catalog tool name is invalid");
  }
  if (value.provider !== "moodle" || typeof value.readOnly !== "boolean" || !isJsonObject(value.inputSchema)) {
    throw new TypeError("Moodle browser catalog operation is invalid");
  }
  const reviewTool = value.reviewTool === undefined || value.reviewTool === null
    ? undefined
    : text(value.reviewTool, "Moodle browser catalog reviewTool", 160);
  if (!value.readOnly && !reviewTool) throw new TypeError("Moodle browser catalog writes require reviewTool");
  return {
    key,
    toolName,
    provider: "moodle",
    summary: text(value.summary, "Moodle browser catalog summary", 500),
    description: text(value.description, "Moodle browser catalog description", 10_000),
    readOnly: value.readOnly,
    ...(reviewTool ? { reviewTool } : {}),
    inputSchema: structuredClone(value.inputSchema),
    documentation: text(value.documentation, "Moodle browser catalog documentation", 2_000),
  };
}

export function parseMoodleBrowserCatalog(value: unknown, rawDigest: string): MoodleBrowserCatalog {
  if (!isJsonObject(value) || value.schema !== "morrow.browser-catalog.v1" || value.provider !== "moodle" || !Array.isArray(value.operations)) {
    throw new TypeError("Moodle browser catalog is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(rawDigest)) throw new TypeError("Moodle browser catalog digest is invalid");
  const operations = value.operations.map(operation);
  const tools = new Set<string>();
  const keys = new Set<string>();
  for (const item of operations) {
    if (tools.has(item.toolName) || keys.has(item.key)) throw new TypeError("Moodle browser catalog has duplicate operations");
    tools.add(item.toolName);
    keys.add(item.key);
  }
  for (const item of operations) {
    if (item.reviewTool && (!tools.has(item.reviewTool) || !operations.find((candidate) => candidate.toolName === item.reviewTool)?.readOnly)) {
      throw new TypeError("Moodle browser catalog reviewTool is invalid");
    }
  }
  return { schema: "morrow.browser-catalog.v1", provider: "moodle", operations, rawDigest };
}

export function loadMoodleBrowserCatalog(path = MOODLE_BROWSER_CATALOG_PATH): MoodleBrowserCatalog {
  const raw = readFileSync(path);
  return parseMoodleBrowserCatalog(JSON.parse(raw.toString("utf8")) as unknown, sha256(raw));
}

export function bridgeCatalogDigest(canvasCatalog: CanvasApiCatalog, moodleCatalog: MoodleBrowserCatalog): string {
  return sha256(`${canvasCatalog.catalogDigest}\n${moodleCatalog.rawDigest}`);
}

function capability(operation: MoodleBrowserOperation, catalog: MoodleBrowserCatalog): SourceCapabilityMetadata {
  return {
    family: "course-content",
    provider: "moodle",
    sourcePath: "connector/extension/generated/moodle-browser-catalog.json",
    sourceExport: operation.key,
    sourceDigest: catalog.rawDigest,
    behavior: {
      readOnly: operation.readOnly,
      mutating: !operation.readOnly,
      destructive: false,
      irreversible: false,
      supportsDryRun: false,
      supportsReadback: true,
      supportsUndo: false,
      supportsBatch: false,
      requiresBrowser: true,
      requiresLiveCanvas: false,
    },
    authority: {
      scopeClass: "course",
      approvalClass: operation.readOnly ? "none" : "standard",
      dataClass: "course",
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
      "public-canvas": { state: "profile_limited", reason: "This action requires a signed-in Moodle session." },
      sandbox: { state: "profile_limited", reason: "This action requires a signed-in Moodle session." },
      "read-only": { state: "profile_limited", reason: "This action requires a signed-in Moodle session." },
    },
    evidence: {
      transport: { state: "known" },
      credentialBoundary: { state: "known" },
    },
  };
}

export function moodleCatalogTools(catalog: MoodleBrowserCatalog): readonly UpstreamTool[] {
  return catalog.operations.map((operation) => ({
    name: operation.toolName,
    title: operation.summary,
    description: operation.description,
    inputSchema: operation.inputSchema,
    annotations: {
      readOnlyHint: operation.readOnly,
      destructiveHint: false,
      idempotentHint: operation.readOnly,
      openWorldHint: true,
    },
    capability: capability(operation, catalog),
  }));
}
