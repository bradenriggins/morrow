import { isJsonObject, type JsonObject, type SourceCapabilityMetadata } from "@morrow/contracts";
import { BLACKBOARD_CONTENT_FIELDS, BLACKBOARD_ONE_LEVEL } from "../client.js";
import { safeContent, safeCourse, type BlackboardCourseRead, type BlackboardLearnRuntime } from "../runtime.js";
import { BLACKBOARD_ID, BlackboardApiError, type BlackboardApiFailureCode } from "../types.js";
import { blackboardTool, contentScopeInput, scopeInput, type BlackboardOperationModule } from "./definition.js";
import { READ_ANNOTATIONS, READ_BEHAVIOR, READ_PROFILES } from "./course-read.js";

/**
 * The course fields the v3 course read asks for. The recovery contract pins this
 * list (docs/research/blackboard-recovery-contract.md:178) and this read adds
 * `availability`, which is the value it exists to report.
 */
const COURSE_FIELDS = ["id", "courseId", "name", "ultraStatus", "closedComplete", "availability"];

/**
 * How far `blackboard_inventory_course_contents` walks. These are ceilings, not
 * a promise: a course larger than either one is reported as read this far, with
 * every item the walk did not open named beside it.
 */
const INVENTORY_MAX_ITEMS = 200;
const INVENTORY_MAX_DEPTH = 4;

/**
 * A Blackboard content handler id, as the content-handler reference writes it,
 * such as `resource/x-bb-document` or `resource/x-bb-folder`.
 * https://docs.blackboard.com/docs/blackboard/rest-apis/advanced/content-handler
 */
const CONTENT_HANDLER_ID = /^[a-z][a-z0-9]{0,20}\/[a-z0-9-]{1,60}$/;

/** One short provider vocabulary value, such as `Ultra`, `Yes`, or `Disabled`. */
const PROVIDER_ENUM = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

/**
 * Why the inventory did not read one node. `children_unread` carries the
 * refusal Blackboard's own answer produced for that one node.
 */
type UnreadReason = "item_ceiling" | "depth_ceiling" | "children_unread";

const CEILING_DETAIL = {
  item_ceiling: `Morrow stopped this inventory at ${INVENTORY_MAX_ITEMS} items, so it did not read this one.`,
  depth_ceiling: `Morrow reads ${INVENTORY_MAX_DEPTH} levels of a Blackboard course, so it did not read what is inside this item.`,
} as const;

/**
 * The failures of one node's children read that the inventory records against
 * that node and then walks past. Everything else stops the whole walk: a
 * credential failure, a rate limit, a cancelled request, a refused pagination
 * link, and a scope mismatch are not one node's problem.
 */
const NODE_READ_FAILURES: readonly BlackboardApiFailureCode[] = [
  "blackboard_request_failed",
  "blackboard_response_invalid",
  "blackboard_response_incomplete",
  "blackboard_response_oversized",
];

interface PendingLevel {
  readonly path: string;
  /** The item whose children this level is, or `null` for the top level of the course. */
  readonly parentId: string | null;
  /** The depth of the items this level holds. The top level is 1. */
  readonly depth: number;
}

function contentsPath(courseId: string): string {
  return `/learn/api/public/v1/courses/${encodeURIComponent(courseId)}/contents?${BLACKBOARD_ONE_LEVEL}`;
}

function childrenPath(courseId: string, contentId: string): string {
  return `/learn/api/public/v1/courses/${encodeURIComponent(courseId)}/contents/${encodeURIComponent(contentId)}/children?${BLACKBOARD_ONE_LEVEL}`;
}

/** One Blackboard identifier Morrow can name a record by, or `null` when it read none. */
function exactId(value: unknown): string | null {
  return typeof value === "string" && BLACKBOARD_ID.test(value) ? value : null;
}

/** One short provider value as it may leave Morrow, or `null` when Blackboard reported none it reads. */
function providerValue(value: unknown): string | null {
  return typeof value === "string" && PROVIDER_ENUM.test(value) ? value : null;
}

/**
 * One content item as this module returns it: the projection every other Morrow
 * content read returns, plus what a person needs to place the item in the
 * course. `contentHandler` says what kind of item it is and `hasChildren`
 * whether anything is inside it. Both are absent when Blackboard did not report
 * them, so "Morrow does not know" never reads as "nothing is inside".
 */
function safeTreeItem(value: JsonObject, read: BlackboardCourseRead): JsonObject {
  const output = safeContent(value, read.roster);
  const handler = isJsonObject(value.contentHandler) && typeof value.contentHandler.id === "string" ? value.contentHandler.id : "";
  if (CONTENT_HANDLER_ID.test(handler)) output.contentHandler = { id: handler };
  if (typeof value.hasChildren === "boolean") output.hasChildren = value.hasChildren;
  return output;
}

