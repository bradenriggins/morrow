import {
  isJsonObject,
  sha256Json,
  type CatalogTool,
  type JsonObject,
} from "@morrow/contracts";
import { BLACKBOARD_CONTENT_PATCH_APPLY_TOOL } from "./blackboard-content-patch.js";
import { BLACKBOARD_ACTIONS } from "./blackboard-actions.js";

const CANVAS_ID = /^[1-9][0-9]{0,18}$/;
const BLACKBOARD_ID = /^_[1-9][0-9]{0,18}_[1-9][0-9]{0,18}$/;
const REVIEW_READ_TIMEOUT_MS = 4_000;
const REVIEW_READ_BUDGET = 200;
const ITEM_BANK_UPDATE_TOOL = "canvas_item_bank_update_item";
const ITEM_BANK_GUARD_KIND = "item_bank_entry_image_alt";
/*
 * The review reads one course name for each course the bank reaches, up to this
 * many. Every course is still listed: the ones past this limit are shown by
 * their Canvas id and said to be unread, because a person waiting minutes for a
 * review window is worse than an id with an honest note beside it.
 */
const ITEM_BANK_COURSE_NAME_READS = 25;

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

function moodleBinding(result: JsonObject, sourceBindingId: string): { readonly courseId: string } | null {
  if (result.isError === true) return null;
  const content = object(result.structuredContent);
  if (!content || content.schema !== "morrow.browser-bindings.v1" || !Array.isArray(content.bindings)) return null;
  const binding = content.bindings.find((candidate) => {
    const value = object(candidate);
    return value?.sourceBindingId === sourceBindingId
      && value.provider === "moodle"
      && value.runtimeVerified === true;
  });
  const value = object(binding);
  const origin = exactText(value?.origin);
  const siteUrl = exactText(value?.siteUrl);
  const courseId = typeof value?.courseId === "string" && CANVAS_ID.test(value.courseId) ? value.courseId : null;
  if (!origin || !siteUrl || !courseId) return null;
  try {
    const parsedOrigin = new URL(origin);
    const parsedSiteUrl = new URL(siteUrl);
    const valid = parsedOrigin.protocol === "https:" && parsedOrigin.origin === origin
      && parsedSiteUrl.protocol === "https:" && parsedSiteUrl.href === siteUrl
      && !parsedSiteUrl.username && !parsedSiteUrl.password && !parsedSiteUrl.search && !parsedSiteUrl.hash
      && parsedSiteUrl.origin === origin;
    return valid ? { courseId } : null;
  } catch {
    return null;
  }
}

function moodleCourseId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === "string" && CANVAS_ID.test(value) ? value : null;
}

function moodleSectionName(value: JsonObject): string | null {
  const name = exactText(value.title || value.rawtitle);
  if (!name) return null;
  const number = value.number;
  const validNumber = typeof number === "number" && Number.isSafeInteger(number) && number >= 0
    ? String(number)
    : typeof number === "string" && /^(?:0|[1-9][0-9]*)$/.test(number) ? number : null;
  return validNumber === null ? name : `Section ${validNumber}: ${name}`;
}

function moodleRead(result: JsonObject): {
  readonly data: JsonObject;
  readonly targets: readonly JsonObject[];
  readonly snapshotDigest: string;
} | null {
  if (result.isError === true) return null;
  const content = object(result.structuredContent);
  if (!content || content.schema !== "morrow.canvas-connector.result.v1" || content.ok !== true
    || content.provider !== "moodle" || content.commandKind !== "invoke_read") return null;
  const browser = object(content.result);
  const data = object(browser?.data);
  if (!browser || browser.ok !== true || browser.sent !== true || !data || !Array.isArray(browser.targets)
    || typeof browser.snapshot_digest !== "string" || !/^[0-9a-f]{64}$/.test(browser.snapshot_digest)) return null;
  return {
    data,
    targets: browser.targets.filter(isJsonObject),
    snapshotDigest: browser.snapshot_digest,
  };
}

