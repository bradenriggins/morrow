/**
 * How long one reading stays usable. The connector reads the object immediately before it sends the
 * change, so anything older belongs to an earlier attempt and has to be read again.
 */
export const CANVAS_SEMANTIC_RESOLUTION_MAX_AGE_MS = 60_000;
const RESOLUTION_CLOCK_TOLERANCE_MS = 1_000;
const SECTION_TARGET = Object.freeze({
    object: "section",
    objectParameter: "id",
    resolverRead: "canvas_get_section_information_sections",
    courseField: "course_id",
    courseCollectionRead: "canvas_list_course_sections",
});
/**
 * A Canvas group can belong to a course, to an account, or to a person who made it themselves, and
 * a course group set can hold groups from another course's set. So the group read has to say both
 * that a course owns this group and which course, and the selected course has to list the group as
 * its own before anything is sent.
 */
const GROUP_TARGET = Object.freeze({
    object: "group",
    objectParameter: "group_id",
    resolverRead: "canvas_get_single_group",
    courseField: "course_id",
    courseCollectionRead: "canvas_list_groups_available_in_context_courses",
    contextField: "context_type",
    contextValue: "Course",
    courseCollectionProof: true,
});
/**
 * A Canvas file can hang from a course, an account, a group, or one person, and the file route says
 * nothing about which. So the file read has to name a course as its owner and name the selected
 * course, and that course's own complete list of files has to hold the file, before anything is
 * sent. The saved version is frozen with it: a rename or a move never rewrites the bytes, so the
 * size and type that come back after the change have to be the ones that went in.
 *
 * Canvas answers a name clash in the destination folder by overwriting the file that is already
 * there unless it is told otherwise, and that would remove a file nobody asked to remove, so Morrow
 * sends a file change only with the instruction that keeps both files.
 */
const FILE_TARGET = Object.freeze({
    object: "file",
    objectParameter: "id",
    resolverRead: "canvas_get_file_files",
    courseField: "context_id",
    courseCollectionRead: "canvas_list_files_courses",
    contextField: "context_type",
    contextValue: "Course",
    courseCollectionProof: true,
    versionFields: Object.freeze(["id", "updated_at", "size", "content-type"]),
    versionTimestampField: "updated_at",
    destinationParameter: "parent_folder_id",
    destinationCollectionRead: "canvas_list_all_folders_courses",
    requiredInputs: Object.freeze({ on_duplicate: "rename" }),
    readbackFields: Object.freeze({ name: "display_name", parent_folder_id: "folder_id" }),
    unsavedInputs: Object.freeze(["on_duplicate"]),
});
/**
 * A Canvas folder carries the same owner fields as a file and is proved the same way. Only the
 * route that creates a folder inside a proved folder is admitted, so the proved object is the parent
 * and the new folder is read back through its own route, where it names that parent again.
 */
const FOLDER_TARGET = Object.freeze({
    object: "folder",
    objectParameter: "folder_id",
    readParameter: "id",
    resolverRead: "canvas_get_folder_folders",
    courseField: "context_id",
    courseCollectionRead: "canvas_list_all_folders_courses",
    contextField: "context_type",
    contextValue: "Course",
    courseCollectionProof: true,
    versionFields: Object.freeze(["id", "updated_at"]),
    versionTimestampField: "updated_at",
    // The route already names the parent folder Morrow proved, so a second parent in the body would
    // put the new folder somewhere else. A folder path names a place Morrow cannot read back to one
    // course at all. A change that carries either one is refused.
    refusedParameters: Object.freeze(["parent_folder_id", "parent_folder_path"]),
    childParentField: "parent_folder_id",
});
/**
 * A Canvas calendar event belongs to whatever calendar its context code names: a course, a group, a
 * person, or an account. So the event read has to name the selected course's own calendar before a
 * change is sent, and the context code a change carries has to name that same course, because that
 * input moves the event to another calendar.
 *
 * Morrow sends one event and reads that one event back, so the inputs that make Canvas repeat the
 * event, copy it, or apply the change to a whole series are refused, and so are the section-level
 * times, which land in child events this reading does not prove.
 */
