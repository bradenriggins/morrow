import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { MAX_BATCH_RESULT_BYTES } from "@morrow/batch-engine";
import { canonicalJson, isJsonObject, sha256Text, type JsonObject } from "@morrow/contracts";
import * as z from "zod/v4";
import { MOODLE_AUDITABLE_QUESTION_TYPES } from "./course-audit.js";
import { resolveResultArtifact, type ResultArtifactPage } from "./result-artifacts.js";
import type { GatewayRuntime } from "./runtime.js";

const canvasId = z.string().regex(/^[1-9][0-9]{0,18}$/);
const moodleId = z.number().int().min(1).max(9_007_199_254_740_991);
const sourceBindingId = z.string().min(1).max(160);
const MAX_RECORDS_PER_LIST = 10_000;
// One source list may not spend the whole per-course call budget. A course has
// many collections, so a long Pages list must not starve modules, quizzes or
// files. The per-course budget still bounds every list together.
const MAX_CALLS_PER_LIST = 8;
const MAX_TARGETS_PER_COURSE = 20_000;
// One Moodle Folder can hold thousands of files. The inventory keeps a bounded
// projection of each file listing so a single Folder cannot crowd every other
// discovered target out of the bounded report.
const MAX_FILES_PER_ACTIVITY = 200;
// Share rows one Item Bank share read asks for. Item Bank share paging is
// live-unverified, so a response this long may be one page of more and the read
// is recorded as incomplete instead of as the whole share list.
const ITEM_BANK_SHARES_PER_PAGE = 100;
// Shared course ids one bank entry target repeats. A widely shared bank keeps
// its exact count next to this bounded projection.
const MAX_SHARED_COURSES_PER_BANK = 50;
const INVENTORY_RESULT_BYTE_LIMIT = MAX_BATCH_RESULT_BYTES;
// Current Instructure documentation describes BankItem in its glossary but shows
// Bank in one response-field list. Retain both observed wire values so neither
// documented representation is silently dropped from the inventory.
const NEW_QUIZ_ENTRY_TYPES = new Set(["Item", "Stimulus", "BankEntry", "Bank", "BankItem"]);
const moodleAuditableQuestionTypes = new Set<string>(MOODLE_AUDITABLE_QUESTION_TYPES);

const courseSelectionSchema = z.strictObject({
  course_id: canvasId,
  expected_name: z.string().min(1).max(500),
  source_binding_id: sourceBindingId,
});

export const courseInventoryInputSchema = z.strictObject({
  provider: z.literal("canvas"),
  scope: z.literal("selected_program"),
  courses: z.array(courseSelectionSchema).min(1).max(100),
  max_pages_per_list: z.number().int().min(1).max(50).default(25),
  max_list_calls_per_course: z.number().int().min(8).max(1_000).default(250),
});

const moodleCourseSelectionSchema = z.strictObject({
  course_id: moodleId,
  expected_name: z.string().min(1).max(500),
  source_binding_id: sourceBindingId,
});

export const moodleProgramInventoryInputSchema = z.strictObject({
  provider: z.literal("moodle"),
  scope: z.literal("selected_program"),
  courses: z.array(moodleCourseSelectionSchema).min(1).max(100),
  max_list_calls_per_course: z.number().int().min(8).max(1_000).default(250),
});

export const programInventoryInputSchema = z.discriminatedUnion("provider", [
  courseInventoryInputSchema,
  moodleProgramInventoryInputSchema,
]);

export type CanvasProgramInventoryInput = z.infer<typeof courseInventoryInputSchema>;
export type CanvasCourseInventorySelection = z.infer<typeof courseSelectionSchema>;
export type MoodleProgramInventoryInput = z.infer<typeof moodleProgramInventoryInputSchema>;
export type MoodleCourseInventorySelection = z.infer<typeof moodleCourseSelectionSchema>;
export type ProgramInventoryInput = z.infer<typeof programInventoryInputSchema>;

export interface CanvasAuditChild {
  readonly childId: string;
  readonly courseId: string;
  readonly tool: "morrow_audit_course";
  readonly sourceBindingId: string;
  readonly arguments: JsonObject;
}

class CourseInventoryError extends Error {}

interface CanvasRead {
  readonly data: unknown;
  readonly truncated: boolean;
  readonly paginationObserved: boolean;
  readonly pageCount: number | null;
  /** Opaque connector token that continues this exact list. Never sent to the model. */
  readonly nextPage?: string;
  /** Pages Canvas still holds for this list, or null when Canvas did not state a last page. */
  readonly unreadPages: number | null;
  readonly upstreamId: string;
  readonly upstreamTool: string;
}

interface ListRead {
  readonly name: string;
  readonly tool: string;
  readonly records: readonly JsonObject[];
  readonly rawRecordCount: number;
  readonly complete: boolean;
  readonly status: "observed" | "truncated" | "unavailable";
  readonly upstreamId?: string;
  readonly pageCount?: number | null;
  /** Bounded calls this list used, including resumed continuations. */
  readonly listCalls?: number;
  /** Pages left unread when the bound was reached. Exact only when Canvas stated a last page. */
  readonly unreadPages?: number | "unknown";
  /** A later run can continue this list from the connector's retained token. */
  readonly resumeAvailable?: boolean;
}

interface CoverageGap {
  readonly code: string;
  readonly list: string;
  readonly reason: string;
  readonly blocking: boolean;
  affected_record_count: number;
  readonly sample_record_ids: string[];
}

interface DiscoveredTarget {
  readonly target: JsonObject;
  readonly source_binding_id: string;
  readonly source_list: string;
  readonly course_id: string;
  readonly batch_eligibility: "eligible" | "blocked";
  readonly inventory_state: "discovered" | "discovered_from_incomplete_list";
  readonly discovery: JsonObject;
}

interface CourseInventory {
  readonly course_id: string;
  readonly expected_name: string;
  readonly source_binding_id: string;
  readonly observed_course?: JsonObject;
  status: "inventory_complete" | "inventory_incomplete" | "course_refused";
  readonly lists: JsonObject[];
  readonly targets: DiscoveredTarget[];
  readonly coverage_gaps: CoverageGap[];
  readonly residual_coverage: JsonObject[];
  readonly counters: {
    list_calls: number;
    completed_list_calls: number;
    truncated_list_calls: number;
    unread_page_responses: number;
    /** Canvas only: pages Canvas still holds for the lists a bound left unread. */
    unread_pages?: "unknown" | number;
    unread_record_count: "unknown" | number;
  };
  reason?: string;
}

function sameCanvasId(value: unknown, expected: string): boolean {
  return value === expected || (typeof value === "number" && Number.isSafeInteger(value) && String(value) === expected);
}

function objectText(value: JsonObject, field: string, maximum = 1_000): string | undefined {
  const candidate = value[field];
  return typeof candidate === "string" && candidate.length > 0 && candidate.length <= maximum ? candidate : undefined;
}

function objectId(value: JsonObject, field = "id"): string | undefined {
  const candidate = value[field];
  const id = typeof candidate === "string" ? candidate : typeof candidate === "number" && Number.isSafeInteger(candidate) ? String(candidate) : "";
  return /^[1-9][0-9]{0,18}$/.test(id) ? id : undefined;
}

// Course ids are decimal with no leading zero, so length before text is their
// numeric order. It keeps course 10 after course 9 in every list a person reads.
const compareCourseIds = (a: string, b: string): number =>
  a.length === b.length ? (a < b ? -1 : a > b ? 1 : 0) : a.length - b.length;

interface ItemBankShareEvidence {
  /** Course ids named by the share rows Morrow read. Sorted and de-duplicated. */
  readonly courseIds: string[];
  /** Every share row of this bank was read and every row named one exact course. */
  readonly complete: boolean;
  /** Why these rows are not the whole reach of the bank. */
  readonly limit?: string;
}

/**
 * Reads the share rows of one Item Bank. A row names one context, so a row that
 * names anything but a course reaches courses this route cannot list, and a
 * response as long as the request may be one page of more. Either one leaves the
 * share list explicitly incomplete instead of standing as the bank's whole
 * reach. `packages/mcp-server/src/item-bank-fan-out.ts` reads the same rows
 * under the same rules.
 */
function itemBankShareEvidence(read: ListRead): ItemBankShareEvidence {
  const courseIds = new Set<string>();
  let limit: string | undefined;
  const incomplete = (reason: string): void => {
    if (limit === undefined) limit = reason;
  };
  if (read.status === "unavailable") incomplete("Morrow could not read this bank's share list.");
  else if (!read.complete) incomplete("Morrow read part of this bank's share list before a bound stopped it.");
  for (const row of read.records) {
    const entityType = objectText(row, "entity_type", 100) ?? objectText(row, "entityType", 100);
    const entityId = objectId(row, "entity_id") ?? objectId(row, "entityId");
    if (!entityType || entityType.toLowerCase() !== "course") {
      incomplete(entityType
        ? `One share names an entity of type ${entityType}, not a course. No Item Bank route lists the courses inside it.`
        : "One share row named no context type, so Morrow cannot say which course it reaches.");
    } else if (!entityId) {
      incomplete("One course share row carried no exact course id.");
    } else {
      courseIds.add(entityId);
    }
  }
  // Item Bank share paging is live-unverified. A response as long as the request
  // may be the first page of more, so it is not the whole share list.
  if (read.complete && read.rawRecordCount >= ITEM_BANK_SHARES_PER_PAGE) {
    incomplete(`Canvas returned ${read.rawRecordCount} share rows, as many as Morrow asked for, so this list may continue. Item Bank share paging is not established.`);
  }
  return { courseIds: [...courseIds].sort(compareCourseIds), complete: limit === undefined, ...(limit ? { limit } : {}) };
}

