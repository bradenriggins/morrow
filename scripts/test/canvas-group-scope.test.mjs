import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInThisContext } from "node:vm";
import { canvasAdmissionReason, canvasOperationAdmission } from "../../connector/extension/generated/canvas-operation-admission.js";
import {
  CANVAS_SEMANTIC_RESOLUTION_MAX_AGE_MS,
  canvasSemanticCourseCollectionState,
  canvasSemanticCourseTarget,
  canvasSemanticResolutionProblem,
  canvasSemanticResolvedCourseId,
} from "../../connector/extension/generated/canvas-semantic-target.js";

const ORIGIN = "https://school.instructure.com";
const CONTENT_SOURCE = readFileSync(new URL("../../connector/extension/src/canvas-content.js", import.meta.url), "utf8");
const CATALOG = JSON.parse(readFileSync(new URL("../../connector/extension/generated/canvas-api-catalog.json", import.meta.url), "utf8"));

// 88 is the selected course's own group, 91 belongs to another course, and 92 is a group a person
// made for themselves outside any course.
const COURSE_GROUP = { id: "88", course_id: "42", context_type: "Course", name: "Lab team 1" };
const OTHER_COURSE_GROUP = { id: "91", course_id: "43", context_type: "Course", name: "Anatomy team" };
const USER_GROUP = { id: "92", course_id: null, context_type: "User", name: "Study buddies" };
const DIGEST = "a".repeat(64);

const GROUP_CONTENT_WRITES = [
  "canvas_create_new_discussion_topic_groups",
  "canvas_create_page_groups",
  "canvas_delete_page_groups",
  "canvas_delete_topic_groups",
  "canvas_update_create_front_page_groups",
  "canvas_update_create_page_groups",
  "canvas_update_topic_groups",
];

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

