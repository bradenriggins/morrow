import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInThisContext } from "node:vm";
import { canvasOperationAdmission } from "../../connector/extension/generated/canvas-operation-admission.js";
import {
  CANVAS_MULTI_CONTEXT_REFUSAL,
  canvasContextCodeCourseId,
  canvasCourseContextCode,
  canvasSemanticContextInputState,
  canvasSemanticCourseCollectionArguments,
  canvasSemanticCourseCollectionState,
  canvasSemanticCourseTarget,
  canvasSemanticObjectContext,
  canvasSemanticResolvedCourseId,
  canvasSemanticSeriesInput,
} from "../../connector/extension/generated/canvas-semantic-target.js";

const ORIGIN = "https://school.instructure.com";
const CONTENT_SOURCE = readFileSync(new URL("../../connector/extension/src/canvas-content.js", import.meta.url), "utf8");
const CATALOG = JSON.parse(readFileSync(new URL("../../connector/extension/generated/canvas-api-catalog.json", import.meta.url), "utf8"));

// 501 is on the selected course's calendar, 601 is on another course's, and 602 is on a group's.
const COURSE_EVENT = {
  id: "501", context_code: "course_42", context_name: "Biology", title: "Lab review",
  start_at: "2026-09-10T16:00:00Z", end_at: "2026-09-10T17:00:00Z",
  description: "<p>Bring the worksheet.</p>", location_name: "Room 2", workflow_state: "active",
};
const OTHER_COURSE_EVENT = { ...COURSE_EVENT, id: "601", context_code: "course_43" };
const GROUP_EVENT = { ...COURSE_EVENT, id: "602", context_code: "group_9" };
// 701 serves the selected course alone, 702 serves two courses at once, and 703 serves another course.
const COURSE_APPOINTMENT_GROUP = {
  id: "701", context_codes: ["course_42"], sub_context_codes: [], title: "Office hours",
  location_name: "Room 2", participant_visibility: "private", workflow_state: "active",
};
const MULTI_COURSE_APPOINTMENT_GROUP = { ...COURSE_APPOINTMENT_GROUP, id: "702", context_codes: ["course_42", "course_43"] };
const OTHER_COURSE_APPOINTMENT_GROUP = { ...COURSE_APPOINTMENT_GROUP, id: "703", context_codes: ["course_43"] };
const DIGEST = "a".repeat(64);

const CALENDAR_WRITES = ["canvas_create_calendar_event", "canvas_delete_calendar_event", "canvas_update_calendar_event"];
const APPOINTMENT_GROUP_WRITES = ["canvas_update_appointment_group"];

function operation(toolName) {
  const value = CATALOG.operations.find((entry) => entry.toolName === toolName);
  assert.ok(value, `missing Canvas operation ${toolName}`);
  return value;
}

function target(toolName) {
  const value = canvasSemanticCourseTarget(operation(toolName));
  assert.ok(value, `${toolName} declares no semantic course target`);
  return value;
}

function eventResolution(overrides = {}) {
  return {
    objectId: "501",
    courseId: "42",
    resolverTool: "canvas_get_single_calendar_event_or_assignment",
    resolvedAt: new Date().toISOString(),
    snapshotDigest: DIGEST,
    ...overrides,
  };
}