/** Blackboard has to answer a children read with children of the item that was asked for. */
function assertChildOf(value: JsonObject, parentId: string | null): void {
  if (parentId === null || value.parentId === undefined || value.parentId === parentId) return;
  throw new BlackboardApiError(
    "blackboard_scope_binding_mismatch",
    "Blackboard returned a content item that is not inside the selected item.",
  );
}

/** One node the inventory did not read, named with the reason it did not. */
function unreadNode(id: string | null, depth: number, reason: UnreadReason, detail: string): JsonObject {
  return { ...(id ? { id } : {}), depth, reason, detail };
}

function readCapability(sourceExport: string, scopeClass = "tenant-course"): SourceCapabilityMetadata {
  return {
    family: "course-read",
    provider: "blackboard",
    sourceExport,
    behavior: READ_BEHAVIOR,
    authority: { scopeClass, approvalClass: "none", dataClass: "course" },
    route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
    profiles: READ_PROFILES,
    evidence: { live: { state: "unknown", reason: "api_configured_live_untested" }, credentialBoundary: { state: "known" } },
  };
}

/**
 * The Blackboard courses the configured integration account is enrolled in. It
 * reads that one account's memberships, and refuses a membership that names
 * another account. Each row says whether this Morrow installation is connected
 * to that course, which is what makes the list usable for choosing one.
 */
async function listMyCourses(
  runtime: BlackboardLearnRuntime,
  input: { tenant_id: string; source_binding_id: string; course_id: string },
  signal?: AbortSignal,
): Promise<JsonObject> {
  const read = await runtime.beginCourseRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const memberships = await read.client.collect(
    `/learn/api/public/v1/users/${encodeURIComponent(read.principalId)}/courses`,
    { label: "course membership", expand: ["course"], signal },
  );
  const courses: JsonObject[] = [];
  const unread: JsonObject[] = [];
  for (const membership of memberships) {
    if (membership.userId !== read.principalId) {
      throw new BlackboardApiError(
        "blackboard_scope_binding_mismatch",
        "Blackboard returned a course membership for a different account than the configured Blackboard integration account.",
      );
    }
    const course = isJsonObject(membership.course) ? membership.course : undefined;
    const id = course ? exactId(course.id) : null;
    if (!course || !id || (exactId(membership.courseId) && membership.courseId !== id)) {
      unread.push({
        ...(exactId(membership.courseId) ? { id: membership.courseId } : {}),
        reason: "course_unread",
        detail: "Blackboard did not return this membership's own course record, so Morrow left the course out of this list.",
      });
      continue;
    }
    const binding = read.courseBindings.find((entry) => entry.courseId === id);
    const ultraStatus = providerValue(course.ultraStatus);
    const available = isJsonObject(course.availability) ? providerValue(course.availability.available) : null;
    courses.push({
      ...safeCourse(course, read.roster),
      ...(ultraStatus ? { ultraStatus } : {}),
      ...(available ? { availability: { available } } : {}),
      connected: Boolean(binding),
      ...(binding ? { sourceBindingId: binding.sourceBindingId } : {}),
    });
  }
  return {
    schema: "morrow.blackboard.courses.v1",
    ok: true,
    tenantId: read.tenantId,
    sourceBindingId: read.sourceBindingId,
    courseId: read.courseId,
    courses,
    count: courses.length,
    complete: unread.length === 0,
    unread,
    status: "api_configured_live_untested",
    diagnostics: read.cost(),
  };
}

/** The items directly inside one selected content item, one level and no further. */
async function listContentChildren(
  runtime: BlackboardLearnRuntime,
  input: { tenant_id: string; source_binding_id: string; course_id: string; content_id: string },
  signal?: AbortSignal,
): Promise<JsonObject> {
  const read = await runtime.beginCourseRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const records = await read.client.collect(childrenPath(read.courseId, input.content_id), {
    label: "content", fields: BLACKBOARD_CONTENT_FIELDS.full, signal,
  });
  const children = records.map((record) => {
    assertChildOf(record, input.content_id);
    return safeTreeItem(record, read);
  });
  return {
    schema: "morrow.blackboard.content-children.v1",
    ok: true,
    tenantId: read.tenantId,
    sourceBindingId: read.sourceBindingId,
    courseId: read.courseId,
    contentId: input.content_id,
    children,
    count: children.length,
    status: "api_configured_live_untested",
    diagnostics: read.cost(),
  };
}

