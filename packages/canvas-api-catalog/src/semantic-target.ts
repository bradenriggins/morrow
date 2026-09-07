export interface CanvasSemanticOperation {
  readonly toolName: string;
  readonly key?: string;
  readonly path: string;
  readonly readOnly?: boolean;
}

/**
 * A Canvas write whose route names an object instead of a course. The route alone proves nothing:
 * a section id belongs to whatever course Canvas says it belongs to, which may be any course on the
 * tenant. The catalog only declares how the object is bound to a course. The connector proves the
 * binding by reading the object in the bound tab immediately before it sends the one change, and
 * freezes that reading into the command record.
 */
export interface CanvasSemanticCourseTarget {
  /** Plain noun for the object the route names. */
  readonly object: "section" | "group" | "file" | "folder" | "calendar event" | "appointment group";
  /** Write input that carries the object id. A route that creates the object names no object yet. */
  readonly objectParameter?: string;
  /** Name the same object id carries in the read routes, when the write route names it differently. */
  readonly readParameter?: string;
  /** Read that returns the object together with the course that owns it. */
  readonly resolverRead: string;
  /** Field of the resolver response that must equal the selected course. */
  readonly courseField: string;
  /**
   * How that field names the course. Canvas names a calendar with a context code, "course_123",
   * instead of a plain id, and it gives an appointment group a list of those codes because one
   * appointment group can serve several courses at once.
   */
  readonly courseFieldShape?: "id" | "context_code" | "context_code_list";
  /**
   * Write input that names the calendar this change belongs to, as a Canvas context code. A route
   * that creates the object names no object id, so this input is the only thing that says where the
   * new object lands; on a route that changes an existing object the same input can move it to
   * another calendar, so Morrow sends it only when it names the selected course.
   */
  readonly courseCodeParameter?: string;
  /** True when the route creates the object, so there is no object to read before the change. */
  readonly createsObject?: boolean;
  /** The selected course's own listing of these objects. A deletion is proved against it. */
  readonly courseCollectionRead: string;
  /** The listing input that names the selected course, when the listing does not take a course id. */
  readonly courseCollectionParameter?: string;
  /** Inputs the listing needs beside the course to return that course's whole set. */
  readonly courseCollectionArguments?: Readonly<Record<string, string>>;
  /** Field that names what kind of thing owns the object, with the one value Morrow accepts. */
  readonly contextField?: string;
  readonly contextValue?: string;
  /**
   * True when the object read is not proof on its own: the object must also appear in the selected
   * course's own complete listing before the change is sent.
   */
  readonly courseCollectionProof?: boolean;
  /**
   * Fields that say which saved copy of the object the reading found. They are frozen before the
   * change and compared with the reading taken after it, so a change that lands on a different saved
   * copy is not reported as the change that was asked for.
   */
  readonly versionFields?: readonly string[];
  /** The one version field that says when the object was last saved. */
  readonly versionTimestampField?: string;
  /**
   * Write input that names where the object lands. Canvas can put a file or a folder in any folder
   * the signed-in person can reach, including a folder in another course, so a change that carries
   * this input is sent only after the destination is proved to belong to the selected course too.
   */
  readonly destinationParameter?: string;
  /** The selected course's own listing that must name the destination. */
  readonly destinationCollectionRead?: string;
  /**
   * Write inputs Morrow does not send: it cannot read them back to one course. A change that carries
   * one of them is refused before anything is sent.
   */
  readonly refusedParameters?: readonly string[];
  /**
   * Write inputs that make Canvas add or change more than the one object Morrow reads back: a repeat
   * rule, a duplicate count, or a choice that applies the change to a whole series. A change that
   * carries one of them is refused before anything is sent.
   */
  readonly seriesParameters?: readonly string[];
  /** Write inputs that are sent only with exactly this value. */
  readonly requiredInputs?: Readonly<Record<string, string>>;
  /** Write inputs the object's own reading answers under a different name. */
  readonly readbackFields?: Readonly<Record<string, string>>;
  /** Write inputs Canvas acts on without keeping them, so nothing later reads them back. */
  readonly unsavedInputs?: readonly string[];
  /** Field of a newly created object that names the object this change was proved against. */
  readonly childParentField?: string;
}