function appointmentGroupResolution(overrides = {}) {
  return {
    objectId: "701",
    courseId: "42",
    resolverTool: "canvas_get_single_appointment_group",
    resolvedAt: new Date().toISOString(),
    snapshotDigest: DIGEST,
    ...overrides,
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

/**
 * Runs the real content script the way Chrome runs it: the file is evaluated as a classic script
 * against these page globals, and the change goes through its own message listener. This is the
 * last enforcement layer before a Canvas request leaves the browser.
 */
async function executeInPage(toolName, { resolution, args, courseId = "42" }) {
  const keys = ["location", "document", "fetch", "chrome", "__morrowCanvasConnectorInstalled"];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const catalogOperation = operation(toolName);
  const requests = [];
  const listeners = [];
  const values = {
    location: { origin: ORIGIN, pathname: "/courses/42/calendar_events" },
    document: { cookie: "_csrf_token=csrf-value; _legacy_normandy_session=session" },
    fetch: async (input, options = {}) => {
      const url = new URL(String(input?.href ?? input), ORIGIN);
      if (url.pathname === "/api/v1/users/self/profile") return jsonResponse({ id: "7", name: "Teacher" });
      if (url.pathname === "/api/v1/courses/42") return jsonResponse({ id: "42", name: "Biology" });
      requests.push({ pathname: url.pathname, method: options.method || "GET" });
      return jsonResponse(toolName.includes("appointment_group") ? COURSE_APPOINTMENT_GROUP : COURSE_EVENT);
    },
    chrome: { runtime: { onMessage: { addListener: (listener) => listeners.push(listener) } } },
    __morrowCanvasConnectorInstalled: undefined,
  };
  try {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    delete globalThis.__morrowCanvasConnectorInstalled;
    runInThisContext(CONTENT_SOURCE, { filename: "canvas-content.js" });
    assert.equal(listeners.length, 1, "the content script registered no message listener");
    const result = await new Promise((resolve, reject) => {
      const handled = listeners[0]({
        type: "morrow_canvas_execute",
        // Exactly what connector/extension/src/service-worker.js sends to the page.
        operation: {
          ...catalogOperation,
          morrowCourseTarget: canvasOperationAdmission(catalogOperation).courseTarget,
          ...(resolution === undefined ? {} : { morrowSemanticResolution: resolution }),
        },
        arguments: args,
        principalId: "7",
        expiresAt: Date.now() + 60_000,
        courseId,
      }, null, resolve);
      if (handled !== true) reject(new Error("the content script did not accept the execute message"));
    });
    return { result, requests };
  } finally {
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test("only the course calendar event routes and the appointment group update declare a reading", () => {
  const calendar = {
    object: "calendar event",
    readParameter: "id",
    resolverRead: "canvas_get_single_calendar_event_or_assignment",
    courseField: "context_code",
    courseFieldShape: "context_code",
    courseCodeParameter: "calendar_event_context_code",
    courseCollectionRead: "canvas_list_calendar_events",
    courseCollectionParameter: "context_codes",
    courseCollectionArguments: { all_events: "true" },
    refusedParameters: [
      "calendar_event_child_event_data_x_context_code",
      "calendar_event_child_event_data_x_start_at",
      "calendar_event_child_event_data_x_end_at",
    ],
    seriesParameters: [
      "calendar_event_duplicate_append_iterator",
      "calendar_event_duplicate_count",
      "calendar_event_duplicate_frequency",
      "calendar_event_duplicate_interval",
      "calendar_event_rrule",
      "which",
    ],
  };
  assert.deepEqual(target("canvas_create_calendar_event"), { ...calendar, createsObject: true });
  for (const toolName of ["canvas_update_calendar_event", "canvas_delete_calendar_event"]) {
    assert.deepEqual(target(toolName), { ...calendar, objectParameter: "id" }, toolName);
  }
  assert.deepEqual(target("canvas_update_appointment_group"), {
    object: "appointment group",
    objectParameter: "id",
    resolverRead: "canvas_get_single_appointment_group",
    courseField: "context_codes",
    courseFieldShape: "context_code_list",
    courseCodeParameter: "appointment_group_context_codes",
    courseCollectionRead: "canvas_list_appointment_groups",
    courseCollectionParameter: "context_codes",
    courseCollectionArguments: { scope: "manageable" },
    refusedParameters: ["appointment_group_sub_context_codes"],
  });
  for (const toolName of [...CALENDAR_WRITES, ...APPOINTMENT_GROUP_WRITES]) {
    assert.equal(canvasOperationAdmission(operation(toolName)).write.state, "admitted", toolName);
  }
  const declared = CATALOG.operations
    .filter((entry) => ["calendar event", "appointment group"].includes(canvasSemanticCourseTarget(entry)?.object))
    .map((entry) => entry.toolName)
    .sort();
  assert.deepEqual(declared, [...CALENDAR_WRITES, ...APPOINTMENT_GROUP_WRITES].sort());

  // Every reading the connector needs is a read, so none can be admitted by its own declaration,
  // and each stays addressable from the ids Morrow already holds: the object, and the course.
  for (const [toolName, path, pathParameters] of [
    ["canvas_get_single_calendar_event_or_assignment", "/v1/calendar_events/{id}", ["id"]],
    ["canvas_get_single_appointment_group", "/v1/appointment_groups/{id}", ["id"]],
    ["canvas_list_calendar_events", "/v1/calendar_events", []],
    ["canvas_list_appointment_groups", "/v1/appointment_groups", []],
  ]) {
    const read = operation(toolName);
    assert.equal(read.readOnly, true, toolName);
    assert.equal(read.path, path, toolName);
    assert.equal(canvasSemanticCourseTarget(read), undefined, toolName);
    assert.deepEqual(read.parameters.filter((entry) => entry.location === "path").map((entry) => entry.inputName), pathParameters, toolName);
  }
  // Both listings take the calendar by its context code, which is how the deletion proof asks for
  // the selected course's own calendar.
  for (const toolName of ["canvas_list_calendar_events", "canvas_list_appointment_groups"]) {
    assert.equal(operation(toolName).parameters.some((entry) => entry.inputName === "context_codes"), true, toolName);
  }
});

test("every other Canvas calendar and appointment group write stays held with its own reason", () => {
  const writes = CATALOG.operations.filter((entry) => entry.readOnly === false
    && /^\/v1\/(?:appointment_groups|calendar_events)(?:\/|$)/.test(entry.path));
  assert.equal(writes.length, 9);
  const grouped = new Map();
  for (const entry of writes) {
    const write = canvasOperationAdmission(entry).write;
    const key = write.state === "held" ? write.reason : write.state;
    grouped.set(key, [...(grouped.get(key) || []), entry.toolName].sort());
  }
  assert.deepEqual(grouped.get("admitted"), [...CALENDAR_WRITES, ...APPOINTMENT_GROUP_WRITES].sort());
  // Reserving a time slot books it for one person, and deleting an appointment group cancels every
  // slot already booked in it. Both change a person's own record, not course content.
  assert.deepEqual(grouped.get("learner_scope_requires_separate_authority"), [
    "canvas_delete_appointment_group",
    "canvas_reserve_time_slot",
    "canvas_reserve_time_slot_participant_id",
  ]);
  // Creating an appointment group names its courses in the request itself, and nothing proves those
  // are the selected one, so it keeps the hold it already carried.
  assert.deepEqual(grouped.get("cross_course_object_requires_resolution"), ["canvas_create_appointment_group"]);
  // The enabled account calendars are the signed-in person's own list of calendars to display.
  assert.deepEqual(grouped.get("course_scope_required"), ["canvas_save_enabled_account_calendars"]);
  assert.deepEqual([...grouped.keys()].sort(), [
    "admitted",
    "course_scope_required",
    "cross_course_object_requires_resolution",
    "learner_scope_requires_separate_authority",
  ]);
});

test("a reading proves a calendar object only when it names the selected course and no other", () => {
  const eventTarget = target("canvas_update_calendar_event");
  assert.equal(canvasCourseContextCode("42"), "course_42");
  assert.equal(canvasCourseContextCode("0"), "");
  assert.equal(canvasContextCodeCourseId("course_42"), "42");
  assert.equal(canvasContextCodeCourseId("group_9"), "");
  assert.equal(canvasContextCodeCourseId(42), "");

  assert.deepEqual(canvasSemanticObjectContext(eventTarget, { ok: true, data: COURSE_EVENT }, "501"), { state: "course", courseId: "42" });
  assert.equal(canvasSemanticResolvedCourseId(eventTarget, { ok: true, data: COURSE_EVENT }, "501"), "42");
  assert.equal(canvasSemanticResolvedCourseId(eventTarget, { ok: true, data: OTHER_COURSE_EVENT }, "601"), "43");
  // A group calendar, a personal calendar and an account calendar all prove no course.
  for (const contextCode of ["group_9", "user_7", "account_5", "", undefined]) {
    assert.deepEqual(canvasSemanticObjectContext(eventTarget, { ok: true, data: { ...COURSE_EVENT, context_code: contextCode } }, "501"),
      { state: "unproved" }, String(contextCode));
  }
  // A reading of another event, a truncated reading and a failed reading prove nothing.
  assert.equal(canvasSemanticResolvedCourseId(eventTarget, { ok: true, data: COURSE_EVENT }, "601"), "");
  assert.equal(canvasSemanticResolvedCourseId(eventTarget, { ok: true, truncated: true, data: COURSE_EVENT }, "501"), "");
  assert.equal(canvasSemanticResolvedCourseId(eventTarget, { ok: false, status: 404 }, "501"), "");

  const groupTarget = target("canvas_update_appointment_group");
  assert.deepEqual(canvasSemanticObjectContext(groupTarget, { ok: true, data: COURSE_APPOINTMENT_GROUP }, "701"), { state: "course", courseId: "42" });
  // An appointment group that serves two courses is refused outright: changing it would change the
  // other course too.
  assert.deepEqual(canvasSemanticObjectContext(groupTarget, { ok: true, data: MULTI_COURSE_APPOINTMENT_GROUP }, "702"), { state: "multi_context" });
  assert.equal(canvasSemanticResolvedCourseId(groupTarget, { ok: true, data: MULTI_COURSE_APPOINTMENT_GROUP }, "702"), "");
  assert.deepEqual(canvasSemanticObjectContext(groupTarget, { ok: true, data: OTHER_COURSE_APPOINTMENT_GROUP }, "703"), { state: "course", courseId: "43" });
  assert.deepEqual(canvasSemanticObjectContext(groupTarget, { ok: true, data: { ...COURSE_APPOINTMENT_GROUP, context_codes: [] } }, "701"), { state: "unproved" });
  assert.deepEqual(canvasSemanticObjectContext(groupTarget, { ok: true, data: { ...COURSE_APPOINTMENT_GROUP, context_codes: "course_42" } }, "701"), { state: "unproved" });
});

test("the change's own inputs say which calendar it names, and more than one is refused", () => {
  const eventTarget = target("canvas_update_calendar_event");
  const createTarget = target("canvas_create_calendar_event");
  const groupTarget = target("canvas_update_appointment_group");
  assert.equal(canvasSemanticContextInputState(createTarget, { calendar_event_context_code: "course_42" }, "42"), "selected_course");
  assert.equal(canvasSemanticContextInputState(createTarget, { calendar_event_context_code: "course_43" }, "42"), "other_context");
  assert.equal(canvasSemanticContextInputState(createTarget, { calendar_event_context_code: "group_9" }, "42"), "other_context");
  assert.equal(canvasSemanticContextInputState(createTarget, {}, "42"), "absent");
  // A change to an existing event can move it to another calendar, so the same input is read there.
  assert.equal(canvasSemanticContextInputState(eventTarget, { id: "501" }, "42"), "absent");
  assert.equal(canvasSemanticContextInputState(eventTarget, { id: "501", calendar_event_context_code: "course_43" }, "42"), "other_context");
  assert.equal(canvasSemanticContextInputState(groupTarget, { appointment_group_context_codes: ["course_42"] }, "42"), "selected_course");
  assert.equal(canvasSemanticContextInputState(groupTarget, { appointment_group_context_codes: ["course_42", "course_43"] }, "42"), "multi_context");
  assert.equal(canvasSemanticContextInputState(groupTarget, { appointment_group_context_codes: [] }, "42"), "absent");
  // A section target names no calendar at all, so it has no context input to read.
  assert.equal(canvasSemanticContextInputState(target("canvas_edit_section"), { id: "302" }, "42"), "absent");

  // Morrow sends one event and reads that one back, so a repeat, a copy or a series choice is
  // refused before anything is sent.
  for (const name of ["calendar_event_rrule", "calendar_event_duplicate_count", "calendar_event_duplicate_frequency",
    "calendar_event_duplicate_interval", "calendar_event_duplicate_append_iterator", "which"]) {
    assert.equal(canvasSemanticSeriesInput(eventTarget, { id: "501", [name]: "1" }), true, name);
  }
  assert.equal(canvasSemanticSeriesInput(eventTarget, { id: "501", calendar_event_title: "Lab review" }), false);
  assert.equal(canvasSemanticSeriesInput(groupTarget, { id: "701", which: "all" }), false);
  assert.equal(CANVAS_MULTI_CONTEXT_REFUSAL, "multi_context_object_not_supported");
});

test("a deletion is proved against the selected course's whole calendar, asked for by context code", () => {
  const eventTarget = target("canvas_update_calendar_event");
  assert.deepEqual(canvasSemanticCourseCollectionArguments(eventTarget, "42"), { context_codes: ["course_42"], all_events: "true" });
  assert.deepEqual(canvasSemanticCourseCollectionArguments(target("canvas_update_appointment_group"), "42"), { context_codes: ["course_42"], scope: "manageable" });
  // A listing Canvas keys by course id keeps taking the course id.
  assert.deepEqual(canvasSemanticCourseCollectionArguments(target("canvas_edit_section"), "42"), { course_id: "42" });
  assert.deepEqual(canvasSemanticCourseCollectionArguments(eventTarget, "0"), {});

  const listing = (events) => ({ ok: true, data: events });
  assert.equal(canvasSemanticCourseCollectionState(eventTarget, listing([COURSE_EVENT]), "501", "42"), "listed");
  assert.equal(canvasSemanticCourseCollectionState(eventTarget, listing([{ ...COURSE_EVENT, id: "502" }]), "501", "42"), "absent");
  assert.equal(canvasSemanticCourseCollectionState(eventTarget, listing([]), "501", "42"), "absent");
  // A listing that could not be read to its last page, or that Canvas never narrowed to this
  // course, says nothing either way and never counts as absence.
  assert.equal(canvasSemanticCourseCollectionState(eventTarget, { ok: true, truncated: true, data: [] }, "501", "42"), "unreadable");
  assert.equal(canvasSemanticCourseCollectionState(eventTarget, listing([OTHER_COURSE_EVENT]), "501", "42"), "unreadable");
  assert.equal(canvasSemanticCourseCollectionState(eventTarget, listing([{ id: "502", title: "No calendar named" }]), "501", "42"), "unreadable");
  assert.equal(canvasSemanticCourseCollectionState(eventTarget, { ok: false, status: 403 }, "501", "42"), "unreadable");
  // A section listing carries no calendar on its entries, so that check does not apply to it.
  assert.equal(canvasSemanticCourseCollectionState(target("canvas_edit_section"), listing([{ id: "302" }]), "302", "42"), "listed");
});

test("the page adds an event only to the selected course's own calendar", async () => {
  const args = {
    calendar_event_context_code: "course_42",
    calendar_event_title: "Lab review",
    calendar_event_start_at: "2026-09-10T16:00:00Z",
    calendar_event_end_at: "2026-09-10T17:00:00Z",
  };

  const created = await executeInPage("canvas_create_calendar_event", { args });
  assert.equal(created.result.ok, true, JSON.stringify(created.result));
  assert.deepEqual(created.requests, [{ pathname: "/api/v1/calendar_events", method: "POST" }]);

  // Another course's calendar, a group calendar and a personal calendar are all refused, and
  // nothing is sent for any of them.
  for (const contextCode of ["course_43", "group_9", "user_7"]) {
    const refused = await executeInPage("canvas_create_calendar_event", {
      args: { ...args, calendar_event_context_code: contextCode },
    });
    assert.deepEqual(refused.result, { ok: false, sent: false, error: "canvas_semantic_target_course_mismatch" }, contextCode);
    assert.deepEqual(refused.requests, [], contextCode);
  }

  // Canvas requires the calendar on this route, so a request that names none is refused as it is
  // built, before the course check the connector already made can run again here. Nothing is sent
  // either way, and connector/extension/src/service-worker.js holds the same change earlier with
  // the sentence about the selected course.
  const withoutCalendar = await executeInPage("canvas_create_calendar_event", {
    args: { ...args, calendar_event_context_code: undefined },
  });
  assert.deepEqual(withoutCalendar.result, { ok: false, sent: false, error: "calendar_event_context_code is required" });
  assert.deepEqual(withoutCalendar.requests, []);

  // Morrow sends one event and reads that one event back, so a repeat rule, a duplicate count and
  // section-level times are refused before anything is sent.
  for (const [name, value] of [
    ["calendar_event_rrule", "FREQ=WEEKLY;COUNT=5"],
    ["calendar_event_duplicate_count", 3],
    ["calendar_event_duplicate_frequency", "weekly"],
    ["calendar_event_child_event_data_x_context_code", "course_section_9"],
    ["calendar_event_child_event_data_x_start_at", "2026-09-10T16:30:00Z"],
  ]) {
    const refused = await executeInPage("canvas_create_calendar_event", { args: { ...args, [name]: value } });
    assert.deepEqual(refused.result, { ok: false, sent: false, error: "canvas_semantic_target_input_refused" }, name);
    assert.deepEqual(refused.requests, [], name);
  }
});

test("the page changes and removes an event only with a current reading of that exact event", async () => {
  const args = { id: "501", calendar_event_title: "Lab review, revised" };

  const withoutProof = await executeInPage("canvas_update_calendar_event", { resolution: undefined, args });
  assert.deepEqual(withoutProof.result, { ok: false, sent: false, error: "canvas_semantic_target_course_mismatch" });
  assert.deepEqual(withoutProof.requests, []);

  const otherCourse = await executeInPage("canvas_update_calendar_event", { resolution: eventResolution({ courseId: "43" }), args });
  assert.deepEqual(otherCourse.result, { ok: false, sent: false, error: "canvas_semantic_target_course_mismatch" });
  assert.deepEqual(otherCourse.requests, []);

  const otherEvent = await executeInPage("canvas_update_calendar_event", { resolution: eventResolution({ objectId: "601" }), args });
  assert.deepEqual(otherEvent.result, { ok: false, sent: false, error: "canvas_semantic_target_course_mismatch" });
  assert.deepEqual(otherEvent.requests, []);

  const changed = await executeInPage("canvas_update_calendar_event", { resolution: eventResolution(), args });
  assert.equal(changed.result.ok, true, JSON.stringify(changed.result));
  assert.deepEqual(changed.requests, [{ pathname: "/api/v1/calendar_events/501", method: "PUT" }]);

  // The same input that puts a new event on a calendar moves an existing one, so a change that
  // names another calendar is refused rather than moving the event out of the course.
  const moved = await executeInPage("canvas_update_calendar_event", {
    resolution: eventResolution(),
    args: { ...args, calendar_event_context_code: "course_43" },
  });
  assert.deepEqual(moved.result, { ok: false, sent: false, error: "canvas_semantic_target_course_mismatch" });
  assert.deepEqual(moved.requests, []);

  const kept = await executeInPage("canvas_update_calendar_event", {
    resolution: eventResolution(),
    args: { ...args, calendar_event_context_code: "course_42" },
  });
  assert.equal(kept.result.ok, true, JSON.stringify(kept.result));

  // A series choice reaches events this change cannot read back, on a change and on a removal.
  for (const toolName of ["canvas_update_calendar_event", "canvas_delete_calendar_event"]) {
    const series = await executeInPage(toolName, { resolution: eventResolution(), args: { id: "501", which: "all" } });
    assert.deepEqual(series.result, { ok: false, sent: false, error: "canvas_semantic_target_input_refused" }, toolName);
    assert.deepEqual(series.requests, [], toolName);
  }

  const removed = await executeInPage("canvas_delete_calendar_event", { resolution: eventResolution(), args: { id: "501" } });
  assert.equal(removed.result.ok, true, JSON.stringify(removed.result));
  assert.deepEqual(removed.requests, [{ pathname: "/api/v1/calendar_events/501", method: "DELETE" }]);
});

test("the page changes an appointment group only when it serves the selected course alone", async () => {
  const args = { id: "701", appointment_group_context_codes: ["course_42"], appointment_group_title: "Office hours, revised" };

  const changed = await executeInPage("canvas_update_appointment_group", { resolution: appointmentGroupResolution(), args });
  assert.equal(changed.result.ok, true, JSON.stringify(changed.result));
  assert.deepEqual(changed.requests, [{ pathname: "/api/v1/appointment_groups/701", method: "PUT" }]);

  // A change that names two courses is refused outright, with the reason that says why.
  const multiContext = await executeInPage("canvas_update_appointment_group", {
    resolution: appointmentGroupResolution(),
    args: { ...args, appointment_group_context_codes: ["course_42", "course_43"] },
  });
  assert.deepEqual(multiContext.result, { ok: false, sent: false, error: "multi_context_object_not_supported" });
  assert.deepEqual(multiContext.requests, []);

  const otherCourse = await executeInPage("canvas_update_appointment_group", {
    resolution: appointmentGroupResolution(),
    args: { ...args, appointment_group_context_codes: ["course_43"] },
  });
  assert.deepEqual(otherCourse.result, { ok: false, sent: false, error: "canvas_semantic_target_course_mismatch" });
  assert.deepEqual(otherCourse.requests, []);

  // Sub contexts narrow the group to particular sections or to a group set, and the reading of the
  // group does not prove those belong to the selected course.
  const subContext = await executeInPage("canvas_update_appointment_group", {
    resolution: appointmentGroupResolution(),
    args: { ...args, appointment_group_sub_context_codes: ["course_section_9"] },
  });
  assert.deepEqual(subContext.result, { ok: false, sent: false, error: "canvas_semantic_target_input_refused" });
  assert.deepEqual(subContext.requests, []);

  const withoutProof = await executeInPage("canvas_update_appointment_group", { resolution: undefined, args });
  assert.deepEqual(withoutProof.result, { ok: false, sent: false, error: "canvas_semantic_target_course_mismatch" });
  assert.deepEqual(withoutProof.requests, []);
});

test("the page still refuses every held calendar and appointment group route", async () => {
  for (const toolName of ["canvas_create_appointment_group", "canvas_delete_appointment_group", "canvas_reserve_time_slot"]) {
    const held = await executeInPage(toolName, {
      resolution: appointmentGroupResolution(),
      args: { id: "701", appointment_group_context_codes: ["course_42"], appointment_group_title: "Must not exist" },
    });
    assert.deepEqual(held.result, { ok: false, sent: false, error: "canvas_course_scope_required" }, toolName);
    assert.deepEqual(held.requests, [], toolName);
  }
});