function sourceRead(
  runtime: GatewayRuntime,
  response: JsonObject,
  upstreamId: string,
  upstreamTool: string,
): CanvasRead {
  const resolved = resolveResultArtifact(response, (handle, offset) => runtime.resultPage(handle, offset) as unknown as ResultArtifactPage);
  const content = resolved.structuredContent;
  const result = isJsonObject(content) ? content.result : undefined;
  if (resolved.isError === true || !isJsonObject(content) || content.schema !== "morrow.canvas-connector.result.v1"
    || content.ok !== true || content.commandKind !== "invoke_read" || !isJsonObject(result)
    || result.ok !== true || result.sent !== true) {
    throw new CourseInventoryError("Canvas did not return a readable inventory result.");
  }
  const pageCount = typeof result.pageCount === "number" && Number.isSafeInteger(result.pageCount) && result.pageCount >= 0
    ? result.pageCount : null;
  const paginationObserved = typeof result.truncated === "boolean";
  const nextPage = typeof result.morrow_next_page === "string" && /^[A-Za-z0-9_-]{8,4096}$/.test(result.morrow_next_page)
    ? result.morrow_next_page : undefined;
  const unreadPages = typeof result.morrow_unread_pages === "number" && Number.isSafeInteger(result.morrow_unread_pages)
    && result.morrow_unread_pages >= 1 ? result.morrow_unread_pages : null;
  return {
    data: result.data,
    truncated: result.truncated !== false,
    paginationObserved,
    pageCount,
    ...(nextPage ? { nextPage } : {}),
    unreadPages,
    upstreamId,
    upstreamTool,
  };
}

function requireInput(value: unknown): CanvasProgramInventoryInput {
  const parsed = courseInventoryInputSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Canvas program inventory input is invalid.");
  const courseIds = new Set<string>();
  for (const course of parsed.data.courses) {
    if (courseIds.has(course.course_id)) throw new TypeError("Canvas program inventory requires each selected course id once.");
    courseIds.add(course.course_id);
  }
  return parsed.data;
}

export function parseCanvasProgramInventoryInput(value: unknown): CanvasProgramInventoryInput {
  return requireInput(value);
}

export function parseProgramInventoryInput(value: unknown): ProgramInventoryInput {
  const parsed = programInventoryInputSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Selected-program inventory input is invalid.");
  const courseIds = new Set<string>();
  for (const course of parsed.data.courses) {
    const courseId = String(course.course_id);
    if (courseIds.has(courseId)) throw new TypeError("Selected-program inventory requires each selected course id once.");
    courseIds.add(courseId);
  }
  return parsed.data;
}

function addGap(
  gaps: CoverageGap[],
  input: Omit<CoverageGap, "affected_record_count" | "sample_record_ids"> & { readonly sampleRecordId?: string },
): void {
  const existing = gaps.find((gap) => gap.code === input.code && gap.list === input.list && gap.reason === input.reason && gap.blocking === input.blocking);
  if (existing) {
    existing.affected_record_count += 1;
    if (input.sampleRecordId && existing.sample_record_ids.length < 20 && !existing.sample_record_ids.includes(input.sampleRecordId)) {
      existing.sample_record_ids.push(input.sampleRecordId);
    }
    return;
  }
  gaps.push({
    code: input.code,
    list: input.list,
    reason: input.reason,
    blocking: input.blocking,
    affected_record_count: 1,
    sample_record_ids: input.sampleRecordId ? [input.sampleRecordId] : [],
  });
}

function listProjection(read: ListRead, sourceBinding: string): JsonObject {
  return {
    list: read.name,
    upstream_read_tool: read.tool,
    status: read.status,
    source_binding_id: sourceBinding,
    upstream_id: read.upstreamId ?? null,
    returned_record_count: read.rawRecordCount,
    page_count: read.pageCount ?? null,
    list_calls: read.listCalls ?? 1,
    unread_pages: read.complete ? 0 : read.unreadPages ?? "unknown",
    resume_available: read.resumeAvailable === true,
    truncated: !read.complete,
  };
}

function targetChild(target: DiscoveredTarget): CanvasAuditChild {
  const argumentsValue: JsonObject = {
    provider: "canvas",
    source_binding_id: target.source_binding_id,
    course_id: target.course_id,
    target: target.target,
  };
  const identity = JSON.stringify(argumentsValue);
  return {
    childId: `audit:${sha256Text(identity).slice(0, 32)}`,
    courseId: target.course_id,
    tool: "morrow_audit_course",
    sourceBindingId: target.source_binding_id,
    arguments: argumentsValue,
  };
}

function inventoryTargetKey(courseId: string, sourceBindingId: string, target: JsonObject): string {
  return canonicalJson({ courseId, sourceBindingId, target });
}

function inventoryReportByteLength(value: JsonObject): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

function inventoryCourseTargets(value: JsonObject): {
  readonly course: JsonObject;
  readonly courseId: string;
  readonly sourceBindingId: string;
  readonly targets: JsonObject[];
}[] {
  if (!Array.isArray(value.courses)) throw new TypeError("inventory result has no course collection");
  return value.courses.map((candidate) => {
    if (!isJsonObject(candidate)
      || typeof candidate.course_id !== "string"
      || typeof candidate.source_binding_id !== "string"
      || !Array.isArray(candidate.targets)) {
      throw new TypeError("inventory result course is invalid");
    }
    if (!candidate.targets.every(isJsonObject)) throw new TypeError("inventory result target is invalid");
    const targets = candidate.targets as JsonObject[];
    return {
      course: candidate,
      courseId: candidate.course_id,
      sourceBindingId: candidate.source_binding_id,
      targets,
    };
  });
}

export function auditChildTargetKey(value: JsonObject): string {
  const courseId = typeof value.courseId === "string" ? value.courseId : null;
  const sourceBindingId = typeof value.sourceBindingId === "string" ? value.sourceBindingId : null;
  const argumentsValue = isJsonObject(value.arguments) ? value.arguments : null;
  const target = argumentsValue && isJsonObject(argumentsValue.target) ? argumentsValue.target : null;
  if (!courseId || !sourceBindingId || !target) throw new TypeError("inventory audit child is invalid");
  return inventoryTargetKey(courseId, sourceBindingId, target);
}

function courseTargetKey(course: {
  readonly courseId: string;
  readonly sourceBindingId: string;
}, value: JsonObject): string {
  const target = isJsonObject(value.target) ? value.target : null;
  if (!target) throw new TypeError("inventory target is invalid");
  return inventoryTargetKey(course.courseId, course.sourceBindingId, target);
}

function markDurableResultGap(course: JsonObject, dropped: number): void {
  if (!Number.isSafeInteger(dropped) || dropped < 1 || !Array.isArray(course.coverage_gaps)) {
    throw new TypeError("inventory result cannot record its durable size gap");
  }
  const existing = course.coverage_gaps.find((value) => (
    isJsonObject(value) && value.code === "durable_result_target_cap_reached"
  ));
  if (isJsonObject(existing)) {
    const count = existing.affected_record_count;
    existing.affected_record_count = (typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : 0) + dropped;
  } else {
    course.coverage_gaps.push({
      code: "durable_result_target_cap_reached",
      list: "durable_result",
      reason: "The collector retained only exact audit targets that fit in the durable encrypted result limit.",
      blocking: true,
      affected_record_count: dropped,
      sample_record_ids: [],
    });
  }
  course.status = "inventory_incomplete";
}

function retainAuditChildren(value: JsonObject, courses: readonly ReturnType<typeof inventoryCourseTargets>[number][]): void {
  if (!Array.isArray(value.audit_children)) throw new TypeError("inventory result has no audit child collection");
  const retained = new Set<string>();
  for (const course of courses) {
    for (const target of course.targets) {
      if (target.batch_eligibility === "eligible") retained.add(courseTargetKey(course, target));
    }
  }
  value.audit_children = value.audit_children.map((candidate) => {
    if (!isJsonObject(candidate)) throw new TypeError("inventory audit child is invalid");
    const key = auditChildTargetKey(candidate);
    if (!retained.has(key)) return null;
    return candidate;
  }).filter(isJsonObject);
}

/**
 * Keep the report that crosses the encrypted batch boundary below the store's
 * hard plaintext limit. Every omitted target is explicit coverage loss; all
 * retained targets stay exact and any retained eligible target keeps its audit
 * child. The same function can run after learner egress redaction, whose token
 * substitutions can change byte length.
 */
export function boundProgramInventoryResult(
  value: JsonObject,
  maximumBytes = INVENTORY_RESULT_BYTE_LIMIT,
): JsonObject {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new RangeError("inventory result byte limit is invalid");
  const report = structuredClone(value);
  if (inventoryReportByteLength(report) <= maximumBytes) return report;
  if (report.schema !== "morrow.course-inventory.v1" || !isJsonObject(report.coverage)) {
    throw new TypeError("inventory result cannot be safely bounded");
  }
  const courses = inventoryCourseTargets(report);
  if (!Array.isArray(report.audit_children)) throw new TypeError("inventory result has no audit child collection");
  const auditBytesByTarget = new Map<string, number>();
  for (const candidate of report.audit_children) {
    if (!isJsonObject(candidate)) throw new TypeError("inventory audit child is invalid");
    const targetKey = auditChildTargetKey(candidate);
    if (auditBytesByTarget.has(targetKey)) throw new TypeError("inventory audit child is duplicated");
    auditBytesByTarget.set(targetKey, Buffer.byteLength(canonicalJson(candidate), "utf8"));
  }
  const dropped = new Map<JsonObject, number>();
  const dropOne = (): number => {
    for (let index = courses.length - 1; index >= 0; index -= 1) {
      const course = courses[index]!;
      const target = course.targets.pop();
      if (!target) continue;
      dropped.set(course.course, (dropped.get(course.course) || 0) + 1);
      const auditBytes = target.batch_eligibility === "eligible"
        ? auditBytesByTarget.get(courseTargetKey(course, target)) ?? 0
        : 0;
      return Buffer.byteLength(canonicalJson(target), "utf8") + auditBytes + 2;
    }
    return 0;
  };

  let measured = inventoryReportByteLength(report);
  while (measured > maximumBytes) {
    const required = measured - maximumBytes;
    let estimatedFreed = 0;
    do {
      const freed = dropOne();
      if (freed === 0) throw new RangeError("inventory result exceeds its durable limit without removable targets");
      estimatedFreed += freed;
    } while (estimatedFreed < required + 4_096);
    for (const [course, count] of dropped) {
      markDurableResultGap(course, count);
      dropped.delete(course);
    }
    retainAuditChildren(report, courses);
    report.coverage.status = "inventory_incomplete";
    report.coverage.complete = false;
    const auditChildren = report.audit_children;
    if (!Array.isArray(auditChildren)) throw new TypeError("inventory result has no audit child collection");
    report.coverage.audit_child_count = auditChildren.length;
    measured = inventoryReportByteLength(report);
  }
  return report;
}

