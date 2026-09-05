import {
  isJsonObject,
  sha256Json,
  type CatalogTool,
  type JsonObject,
} from "@morrow/contracts";

const CANVAS_ID = /^[1-9][0-9]{0,18}$/;
const REVIEW_READ_TIMEOUT_MS = 4_000;
const REVIEW_READ_BUDGET = 200;

export interface ApprovalReviewContext {
  readonly targets: readonly {
    readonly field: string;
    readonly label: string;
    readonly name: string;
    readonly url?: string;
  }[];
  readonly limited?: boolean;
  readonly current?: JsonObject;
  readonly question?: JsonObject;
}

export type ApprovalReviewReadCache = Map<string, Promise<JsonObject | null>>;

export interface ApprovalReviewOperation {
  readonly state: string;
  readonly publicToolName: string;
  readonly sourceId: string;
  readonly sourceToolName: string;
  readonly sourceBindingId: string | null;
  readonly plan: JsonObject;
}

export interface ApprovalReviewContextInput {
  readonly operation: ApprovalReviewOperation;
  readonly tools: readonly CatalogTool[];
  readonly cache?: ApprovalReviewReadCache;
  readonly read: (
    publicName: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ) => Promise<JsonObject>;
}

interface TargetSpec {
  readonly field: string;
  readonly label: string;
  readonly id: string;
  readonly readTool: string;
  readonly readArguments: JsonObject;
  readonly entityId: (value: JsonObject) => boolean;
  readonly nameFields: readonly string[];
  readonly entryNameFields?: readonly string[];
  readonly urlPath?: readonly string[];
  readonly courseId?: string;
}

function object(value: unknown): JsonObject | null {
  return isJsonObject(value) ? value : null;
}

function exactId(value: unknown): string | null {
  const id = typeof value === "string" ? value.trim() : "";
  return CANVAS_ID.test(id) ? id : null;
}

function sameId(value: unknown, expected: string): boolean {
  return (typeof value === "string" && value === expected)
    || (typeof value === "number" && Number.isSafeInteger(value) && value > 0 && String(value) === expected);
}

function exactText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= 500 ? text : null;
}

function exactSourceTool(
  tools: readonly CatalogTool[],
  sourceId: string,
  upstreamName: string,
  requireCanvasRoute: boolean,
): CatalogTool | null {
  const matches = tools.filter((tool) => (
    tool.upstreamId === sourceId
    && tool.upstreamName === upstreamName
    && tool.annotations?.readOnlyHint === true
    && (!requireCanvasRoute || tool.capability?.route.backend === "canvas-connector")
  ));
  return matches.length === 1 ? matches[0]! : null;
}

function operationTool(
  operation: ApprovalReviewOperation,
  tools: readonly CatalogTool[],
): CatalogTool | null {
  const matches = tools.filter((tool) => (
    tool.publicName === operation.publicToolName
    && tool.upstreamId === operation.sourceId
    && tool.upstreamName === operation.sourceToolName
    && tool.annotations?.readOnlyHint !== true
    && tool.capability?.route.backend === "canvas-connector"
  ));
  return matches.length === 1 ? matches[0]! : null;
}

function planArguments(operation: ApprovalReviewOperation): JsonObject | null {
  const plan = object(operation.plan);
  if (!plan
    || plan.schema !== "morrow.plan.v1"
    || plan.tool !== operation.publicToolName
    || plan.source !== operation.sourceId
    || plan.sourceTool !== operation.sourceToolName
    || plan.sourceBindingId !== operation.sourceBindingId) return null;
  const args = object(plan.arguments);
  const routing = args ? object(args._morrow) : null;
  if (!args || !routing || routing.source_binding_id !== operation.sourceBindingId) return null;
  return args;
}

function canvasEntity(result: JsonObject): JsonObject | null {
  if (result.isError === true) return null;
  const content = object(result.structuredContent);
  if (!content
    || content.schema !== "morrow.canvas-connector.result.v1"
    || content.ok !== true
    || content.commandKind !== "invoke_read") return null;
  const browser = object(content.result);
  if (!browser || browser.ok !== true || browser.sent !== true) return null;
  return object(browser.data);
}