function moodleGradebookRead(result: JsonObject): {
  readonly data: JsonObject;
  readonly snapshotDigest: string;
} | null {
  if (result.isError === true) return null;
  const content = object(result.structuredContent);
  if (!content || content.schema !== "morrow.canvas-connector.result.v1" || content.ok !== true
    || content.provider !== "moodle" || content.commandKind !== "invoke_read") return null;
  const browser = object(content.result);
  const data = object(browser?.data);
  if (!browser || browser.ok !== true || browser.sent !== true || !data
    || typeof browser.snapshot_digest !== "string" || !/^[0-9a-f]{64}$/.test(browser.snapshot_digest)) return null;
  return { data, snapshotDigest: browser.snapshot_digest };
}

function gradebookSetupName(value: JsonObject, courseId: string, field: "categories" | "grade_item_links", id: string): string | null {
  if (!sameId(value.course_id, courseId)) return null;
  const entries = value[field];
  const matches = Array.isArray(entries) ? entries.filter((entry) => sameId(object(entry)?.id, id)) : [];
  const target = matches.length === 1 ? object(matches[0]) : null;
  return target ? exactText(target.name) : null;
}

async function moodleGradebookApprovalContext(
  input: ApprovalReviewContextInput,
  review: ApprovalReviewContextInput,
  operation: ApprovalReviewOperation,
  args: JsonObject,
  binding: { readonly courseId: string },
  reviewTool: CatalogTool,
): Promise<ApprovalReviewContext | null> {
  const category = operation.sourceToolName === "moodle_update_grade_category";
  const targetField = category ? "category_id" : "grade_item_id";
  const targetId = moodleCourseId(args[targetField]);
  const proposedName = exactText(args[category ? "fullname" : "item_name"]);
  const courseTool = exactSourceTool(input.tools, operation.sourceId, "moodle_get_course", false);
  const setupTool = exactSourceTool(input.tools, operation.sourceId, "moodle_get_gradebook_setup", false);
  if (!targetId || !proposedName || !courseTool || !setupTool) return null;
  const courseArgs = { course_id: args.course_id, _morrow: { source_binding_id: operation.sourceBindingId! } };
  const [courseRead, setupRead, targetRead] = await Promise.all([
    boundedRead(review, courseTool.publicName, courseArgs),
    boundedRead(review, setupTool.publicName, courseArgs),
    boundedRead(review, reviewTool.publicName, { ...courseArgs, [targetField]: args[targetField] }),
  ]);
  const course = courseRead.result ? moodleRead(courseRead.result) : null;
  const setup = setupRead.result ? moodleGradebookRead(setupRead.result) : null;
  const target = targetRead.result ? moodleGradebookRead(targetRead.result) : null;
  const courseName = course && sameId(course.data.course_id, binding.courseId) ? exactText(course.data.fullname) : null;
  const setupName = setup
    ? gradebookSetupName(setup.data, binding.courseId, category ? "categories" : "grade_item_links", targetId) : null;
  const protectedSettings = target && typeof target.data.protected_settings_digest === "string"
    && /^[0-9a-f]{64}$/.test(target.data.protected_settings_digest)
    && Array.isArray(target.data.protected_setting_names) && target.data.protected_setting_names.every((name) => typeof name === "string");
  const rawCurrent = target?.data[category ? "fullname" : "item_name"];
  const currentName = category && rawCurrent === "" ? "Course grade category" : exactText(rawCurrent);
  const targetMatches = target && (operation.state !== "awaiting_approval" || target.snapshotDigest === args.expected_digest)
    && sameId(target.data.course_id, binding.courseId) && sameId(target.data[targetField], targetId)
    && protectedSettings && currentName
    && (category ? (rawCurrent === "" || rawCurrent === setupName) : target.data.item_type === "manual" && rawCurrent === setupName);
  if (!courseName || !setupName || !targetMatches) return null;
  return {
    targets: [
      { field: "course_id", label: "Course", name: courseName },
      { field: targetField, label: category ? "Grade category" : "Manual grade item", name: category && rawCurrent === "" ? "Course grade category" : setupName },
    ],
    current: { gradebook_current_name: currentName },
  };
}