/** @deprecated Use boundProgramInventoryResult for provider-neutral reports. */
export function boundCanvasProgramInventoryResult(
  value: JsonObject,
  maximumBytes = INVENTORY_RESULT_BYTE_LIMIT,
): JsonObject {
  return boundProgramInventoryResult(value, maximumBytes);
}

function residualCoverage(): JsonObject[] {
  return [
    { category: "accessibility_manual_review", reason: "Saved-source checks cannot establish captions, transcripts, keyboard behavior, focus order, contrast, equations, learner rendering, or external-tool accessibility." },
    { category: "announcements", reason: "Announcements are read as their own only_announcements list, so their completeness is tracked separately from discussion topics. Neither list reads replies. Whether a course returns announcements depends on its settings and the caller's role; that behavior is live-unverified." },
    { category: "files", reason: "Canvas file inventory lists metadata. A later exact file audit can read confirmed UTF-8 text or HTML with the user's Chrome file-access permission. A binary file returns an explicit blocked audit state with its block reason and observed metadata, never a pass. Document tags and learner rendering remain manual review." },
    { category: "front_page", reason: "The course front page is recorded as a flag on its own Pages target, never as a second target. A course with no front page and an unreadable front-page read are not distinguished, so an unobserved front page leaves every Page flag null." },
    { category: "item_banks", reason: "Each Item Bank entry records how its bank is associated with the selected course: a share row that names the course, or the course-scoped bank list that returned the bank. No Item Bank route lists the quizzes that draw from a bank, so a bank's full reach cannot be enumerated from Item Bank routes alone. That limit is permanent. A bank shared with an account, a share row without an exact course, or a share list Morrow could not read to its end leaves the courses that bank reaches unestablished and is recorded as a blocking gap. Item Bank share paging is live-unverified." },
    { category: "new_quiz_entry_types", reason: "Stimulus, BankEntry, and BankItem are retained as exact targets. Their source fields must still be present in the later exact audit." },
    { category: "pagination", reason: "The connector follows native Canvas Link headers inside one bounded call, and continues the same list in further bounded calls with an opaque next-page token that only the connector decodes. The token is accepted only for the same origin and the same request path, and it cannot widen the read. When a call bound is reached first, the list keeps every record Morrow read, records how many pages Canvas still holds whenever Canvas states a last page, and stays explicitly incomplete. Canvas rate limits and Link header shapes are live-unverified." },
    { category: "rubrics", reason: "Rubric criteria and rating text are inventoried and audited as saved source. Rubric assessments are learner data and are never requested, so no learner score or comment is observed. The current rubric update route cannot express nested criteria, so rubric remediation stays blocked." },
    { category: "syllabus", reason: "The course syllabus comes from the confirmed course read with include[]=syllabus_body. Its visibility depends on the course settings and the caller's role; a course that returns no syllabus body keeps its exact target and records an explicit not-observed audit state, never a pass. That visibility is live-unverified." },
  ];
}

