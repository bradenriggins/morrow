const BLOCKED_READBACKS = Object.freeze({
    bulk_select_provisional_grades: "student_grade_or_submission_state",
    clear_unread_status_for_all_submissions_courses: "student_grade_or_submission_state",
    delete_entry_courses: "discussion_or_conversation_content",
    delete_feedback_on_conversation_message: "discussion_or_conversation_content",
    delete_single_rubric_assessment: "student_grade_or_submission_state",
    delete_submission_comment: "student_grade_or_submission_state",
    disable_summary_courses: "summary_state_has_no_narrow_reader",
    edit_external_tool_courses: "external_tool_update_has_no_cataloged_fields",
    add_course_to_favorites: "favorite_list_is_effective_not_explicit_state",
    mark_all_topic_as_read_courses: "discussion_or_conversation_content",
    mark_module_item_as_done_not_done: "module_item_reader_mutates_progress",
    mark_submission_as_read_courses: "student_grade_or_submission_state",
    mark_submission_as_unread_courses: "student_grade_or_submission_state",
    mark_submission_item_as_read_courses: "student_grade_or_submission_state",
    mark_topic_as_read_courses: "discussion_or_conversation_content",
    mark_topic_as_unread_courses: "discussion_or_conversation_content",
    re_lock_module_progressions: "module_progression_state_has_no_current_user_reader",
    remove_course_from_favorites: "favorite_list_is_effective_not_explicit_state",
    reset_what_if_scores_for_current_user_for_entire_course_and_recalculate_grades: "student_grade_or_submission_state",
    select_provisional_grade: "student_grade_or_submission_state",
    subscribe_to_topic_courses: "discussion_or_conversation_content",
    unsubscribe_from_topic_courses: "discussion_or_conversation_content",
    update_content_migration_courses: "content_migration_update_has_no_cataloged_fields",
});
export function canvasReadbackBlocker(operation) {
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
]);
export function hasNamedCanvasReadback(operation) {
    return NAMED_CANVAS_READBACKS.some((candidate) => candidate.toolName === operation?.toolName && candidate.key === operation?.key);
}
const EXACT_READBACKS = Object.freeze({
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
        targetField: "id",
        strategy: "collection-omits-target",
    },
});
function normalizedPath(value) {
    return String(value || "").replace(/\{[^}]+\}/g, "{}");
}
function wirePath(value) {
    return String(value || "").match(/[^\[\].]+/g) || [];
}
function normalizeKey(value) {
    return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}