/** The one Blackboard content update Morrow reviews, resolved from the catalog. */
function blackboardContentPatchTool(
  operation: ApprovalReviewOperation,
  tools: readonly CatalogTool[],
): CatalogTool | null {
  const matches = tools.filter((tool) => (
    tool.publicName === operation.publicToolName
    && tool.upstreamId === operation.sourceId
    && tool.upstreamName === operation.sourceToolName
    && (tool.upstreamName === BLACKBOARD_CONTENT_PATCH_APPLY_TOOL || BLACKBOARD_ACTIONS.some((action) => action.apply.name === tool.upstreamName))
    && tool.annotations?.readOnlyHint !== true
    && tool.capability?.provider === "blackboard"
    && tool.capability.route.backend === "lms-api"
  ));
  return matches.length === 1 ? matches[0]! : null;
}

function blackboardId(value: unknown): string | null {
  return typeof value === "string" && BLACKBOARD_ID.test(value) ? value : null;
}

/** One Blackboard read projection, admitted only for the exact reviewed scope. */
function blackboardRead(
  result: JsonObject,
  schema: string,
  args: JsonObject,
  sourceBindingId: string,
): JsonObject | null {
  if (result.isError === true) return null;
  const content = object(result.structuredContent);
  if (!content || content.schema !== schema || content.ok !== true
    || content.tenantId !== args.tenant_id
    || content.sourceBindingId !== sourceBindingId
    || content.courseId !== args.course_id) return null;
  return content;
}

/**
 * Names the Blackboard course and content item a reviewed patch changes, and
 * shows the item's current values beside the requested ones. Both names come
 * from the Blackboard source's own redacted read projection: a name the source
 * withheld, or did not return, leaves the review unnamed rather than showing a
 * name Morrow built from the request.
 */