async function collectCourseInventory(
  runtime: GatewayRuntime,
  selected: CanvasCourseInventorySelection,
  options: Pick<CanvasProgramInventoryInput, "max_pages_per_list" | "max_list_calls_per_course">,
  signal: AbortSignal,
): Promise<CourseInventory> {
  const lists: JsonObject[] = [];
  const targets: DiscoveredTarget[] = [];
  const targetIdentities = new Set<string>();
  const coverageGaps: CoverageGap[] = [];
  const counters = {
    list_calls: 0,
    completed_list_calls: 0,
    truncated_list_calls: 0,
    unread_page_responses: 0,
    unread_pages: 0 as "unknown" | number,
    unread_record_count: "unknown" as "unknown" | number,
  };
  let source: string | undefined;
  let targetLimitReached = false;

  const read = async (upstreamTool: string, argumentsValue: JsonObject, listResume?: JsonObject): Promise<CanvasRead> => {
    signal.throwIfAborted();
    const matches = runtime.searchCatalog({ query: upstreamTool, limit: 100 }).tools.filter((candidate) => {
      const descriptor = runtime.capabilityGet(candidate.publicName).descriptor;
      return candidate.upstreamName === upstreamTool && candidate.annotations?.readOnlyHint === true
        && (!source || candidate.upstreamId === source) && isJsonObject(descriptor)
        && descriptor.provider === "canvas" && isJsonObject(descriptor.route) && descriptor.route.backend === "canvas-connector";
    });
    if (matches.length !== 1) throw new CourseInventoryError(`The selected Canvas source does not expose one unambiguous ${upstreamTool} read.`);
    const candidate = matches[0]!;
    const connection = runtime.config.upstreams.find((item) => item.id === candidate.upstreamId);
    const privacy = connection?.outputPrivacy[upstreamTool] ?? connection?.outputPrivacyDefault;
    if (privacy?.fieldPolicy !== "scrub-sensitive" || privacy.freeText !== "allow" || privacy.aiClientAdmission !== "allow") {
      throw new CourseInventoryError(`The selected Canvas source privacy policy does not permit ${upstreamTool} inventory evidence.`);
    }
    source = candidate.upstreamId;
    return sourceRead(runtime, await runtime.callSourceOwned(candidate.publicName, {
      ...argumentsValue,
      _morrow: {
        source_binding_id: selected.source_binding_id,
        ...(listResume ? { list_resume: listResume } : {}),
      },
    }, { signal }), candidate.upstreamId, upstreamTool);
  };

  const refusal = (reason: string): CourseInventory => ({
    course_id: selected.course_id,
    expected_name: selected.expected_name,
    source_binding_id: selected.source_binding_id,
    status: "course_refused",
    lists,
    targets,
    coverage_gaps: coverageGaps,
    residual_coverage: residualCoverage(),
    counters,
    reason,
  });

  let confirmedCourse: CanvasRead;
  try {
    // include[]=syllabus_body makes the confirmed course read carry the syllabus,
    // so the syllabus needs no separate list call.
    confirmedCourse = await read("canvas_get_single_course_courses", { id: selected.course_id, include: ["syllabus_body"] });
  } catch (error) {
    addGap(coverageGaps, { code: "course_confirmation_unavailable", list: "course", blocking: true, reason: error instanceof Error ? error.message : "Canvas course confirmation failed." });
    return refusal("The selected course could not be confirmed from its exact current Canvas binding.");
  }
  if (confirmedCourse.truncated || !isJsonObject(confirmedCourse.data) || !sameCanvasId(confirmedCourse.data.id, selected.course_id)) {
    addGap(coverageGaps, { code: "wrong_course_refused", list: "course", blocking: true, reason: "Canvas did not return the exact selected course id." });
    return refusal("Canvas returned a different or incomplete course record; inventory refused to substitute it.");
  }
  if (confirmedCourse.data.name !== selected.expected_name) {
    addGap(coverageGaps, { code: "wrong_course_refused", list: "course", blocking: true, reason: "Canvas returned a course name different from the selected expected name." });
    return refusal("Canvas returned a different course name; inventory refused to substitute it.");
  }
  const courseRecord = confirmedCourse.data;
  const courseReadList: ListRead = {
    name: "course",
    tool: confirmedCourse.upstreamTool,
    records: [courseRecord],
    rawRecordCount: 1,
    complete: true,
    status: "observed",
    upstreamId: confirmedCourse.upstreamId,
    pageCount: confirmedCourse.pageCount,
  };

  /**
   * Reads one source list to the end of its pagination when the connector can
   * continue it. Canvas caps a single browser read, so a capped read hands back
   * an opaque next-page token that only the connector can decode, and this loop
   * spends further bounded calls on the same list. When a bound stops the loop
   * the list keeps every record it read, records how many pages Canvas still
   * holds, and stays explicitly incomplete.
   */
  const list = async (name: string, tool: string, argumentsValue: JsonObject): Promise<ListRead> => {
    const records: JsonObject[] = [];
    let rawRecordCount = 0;
    let pagesRead = 0;
    let listCalls = 0;
    let upstreamId: string | undefined;
    let complete = false;
    let unreadPages: number | "unknown" = "unknown";
    let resumeToken: string | undefined;
    let capped = false;
    const finish = (status: ListRead["status"]): ListRead => {
      // Only a list Canvas actually capped leaves pages unread. A list Morrow
      // could not read at all is a different gap and states no page count.
      if (capped && !complete) {
        counters.unread_page_responses += 1;
        counters.unread_pages = counters.unread_pages === "unknown" || unreadPages === "unknown"
          ? "unknown"
          : counters.unread_pages + unreadPages;
      }
      const result: ListRead = {
        name,
        tool,
        records,
        rawRecordCount,
        complete,
        status,
        ...(upstreamId ? { upstreamId } : {}),
        pageCount: pagesRead || null,
        listCalls,
        unreadPages,
        resumeAvailable: !complete && resumeToken !== undefined,
      };
      lists.push(listProjection(result, selected.source_binding_id));
      return result;
    };

    for (let call = 0; call < MAX_CALLS_PER_LIST; call += 1) {
      if (counters.list_calls >= options.max_list_calls_per_course) {
        addGap(coverageGaps, {
          code: "list_call_cap_reached",
          list: name,
          blocking: true,
          reason: call === 0
            ? "The configured bounded list-call limit was reached before this source list could be read."
            : "The configured bounded list-call limit was reached before this source list finished. Every record Morrow already read stays exact and auditable.",
        });
        return finish(call === 0 ? "unavailable" : "truncated");
      }
      counters.list_calls += 1;
      listCalls += 1;
      let readResult: CanvasRead;
      try {
        readResult = await read(
          tool,
          { ...argumentsValue, morrow_max_pages: options.max_pages_per_list },
          resumeToken === undefined ? {} : { next_page: resumeToken },
        );
      } catch (error) {
        addGap(coverageGaps, { code: "list_unavailable", list: name, blocking: true, reason: error instanceof Error ? error.message : "Canvas list read failed." });
        // The token this call carried did not work, so no later run can rely on it.
        resumeToken = undefined;
        return finish(call === 0 ? "unavailable" : "truncated");
      }
      upstreamId = readResult.upstreamId;
      if (!Array.isArray(readResult.data)) {
        addGap(coverageGaps, { code: "collection_shape_unavailable", list: name, blocking: true, reason: "Canvas did not return an array for this required collection read." });
        resumeToken = undefined;
        return finish(call === 0 ? "unavailable" : "truncated");
      }
      pagesRead += readResult.pageCount ?? 0;
      rawRecordCount += readResult.data.length;
      const retained = readResult.data.slice(0, Math.max(0, MAX_RECORDS_PER_LIST - records.length));
      const structured = retained.filter(isJsonObject);
      records.push(...structured);
      capped = readResult.truncated;
      unreadPages = readResult.truncated ? readResult.unreadPages ?? "unknown" : 0;
      resumeToken = readResult.nextPage;
      if (!readResult.paginationObserved) {
        addGap(coverageGaps, { code: "pagination_state_unavailable", list: name, blocking: true, reason: "Canvas did not return an explicit pagination completion state for this collection." });
        return finish("truncated");
      }
      if (structured.length !== retained.length) {
        addGap(coverageGaps, { code: "list_record_shape_incomplete", list: name, blocking: true, reason: "One or more source list records were not structured objects." });
        return finish("truncated");
      }
      if (rawRecordCount > MAX_RECORDS_PER_LIST) {
        addGap(coverageGaps, { code: "list_record_cap_reached", list: name, blocking: true, reason: "The collector retained only its bounded maximum records from this source list." });
        return finish("truncated");
      }
      if (!readResult.truncated) {
        complete = true;
        counters.completed_list_calls += 1;
        return finish("observed");
      }
      counters.truncated_list_calls += 1;
      if (resumeToken === undefined) {
        addGap(coverageGaps, {
          code: "list_truncated_no_resume_token",
          list: name,
          blocking: true,
          reason: "Canvas reported a capped next page and the connector returned no safe resume token for this list, so the rest of it is unread. Every record Morrow already read stays exact and auditable.",
        });
        return finish("truncated");
      }
    }
    addGap(coverageGaps, {
      code: "list_resume_bound_reached",
      list: name,
      blocking: true,
      reason: "Morrow reached its bounded resume limit for this one source list before Canvas ran out of pages. Every record Morrow already read stays exact and auditable, and the unread page count is recorded with this list.",
    });
    return finish("truncated");
  };

  const addTarget = (sourceList: ListRead, target: JsonObject, discovery: JsonObject): void => {
    const targetIdentity = canonicalJson(target);
    if (targetIdentities.has(targetIdentity)) return;
    if (targets.length >= MAX_TARGETS_PER_COURSE) {
      if (!targetLimitReached) {
        targetLimitReached = true;
        addGap(coverageGaps, { code: "target_cap_reached", list: sourceList.name, blocking: true, reason: "The collector reached its bounded per-course target limit." });
      }
      return;
    }
    targetIdentities.add(targetIdentity);
    targets.push({
      target,
      course_id: selected.course_id,
      source_binding_id: selected.source_binding_id,
      source_list: sourceList.name,
      // A record Morrow read is exact even when the rest of its list is unread,
      // so it stays auditable. The unread part of the list is a course coverage
      // gap; it is never a reason to drop evidence Morrow already holds.
      batch_eligibility: "eligible",
      inventory_state: sourceList.complete ? "discovered" : "discovered_from_incomplete_list",
      discovery: {
        upstream_read_tool: sourceList.tool,
        ...(sourceList.upstreamId ? { upstream_id: sourceList.upstreamId } : {}),
        ...discovery,
      },
    });
  };

  const recordMissing = (sourceList: ListRead, code: string, record: JsonObject, reason: string): void => {
    addGap(coverageGaps, { code, list: sourceList.name, blocking: true, reason, sampleRecordId: objectId(record) ?? objectText(record, "title", 160) });
  };

  // Keep catalog-source selection serial. A concurrent first read could otherwise
  // let two equally named catalog entries establish different upstream sources.
  const modules = await list("modules", "canvas_list_modules", { course_id: selected.course_id, include: ["items", "content_details"] });
  const pages = await list("pages", "canvas_list_pages_courses", { course_id: selected.course_id });
  const assignments = await list("assignments", "canvas_list_assignments_assignments", { course_id: selected.course_id });
  const discussions = await list("discussions", "canvas_list_discussion_topics_courses", { course_id: selected.course_id });
  // Canvas returns announcements only when a read asks for them, so they need
  // their own list with its own completeness state.
  const announcements = await list("announcements", "canvas_list_discussion_topics_courses", { course_id: selected.course_id, only_announcements: true });
  const classicQuizzes = await list("classic_quizzes", "canvas_list_quizzes_in_course", { course_id: selected.course_id });
  const newQuizzes = await list("new_quizzes", "canvas_list_new_quizzes", { course_id: selected.course_id });
  const files = await list("files", "canvas_list_files_courses", { course_id: selected.course_id });
  const rubrics = await list("rubrics", "canvas_list_rubrics_courses", { course_id: selected.course_id });
  const itemBanks = await list("item_banks", "canvas_item_bank_list_banks", { course_id: selected.course_id });

  // The front page is one of the listed Pages. Read it to mark that Page, never
  // to add a second target for the same body. `undefined` stays "not observed".
  let frontPageUrl: string | undefined;
  try {
    const frontPage = await read("canvas_show_front_page_courses", { course_id: selected.course_id });
    frontPageUrl = !frontPage.truncated && isJsonObject(frontPage.data) ? objectText(frontPage.data, "url", 1_000) : undefined;
  } catch {
    frontPageUrl = undefined;
  }
  if (frontPageUrl === undefined) {
    addGap(coverageGaps, {
      code: "course_front_page_not_observed",
      list: "front_page",
      blocking: false,
      reason: "Canvas returned no readable course front page. A course with no front page and an unreadable front-page read are not distinguished here, so no Page carries a confirmed front-page flag.",
    });
  }

  addTarget(courseReadList, { kind: "syllabus" }, {
    listed_id: selected.course_id,
    title: objectText(courseRecord, "name", 500) ?? null,
    syllabus_body_returned: typeof courseRecord.syllabus_body === "string",
  });
  if (typeof courseRecord.syllabus_body !== "string") {
    addGap(coverageGaps, {
      code: "course_syllabus_body_not_returned",
      list: "course",
      blocking: false,
      reason: "The confirmed course read asked for syllabus_body and Canvas did not return it. Its visibility depends on the course settings and the caller's role. The syllabus stays an exact target and its audit records the not-observed state.",
    });
  }

  for (const page of pages.records) {
    const url = objectText(page, "url", 1_000);
    if (!url) recordMissing(pages, "page_url_missing", page, "Canvas listed a Page without the URL required for an exact Page audit.");
    else addTarget(pages, { kind: "page", page_url: url }, {
      listed_id: objectId(page, "page_id") ?? null,
      title: objectText(page, "title", 500) ?? null,
      front_page: frontPageUrl === undefined ? null : url === frontPageUrl,
    });
  }
  if (frontPageUrl !== undefined && !pages.records.some((page) => objectText(page, "url", 1_000) === frontPageUrl)) {
    addGap(coverageGaps, {
      code: "front_page_absent_from_pages_list",
      list: "pages",
      blocking: true,
      reason: "Canvas returned a course front page whose URL is not in this Pages list, so the front page is not covered by an exact audit target.",
      sampleRecordId: frontPageUrl,
    });
  }
  for (const rubric of rubrics.records) {
    const id = objectId(rubric);
    if (!id) recordMissing(rubrics, "rubric_id_missing", rubric, "Canvas listed a rubric without an exact identifier.");
    else addTarget(rubrics, { kind: "rubric", rubric_id: id }, {
      listed_id: id,
      title: objectText(rubric, "title", 500) ?? null,
      learner_assessment_data: "never_requested",
    });
  }
  for (const assignment of assignments.records) {
    const id = objectId(assignment);
    if (!id) recordMissing(assignments, "assignment_id_missing", assignment, "Canvas listed an Assignment without an exact identifier.");
    else addTarget(assignments, { kind: "assignment", assignment_id: id }, { listed_id: id, title: objectText(assignment, "name", 500) ?? null });
  }
  for (const discussion of discussions.records) {
    const id = objectId(discussion);
    if (!id) recordMissing(discussions, "discussion_id_missing", discussion, "Canvas listed a discussion or announcement without an exact identifier.");
    else addTarget(discussions, { kind: "discussion", topic_id: id }, { listed_id: id, title: objectText(discussion, "title", 500) ?? null, is_announcement: discussion.is_announcement === true });
  }
  for (const announcement of announcements.records) {
    const id = objectId(announcement);
    if (!id) recordMissing(announcements, "announcement_id_missing", announcement, "Canvas listed an announcement without an exact identifier.");
    else addTarget(announcements, { kind: "discussion", topic_id: id }, { listed_id: id, title: objectText(announcement, "title", 500) ?? null, is_announcement: announcement.is_announcement === true });
  }
  for (const file of files.records) {
    const id = objectId(file);
    if (!id) recordMissing(files, "file_id_missing", file, "Canvas listed a course file without an exact identifier.");
    else addTarget(files, { kind: "file", file_id: id }, { listed_id: id, title: objectText(file, "display_name", 500) ?? objectText(file, "filename", 500) ?? null, coverage: "metadata_only" });
  }

  for (const module of modules.records) {
    const moduleId = objectId(module);
    if (!moduleId) {
      recordMissing(modules, "module_id_missing", module, "Canvas listed a module without an exact identifier.");
      continue;
    }
    const moduleItems = await list(`module_items:${moduleId}`, "canvas_list_module_items", { course_id: selected.course_id, module_id: moduleId, include: ["content_details"] });
    for (const item of moduleItems.records) {
      const type = objectText(item, "type", 100);
      if (!type || !["Page", "Assignment", "Discussion", "Quiz", "File"].includes(type)) {
        addGap(coverageGaps, {
          code: "module_item_without_supported_audit_route",
          list: moduleItems.name,
          blocking: false,
          reason: "This module item has no current exact Canvas course-audit route. It remains a manual or platform-specific review surface.",
          sampleRecordId: objectId(item) ?? type,
        });
      }
    }
  }

  for (const quiz of classicQuizzes.records) {
    const quizId = objectId(quiz);
    if (!quizId) {
      recordMissing(classicQuizzes, "classic_quiz_id_missing", quiz, "Canvas listed a Classic Quiz without an exact identifier.");
      continue;
    }
    addTarget(classicQuizzes, { kind: "classic_quiz", quiz_id: quizId }, { listed_id: quizId, title: objectText(quiz, "title", 500) ?? null });
    const questions = await list(`classic_quiz_questions:${quizId}`, "canvas_list_questions_in_quiz_or_submission", { course_id: selected.course_id, quiz_id: quizId });
    for (const question of questions.records) {
      const questionId = objectId(question);
      if (!questionId) recordMissing(questions, "classic_quiz_question_id_missing", question, "Canvas listed a Classic Quiz question without an exact identifier.");
      else addTarget(questions, { kind: "classic_quiz_question", quiz_id: quizId, question_id: questionId }, { listed_id: questionId, quiz_id: quizId, title: objectText(question, "question_name", 500) ?? null });
    }
  }

  for (const quiz of newQuizzes.records) {
    const quizId = objectId(quiz);
    if (!quizId) {
      recordMissing(newQuizzes, "new_quiz_id_missing", quiz, "Canvas listed a New Quiz without the assignment identifier required for its exact audit.");
      continue;
    }
    addTarget(newQuizzes, { kind: "new_quiz", quiz_id: quizId }, { listed_id: quizId, title: objectText(quiz, "title", 500) ?? null });
    const items = await list(`new_quiz_items:${quizId}`, "canvas_list_quiz_items", { course_id: selected.course_id, assignment_id: quizId });
    for (const item of items.records) {
      const itemId = objectId(item);
      const entryType = objectText(item, "entry_type", 100);
      if (!itemId) {
        recordMissing(items, "new_quiz_item_id_missing", item, "Canvas listed a New Quiz item without an exact identifier.");
      } else if (!entryType || !NEW_QUIZ_ENTRY_TYPES.has(entryType)) {
        addGap(coverageGaps, {
          code: "new_quiz_entry_type_incomplete",
          list: items.name,
          blocking: true,
          reason: "Canvas did not return one documented New Quiz entry type for this exact item.",
          sampleRecordId: itemId,
        });
      } else {
        addTarget(items, { kind: "new_quiz_item", quiz_id: quizId, item_id: itemId }, { listed_id: itemId, quiz_id: quizId, entry_type: entryType });
      }
    }
  }

  for (const bank of itemBanks.records) {
    const bankId = objectId(bank);
    if (!bankId) {
      recordMissing(itemBanks, "item_bank_id_missing", bank, "Canvas listed an Item Bank without an exact identifier.");
      continue;
    }
    // Every bank here came back from one list_banks read scoped to the selected
    // course, which is the weaker of the two course associations an Item Bank
    // route can show. A share row that names the selected course is the stronger
    // one, so read the shares before the entries. A share list Morrow could not
    // read to its end cannot show that no share names this course, so it
    // establishes nothing.
    const shareList = await list(`item_bank_shares:${bankId}`, "canvas_item_bank_list_shares", { bank_id: bankId, per_page: ITEM_BANK_SHARES_PER_PAGE });
    const shares = itemBankShareEvidence(shareList);
    const association = shares.courseIds.includes(selected.course_id) ? "observed_by_bank_share"
      : shares.complete ? "observed_by_course_scoped_bank_list"
      : "not_established";
    const associationEvidence = {
      course_association: association,
      course_association_evidence: {
        bank_list_course_id: selected.course_id,
        share_list_state: shares.complete ? "observed" : shareList.status === "unavailable" ? "unavailable" : "incomplete",
        shared_course_ids: shares.courseIds.slice(0, MAX_SHARED_COURSES_PER_BANK),
        shared_course_count: shares.courseIds.length,
        ...(shares.limit ? { share_list_limit: shares.limit } : {}),
      },
    };
    const targetsBeforeEntries = targets.length;
    const entries = await list(`item_bank_entries:${bankId}`, "canvas_item_bank_list_entries", { bank_id: bankId });
    for (const entry of entries.records) {
      const entryId = objectId(entry);
      const entryType = objectText(entry, "entry_type", 100);
      if (!entryId) {
        recordMissing(entries, "item_bank_entry_id_missing", entry, "Canvas listed an Item Bank entry without an exact identifier.");
      } else if (entryType && !NEW_QUIZ_ENTRY_TYPES.has(entryType)) {
        addGap(coverageGaps, {
          code: "item_bank_entry_type_incomplete",
          list: entries.name,
          blocking: true,
          reason: "Canvas returned an Item Bank entry type outside the documented New Quiz entry types.",
          sampleRecordId: entryId,
        });
      } else {
        addTarget(entries, { kind: "item_bank_entry", item_bank_id: bankId, entry_id: entryId }, {
          listed_id: entryId,
          item_bank_id: bankId,
          entry_type: entryType ?? null,
          ...associationEvidence,
        });
      }
    }
    if (!shares.complete && targets.length > targetsBeforeEntries) {
      addGap(coverageGaps, {
        code: "item_bank_shares_unread",
        list: shareList.name,
        blocking: true,
        reason: `Morrow did not read the whole share list of this Item Bank, so the courses it reaches are not established. Each entry of this bank records the association Morrow could observe. ${shares.limit}`,
        sampleRecordId: bankId,
      });
    }
  }

  const blocking = coverageGaps.some((gap) => gap.blocking);
  return {
    course_id: selected.course_id,
    expected_name: selected.expected_name,
    source_binding_id: selected.source_binding_id,
    observed_course: {
      id: selected.course_id,
      name: selected.expected_name,
      upstream_read_tool: confirmedCourse.upstreamTool,
      upstream_id: confirmedCourse.upstreamId,
    },
    status: blocking ? "inventory_incomplete" : "inventory_complete",
    lists,
    targets,
    coverage_gaps: coverageGaps,
    residual_coverage: residualCoverage(),
    counters,
  };
}

