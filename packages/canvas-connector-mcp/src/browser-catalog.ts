import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonObject, sha256Json, type JsonObject, type JsonSchema, type SourceCapabilityMetadata, type UpstreamTool } from "@morrow/contracts";
import { canvasApiCompatibilityDigest, operationalJsonSchema, readExactCatalogBytes, type CanvasApiCatalog } from "@morrow/canvas-api-catalog";

export type BrowserCatalogProvider = "canvas" | "moodle";

export const BROWSER_CATALOG_DATA_CLASSES = ["public", "course", "learner"] as const;
export const MAX_MOODLE_JSON_INTEGER = Number.MAX_SAFE_INTEGER;
export const PRIVATE_BRIDGE_COMPATIBILITY_SCHEMA = "morrow.private-bridge-compatibility.v1";

const PRIVATE_MOODLE_STAGED_CREATE_ARGUMENTS = ["course_id", "section_id", "name", "filename", "size_bytes", "sha256", "expected_digest"] as const;
const PRIVATE_MOODLE_STAGED_REPLACE_ARGUMENTS = ["course_id", "module_id", "filename", "size_bytes", "sha256", "expected_digest"] as const;
export const PRIVATE_BRIDGE_OPERATION_CONTRACTS = Object.freeze([
  { kind: "moodle_staged_file", toolName: "moodle_create_resource_file", key: "moodle.form.course.modedit.resource.file.create.write.v1", argumentNames: PRIVATE_MOODLE_STAGED_CREATE_ARGUMENTS, attachmentMode: "single" },
  { kind: "moodle_staged_file", toolName: "moodle_create_folder_file", key: "moodle.form.course.modedit.folder.file.create.write.v1", argumentNames: PRIVATE_MOODLE_STAGED_CREATE_ARGUMENTS, attachmentMode: "single" },
  { kind: "moodle_staged_file", toolName: "moodle_create_imscp_package", key: "moodle.form.course.modedit.imscp.package.create.write.v1", argumentNames: PRIVATE_MOODLE_STAGED_CREATE_ARGUMENTS, attachmentMode: "single" },
  { kind: "moodle_staged_file", toolName: "moodle_create_scorm_package", key: "moodle.form.course.modedit.scorm.package.create.write.v1", argumentNames: PRIVATE_MOODLE_STAGED_CREATE_ARGUMENTS, attachmentMode: "single" },
  { kind: "moodle_staged_file", toolName: "moodle_replace_resource_file", key: "moodle.form.course.modedit.resource.file.replace.write.v1", argumentNames: PRIVATE_MOODLE_STAGED_REPLACE_ARGUMENTS, attachmentMode: "single" },
  { kind: "moodle_staged_file", toolName: "moodle_replace_scorm_package", key: "moodle.form.course.modedit.scorm.package.replace.write.v1", argumentNames: PRIVATE_MOODLE_STAGED_REPLACE_ARGUMENTS, attachmentMode: "single" },
  { kind: "moodle_staged_file", toolName: "moodle_replace_h5pactivity_package", key: "moodle.form.course.modedit.h5pactivity.package.replace.write.v1", argumentNames: PRIVATE_MOODLE_STAGED_REPLACE_ARGUMENTS, attachmentMode: "single" },
  { kind: "moodle_staged_file", toolName: "moodle_add_folder_files", key: "moodle.form.course.modedit.folder.files.add.write.v1", argumentNames: ["course_id", "module_id", "folder_path", "files", "expected_digest"], attachmentMode: "multiple" },
  { kind: "moodle_staged_file", toolName: "moodle_create_h5pactivity", key: "moodle.form.course.modedit.h5pactivity.create.write.v1", argumentNames: PRIVATE_MOODLE_STAGED_CREATE_ARGUMENTS, attachmentMode: "single" },
  {
    kind: "canvas_private_operation", toolName: "canvas_transfer_course_file", key: "canvas.private.course_file.transfer.v1",
    provider: "canvas", readOnly: false, service: "canvas_file_transfer", path: "/v1/courses/{course_id}/folders/{folder_id}/files",
    argumentNames: ["course_id", "folder_id", "filename", "size_bytes", "sha256", "content_type"], attachmentMode: "single",
  },
  {
    kind: "canvas_private_operation", toolName: "canvas_create_new_quiz_hot_spot", key: "canvas.private.new_quiz.hot_spot.create.v1",
    provider: "canvas", readOnly: false, method: "POST", service: "canvas_new_quiz_hot_spot",
    path: "/quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items",
    argumentNames: ["course_id", "assignment_id", "item", "before_items_sha256", "payload_sha256", "filename", "size_bytes", "sha256", "content_type"],
    attachmentMode: "single", contentTypes: ["image/png", "image/jpeg", "image/gif"],
  },
  {
    kind: "canvas_private_operation", toolName: "canvas_send_private_conversation", key: "canvas.private.conversation.send.v1",
    provider: "canvas", readOnly: false, method: "POST", service: "canvas_private_conversation",
    path: "/morrow/private/courses/{course_id}/conversations", argumentNames: ["course_id"],
    privatePayloadSchema: "morrow.canvas-conversation.private.v1",
  },
  {
    kind: "moodle_private_operation", toolName: "morrow_private_moodle_find_enrolment_candidate", key: "moodle.private.enrolment_candidate.find.v1",
    provider: "moodle", readOnly: true, method: "GET", service: "moodle_private_enrolment_candidate",
    path: "/enrol/manual/manage.php", argumentNames: ["course_id", "query"], resultSchema: "morrow.moodle-enrolment-candidate.private.v1",
  },
] as const);

export function privateBridgeCompatibilityContract(): JsonObject {
  return { schema: PRIVATE_BRIDGE_COMPATIBILITY_SCHEMA, operations: structuredClone(PRIVATE_BRIDGE_OPERATION_CONTRACTS) } as unknown as JsonObject;
}

