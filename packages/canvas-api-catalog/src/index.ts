import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import { resolve } from "node:path";
import { isJsonObject, sha256Json, type JsonObject, type JsonSchema, type SourceCapabilityMetadata, type UpstreamTool } from "@morrow/contracts";
import { canvasAdmissionReason, canvasOperationAdmission, canvasReadbackAssessment } from "./operation-admission.js";

export { canvasAccountAuthorityRoute, canvasAdmissionIsBound, canvasAdmissionReason, canvasCourseTargetIsScoped, canvasOperationAdmission, canvasReadbackAssessment, CANVAS_REVIEWED_UPLOAD_ROUTES, canvasReviewedUploadKind, canvasReviewedUploadPath, canvasReviewedUploadRoute, canvasUploadListingRead, canvasSiteAuthorityNote } from "./operation-admission.js";
export type { CanvasCourseTarget, CanvasOperationAdmission, CanvasOperationAuthority, CanvasReadbackAssessment, CanvasReviewedUploadKind, CanvasSiteAuthorityClass, CanvasWriteAdmission } from "./operation-admission.js";
export { evaluateBrowserReadback, hasDeclaredCanvasReadback, matchesReadbackAssertions, planBrowserReadback, planCanvasRecoveryDescriptor, readbackFieldValue } from "./readback-plan.js";
export type { BrowserReadbackAssertion, BrowserReadbackPlan, BrowserReadbackResult, BrowserVerification, CanvasRecoveryDescriptor, CanvasRecoveryRead, CanvasReadbackOperation } from "./readback-plan.js";
export { CANVAS_MULTI_CONTEXT_REFUSAL, CANVAS_SEMANTIC_RESOLUTION_MAX_AGE_MS, canvasContextCodeCourseId, canvasCourseContextCode, canvasLearnerScopeObjectRoute, canvasSemanticContextInputState, canvasSemanticCourseCollectionArguments, canvasSemanticCourseCollectionState, canvasSemanticCourseTarget, canvasSemanticObjectContext, canvasSemanticObjectVersion, canvasSemanticResolutionProblem, canvasSemanticResolvedCourseId, canvasSemanticSeriesInput, canvasSemanticVersionState } from "./semantic-target.js";
export type { CanvasSemanticContextInputState, CanvasSemanticCourseCollectionState, CanvasSemanticCourseTarget, CanvasSemanticObjectContext, CanvasSemanticOperation, CanvasSemanticResolutionExpectation, CanvasSemanticResolutionProof, CanvasSemanticResolutionRefusal, CanvasSemanticVersionState } from "./semantic-target.js";
export { canvasDeclaredReadback, canvasEntityReadRoutes, canvasRecordListing } from "./entity-read-routes.js";
export type { CanvasDeclaredReadback, CanvasEntityReadRoute, CanvasRecordListing } from "./entity-read-routes.js";
export { CLASSIC_QUIZ_SUPPORTED_QUESTION_TYPES, classicQuizQuestionContract } from "./classic-quiz-question-contract.js";
export type { ClassicQuizQuestionContractIssue, ClassicQuizQuestionContractResult, ClassicQuizQuestionRequestAnswer } from "./classic-quiz-question-contract.js";

export type CanvasApiService = "canvas" | "item_bank" | "course_file_content";
export type CanvasApiRisk = "read" | "write" | "sensitive_write" | "destructive";
export type CanvasParameterLocation = "path" | "query" | "form" | "control";

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
  };
  readonly counts: {
    readonly officialOperations: number;
    readonly browserSessionOperations: number;
    readonly totalOperations: number;
    readonly newQuizzesOperations: number;
    readonly itemBankOperations: number;
    readonly courseFileContentOperations: number;
    readonly reads: number;
    readonly writes: number;
  };
  readonly operations: readonly CanvasApiOperation[];
  readonly catalogDigest: string;
}

export const CANVAS_API_COMPATIBILITY_SCHEMA = "morrow.canvas-api-compatibility.v1";