function bindingOrigin(result: JsonObject, sourceBindingId: string): string | null {
  if (result.isError === true) return null;
  const content = object(result.structuredContent);
  if (!content || content.schema !== "morrow.canvas-bindings.v1" || !Array.isArray(content.bindings)) return null;
  const binding = content.bindings.find((candidate) => {
    const value = object(candidate);
    return value?.sourceBindingId === sourceBindingId
      && value.provider === "canvas"
      && value.runtimeVerified === true;
  });
  const value = object(binding);
  const origin = exactText(value?.origin);
  if (!origin) return null;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "https:" && parsed.origin === origin ? origin : null;
  } catch {
    return null;
  }
}

function readCacheKey(
  input: ApprovalReviewContextInput,
  publicName: string,
  args: Readonly<Record<string, unknown>>,
): string {
  const binding = input.operation.sourceBindingId || "unbound";
  return `${input.operation.sourceId}:${binding}:${publicName}:${sha256Json(args)}`;
}

async function boundedRead(
  input: ApprovalReviewContextInput,
  publicName: string,
  args: Readonly<Record<string, unknown>>,
): Promise<{ readonly result: JsonObject | null; readonly limited: boolean }> {
  const cache = input.cache;
  if (!cache) throw new Error("approval review cache is required");
  const key = readCacheKey(input, publicName, args);
  const cached = cache.get(key);
  if (cached) return { result: await cached, limited: false };
  if (cache.size >= REVIEW_READ_BUDGET) return { result: null, limited: true };
  const signal = AbortSignal.timeout(REVIEW_READ_TIMEOUT_MS);
  const pending = input.read(publicName, args, signal).catch(() => null);
  cache.set(key, pending);
  return { result: await pending, limited: false };
}

