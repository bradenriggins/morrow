import {
  canonicalJson,
  isJsonObject,
  type JsonObject,
} from "@morrow/contracts";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

export const CANVAS_RESULT_BINDING_SCHEMA = "morrow.canvas-result-binding.v1" as const;

// Canvas-only by what the providers' write catalogs actually contain, not by omission. Both
// bound kinds exist because Canvas splits creating a Page or an Assignment from placing it in a
// Module: the Module Item references the created object by an id or url Canvas assigns only at
// creation, so a batch needs to carry that value from one step to the next without letting the
// batch definition itself name an unverified target. Moodle's every content-creating write
// (moodle_create_page, moodle_create_assignment, moodle_create_forum, and so on) creates the
// activity directly inside its section in one call, so no second placement step, and no id to
// carry, ever exists. Blackboard's write catalog has no general create-new-content operation at
// all yet; every Blackboard write patches, attaches to, or changes the visibility of content that
// already exists. Add a binding kind here only when a provider's catalog gains a create-then-
// place-by-id split like Canvas's.
export const CANVAS_RESULT_BINDING_KINDS = Object.freeze([
  "canvas_page_url_to_module_item_page_url",
  "canvas_assignment_id_to_module_item_content_id",
] as const);

export type CanvasResultBindingKind = typeof CANVAS_RESULT_BINDING_KINDS[number];

export const CANVAS_RESULT_BINDING_ARTIFACT_SCHEMA = "morrow.canvas-result-binding-artifact.v1" as const;
export const CANVAS_RESULT_BINDING_ARTIFACT_ENVELOPE_SCHEMA = "morrow.canvas-result-binding-artifact-envelope.v1" as const;

export interface CanvasResultBindingArtifact {
  readonly schema: typeof CANVAS_RESULT_BINDING_ARTIFACT_SCHEMA;
  readonly kind: CanvasResultBindingKind;
  readonly value: string;
}

export interface CanvasResultBindingArtifactEnvelope {
  readonly schema: typeof CANVAS_RESULT_BINDING_ARTIFACT_ENVELOPE_SCHEMA;
  readonly ciphertext: string;
  readonly iv: string;
  readonly tag: string;
}

export interface CanvasResultBindingArtifactContext {
  readonly operationId: string;
  readonly publicToolName: string;
  readonly sourceId: string;
  readonly sourceToolName: string;
  readonly sourceOperationId: string | null;
  readonly sourceBindingId: string | null;
  readonly targetIdentityDigest: string | null;
  readonly upstreamResultDigest: string;
  readonly readbackDigest: string;
}

export interface CanvasResultBinding {
  readonly schema: typeof CANVAS_RESULT_BINDING_SCHEMA;
  readonly sourceChildId: string;
  readonly kind: CanvasResultBindingKind;
}

export interface CanvasBindingChild {
  readonly childId: string;
  readonly courseId: string;
  readonly publicToolName: string;
  readonly sourceId: string;
  readonly sourceToolName: string;
  readonly arguments: JsonObject;
  readonly dependencyChildIds: readonly string[];
}

const IDENTIFIER = /^[A-Za-z0-9_.:@-]{1,160}$/;
const CANVAS_IDENTIFIER = /^[1-9][0-9]{0,18}$/;