export async function collectCanvasProgramInventory(
  runtime: GatewayRuntime,
  value: unknown,
  options: { readonly signal?: AbortSignal } = {},
): Promise<JsonObject> {
  const input = requireInput(value);
  const signal = options.signal ?? new AbortController().signal;
  const courses: CourseInventory[] = [];
  for (const selected of input.courses) {
    signal.throwIfAborted();
    courses.push(await collectCourseInventory(runtime, selected, input, signal));
  }
  const complete = courses.length > 0 && courses.every((course) => course.status === "inventory_complete");
  const auditChildren = courses.flatMap((course) => (
    course.targets.filter((target) => target.batch_eligibility === "eligible").map(targetChild)
  ));
  const listCalls = courses.reduce((total, course) => total + course.counters.list_calls, 0);
  const completedListCalls = courses.reduce((total, course) => total + course.counters.completed_list_calls, 0);
  const truncatedListCalls = courses.reduce((total, course) => total + course.counters.truncated_list_calls, 0);
  const unreadPageResponses = courses.reduce((total, course) => total + course.counters.unread_page_responses, 0);
  const unreadPages = courses.reduce<"unknown" | number>((total, course) => (
    total === "unknown" || course.counters.unread_pages === undefined || course.counters.unread_pages === "unknown"
      ? "unknown"
      : total + course.counters.unread_pages
  ), 0);
  const resumeAvailable = courses.some((course) => course.lists.some((entry) => entry.resume_available === true));
  return boundCanvasProgramInventoryResult({
    schema: "morrow.course-inventory.v1",
    provider: "canvas",
    scope: "selected_program",
    observed_at: new Date().toISOString(),
    courses,
    audit_children: auditChildren,
    coverage: {
      status: complete ? "supported_inventory_complete" : "inventory_incomplete",
      source: "explicit",
      course_ids: input.courses.map((course) => course.course_id),
      complete,
      pagination_complete: complete && unreadPageResponses === 0,
      list_calls: listCalls,
      completed_list_calls: completedListCalls,
      truncated_list_calls: truncatedListCalls,
      unread_page_responses: unreadPageResponses,
      unread_pages: unreadPageResponses === 0 ? 0 : unreadPages,
      resume_available: resumeAvailable,
      unread_record_count: "unknown",
      audit_child_count: auditChildren.length,
      residual_coverage: residualCoverage(),
    },
  });
}

interface MoodleRead {
  readonly data: JsonObject;
  readonly truncated: boolean;
  readonly upstreamId: string;
  readonly upstreamTool: string;
  readonly snapshotDigest: string;
}

function moodleSourceRead(
  runtime: GatewayRuntime,
  response: JsonObject,
  upstreamId: string,
  upstreamTool: string,
): MoodleRead {
  const resolved = resolveResultArtifact(response, (handle, offset) => runtime.resultPage(handle, offset) as unknown as ResultArtifactPage);
  const content = resolved.structuredContent;
  const result = isJsonObject(content) ? content.result : undefined;
  if (resolved.isError === true || !isJsonObject(content) || content.schema !== "morrow.canvas-connector.result.v1"
    || content.ok !== true || content.provider !== "moodle" || content.commandKind !== "invoke_read"
    || !isJsonObject(result) || result.schema !== "morrow.moodle-browser-result.v1" || result.ok !== true
    || result.sent !== true || !isJsonObject(result.data) || typeof result.snapshot_digest !== "string"
    || !/^[0-9a-f]{64}$/u.test(result.snapshot_digest)) {
    throw new CourseInventoryError("Moodle did not return a readable inventory result.");
  }
  return {
    data: result.data,
    truncated: result.truncated === true,
    upstreamId,
    upstreamTool,
    snapshotDigest: result.snapshot_digest,
  };
}

function sameMoodleId(value: unknown, expected: number): boolean {
  return value === expected || (typeof value === "string" && value === String(expected));
}

function moodleIdValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 9_007_199_254_740_991
    ? value
    : typeof value === "string" && /^[1-9][0-9]{0,15}$/u.test(value) && Number.isSafeInteger(Number(value))
      ? Number(value)
      : undefined;
}

function moodleText(value: JsonObject, field: string, maximum = 1_000): string | undefined {
  const candidate = value[field];
  return typeof candidate === "string" && candidate.length > 0 && candidate.length <= maximum ? candidate : undefined;
}

function moodleAuditText(value: JsonObject, field: string): string | undefined {
  const candidate = value[field];
  return typeof candidate === "string" && candidate.length <= 120_000 ? candidate : undefined;
}

/**
 * Project the file listing that the native Resource and Folder settings forms
 * return. A Folder listing carries no main-file flag, because a Folder has no
 * main file. Any entry that is not exact makes the whole listing unusable, so
 * the caller records an explicit gap instead of a partial file list.
 */