/**
 * Whether one selected course is available, closed and complete, and Original or
 * Ultra. The v3 course read answers this; a Learn version that does not serve
 * that route is read through the v1 course record instead. The result records
 * which read answered and names every field that read did not report, because a
 * field Morrow could not read is not the same finding as a field that is off.
 */
async function getCourseAvailability(
  runtime: BlackboardLearnRuntime,
  input: { tenant_id: string; source_binding_id: string; course_id: string },
  signal?: AbortSignal,
): Promise<JsonObject> {
  const read = await runtime.beginCourseRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const path = `/learn/api/public/v3/courses/${encodeURIComponent(read.courseId)}?fields=${COURSE_FIELDS.join(",")}`;
  let apiVersion = "v3";
  let course: JsonObject;
  try {
    course = await read.client.get(path, signal);
  } catch (error) {
    // Only a route this Learn version does not serve falls back. Every other
    // failure is this tenant's answer to the read Morrow meant to make.
    if (!(error instanceof BlackboardApiError) || error.status !== 404) throw error;
    apiVersion = "v1";
    course = await read.client.get(`/learn/api/public/v1/courses/${encodeURIComponent(read.courseId)}`, signal);
  }
  if (course.id !== read.courseId) {
    throw new BlackboardApiError("blackboard_scope_binding_mismatch", "Blackboard returned a different course.");
  }
  const ultraStatus = providerValue(course.ultraStatus);
  const available = isJsonObject(course.availability) ? providerValue(course.availability.available) : null;
  const closedComplete = typeof course.closedComplete === "boolean" ? course.closedComplete : null;
  const unreported = [
    ...(ultraStatus ? [] : ["ultraStatus"]),
    ...(available ? [] : ["availability.available"]),
    ...(closedComplete === null ? ["closedComplete"] : []),
  ];
  return {
    schema: "morrow.blackboard.course-availability.v1",
    ok: true,
    tenantId: read.tenantId,
    sourceBindingId: read.sourceBindingId,
    courseId: read.courseId,
    apiVersion,
    course: safeCourse(course, read.roster),
    ...(ultraStatus ? { ultraStatus } : {}),
    ...(available ? { availability: { available } } : {}),
    ...(closedComplete === null ? {} : { closedComplete }),
    unreported,
    status: "api_configured_live_untested",
    diagnostics: read.cost(),
  };
}

/**
 * One bounded map of a course's content tree, read level by level. It stops at
 * `INVENTORY_MAX_ITEMS` items and `INVENTORY_MAX_DEPTH` levels and names every
 * item it did not read, so a partial map is never reported as the whole course.
 * It reads one level at a time rather than asking Blackboard to recurse,
 * because that is what makes each unread node nameable.
 */
async function inventoryCourseContents(
  runtime: BlackboardLearnRuntime,
  input: { tenant_id: string; source_binding_id: string; course_id: string },
  signal?: AbortSignal,
): Promise<JsonObject> {
  const read = await runtime.beginCourseRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const items: JsonObject[] = [];
  const unread: JsonObject[] = [];
  /** Every item whose children this walk has already asked for, so it asks once. */
  const expanded = new Set<string>();
  const pending: PendingLevel[] = [{ path: contentsPath(read.courseId), parentId: null, depth: 1 }];
  while (pending.length > 0) {
    const level = pending.shift()!;
    // The ceiling is checked before the request, so a course past it costs no
    // further Blackboard reads and every level left in the queue is still named.
    if (items.length >= INVENTORY_MAX_ITEMS) {
      unread.push(unreadNode(level.parentId, level.depth, "item_ceiling", CEILING_DETAIL.item_ceiling));
      continue;
    }
    let records: readonly JsonObject[];
    try {
      records = await read.client.collect(level.path, { label: "content", fields: BLACKBOARD_CONTENT_FIELDS.structure, signal });
    } catch (error) {
      if (!(error instanceof BlackboardApiError) || !NODE_READ_FAILURES.includes(error.code)) throw error;
      unread.push(unreadNode(level.parentId, level.depth, "children_unread", error.message));
      continue;
    }
    for (const record of records) {
      assertChildOf(record, level.parentId);
      if (items.length >= INVENTORY_MAX_ITEMS) {
        unread.push(unreadNode(exactId(record.id), level.depth, "item_ceiling", CEILING_DETAIL.item_ceiling));
        continue;
      }
      const item = safeTreeItem(record, read);
      items.push({ ...item, depth: level.depth });
      const id = exactId(item.id);
      if (record.hasChildren !== true || !id || expanded.has(id)) continue;
      if (level.depth >= INVENTORY_MAX_DEPTH) {
        unread.push(unreadNode(id, level.depth + 1, "depth_ceiling", CEILING_DETAIL.depth_ceiling));
        continue;
      }
      expanded.add(id);
      pending.push({ path: childrenPath(read.courseId, id), parentId: id, depth: level.depth + 1 });
    }
  }
  return {
    schema: "morrow.blackboard.content-inventory.v1",
    ok: true,
    tenantId: read.tenantId,
    sourceBindingId: read.sourceBindingId,
    courseId: read.courseId,
    items,
    count: items.length,
    complete: unread.length === 0,
    unread,
    limits: { maxItems: INVENTORY_MAX_ITEMS, maxDepth: INVENTORY_MAX_DEPTH },
    status: "api_configured_live_untested",
    diagnostics: read.cost(),
  };
}

