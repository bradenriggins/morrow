export const CANVAS_API_COMPATIBILITY_SCHEMA = "morrow.canvas-api-compatibility.v1";
export const BROWSER_CATALOG_COMPATIBILITY_SCHEMA = "morrow.browser-catalog-compatibility.v1";
export const BRIDGE_CATALOG_COMPATIBILITY_SCHEMA = "morrow.bridge-catalog-compatibility.v2";
export const PRIVATE_BRIDGE_COMPATIBILITY_SCHEMA = "morrow.private-bridge-compatibility.v1";
const PRIVATE_MOODLE_STAGED_CREATE_ARGUMENTS = ["course_id", "section_id", "name", "filename", "size_bytes", "sha256", "expected_digest"];
const PRIVATE_MOODLE_STAGED_REPLACE_ARGUMENTS = ["course_id", "module_id", "filename", "size_bytes", "sha256", "expected_digest"];
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
  { kind: "canvas_private_operation", toolName: "canvas_transfer_course_file", key: "canvas.private.course_file.transfer.v1", provider: "canvas", readOnly: false, service: "canvas_file_transfer", path: "/v1/courses/{course_id}/uploads", argumentNames: ["course_id", "upload_tool", "upload_arguments", "filename", "size_bytes", "sha256", "content_type"], attachmentMode: "single" },
  { kind: "canvas_private_operation", toolName: "canvas_create_new_quiz_hot_spot", key: "canvas.private.new_quiz.hot_spot.create.v1", provider: "canvas", readOnly: false, method: "POST", service: "canvas_new_quiz_hot_spot", path: "/quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items", argumentNames: ["course_id", "assignment_id", "item", "before_items_sha256", "payload_sha256", "filename", "size_bytes", "sha256", "content_type"], attachmentMode: "single", contentTypes: ["image/png", "image/jpeg", "image/gif"] },
  { kind: "canvas_private_operation", toolName: "canvas_send_private_conversation", key: "canvas.private.conversation.send.v1", provider: "canvas", readOnly: false, method: "POST", service: "canvas_private_conversation", path: "/morrow/private/courses/{course_id}/conversations", argumentNames: ["course_id"], privatePayloadSchema: "morrow.canvas-conversation.private.v1" },
  { kind: "moodle_private_operation", toolName: "morrow_private_moodle_find_enrolment_candidate", key: "moodle.private.enrolment_candidate.find.v1", provider: "moodle", readOnly: true, method: "GET", service: "moodle_private_enrolment_candidate", path: "/enrol/manual/manage.php", argumentNames: ["course_id", "query"], resultSchema: "morrow.moodle-enrolment-candidate.private.v1" },
]);

const JSON_SCHEMA_ANNOTATION_KEYS = new Set(["$comment", "description", "examples", "title"]);
const JSON_SCHEMA_MAP_KEYS = new Set(["$defs", "definitions", "dependentSchemas", "patternProperties", "properties"]);
const JSON_SCHEMA_ARRAY_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const JSON_SCHEMA_SINGLE_KEYS = new Set([
  "additionalItems", "additionalProperties", "contains", "contentSchema", "else", "if", "items", "not",
  "propertyNames", "then", "unevaluatedItems", "unevaluatedProperties",
]);
const BROWSER_CATALOG_DATA_CLASSES = new Set(["public", "course", "learner"]);
const MAX_MOODLE_JSON_INTEGER = Number.MAX_SAFE_INTEGER;
export const MAX_PUBLIC_CATALOG_BYTES = 16 * 1024 * 1024;
export const MAX_PUBLIC_CATALOG_DEPTH = 64;
export const PUBLIC_CATALOG_TIMEOUT_MS = 10_000;

const CANVAS_CATALOG_KEYS = ["catalogDigest", "counts", "operations", "schema", "source"];
const CANVAS_COUNT_KEYS = [
  "browserSessionOperations", "courseFileContentOperations", "itemBankOperations", "newQuizzesOperations",
  "officialOperations", "reads", "totalOperations", "writes",
];
const CANVAS_SOURCE_KEYS = ["apiVersion", "indexUrl", "resourceCount", "sourceDigest", "swaggerVersion"];
const CANVAS_OPERATION_KEYS = [
  "deprecated", "description", "family", "inputSchema", "key", "method", "nickname", "parameters", "path",
  "readOnly", "resource", "responseType", "risk", "service", "source", "summary", "toolName",
];
const CANVAS_PARAMETER_KEYS = ["deprecated", "inputName", "location", "required", "schema", "wireName"];
const BROWSER_CATALOG_KEYS = ["operations", "provider", "schema"];
const BROWSER_OPERATION_KEYS = [
  "dataClass", "description", "destructive", "documentation", "family", "inputSchema", "irreversible", "key",
  "morrowPrivate", "provider", "readOnly", "reviewTool", "summary", "toolName",
];

function jsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!jsonObject(value)) throw new TypeError(`${label} is invalid`);
  const keys = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) {
    throw new TypeError(`${label} is invalid`);
  }
}

function allowedKeys(value, allowed, label) {
  if (!jsonObject(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError(`${label} is invalid`);
  }
}

function exactJsonDepth(text) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > MAX_PUBLIC_CATALOG_DEPTH) throw new TypeError("Catalog JSON is too deeply nested");
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth < 0) throw new TypeError("Catalog JSON is invalid");
    }
  }
  if (quoted || escaped || depth !== 0) throw new TypeError("Catalog JSON is invalid");
}

function abortableCatalogRead(operation, signal, label) {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(new TypeError(`${label} response timed out`));
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new TypeError(`${label} response timed out`));
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

export async function boundedCatalogText(response, label = "Catalog", { signal } = {}) {
  if (!response?.ok || !response.body || typeof response.body.getReader !== "function") {
    try { const cancellation = response?.body?.cancel?.(); if (cancellation && typeof cancellation.catch === "function") void cancellation.catch(() => {}); } catch {}
    throw new TypeError(`${label} response is invalid`);
  }
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined
    && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_PUBLIC_CATALOG_BYTES)) {
      try { const cancellation = response?.body?.cancel?.(); if (cancellation && typeof cancellation.catch === "function") void cancellation.catch(() => {}); } catch {}
    throw new TypeError(`${label} response is too large`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await abortableCatalogRead(reader.read(), signal, label);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new TypeError(`${label} response is invalid`);
      length += value.byteLength;
      if (length > MAX_PUBLIC_CATALOG_BYTES) throw new TypeError(`${label} response is too large`);
      chunks.push(value);
    }
  } catch (error) {
    try { void reader.cancel().catch(() => {}); } catch {}
    throw error;
  } finally {
    try { reader.releaseLock?.(); } catch {}
  }
  if (length < 1) throw new TypeError(`${label} response is invalid`);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new TypeError(`${label} must contain strict UTF-8`); }
  exactJsonDepth(text);
  return text;
}

