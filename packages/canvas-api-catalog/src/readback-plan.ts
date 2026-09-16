export interface CanvasReadbackParameter {
  readonly inputName: string;
  readonly wireName: string;
  readonly location: string;
}

export interface CanvasReadbackOperation {
  readonly toolName: string;
  readonly key?: string;
  readonly nickname: string;
  readonly service: string;
  readonly method: string;
  readonly path: string;
  readonly readOnly: boolean;
  readonly parameters?: readonly CanvasReadbackParameter[];
}

export type CanvasReadbackBlocker =
  | "student_grade_or_submission_state"
  | "discussion_or_conversation_content"
  | "summary_state_has_no_narrow_reader"
  | "external_tool_update_has_no_cataloged_fields"
  | "module_item_reader_mutates_progress"
  | "module_progression_state_has_no_current_user_reader"
  | "content_migration_update_has_no_cataloged_fields"
  | "favorite_list_is_effective_not_explicit_state"
  | "course_delete_or_conclude_is_ambiguous"
  | "outcome_link_identity_is_nested";

const BLOCKED_READBACKS: Readonly<Record<string, CanvasReadbackBlocker>> = Object.freeze({
  bulk_select_provisional_grades: "student_grade_or_submission_state",
  clear_unread_status_for_all_submissions_courses: "student_grade_or_submission_state",
  delete_feedback_on_conversation_message: "discussion_or_conversation_content",
  delete_single_rubric_assessment: "student_grade_or_submission_state",
  delete_submission_comment: "student_grade_or_submission_state",
  disable_summary_courses: "summary_state_has_no_narrow_reader",
  edit_external_tool_courses: "external_tool_update_has_no_cataloged_fields",
  add_course_to_favorites: "favorite_list_is_effective_not_explicit_state",
  mark_module_item_as_done_not_done: "module_item_reader_mutates_progress",
  mark_submission_as_read_courses: "student_grade_or_submission_state",
  mark_submission_as_unread_courses: "student_grade_or_submission_state",
  mark_submission_item_as_read_courses: "student_grade_or_submission_state",
  re_lock_module_progressions: "module_progression_state_has_no_current_user_reader",
  remove_course_from_favorites: "favorite_list_is_effective_not_explicit_state",
  reset_what_if_scores_for_current_user_for_entire_course_and_recalculate_grades: "student_grade_or_submission_state",
  select_provisional_grade: "student_grade_or_submission_state",
  update_content_migration_courses: "content_migration_update_has_no_cataloged_fields",
  // One route deletes or concludes the whole course by its event field, and the course read cannot
  // tell a concluded course from the saved state a deleted one leaves.
  delete_conclude_course: "course_delete_or_conclude_is_ambiguous",
  // A group's link list is keyed by the linked outcome, not by the group id the route names, so the
  // generic collection reading would match the wrong record (ledger row 412).
  create_link_outcome_accounts: "outcome_link_identity_is_nested",
  create_link_outcome_accounts_outcome_id: "outcome_link_identity_is_nested",
  create_link_outcome_courses: "outcome_link_identity_is_nested",
  create_link_outcome_courses_outcome_id: "outcome_link_identity_is_nested",
  create_link_outcome_global: "outcome_link_identity_is_nested",
  create_link_outcome_global_outcome_id: "outcome_link_identity_is_nested",
});

export function canvasReadbackBlocker(operation: Pick<CanvasReadbackOperation, "nickname"> | null | undefined): CanvasReadbackBlocker | undefined {
  return operation?.nickname ? BLOCKED_READBACKS[operation.nickname] : undefined;
}

const NAMED_CANVAS_READBACKS = Object.freeze([
  {
    toolName: "canvas_bulk_update_assignment_dates",
    key: "PUT /v1/courses/{course_id}/assignments/bulk_update#bulk_update_assignment_dates",
  },
  {
    toolName: "canvas_re_activate_enrollment",
    key: "PUT /v1/courses/{course_id}/enrollments/{id}/reactivate#re_activate_enrollment",
  },
  {
    toolName: "canvas_duplicate_assignment",
    key: "POST /v1/courses/{course_id}/assignments/{assignment_id}/duplicate#duplicate_assignment",
  },
]);

/** True when a reviewed entry in the exact readback table names this write's read and comparator. */
export function hasDeclaredCanvasReadback(operation: Pick<CanvasReadbackOperation, "nickname"> | null | undefined): boolean {
  return Boolean(operation?.nickname && Object.hasOwn(EXACT_READBACKS, operation.nickname));
}

export function hasNamedCanvasReadback(operation: Pick<CanvasReadbackOperation, "toolName" | "key"> | null | undefined): boolean {
  return NAMED_CANVAS_READBACKS.some((candidate) => candidate.toolName === operation?.toolName && candidate.key === operation?.key);
}

export interface BrowserReadbackAssertion {
  readonly inputName: string;
  readonly paths: readonly (readonly string[])[];
  readonly expected: unknown;
}