function freshResolution(overrides = {}) {
  return {
    objectId: "88",
    courseId: "42",
    resolverTool: "canvas_get_single_group",
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
    location: { origin: ORIGIN, pathname: "/courses/42/settings" },
    document: { cookie: "_csrf_token=csrf-value; _legacy_normandy_session=session" },
    fetch: async (input, options = {}) => {
      const url = new URL(String(input?.href ?? input), ORIGIN);
      if (url.pathname === "/api/v1/users/self/profile") return jsonResponse({ id: "7", name: "Teacher" });
      if (url.pathname === "/api/v1/courses/42") return jsonResponse({ id: "42", name: "Biology" });
      requests.push({ pathname: url.pathname, method: options.method || "GET" });
      return jsonResponse({ url: "week-one", title: "Week one", body: "<p>Plan</p>" });
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

test("only a group's own discussion topics and pages declare a course-ownership reading", () => {
  const groupTarget = {
    object: "group",
    objectParameter: "group_id",
    resolverRead: "canvas_get_single_group",
    courseField: "course_id",
    courseCollectionRead: "canvas_list_groups_available_in_context_courses",
    contextField: "context_type",
    contextValue: "Course",
    courseCollectionProof: true,
  };
  for (const toolName of GROUP_CONTENT_WRITES) {
    assert.deepEqual(target(toolName), groupTarget, toolName);
    assert.equal(canvasOperationAdmission(operation(toolName)).write.state, "admitted", toolName);
  }
  const declared = CATALOG.operations
    .filter((entry) => canvasSemanticCourseTarget(entry)?.object === "group")
    .map((entry) => entry.toolName)
    .sort();
  assert.deepEqual(declared, GROUP_CONTENT_WRITES);
  // The two readings the connector needs are reads, so neither can be admitted by its own
  // declaration, and both stay addressable from the ids Morrow already holds.
  const resolver = operation(groupTarget.resolverRead);
  assert.equal(resolver.readOnly, true);
  assert.equal(resolver.path, "/v1/groups/{group_id}");
  assert.equal(canvasSemanticCourseTarget(resolver), undefined);
  const collection = operation(groupTarget.courseCollectionRead);
  assert.equal(collection.readOnly, true);
  assert.equal(collection.path, "/v1/courses/{course_id}/groups");
});

test("every group route about who is in a group stays held with the learner reason", () => {
  const groupWrites = CATALOG.operations
    .filter((entry) => entry.readOnly === false && /^\/v1\/(?:groups|group_categories)(?:\/|$)/.test(entry.path));
  assert.equal(groupWrites.length, 53);
  const grouped = new Map();
  for (const entry of groupWrites) {
    const write = canvasOperationAdmission(entry).write;
    const key = write.state === "held" ? write.reason : write.state;
    grouped.set(key, [...(grouped.get(key) || []), entry.toolName].sort());
  }
  assert.deepEqual([...grouped.keys()].sort(), ["admitted", "cross_course_object_requires_resolution", "learner_scope_requires_separate_authority"]);
  assert.deepEqual(grouped.get("admitted"), GROUP_CONTENT_WRITES);
  assert.deepEqual(grouped.get("learner_scope_requires_separate_authority"), [
    "canvas_assign_unassigned_members",
    "canvas_bulk_delete_memberships_bulk_deletes_memberships_by_providing_array_of_user_ids_or_for_different",
    "canvas_create_membership",
    "canvas_import_category_groups",
    "canvas_invite_others_to_group",
    "canvas_leave_group_memberships",
    "canvas_leave_group_users",
    "canvas_update_membership_memberships",
    "canvas_update_membership_users",
  ]);
  assert.equal(
    canvasAdmissionReason({ state: "held", reason: "learner_scope_requires_separate_authority" }),
    "Morrow does not change a student's own record: their submitted work, a quiz attempt, a grade, an enrollment, who is in a group, or a booked time slot. Those need their own permission, so make that change in Canvas.",
  );
  // A group set can create groups and place students in them, so no group-set write is admitted,
  // and the group object itself has no declared reading yet.
  for (const toolName of ["canvas_create_group_group_categories", "canvas_delete_group_category", "canvas_update_group_category", "canvas_delete_group", "canvas_edit_group"]) {
    assert.deepEqual(canvasOperationAdmission(operation(toolName)).write, { state: "held", reason: "cross_course_object_requires_resolution" }, toolName);
    assert.equal(canvasSemanticCourseTarget(operation(toolName)), undefined, toolName);
  }
});

test("a reading proves a group only when a course owns it, it is this group, and the course lists it", () => {
  const groupTarget = target("canvas_update_create_page_groups");
  assert.equal(canvasSemanticResolvedCourseId(groupTarget, { ok: true, data: COURSE_GROUP }, "88"), "42");
  assert.equal(canvasSemanticResolvedCourseId(groupTarget, { ok: true, data: OTHER_COURSE_GROUP }, "91"), "43");
  // A group a person made for themselves proves no course, whatever else the reading carries.
  assert.equal(canvasSemanticResolvedCourseId(groupTarget, { ok: true, data: USER_GROUP }, "92"), "");
  assert.equal(canvasSemanticResolvedCourseId(groupTarget, { ok: true, data: { ...USER_GROUP, course_id: "42" } }, "92"), "");
  assert.equal(canvasSemanticResolvedCourseId(groupTarget, { ok: true, data: { ...COURSE_GROUP, context_type: "Account" } }, "88"), "");
  assert.equal(canvasSemanticResolvedCourseId(groupTarget, { ok: true, data: { id: 88, course_id: 42, context_type: "Course" } }, "88"), "42");
  assert.equal(canvasSemanticResolvedCourseId(groupTarget, { ok: true, data: COURSE_GROUP }, "91"), "");
  assert.equal(canvasSemanticResolvedCourseId(groupTarget, { ok: true, truncated: true, data: COURSE_GROUP }, "88"), "");
  assert.equal(canvasSemanticResolvedCourseId(groupTarget, { ok: false, status: 404 }, "88"), "");

  // The group read alone is not the whole proof: the selected course has to list the group as its
  // own, and a listing that could not be read to its last page says nothing either way.
  assert.equal(groupTarget.courseCollectionProof, true);
  assert.equal(canvasSemanticCourseCollectionState(groupTarget, { ok: true, data: [{ id: "87" }, { id: 88 }] }, "88"), "listed");
  assert.equal(canvasSemanticCourseCollectionState(groupTarget, { ok: true, data: [{ id: "87" }] }, "88"), "absent");
  assert.equal(canvasSemanticCourseCollectionState(groupTarget, { ok: true, truncated: true, data: [{ id: "87" }] }, "88"), "unreadable");
  assert.equal(canvasSemanticCourseCollectionState(groupTarget, { ok: false, status: 403 }, "88"), "unreadable");
  assert.equal(canvasSemanticCourseCollectionState(groupTarget, { ok: true, data: { id: "88" } }, "88"), "unreadable");

  const now = Date.now();
  const expected = { objectId: "88", courseId: "42", now };
  assert.equal(canvasSemanticResolutionProblem(groupTarget, freshResolution(), expected), undefined);
  for (const [label, resolution] of [
    ["no reading at all", undefined],
    ["a reading of another course", freshResolution({ courseId: "43" })],
    ["a reading of another group", freshResolution({ objectId: "91" })],
    ["a reading taken through another route", freshResolution({ resolverTool: "canvas_list_groups_available_in_context_courses" })],
    ["a reading with no snapshot", freshResolution({ snapshotDigest: "" })],
  ]) {
    assert.equal(canvasSemanticResolutionProblem(groupTarget, resolution, expected), "canvas_semantic_target_course_mismatch", label);
  }
  const stale = freshResolution({ resolvedAt: new Date(now - CANVAS_SEMANTIC_RESOLUTION_MAX_AGE_MS - 1_000).toISOString() });
  assert.equal(canvasSemanticResolutionProblem(groupTarget, stale, expected), "canvas_semantic_target_resolution_stale");
});

test("the page sends a group page change only with a current reading of that exact group", async () => {
  const args = { group_id: "88", url_or_id: "week-one", wiki_page_body: "<p>Plan</p>" };

  const withoutProof = await executeInPage("canvas_update_create_page_groups", { resolution: undefined, args });
  assert.deepEqual(withoutProof.result, { ok: false, sent: false, error: "canvas_semantic_target_course_mismatch" });
  assert.deepEqual(withoutProof.requests, []);

  const otherCourse = await executeInPage("canvas_update_create_page_groups", { resolution: freshResolution({ courseId: "43" }), args });
  assert.deepEqual(otherCourse.result, { ok: false, sent: false, error: "canvas_semantic_target_course_mismatch" });
  assert.deepEqual(otherCourse.requests, []);

  // A reading of another group, including a group outside every course, never stands in for this one.
  for (const objectId of ["91", "92"]) {
    const otherGroup = await executeInPage("canvas_update_create_page_groups", { resolution: freshResolution({ objectId }), args });
    assert.deepEqual(otherGroup.result, { ok: false, sent: false, error: "canvas_semantic_target_course_mismatch" }, objectId);
    assert.deepEqual(otherGroup.requests, [], objectId);
  }

  const stale = await executeInPage("canvas_update_create_page_groups", {
    resolution: freshResolution({ resolvedAt: new Date(Date.now() - CANVAS_SEMANTIC_RESOLUTION_MAX_AGE_MS - 5_000).toISOString() }),
    args,
  });
  assert.deepEqual(stale.result, { ok: false, sent: false, error: "canvas_semantic_target_resolution_stale" });
  assert.deepEqual(stale.requests, []);

  const proved = await executeInPage("canvas_update_create_page_groups", { resolution: freshResolution(), args });
  assert.equal(proved.result.ok, true, JSON.stringify(proved.result));
  assert.deepEqual(proved.requests, [{ pathname: "/api/v1/groups/88/pages/week-one", method: "PUT" }]);

  // The reading names the group, so it cannot carry a change to a different group's content.
  const otherGroupContent = await executeInPage("canvas_update_create_page_groups", {
    resolution: freshResolution(),
    args: { ...args, group_id: "91" },
  });
  assert.deepEqual(otherGroupContent.result, { ok: false, sent: false, error: "canvas_semantic_target_course_mismatch" });
  assert.deepEqual(otherGroupContent.requests, []);

  const topic = await executeInPage("canvas_delete_topic_groups", { resolution: freshResolution(), args: { group_id: "88", topic_id: "9" } });
  assert.equal(topic.result.ok, true, JSON.stringify(topic.result));
  assert.deepEqual(topic.requests, [{ pathname: "/api/v1/groups/88/discussion_topics/9", method: "DELETE" }]);
});

test("the page still refuses every held group route, proof or not", async () => {
  for (const toolName of ["canvas_create_membership", "canvas_edit_group", "canvas_update_group_category"]) {
    const held = await executeInPage(toolName, {
      resolution: freshResolution(),
      args: { group_id: "88", group_category_id: "12", user_id: "99", group_name: "Lab team 1", name: "Lab teams" },
    });
    assert.deepEqual(held.result, { ok: false, sent: false, error: "canvas_course_scope_required" }, toolName);
    assert.deepEqual(held.requests, [], toolName);
  }
});