const JSON_SCHEMA_ANNOTATION_KEYS = new Set(["$comment", "description", "examples", "title"]);
const JSON_SCHEMA_MAP_KEYS = new Set(["$defs", "definitions", "dependentSchemas", "patternProperties", "properties"]);
const JSON_SCHEMA_ARRAY_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const JSON_SCHEMA_SINGLE_KEYS = new Set([
  "additionalItems", "additionalProperties", "contains", "contentSchema", "else", "if", "items", "not",
  "propertyNames", "then", "unevaluatedItems", "unevaluatedProperties",
]);

/** Removes JSON Schema annotations that cannot change admission or wire behavior. */
export function operationalJsonSchema(value: JsonSchema): JsonSchema {
  const project = (entry: unknown): unknown => {
    if (!isJsonObject(entry)) return structuredClone(entry);
    const output: JsonObject = {};
    for (const [key, child] of Object.entries(entry)) {
      if (JSON_SCHEMA_ANNOTATION_KEYS.has(key)) continue;
      if (JSON_SCHEMA_MAP_KEYS.has(key) && isJsonObject(child)) {
        output[key] = Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, project(schema)]));
      } else if (JSON_SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(child)) {
        output[key] = child.map(project);
      } else if (JSON_SCHEMA_SINGLE_KEYS.has(key)) {
        output[key] = Array.isArray(child) ? child.map(project) : isJsonObject(child) ? project(child) : structuredClone(child);
      } else {
        output[key] = structuredClone(child);
      }
    }
    return output;
  };
  return project(value) as JsonSchema;
}