export interface BrowserReadbackPlan {
  readonly schema: "morrow.browser-readback-plan.v1";
  readonly strategy: string;
  readonly readOperation: CanvasReadbackOperation;
  readonly arguments: Readonly<Record<string, string | readonly string[]>>;
  readonly assertions: readonly BrowserReadbackAssertion[];
  readonly targetId?: string;
  readonly targetField?: string;
  readonly targetPath?: readonly string[];
  /** For a reorder: the requested ids, in the order the listing must return them. */
  readonly orderedTargets?: readonly string[];
  /**
   * A second reviewed read for a deletion Canvas answers by still returning the
   * object. Canvas keeps some deleted records readable by id and shows the
   * deletion only by leaving them out of their listing, so the listing settles
   * what the record alone cannot.
   */
  readonly fallback?: BrowserReadbackPlan;
}

interface ExactReadback {
  readonly read: string;
  readonly dynamic?: Readonly<Record<string, string>>;
  readonly fixedArguments?: Readonly<Record<string, string | readonly string[]>>;
  // Read inputs filled from the write's own inputs: a string names one write input, and a one-element
  // list names one write input sent as a one-element list, such as `ids[]` naming the written entry.
  readonly argumentsFromWrite?: Readonly<Record<string, string | readonly [string]>>;
  // A reorder names every id it moves in one write input. The listing must return exactly those ids
  // in that order, whatever other records it holds between them.
  readonly orderArgument?: string;
  readonly targetArgument?: string;
  readonly targetResponse?: string;
  readonly targetField?: string;
  readonly targetPath?: readonly string[];
  readonly strategy?: string;
  readonly ignoredAssertions?: readonly string[];
  // Input names whose value is the whole written resource. The request wraps that value under the
  // parameter name, while the readback returns the resource itself, so the saved record is compared
  // at its own root as well as under that name.
  readonly bodyAssertions?: readonly string[];
  readonly responseAssertions?: readonly string[];
  readonly fixedAssertions?: Readonly<Record<string, unknown>>;
}

