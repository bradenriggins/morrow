import {
  CANVAS_RESULT_BINDING_SCHEMA,
  type CanvasResultBinding,
} from "@morrow/batch-engine";
import { isJsonObject, type JsonObject } from "@morrow/contracts";

const CANVAS_ID = /^[1-9][0-9]{0,18}$/;
const CHILD_ID = /^[A-Za-z0-9_.:@-]{1,160}$/;
const SOURCE_BINDING_ID = /^[A-Za-z0-9_.:@-]{1,160}$/;

export type CanvasCourseContentKind = "page" | "assignment";

export interface CanvasCourseComposeInput {
  readonly schema: "morrow.canvas-course-compose.v1";
  readonly courseId: string;
  readonly sourceBindingId: string;
  readonly content: {
    readonly kind: CanvasCourseContentKind;
    readonly childId: string;
    readonly arguments: JsonObject;
  };
  readonly placement: {
    readonly childId: string;
    readonly moduleId: string;
    readonly title?: string;
    readonly position?: number;
  };
}

export interface CanvasCourseComposeOperation {
  readonly childId: string;
  readonly courseId: string;
  readonly tool: "canvas_create_page_courses" | "canvas_create_assignment" | "canvas_create_module_item";
  readonly arguments: JsonObject;
  readonly sourceBindingId: string;
  readonly dependencyChildIds: readonly string[];
  readonly resultBinding?: CanvasResultBinding;
}

export interface CanvasCourseComposePlan {
  readonly schema: "morrow.canvas-course-compose-plan.v1";
  readonly courseId: string;
  readonly sourceBindingId: string;
  readonly operations: readonly [CanvasCourseComposeOperation, CanvasCourseComposeOperation];
}

function exactCanvasId(value: unknown, label: string): string {
  if (typeof value !== "string" || !CANVAS_ID.test(value)) {
    throw new TypeError(`${label} must be an exact Canvas id`);
  }
  return value;
}

function exactChildId(value: unknown, label: string): string {
  if (typeof value !== "string" || !CHILD_ID.test(value)) {
    throw new TypeError(`${label} must be a valid child id`);
  }
  return value;
}

function exactSourceBindingId(value: unknown): string {
  if (typeof value !== "string" || !SOURCE_BINDING_ID.test(value)) {
    throw new TypeError("source binding id must be exact");
  }
  return value;
}

function exactContentArguments(value: unknown, courseId: string, sourceBindingId: string): JsonObject {
  if (!isJsonObject(value)) throw new TypeError("content arguments must be an object");
  if (value.course_id !== undefined && value.course_id !== courseId) {
    throw new TypeError("content arguments must target the selected course");
  }
  if (value._morrow !== undefined) {
    if (!isJsonObject(value._morrow) || Object.keys(value._morrow).length !== 1
      || value._morrow.source_binding_id !== sourceBindingId) {
      throw new TypeError("content arguments may contain only the selected source binding");
    }
  }
  const { _morrow: _ignored, course_id: _courseIgnored, ...rest } = value;
  return {
    ...structuredClone(rest),
    course_id: courseId,
    _morrow: { source_binding_id: sourceBindingId },
  };
}

function exactRequiredText(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > 1_000) {
    throw new TypeError(`${field} must be present`);
  }
}

function placementArguments(
  input: CanvasCourseComposeInput,
  type: "Page" | "Assignment",
): JsonObject {
  const moduleId = exactCanvasId(input.placement.moduleId, "module id");
  const title = input.placement.title;
  if (title !== undefined) exactRequiredText(title, "module item title");
  const position = input.placement.position;
  if (position !== undefined && (!Number.isSafeInteger(position) || position < 1 || position > 1_000_000)) {
    throw new TypeError("module item position must be a positive whole number");
  }
  return {
    course_id: input.courseId,
    module_id: moduleId,
    module_item_type: type,
    ...(title === undefined ? {} : { module_item_title: title }),
    ...(position === undefined ? {} : { module_item_position: position }),
    _morrow: { source_binding_id: input.sourceBindingId },
  };
}

/**
 * Freeze exactly two writes for one legacy Canvas authoring action. The module
 * target is deliberately absent until the batch engine derives it from a
 * verified create result. This function cannot dispatch, delete, or retry.
 */
export function composeCanvasCourseContentAndModule(
  raw: CanvasCourseComposeInput,
): CanvasCourseComposePlan {
  if (!isJsonObject(raw) || raw.schema !== "morrow.canvas-course-compose.v1") {
    throw new TypeError("Canvas course compose input is invalid");
  }
  const courseId = exactCanvasId(raw.courseId, "course id");
  const sourceBindingId = exactSourceBindingId(raw.sourceBindingId);
  const contentChildId = exactChildId(raw.content?.childId, "content child id");
  const placementChildId = exactChildId(raw.placement?.childId, "placement child id");
  if (contentChildId === placementChildId) throw new TypeError("content and placement child ids must differ");
  if (raw.content?.kind !== "page" && raw.content?.kind !== "assignment") {
    throw new TypeError("Canvas content kind must be page or assignment");
  }
  const argumentsValue = exactContentArguments(raw.content.arguments, courseId, sourceBindingId);
  const kind = raw.content.kind;
  const tool = kind === "page" ? "canvas_create_page_courses" : "canvas_create_assignment";
  const requiredField = kind === "page" ? "wiki_page_title" : "assignment_name";
  exactRequiredText(argumentsValue[requiredField], requiredField);
  const moduleItemType = kind === "page" ? "Page" : "Assignment";
  const resultBinding: CanvasResultBinding = {
    schema: CANVAS_RESULT_BINDING_SCHEMA,
    sourceChildId: contentChildId,
    kind: kind === "page"
      ? "canvas_page_url_to_module_item_page_url"
      : "canvas_assignment_id_to_module_item_content_id",
  };
  const content: CanvasCourseComposeOperation = {
    childId: contentChildId,
    courseId,
    tool,
    arguments: argumentsValue,
    sourceBindingId,
    dependencyChildIds: [],
  };
  const placement: CanvasCourseComposeOperation = {
    childId: placementChildId,
    courseId,
    tool: "canvas_create_module_item",
    arguments: placementArguments({ ...raw, courseId, sourceBindingId }, moduleItemType),
    sourceBindingId,
    dependencyChildIds: [contentChildId],
    resultBinding,
  };
  return {
    schema: "morrow.canvas-course-compose-plan.v1",
    courseId,
    sourceBindingId,
    operations: [content, placement],
  };
}