export async function fetchBoundedCatalogText(input, label = "Catalog", {
  fetchImplementation = fetch,
  timeoutMs = PUBLIC_CATALOG_TIMEOUT_MS,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError(`${label} timeout is invalid`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await abortableCatalogRead(Promise.resolve(fetchImplementation(input, {
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    })), controller.signal, label);
    return await boundedCatalogText(response, label, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new TypeError(`${label} response timed out`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function catalogText(value, label, maximum) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new TypeError(`${label} is invalid`);
  return value.trim();
}

function catalogFlag(value, label) {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new TypeError(`${label} is invalid`);
  return value;
}

function browserCatalogDataClass(value, label) {
  if (value === undefined || value === null) return undefined;
  const normalized = catalogText(value, label, 40);
  if (!BROWSER_CATALOG_DATA_CLASSES.has(normalized)) throw new TypeError(`${label} is invalid`);
  return normalized;
}

function assertExactMoodleIntegerSchemas(value, label) {
  if (Array.isArray(value)) {
    for (const entry of value) assertExactMoodleIntegerSchemas(entry, label);
    return;
  }
  if (!jsonObject(value)) return;
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

function normalizedBrowserCatalogOperation(value, provider) {
  const label = provider === "canvas" ? "Canvas" : "Moodle";
  if (!jsonObject(value)) throw new TypeError(`${label} browser catalog operation is invalid`);
  const key = catalogText(value.key, `${label} browser catalog operation key`, 240);
  const toolName = catalogText(value.toolName, `${label} browser catalog tool name`, 160);
  if (!/^[a-z][a-z0-9_]{1,159}$/.test(toolName) || !toolName.startsWith(`${provider}_`)) {
    throw new TypeError(`${label} browser catalog tool name is invalid`);
  }
  if (value.provider !== provider || typeof value.readOnly !== "boolean" || !jsonObject(value.inputSchema)) {
    throw new TypeError(`${label} browser catalog operation is invalid`);
  }
  if (provider === "moodle") assertExactMoodleIntegerSchemas(value.inputSchema, `${label} browser catalog operation ${toolName}`);
  const reviewTool = value.reviewTool === undefined || value.reviewTool === null
    ? undefined
    : catalogText(value.reviewTool, `${label} browser catalog reviewTool`, 160);
  if (!value.readOnly && !reviewTool) throw new TypeError(`${label} browser catalog writes require reviewTool`);
  const destructive = catalogFlag(value.destructive, `${label} browser catalog destructive`);
  const irreversible = catalogFlag(value.irreversible, `${label} browser catalog irreversible`);
  if (value.readOnly && (destructive || irreversible)) {
    throw new TypeError(`${label} browser catalog reads cannot be destructive or irreversible`);
  }
  const dataClass = browserCatalogDataClass(value.dataClass, `${label} browser catalog dataClass`);
  const family = value.family === undefined || value.family === null
    ? undefined
    : catalogText(value.family, `${label} browser catalog family`, 80);
  const morrowPrivate = catalogFlag(value.morrowPrivate, `${label} browser catalog morrowPrivate`);
  allowedKeys(value, BROWSER_OPERATION_KEYS, `${label} browser catalog operation`);
  return {
    key,
    toolName,
    provider,
    summary: catalogText(value.summary, `${label} browser catalog summary`, 500),
    description: catalogText(value.description, `${label} browser catalog description`, 10_000),
    readOnly: value.readOnly,
    ...(reviewTool ? { reviewTool } : {}),
    ...(destructive ? { destructive } : {}),
    ...(irreversible ? { irreversible } : {}),
    ...(dataClass ? { dataClass } : {}),
    ...(family ? { family } : {}),
    ...(morrowPrivate ? { morrowPrivate } : {}),
    inputSchema: structuredClone(value.inputSchema),
    documentation: catalogText(value.documentation, `${label} browser catalog documentation`, 2_000),
  };
}

export function normalizedBrowserCatalog(catalog, expectedProvider = undefined) {
  if (!jsonObject(catalog) || catalog.schema !== "morrow.browser-catalog.v1"
    || !["canvas", "moodle"].includes(catalog.provider) || !Array.isArray(catalog.operations)) {
    throw new TypeError("Browser catalog is invalid");
  }
  exactKeys(catalog, BROWSER_CATALOG_KEYS, "Browser catalog");
  if (expectedProvider !== undefined && catalog.provider !== expectedProvider) throw new TypeError("Browser catalog is invalid");
  const operations = catalog.operations.map((entry) => normalizedBrowserCatalogOperation(entry, catalog.provider));
  const tools = new Set();
  const keys = new Set();
  for (const operation of operations) {
    if (tools.has(operation.toolName) || keys.has(operation.key)) throw new TypeError(`${catalog.provider === "canvas" ? "Canvas" : "Moodle"} browser catalog has duplicate operations`);
    tools.add(operation.toolName);
    keys.add(operation.key);
  }
  for (const operation of operations) {
    if (operation.reviewTool && (!tools.has(operation.reviewTool)
      || !operations.find((candidate) => candidate.toolName === operation.reviewTool)?.readOnly)) {
      throw new TypeError(`${catalog.provider === "canvas" ? "Canvas" : "Moodle"} browser catalog reviewTool is invalid`);
    }
  }
  return { schema: "morrow.browser-catalog.v1", provider: catalog.provider, operations };
}

export async function admitCanvasApiCatalog(catalog) {
  exactKeys(catalog, CANVAS_CATALOG_KEYS, "Canvas API catalog");
  if (catalog.schema !== "morrow.canvas-api-catalog.v1" || !Array.isArray(catalog.operations)
    || !jsonObject(catalog.counts) || !jsonObject(catalog.source) || !/^[0-9a-f]{64}$/.test(catalog.catalogDigest || "")) {
    throw new TypeError("Canvas API catalog is invalid");
  }
  exactKeys(catalog.counts, CANVAS_COUNT_KEYS, "Canvas API catalog counts");
  exactKeys(catalog.source, CANVAS_SOURCE_KEYS, "Canvas API catalog source");
  if (Object.values(catalog.counts).some((value) => !Number.isSafeInteger(value) || value < 0)
    || catalog.counts.totalOperations !== catalog.operations.length) throw new TypeError("Canvas API catalog counts are invalid");
  const names = new Set();
  const keys = new Set();
  for (const operation of catalog.operations) {
    exactKeys(operation, CANVAS_OPERATION_KEYS, "Canvas API catalog operation");
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(operation.toolName || "") || typeof operation.key !== "string"
      || !Array.isArray(operation.parameters) || !jsonObject(operation.inputSchema)) {
      throw new TypeError("Canvas API catalog operation is invalid");
    }
    for (const parameter of operation.parameters) {
      exactKeys(parameter, CANVAS_PARAMETER_KEYS, "Canvas API catalog parameter");
      if (!jsonObject(parameter.schema)) throw new TypeError("Canvas API catalog parameter is invalid");
    }
    if (names.has(operation.toolName) || keys.has(operation.key)) throw new TypeError("Canvas API catalog has duplicate operations");
    names.add(operation.toolName);
    keys.add(operation.key);
  }
  const { catalogDigest, ...body } = catalog;
  if (catalogDigest !== await sha256StableJson(body)) throw new TypeError("Canvas API catalog digest does not match its content");
  return structuredClone(catalog);
}

export async function parseCanvasApiCatalogText(text) {
  exactJsonDepth(text);
  return await admitCanvasApiCatalog(JSON.parse(text));
}

export function parseBrowserCatalogText(text, provider) {
  exactJsonDepth(text);
  return normalizedBrowserCatalog(JSON.parse(text), provider);
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}

async function sha256StableJson(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJson(value)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function operationalJsonSchema(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return structuredClone(value);
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (JSON_SCHEMA_ANNOTATION_KEYS.has(key)) continue;
    if (JSON_SCHEMA_MAP_KEYS.has(key) && child && typeof child === "object" && !Array.isArray(child)) {
      output[key] = Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, operationalJsonSchema(schema)]));
    } else if (JSON_SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(child)) {
      output[key] = child.map(operationalJsonSchema);
    } else if (JSON_SCHEMA_SINGLE_KEYS.has(key)) {
      output[key] = Array.isArray(child)
        ? child.map(operationalJsonSchema)
        : child && typeof child === "object" ? operationalJsonSchema(child) : structuredClone(child);
    } else {
      output[key] = structuredClone(child);
    }
  }
  return output;
}

export function canvasApiCompatibilityContract(catalog) {
  return {
    schema: CANVAS_API_COMPATIBILITY_SCHEMA,
    operations: catalog.operations.map((operation) => ({
      key: operation.key,
      toolName: operation.toolName,
      service: operation.service,
      family: operation.family,
      nickname: operation.nickname,
      method: operation.method,
      path: operation.path,
      deprecated: operation.deprecated,
      risk: operation.risk,
      readOnly: operation.readOnly,
      parameters: operation.parameters.map((parameter) => ({
        inputName: parameter.inputName,
        wireName: parameter.wireName,
        location: parameter.location,
        required: parameter.required,
        deprecated: parameter.deprecated,
        schema: operationalJsonSchema(parameter.schema),
      })),
      inputSchema: operationalJsonSchema(operation.inputSchema),
      responseType: operation.responseType,
    })),
  };
}

export function browserCatalogCompatibilityContract(catalog) {
  const normalized = normalizedBrowserCatalog(catalog);
  return {
    schema: BROWSER_CATALOG_COMPATIBILITY_SCHEMA,
    provider: normalized.provider,
    operations: normalized.operations.map((operation) => ({
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

export function privateBridgeCompatibilityContract(operations) {
  if (!Array.isArray(operations) || operations.length < 1) throw new TypeError("Private Bridge operation contracts are invalid");
  return { schema: PRIVATE_BRIDGE_COMPATIBILITY_SCHEMA, operations: structuredClone(operations) };
}

export function bridgeCatalogCompatibilityContract(canvasApiDigest, canvasBrowserDigest, moodleBrowserDigest, privateCommandsDigest) {
  return {
    schema: BRIDGE_CATALOG_COMPATIBILITY_SCHEMA,
    canvasApi: canvasApiDigest,
    canvasBrowser: canvasBrowserDigest,
    moodleBrowser: moodleBrowserDigest,
    privateCommands: privateCommandsDigest,
  };
}
