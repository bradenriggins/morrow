import {
  canonicalJson,
  isJsonObject,
  type JsonObject,
} from "@morrow/contracts";

export const CANVAS_RESULT_BINDING_SCHEMA = "morrow.canvas-result-binding.v1" as const;

export const CANVAS_RESULT_BINDING_KINDS = Object.freeze([
  "canvas_page_url_to_module_item_page_url",
  "canvas_assignment_id_to_module_item_content_id",
] as const);

export type CanvasResultBindingKind = typeof CANVAS_RESULT_BINDING_KINDS[number];

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
  validateCanvasResultBinding(binding, source, dependent);
  const artifact = connectorArtifact(source, sourceResult);
  const field = binding.kind === "canvas_page_url_to_module_item_page_url"
    ? "module_item_page_url"
    : "module_item_content_id";
  const value = binding.kind === "canvas_page_url_to_module_item_page_url"
    ? exactPageUrl(artifact.url)
    : exactAssignmentId(artifact.id);
  const bound = { ...structuredClone(dependent.arguments), [field]: value } as JsonObject;
  if (!sameRequestExceptTarget(dependent.arguments, bound, field)) {
    throw new Error("Canvas bound request changed frozen fields");
  }
  return bound;
}