function safeCanvasUrl(origin: string | null, path: readonly string[]): string | undefined {
  if (!origin) return undefined;
  try {
    const expected = new URL(origin);
    const url = new URL(`/${path.map((segment) => encodeURIComponent(segment)).join("/")}`, expected);
    return url.protocol === "https:" && url.origin === expected.origin ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function resourceSpec(
  mapping: CatalogTool,
  args: JsonObject,
  courseId: string | null,
): TargetSpec | null {
  const family = mapping.capability?.family;
  const assignmentId = exactId(args.assignment_id);
  const quizId = exactId(args.quiz_id);
  const moduleId = exactId(args.module_id) || (family === "modules" ? exactId(args.id) : null);
  const bankId = exactId(args.bank_id);
  const page = exactText(args.url_or_id);

  if (family === "new-quizzes" && courseId && assignmentId) {
    return {
      field: "assignment_id",
      label: "Quiz",
      id: assignmentId,
      readTool: "canvas_get_new_quiz",
      readArguments: { course_id: courseId, assignment_id: assignmentId },
      entityId: (value) => sameId(value.id, assignmentId),
      nameFields: ["title", "name"],
      urlPath: ["courses", courseId, "assignments", assignmentId],
      courseId,
    };
  }
  if (courseId && quizId) {
    return {
      field: "quiz_id",
      label: "Quiz",
      id: quizId,
      readTool: "canvas_get_single_quiz",
      readArguments: { course_id: courseId, id: quizId },
      entityId: (value) => sameId(value.id, quizId),
      nameFields: ["title", "name"],
      urlPath: ["courses", courseId, "quizzes", quizId],
      courseId,
    };
  }
  const assignmentField = assignmentId ? "assignment_id" : family === "assignments" ? "id" : null;
  const resolvedAssignmentId = assignmentId || (assignmentField ? exactId(args.id) : null);
  if (courseId && assignmentField && resolvedAssignmentId) {
    return {
      field: assignmentField,
      label: "Assignment",
      id: resolvedAssignmentId,
      readTool: "canvas_get_single_assignment",
      readArguments: { course_id: courseId, id: resolvedAssignmentId },
      entityId: (value) => sameId(value.id, resolvedAssignmentId),
      nameFields: ["name", "title"],
      urlPath: ["courses", courseId, "assignments", resolvedAssignmentId],
      courseId,
    };
  }
  if (family === "pages" && courseId && page) {
    return {
      field: "url_or_id",
      label: "Page",
      id: page,
      readTool: "canvas_show_page_courses",
      readArguments: { course_id: courseId, url_or_id: page },
      entityId: (value) => value.url === page || sameId(value.page_id, page) || sameId(value.id, page),
      nameFields: ["title", "name"],
      urlPath: ["courses", courseId, "pages", page],
      courseId,
    };
  }
  if (family === "discussion_topics" && courseId && exactId(args.topic_id)) {
    const id = exactId(args.topic_id)!;
    return { field: "topic_id", label: "Discussion", id,
      readTool: "canvas_get_single_topic_courses", readArguments: { course_id: courseId, topic_id: id },
      entityId: (value) => sameId(value.id, id), nameFields: ["title"],
      urlPath: ["courses", courseId, "discussion_topics", id], courseId };
  }
  if (family === "files" && exactId(args.id) && ["canvas_delete_file", "canvas_update_file"].includes(mapping.upstreamName)) {
    const id = exactId(args.id)!;
    return { field: "id", label: "File", id,
      readTool: "canvas_get_file_files", readArguments: { id },
      entityId: (value) => sameId(value.id, id), nameFields: ["display_name", "filename"],
      ...(courseId ? { urlPath: ["courses", courseId, "files", id], courseId } : {}) };
  }
  if (family === "rubrics" && courseId && exactId(args.id) && ["canvas_update_single_rubric", "canvas_delete_single"].includes(mapping.upstreamName)) {
    const id = exactId(args.id)!;
    return { field: "id", label: "Rubric", id,
      readTool: "canvas_get_single_rubric_courses", readArguments: { course_id: courseId, id },
      entityId: (value) => sameId(value.id, id), nameFields: ["title"], courseId };
  }
  if (family === "modules" && courseId && moduleId) {
    return {
      field: exactId(args.module_id) ? "module_id" : "id",
      label: "Module",
      id: moduleId,
      readTool: "canvas_show_module",
      readArguments: { course_id: courseId, id: moduleId },
      entityId: (value) => sameId(value.id, moduleId),
      nameFields: ["name", "title"],
      urlPath: ["courses", courseId, "modules", moduleId],
      courseId,
    };
  }
  if (family === "new-quizzes-item-banks" && bankId) {
    return {
      field: "bank_id",
      label: "Item Bank",
      id: bankId,
      readTool: "canvas_item_bank_get_bank",
      readArguments: { bank_id: bankId },
      entityId: (value) => sameId(value.id, bankId),
      nameFields: ["title", "name"],
    };
  }
  return null;
}

function moduleItemSpec(mapping: CatalogTool, args: JsonObject, courseId: string | null): TargetSpec | null {
  const moduleId = exactId(args.module_id);
  const id = exactId(args.id);
  if (mapping.capability?.family !== "modules" || !courseId || !moduleId || !id
    || !["canvas_update_module_item", "canvas_delete_module_item"].includes(mapping.upstreamName)) return null;
  return { field: "id", label: "Module item", id,
    readTool: "canvas_show_module_item", readArguments: { course_id: courseId, module_id: moduleId, id },
    entityId: (value) => sameId(value.id, id) && (value.module_id === undefined || sameId(value.module_id, moduleId)),
    nameFields: ["title"], courseId };
}

function questionSpec(
  mapping: CatalogTool,
  args: JsonObject,
  courseId: string | null,
): TargetSpec | null {
  const assignmentId = exactId(args.assignment_id);
  const itemId = exactId(args.item_id);
  if (mapping.capability?.family !== "new-quizzes"
    || !["canvas_update_quiz_item", "canvas_delete_quiz_item"].includes(mapping.upstreamName)
    || !courseId || !assignmentId || !itemId) return null;
  return {
    field: "item_id",
    label: "Question",
    id: itemId,
    readTool: "canvas_get_quiz_item",
    readArguments: { course_id: courseId, assignment_id: assignmentId, item_id: itemId },
    entityId: (value) => sameId(value.id, itemId),
    nameFields: [],
    entryNameFields: ["title", "name"],
    courseId,
  };
}

function resolvedTarget(
  target: TargetSpec,
  result: JsonObject | null,
  origin: string | null,
): ApprovalReviewContext["targets"][number] {
  const entity = result ? canvasEntity(result) : null;
  const entityCourseId = entity?.course_id ?? entity?.courseId;
  const courseMatches = !target.courseId || entityCourseId === undefined || sameId(entityCourseId, target.courseId);
  const nameSource = entity && target.entryNameFields ? object(entity.entry) : entity;
  const nameFields = target.entryNameFields || target.nameFields;
  const name = entity && nameSource && courseMatches && target.entityId(entity)
    ? nameFields.map((field) => exactText(nameSource[field])).find((value): value is string => value !== null)
    : null;
  return {
    field: target.field,
    label: target.label,
    name: name || "",
    ...(name && target.urlPath ? { url: safeCanvasUrl(origin, target.urlPath) } : {}),
  };
}

function currentContent(args: JsonObject, value: JsonObject): JsonObject {
  const fields: Record<string, string> = {
    wiki_page_body: "body", wiki_page_title: "title", wiki_page_published: "published",
    assignment_description: "description", assignment_name: "name", assignment_points_possible: "points_possible",
    assignment_due_at: "due_at", assignment_unlock_at: "unlock_at", assignment_lock_at: "lock_at", assignment_published: "published",
    quiz_instructions: "instructions", quiz_title: "title", body: "body", summary: "summary", title: "title", message: "message", published: "published",
  };
  return Object.fromEntries(Object.entries(fields).flatMap(([field, source]) => field in args && Object.hasOwn(value, source) ? [[field, value[source]!]] : []));
}

function currentQuestionContent(value: JsonObject): JsonObject {
  const entry = object(value.entry);
  if (!entry) return {};
  const fields: Record<string, string> = {
    item_entry_title: "title",
    item_entry_item_body: "item_body",
    item_entry_interaction_type_slug: "interaction_type_slug",
    item_entry_interaction_data: "interaction_data",
    item_entry_scoring_algorithm: "scoring_algorithm",
    item_entry_scoring_data: "scoring_data",
  };
  return Object.fromEntries(Object.entries(fields).flatMap(([field, source]) => Object.hasOwn(entry, source) ? [[field, entry[source]!]] : []));
}

export async function resolveApprovalReviewContext(
  input: ApprovalReviewContextInput,
): Promise<ApprovalReviewContext> {
  const review = input.cache ? input : { ...input, cache: new Map() };
  const { operation, tools } = input;
  const lmsMapping = tools.find((tool) => tool.publicName === operation.publicToolName
    && tool.upstreamId === operation.sourceId && tool.upstreamName === operation.sourceToolName
    && tool.capability?.route.backend === "lms-api" && tool.annotations?.readOnlyHint !== true);
  if (lmsMapping) {
    const plan = object(operation.plan);
    const args = object(plan?.arguments);
    const readTool = exactSourceTool(tools, operation.sourceId, lmsMapping.capability?.route.planBackend || "", false);
    if (!args || !readTool || readTool.capability?.route.backend !== "lms-api"
      || readTool.capability.provider !== lmsMapping.capability?.provider
      || plan?.tool !== operation.publicToolName || plan?.source !== operation.sourceId) return { targets: [] };
    const properties = object(readTool.inputSchema.properties) || {};
    const readArgs = Object.fromEntries(Object.entries(args).filter(([key]) => key in properties));
    const read = await boundedRead(review, readTool.publicName, readArgs);
    const result = object(read.result?.structuredContent);
    if (read.result?.isError || result?.schema !== "morrow.lms-api.result.v1" || result.ok !== true
      || result.provider !== lmsMapping.capability?.provider || !Array.isArray(result.targets)
      || (operation.state === "awaiting_approval" && (result.snapshot_digest !== args.expected_digest || result.connection_digest !== args.expected_connection))) {
      return { targets: [], ...(read.limited ? { limited: true } : {}) };
    }
    const data = object(result.data) || {};
    const current = operation.state === "awaiting_approval" ? currentContent(args, object(data.content) || data) : {};
    return { ...(Object.keys(current).length ? { current } : {}), targets: result.targets.filter(isJsonObject).flatMap((target) => {
      const field = exactText(target.field);
      const label = exactText(target.label);
      const name = exactText(target.name);
      return field && label && name && field in args ? [{ field, label, name }] : [];
    }) };
  }
  if (!operation.sourceBindingId) return { targets: [] };
  const args = planArguments(operation);
  const mapping = operationTool(operation, tools);
  if (!args || !mapping) return { targets: [] };

  const courseField = "course_id" in args ? "course_id"
    : ["canvas_update_course", "canvas_add_course_to_favorites", "canvas_remove_course_from_favorites"].includes(mapping.upstreamName) ? "id" : null;
  const courseId = courseField ? exactId(args[courseField]) : null;
  const course = courseId ? {
    field: courseField!,
    label: "Course",
    id: courseId,
    readTool: "canvas_get_single_course_courses",
    readArguments: { id: courseId },
    entityId: (value: JsonObject) => sameId(value.id, courseId),
    nameFields: ["name"],
    urlPath: ["courses", courseId],
  } satisfies TargetSpec : null;
  const resource = resourceSpec(mapping, args, courseId);
  const question = questionSpec(mapping, args, courseId);
  const moduleItem = moduleItemSpec(mapping, args, courseId);
  const expected = [course, resource, question, moduleItem].filter((target): target is TargetSpec => target !== null);
  if (expected.length === 0) return { targets: [] };

  const bindingTool = exactSourceTool(tools, operation.sourceId, "morrow_canvas_bindings", false);
  if (!bindingTool) return {
    targets: expected.map((target) => ({ field: target.field, label: target.label, name: "" })),
  };
  const bindingRead = await boundedRead(review, bindingTool.publicName, {});
  const origin = bindingRead.result ? bindingOrigin(bindingRead.result, operation.sourceBindingId) : null;
  if (!origin) return {
    targets: expected.map((target) => ({ field: target.field, label: target.label, name: "" })),
    ...(bindingRead.limited ? { limited: true } : {}),
  };

  const results = await Promise.all(expected.map(async (target) => {
    const readTool = exactSourceTool(tools, operation.sourceId, target.readTool, true);
    if (!readTool) return [target, { result: null, limited: false }] as const;
    const response = await boundedRead(review, readTool.publicName, {
      ...target.readArguments,
      _morrow: { source_binding_id: operation.sourceBindingId },
    });
    return [target, response] as const;
  }));
  const resourceResult = results.find(([target]) => target === resource);
  const entity = resourceResult?.[1].result ? canvasEntity(resourceResult[1].result) : null;
  const questionResult = results.find(([target]) => target === question);
  const questionEntity = questionResult?.[1].result ? canvasEntity(questionResult[1].result) : null;
  const current = resourceResult && entity && resolvedTarget(resourceResult[0], resourceResult[1].result, origin).name
    && operation.state === "awaiting_approval" ? currentContent(args, entity) : {};
  const questionContent = questionResult && questionEntity && resolvedTarget(questionResult[0], questionResult[1].result, origin).name
    && operation.state === "awaiting_approval" && mapping.upstreamName === "canvas_update_quiz_item"
    ? currentQuestionContent(questionEntity) : {};
  return {
    ...(Object.keys(current).length ? { current } : {}),
    ...(Object.keys(questionContent).length ? { question: questionContent } : {}),
    targets: results.map(([target, response]) => resolvedTarget(target, response.result, origin)),
    ...(results.some(([, response]) => response.limited) ? { limited: true } : {}),
  };
}