function valueByKey(value, key, depth = 0) {
    if (depth > 12 || value === null || value === undefined)
        return undefined;
    if (Array.isArray(value)) {
        for (const entry of value) {
            const found = valueByKey(entry, key, depth + 1);
            if (found !== undefined)
                return found;
        }
        return undefined;
    }
    if (typeof value !== "object")
        return undefined;
    const wanted = normalizeKey(key);
    for (const [name, child] of Object.entries(value)) {
        if (normalizeKey(name) === wanted && child !== undefined)
            return child;
    }
    for (const child of Object.values(value)) {
        const found = valueByKey(child, key, depth + 1);
        if (found !== undefined)
            return found;
    }
    return undefined;
}
function readArguments(read, writeArguments, dynamic = {}, fixedArguments = {}, writeData) {
    const output = {};
    for (const parameter of read.parameters || []) {
        if (parameter.location !== "path")
            continue;
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
        if (value === undefined || value === null || value === "")
            return null;
        output[parameter.inputName] = String(value);
    }
    for (const [inputName, value] of Object.entries(fixedArguments)) {
        if (!(read.parameters || []).some((parameter) => parameter.inputName === inputName))
            return null;
        output[inputName] = value;
    }
    return output;
}
function exactRead(operations, write) {
    return operations.find((candidate) => candidate.readOnly && candidate.service === write.service && normalizedPath(candidate.path) === normalizedPath(write.path));
}
function childRead(operations, write) {
    const prefix = `${normalizedPath(write.path).replace(/\/$/, "")}/{}`;
    return operations.find((candidate) => candidate.readOnly && candidate.service === write.service && normalizedPath(candidate.path) === prefix);
}
function collectionRead(operations, write) {
    const segments = write.path.split("/").filter(Boolean);
    for (let count = segments.length; count >= 2; count -= 1) {
        const path = normalizedPath(`/${segments.slice(0, count).join("/")}`);
        const read = operations.find((candidate) => candidate.readOnly && candidate.service === write.service && normalizedPath(candidate.path) === path);
        if (read)
            return read;
    }
    return undefined;
}
function normalizedRoute(value) {
    return normalizedPath(value).replace(/\/$/, "");
}
function readsWriteTargetResource(write, read) {
    const target = normalizedRoute(write.path);
    const candidate = normalizedRoute(read.path);
    return candidate === target || candidate === `${target}/{}` || `${candidate}/{}` === target;
}
function requestedAssertions(write, args, ignored = [], bodies = []) {
    return (write.parameters || []).flatMap((parameter) => {
        if (parameter.location === "path" || ignored.includes(parameter.inputName))
            return [];
        const expected = args?.[parameter.inputName];
        if (expected === undefined)
            return [];
        const full = wirePath(parameter.wireName);
        const wrapped = full.length > 1 ? [full, full.slice(1)] : [full];
        const paths = bodies.includes(parameter.inputName) ? [...wrapped, []] : wrapped;
        return [{ inputName: parameter.inputName, paths, expected }];
    });
}
function responseAssertions(names, writeData) {
    return (names || []).flatMap((inputName) => {
        const expected = valueByKey(writeData, inputName);
        if (expected === undefined)
            return [];
        const full = wirePath(inputName);
        return [{ inputName, paths: [full], expected }];
    });
}
function fixedAssertions(values) {
    return Object.entries(values || {}).map(([inputName, expected]) => ({
        inputName,
        paths: [wirePath(inputName)],
        expected,
    }));
}
export function planBrowserReadback(operations, write, args, writeData) {
    if (!write || write.readOnly)
        return null;
    if (canvasReadbackBlocker(write))
        return null;
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
    if (!read)
        return null;
    // A generic read only proves this write when it addresses the written resource itself, the child
    // route the write creates, or the collection that holds the written item. Any other route reports
    // the state of a different object. Hand-written EXACT_READBACKS entries and the named Canvas
    // readbacks carry their own reviewed route and evaluator.
    if (!override && !hasNamedCanvasReadback(write) && !readsWriteTargetResource(write, read))
        return null;
    const argumentsValue = readArguments(read, args, override?.dynamic, override?.fixedArguments, writeData);
    if (!argumentsValue)
        return null;
    const targetId = override?.targetArgument
        ? args?.[override.targetArgument]
        : override?.targetResponse
            ? valueByKey(writeData, override.targetResponse)
            : write.method === "POST"
                ? valueByKey(writeData, "id")
                : undefined;
    const targetField = targetId === undefined || targetId === null ? undefined : override?.targetField || "id";
    return {
        schema: "morrow.browser-readback-plan.v1",
        strategy: strategy || "updated-resource",
        readOperation: read,
        arguments: argumentsValue,
        assertions: [
            ...requestedAssertions(write, args, override?.ignoredAssertions, override?.bodyAssertions),
            ...responseAssertions(override?.responseAssertions, writeData),
            ...fixedAssertions(override?.fixedAssertions),
        ],
        ...(targetId === undefined || targetId === null ? {} : { targetId: String(targetId) }),
        ...(targetField ? { targetField } : {}),
        ...(override?.targetPath?.length ? { targetPath: override.targetPath } : {}),
    };
}
function pathValue(value, path) {
    let current = value;
    for (const part of path) {
        if (!current || typeof current !== "object")
            return undefined;
        const record = current;
        const match = Object.keys(record).find((key) => normalizeKey(key) === normalizeKey(part));
        if (!match)
            return undefined;
        current = record[match];
    }
    return current;
}
function assertedValues(record, paths) {
    return (paths || []).map((path) => pathValue(record, path)).filter((value) => value !== undefined);
}
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const NUMBER_LITERAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
function numericValue(value) {
    if (typeof value === "number")
        return Number.isFinite(value) ? value : undefined;
    if (typeof value !== "string")
        return undefined;
    const text = value.trim();
    if (!NUMBER_LITERAL.test(text))
        return undefined;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function equivalent(actual, expected) {
    if (Object.is(actual, expected))
        return true;
    if (actual === null || expected === null || actual === undefined || expected === undefined)
        return false;
    if (Array.isArray(expected))
        return Array.isArray(actual)
            && actual.length === expected.length
            && expected.every((entry, index) => equivalent(actual[index], entry));
    if (typeof expected === "object") {
        if (!actual || typeof actual !== "object" || Array.isArray(actual))
            return false;
        const record = actual;
        return Object.entries(expected).every(([key, child]) => {
            const match = Object.keys(record).find((candidate) => normalizeKey(candidate) === normalizeKey(key));
            return Boolean(match) && equivalent(record[match], child);
        });
    }
    if (typeof actual === "number" || typeof expected === "number") {
        const actualNumber = numericValue(actual);
        const expectedNumber = numericValue(expected);
        return actualNumber !== undefined && expectedNumber !== undefined && actualNumber === expectedNumber;
    }
    if (typeof actual === "boolean" || typeof expected === "boolean")
        return String(actual) === String(expected);
    const left = String(actual);
    const right = String(expected);
    if (left === right)
        return true;
    if (!ISO_DATE_TIME.test(left.trim()) || !ISO_DATE_TIME.test(right.trim()))
        return false;
    const leftDate = Date.parse(left);
    const rightDate = Date.parse(right);
    return Number.isFinite(leftDate) && Number.isFinite(rightDate) && leftDate === rightDate;
}
function recordsAtPath(value, path) {
    if (!path?.length)
        return [];
    if (Array.isArray(value))
        return value.flatMap((entry) => recordsAtPath(entry, path));
    if (!value || typeof value !== "object")
        return [];
    const record = value;
    const match = Object.keys(record).find((key) => normalizeKey(key) === normalizeKey(path[0]));
    if (!match)
        return [];
    const child = record[match];
    if (path.length === 1)
        return Array.isArray(child) ? child : [child];
    return recordsAtPath(child, path.slice(1));
}
function targetScope(value, targetPath) {
    if (targetPath?.length)
        return recordsAtPath(value, targetPath);
    return Array.isArray(value) ? value : [value];
}
function fieldValue(record, field) {
    if (!record || typeof record !== "object" || Array.isArray(record))
        return undefined;
    return pathValue(record, [field]);
}
function targetRecords(value, target, targetField, targetPath) {
    return targetScope(value, targetPath).filter((record) => {
        const identity = fieldValue(record, targetField);
        return identity !== undefined && identity !== null && String(identity) === String(target);
    });
}
function verification(status, plan, evidence) {
    return {
        schema: "morrow.browser-verification.v1",
        status,
        strategy: plan.strategy,
        readTool: plan.readOperation.toolName,
        evidence,
    };
}
export function evaluateBrowserReadback(plan, readResult) {
    if (!plan || !readResult)
        return { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "readback_unavailable" };
    const absent = readResult.ok === false && [404, 410].includes(Number(readResult.status));
    if (["deleted-resource", "deleted-or-archived-resource"].includes(plan.strategy) && absent) {
        return verification("verified", plan, "fresh_readback_absent");
    }
    if (readResult.ok !== true) {
        return verification("unconfirmed", plan, `fresh_readback_http_${Number(readResult.status || 0)}`);
    }
    if (plan.strategy === "collection-empty") {
        if (readResult.truncated === true)
            return verification("unconfirmed", plan, "collection_readback_incomplete");
        if (!Array.isArray(readResult.data))
            return verification("unconfirmed", plan, "collection_readback_shape_invalid");
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
    if (!plan.targetId && (plan.assertions || []).length === 0) {
        return verification("unconfirmed", plan, "no_exact_postcondition");
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
    if (plan.targetId && records.length === 0)
        return verification("mismatch", plan, "target_missing_from_readback");
    if (plan.targetId && records.length > 1)
        return verification("mismatch", plan, "target_ambiguous_in_readback");
    const record = records[0];
    for (const assertion of plan.assertions || []) {
        const values = assertedValues(record, assertion.paths);
        if (values.length === 0)
            return verification("unconfirmed", plan, "requested_fields_not_returned");
        if (!values.some((value) => equivalent(value, assertion.expected))) {
            return verification("mismatch", plan, `requested_field_mismatch:${assertion.inputName}`);
        }
    }
    return verification("verified", plan, "fresh_readback_matches_requested_postcondition");
}
/** True when one record carries every requested field value the write asked for. */
export function matchesReadbackAssertions(record, assertions) {
    return assertions.every((assertion) => {
        const values = assertedValues(record, assertion.paths);
        return values.length > 0 && values.some((value) => equivalent(value, assertion.expected));
    });
}
/** Reads one named field from one record using the readback name comparison. */
export function readbackFieldValue(record, field) {
    return fieldValue(record, field);
}
// A retained descriptor is a route plus its id arguments plus the exact field
// values the reviewer already approved. Anything larger than one short field,
// such as a page body, a discussion message, or a long free-text answer, is not retained,
// and the whole descriptor is dropped rather than silently weakened, because an
// unchecked assertion would let a later re-check report a postcondition it never
// proved.
const MAX_RETAINED_VALUE_LENGTH = 200;
const MAX_RETAINED_VALUE_COUNT = 50;
function retainableValue(value) {
    if (value === null || typeof value === "boolean" || typeof value === "number")
        return true;
    if (typeof value === "string")
        return value.length <= MAX_RETAINED_VALUE_LENGTH;
    return Array.isArray(value)
        && value.length <= MAX_RETAINED_VALUE_COUNT
        && value.every((entry) => retainableValue(entry));
}
function retainableRead(read) {
    return !read || Object.values(read.arguments).every((value) => retainableValue(value));
}
function recoveryRead(operation, argumentsValue) {
    if (!operation || !argumentsValue)
        return undefined;
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
export function planCanvasRecoveryDescriptor(operations, write, args, writeData) {
    if (!write || write.readOnly)
        return null;
    if (canvasReadbackBlocker(write))
        return null;
    const plan = planBrowserReadback(operations, write, args, writeData);
    const override = EXACT_READBACKS[write.nickname];
    // A POST can land more than once through the browser transport, so the parent
    // collection is retained as well. It is the only read that can show a second
    // created record.
    const collectionOperation = write.method === "POST" ? exactRead(operations, write) : undefined;
    const collection = recoveryRead(collectionOperation, collectionOperation ? readArguments(collectionOperation, args, undefined, undefined, writeData) : null);
    const assertions = plan ? plan.assertions : requestedAssertions(write, args, override?.ignoredAssertions, override?.bodyAssertions);
    if (!plan && !collection)
        return null;
    if (assertions.length === 0 && !plan?.targetId)
        return null;
    if (!assertions.every((assertion) => retainableValue(assertion.expected)))
        return null;
    const read = plan
        ? {
            ...recoveryRead(plan.readOperation, plan.arguments),
            ...(plan.targetId === undefined ? {} : { targetId: plan.targetId }),
            ...(plan.targetField === undefined ? {} : { targetField: plan.targetField }),
            ...(plan.targetPath === undefined ? {} : { targetPath: plan.targetPath }),
        }
        : undefined;
    if (!retainableRead(read) || !retainableRead(collection))
        return null;
    if (read?.targetId !== undefined && !retainableValue(read.targetId))
        return null;
    return {
        schema: "morrow.canvas-recovery-descriptor.v1",
        strategy: plan?.strategy || (write.method === "POST" ? "created-resource" : "updated-resource"),
        writeMethod: write.method,
        assertions,
        ...(read ? { read } : {}),
        ...(collection ? { collection } : {}),
    };
}