export function privateBridgeCompatibilityDigest(): string {
  return sha256Json(privateBridgeCompatibilityContract());
}

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
  readonly compatibilityDigest: string;
}

export type CanvasBrowserCatalog = BrowserCatalog<"canvas">;
export type MoodleBrowserCatalog = BrowserCatalog<"moodle">;
type BrowserCatalogCompatibilitySource<Provider extends BrowserCatalogProvider> = Pick<BrowserCatalog<Provider>, "provider" | "operations">;

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

function assertExactMoodleIntegerSchemas(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertExactMoodleIntegerSchemas(entry, label);
    return;
  }
  if (!isJsonObject(value)) return;
  if (value.type === "integer") {
    if (Array.isArray(value.enum)) {
      if (!value.enum.every((entry) => Number.isSafeInteger(entry))) {
        throw new TypeError(`${label} has an integer enum outside JavaScript's exact integer range`);
      }
    } else if (typeof value.maximum !== "number" || !Number.isSafeInteger(value.maximum) || value.maximum > MAX_MOODLE_JSON_INTEGER
      || (value.minimum !== undefined && (typeof value.minimum !== "number" || !Number.isSafeInteger(value.minimum)))) {
      throw new TypeError(`${label} has an unbounded or inexact integer schema`);
    }
  }
  for (const entry of Object.values(value)) assertExactMoodleIntegerSchemas(entry, label);
}

export function moodleArgumentsUseExactIntegers(schema: JsonSchema, value: unknown): boolean {
  if (!isJsonObject(schema)) return true;
  if (schema.type === "integer") return value === undefined || (typeof value === "number" && Number.isSafeInteger(value));
  if (schema.type === "array" && Array.isArray(value) && isJsonObject(schema.items)) {
    return value.every((entry) => moodleArgumentsUseExactIntegers(schema.items as JsonSchema, entry));
  }
  if (schema.type === "object" && isJsonObject(value) && isJsonObject(schema.properties)) {
    return Object.entries(schema.properties).every(([name, propertySchema]) => !Object.hasOwn(value, name)
      || moodleArgumentsUseExactIntegers(propertySchema as JsonSchema, value[name]));
  }
  return true;
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
  if (provider === "moodle") assertExactMoodleIntegerSchemas(value.inputSchema, `${label} browser catalog operation ${toolName}`);
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
  const compatibilityDigest = browserCatalogCompatibilityDigest({ provider, operations });
  return { schema: "morrow.browser-catalog.v1", provider, operations, rawDigest, compatibilityDigest };
}

export const BROWSER_CATALOG_COMPATIBILITY_SCHEMA = "morrow.browser-catalog-compatibility.v1";
export const BRIDGE_CATALOG_COMPATIBILITY_SCHEMA = "morrow.bridge-catalog-compatibility.v2";

/** The browser-catalog fields that can change admission, dispatch, or readback. */
export function browserCatalogCompatibilityContract<Provider extends BrowserCatalogProvider>(
  catalog: BrowserCatalogCompatibilitySource<Provider>,
): JsonObject {
  return {
    schema: BROWSER_CATALOG_COMPATIBILITY_SCHEMA,
    provider: catalog.provider,
    operations: catalog.operations.map((operation) => ({
      key: operation.key,
      toolName: operation.toolName,
      provider: operation.provider,
      readOnly: operation.readOnly,
      reviewTool: operation.reviewTool ?? null,
      destructive: operation.destructive === true,
      irreversible: operation.irreversible === true,
      dataClass: operation.dataClass ?? null,
      family: operation.family ?? null,
      morrowPrivate: operation.morrowPrivate === true,
      inputSchema: operationalJsonSchema(operation.inputSchema),
    })),
  };
}

export function browserCatalogCompatibilityDigest<Provider extends BrowserCatalogProvider>(
  catalog: BrowserCatalogCompatibilitySource<Provider>,
): string {
  return sha256Json(browserCatalogCompatibilityContract(catalog));
}

export function parseCanvasBrowserCatalog(value: unknown, rawDigest: string): CanvasBrowserCatalog {
  return parseBrowserCatalog(value, rawDigest, "canvas");
}

export function parseMoodleBrowserCatalog(value: unknown, rawDigest: string): MoodleBrowserCatalog {
  return parseBrowserCatalog(value, rawDigest, "moodle");
}

export function loadCanvasBrowserCatalog(path = CANVAS_BROWSER_CATALOG_PATH): CanvasBrowserCatalog {
  const catalog = readExactCatalogBytes(path, "Canvas browser catalog");
  return parseCanvasBrowserCatalog(JSON.parse(catalog.text) as unknown, sha256(catalog.bytes));
}

export function loadMoodleBrowserCatalog(path = MOODLE_BROWSER_CATALOG_PATH): MoodleBrowserCatalog {
  const catalog = readExactCatalogBytes(path, "Moodle browser catalog");
  return parseMoodleBrowserCatalog(JSON.parse(catalog.text) as unknown, sha256(catalog.bytes));
}

export function bridgeCatalogDigest(
  canvasCatalog: CanvasApiCatalog,
  canvasBrowserCatalog: CanvasBrowserCatalog,
  moodleCatalog: MoodleBrowserCatalog,
): string {
  return sha256Json({
    schema: BRIDGE_CATALOG_COMPATIBILITY_SCHEMA,
    canvasApi: canvasApiCompatibilityDigest(canvasCatalog),
    canvasBrowser: canvasBrowserCatalog.compatibilityDigest,
    moodleBrowser: moodleCatalog.compatibilityDigest,
    privateCommands: privateBridgeCompatibilityDigest(),
  });
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