const CALENDAR_EVENT_CALENDAR = Object.freeze({
    object: "calendar event",
    readParameter: "id",
    resolverRead: "canvas_get_single_calendar_event_or_assignment",
    courseField: "context_code",
    courseFieldShape: "context_code",
    courseCodeParameter: "calendar_event_context_code",
    courseCollectionRead: "canvas_list_calendar_events",
    courseCollectionParameter: "context_codes",
    // Canvas returns one day of a calendar unless it is asked for the whole of it. A deletion is
    // proved against the course's whole calendar or against nothing.
    courseCollectionArguments: Object.freeze({ all_events: "true" }),
    refusedParameters: Object.freeze([
        "calendar_event_child_event_data_x_context_code",
        "calendar_event_child_event_data_x_start_at",
        "calendar_event_child_event_data_x_end_at",
    ]),
    seriesParameters: Object.freeze([
        "calendar_event_duplicate_append_iterator",
        "calendar_event_duplicate_count",
        "calendar_event_duplicate_frequency",
        "calendar_event_duplicate_interval",
        "calendar_event_rrule",
        "which",
    ]),
});
const CALENDAR_EVENT_TARGET = Object.freeze({
    ...CALENDAR_EVENT_CALENDAR,
    objectParameter: "id",
});
const CALENDAR_EVENT_CREATE_TARGET = Object.freeze({
    ...CALENDAR_EVENT_CALENDAR,
    createsObject: true,
});
/**
 * A Canvas appointment group is a sign-up sheet that can serve several courses at once, and its own
 * reading is the only thing that says which. Morrow changes one course, so a group that lists more
 * than one context is refused outright rather than changed for the other courses too, and the sub
 * contexts that narrow a group to particular sections or to a group set are not sent: a reading of
 * the group does not prove they belong to the selected course.
 */
const APPOINTMENT_GROUP_TARGET = Object.freeze({
    object: "appointment group",
    objectParameter: "id",
    resolverRead: "canvas_get_single_appointment_group",
    courseField: "context_codes",
    courseFieldShape: "context_code_list",
    courseCodeParameter: "appointment_group_context_codes",
    courseCollectionRead: "canvas_list_appointment_groups",
    courseCollectionParameter: "context_codes",
    courseCollectionArguments: Object.freeze({ scope: "manageable" }),
    refusedParameters: Object.freeze(["appointment_group_sub_context_codes"]),
});
// The two section routes that change the section itself, the group routes that change a group's own
// discussion topics and pages, and the file and folder routes that rename, move, remove, or add one
// object inside the selected course's own files, the routes that add, change, or remove one event on
// the selected course's calendar, and the route that changes an appointment group that serves that
// course alone. Every route under a section or a group that carries a person's own record stays
// held: canvasLearnerScopeObjectRoute and the learner routes in operation-admission.ts name them,
// and a booked time slot is one of them. Copying a file or a folder stays held as well: the copy
// lands in a second object that this reading does not prove.
const SEMANTIC_COURSE_TARGETS = Object.freeze({
    "PUT /v1/sections/{id}#edit_section": SECTION_TARGET,
    "DELETE /v1/sections/{id}#delete_section": SECTION_TARGET,
    "POST /v1/groups/{group_id}/discussion_topics#create_new_discussion_topic_groups": GROUP_TARGET,
    "PUT /v1/groups/{group_id}/discussion_topics/{topic_id}#update_topic_groups": GROUP_TARGET,
    "DELETE /v1/groups/{group_id}/discussion_topics/{topic_id}#delete_topic_groups": GROUP_TARGET,
    "POST /v1/groups/{group_id}/pages#create_page_groups": GROUP_TARGET,
    "PUT /v1/groups/{group_id}/pages/{url_or_id}#update_create_page_groups": GROUP_TARGET,
    "DELETE /v1/groups/{group_id}/pages/{url_or_id}#delete_page_groups": GROUP_TARGET,
    "PUT /v1/groups/{group_id}/front_page#update_create_front_page_groups": GROUP_TARGET,
    "PUT /v1/files/{id}#update_file": FILE_TARGET,
    "DELETE /v1/files/{id}#delete_file": FILE_TARGET,
    "POST /v1/folders/{folder_id}/folders#create_folder_folders": FOLDER_TARGET,
    "POST /v1/calendar_events#create_calendar_event": CALENDAR_EVENT_CREATE_TARGET,
    "PUT /v1/calendar_events/{id}#update_calendar_event": CALENDAR_EVENT_TARGET,
    "DELETE /v1/calendar_events/{id}#delete_calendar_event": CALENDAR_EVENT_TARGET,
    "PUT /v1/appointment_groups/{id}#update_appointment_group": APPOINTMENT_GROUP_TARGET,
});
const LEARNER_STATE_SEGMENTS = Object.freeze([
    "submissions",
    "anonymous_submissions",
    "enrollments",
    "peer_reviews",
    "grades",
    "override",
    "overrides",
]);
export function canvasSemanticCourseTarget(operation) {
    if (!operation?.key || operation.readOnly === true)
        return undefined;
    return SEMANTIC_COURSE_TARGETS[operation.key];
}
/**
 * A route under one object that names a learner's own submission, grade, enrollment or assignment
 * override. Those need their own authority, not the course binding this framework proves.
 */