const EXACT_READBACKS: Readonly<Record<string, ExactReadback>> = Object.freeze({
  create_page_courses: { read: "show_page_courses", dynamic: { url_or_id: "url" }, targetResponse: "page_id", targetField: "page_id", strategy: "created-resource", ignoredAssertions: ["wiki_page_notify_of_update"] },
  create_page_groups: { read: "show_page_groups", dynamic: { url_or_id: "url" }, targetResponse: "page_id", targetField: "page_id", strategy: "created-resource", ignoredAssertions: ["wiki_page_notify_of_update"] },
  create_assignment_group: { read: "get_assignment_group", dynamic: { assignment_group_id: "id" }, targetField: "id", strategy: "created-resource" },
  create_new_discussion_topic_courses: { read: "get_single_topic_courses", dynamic: { topic_id: "id" }, targetField: "id", strategy: "created-resource" },
  create_new_discussion_topic_groups: { read: "get_single_topic_groups", dynamic: { topic_id: "id" }, targetField: "id", strategy: "created-resource" },
  create_new_grading_standard_courses: { read: "get_single_grading_standard_in_context_courses", dynamic: { grading_standard_id: "id" }, targetField: "id", strategy: "created-resource" },
  create_external_tool_courses: { read: "get_single_external_tool_courses", dynamic: { external_tool_id: "id" }, targetField: "id", strategy: "created-resource" },
  // Both the write and the folder list read carry one folder id, and they mean different folders:
  // the write names the folder the new one goes inside, and the list would name the new folder's own
  // contents. The new folder's own reading is the comparator, and it names its parent again.
  create_folder_folders: { read: "get_folder_folders", dynamic: { id: "id" }, targetField: "id", strategy: "created-resource" },
  create_new_quiz: { read: "get_new_quiz", dynamic: { assignment_id: "id" }, targetField: "id", strategy: "created-resource" },
  update_single_quiz: { read: "get_new_quiz", strategy: "updated-resource" },
  delete_new_quiz: { read: "get_new_quiz", strategy: "deleted-resource" },
  create_quiz_item: { read: "get_quiz_item", dynamic: { item_id: "id" }, targetField: "id", strategy: "created-resource" },
  update_quiz_item: { read: "get_quiz_item", strategy: "updated-resource" },
  delete_quiz_item: { read: "get_quiz_item", strategy: "deleted-resource" },
  update_custom_gradebook_column: {
    read: "list_custom_gradebook_columns",
    fixedArguments: { include_hidden: "true" },
    targetArgument: "id",
    targetField: "id",
    strategy: "collection-contains-target",
    responseAssertions: ["title", "position", "hidden", "teacher_notes", "read_only"],
  },
  delete_custom_gradebook_column: {
    read: "list_custom_gradebook_columns",
    fixedArguments: { include_hidden: "true" },
    targetArgument: "id",
    targetField: "id",
    strategy: "collection-omits-target",
  },
  delete_external_feed_courses: {
    read: "list_external_feeds_courses",
    targetArgument: "external_feed_id",
    targetField: "id",
    strategy: "collection-omits-target",
  },
  mark_document_annotations_as_read_courses: {
    read: "get_document_annotations_read_state_courses",
    fixedAssertions: { read: true },
    strategy: "updated-resource",
  },
  mark_rubric_assessments_as_read_courses_rubric_assessments: {
    read: "get_rubric_assessments_read_state_courses_rubric_assessments",
    fixedAssertions: { read: true },
    strategy: "updated-resource",
  },
  mark_rubric_assessments_as_read_courses_rubric_comments: {
    read: "get_rubric_assessments_read_state_courses_rubric_comments",
    fixedAssertions: { read: true },
    strategy: "updated-resource",
  },
  unlink_outcome_courses: {
    read: "list_linked_outcomes_courses",
    targetArgument: "outcome_id",
    targetField: "outcome.id",
    strategy: "collection-omits-target",
  },
  // A copy is a new object Canvas answers with, read back through its own route.
  duplicate_page: { read: "show_page_courses", dynamic: { url_or_id: "url" }, targetResponse: "page_id", targetField: "page_id", strategy: "created-resource" },
  duplicate_discussion_topic_courses: { read: "get_single_topic_courses", dynamic: { topic_id: "id" }, targetField: "id", strategy: "created-resource" },
  duplicate_discussion_topic_groups: { read: "get_single_topic_groups", dynamic: { topic_id: "id" }, targetField: "id", strategy: "created-resource" },
  // A reorder is proved by the complete listing returning the requested ids in the requested order.
  reorder_custom_columns: { read: "list_custom_gradebook_columns", fixedArguments: { include_hidden: "true" }, orderArgument: "order", targetField: "id", strategy: "collection-order" },
  reorder_pinned_topics_courses: { read: "list_discussion_topics_courses", fixedArguments: { order_by: "position" }, orderArgument: "order", targetField: "id", strategy: "collection-order" },
  reorder_pinned_topics_groups: { read: "list_discussion_topics_groups", fixedArguments: { order_by: "position" }, orderArgument: "order", targetField: "id", strategy: "collection-order" },
  // Discussion state that belongs to the signed-in person: a topic's read state and subscription, and
  // one entry's read state. Each is read back from the same topic or entry for the same person.
  ...Object.fromEntries((["courses", "groups"] as const).flatMap((context) => [
    [`mark_topic_as_read_${context}`, { read: `get_single_topic_${context}`, fixedAssertions: { read_state: "read" }, strategy: "updated-resource" }],
    [`mark_topic_as_unread_${context}`, { read: `get_single_topic_${context}`, fixedAssertions: { read_state: "unread" }, strategy: "updated-resource" }],
    [`subscribe_to_topic_${context}`, { read: `get_single_topic_${context}`, fixedAssertions: { subscribed: true }, strategy: "updated-resource" }],
    [`unsubscribe_from_topic_${context}`, { read: `get_single_topic_${context}`, fixedAssertions: { subscribed: false }, strategy: "updated-resource" }],
    [`mark_all_entries_as_read_${context}`, {
      read: `get_single_topic_${context}`, fixedAssertions: { read_state: "read", unread_count: 0 },
      ignoredAssertions: ["forced_read_state"], strategy: "updated-resource",
    }],
    [`mark_all_entries_as_unread_${context}`, {
      read: `get_single_topic_${context}`, fixedAssertions: { read_state: "unread" },
      ignoredAssertions: ["forced_read_state"], strategy: "updated-resource",
    }],
    [`mark_entry_as_read_${context}`, {
      read: `list_entries_${context}`, argumentsFromWrite: { ids: ["entry_id"] }, targetArgument: "entry_id", targetField: "id",
      fixedAssertions: { read_state: "read" }, ignoredAssertions: ["forced_read_state"], strategy: "collection-contains-target",
    }],
    [`mark_entry_as_unread_${context}`, {
      read: `list_entries_${context}`, argumentsFromWrite: { ids: ["entry_id"] }, targetArgument: "entry_id", targetField: "id",
      fixedAssertions: { read_state: "unread" }, ignoredAssertions: ["forced_read_state"], strategy: "collection-contains-target",
    }],
    // Canvas keeps a deleted entry in the entry list and marks it deleted.
    [`delete_entry_${context}`, {
      read: `list_entries_${context}`, argumentsFromWrite: { ids: ["id"] }, targetArgument: "id", targetField: "id",
      fixedAssertions: { deleted: true }, strategy: "collection-contains-target",
    }],
    // Every topic in the context is read once all of them are marked read.
    [`mark_all_topic_as_read_${context}`, {
      read: `list_discussion_topics_${context}`, fixedAssertions: { read_state: "read" }, strategy: "collection-every-record",
    }],
  ])) as Record<string, ExactReadback>,
});

function normalizedPath(value: unknown): string {
  return String(value || "").replace(/\{[^}]+\}/g, "{}");
}

function wirePath(value: unknown): string[] {
  return String(value || "").match(/[^\[\].]+/g) || [];
}