function moodleFileMetadata(value: unknown): { readonly files: JsonObject[]; readonly listedCount: number } | undefined {
  if (!Array.isArray(value)) return undefined;
  const files: JsonObject[] = [];
  for (const entry of value.slice(0, MAX_FILES_PER_ACTIVITY)) {
    if (!isJsonObject(entry)) return undefined;
    const filename = moodleText(entry, "filename", 500);
    const relativePath = moodleText(entry, "relative_path", 4_096);
    const mediaTypeLabel = moodleText(entry, "media_type_label", 1_333);
    const sizeBytes = entry.size_bytes;
    const mainFile = entry.main_file;
    if (filename === undefined || relativePath === undefined || mediaTypeLabel === undefined
      || typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0
      || (mainFile !== undefined && typeof mainFile !== "boolean")) return undefined;
    files.push({ filename, relative_path: relativePath, size_bytes: sizeBytes, media_type_label: mediaTypeLabel, main_file: mainFile === true });
  }
  return { files, listedCount: value.length };
}

function moodleTargetChild(target: DiscoveredTarget): CanvasAuditChild {
  const argumentsValue: JsonObject = {
    provider: "moodle",
    source_binding_id: target.source_binding_id,
    course_id: Number(target.course_id),
    target: target.target,
  };
  return {
    childId: `audit:${sha256Text(canonicalJson(argumentsValue)).slice(0, 32)}`,
    courseId: target.course_id,
    tool: "morrow_audit_course",
    sourceBindingId: target.source_binding_id,
    arguments: argumentsValue,
  };
}

function moodleResidualCoverage(): JsonObject[] {
  return [
    { category: "accessibility_manual_review", reason: "Saved-source checks cannot establish captions, transcripts, keyboard behavior, focus order, contrast, equations, learner rendering, or external-tool accessibility." },
    { category: "files", reason: "Moodle Resource and Folder activities are read through their native settings forms, which return each file's name, relative path, byte size, media-type label, and main-file flag. File bytes, document structure, tags, and media tracks stay unread. File metadata is not a file accessibility pass." },
    { category: "activity_scope", reason: "Each converted Moodle target is limited to its exact returned field. Activity intros and descriptions do not establish the state of posts, entries, nested pages, responses, submissions, external destinations, or learner views." },
    { category: "packages", reason: "Moodle IMS content package and SCORM activities are read as their exact settings-form fields. Package contents, package navigation, learner attempts, and the learner launch stay unread." },
    { category: "files", reason: "The native activity-form reads return selected text fields, not attached file bytes, document structure, tags, or media tracks." },
    { category: "files", reason: "A Moodle Drag and drop onto image or Drag and drop markers question returns its background image as a file name, byte size, and media-type label only. No image bytes are read and no drag-item image is read, so the result carries no accessibility claim about either image." },
    { category: "activity_scope", reason: "A Moodle Calculated, Calculated multichoice, or Calculated simple question is read on its first native page only. The result carries the question text with its wildcard placeholders, the answer formulas, tolerance, answer display, unit handling, and the wildcard names. Dataset definition ranges and dataset item values stay unread, so the result does not establish which numbers a learner sees." },
    { category: "native_limits", reason: "Moodle native state and Quiz-slot reads have bounded result limits. A partial or unreadable read remains an explicit coverage gap." },
    { category: "activity_scope", reason: "This inventory converts course activities, Book chapters, and Quiz questions. Workshop intros, H5P activity intros, Glossary entries, Wiki pages, Lesson pages, Feedback questions, and Database fields are audit targets that morrow_audit_course reads one at a time, and this ledger does not enumerate them." },
    { category: "activity_scope", reason: "A Moodle External tool activity has no audit target. Its native settings read reports only whether a description is set and never returns the description text, and the tool itself runs on another site under another operator." },
    { category: "activity_scope", reason: "Moodle Forum discussions and posts are learner-authored. They are read only through the separate privacy-projected forum-post route, so no audit target and no entry in this ledger covers them." },
  ];
}