export function canvasLearnerScopeObjectRoute(operation) {
    const path = String(operation?.path || "");
    if (!/^\/v1\/sections\/\{[^}]+\}\/./.test(path))
        return false;
    return path.split("/").some((segment) => LEARNER_STATE_SEGMENTS.includes(segment));
}
function exactId(value) {
    return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value);
}
/** The way Canvas names one course's calendar. */
export function canvasCourseContextCode(courseId) {
    return exactId(courseId) ? `course_${courseId}` : "";
}
/** The course a Canvas context code names, or an empty string when it names anything else. */
export function canvasContextCodeCourseId(value) {
    const match = typeof value === "string" ? value.match(/^course_([1-9][0-9]{0,18})$/) : null;
    return match ? match[1] : "";
}
/** The one reason Morrow refuses an object outright rather than asking for a better reading. */
export const CANVAS_MULTI_CONTEXT_REFUSAL = "multi_context_object_not_supported";
function namedValue(value) {
    return value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0);
}
/**
 * Checks one frozen reading against the change it is meant to prove. Every enforcement layer calls
 * this before the change is sent; without a reading that names this exact object and the selected
 * course, the change stays held.
 */
export function canvasSemanticResolutionProblem(target, resolution, expected) {
    if (!target)
        return "canvas_semantic_target_course_mismatch";
    if (!exactId(expected.objectId) || !exactId(expected.courseId))
        return "canvas_semantic_target_course_mismatch";
    if (!resolution || typeof resolution !== "object" || Array.isArray(resolution)) {
        return "canvas_semantic_target_course_mismatch";
    }
    const proof = resolution;
    if (proof.resolverTool !== target.resolverRead)
        return "canvas_semantic_target_course_mismatch";
    if (!exactId(proof.objectId) || proof.objectId !== expected.objectId)
        return "canvas_semantic_target_course_mismatch";
    if (!exactId(proof.courseId) || proof.courseId !== expected.courseId)
        return "canvas_semantic_target_course_mismatch";
    if (typeof proof.snapshotDigest !== "string" || !/^[0-9a-f]{64}$/.test(proof.snapshotDigest)) {
        return "canvas_semantic_target_course_mismatch";
    }
    // An object whose saved version is declared has to arrive with one: it is what the reading after
    // the change is compared against.
    if (target.versionFields?.length) {
        const version = proof.objectVersion;
        if (!version || typeof version !== "object" || Array.isArray(version)
            || idText(version.id) !== expected.objectId) {
            return "canvas_semantic_target_course_mismatch";
        }
    }
    // Where the change lands is proved the same way the object is, so the reading names the exact
    // destination this change asks for, and names none when the change asks for none.
    if ((proof.destinationId ?? "") !== (expected.destinationId ?? ""))
        return "canvas_semantic_target_course_mismatch";
    const resolvedAt = typeof proof.resolvedAt === "string" ? Date.parse(proof.resolvedAt) : Number.NaN;
    if (!Number.isFinite(resolvedAt))
        return "canvas_semantic_target_resolution_stale";
    if (resolvedAt > expected.now + RESOLUTION_CLOCK_TOLERANCE_MS)
        return "canvas_semantic_target_resolution_stale";
    if (expected.now - resolvedAt > CANVAS_SEMANTIC_RESOLUTION_MAX_AGE_MS)
        return "canvas_semantic_target_resolution_stale";
    return undefined;
}
function idText(value) {
    return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
}
const UNPROVED_CONTEXT = Object.freeze({ state: "unproved" });
const MULTI_CONTEXT = Object.freeze({ state: "multi_context" });
function courseOfContextCode(value) {
    const courseId = canvasContextCodeCourseId(value);
    return courseId ? Object.freeze({ state: "course", courseId }) : UNPROVED_CONTEXT;
}
function courseOfField(target, value) {
    if (target.courseFieldShape === "context_code_list") {
        if (!Array.isArray(value) || value.length === 0)
            return UNPROVED_CONTEXT;
        return value.length > 1 ? MULTI_CONTEXT : courseOfContextCode(value[0]);
    }
    if (target.courseFieldShape === "context_code")
        return courseOfContextCode(value);
    const courseText = idText(value);
    return exactId(courseText) ? Object.freeze({ state: "course", courseId: courseText }) : UNPROVED_CONTEXT;
}
export function canvasSemanticObjectContext(target, read, objectId) {
    if (!target)
        return UNPROVED_CONTEXT;
    const values = objectRecord(read);
    if (!values)
        return UNPROVED_CONTEXT;
    // Canvas names the kind of owner separately from the owner's id. A group a person made for
    // themselves, or one an account owns, is refused here even when the reading also carries a course.
    if (target.contextField && values[target.contextField] !== target.contextValue)
        return UNPROVED_CONTEXT;
    const identityText = idText(values.id);
    if (!exactId(identityText) || identityText !== objectId)
        return UNPROVED_CONTEXT;
    return courseOfField(target, values[target.courseField]);
}
/** The course this reading proves, or an empty string when the reading proves nothing. */
export function canvasSemanticResolvedCourseId(target, read, objectId) {
    const context = canvasSemanticObjectContext(target, read, objectId);
    return context.state === "course" ? context.courseId : "";
}
export function canvasSemanticContextInputState(target, args, courseId) {
    if (!target?.courseCodeParameter)
        return "absent";
    const value = args?.[target.courseCodeParameter];
    if (!namedValue(value))
        return "absent";
    if (Array.isArray(value) && value.length > 1)
        return "multi_context";
    const named = Array.isArray(value) ? value[0] : value;
    const code = canvasCourseContextCode(courseId);
    return code && named === code ? "selected_course" : "other_context";
}
/**
 * True when the change carries an input that reaches further than the one object Morrow reads back:
 * a repeat rule, a duplicate count, or a choice that applies the change to a whole series.
 */
