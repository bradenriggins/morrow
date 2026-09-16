import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInThisContext } from "node:vm";
import { canvasOperationAdmission, canvasSiteAuthorityNote } from "../../connector/extension/generated/canvas-operation-admission.js";
import {
  CANVAS_SEMANTIC_RESOLUTION_MAX_AGE_MS,
  canvasLearnerScopeObjectRoute,
  canvasSemanticCourseTarget,
  canvasSemanticObjectContext,
  canvasSemanticResolutionProblem,
  canvasSemanticResolvedCourseId,
} from "../../connector/extension/generated/canvas-semantic-target.js";

const ORIGIN = "https://school.instructure.com";
const CONTENT_SOURCE = readFileSync(new URL("../../connector/extension/src/canvas-content.js", import.meta.url), "utf8");
const CATALOG = JSON.parse(readFileSync(new URL("../../connector/extension/generated/canvas-api-catalog.json", import.meta.url), "utf8"));

const SECTION = { id: "302", course_id: "42", name: "Section B" };
const OTHER_COURSE_SECTION = { id: "303", course_id: "43", name: "Section C" };
const DIGEST = "a".repeat(64);

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
    objectId: "302",
    courseId: "42",
    resolverTool: "canvas_get_section_information_sections",
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
async function executeInPage(toolName, { resolution, args = { id: "302" }, courseId = "42" }) {
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
      return jsonResponse({ ...SECTION, name: "Section B evening" });
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

test("the section routes that change the section itself declare a course-ownership reading", () => {
  const sectionTarget = {
    object: "section",
    objectParameter: "id",
    resolverRead: "canvas_get_section_information_sections",
    courseField: "course_id",
    courseCollectionRead: "canvas_list_course_sections",
  };
  assert.deepEqual(target("canvas_edit_section"), sectionTarget);
  assert.deepEqual(target("canvas_delete_section"), sectionTarget);

  const declared = CATALOG.operations.filter((entry) => canvasSemanticCourseTarget(entry)).map((entry) => entry.toolName).sort();
  // The group content routes, the course file and folder routes, and the course calendar routes
  // declare the same kind of reading; scripts/test/canvas-group-scope.test.mjs,
  // scripts/test/canvas-file-scope.test.mjs and scripts/test/canvas-calendar-scope.test.mjs hold
  // their cases.
  assert.deepEqual(declared.filter((name) => name.endsWith("_section")), ["canvas_delete_section", "canvas_edit_section"]);
  assert.deepEqual(declared.filter((name) => !name.endsWith("_section")), [
    "canvas_create_calendar_event",
    "canvas_create_folder_folders",
    "canvas_create_new_discussion_topic_groups",
    "canvas_create_page_groups",
    "canvas_delete_calendar_event",
    "canvas_delete_file",
    "canvas_delete_page_groups",
    "canvas_delete_topic_groups",
    "canvas_update_appointment_group",
    "canvas_update_calendar_event",
    "canvas_update_create_front_page_groups",
    "canvas_update_create_page_groups",
    "canvas_update_file",
    "canvas_update_topic_groups",
  ]);
  // The reading itself is a read, so it can never be admitted as a change by its own declaration.
  assert.equal(canvasSemanticCourseTarget(operation("canvas_get_section_information_sections")), undefined);
});

test("every section route that carries a learner's own record without its course is a site request with its own class", () => {
  const sectionWrites = CATALOG.operations.filter((entry) => entry.readOnly === false && entry.path.startsWith("/v1/sections/"));
  assert.equal(sectionWrites.length, 21);
  const grouped = new Map();
  for (const entry of sectionWrites) {
    const admission = canvasOperationAdmission(entry);
    const key = admission.write.state === "held" ? admission.write.reason : admission.siteClass || admission.authority;
    grouped.set(key, [...(grouped.get(key) || []), entry.toolName].sort());
  }
  assert.deepEqual([...grouped.keys()].sort(), ["course", "learner_record", "multi_step_upload_requires_reviewed_transfer", "shared_object"]);
  assert.deepEqual(grouped.get("course"), ["canvas_delete_section", "canvas_edit_section"]);
  // Cross-listing moves the section into a second course, so it is a site request on a shared object.
  assert.deepEqual(grouped.get("shared_object"), ["canvas_cross_list_section", "canvas_de_cross_list_section"]);
  assert.deepEqual(grouped.get("multi_step_upload_requires_reviewed_transfer"), ["canvas_upload_file_sections"]);
  assert.deepEqual(grouped.get("learner_record"), [
    "canvas_clear_unread_status_for_all_submissions_sections",
    "canvas_create_peer_review_sections",
    "canvas_delete_peer_review_sections",
    "canvas_enroll_user_sections",
    "canvas_grade_or_comment_on_multiple_submissions_sections_assignments",
    "canvas_grade_or_comment_on_multiple_submissions_sections_submissions",
    "canvas_grade_or_comment_on_submission_by_anonymous_id_sections",
    "canvas_grade_or_comment_on_submission_sections",
    "canvas_mark_bulk_submissions_as_read_sections",
    "canvas_mark_document_annotations_as_read_sections",
    "canvas_mark_rubric_assessments_as_read_sections_rubric_assessments",
    "canvas_mark_rubric_assessments_as_read_sections_rubric_comments",
    "canvas_mark_submission_as_read_sections",
    "canvas_mark_submission_as_unread_sections",
    "canvas_mark_submission_item_as_read_sections",
    "canvas_submit_assignment_sections",
  ]);
  assert.equal(
    canvasSiteAuthorityNote("learner_record"),
    "It changes a person's record through a section, group, quiz attempt or booking rather than through the selected course, so it can reach a course other than the selected one. Canvas decides it with your own roles.",
  );
  // The learner-object helper recognizes object routes. A section route does not name its course and
  // is a site request; the same record reached through its course is course work.
  assert.equal(canvasLearnerScopeObjectRoute(operation("canvas_grade_or_comment_on_submission_sections")), true);
  assert.equal(canvasLearnerScopeObjectRoute(operation("canvas_edit_section")), false);
  assert.equal(canvasLearnerScopeObjectRoute(operation("canvas_grade_or_comment_on_submission_courses")), false);
  assert.deepEqual(canvasOperationAdmission(operation("canvas_grade_or_comment_on_submission_courses")).write, {
    state: "admitted",
  });
});

test("a reading proves a section only when it names this object and the selected course", () => {
  const sectionTarget = target("canvas_edit_section");
  const now = Date.now();
  const expected = { objectId: "302", courseId: "42", now };
  assert.equal(canvasSemanticResolutionProblem(sectionTarget, freshResolution(), expected), undefined);
  for (const [label, resolution] of [
    ["no reading at all", undefined],
    ["a reading of another course", freshResolution({ courseId: "43" })],
    ["a reading of another section", freshResolution({ objectId: "303" })],
    ["a reading taken through another route", freshResolution({ resolverTool: "canvas_get_section_information_courses" })],
    ["a reading with no snapshot", freshResolution({ snapshotDigest: "" })],
    ["a reading with a non-decimal id", freshResolution({ objectId: "302a" })],
  ]) {
    assert.equal(canvasSemanticResolutionProblem(sectionTarget, resolution, expected), "canvas_semantic_target_course_mismatch", label);
  }
  const stale = freshResolution({ resolvedAt: new Date(now - CANVAS_SEMANTIC_RESOLUTION_MAX_AGE_MS - 1_000).toISOString() });
  assert.equal(canvasSemanticResolutionProblem(sectionTarget, stale, expected), "canvas_semantic_target_resolution_stale");
  assert.equal(
    canvasSemanticResolutionProblem(sectionTarget, freshResolution({ resolvedAt: new Date(now + 120_000).toISOString() }), expected),
    "canvas_semantic_target_resolution_stale",
  );
  assert.equal(canvasSemanticResolutionProblem(sectionTarget, freshResolution({ resolvedAt: "" }), expected), "canvas_semantic_target_resolution_stale");
  // A reading that arrived one page short of the whole answer proves nothing either way.
  assert.equal(canvasSemanticResolvedCourseId(sectionTarget, { ok: true, data: SECTION }, "302"), "42");
  assert.equal(canvasSemanticResolvedCourseId(sectionTarget, { ok: true, truncated: true, data: SECTION }, "302"), "");
  assert.equal(canvasSemanticResolvedCourseId(sectionTarget, { ok: false, status: 404 }, "302"), "");
  assert.equal(canvasSemanticResolvedCourseId(sectionTarget, { ok: true, data: OTHER_COURSE_SECTION }, "303"), "43");
  assert.equal(canvasSemanticResolvedCourseId(sectionTarget, { ok: true, data: { id: "302" } }, "302"), "");
  assert.equal(canvasSemanticResolvedCourseId(sectionTarget, { ok: true, data: [SECTION] }, "302"), "");
  assert.equal(canvasSemanticResolvedCourseId(sectionTarget, { ok: true, data: { id: 302, course_id: 42 } }, "302"), "42");
});

test("the page refuses a section change that carries no current reading, and sends the one it proves", async () => {
  const withoutProof = await executeInPage("canvas_edit_section", { resolution: undefined, args: { id: "302", course_section_name: "Section B evening" } });
  assert.deepEqual(withoutProof.result, { ok: false, sent: false, error: "canvas_semantic_target_course_mismatch" });
  assert.deepEqual(withoutProof.requests, []);

  const otherCourse = await executeInPage("canvas_edit_section", {
    resolution: freshResolution({ courseId: "43" }),
    args: { id: "302", course_section_name: "Section B evening" },
  });
  assert.deepEqual(otherCourse.result, { ok: false, sent: false, error: "canvas_semantic_target_course_mismatch" });
  assert.deepEqual(otherCourse.requests, []);

  const otherSection = await executeInPage("canvas_edit_section", {
    resolution: freshResolution({ objectId: "303" }),
    args: { id: "302", course_section_name: "Section B evening" },
  });
  assert.deepEqual(otherSection.result, { ok: false, sent: false, error: "canvas_semantic_target_course_mismatch" });
  assert.deepEqual(otherSection.requests, []);

  const stale = await executeInPage("canvas_edit_section", {
    resolution: freshResolution({ resolvedAt: new Date(Date.now() - CANVAS_SEMANTIC_RESOLUTION_MAX_AGE_MS - 5_000).toISOString() }),
    args: { id: "302", course_section_name: "Section B evening" },
  });
  assert.deepEqual(stale.result, { ok: false, sent: false, error: "canvas_semantic_target_resolution_stale" });
  assert.deepEqual(stale.requests, []);

  const proved = await executeInPage("canvas_edit_section", {
    resolution: freshResolution(),
    args: { id: "302", course_section_name: "Section B evening" },
  });
  assert.equal(proved.result.ok, true, JSON.stringify(proved.result));
  assert.deepEqual(proved.requests, [{ pathname: "/api/v1/sections/302", method: "PUT" }]);
});

test("the page still refuses every held section route, proof or not", async () => {
  for (const toolName of ["canvas_enroll_user_sections", "canvas_cross_list_section"]) {
    const held = await executeInPage(toolName, {
      resolution: freshResolution(),
      args: { section_id: "302", id: "302", new_course_id: "43", enrollment_user_id: "99", enrollment_type: "StudentEnrollment" },
    });
    assert.deepEqual(held.result, { ok: false, sent: false, error: "canvas_course_scope_required" }, toolName);
    assert.deepEqual(held.requests, [], toolName);
  }
});

test("an object Canvas names no owner for is identified, and its course is left to the listing", () => {
  const fileTarget = canvasSemanticCourseTarget(operation("canvas_delete_file"));
  assert.ok(fileTarget, "a Canvas file deletion names a semantic course object");
  assert.equal(fileTarget.courseCollectionProof, true);

  // Canvas answers for a file with no context field of any kind.
  const file = { ok: true, data: { id: "14113694", folder_id: "1564337", display_name: "guide.txt" } };
  assert.deepEqual(canvasSemanticObjectContext(fileTarget, file, "14113694"), { state: "unnamed_context" });

  // A reading for another object proves nothing, whatever it names.
  assert.deepEqual(canvasSemanticObjectContext(fileTarget, file, "999"), { state: "unproved" });

  // An owner Canvas does name is read as that owner: a course binds, and a
  // person's or an account's object is refused even here.
  assert.deepEqual(
    canvasSemanticObjectContext(fileTarget, { ok: true, data: { id: "5", context_type: "Course", context_id: "89585" } }, "5"),
    { state: "course", courseId: "89585" },
  );
  assert.deepEqual(
    canvasSemanticObjectContext(fileTarget, { ok: true, data: { id: "5", context_type: "User", context_id: "7" } }, "5"),
    { state: "unproved" },
  );
});