async function blackboardApprovalContext(
  input: ApprovalReviewContextInput,
  review: ApprovalReviewContextInput,
): Promise<ApprovalReviewContext> {
  const { operation, tools } = input;
  if (!operation.sourceBindingId) return { targets: [] };
  const args = planArguments(operation);
  const courseTool = exactSourceTool(tools, operation.sourceId, "blackboard_read_course", false);
  const contentTool = exactSourceTool(tools, operation.sourceId, "blackboard_read_course_content", false);
  const courseId = args ? blackboardId(args.course_id) : null;
  const contentId = args ? blackboardId(args.content_id) : null;
  const tenantId = args && typeof args.tenant_id === "string" ? args.tenant_id : null;
  const action = BLACKBOARD_ACTIONS.find((entry) => entry.apply.name === operation.sourceToolName);
  if (action && args && courseTool && courseId && tenantId) {
    const planner = exactSourceTool(tools, operation.sourceId, action.plan.name, false);
    if (!planner) return { targets: [] };
    const { expected_connection: _connection, expected_plan_digest: _digest, _morrow: _routing, ...request } = args;
    const parsed = action.plan.inputSchema.safeParse(request);
    if (!parsed.success) return { targets: [] };
    const [courseRead, planRead] = await Promise.all([
      boundedRead(review, courseTool.publicName, { tenant_id: tenantId, source_binding_id: operation.sourceBindingId, course_id: courseId }),
      boundedRead(review, planner.publicName, parsed.data as JsonObject),
    ]);
    const courseResult = courseRead.result ? blackboardRead(courseRead.result, "morrow.blackboard.course.v1", args, operation.sourceBindingId) : null;
    const course = courseResult ? object(courseResult.course) : null;
    const courseName = course && course.id === courseId ? exactText(course.name) : null;
    const plan = planRead.result ? object(planRead.result.structuredContent) : null;
    const before = plan && plan.ok === true && plan.tenantId === tenantId && plan.sourceBindingId === operation.sourceBindingId && plan.courseId === courseId
      ? object(plan.before) : null;
    const targets: ApprovalReviewContext["targets"][number][] = courseName ? [{ field: "course_id", label: "Course", name: courseName }] : [];
    const itemName = before ? exactText(before.title) || exactText(before.name) : null;
    if (itemName) {
      const field = ["content_id", "announcement_id", "group_id", "column_id"].find((key) => typeof args[key] === "string");
      if (field) targets.push({ field, label: "Item", name: itemName });
    }
    return {
      targets,
      ...(operation.state === "awaiting_approval" && before ? { current: before } : {}),
      ...(courseRead.limited || planRead.limited ? { limited: true } : {}),
    };
  }
  if (!args || !courseTool || !contentTool || !courseId || !contentId || !tenantId) return { targets: [] };
  const scope = {
    tenant_id: tenantId,
    source_binding_id: operation.sourceBindingId,
    course_id: courseId,
  };
  const [courseRead, contentRead] = await Promise.all([
    boundedRead(review, courseTool.publicName, scope),
    boundedRead(review, contentTool.publicName, { ...scope, content_id: contentId }),
  ]);
  const limited = courseRead.limited || contentRead.limited ? { limited: true } : {};
  const courseResult = courseRead.result
    ? blackboardRead(courseRead.result, "morrow.blackboard.course.v1", args, operation.sourceBindingId) : null;
  const contentResult = contentRead.result
    ? blackboardRead(contentRead.result, "morrow.blackboard.content.v1", args, operation.sourceBindingId) : null;
  const course = courseResult ? object(courseResult.course) : null;
  const item = contentResult && contentResult.contentId === contentId ? object(contentResult.content) : null;
  const courseName = course && course.id === courseId ? exactText(course.name) : null;
  const itemTitle = item && item.id === contentId ? exactText(item.title) : null;
  if (!item || !courseName || !itemTitle) return { targets: [], ...limited };
  const availability = object(item.availability);
  const current = operation.state === "awaiting_approval" ? {
    title: itemTitle,
    ...(typeof item.description === "string" ? { description: item.description } : {}),
    ...(availability && typeof availability.available === "string"
      ? { availability: { available: availability.available } } : {}),
  } : {};
  return {
    ...(Object.keys(current).length ? { current } : {}),
    targets: [
      { field: "course_id", label: "Course", name: courseName },
      { field: "content_id", label: "Item", name: itemTitle },
    ],
    ...limited,
  };
}