async function collectMoodleCourseInventory(
  runtime: GatewayRuntime,
  selected: MoodleCourseInventorySelection,
  options: Pick<MoodleProgramInventoryInput, "max_list_calls_per_course">,
  signal: AbortSignal,
): Promise<CourseInventory> {
  const lists: JsonObject[] = [];
  const targets: DiscoveredTarget[] = [];
  const targetIdentities = new Set<string>();
  const coverageGaps: CoverageGap[] = [];
  const counters = {
    list_calls: 0,
    completed_list_calls: 0,
    truncated_list_calls: 0,
    unread_page_responses: 0,
    unread_record_count: "unknown" as "unknown" | number,
  };
  let source: string | undefined;
  let targetLimitReached = false;

  const read = async (upstreamTool: string, argumentsValue: JsonObject): Promise<MoodleRead> => {
    signal.throwIfAborted();
    const matches = runtime.searchCatalog({ query: upstreamTool, limit: 100 }).tools.filter((candidate) => {
      const descriptor = runtime.capabilityGet(candidate.publicName).descriptor;
      return candidate.upstreamName === upstreamTool && candidate.annotations?.readOnlyHint === true
        && (!source || candidate.upstreamId === source) && isJsonObject(descriptor)
        && descriptor.provider === "moodle" && isJsonObject(descriptor.route) && descriptor.route.backend === "canvas-connector";
    });
    if (matches.length !== 1) throw new CourseInventoryError(`The selected Moodle source does not expose one unambiguous ${upstreamTool} read.`);
    const candidate = matches[0]!;
    const connection = runtime.config.upstreams.find((item) => item.id === candidate.upstreamId);
    const privacy = connection?.outputPrivacy[upstreamTool] ?? connection?.outputPrivacyDefault;
    if (privacy?.fieldPolicy !== "scrub-sensitive" || privacy.freeText !== "allow" || privacy.aiClientAdmission !== "allow") {
      throw new CourseInventoryError(`The selected Moodle source privacy policy does not permit ${upstreamTool} inventory evidence.`);
    }
    source = candidate.upstreamId;
    return moodleSourceRead(runtime, await runtime.callSourceOwned(candidate.publicName, {
      ...argumentsValue,
      _morrow: { source_binding_id: selected.source_binding_id },
    }, { signal }), candidate.upstreamId, upstreamTool);
  };

  const refusal = (reason: string): CourseInventory => ({
    course_id: String(selected.course_id),
    expected_name: selected.expected_name,
    source_binding_id: selected.source_binding_id,
    status: "course_refused",
    lists,
    targets,
    coverage_gaps: coverageGaps,
    residual_coverage: moodleResidualCoverage(),
    counters,
    reason,
  });

  let confirmedCourse: MoodleRead;
  try {
    confirmedCourse = await read("moodle_get_course", { course_id: selected.course_id });
  } catch (error) {
    addGap(coverageGaps, { code: "course_confirmation_unavailable", list: "course", blocking: true, reason: error instanceof Error ? error.message : "Moodle course confirmation failed." });
    return refusal("The selected course could not be confirmed from its exact current Moodle binding.");
  }
  const confirmedName = moodleText(confirmedCourse.data, "fullname", 500) ?? moodleText(confirmedCourse.data, "shortname", 500);
  if (confirmedCourse.truncated || !sameMoodleId(confirmedCourse.data.course_id, selected.course_id)) {
    addGap(coverageGaps, { code: "wrong_course_refused", list: "course", blocking: true, reason: "Moodle did not return the exact selected course id." });
    return refusal("Moodle returned a different or incomplete course record; inventory refused to substitute it.");
  }
  if (confirmedName !== selected.expected_name) {
    addGap(coverageGaps, { code: "wrong_course_refused", list: "course", blocking: true, reason: "Moodle returned a course name different from the selected expected name." });
    return refusal("Moodle returned a different course name; inventory refused to substitute it.");
  }

  const boundedRead = async (name: string, tool: string, argumentsValue: JsonObject): Promise<{ readonly read: MoodleRead | null; readonly list: ListRead }> => {
    if (counters.list_calls >= options.max_list_calls_per_course) {
      addGap(coverageGaps, { code: "list_call_cap_reached", list: name, blocking: true, reason: "The configured bounded native-read limit was reached before this source surface could be read." });
      const list: ListRead = { name, tool, records: [], rawRecordCount: 0, complete: false, status: "unavailable" };
      lists.push(listProjection(list, selected.source_binding_id));
      return { read: null, list };
    }
    counters.list_calls += 1;
    try {
      const result = await read(tool, argumentsValue);
      const collection = Array.isArray(result.data.activities)
        ? result.data.activities
        : Array.isArray(result.data.questions)
          ? result.data.questions
          : Array.isArray(result.data.chapters)
            ? result.data.chapters
            : undefined;
      const records = collection?.filter(isJsonObject) ?? [];
      const rawRecordCount = collection?.length ?? 1;
      const complete = !result.truncated && result.data.truncated !== true;
      if (!complete) {
        counters.truncated_list_calls += 1;
        counters.unread_page_responses += 1;
        addGap(coverageGaps, { code: "native_read_partial", list: name, blocking: true, reason: "Moodle reported a bounded or partial native read for this source surface." });
      } else {
        counters.completed_list_calls += 1;
      }
      const list: ListRead = {
        name,
        tool,
        records,
        rawRecordCount,
        complete,
        status: complete ? "observed" : "truncated",
        upstreamId: result.upstreamId,
        pageCount: null,
      };
      lists.push(listProjection(list, selected.source_binding_id));
      return { read: result, list };
    } catch (error) {
      addGap(coverageGaps, { code: "native_read_unavailable", list: name, blocking: true, reason: error instanceof Error ? error.message : "Moodle native read failed." });
      const list: ListRead = { name, tool, records: [], rawRecordCount: 0, complete: false, status: "unavailable" };
      lists.push(listProjection(list, selected.source_binding_id));
      return { read: null, list };
    }
  };

  const contents = await boundedRead("contents", "moodle_get_contents", { course_id: selected.course_id });
  if (!contents.read || !isJsonObject(contents.read.data.course) || !sameMoodleId(contents.read.data.course.id ?? contents.read.data.course.course_id, selected.course_id)
    || !Array.isArray(contents.read.data.activities) || !contents.read.data.activities.every(isJsonObject)) {
    if (contents.read) addGap(coverageGaps, { code: "contents_shape_unavailable", list: "contents", blocking: true, reason: "Moodle did not return an exact structured activity collection for the selected course." });
    return {
      course_id: String(selected.course_id), expected_name: selected.expected_name, source_binding_id: selected.source_binding_id,
      observed_course: { id: String(selected.course_id), name: selected.expected_name, upstream_read_tool: confirmedCourse.upstreamTool, upstream_id: confirmedCourse.upstreamId },
      status: "inventory_incomplete", lists, targets, coverage_gaps: coverageGaps, residual_coverage: moodleResidualCoverage(), counters,
    };
  }
  const contentsList = contents.read.data.activities.length >= MAX_RECORDS_PER_LIST
    ? { ...contents.list, complete: false, status: "truncated" as const }
    : contents.list;
  if (contents.read.data.activities.length >= MAX_RECORDS_PER_LIST) {
    addGap(coverageGaps, { code: "contents_record_cap_reached", list: "contents", blocking: true, reason: "Moodle returned the collector's maximum activity count, so additional activities may be unread." });
  }

  // `auditRouted: false` keeps a discovered target out of the audit batch when
  // morrow_audit_course has no route for it. The Resource and Folder listings
  // are file metadata, and no current Moodle audit route reads file bytes.
  const addTarget = (sourceList: ListRead, target: JsonObject, discovery: JsonObject, options: { readonly auditRouted?: boolean } = {}): void => {
    const targetIdentity = canonicalJson(target);
    if (targetIdentities.has(targetIdentity)) return;
    if (targets.length >= MAX_TARGETS_PER_COURSE) {
      if (!targetLimitReached) {
        targetLimitReached = true;
        addGap(coverageGaps, { code: "target_cap_reached", list: sourceList.name, blocking: true, reason: "The collector reached its bounded per-course target limit." });
      }
      return;
    }
    targetIdentities.add(targetIdentity);
    targets.push({
      target,
      course_id: String(selected.course_id),
      source_binding_id: selected.source_binding_id,
      source_list: sourceList.name,
      batch_eligibility: sourceList.complete && options.auditRouted !== false ? "eligible" : "blocked",
      inventory_state: sourceList.complete ? "discovered" : "discovered_from_incomplete_list",
      discovery: { upstream_read_tool: sourceList.tool, ...(sourceList.upstreamId ? { upstream_id: sourceList.upstreamId } : {}), ...discovery },
    });
  };

  const activities = contents.read.data.activities as JsonObject[];
  for (const activity of activities) {
    signal.throwIfAborted();
    const moduleId = moodleIdValue(activity.id ?? activity.module_id);
    const module = moodleText(activity, "module", 100)?.toLocaleLowerCase("en-US");
    const title = moodleText(activity, "name", 500) ?? null;
    if (!moduleId || !module) {
      addGap(coverageGaps, { code: "activity_identifier_unavailable", list: "contents", blocking: true, reason: "Moodle listed an activity without the exact module type and identifier needed for a current audit route.", sampleRecordId: typeof activity.id === "string" ? activity.id : undefined });
      continue;
    }
    if (module === "resource" || module === "folder") {
      const fileTool = module === "resource" ? "moodle_get_resource_files" : "moodle_get_folder_files";
      const fileKind = module === "resource" ? "resource_files" : "folder_files";
      const listing = await boundedRead(`${fileKind}:${moduleId}`, fileTool, { course_id: selected.course_id, module_id: moduleId });
      if (!listing.read || !listing.list.complete || !sameMoodleId(listing.read.data.course_id, selected.course_id) || !sameMoodleId(listing.read.data.module_id, moduleId)) {
        if (listing.read && listing.list.complete) addGap(coverageGaps, { code: "activity_read_mismatch", list: listing.list.name, blocking: true, reason: "Moodle did not return the exact selected course activity." });
        continue;
      }
      const listed = moodleFileMetadata(listing.read.data.files);
      if (!listed) {
        addGap(coverageGaps, { code: "file_listing_unreadable", list: listing.list.name, blocking: true, reason: "Moodle did not return an exact structured file listing for this selected file-bearing activity.", sampleRecordId: String(moduleId) });
        continue;
      }
      if (listed.listedCount > listed.files.length) {
        addGap(coverageGaps, { code: "file_listing_capped", list: listing.list.name, blocking: true, reason: "Moodle listed more files than this bounded inventory retains for one activity, so the remaining files are unread.", sampleRecordId: String(moduleId) });
      }
      addTarget(contentsList, { kind: fileKind, module_id: moduleId }, {
        listed_id: String(moduleId), title, confirmed_read_tool: fileTool, snapshot_digest: listing.read.snapshotDigest,
        listed_file_count: listed.listedCount, files: listed.files,
        audit_route: "not_established_for_moodle_file_metadata",
      }, { auditRouted: false });
      addGap(coverageGaps, {
        code: "file_bytes_not_readable",
        list: listing.list.name,
        blocking: true,
        reason: "Moodle returned this activity's file names, relative paths, byte sizes, and media-type labels. File bytes, document structure, tags, and media tracks stay unread, and file metadata is not a file accessibility pass.",
        sampleRecordId: String(moduleId),
      });
      continue;
    }
    const supported = module === "page" ? { tool: "moodle_get_page", kind: "page", field: "content" }
      : module === "label" ? { tool: "moodle_get_label", kind: "label", field: "content" }
        : module === "url" ? { tool: "moodle_get_url", kind: "url", field: "description" }
          : module === "forum" ? { tool: "moodle_get_forum", kind: "forum", field: "instructions" }
            : module === "choice" ? { tool: "moodle_get_choice", kind: "choice", field: "instructions" }
              : module === "book" ? { tool: "moodle_get_book", kind: "book_intro", field: "instructions" }
                : module === "lesson" ? { tool: "moodle_get_lesson", kind: "lesson_intro", field: "instructions" }
                  : module === "glossary" ? { tool: "moodle_get_glossary", kind: "glossary", field: "instructions" }
                    : module === "wiki" ? { tool: "moodle_get_wiki", kind: "wiki", field: "instructions" }
                      : module === "feedback" ? { tool: "moodle_get_feedback", kind: "feedback", field: "instructions" }
                        : module === "data" ? { tool: "moodle_get_database", kind: "database", field: "instructions" }
                          : module === "assign" ? { tool: "moodle_get_assignment", kind: "assignment", field: "instructions" }
                            : module === "quiz" ? { tool: "moodle_get_quiz", kind: "quiz", field: "instructions" }
                              : module === "imscp" ? { tool: "moodle_get_imscp", kind: "imscp", field: "instructions" }
                                : module === "scorm" ? { tool: "moodle_get_scorm", kind: "scorm", field: "instructions" }
                                  : null;
    if (!supported) {
      addGap(coverageGaps, { code: "activity_type_unsupported", list: "contents", blocking: true, reason: "Moodle listed an activity type that this selected-program inventory does not convert to an audit target. Some of these activity types have a single-target audit route; see this course's residual coverage.", sampleRecordId: String(moduleId) });
      continue;
    }
    const exact = await boundedRead(`${supported.kind}:${moduleId}`, supported.tool, { course_id: selected.course_id, module_id: moduleId });
    if (!exact.read || !exact.list.complete || !sameMoodleId(exact.read.data.course_id, selected.course_id) || !sameMoodleId(exact.read.data.module_id, moduleId)) {
      if (exact.read && exact.list.complete) addGap(coverageGaps, { code: "activity_read_mismatch", list: exact.list.name, blocking: true, reason: "Moodle did not return the exact selected course activity." });
      continue;
    }
    if (moodleAuditText(exact.read.data, supported.field) === undefined) {
      addGap(coverageGaps, { code: "activity_text_unreadable", list: exact.list.name, blocking: true, reason: "Moodle did not return the exact bounded text field required for this selected activity audit.", sampleRecordId: String(moduleId) });
      continue;
    }
    const target = { kind: supported.kind, module_id: moduleId } as JsonObject;
    addTarget(contentsList, target, { listed_id: String(moduleId), title, confirmed_read_tool: supported.tool, snapshot_digest: exact.read.snapshotDigest });
    if (["url", "forum", "choice", "lesson_intro", "glossary", "wiki", "feedback", "database"].includes(supported.kind)) {
      addGap(coverageGaps, {
        code: "activity_nested_content_not_readable",
        list: "contents",
        blocking: true,
        reason: "The retained exact activity text does not read its posts, entries, nested pages, responses, submissions, external destination, or learner view.",
        sampleRecordId: String(moduleId),
      });
    }
    if (supported.kind === "imscp" || supported.kind === "scorm") {
      addGap(coverageGaps, {
        code: "package_contents_not_readable",
        list: "contents",
        blocking: true,
        reason: "The retained exact package settings text does not read the package contents, its navigation, learner attempts, or the learner launch.",
        sampleRecordId: String(moduleId),
      });
    }
    if (supported.kind === "book_intro") {
      const chapters = await boundedRead(`book_chapters:${moduleId}`, "moodle_list_book_chapters", { course_id: selected.course_id, module_id: moduleId });
      const chapterValues = chapters.read?.data.chapters;
      if (!chapters.read || !Array.isArray(chapterValues) || !chapterValues.every(isJsonObject)) {
        if (chapters.read) addGap(coverageGaps, { code: "book_chapters_shape_unavailable", list: chapters.list.name, blocking: true, reason: "Moodle did not return an exact structured Book chapter collection." });
        continue;
      }
      const chapterList = chapters.read.data.truncated === true
        ? { ...chapters.list, complete: false, status: "truncated" as const }
        : chapters.list;
      if (chapters.read.data.truncated === true || !chapters.list.complete) {
        addGap(coverageGaps, { code: "book_chapters_partial", list: chapters.list.name, blocking: true, reason: "Moodle returned an incomplete bounded Book chapter collection." });
      }
      for (const chapter of chapterValues) {
        const chapterId = moodleIdValue(chapter.chapter_id);
        if (!chapterId) {
          addGap(coverageGaps, { code: "book_chapter_identifier_unavailable", list: chapters.list.name, blocking: true, reason: "Moodle listed a Book chapter without the exact identifier needed for audit." });
          continue;
        }
        const exactChapter = await boundedRead(`book_chapter:${moduleId}:${chapterId}`, "moodle_get_book_chapter", { course_id: selected.course_id, module_id: moduleId, chapter_id: chapterId });
        if (!exactChapter.read || !exactChapter.list.complete
          || !sameMoodleId(exactChapter.read.data.course_id, selected.course_id)
          || !sameMoodleId(exactChapter.read.data.module_id, moduleId)
          || !sameMoodleId(exactChapter.read.data.chapter_id, chapterId)) {
          if (exactChapter.read && exactChapter.list.complete) addGap(coverageGaps, { code: "book_chapter_read_mismatch", list: exactChapter.list.name, blocking: true, reason: "Moodle did not return the exact selected Book chapter." });
          continue;
        }
        if (moodleAuditText(exactChapter.read.data, "content") === undefined) {
          addGap(coverageGaps, { code: "book_chapter_text_unreadable", list: exactChapter.list.name, blocking: true, reason: "Moodle did not return the exact bounded Book chapter text required for audit.", sampleRecordId: String(chapterId) });
          continue;
        }
        addTarget(chapterList, { kind: "book_chapter", module_id: moduleId, chapter_id: chapterId }, {
          listed_id: String(chapterId), book_id: String(moduleId), title: moodleText(chapter, "title", 500) ?? null,
          confirmed_read_tool: "moodle_get_book_chapter", snapshot_digest: exactChapter.read.snapshotDigest,
        });
        if (exactChapter.read.data.content_file_state !== "empty") {
          addGap(coverageGaps, { code: "book_chapter_files_not_readable", list: exactChapter.list.name, blocking: true, reason: "Moodle reported a Book chapter file area that this selected-program inventory does not read.", sampleRecordId: String(chapterId) });
        }
      }
      continue;
    }
    if (supported.kind !== "quiz") continue;

    const questions = await boundedRead(`quiz_questions:${moduleId}`, "moodle_list_quiz_questions", { course_id: selected.course_id, module_id: moduleId });
    const questionValues = questions.read?.data.questions;
    if (!questions.read || !Array.isArray(questionValues) || !questionValues.every(isJsonObject)) {
      if (questions.read) addGap(coverageGaps, { code: "quiz_questions_shape_unavailable", list: questions.list.name, blocking: true, reason: "Moodle did not return a structured Quiz-slot collection." });
      continue;
    }
    const questionsList = questions.read.data.truncated === true
      ? { ...questions.list, complete: false, status: "truncated" as const }
      : questions.list;
    if (questions.read.data.truncated === true || !questions.list.complete) {
      addGap(coverageGaps, { code: "quiz_questions_partial", list: questions.list.name, blocking: true, reason: "Moodle returned an incomplete bounded Quiz-slot collection." });
    }
    for (const question of questionValues) {
      const slotId = moodleIdValue(question.slot_id);
      const questionType = moodleText(question, "qtype", 100)?.toLocaleLowerCase("en-US");
      if (!slotId) {
        addGap(coverageGaps, { code: "quiz_question_identifier_unavailable", list: questions.list.name, blocking: true, reason: "Moodle listed a Quiz slot without the exact slot identifier needed for audit." });
        continue;
      }
      if (question.inspectable !== true) {
        addGap(coverageGaps, { code: "quiz_question_unreadable", list: questions.list.name, blocking: true, reason: "Moodle marked this Quiz slot random, unsupported, or otherwise unreadable by the current native route.", sampleRecordId: String(slotId) });
        continue;
      }
      if (!questionType || !moodleAuditableQuestionTypes.has(questionType)) {
        addGap(coverageGaps, { code: "quiz_question_type_unsupported", list: questions.list.name, blocking: true, reason: "The current course-audit contract has no exact native read for this Moodle Quiz question type.", sampleRecordId: String(slotId) });
        continue;
      }
      const exactQuestion = await boundedRead(`quiz_question:${moduleId}:${slotId}`, "moodle_get_quiz_question", { course_id: selected.course_id, module_id: moduleId, slot_id: slotId });
      if (!exactQuestion.read || !exactQuestion.list.complete
        || !sameMoodleId(exactQuestion.read.data.course_id, selected.course_id)
        || !sameMoodleId(exactQuestion.read.data.module_id, moduleId)
        || !sameMoodleId(exactQuestion.read.data.slot_id, slotId)
        || moodleText(exactQuestion.read.data, "qtype", 100)?.toLocaleLowerCase("en-US") !== questionType) {
        if (exactQuestion.read && exactQuestion.list.complete) addGap(coverageGaps, { code: "quiz_question_read_mismatch", list: exactQuestion.list.name, blocking: true, reason: "Moodle did not return the exact supported Quiz question." });
        continue;
      }
      if (moodleAuditText(exactQuestion.read.data, "question_text") === undefined) {
        addGap(coverageGaps, { code: "quiz_question_text_unreadable", list: exactQuestion.list.name, blocking: true, reason: "Moodle did not return the exact bounded Quiz question text required for audit.", sampleRecordId: String(slotId) });
        continue;
      }
      addTarget(questionsList, { kind: "quiz_question", module_id: moduleId, slot_id: slotId }, {
        listed_id: String(slotId), quiz_id: String(moduleId), question_type: questionType, title: moodleText(question, "name", 500) ?? null,
        confirmed_read_tool: "moodle_get_quiz_question", snapshot_digest: exactQuestion.read.snapshotDigest,
      });
    }
  }

  const blocking = coverageGaps.some((gap) => gap.blocking);
  const allTargetsEligible = targets.every((target) => target.batch_eligibility === "eligible");
  return {
    course_id: String(selected.course_id),
    expected_name: selected.expected_name,
    source_binding_id: selected.source_binding_id,
    observed_course: { id: String(selected.course_id), name: selected.expected_name, upstream_read_tool: confirmedCourse.upstreamTool, upstream_id: confirmedCourse.upstreamId },
    status: blocking || !allTargetsEligible ? "inventory_incomplete" : "inventory_complete",
    lists,
    targets,
    coverage_gaps: coverageGaps,
    residual_coverage: moodleResidualCoverage(),
    counters,
  };
}