function exactObject(value: unknown, keys: readonly string[]): value is JsonObject {
  return isJsonObject(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function exactSourceBinding(value: JsonObject): string {
  const controls = value._morrow;
  if (!isJsonObject(controls) || typeof controls.source_binding_id !== "string") {
    throw new TypeError("Canvas result binding requires one exact source binding id");
  }
  const sourceBindingId = controls.source_binding_id.trim();
  if (!IDENTIFIER.test(sourceBindingId)) {
    throw new TypeError("Canvas result binding has an invalid source binding id");
  }
  return sourceBindingId;
}

function exactCourseArgument(value: JsonObject): string {
  if (typeof value.course_id !== "string" || !CANVAS_IDENTIFIER.test(value.course_id)) {
    throw new TypeError("Canvas result binding requires one exact Canvas course id");
  }
  return value.course_id;
}

function noTarget(value: JsonObject, field: string): void {
  if (Object.hasOwn(value, field)) {
    throw new TypeError(`Canvas result binding target must omit ${field}`);
  }
}

function sameRequestExceptTarget(template: JsonObject, bound: JsonObject, field: string): boolean {
  const templateKeys = Object.keys(template);
  const boundKeys = Object.keys(bound);
  if (boundKeys.length !== templateKeys.length + 1 || !Object.hasOwn(bound, field)) return false;
  for (const key of templateKeys) {
    if (!Object.hasOwn(bound, key) || canonicalJson(template[key]) !== canonicalJson(bound[key])) return false;
  }
  return boundKeys.every((key) => key === field || Object.hasOwn(template, key));
}

function connectorArtifact(
  source: CanvasBindingChild,
  resultPayload: JsonObject,
): JsonObject {
  const structured = resultPayload.structuredContent;
  if (!isJsonObject(structured) || structured.schema !== "morrow.result.v1"
    || structured.tool !== source.publicToolName || structured.effectState !== "verified"
    || !isJsonObject(structured.verification) || structured.verification.status !== "verified"
    || !isJsonObject(structured.data)) {
    throw new Error("Canvas source result has no verified artifact");
  }
  const connector = structured.data;
  if (connector.schema !== "morrow.canvas-connector.result.v1" || connector.ok !== true
    || connector.provider !== "canvas" || connector.toolName !== source.publicToolName
    || connector.commandKind !== "invoke_write" || !isJsonObject(connector.result)
    || !isJsonObject(connector.result.data)) {
    throw new Error("Canvas source result has no verified connector artifact");
  }
  return connector.result.data;
}

function exactPageUrl(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_000 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Canvas page source artifact has no exact page url");
  }
  return value;
}

function exactAssignmentId(value: unknown): string {
  if (typeof value !== "string" || !CANVAS_IDENTIFIER.test(value)) {
    throw new Error("Canvas assignment source artifact has no exact assignment id");
  }
  return value;
}

function exactKey(value: Uint8Array): Buffer {
  const key = Buffer.from(value);
  if (key.length !== 32) throw new TypeError("batch encryption key must contain exactly 32 bytes");
  return key;
}

function exactDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a SHA-256 digest`);
  }
  return value;
}

function exactNullableIdentifier(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function normalizedArtifact(value: unknown): CanvasResultBindingArtifact {
  if (!exactObject(value, ["schema", "kind", "value"])
    || value.schema !== CANVAS_RESULT_BINDING_ARTIFACT_SCHEMA
    || typeof value.kind !== "string"
    || !CANVAS_RESULT_BINDING_KINDS.includes(value.kind as CanvasResultBindingKind)) {
    throw new TypeError("Canvas result binding artifact is invalid");
  }
  return {
    schema: CANVAS_RESULT_BINDING_ARTIFACT_SCHEMA,
    kind: value.kind as CanvasResultBindingKind,
    value: value.kind === "canvas_page_url_to_module_item_page_url"
      ? exactPageUrl(value.value)
      : exactAssignmentId(value.value),
  };
}

function normalizedArtifactContext(value: CanvasResultBindingArtifactContext): CanvasResultBindingArtifactContext {
  if (!IDENTIFIER.test(value.operationId)
    || !IDENTIFIER.test(value.publicToolName)
    || !IDENTIFIER.test(value.sourceId)
    || !IDENTIFIER.test(value.sourceToolName)) {
    throw new TypeError("Canvas result binding artifact effect identity is invalid");
  }
  return {
    operationId: value.operationId,
    publicToolName: value.publicToolName,
    sourceId: value.sourceId,
    sourceToolName: value.sourceToolName,
    sourceOperationId: exactNullableIdentifier(value.sourceOperationId, "source operation id"),
    sourceBindingId: exactNullableIdentifier(value.sourceBindingId, "source binding id"),
    targetIdentityDigest: value.targetIdentityDigest === null
      ? null : exactDigest(value.targetIdentityDigest, "target identity digest"),
    upstreamResultDigest: exactDigest(value.upstreamResultDigest, "upstream result digest"),
    readbackDigest: exactDigest(value.readbackDigest, "readback digest"),
  };
}

function artifactAad(
  context: CanvasResultBindingArtifactContext,
): Buffer {
  return Buffer.from(canonicalJson({
    schema: CANVAS_RESULT_BINDING_ARTIFACT_ENVELOPE_SCHEMA,
    context: normalizedArtifactContext(context),
  }), "utf8");
}

/**
 * Extract only the provider-assigned field needed by a later Canvas module-item
 * request. The connector result must already carry its verified readback.
 */
export function canvasResultBindingArtifactFromVerifiedConnector(
  publicToolName: string,
  value: JsonObject,
): CanvasResultBindingArtifact | null {
  const kind = publicToolName === "canvas_create_page_courses"
    ? "canvas_page_url_to_module_item_page_url"
    : publicToolName === "canvas_create_assignment"
      ? "canvas_assignment_id_to_module_item_content_id"
      : null;
  if (!kind) return null;
  const connector = isJsonObject(value.structuredContent) ? value.structuredContent : null;
  const browser = connector && isJsonObject(connector.result) ? connector.result : null;
  const verification = browser && isJsonObject(browser.verification) ? browser.verification : null;
  const data = browser && isJsonObject(browser.data) ? browser.data : null;
  if (!connector || connector.schema !== "morrow.canvas-connector.result.v1"
    || connector.ok !== true || connector.provider !== "canvas"
    || connector.toolName !== publicToolName || connector.commandKind !== "invoke_write"
    || !browser || browser.schema !== "morrow.canvas-browser-result.v1"
    || browser.ok !== true || browser.sent !== true
    || verification?.schema !== "morrow.browser-verification.v1"
    || verification.status !== "verified" || !data) return null;
  try {
    return normalizedArtifact({
      schema: CANVAS_RESULT_BINDING_ARTIFACT_SCHEMA,
      kind,
      value: kind === "canvas_page_url_to_module_item_page_url" ? data.url : data.id,
    });
  } catch {
    return null;
  }
}

/** Encrypt and bind one minimal artifact to the exact verified provider effect. */
export function encryptCanvasResultBindingArtifact(
  keyValue: Uint8Array,
  contextValue: CanvasResultBindingArtifactContext,
  artifactValue: CanvasResultBindingArtifact,
): CanvasResultBindingArtifactEnvelope {
  const key = exactKey(keyValue);
  const context = normalizedArtifactContext(contextValue);
  const artifact = normalizedArtifact(artifactValue);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(artifactAad(context));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(canonicalJson(artifact), "utf8")),
    cipher.final(),
  ]);
  return {
    schema: CANVAS_RESULT_BINDING_ARTIFACT_ENVELOPE_SCHEMA,
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

/** Authenticate and decrypt one artifact only for the effect that verified it. */
export function decryptCanvasResultBindingArtifact(
  keyValue: Uint8Array,
  contextValue: CanvasResultBindingArtifactContext,
  envelopeValue: unknown,
): CanvasResultBindingArtifact {
  if (!exactObject(envelopeValue, ["schema", "ciphertext", "iv", "tag"])
    || envelopeValue.schema !== CANVAS_RESULT_BINDING_ARTIFACT_ENVELOPE_SCHEMA
    || typeof envelopeValue.ciphertext !== "string"
    || typeof envelopeValue.iv !== "string"
    || typeof envelopeValue.tag !== "string") {
    throw new TypeError("Canvas result binding artifact envelope is invalid");
  }
  const decipher = createDecipheriv("aes-256-gcm", exactKey(keyValue), Buffer.from(envelopeValue.iv, "base64url"));
  decipher.setAAD(artifactAad(normalizedArtifactContext(contextValue)));
  decipher.setAuthTag(Buffer.from(envelopeValue.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelopeValue.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  return normalizedArtifact(JSON.parse(plaintext) as unknown);
}

export function normalizeCanvasResultBinding(value: unknown): CanvasResultBinding {
  if (!exactObject(value, ["schema", "sourceChildId", "kind"])
    || value.schema !== CANVAS_RESULT_BINDING_SCHEMA
    || typeof value.sourceChildId !== "string" || !IDENTIFIER.test(value.sourceChildId)
    || typeof value.kind !== "string" || !CANVAS_RESULT_BINDING_KINDS.includes(value.kind as CanvasResultBindingKind)) {
    throw new TypeError("Canvas result binding is invalid");
  }
  return {
    schema: CANVAS_RESULT_BINDING_SCHEMA,
    sourceChildId: value.sourceChildId,
    kind: value.kind as CanvasResultBindingKind,
  };
}

/**
 * Freeze the only supported Canvas create-to-placement result bindings. The
 * source and target records are already immutable; this checks their exact
 * relationship before a future verified source artifact can fill one field.
 */
export function validateCanvasResultBinding(
  binding: CanvasResultBinding,
  source: CanvasBindingChild,
  dependent: CanvasBindingChild,
): void {
  if (binding.sourceChildId !== source.childId || !dependent.dependencyChildIds.includes(source.childId)) {
    throw new TypeError("Canvas result binding requires an explicit source dependency");
  }
  if (source.courseId !== dependent.courseId
    || exactCourseArgument(source.arguments) !== source.courseId
    || exactCourseArgument(dependent.arguments) !== dependent.courseId
    || source.sourceId !== dependent.sourceId
    || exactSourceBinding(source.arguments) !== exactSourceBinding(dependent.arguments)) {
    throw new TypeError("Canvas result binding requires the same source binding and course");
  }
  if (binding.kind === "canvas_page_url_to_module_item_page_url") {
    if (source.publicToolName !== "canvas_create_page_courses"
      || source.sourceToolName !== "canvas_create_page_courses"
      || dependent.publicToolName !== "canvas_create_module_item"
      || dependent.sourceToolName !== "canvas_create_module_item"
      || dependent.arguments.module_item_type !== "Page") {
      throw new TypeError("Canvas page result binding has an invalid source or module item");
    }
    noTarget(dependent.arguments, "module_item_page_url");
    noTarget(dependent.arguments, "module_item_content_id");
    return;
  }
  if (source.publicToolName !== "canvas_create_assignment"
    || source.sourceToolName !== "canvas_create_assignment"
    || dependent.publicToolName !== "canvas_create_module_item"
    || dependent.sourceToolName !== "canvas_create_module_item"
    || dependent.arguments.module_item_type !== "Assignment") {
    throw new TypeError("Canvas assignment result binding has an invalid source or module item");
  }
  noTarget(dependent.arguments, "module_item_content_id");
  noTarget(dependent.arguments, "module_item_page_url");
}

/**
 * Derive one immutable module-item request only from a verified connector
 * artifact. No caller-controlled target value reaches the bound request.
 */
export function bindCanvasResultArguments(
  binding: CanvasResultBinding,
  source: CanvasBindingChild,
  dependent: CanvasBindingChild,
  sourceResult: JsonObject,
): JsonObject {
  const sourceArtifact = connectorArtifact(source, sourceResult);
  return bindCanvasResultArtifactArguments(binding, source, dependent, {
    schema: CANVAS_RESULT_BINDING_ARTIFACT_SCHEMA,
    kind: binding.kind,
    value: binding.kind === "canvas_page_url_to_module_item_page_url"
      ? exactPageUrl(sourceArtifact.url)
      : exactAssignmentId(sourceArtifact.id),
  });
}

/** Derive the same frozen request from an authenticated minimal recovery artifact. */
export function bindCanvasResultArtifactArguments(
  binding: CanvasResultBinding,
  source: CanvasBindingChild,
  dependent: CanvasBindingChild,
  artifactValue: CanvasResultBindingArtifact,
): JsonObject {
  validateCanvasResultBinding(binding, source, dependent);
  const artifact = normalizedArtifact(artifactValue);
  if (artifact.kind !== binding.kind) {
    throw new Error("Canvas result binding artifact kind does not match the frozen binding");
  }
  const field = binding.kind === "canvas_page_url_to_module_item_page_url"
    ? "module_item_page_url" : "module_item_content_id";
  const value = binding.kind === "canvas_page_url_to_module_item_page_url"
    ? exactPageUrl(artifact.value) : exactAssignmentId(artifact.value);
  const bound = { ...structuredClone(dependent.arguments), [field]: value } as JsonObject;
  if (!sameRequestExceptTarget(dependent.arguments, bound, field)) {
    throw new Error("Canvas bound request changed frozen fields");
  }
  return bound;
}