/**
 * The Blackboard course and content-tree reads. Each one resolves the exact
 * configured course connection, checks which Learn account this server
 * credential acts as and that account's membership of the selected course, and
 * redacts learner identities out of every value it returns. Each content
 * listing asks Blackboard for one level and an explicit field list, as the
 * recovery contract requires (docs/research/blackboard-recovery-contract.md:179).
 *
 * Every route here comes from Anthology's public documentation. No tenant
 * Swagger has been read, and the developer portal pins the published route set
 * to one Learn version, so which of these a given Learn site answers stays
 * live-unverified.
 */
export const blackboardCourseContentsModule: BlackboardOperationModule = {
  id: "course-contents",
  tools: [
    blackboardTool({
      name: "blackboard_list_my_courses",
      title: "List Blackboard courses for this connection",
      description: "List the Blackboard Learn courses the configured Morrow integration account is enrolled in, and mark which of them this Morrow installation is connected to. Course text is redacted against the selected course's roster, which is the only roster this server holds.",
      private: false,
      gatewayDispatchOnly: false,
      inputSchema: scopeInput,
      annotations: READ_ANNOTATIONS,
      capability: readCapability("GET /learn/api/public/v1/users/{principal_id}/courses", "tenant-account"),
      rest: {
        method: "GET",
        pathTemplate: "/learn/api/public/v1/users/{principal_id}/courses",
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => listMyCourses(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_list_content_children",
      title: "List what is inside one Blackboard content item",
      description: "List the Blackboard Learn content items directly inside one selected item. It reads one level and does not open what is inside those items. Learner identities are redacted before output.",
      private: false,
      gatewayDispatchOnly: false,
      inputSchema: contentScopeInput,
      annotations: READ_ANNOTATIONS,
      capability: readCapability("GET /learn/api/public/v1/courses/{course_id}/contents/{content_id}/children"),
      rest: {
        method: "GET",
        pathTemplate: "/learn/api/public/v1/courses/{course_id}/contents/{content_id}/children?recursive=false",
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => listContentChildren(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_get_course_availability",
      title: "Read whether one Blackboard course is open",
      description: "Read whether one selected Blackboard Learn course is available, whether it is closed and complete, and whether it is an Original or an Ultra course. The result records which Learn course read answered and names every one of those fields that read did not report.",
      private: false,
      gatewayDispatchOnly: false,
      inputSchema: scopeInput,
      annotations: READ_ANNOTATIONS,
      capability: readCapability("GET /learn/api/public/v3/courses/{course_id}"),
      rest: {
        method: "GET",
        pathTemplate: "/learn/api/public/v3/courses/{course_id}?fields=id,courseId,name,ultraStatus,closedComplete,availability",
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => getCourseAvailability(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_inventory_course_contents",
      title: "Map the content of one Blackboard course",
      description: `Walk one selected Blackboard Learn course's content tree, to at most ${INVENTORY_MAX_ITEMS} items and ${INVENTORY_MAX_DEPTH} levels. The result lists each item it read with the level it sits at, and each item it did not read with the reason, so a partial map is never reported as the whole course. It reads titles and structure, not item text: read one item with blackboard_read_course_content. Learner identities are redacted before output.`,
      private: false,
      gatewayDispatchOnly: false,
      inputSchema: scopeInput,
      annotations: READ_ANNOTATIONS,
      capability: readCapability("GET /learn/api/public/v1/courses/{course_id}/contents?recursive=false, then .../contents/{content_id}/children for each level below it"),
      rest: {
        method: "GET",
        pathTemplate: "/learn/api/public/v1/courses/{course_id}/contents?recursive=false",
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => inventoryCourseContents(runtime, input, signal),
    }),
  ],
};