export function canvasSemanticSeriesInput(target, args) {
    return (target?.seriesParameters || []).some((name) => namedValue(args?.[name]));
}
/**
 * The arguments that make the selected course's own listing return that course's whole set. A
 * listing Canvas keys by course id takes the id; one it keys by calendar takes that calendar's
 * context code.
 */
export function canvasSemanticCourseCollectionArguments(target, courseId) {
    if (!target || !exactId(courseId))
        return {};
    if (!target.courseCollectionParameter)
        return { course_id: courseId };
    return {
        [target.courseCollectionParameter]: [canvasCourseContextCode(courseId)],
        ...(target.courseCollectionArguments || {}),
    };
}
function objectRecord(read) {
    if (read?.ok !== true || read.truncated === true)
        return undefined;
    const record = read.data;
    if (!record || typeof record !== "object" || Array.isArray(record))
        return undefined;
    return record;
}
/**
 * The saved version this reading found: the fields that say which stored copy of the object it is.
 * The connector freezes it beside the course proof and compares it with the reading it takes after
 * the change.
 */
export function canvasSemanticObjectVersion(target, read, objectId) {
    if (!target?.versionFields?.length || !exactId(objectId))
        return undefined;
    const values = objectRecord(read);
    if (!values || idText(values.id) !== objectId)
        return undefined;
    const version = {};
    for (const field of target.versionFields) {
        const value = field === "id" ? idText(values.id) : values[field];
        if (value !== undefined)
            version[field] = value;
    }
    return Object.freeze(version);
}
export function canvasSemanticVersionState(target, version, read, objectId) {
    if (!target || !version || typeof version !== "object" || Array.isArray(version))
        return "unreadable";
    const values = objectRecord(read);
    if (!values || !exactId(objectId))
        return "unreadable";
    if (idText(values.id) !== objectId)
        return "changed";
    for (const [field, frozen] of Object.entries(version)) {
        const actual = field === "id" ? idText(values.id) : values[field];
        if (actual === undefined)
            return "unreadable";
        if (field === target.versionTimestampField) {
            const frozenAt = Date.parse(String(frozen));
            const readAt = Date.parse(String(actual));
            if (!Number.isFinite(frozenAt) || !Number.isFinite(readAt))
                return "unreadable";
            if (readAt < frozenAt)
                return "changed";
            continue;
        }
        if (actual !== frozen)
            return "changed";
    }
    return "same_object";
}
export function canvasSemanticCourseCollectionState(target, read, objectId, courseId = "") {
    if (!target || !exactId(objectId) || read?.ok !== true || read.truncated === true || !Array.isArray(read.data))
        return "unreadable";
    // A listing Canvas keys by calendar carries that calendar on every entry. An entry from another
    // calendar means Canvas did not narrow the listing to the selected course, so the listing is not
    // that course's own and proves nothing about what it holds.
    if (exactId(courseId) && target.courseFieldShape && target.courseFieldShape !== "id") {
        const narrowed = read.data.every((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry))
                return false;
            const context = courseOfField(target, entry[target.courseField]);
            return context.state === "course" && context.courseId === courseId;
        });
        if (!narrowed)
            return "unreadable";
    }
    const listed = read.data.some((entry) => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
        && idText(entry.id) === objectId);
    return listed ? "listed" : "absent";
}