function normalizeKey(value: unknown): string {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function valueByKey(value: unknown, key: string, depth = 0): unknown {
  if (depth > 12 || value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = valueByKey(entry, key, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  const wanted = normalizeKey(key);
  for (const [name, child] of Object.entries(value)) {
    if (normalizeKey(name) === wanted && child !== undefined) return child;
  }
  for (const child of Object.values(value)) {
    const found = valueByKey(child, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function readArguments(
  read: CanvasReadbackOperation,
  writeArguments: Readonly<Record<string, unknown>> | undefined,
  dynamic: Readonly<Record<string, string>> = {},
  fixedArguments: Readonly<Record<string, string | readonly string[]>> = {},
  writeData: unknown,
  argumentsFromWrite: Readonly<Record<string, string | readonly [string]>> = {},
): Readonly<Record<string, string | readonly string[]>> | null {
  const output: Record<string, string | readonly string[]> = {};
  for (const [inputName, source] of Object.entries(argumentsFromWrite)) {
    if (!(read.parameters || []).some((parameter) => parameter.inputName === inputName)) return null;
    const writeName = typeof source === "string" ? source : source[0];
    const value = writeArguments?.[writeName];
    if (value === undefined || value === null || value === "" || typeof value === "object") return null;
    output[inputName] = typeof source === "string" ? String(value) : [String(value)];
  }
  for (const parameter of read.parameters || []) {
    if (parameter.location !== "path" || Object.hasOwn(output, parameter.inputName)) continue;
    const responseKey = dynamic[parameter.inputName];
    const wireResponseKey = dynamic[parameter.wireName];
    const dynamicResponseKey = responseKey ?? wireResponseKey;
    let value = dynamicResponseKey === undefined
      ? writeArguments?.[parameter.inputName]
      : valueByKey(writeData, dynamicResponseKey);
    if (value === undefined && dynamicResponseKey === undefined
      && !Object.prototype.hasOwnProperty.call(writeArguments || {}, parameter.inputName)) {
      value = valueByKey(writeData, parameter.inputName);
    }
    if (value === undefined || value === null || value === "") return null;
    output[parameter.inputName] = String(value);
  }
  for (const [inputName, value] of Object.entries(fixedArguments)) {
    if (!(read.parameters || []).some((parameter) => parameter.inputName === inputName)) return null;
    output[inputName] = value;
  }
  return output;
}

function exactRead(operations: readonly CanvasReadbackOperation[], write: CanvasReadbackOperation): CanvasReadbackOperation | undefined {
  return operations.find((candidate) => candidate.readOnly && candidate.service === write.service && normalizedPath(candidate.path) === normalizedPath(write.path));
}

function childRead(operations: readonly CanvasReadbackOperation[], write: CanvasReadbackOperation): CanvasReadbackOperation | undefined {
  const prefix = `${normalizedPath(write.path).replace(/\/$/, "")}/{}`;
  return operations.find((candidate) => candidate.readOnly && candidate.service === write.service && normalizedPath(candidate.path) === prefix);
}

function collectionRead(operations: readonly CanvasReadbackOperation[], write: CanvasReadbackOperation): CanvasReadbackOperation | undefined {
  const segments = write.path.split("/").filter(Boolean);
  for (let count = segments.length; count >= 2; count -= 1) {
    const path = normalizedPath(`/${segments.slice(0, count).join("/")}`);
    const read = operations.find((candidate) => candidate.readOnly && candidate.service === write.service && normalizedPath(candidate.path) === path);
    if (read) return read;
  }
  return undefined;
}

function normalizedRoute(value: unknown): string {
  return normalizedPath(value).replace(/\/$/, "");
}

function readsWriteTargetResource(write: CanvasReadbackOperation, read: CanvasReadbackOperation): boolean {
  const target = normalizedRoute(write.path);
  const candidate = normalizedRoute(read.path);
  return candidate === target || candidate === `${target}/{}` || `${candidate}/{}` === target;
}

function collectionTargetArgument(
  write: CanvasReadbackOperation,
  read: CanvasReadbackOperation,
): string | undefined {
  const writeSegments = write.path.split("/").filter(Boolean);
  const readSegments = read.path.split("/").filter(Boolean);
  if (writeSegments.length !== readSegments.length + 1) return undefined;
  if (normalizedPath(`/${writeSegments.slice(0, -1).join("/")}`) !== normalizedPath(`/${readSegments.join("/")}`)) return undefined;
  const match = /^\{([^{}]+)\}$/.exec(writeSegments.at(-1) || "");
  if (!match) return undefined;
  const parameters = (write.parameters || []).filter((parameter) => parameter.location === "path"
    && (parameter.wireName === match[1] || parameter.inputName === match[1]));
  return parameters.length === 1 ? parameters[0]!.inputName : undefined;
}

function requestedAssertions(
  write: CanvasReadbackOperation,
  args: Readonly<Record<string, unknown>> | undefined,
  ignored: readonly string[] = [],
  bodies: readonly string[] = [],
): readonly BrowserReadbackAssertion[] {
  return (write.parameters || []).flatMap((parameter) => {
    if (parameter.location === "path" || ignored.includes(parameter.inputName)) return [];
    const expected = args?.[parameter.inputName];
    if (expected === undefined) return [];
    const full = wirePath(parameter.wireName);
    const wrapped = full.length > 1 ? [full, full.slice(1)] : [full];
    const paths = bodies.includes(parameter.inputName) ? [...wrapped, []] : wrapped;
    return [{ inputName: parameter.inputName, paths, expected }];
  });
}

function responseAssertions(
  names: readonly string[] | undefined,
  writeData: unknown,
): readonly BrowserReadbackAssertion[] {
  return (names || []).flatMap((inputName) => {
    const expected = valueByKey(writeData, inputName);
    if (expected === undefined) return [];
    const full = wirePath(inputName);
    return [{ inputName, paths: [full], expected }];
  });
}

function fixedAssertions(
  values: Readonly<Record<string, unknown>> | undefined,
): readonly BrowserReadbackAssertion[] {
  return Object.entries(values || {}).map(([inputName, expected]) => ({
    inputName,
    paths: [wirePath(inputName)],
    expected,
  }));
}

/**
 * The listing that proves one deletion when Canvas still answers for the deleted
 * record by id. It reads the collection the written route belongs to and requires
 * the target to be gone from it.
 */
function deletionListingFallback(
  operations: readonly CanvasReadbackOperation[],
  write: CanvasReadbackOperation,
  args: Readonly<Record<string, unknown>> | undefined,
): BrowserReadbackPlan | null {
  const segments = write.path.split("/").filter(Boolean);
  const parent = normalizedPath(`/${segments.slice(0, -1).join("/")}`);
  const candidates = operations.filter((candidate) => candidate.readOnly
    && candidate.service === write.service
    && normalizedPath(candidate.path) === parent);
  const listing = candidates.length === 1 ? candidates[0] : undefined;
  if (!listing) return null;
  const targetArgument = collectionTargetArgument(write, listing);
  const target = targetArgument ? args?.[targetArgument] : undefined;
  // The listing is matched on the record id, so a route addressed by anything
  // else, such as a page by its URL, is left to its own read.
  if (!/^[1-9][0-9]{0,18}$/.test(String(target ?? ""))) return null;
  const argumentsValue = readArguments(listing, args, undefined, undefined, undefined, undefined);
  if (!argumentsValue) return null;
  return {
    schema: "morrow.browser-readback-plan.v1",
    strategy: "collection-omits-target",
    readOperation: listing,
    arguments: argumentsValue,
    assertions: [],
    targetId: String(target),
    targetField: "id",
  };
}

export function planBrowserReadback(
  operations: readonly CanvasReadbackOperation[],
  write: CanvasReadbackOperation | null | undefined,
  args: Readonly<Record<string, unknown>> | undefined,
  writeData: unknown,
): BrowserReadbackPlan | null {
  if (!write || write.readOnly) return null;
  if (canvasReadbackBlocker(write)) return null;
  const override = EXACT_READBACKS[write.nickname];
  let read = override
    ? operations.find((candidate) => candidate.readOnly && candidate.service === write.service && candidate.nickname === override.read)
    : undefined;
  let strategy = override?.strategy;
  if (!read && write.method === "POST") {
    read = childRead(operations, write) || exactRead(operations, write) || collectionRead(operations, write);
    strategy = read && normalizedPath(read.path) === normalizedPath(write.path) ? "collection-contains-target" : "created-resource";
  }
  if (!read) {
    read = exactRead(operations, write) || collectionRead(operations, write);
    strategy = write.method === "DELETE"
      ? (read && normalizedPath(read.path) === normalizedPath(write.path) ? "deleted-resource" : "collection-omits-target")
      : "updated-resource";
  }
  if (!read) return null;
  // A generic read only proves this write when it addresses the written resource itself, the child
  // route the write creates, or the collection that holds the written item. Any other route reports
  // the state of a different object. Hand-written EXACT_READBACKS entries and the named Canvas
  // readbacks carry their own reviewed route and evaluator.
  if (!override && !hasNamedCanvasReadback(write) && !readsWriteTargetResource(write, read)) return null;
  const argumentsValue = readArguments(read, args, override?.dynamic, override?.fixedArguments, writeData, override?.argumentsFromWrite);
  if (!argumentsValue) return null;
  const collectionArgument = !override && !hasNamedCanvasReadback(write) ? collectionTargetArgument(write, read) : undefined;
  if (collectionArgument && write.method !== "POST") {
    strategy = write.method === "DELETE" ? "collection-omits-target" : "collection-contains-target";
  }
  const targetId = override?.targetArgument
    ? args?.[override.targetArgument]
    : override?.targetResponse
      ? valueByKey(writeData, override.targetResponse)
      : write.method === "POST"
        ? valueByKey(writeData, "id")
        : collectionArgument
          ? args?.[collectionArgument]
          : undefined;
  const targetField = targetId === undefined || targetId === null ? undefined : override?.targetField || "id";
  const orderValue = override?.orderArgument ? args?.[override.orderArgument] : undefined;
  const orderList = typeof orderValue === "string" ? orderValue.split(",").map((entry) => entry.trim()) : orderValue;
  const orderedTargets = Array.isArray(orderList) && orderList.length > 0
    && orderList.every((entry) => /^[1-9][0-9]{0,18}$/.test(String(entry)))
    ? orderList.map((entry) => String(entry))
    : undefined;
  if (override?.orderArgument && !orderedTargets) return null;
  return {
    schema: "morrow.browser-readback-plan.v1",
    strategy: strategy || "updated-resource",
    readOperation: read,
    arguments: argumentsValue,
    ...(strategy === "deleted-resource"
      ? (() => {
        const listing = deletionListingFallback(operations, write, args);
        return listing ? { fallback: listing } : {};
      })()
      : {}),
    assertions: [
      ...requestedAssertions(write, args, [...(override?.ignoredAssertions || []), ...(override?.orderArgument ? [override.orderArgument] : [])], override?.bodyAssertions),
      ...responseAssertions(override?.responseAssertions, writeData),
      ...fixedAssertions(override?.fixedAssertions),
    ],
    ...(targetId === undefined || targetId === null ? {} : { targetId: String(targetId) }),
    ...(targetField ? { targetField } : {}),
    ...(override?.targetPath?.length ? { targetPath: override.targetPath } : {}),
    ...(orderedTargets ? { orderedTargets } : {}),
  };
}

export interface BrowserReadbackResult {
  readonly ok?: boolean;
  readonly status?: number;
  readonly truncated?: boolean;
  readonly data?: unknown;
}

export interface BrowserVerification {
  readonly schema: "morrow.browser-verification.v1";
  readonly status: "verified" | "mismatch" | "unconfirmed";
  readonly strategy?: string;
  readonly readTool?: string;
  readonly evidence?: string;
  readonly reason?: string;
}

function pathValue(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const part of path) {
    if (!current || typeof current !== "object") return undefined;
    const record = current as Record<string, unknown>;
    const match = Object.keys(record).find((key) => normalizeKey(key) === normalizeKey(part));
    if (!match) return undefined;
    current = record[match];
  }
  return current;
}

function assertedValues(record: unknown, paths: readonly (readonly string[])[] | undefined): unknown[] {
  return (paths || []).map((path) => pathValue(record, path)).filter((value) => value !== undefined);
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const NUMBER_LITERAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!NUMBER_LITERAL.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function equivalent(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (actual === null || expected === null || actual === undefined || expected === undefined) return false;
  if (Array.isArray(expected)) return Array.isArray(actual)
    && actual.length === expected.length
    && expected.every((entry, index) => equivalent(actual[index], entry));
  if (typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    const record = actual as Record<string, unknown>;
    return Object.entries(expected as Record<string, unknown>).every(([key, child]) => {
      const match = Object.keys(record).find((candidate) => normalizeKey(candidate) === normalizeKey(key));
      return Boolean(match) && equivalent(record[match!], child);
    });
  }
  if (typeof actual === "number" || typeof expected === "number") {
    const actualNumber = numericValue(actual);
    const expectedNumber = numericValue(expected);
    return actualNumber !== undefined && expectedNumber !== undefined && actualNumber === expectedNumber;
  }
  if (typeof actual === "boolean" || typeof expected === "boolean") return String(actual) === String(expected);
  const left = String(actual);
  const right = String(expected);
  if (left === right) return true;
  if (!ISO_DATE_TIME.test(left.trim()) || !ISO_DATE_TIME.test(right.trim())) return false;
  const leftDate = Date.parse(left);
  const rightDate = Date.parse(right);
  return Number.isFinite(leftDate) && Number.isFinite(rightDate) && leftDate === rightDate;
}

function recordsAtPath(value: unknown, path: readonly string[]): unknown[] {
  if (!path?.length) return [];
  if (Array.isArray(value)) return value.flatMap((entry) => recordsAtPath(entry, path));
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const match = Object.keys(record).find((key) => normalizeKey(key) === normalizeKey(path[0]!));
  if (!match) return [];
  const child = record[match];
  if (path.length === 1) return Array.isArray(child) ? child : [child];
  return recordsAtPath(child, path.slice(1));
}

function targetScope(value: unknown, targetPath: readonly string[] | undefined): unknown[] {
  if (targetPath?.length) return recordsAtPath(value, targetPath);
  return Array.isArray(value) ? value : [value];
}

function fieldValue(record: unknown, field: string): unknown {
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  const path = wirePath(field);
  return path.length > 0 ? pathValue(record, path) : undefined;
}

function targetRecords(value: unknown, target: unknown, targetField: string, targetPath: readonly string[] | undefined): unknown[] {
  return targetScope(value, targetPath).filter((record) => {
    const identity = fieldValue(record, targetField);
    return identity !== undefined && identity !== null && String(identity) === String(target);
  });
}

/** Canvas's own record of a deletion, as the read returns it. */
function deletedStateValue(data: unknown): boolean {
  return String(valueByKey(data, "workflow_state") ?? "") === "deleted"
    || valueByKey(data, "deleted") === true
    || valueByKey(data, "archived") === true;
}

function verification(
  status: BrowserVerification["status"],
  plan: BrowserReadbackPlan,
  evidence: string,
): BrowserVerification {
  return {
    schema: "morrow.browser-verification.v1",
    status,
    strategy: plan.strategy,
    readTool: plan.readOperation.toolName,
    evidence,
  };
}

export function evaluateBrowserReadback(
  plan: BrowserReadbackPlan | null | undefined,
  readResult: BrowserReadbackResult | null | undefined,
): BrowserVerification {
  if (!plan || !readResult) return { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "readback_unavailable" };
  const absent = readResult.ok === false && [404, 410].includes(Number(readResult.status));
  if (["deleted-resource", "deleted-or-archived-resource"].includes(plan.strategy) && absent) {
    return verification("verified", plan, "fresh_readback_absent");
  }
  // Canvas deletes some records softly: the read still answers, and the record
  // carries the deleted state itself. A record that comes back without that
  // state proves nothing here, and the plan's listing settles it.
  if (plan.strategy === "deleted-resource" && readResult.ok === true) {
    return deletedStateValue(readResult.data)
      ? verification("verified", plan, "fresh_readback_deleted_state")
      : verification("unconfirmed", plan, "resource_still_returned");
  }
  if (readResult.ok !== true) {
    return verification("unconfirmed", plan, `fresh_readback_http_${Number(readResult.status || 0)}`);
  }
  if (plan.strategy === "collection-empty") {
    if (readResult.truncated === true) return verification("unconfirmed", plan, "collection_readback_incomplete");
    if (!Array.isArray(readResult.data)) return verification("unconfirmed", plan, "collection_readback_shape_invalid");
    return readResult.data.length === 0
      ? verification("verified", plan, "fresh_collection_empty")
      : verification("mismatch", plan, "collection_not_empty");
  }
  if (plan.strategy === "deleted-or-archived-resource") {
    const archived = valueByKey(readResult.data, "archived") ?? valueByKey(readResult.data, "deleted");
    return archived === true
      ? verification("verified", plan, "fresh_readback_archived")
      : verification("mismatch", plan, "resource_remains_active");
  }
  if (plan.strategy === "collection-order") {
    if (readResult.truncated === true) return verification("unconfirmed", plan, "collection_readback_incomplete");
    if (!Array.isArray(readResult.data) || !plan.orderedTargets?.length) return verification("unconfirmed", plan, "collection_readback_shape_invalid");
    const wanted = new Set(plan.orderedTargets);
    const listed = readResult.data.map((record) => String(fieldValue(record, plan.targetField || "id") ?? "")).filter((id) => wanted.has(id));
    return listed.length === plan.orderedTargets.length && listed.every((id, index) => id === plan.orderedTargets![index])
      ? verification("verified", plan, "fresh_listing_matches_requested_order")
      : verification("mismatch", plan, "listing_order_differs");
  }
  if (!plan.targetId && (plan.assertions || []).length === 0) {
    return verification("unconfirmed", plan, "no_exact_postcondition");
  }
  // A change that applies to every record in a listing is proved only by the complete listing, with
  // every record carrying the requested state.
  if (plan.strategy === "collection-every-record") {
    if (readResult.truncated === true) return verification("unconfirmed", plan, "collection_readback_incomplete");
    const records = targetScope(readResult.data, plan.targetPath);
    if (!Array.isArray(readResult.data) && !plan.targetPath?.length) return verification("unconfirmed", plan, "collection_readback_shape_invalid");
    for (const record of records) {
      for (const assertion of plan.assertions || []) {
        const values = assertedValues(record, assertion.paths);
        if (values.length === 0) return verification("unconfirmed", plan, "requested_fields_not_returned");
        if (!values.some((value) => equivalent(value, assertion.expected))) {
          return verification("mismatch", plan, `requested_field_mismatch:${assertion.inputName}`);
        }
      }
    }
    return verification("verified", plan, "fresh_every_record_matches_requested_postcondition");
  }
  if (["collection-contains-target", "collection-omits-target"].includes(plan.strategy) && readResult.truncated === true) {
    return verification("unconfirmed", plan, "collection_readback_incomplete");
  }
  if (["collection-contains-target", "collection-omits-target"].includes(plan.strategy) && !plan.targetId) {
    return verification("unconfirmed", plan, "collection_target_unresolved");
  }
  const targetField = plan.targetField || "id";
  if (plan.strategy === "collection-omits-target") {
    const scope = targetScope(readResult.data, plan.targetPath);
    if (scope.length > 0 && !scope.some((record) => fieldValue(record, targetField) !== undefined)) {
      return verification("unconfirmed", plan, "readback_records_lack_target_field");
    }
    return targetRecords(readResult.data, plan.targetId, targetField, plan.targetPath).length === 0
      ? verification("verified", plan, "fresh_collection_omits_target")
      : verification("mismatch", plan, "target_still_present");
  }
  const records = plan.targetId ? targetRecords(readResult.data, plan.targetId, targetField, plan.targetPath) : [readResult.data];
  if (plan.targetId && records.length === 0) return verification("mismatch", plan, "target_missing_from_readback");
  if (plan.targetId && records.length > 1) return verification("mismatch", plan, "target_ambiguous_in_readback");
  const record = records[0];
  for (const assertion of plan.assertions || []) {
    const values = assertedValues(record, assertion.paths);
    if (values.length === 0) return verification("unconfirmed", plan, "requested_fields_not_returned");
    if (!values.some((value) => equivalent(value, assertion.expected))) {
      return verification("mismatch", plan, `requested_field_mismatch:${assertion.inputName}`);
    }
  }
  return verification("verified", plan, "fresh_readback_matches_requested_postcondition");
}

/** True when one record carries every requested field value the write asked for. */
export function matchesReadbackAssertions(
  record: unknown,
  assertions: readonly BrowserReadbackAssertion[],
): boolean {
  return assertions.every((assertion) => {
    const values = assertedValues(record, assertion.paths);
    return values.length > 0 && values.some((value) => equivalent(value, assertion.expected));
  });
}

/** Reads one named field from one record using the readback name comparison. */
export function readbackFieldValue(record: unknown, field: string): unknown {
  return fieldValue(record, field);
}

export interface CanvasRecoveryRead {
  readonly readTool: string;
  readonly readOperationKey?: string;
  readonly arguments: Readonly<Record<string, string | readonly string[]>>;
}

export interface CanvasRecoveryDescriptor {
  readonly schema: "morrow.canvas-recovery-descriptor.v1";
  readonly strategy: string;
  readonly writeMethod: string;
  readonly assertions: readonly BrowserReadbackAssertion[];
  readonly preconditionSnapshotSha256?: string;
  readonly hashedAssertions?: readonly {
    readonly paths: readonly (readonly string[])[];
    readonly expectedSha256: string;
  }[];
  readonly read?: CanvasRecoveryRead & {
    readonly targetId?: string;
    readonly targetField?: string;
    readonly targetPath?: readonly string[];
  };
  readonly collection?: CanvasRecoveryRead;
  readonly newQuizLifecycle?: {
    readonly kind: "create" | "delete";
    readonly beforeIds: readonly string[];
    readonly targetId?: string;
    readonly requestedQuiz?: Readonly<Record<string, unknown>>;
    readonly getTool?: string;
  };
}

// A retained descriptor is a route plus its id arguments plus the exact field
// values the reviewer already approved. Anything larger than one short field,
// such as a page body, a discussion message, or a long free-text answer, is not retained,
// and the whole descriptor is dropped rather than silently weakened, because an
// unchecked assertion would let a later re-check report a postcondition it never
// proved.
const MAX_RETAINED_VALUE_LENGTH = 200;
const MAX_RETAINED_VALUE_COUNT = 50;

function retainableValue(value: unknown): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "number") return true;
  if (typeof value === "string") return value.length <= MAX_RETAINED_VALUE_LENGTH;
  return Array.isArray(value)
    && value.length <= MAX_RETAINED_VALUE_COUNT
    && value.every((entry) => retainableValue(entry));
}

function retainableRead(read: CanvasRecoveryRead | undefined): boolean {
  return !read || Object.values(read.arguments).every((value) => retainableValue(value));
}

function recoveryRead(
  operation: CanvasReadbackOperation | undefined,
  argumentsValue: Readonly<Record<string, string | readonly string[]>> | null,
): CanvasRecoveryRead | undefined {
  if (!operation || !argumentsValue) return undefined;
  return {
    readTool: operation.toolName,
    ...(operation.key ? { readOperationKey: operation.key } : {}),
    arguments: argumentsValue,
  };
}

/**
 * Plans the read-only comparator Morrow keeps with an operation record so an
 * unresolved Canvas write can be checked later without ever resending it.
 * `writeData` is absent when the write outcome is unknown; the descriptor then
 * carries only the reads that can be addressed from the approved arguments.
 */
export function planCanvasRecoveryDescriptor(
  operations: readonly CanvasReadbackOperation[],
  write: CanvasReadbackOperation | null | undefined,
  args: Readonly<Record<string, unknown>> | undefined,
  writeData: unknown,
): CanvasRecoveryDescriptor | null {
  if (!write || write.readOnly) return null;
  if (canvasReadbackBlocker(write)) return null;
  const plan = planBrowserReadback(operations, write, args, writeData);
  const override = EXACT_READBACKS[write.nickname];
  // A POST can land more than once through the browser transport, so the parent
  // collection is retained as well. It is the only read that can show a second
  // created record.
  const collectionOperation = write.method === "POST" ? exactRead(operations, write) : undefined;
  const collection = recoveryRead(
    collectionOperation,
    collectionOperation ? readArguments(collectionOperation, args, undefined, undefined, writeData) : null,
  );
  const assertions = plan ? plan.assertions : requestedAssertions(write, args, override?.ignoredAssertions, override?.bodyAssertions);
  if (!plan && !collection) return null;
  if (assertions.length === 0 && !plan?.targetId) return null;
  if (!assertions.every((assertion) => retainableValue(assertion.expected))) return null;
  const read = plan
    ? {
        ...recoveryRead(plan.readOperation, plan.arguments)!,
        ...(plan.targetId === undefined ? {} : { targetId: plan.targetId }),
        ...(plan.targetField === undefined ? {} : { targetField: plan.targetField }),
        ...(plan.targetPath === undefined ? {} : { targetPath: plan.targetPath }),
      }
    : undefined;
  if (!retainableRead(read) || !retainableRead(collection)) return null;
  if (read?.targetId !== undefined && !retainableValue(read.targetId)) return null;
  return {
    schema: "morrow.canvas-recovery-descriptor.v1",
    strategy: plan?.strategy || (write.method === "POST" ? "created-resource" : "updated-resource"),
    writeMethod: write.method,
    assertions,
    ...(read ? { read } : {}),
    ...(collection ? { collection } : {}),
  };
}