function approvalTargets(args: JsonObject, targets: readonly JsonObject[]): ApprovalReviewContext["targets"] {
  return targets.flatMap((target) => {
    const field = exactText(target.field);
    const label = exactText(target.label);
    const name = exactText(target.name);
    return field && label && name && field in args ? [{ field, label, name }] : [];
  });
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

interface ItemBankTarget {
  readonly courseId: string;
  readonly bankId: string;
  readonly bankEntryId: string;
  readonly itemId: string;
  /** The courses the frozen record names, or null when that list is unreadable. */
  readonly externalCourseIds: readonly string[] | null;
  readonly fanOutComplete: boolean;
}

/**
 * The one Item Bank question change Morrow reviews, taken from the guard the
 * plan froze. The guard carries the course, the bank, the entry, the question,
 * and the record of every course the bank reaches, so the review needs no other
 * source for the scope of the change.
 */
function itemBankGuardTarget(mapping: CatalogTool, args: JsonObject): ItemBankTarget | null {
  if (mapping.upstreamName !== ITEM_BANK_UPDATE_TOOL || mapping.capability?.family !== "new-quizzes-item-banks") return null;
  const guard = object(args.morrow_item_bank_guard);
  if (!guard || guard.kind !== ITEM_BANK_GUARD_KIND) return null;
  const courseId = exactId(guard.course_id);
  const bankId = exactId(guard.bank_id);
  const bankEntryId = exactId(guard.bank_entry_id);
  const itemId = exactId(guard.item_id);
  if (!courseId || !bankId || !bankEntryId || !itemId
    || bankId !== exactId(args.bank_id) || itemId !== exactId(args.item_id)) return null;
  const fanOut = object(guard.fan_out);
  const listed = Array.isArray(fanOut?.external_course_ids)
    ? fanOut.external_course_ids.map((value) => exactId(value)) : null;
  const ids = listed ? listed.filter((id): id is string => id !== null) : null;
  // A list Morrow cannot read is not a list of no courses, so an unreadable
  // record becomes null here and the review says the reach is unread.
  const externalCourseIds = listed && ids && ids.length === listed.length && new Set(ids).size === ids.length ? ids : null;
  return { courseId, bankId, bankEntryId, itemId, externalCourseIds, fanOutComplete: fanOut?.complete === true };
}

/** One fresh Canvas read reduced to the entity it confirms, or null. */
function readEntity(result: JsonObject | null, matches: (value: JsonObject) => boolean): JsonObject | null {
  const entity = result ? canvasEntity(result) : null;
  return entity && matches(entity) ? entity : null;
}

function itemBankCourseName(result: JsonObject | null, courseId: string): string | null {
  const course = readEntity(result, (value) => sameId(value.id, courseId));
  return course ? exactText(course.name) : null;
}

/**
 * Names every course one Item Bank question change reaches, before a person
 * approves it. An item bank is shared machinery: the same question can be drawn
 * by quizzes in courses nobody opened. The review reads the selected course, the
 * bank, the bank entry, and the question, and then reads the name of each course
 * the frozen record names.
 *
 * A course whose name no fresh read supplies is shown by its Canvas id and said
 * to be unread; no name is built from the request. The question body and the
 * image source stay out of the review: the person approves one alternative-text
 * change, and the review shows the course, the bank, the question, and the reach.
 */
async function itemBankApprovalContext(
  input: ApprovalReviewContextInput,
  review: ApprovalReviewContextInput,
  target: ItemBankTarget,
): Promise<ApprovalReviewContext> {
  const { operation } = input;
  const sourceBindingId = operation.sourceBindingId!;
  const read = async (upstreamName: string, readArguments: JsonObject) => {
    const readTool = exactSourceTool(input.tools, operation.sourceId, upstreamName, true);
    return readTool
      ? await boundedRead(review, readTool.publicName, { ...readArguments, _morrow: { source_binding_id: sourceBindingId } })
      : { result: null, limited: false };
  };
  const named = (target.externalCourseIds || []).slice(0, ITEM_BANK_COURSE_NAME_READS);
  const [courseRead, bankRead, entryRead, itemRead, ...courseReads] = await Promise.all([
    read("canvas_get_single_course_courses", { id: target.courseId }),
    read("canvas_item_bank_get_bank", { bank_id: target.bankId }),
    read("canvas_item_bank_get_entry", { bank_id: target.bankId, bank_entry_id: target.bankEntryId }),
    read("canvas_item_bank_get_item", { bank_id: target.bankId, item_id: target.itemId }),
    ...named.map((id) => read("canvas_get_single_course_courses", { id })),
  ]);
  const bank = readEntity(bankRead.result, (value) => sameId(value.id, target.bankId));
  const bankName = bank ? exactText(bank.title) || exactText(bank.name) : null;
  // The entry route resolves inside this bank, so a returned Item entry shows
  // that the guard's entry is a question entry of this bank. That the entry and
  // the question are the same target was proven when the change was planned and
  // is proven again inside the Item Banks frame before anything is sent.
  const entry = readEntity(entryRead.result, (value) => value.entry_type === "Item");
  const item = readEntity(itemRead.result, (value) => sameId(value.id, target.itemId) && value.entry_type === "Item");
  const question = entry && item ? object(item.entry) : null;
  const title = question ? exactText(question.title) : null;
  // Provider text names the question here. Markup in a name is not a name, and a
  // long one does not read as one, so neither is shown.
  const questionName = question
    ? (title && title.length <= 200 && !title.includes("<") ? title : `Item bank question ${target.itemId}`)
    : "";
  const names = new Map(named.map((id, index) => [id, itemBankCourseName(courseReads[index]?.result || null, id)]));
  const external = target.externalCourseIds || [];
  const listed = external.map((id) => {
    if (!names.has(id)) return `Course ${id}`;
    const name = names.get(id);
    return name ? `${name} (course ${id})` : `Course ${id} (Morrow could not read this course name)`;
  }).join(", ");
  // "Nobody read the courses" and "no course draws from this bank" are different
  // answers, and only the complete record may give the second one.
  const complete = target.fanOutComplete && target.externalCourseIds !== null;
  const reach = [
    listed ? `${listed}.` : complete ? "No other course uses this item bank." : "",
    external.length > named.length ? `Morrow read the first ${ITEM_BANK_COURSE_NAME_READS} of these course names.` : "",
    complete ? "" : "Morrow could not read every course this item bank reaches.",
  ].filter(Boolean).join(" ");
  return {
    targets: [
      { field: "course_id", label: "Course", name: itemBankCourseName(courseRead.result, target.courseId) || "" },
      { field: "bank_id", label: "Item Bank", name: bankName || "" },
      { field: "morrow_item_bank_fan_out", label: "Also changes these courses", name: reach },
      { field: "item_id", label: "Question", name: questionName },
    ],
    ...([courseRead, bankRead, entryRead, itemRead, ...courseReads].some((response) => response.limited) ? { limited: true } : {}),
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

function moodleCurrentVisibility(toolName: string, args: JsonObject, value: JsonObject): boolean | null {
  if (!/^moodle_(?:show|hide)_(?:course|section|activity)$/.test(toolName)) return null;
  if (toolName.endsWith("_course")) return typeof value.visible === "boolean" ? value.visible : null;
  const section = toolName.endsWith("_section");
  const field = section ? "section_id" : "module_id";
  const targetId = moodleCourseId(args[field]);
  const entries = value[section ? "sections" : "activities"];
  const target = Array.isArray(entries) ? entries.find((entry) => sameId(object(entry)?.id, targetId || "")) : null;
  const visible = object(target)?.visible;
  return typeof visible === "boolean" ? visible : null;
}

function currentContent(args: JsonObject, value: JsonObject, toolName = ""): JsonObject {
  const fields: Record<string, string> = {
    wiki_page_body: "body", wiki_page_title: "title", wiki_page_published: "published",
    assignment_description: "description", assignment_name: "name", assignment_points_possible: "points_possible",
    assignment_due_at: "due_at", assignment_unlock_at: "unlock_at", assignment_lock_at: "lock_at", assignment_published: "published",
    quiz_instructions: "instructions", quiz_title: "title", body: "body", summary: "summary", title: "title", message: "message", published: "published",
    name: "name", content: "content", instructions: "instructions", due_date: "due_date", open_at: "open_at", close_at: "close_at", visible: "visible",
  };
  const current = Object.fromEntries(Object.entries(fields).flatMap(([field, source]) => field in args && Object.hasOwn(value, source) ? [[field, value[source]!]] : []));
  const visible = moodleCurrentVisibility(toolName, args, value);
  return visible === null ? current : { ...current, visible };
}

function currentMoodleUrlContent(value: JsonObject): JsonObject {
  const fields = ["name", "external_url", "description"] as const;
  return Object.fromEntries(fields.flatMap((field) => Object.hasOwn(value, field) ? [[field, value[field]!]] : []));
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
  if (blackboardContentPatchTool(operation, tools)) return await blackboardApprovalContext(input, review);
  const browserMapping = operationTool(operation, tools);
  if (browserMapping?.capability?.provider === "moodle") {
    if (!operation.sourceBindingId) return { targets: [] };
    const args = planArguments(operation);
    const reviewTool = exactSourceTool(tools, operation.sourceId, browserMapping.capability.route.planBackend || "", false);
    const bindingTool = exactSourceTool(tools, operation.sourceId, "morrow_browser_bindings", false);
    if (!args || !reviewTool || !bindingTool || reviewTool.capability?.route.backend !== "canvas-connector"
      || reviewTool.capability.provider !== "moodle") return { targets: [] };
    const bindingRead = await boundedRead(review, bindingTool.publicName, {});
    const binding = bindingRead.result ? moodleBinding(bindingRead.result, operation.sourceBindingId) : null;
    if (!binding || ("course_id" in args && moodleCourseId(args.course_id) !== binding.courseId)) {
      return { targets: [], ...(bindingRead.limited ? { limited: true } : {}) };
    }
    if (["moodle_update_grade_category", "moodle_update_grade_item"].includes(browserMapping.upstreamName)) {
      return (await moodleGradebookApprovalContext(input, review, operation, args, binding, reviewTool)) || { targets: [] };
    }
    const properties = object(reviewTool.inputSchema.properties) || {};
    const readArgs = {
      ...Object.fromEntries(Object.entries(args).filter(([key]) => key in properties)),
      _morrow: { source_binding_id: operation.sourceBindingId },
    };
    const read = await boundedRead(review, reviewTool.publicName, readArgs);
    const result = read.result ? moodleRead(read.result) : null;
    if (!result || (operation.state === "awaiting_approval" && result.snapshotDigest !== args.expected_digest)) {
      return { targets: [], ...(read.limited ? { limited: true } : {}) };
    }
    let targets = [...result.targets];
    let current = operation.state === "awaiting_approval" && !["moodle_create_page", "moodle_create_label", "moodle_create_url", "moodle_create_resource_file", "moodle_create_folder_file", "moodle_create_imscp_package", "moodle_create_scorm_package", "moodle_create_assignment", "moodle_create_quiz", "moodle_create_forum", "moodle_create_choice"].includes(browserMapping.upstreamName)
      ? browserMapping.upstreamName === "moodle_update_url" ? currentMoodleUrlContent(result.data) : currentContent(args, result.data, browserMapping.upstreamName) : {};
    if (/^moodle_(?:show|hide)_(?:section|activity)$/.test(browserMapping.upstreamName)) {
      const section = browserMapping.upstreamName.endsWith("_section");
      const field = section ? "section_id" : "module_id";
      const entries = result.data[section ? "sections" : "activities"];
      const selected = Array.isArray(entries) ? entries.filter((entry) => sameId(object(entry)?.id, moodleCourseId(args[field]) || "")) : [];
      const target = selected.length === 1 ? object(selected[0]) : null;
      const name = target ? exactText(section ? target.title || target.rawtitle : target.name) : null;
      if (name) targets.push({ field, label: section ? "Section" : "Activity", name });
    }
    if (browserMapping.upstreamName === "moodle_move_activity") {
      const activityId = moodleCourseId(args.module_id);
      const destinationId = moodleCourseId(args.target_section_id);
      const activities = Array.isArray(result.data.activities) ? result.data.activities : [];
      const sections = Array.isArray(result.data.sections) ? result.data.sections : [];
      const activitiesMatched = activities.filter((entry) => sameId(object(entry)?.id, activityId || ""));
      const sectionsMatched = sections.filter((entry) => sameId(object(entry)?.id, destinationId || ""));
      const activity = activitiesMatched.length === 1 ? object(activitiesMatched[0]) : null;
      const destination = sectionsMatched.length === 1 ? object(sectionsMatched[0]) : null;
      const sourceId = activity ? moodleCourseId(activity.sectionid) : null;
      const sourcesMatched = sections.filter((entry) => sameId(object(entry)?.id, sourceId || ""));
      const source = sourcesMatched.length === 1 ? object(sourcesMatched[0]) : null;
      const activityName = activity ? exactText(activity.name) : null;
      const destinationName = destination ? moodleSectionName(destination) : null;
      const sourceName = source ? moodleSectionName(source) : null;
      if (activityName) targets.push({ field: "module_id", label: "Activity", name: activityName });
      if (destinationName) targets.push({ field: "target_section_id", label: "Destination section", name: destinationName });
      if (operation.state === "awaiting_approval" && sourceName) current = { ...current, current_section: sourceName };
    }
    if (["moodle_show_book_chapter", "moodle_hide_book_chapter", "moodle_delete_book_chapter"].includes(browserMapping.upstreamName)) {
      const chapterId = moodleCourseId(args.chapter_id);
      const chapters = Array.isArray(result.data.chapters) ? result.data.chapters : [];
      const matches = chapters.filter((entry) => sameId(object(entry)?.chapter_id, chapterId || ""));
      const chapter = matches.length === 1 ? object(matches[0]) : null;
      const name = chapter ? exactText(chapter.title) : null;
      const hidden = chapter?.hidden;
      const expectedHidden = browserMapping.upstreamName === "moodle_show_book_chapter";
      if (!chapter || !name || (browserMapping.upstreamName !== "moodle_delete_book_chapter" && hidden !== expectedHidden)) return { targets: [] };
      targets.push({ field: "chapter_id", label: "Chapter", name });
      if (operation.state === "awaiting_approval") {
        const index = chapters.indexOf(matches[0]!);
        const affected: JsonObject[] = [chapter];
        if (chapter.subchapter !== true) {
          for (let next = index + 1; next < chapters.length && object(chapters[next])?.subchapter === true; next += 1) {
            const child = object(chapters[next]);
            if (!child || !exactText(child.title)) return { targets: [] };
            affected.push(child);
          }
        }
        current = browserMapping.upstreamName === "moodle_delete_book_chapter"
          ? { ...current, affected_chapters: affected.map((entry) => entry.content_file_state === "nonempty" ? `${entry.title} (contains attached files)` : entry.title) }
          : { ...current, hidden, affected_chapters: affected.map((entry) => entry.title) };
      }
    }
    if (["moodle_create_resource_file", "moodle_create_folder_file", "moodle_create_imscp_package", "moodle_create_scorm_package"].includes(browserMapping.upstreamName)) {
      const contentsTool = exactSourceTool(tools, operation.sourceId, "moodle_get_contents", false);
      const sectionId = moodleCourseId(args.section_id);
      if (contentsTool && sectionId) {
        const contentsRead = await boundedRead(review, contentsTool.publicName, {
          course_id: args.course_id,
          _morrow: { source_binding_id: operation.sourceBindingId },
        });
        const contents = contentsRead.result ? moodleRead(contentsRead.result) : null;
        const course = contents ? object(contents.data.course) : null;
        const matches = contents && sameId(course?.id, binding.courseId) && Array.isArray(contents.data.sections)
          ? contents.data.sections.filter((entry) => sameId(object(entry)?.id, sectionId)) : [];
        const section = matches.length === 1 ? object(matches[0]) : null;
        const sectionName = section ? moodleSectionName(section) : null;
        if (sectionName) targets = targets.map((target) => (
          target.field === "section_id" ? { ...target, name: sectionName } : target
        ));
      }
    }
    const approvedTargets = approvalTargets(args, targets);
    return {
      ...(Object.keys(current).length ? { current } : {}),
      targets: approvedTargets,
      ...(read.limited ? { limited: true } : {}),
    };
  }
  if (!operation.sourceBindingId) return { targets: [] };
  const args = planArguments(operation);
  const mapping = operationTool(operation, tools);
  if (!args || !mapping) return { targets: [] };
  const itemBank = itemBankGuardTarget(mapping, args);
  if (itemBank) return await itemBankApprovalContext(input, review, itemBank);

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