export async function collectMoodleProgramInventory(
  runtime: GatewayRuntime,
  value: unknown,
  options: { readonly signal?: AbortSignal } = {},
): Promise<JsonObject> {
  const input = moodleProgramInventoryInputSchema.parse(value);
  const signal = options.signal ?? new AbortController().signal;
  const courses: CourseInventory[] = [];
  for (const selected of input.courses) {
    signal.throwIfAborted();
    courses.push(await collectMoodleCourseInventory(runtime, selected, input, signal));
  }
  const complete = courses.length > 0 && courses.every((course) => course.status === "inventory_complete");
  const auditChildren = courses.flatMap((course) => (
    course.targets.filter((target) => target.batch_eligibility === "eligible").map(moodleTargetChild)
  ));
  const listCalls = courses.reduce((total, course) => total + course.counters.list_calls, 0);
  const completedListCalls = courses.reduce((total, course) => total + course.counters.completed_list_calls, 0);
  const truncatedListCalls = courses.reduce((total, course) => total + course.counters.truncated_list_calls, 0);
  const unreadPageResponses = courses.reduce((total, course) => total + course.counters.unread_page_responses, 0);
  return boundProgramInventoryResult({
    schema: "morrow.course-inventory.v1",
    provider: "moodle",
    scope: "selected_program",
    observed_at: new Date().toISOString(),
    courses,
    audit_children: auditChildren,
    coverage: {
      status: complete ? "supported_inventory_complete" : "inventory_incomplete",
      source: "explicit",
      course_ids: input.courses.map((course) => String(course.course_id)),
      complete,
      pagination_complete: complete && truncatedListCalls === 0,
      list_calls: listCalls,
      completed_list_calls: completedListCalls,
      truncated_list_calls: truncatedListCalls,
      unread_page_responses: unreadPageResponses,
      unread_record_count: "unknown",
      audit_child_count: auditChildren.length,
      residual_coverage: moodleResidualCoverage(),
    },
  });
}

export async function collectProgramInventory(
  runtime: GatewayRuntime,
  value: unknown,
  options: { readonly signal?: AbortSignal } = {},
): Promise<JsonObject> {
  const input = parseProgramInventoryInput(value);
  return input.provider === "canvas"
    ? await collectCanvasProgramInventory(runtime, input, options)
    : await collectMoodleProgramInventory(runtime, input, options);
}

function inventoryFailure(error: unknown): CallToolResult {
  const detail = error instanceof CourseInventoryError || error instanceof TypeError
    ? error.message : "Morrow could not complete the selected-course inventory.";
  return {
    isError: true,
    content: [{ type: "text", text: `Course inventory unavailable. ${detail}` }],
    structuredContent: {
      schema: "morrow.problem.v1",
      code: "course_inventory_unavailable",
      detail_digest: sha256Text(error instanceof Error ? `${error.name}:${error.message}` : String(error)),
    },
  };
}

export async function collectCourseInventoryTool(
  runtime: GatewayRuntime,
  value: unknown,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  try {
    const boundedSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000);
    const report = await collectCanvasProgramInventory(runtime, value, { signal: boundedSignal });
    const coverage = isJsonObject(report.coverage) ? report.coverage : {};
    const complete = coverage.complete === true;
    const childCount = Array.isArray(report.audit_children) ? report.audit_children.length : 0;
    return {
      content: [{
        type: "text",
        text: `${complete ? "Supported selected-course inventory is complete" : "Selected-course inventory is incomplete"}. ${childCount} exact, safely bound audit target${childCount === 1 ? " is" : "s are"} ready. No edit or accessibility conformance decision was made.`,
      }],
      structuredContent: report,
    };
  } catch (error) {
    return inventoryFailure(error);
  }
}

export function registerCourseInventoryTool(server: McpServer, runtime: GatewayRuntime): void {
  server.registerTool("morrow_inventory_courses", {
    title: "Inventory selected Canvas course content",
    description: "Read an explicit selected set of Canvas courses through each course's current binding. Returns bounded discovery coverage for modules, Pages and the course front page, the course syllabus, Assignments, discussions, announcements, Classic Quizzes and questions, New Quizzes and items, rubrics, course files, and reachable Item Banks with the courses each bank's shares name. Rubric assessments are learner data and are never requested. A capped list is continued in further bounded calls, and every record Morrow read stays auditable even when the rest of that list, or another list, is still unread. A capped, malformed, inaccessible, or unsupported surface remains an explicit coverage gap with the pages it left unread. This tool makes no edit and does not establish accessibility conformance.",
    inputSchema: courseInventoryInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (value, context: ServerContext) => {
    return await collectCourseInventoryTool(runtime, value, context.mcpReq.signal);
  });
}