/** The Canvas contract that must match for MCP and Bridge execution to interoperate. */
export function canvasApiCompatibilityContract(catalog: CanvasApiCatalog): JsonObject {
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

export function canvasApiCompatibilityDigest(catalog: CanvasApiCatalog): string {
  return sha256Json(canvasApiCompatibilityContract(catalog));
}

/** Maximum accepted size for command-authoritative and packaged public catalogs. */
export const MAX_PUBLIC_CATALOG_BYTES = 16 * 1024 * 1024;

export interface ExactCatalogBytes {
  readonly bytes: Buffer;
  readonly text: string;
}

function sameCatalogFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameCatalogSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  // ctime can gain precision after a fresh write without any file mutation.
  return sameCatalogFile(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.gid === right.gid;
}

/** Reads one stable regular public catalog through a bounded, non-following descriptor. */
export function readExactCatalogBytes(pathValue: string, label = "Public catalog"): ExactCatalogBytes {
  const path = resolve(pathValue);
  const invalid = (): Error => new Error(`${label} must name one stable regular file from 1 byte through 16 MiB`);
  let descriptor: number | undefined;
  try {
    const namedBefore = lstatSync(path, { bigint: true });
    if (!namedBefore.isFile() || namedBefore.isSymbolicLink()
      || namedBefore.size < 1n || namedBefore.size > BigInt(MAX_PUBLIC_CATALOG_BYTES)) {
      throw invalid();
    }
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const nonblocking = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
    descriptor = openSync(path, constants.O_RDONLY | noFollow | nonblocking);
    const openedBefore = fstatSync(descriptor, { bigint: true });
    if (!openedBefore.isFile() || !sameCatalogSnapshot(namedBefore, openedBefore)
      || openedBefore.size < 1n || openedBefore.size > BigInt(MAX_PUBLIC_CATALOG_BYTES)) {
      throw invalid();
    }

    const bytes = Buffer.allocUnsafe(Number(openedBefore.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const openedAfter = fstatSync(descriptor, { bigint: true });
    const namedAfter = lstatSync(path, { bigint: true });
    if (offset !== bytes.length || !sameCatalogSnapshot(openedBefore, openedAfter)
      || !sameCatalogSnapshot(openedAfter, namedAfter)) {
      throw invalid();
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new TypeError(`${label} must contain strict UTF-8`);
    }
    return { bytes, text };
  } catch (error) {
    if (error instanceof Error && (error.message === invalid().message || error.message === `${label} must contain strict UTF-8`)) {
      throw error;
    }
    throw invalid();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
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
  const catalog = readExactCatalogBytes(path, "Canvas API catalog");
  return exactCatalog(JSON.parse(catalog.text) as unknown);
}

export function canvasOperationMap(catalog: CanvasApiCatalog): ReadonlyMap<string, CanvasApiOperation> {
  return new Map(catalog.operations.map((operation) => [operation.toolName, operation]));
}

function capability(catalog: CanvasApiCatalog, operation: CanvasApiOperation): SourceCapabilityMetadata {
  const destructive = operation.risk === "destructive";
  const admission = canvasOperationAdmission(operation);
  const readback = canvasReadbackAssessment(catalog.operations, operation, admission);
  const credentialReadReason = operation.toolName === "canvas_get_items_media_upload_url"
    ? "This Canvas read returns a one-time media upload credential. Morrow keeps upload credentials inside its reviewed file transfer."
    : undefined;
  const incompatibleAuthenticationReason = operation.path.startsWith("/lti/")
    ? "This Canvas LTI service requires separate LTI authorization that the signed-in browser session does not hold."
    : undefined;
  const redirectReadReason = operation.readOnly && operation.responseType === "void"
    && /redirect/iu.test(`${operation.summary} ${operation.description}`)
    ? "This Canvas route returns a navigation redirect instead of course data, which the Bridge does not follow across origins."
    : undefined;
  const readAdmissionReason = credentialReadReason;
  const profile = readAdmissionReason
    ? { state: "profile_limited" as const, reason: readAdmissionReason }
    : admission.write.state === "held"
      ? { state: "profile_limited" as const, reason: canvasAdmissionReason(admission.write) }
      : incompatibleAuthenticationReason
        ? { state: "profile_limited" as const, reason: incompatibleAuthenticationReason }
      : redirectReadReason
        ? { state: "profile_limited" as const, reason: redirectReadReason }
      // A change with no exact readback is still sent. It is approved one change at a time, never
      // granted ahead, and its result says Morrow did not check the saved result.
      : { state: "supported" as const };
  return {
    family: operation.family,
    provider: "canvas",
    sourcePath: operation.source === "canvas-official-swagger-1.2"
      ? operation.path
      : operation.service === "course_file_content"
        ? "connector/extension/src/canvas-file-content.js"
        : "connector/extension/src/item-bank-executor.js",
    sourceExport: operation.key,
    sourceDigest: sha256Json({ key: operation.key, method: operation.method, path: operation.path, parameters: operation.parameters }),
    behavior: {
      readOnly: operation.readOnly,
      mutating: !operation.readOnly,
      destructive,
      irreversible: destructive,
      supportsDryRun: !operation.readOnly,
      supportsReadback: readback.state === "structurally_exact",
      supportsUndo: false,
      supportsBatch: true,
      requiresBrowser: true,
      requiresLiveCanvas: true,
    },
      authority: {
      // A site request acts on the connected Canvas site as the signed-in person, so no layer compares
      // it with the selected course. A course object names no course, and the Bridge proves the course
      // that owns it before the change is sent.
      scopeClass: admission.authority === "site"
        ? "site"
        : admission.courseTarget.kind === "semantic_course_object" ? "course-object" : "course",
      approvalClass: operation.readOnly ? "none" : destructive ? "destructive" : /(?:grade|score|submission)/i.test(operation.key) ? "grade" : "standard",
      dataClass: /(?:user|student|enrollment|submission|grade)/i.test(operation.key) ? "learner" : "course",
    },
    route: {
      backend: "canvas-connector",
      dispatchBackend: "chrome-session-connector",
      readbackBackend: "chrome-session-connector",
      comparator: operation.service === "course_file_content" ? "exact-file-version-and-byte-digest" : "frozen-json-digest",
    },
    profiles: {
      "private-full": profile,
      "public-canvas": profile,
      sandbox: { state: "profile_limited", reason: "The live connector is replaced by the synthetic Canvas estate." },
      "read-only": operation.readOnly
        ? profile
        : { state: "profile_limited", reason: "The read-only profile does not admit provider writes." },
    },
    evidence: {
      transport: { state: "known" },
      credentialBoundary: { state: "known" },
      admission: readAdmissionReason
        ? { state: "blocked", reason: readAdmissionReason }
        : admission.write.state === "held"
        ? { state: "blocked", reason: canvasAdmissionReason(admission.write) }
        : incompatibleAuthenticationReason
          ? { state: "blocked", reason: incompatibleAuthenticationReason }
        : redirectReadReason
          ? { state: "blocked", reason: redirectReadReason }
        : { state: "known" },
      readback: readback.state === "structurally_exact"
        ? { state: "known", reason: "A structural readback plan can compare a target or requested postcondition; live provider readback remains required." }
        : readback.state === "not_applicable"
          ? { state: "blocked", reason: readback.reason === "read_only" ? "This operation does not mutate provider state." : "This provider write remains held before dispatch." }
        : readback.state === "unavailable"
          ? { state: "blocked", reason: "No safe generic readback route is available." }
          : readback.state === "blocked"
            ? { state: "blocked", reason: `No safe exact post-write reader is available: ${readback.reason}.` }
          : { state: "unknown", reason: "The generic readback plan has no exact target or requested postcondition." },
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
    capability: capability(catalog, operation),
  }));
}

function validateCreateModuleItemArguments(operation: CanvasApiOperation, input: JsonObject): void {
  if (operation.toolName !== "canvas_create_module_item") return;
  const type = input.module_item_type;
  if (typeof type !== "string" || type === "") return;
  const required = (name: string) => {
    const value = input[name];
    if (value === undefined || value === null || value === "") throw new TypeError(`${name} is required`);
  };
  if (type === "Page") {
    required("module_item_page_url");
    return;
  }
  if (type === "ExternalUrl") {
    required("module_item_external_url");
    return;
  }
  if (type === "SubHeader") return;
  required("module_item_content_id");
  if (type === "ExternalTool") required("module_item_external_url");
}

const CLASSIC_QUIZ_ANSWER_FIELDS = [
  "id",
  "answer_text",
  "answer_weight",
  "answer_comments",
  "answer_comment_html",
  "answer_html",
  "text_after_answers",
] as const;

// Canvas takes the typed Classic Quiz answer array as indexed form fields, so one
// answer becomes question[answers][0][answer_text] and its siblings. The extension
// applies the same rule to the request it sends in connector/extension/src/canvas-content.js.
function classicQuizAnswerEntries(parameter: CanvasApiParameter, value: unknown): [string, unknown][] | null {
  if (parameter.location !== "form" || parameter.wireName !== "question[answers]") return null;
  if (!Array.isArray(value)) throw new TypeError(`${parameter.inputName} must be an array of answers`);
  return value.flatMap((answer, index) => {
    if (!isJsonObject(answer)) throw new TypeError(`${parameter.inputName} must contain answer objects`);
    return CLASSIC_QUIZ_ANSWER_FIELDS
      .filter((field) => answer[field] !== undefined)
      .map((field): [string, unknown] => [`question[answers][${index}][${field}]`, answer[field]]);
  });
}

export function operationArguments(operation: CanvasApiOperation, input: JsonObject): {
  readonly path: string;
  readonly query: readonly [string, unknown][];
  readonly body: readonly [string, unknown][];
} {
  validateCreateModuleItemArguments(operation, input);
  let path = operation.path;
  const query: [string, unknown][] = [];
  const body: [string, unknown][] = [];
  for (const parameter of operation.parameters) {
    const value = input[parameter.inputName];
    const preserveNewQuizValue = operation.family === "new-quizzes" && operation.path.startsWith("/quiz/v1/")
      && ["POST", "PATCH"].includes(operation.method) && parameter.location === "form";
    if (value === undefined || (!preserveNewQuizValue && (value === null || value === ""))) {
      if (parameter.required) throw new TypeError(`${parameter.inputName} is required`);
      continue;
    }
    if (parameter.location === "path") {
      path = path.replace(`{${parameter.wireName}}`, encodeURIComponent(String(value)));
    } else if (parameter.location === "control") {
      continue;
    } else if (parameter.location === "query") {
      query.push([parameter.wireName, value]);
    } else {
      const answers = classicQuizAnswerEntries(parameter, value);
      if (answers) body.push(...answers);
      else body.push([parameter.wireName, value]);
    }
  }
  if (/\{[^}]+\}/.test(path)) throw new TypeError("Canvas path has unresolved parameters");
  return { path, query, body };
}
