import { readFileSync } from "node:fs";
import { isJsonObject, sha256Json, type JsonObject, type JsonSchema, type SourceCapabilityMetadata, type UpstreamTool } from "@morrow/contracts";

export type CanvasApiService = "canvas" | "item_bank";
export type CanvasApiRisk = "read" | "write" | "sensitive_write" | "destructive";
export type CanvasParameterLocation = "path" | "query" | "form";

export interface CanvasApiParameter {
  readonly inputName: string;
  readonly wireName: string;
  readonly location: CanvasParameterLocation;
  readonly required: boolean;
  readonly deprecated: boolean;
  readonly schema: JsonSchema;
}

export interface CanvasApiOperation {
  readonly key: string;
  readonly toolName: string;
  readonly source: string;
  readonly service: CanvasApiService;
  readonly resource: string;
  readonly family: string;
  readonly nickname: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly summary: string;
  readonly description: string;
  readonly deprecated: boolean;
  readonly risk: CanvasApiRisk;
  readonly readOnly: boolean;
  readonly parameters: readonly CanvasApiParameter[];
  readonly inputSchema: JsonSchema;
  readonly responseType: string;
}

export interface CanvasApiCatalog {
  readonly schema: "morrow.canvas-api-catalog.v1";
  readonly source: {
    readonly indexUrl: string;
    readonly swaggerVersion: string;
    readonly apiVersion: string;
    readonly resourceCount: number;
    readonly sourceDigest: string;
    readonly lastModified: string | null;
  };
  readonly counts: {
    readonly officialOperations: number;
    readonly browserSessionOperations: number;
    readonly totalOperations: number;
    readonly newQuizzesOperations: number;
    readonly itemBankOperations: number;
    readonly reads: number;
    readonly writes: number;
  };
  readonly operations: readonly CanvasApiOperation[];
  readonly catalogDigest: string;
}

function exactCatalog(value: unknown): CanvasApiCatalog {
  if (!isJsonObject(value) || value.schema !== "morrow.canvas-api-catalog.v1") {
    throw new TypeError("Expected morrow.canvas-api-catalog.v1");
  }
  if (!Array.isArray(value.operations) || !isJsonObject(value.counts) || !isJsonObject(value.source)) {
    throw new TypeError("Canvas API catalog is incomplete");
  }
  if (!/^[0-9a-f]{64}$/.test(String(value.catalogDigest || ""))) {
    throw new TypeError("Canvas API catalog digest is invalid");
  }
  const { catalogDigest, ...body } = value;
  if (sha256Json(body) !== catalogDigest) throw new Error("Canvas API catalog digest does not match its content");
  if (value.counts.totalOperations !== value.operations.length) throw new Error("Canvas API catalog count is invalid");
  const names = new Set<string>();
  const keys = new Set<string>();
  for (const raw of value.operations) {
    if (!isJsonObject(raw) || typeof raw.toolName !== "string" || typeof raw.key !== "string") {
      throw new TypeError("Canvas API catalog contains an invalid operation");
    }
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(raw.toolName)) throw new TypeError(`Invalid Canvas tool name ${raw.toolName}`);
    if (names.has(raw.toolName) || keys.has(raw.key)) throw new Error(`Duplicate Canvas operation ${raw.key}`);
    names.add(raw.toolName);
    keys.add(raw.key);
  }
  return structuredClone(value) as unknown as CanvasApiCatalog;
}

export function parseCanvasApiCatalog(value: unknown): CanvasApiCatalog {
  return exactCatalog(value);
}

export function loadCanvasApiCatalog(path: string): CanvasApiCatalog {
  return exactCatalog(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function canvasOperationMap(catalog: CanvasApiCatalog): ReadonlyMap<string, CanvasApiOperation> {
  return new Map(catalog.operations.map((operation) => [operation.toolName, operation]));
}

function capability(operation: CanvasApiOperation): SourceCapabilityMetadata {
  const destructive = operation.risk === "destructive";
  const profile = operation.service === "item_bank" && !operation.readOnly && operation.nickname !== "create_bank"
    ? { state: "profile_limited" as const, reason: "Existing Item Bank mutations require complete dependency and affected-course evidence that is not yet available." }
    : { state: "supported" as const };
  return {
    family: operation.family,
    provider: "canvas",
    sourcePath: operation.source === "canvas-official-swagger-1.2" ? operation.path : "connector/extension/src/item-bank-executor.js",
    sourceExport: operation.key,
    sourceDigest: sha256Json({ key: operation.key, method: operation.method, path: operation.path, parameters: operation.parameters }),
    behavior: {
      readOnly: operation.readOnly,
      mutating: !operation.readOnly,
      destructive,
      irreversible: destructive,
      supportsDryRun: !operation.readOnly,
      supportsReadback: true,
      supportsUndo: false,
      supportsBatch: true,
      requiresBrowser: true,
      requiresLiveCanvas: true,
    },
    authority: {
      scopeClass: operation.path.includes("{account_id}") ? "account" : operation.path.includes("{course_id}") ? "course" : "canvas-session",
      approvalClass: operation.readOnly ? "none" : destructive ? "destructive" : /(?:grade|score|submission)/i.test(operation.key) ? "grade" : "standard",
      dataClass: /(?:user|student|enrollment|submission|grade)/i.test(operation.key) ? "learner" : "course",
    },
    route: {
      backend: "canvas-connector",
      dispatchBackend: "chrome-session-connector",
      readbackBackend: "chrome-session-connector",
      comparator: "frozen-json-digest",
    },
    profiles: {
      "private-full": profile,
      "public-canvas": profile,
      sandbox: { state: "profile_limited", reason: "The live connector is replaced by the synthetic Canvas estate." },
      "read-only": operation.readOnly
        ? { state: "supported" }
        : { state: "profile_limited", reason: "The read-only profile does not admit provider writes." },
    },
    evidence: {
      transport: { state: "known" },
      credentialBoundary: { state: "known" },
    },
  };
}

export function canvasCatalogTools(catalog: CanvasApiCatalog): readonly UpstreamTool[] {
  return catalog.operations.map((operation) => ({
    name: operation.toolName,
    title: operation.summary,
    description: operation.description,
    inputSchema: operation.inputSchema,
    annotations: {
      readOnlyHint: operation.readOnly,
      destructiveHint: operation.risk === "destructive",
      idempotentHint: operation.method === "GET" || ["PUT", "PATCH", "DELETE"].includes(operation.method),
      openWorldHint: true,
    },
    capability: capability(operation),
  }));
}

export function operationArguments(operation: CanvasApiOperation, input: JsonObject): {
  readonly path: string;
  readonly query: readonly [string, unknown][];
  readonly body: readonly [string, unknown][];
} {
  let path = operation.path;
  const query: [string, unknown][] = [];
  const body: [string, unknown][] = [];
  for (const parameter of operation.parameters) {
    const value = input[parameter.inputName];
    if (value === undefined || value === null || value === "") {
      if (parameter.required) throw new TypeError(`${parameter.inputName} is required`);
      continue;
    }
    if (parameter.location === "path") {
      path = path.replace(`{${parameter.wireName}}`, encodeURIComponent(String(value)));
    } else if (parameter.location === "query") {
      query.push([parameter.wireName, value]);
    } else {
      body.push([parameter.wireName, value]);
    }
  }
  if (/\{[^}]+\}/.test(path)) throw new TypeError("Canvas path has unresolved parameters");
  return { path, query, body };
}