/** One reading of a semantic target, frozen before the change is sent. */
export interface CanvasSemanticResolutionProof {
  readonly objectId: string;
  readonly courseId: string;
  readonly resolverTool: string;
  readonly resolvedAt: string;
  readonly snapshotDigest: string;
  readonly objectVersion?: Readonly<Record<string, unknown>>;
  readonly destinationId?: string;
}

export type CanvasSemanticResolutionRefusal =
  | "canvas_semantic_target_course_mismatch"
  | "canvas_semantic_target_resolution_stale";

export interface CanvasSemanticResolutionExpectation {
  readonly objectId: string;
  readonly courseId: string;
  readonly now: number;
  readonly destinationId?: string;
}

/**
 * How long one reading stays usable. The connector reads the object immediately before it sends the
 * change, so anything older belongs to an earlier attempt and has to be read again.
 */
export const CANVAS_SEMANTIC_RESOLUTION_MAX_AGE_MS = 60_000;

const RESOLUTION_CLOCK_TOLERANCE_MS = 1_000;

const SECTION_TARGET: CanvasSemanticCourseTarget = Object.freeze({
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
const GROUP_TARGET: CanvasSemanticCourseTarget = Object.freeze({
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
const FILE_TARGET: CanvasSemanticCourseTarget = Object.freeze({
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
const FOLDER_TARGET: CanvasSemanticCourseTarget = Object.freeze({
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
} as const);

const CALENDAR_EVENT_TARGET: CanvasSemanticCourseTarget = Object.freeze({
  ...CALENDAR_EVENT_CALENDAR,
  objectParameter: "id",
});

const CALENDAR_EVENT_CREATE_TARGET: CanvasSemanticCourseTarget = Object.freeze({
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
const APPOINTMENT_GROUP_TARGET: CanvasSemanticCourseTarget = Object.freeze({
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
const SEMANTIC_COURSE_TARGETS: Readonly<Record<string, CanvasSemanticCourseTarget>> = Object.freeze({
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

const LEARNER_STATE_SEGMENTS: readonly string[] = Object.freeze([
  "submissions",
  "anonymous_submissions",
  "enrollments",
  "peer_reviews",
  "grades",
  "override",
  "overrides",
]);

export function canvasSemanticCourseTarget(
  operation: CanvasSemanticOperation | null | undefined,
): CanvasSemanticCourseTarget | undefined {
  if (!operation?.key || operation.readOnly === true) return undefined;
  return SEMANTIC_COURSE_TARGETS[operation.key];
}

/**
 * A route under one object that names a learner's own submission, grade, enrollment or assignment
 * override. Those need their own authority, not the course binding this framework proves.
 */
export function canvasLearnerScopeObjectRoute(operation: CanvasSemanticOperation | null | undefined): boolean {
  const path = String(operation?.path || "");
  if (!/^\/v1\/sections\/\{[^}]+\}\/./.test(path)) return false;
  return path.split("/").some((segment) => LEARNER_STATE_SEGMENTS.includes(segment));
}

function exactId(value: unknown): boolean {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value);
}

/** The way Canvas names one course's calendar. */
export function canvasCourseContextCode(courseId: string): string {
  return exactId(courseId) ? `course_${courseId}` : "";
}

/** The course a Canvas context code names, or an empty string when it names anything else. */
export function canvasContextCodeCourseId(value: unknown): string {
  const match = typeof value === "string" ? value.match(/^course_([1-9][0-9]{0,18})$/) : null;
  return match ? match[1]! : "";
}

/** The one reason Morrow refuses an object outright rather than asking for a better reading. */
export const CANVAS_MULTI_CONTEXT_REFUSAL = "multi_context_object_not_supported";

function namedValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0);
}

/**
 * Checks one frozen reading against the change it is meant to prove. Every enforcement layer calls
 * this before the change is sent; without a reading that names this exact object and the selected
 * course, the change stays held.
 */
export function canvasSemanticResolutionProblem(
  target: CanvasSemanticCourseTarget | null | undefined,
  resolution: unknown,
  expected: CanvasSemanticResolutionExpectation,
): CanvasSemanticResolutionRefusal | undefined {
  if (!target) return "canvas_semantic_target_course_mismatch";
  if (!exactId(expected.objectId) || !exactId(expected.courseId)) return "canvas_semantic_target_course_mismatch";
  if (!resolution || typeof resolution !== "object" || Array.isArray(resolution)) {
    return "canvas_semantic_target_course_mismatch";
  }
  const proof = resolution as Partial<CanvasSemanticResolutionProof>;
  if (proof.resolverTool !== target.resolverRead) return "canvas_semantic_target_course_mismatch";
  if (!exactId(proof.objectId) || proof.objectId !== expected.objectId) return "canvas_semantic_target_course_mismatch";
  if (!exactId(proof.courseId) || proof.courseId !== expected.courseId) return "canvas_semantic_target_course_mismatch";
  if (typeof proof.snapshotDigest !== "string" || !/^[0-9a-f]{64}$/.test(proof.snapshotDigest)) {
    return "canvas_semantic_target_course_mismatch";
  }
  // An object whose saved version is declared has to arrive with one: it is what the reading after
  // the change is compared against.
  if (target.versionFields?.length) {
    const version = proof.objectVersion;
    if (!version || typeof version !== "object" || Array.isArray(version)
      || idText((version as Record<string, unknown>).id) !== expected.objectId) {
      return "canvas_semantic_target_course_mismatch";
    }
  }
  // Where the change lands is proved the same way the object is, so the reading names the exact
  // destination this change asks for, and names none when the change asks for none.
  if ((proof.destinationId ?? "") !== (expected.destinationId ?? "")) return "canvas_semantic_target_course_mismatch";
  const resolvedAt = typeof proof.resolvedAt === "string" ? Date.parse(proof.resolvedAt) : Number.NaN;
  if (!Number.isFinite(resolvedAt)) return "canvas_semantic_target_resolution_stale";
  if (resolvedAt > expected.now + RESOLUTION_CLOCK_TOLERANCE_MS) return "canvas_semantic_target_resolution_stale";
  if (expected.now - resolvedAt > CANVAS_SEMANTIC_RESOLUTION_MAX_AGE_MS) return "canvas_semantic_target_resolution_stale";
  return undefined;
}

function idText(value: unknown): unknown {
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
}

/**
 * What one reading says about the course this object belongs to. An object that serves more than one
 * course at once is its own answer: Morrow changes one course, and it refuses such an object rather
 * than sending a change that would land in the others too.
 */
export type CanvasSemanticObjectContext =
  | { readonly state: "course"; readonly courseId: string }
  | { readonly state: "multi_context" }
  | { readonly state: "unproved" };

const UNPROVED_CONTEXT: CanvasSemanticObjectContext = Object.freeze({ state: "unproved" });
const MULTI_CONTEXT: CanvasSemanticObjectContext = Object.freeze({ state: "multi_context" });

function courseOfContextCode(value: unknown): CanvasSemanticObjectContext {
  const courseId = canvasContextCodeCourseId(value);
  return courseId ? Object.freeze({ state: "course" as const, courseId }) : UNPROVED_CONTEXT;
}

function courseOfField(target: CanvasSemanticCourseTarget, value: unknown): CanvasSemanticObjectContext {
  if (target.courseFieldShape === "context_code_list") {
    if (!Array.isArray(value) || value.length === 0) return UNPROVED_CONTEXT;
    return value.length > 1 ? MULTI_CONTEXT : courseOfContextCode(value[0]);
  }
  if (target.courseFieldShape === "context_code") return courseOfContextCode(value);
  const courseText = idText(value);
  return exactId(courseText) ? Object.freeze({ state: "course" as const, courseId: courseText as string }) : UNPROVED_CONTEXT;
}

export function canvasSemanticObjectContext(
  target: CanvasSemanticCourseTarget | null | undefined,
  read: { readonly ok?: boolean; readonly truncated?: boolean; readonly data?: unknown } | null | undefined,
  objectId: string,
): CanvasSemanticObjectContext {
  if (!target) return UNPROVED_CONTEXT;
  const values = objectRecord(read);
  if (!values) return UNPROVED_CONTEXT;
  // Canvas names the kind of owner separately from the owner's id. A group a person made for
  // themselves, or one an account owns, is refused here even when the reading also carries a course.
  if (target.contextField && values[target.contextField] !== target.contextValue) return UNPROVED_CONTEXT;
  const identityText = idText(values.id);
  if (!exactId(identityText) || identityText !== objectId) return UNPROVED_CONTEXT;
  return courseOfField(target, values[target.courseField]);
}

/** The course this reading proves, or an empty string when the reading proves nothing. */
export function canvasSemanticResolvedCourseId(
  target: CanvasSemanticCourseTarget | null | undefined,
  read: { readonly ok?: boolean; readonly truncated?: boolean; readonly data?: unknown } | null | undefined,
  objectId: string,
): string {
  const context = canvasSemanticObjectContext(target, read, objectId);
  return context.state === "course" ? context.courseId : "";
}

/**
 * What the change's own inputs say about the calendar it names. A create says where the new object
 * lands, and a change to an existing object can move it, so both are read here before anything is
 * sent. More than one context is refused outright: Morrow changes one course.
 */
export type CanvasSemanticContextInputState = "absent" | "selected_course" | "multi_context" | "other_context";

export function canvasSemanticContextInputState(
  target: CanvasSemanticCourseTarget | null | undefined,
  args: Readonly<Record<string, unknown>> | null | undefined,
  courseId: string,
): CanvasSemanticContextInputState {
  if (!target?.courseCodeParameter) return "absent";
  const value = args?.[target.courseCodeParameter];
  if (!namedValue(value)) return "absent";
  if (Array.isArray(value) && value.length > 1) return "multi_context";
  const named = Array.isArray(value) ? value[0] : value;
  const code = canvasCourseContextCode(courseId);
  return code && named === code ? "selected_course" : "other_context";
}

/**
 * True when the change carries an input that reaches further than the one object Morrow reads back:
 * a repeat rule, a duplicate count, or a choice that applies the change to a whole series.
 */
export function canvasSemanticSeriesInput(
  target: CanvasSemanticCourseTarget | null | undefined,
  args: Readonly<Record<string, unknown>> | null | undefined,
): boolean {
  return (target?.seriesParameters || []).some((name) => namedValue(args?.[name]));
}

/**
 * The arguments that make the selected course's own listing return that course's whole set. A
 * listing Canvas keys by course id takes the id; one it keys by calendar takes that calendar's
 * context code.
 */
export function canvasSemanticCourseCollectionArguments(
  target: CanvasSemanticCourseTarget | null | undefined,
  courseId: string,
): Readonly<Record<string, string | readonly string[]>> {
  if (!target || !exactId(courseId)) return {};
  if (!target.courseCollectionParameter) return { course_id: courseId };
  return {
    [target.courseCollectionParameter]: [canvasCourseContextCode(courseId)],
    ...(target.courseCollectionArguments || {}),
  };
}

function objectRecord(
  read: { readonly ok?: boolean; readonly truncated?: boolean; readonly data?: unknown } | null | undefined,
): Record<string, unknown> | undefined {
  if (read?.ok !== true || read.truncated === true) return undefined;
  const record = read.data;
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  return record as Record<string, unknown>;
}

/**
 * The saved version this reading found: the fields that say which stored copy of the object it is.
 * The connector freezes it beside the course proof and compares it with the reading it takes after
 * the change.
 */
export function canvasSemanticObjectVersion(
  target: CanvasSemanticCourseTarget | null | undefined,
  read: { readonly ok?: boolean; readonly truncated?: boolean; readonly data?: unknown } | null | undefined,
  objectId: string,
): Readonly<Record<string, unknown>> | undefined {
  if (!target?.versionFields?.length || !exactId(objectId)) return undefined;
  const values = objectRecord(read);
  if (!values || idText(values.id) !== objectId) return undefined;
  const version: Record<string, unknown> = {};
  for (const field of target.versionFields) {
    const value = field === "id" ? idText(values.id) : values[field];
    if (value !== undefined) version[field] = value;
  }
  return Object.freeze(version);
}

/**
 * What a reading taken after the change says about the version that was frozen. The bytes of a file
 * are not part of a rename or a move, so a size or type that changed means the change did not land
 * on the object that was read; a saved-at time earlier than the frozen one means the reading is an
 * older copy. A frozen field the reading does not carry proves nothing either way.
 */
export type CanvasSemanticVersionState = "same_object" | "changed" | "unreadable";

export function canvasSemanticVersionState(
  target: CanvasSemanticCourseTarget | null | undefined,
  version: unknown,
  read: { readonly ok?: boolean; readonly truncated?: boolean; readonly data?: unknown } | null | undefined,
  objectId: string,
): CanvasSemanticVersionState {
  if (!target || !version || typeof version !== "object" || Array.isArray(version)) return "unreadable";
  const values = objectRecord(read);
  if (!values || !exactId(objectId)) return "unreadable";
  if (idText(values.id) !== objectId) return "changed";
  for (const [field, frozen] of Object.entries(version as Record<string, unknown>)) {
    const actual = field === "id" ? idText(values.id) : values[field];
    if (actual === undefined) return "unreadable";
    if (field === target.versionTimestampField) {
      const frozenAt = Date.parse(String(frozen));
      const readAt = Date.parse(String(actual));
      if (!Number.isFinite(frozenAt) || !Number.isFinite(readAt)) return "unreadable";
      if (readAt < frozenAt) return "changed";
      continue;
    }
    if (actual !== frozen) return "changed";
  }
  return "same_object";
}

/**
 * What the selected course's own listing says about this object. A listing that could not be read
 * to its last page says nothing either way, so it is its own answer and never counts as absence.
 */
export type CanvasSemanticCourseCollectionState = "listed" | "absent" | "unreadable";

export function canvasSemanticCourseCollectionState(
  target: CanvasSemanticCourseTarget | null | undefined,
  read: { readonly ok?: boolean; readonly truncated?: boolean; readonly data?: unknown } | null | undefined,
  objectId: string,
  courseId = "",
): CanvasSemanticCourseCollectionState {
  if (!target || !exactId(objectId) || read?.ok !== true || read.truncated === true || !Array.isArray(read.data)) return "unreadable";
  // A listing Canvas keys by calendar carries that calendar on every entry. An entry from another
  // calendar means Canvas did not narrow the listing to the selected course, so the listing is not
  // that course's own and proves nothing about what it holds.
  if (exactId(courseId) && target.courseFieldShape && target.courseFieldShape !== "id") {
    const narrowed = read.data.every((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const context = courseOfField(target, (entry as Record<string, unknown>)[target.courseField]);
      return context.state === "course" && context.courseId === courseId;
    });
    if (!narrowed) return "unreadable";
  }
  const listed = read.data.some((entry) => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
    && idText((entry as Record<string, unknown>).id) === objectId);
  return listed ? "listed" : "absent";
}
