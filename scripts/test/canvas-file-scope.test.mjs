import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInThisContext } from "node:vm";
import { canvasOperationAdmission } from "../../connector/extension/generated/canvas-operation-admission.js";
import {
  CANVAS_SEMANTIC_RESOLUTION_MAX_AGE_MS,
  canvasSemanticCourseCollectionState,
  canvasSemanticCourseTarget,
  canvasSemanticObjectVersion,
  canvasSemanticResolutionProblem,
  canvasSemanticResolvedCourseId,
  canvasSemanticVersionState,
} from "../../connector/extension/generated/canvas-semantic-target.js";

const ORIGIN = "https://school.instructure.com";
const CONTENT_SOURCE = readFileSync(new URL("../../connector/extension/src/canvas-content.js", import.meta.url), "utf8");
const CATALOG = JSON.parse(readFileSync(new URL("../../connector/extension/generated/canvas-api-catalog.json", import.meta.url), "utf8"));

// 601 is the selected course's own file, 701 belongs to another course, and 702 hangs from the
// Canvas account rather than from any course. 84 is the course's own folder.
const COURSE_FILE = {
  id: "601", context_type: "Course", context_id: "42", folder_id: "84",
  display_name: "Syllabus.pdf", filename: "syllabus.pdf", "content-type": "application/pdf",
  size: 20480, updated_at: "2026-09-06T12:00:00Z",
};
const OTHER_COURSE_FILE = { ...COURSE_FILE, id: "701", context_id: "43", folder_id: "86" };
const ACCOUNT_FILE = { ...COURSE_FILE, id: "702", context_type: "Account", context_id: "5" };
const COURSE_FOLDER = { id: "84", context_type: "Course", context_id: "42", name: "Week 1", parent_folder_id: "80", updated_at: "2026-09-06T12:00:00Z" };
const DIGEST = "a".repeat(64);

const FILE_WRITES = ["canvas_delete_file", "canvas_update_file"];
const FOLDER_WRITES = ["canvas_create_folder_folders"];

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

function fileResolution(overrides = {}) {
  return {
    objectId: "601",
    courseId: "42",
    resolverTool: "canvas_get_file_files",
    resolvedAt: new Date().toISOString(),
    snapshotDigest: DIGEST,
    objectVersion: { id: "601", updated_at: COURSE_FILE.updated_at, size: COURSE_FILE.size, "content-type": COURSE_FILE["content-type"] },
    ...overrides,
  };
}

function folderResolution(overrides = {}) {
  return {
    objectId: "84",
    courseId: "42",
    resolverTool: "canvas_get_folder_folders",
    resolvedAt: new Date().toISOString(),
    snapshotDigest: DIGEST,
    objectVersion: { id: "84", updated_at: COURSE_FOLDER.updated_at },
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
    location: { origin: ORIGIN, pathname: "/courses/42/files" },
    document: { cookie: "_csrf_token=csrf-value; _legacy_normandy_session=session" },
    fetch: async (input, options = {}) => {
      const url = new URL(String(input?.href ?? input), ORIGIN);
      if (url.pathname === "/api/v1/users/self/profile") return jsonResponse({ id: "7", name: "Teacher" });
      if (url.pathname === "/api/v1/courses/42") return jsonResponse({ id: "42", name: "Biology" });
      requests.push({ pathname: url.pathname, method: options.method || "GET" });
      return jsonResponse({ ...COURSE_FILE, display_name: "Syllabus 2026.pdf" });
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

test("only renaming, moving, removing a course file and adding a folder inside one declare a reading", () => {
  const fileTarget = {
    object: "file",
    objectParameter: "id",
    resolverRead: "canvas_get_file_files",
    courseField: "context_id",
    courseCollectionRead: "canvas_list_files_courses",
    contextField: "context_type",
    contextValue: "Course",
    courseCollectionProof: true,
    versionFields: ["id", "updated_at", "size", "content-type"],
    versionTimestampField: "updated_at",
    destinationParameter: "parent_folder_id",
    destinationCollectionRead: "canvas_list_all_folders_courses",
    requiredInputs: { on_duplicate: "rename" },
    readbackFields: { name: "display_name", parent_folder_id: "folder_id" },
    unsavedInputs: ["on_duplicate"],
  };
  const folderTarget = {
    object: "folder",
    objectParameter: "folder_id",
    readParameter: "id",
    resolverRead: "canvas_get_folder_folders",
    courseField: "context_id",
    courseCollectionRead: "canvas_list_all_folders_courses",
    contextField: "context_type",
    contextValue: "Course",
    courseCollectionProof: true,
    versionFields: ["id", "updated_at"],
    versionTimestampField: "updated_at",
    refusedParameters: ["parent_folder_id", "parent_folder_path"],
    childParentField: "parent_folder_id",
  };
  for (const toolName of FILE_WRITES) {
    assert.deepEqual(target(toolName), fileTarget, toolName);
    assert.equal(canvasOperationAdmission(operation(toolName)).write.state, "admitted", toolName);
  }
  for (const toolName of FOLDER_WRITES) {
    assert.deepEqual(target(toolName), folderTarget, toolName);
    assert.equal(canvasOperationAdmission(operation(toolName)).write.state, "admitted", toolName);
  }
  const declared = CATALOG.operations
    .filter((entry) => ["file", "folder"].includes(canvasSemanticCourseTarget(entry)?.object))
    .map((entry) => entry.toolName)
    .sort();
  assert.deepEqual(declared, [...FILE_WRITES, ...FOLDER_WRITES].sort());

  // Every reading the connector needs is a read, so none can be admitted by its own declaration,
  // and each stays addressable from the ids Morrow already holds: the object, and the course.
  for (const [toolName, path, parameter] of [
    ["canvas_get_file_files", "/v1/files/{id}", "id"],
    ["canvas_get_folder_folders", "/v1/folders/{id}", "id"],
    ["canvas_list_files_courses", "/v1/courses/{course_id}/files", "course_id"],
    ["canvas_list_all_folders_courses", "/v1/courses/{course_id}/folders", "course_id"],
  ]) {
    const read = operation(toolName);
    assert.equal(read.readOnly, true, toolName);
    assert.equal(read.path, path, toolName);
    assert.equal(canvasSemanticCourseTarget(read), undefined, toolName);
    assert.deepEqual(read.parameters.filter((entry) => entry.location === "path").map((entry) => entry.inputName), [parameter], toolName);
  }
});

test("every other Canvas file and folder write stays held, including both copy routes", () => {
  const writes = CATALOG.operations.filter((entry) => entry.readOnly === false && /^\/v1\/(?:files|folders)(?:\/|$)/.test(entry.path));
  assert.equal(writes.length, 10);
  const grouped = new Map();
  for (const entry of writes) {
    const write = canvasOperationAdmission(entry).write;
    const key = write.state === "held" ? write.reason : write.state;
    grouped.set(key, [...(grouped.get(key) || []), entry.toolName].sort());
  }
  assert.deepEqual([...grouped.keys()].sort(), ["admitted", "cross_course_object_requires_resolution"]);
  assert.deepEqual(grouped.get("admitted"), [...FILE_WRITES, ...FOLDER_WRITES].sort());
  // A copy lands in a second object, and the reading that proves the source proves nothing about
  // where the copy goes. The folder object itself, the file word count, the link verifier reset and
  // the folder upload pre-flight have no reading declared for them either.
  assert.deepEqual(grouped.get("cross_course_object_requires_resolution"), [
    "canvas_copy_file",
    "canvas_copy_folder",
    "canvas_delete_folder",
    "canvas_reset_link_verifier",
    "canvas_update_folder",
    "canvas_update_word_count",
    "canvas_upload_file_v1_folders_folder_id_files_post",
  ]);
  // The file routes under an account, a group, or one person keep their own holds.
  for (const [toolName, reason] of [
    ["canvas_upload_file_v1_users_user_id_files_post", "course_scope_required"],
    ["canvas_upload_file_v1_groups_group_id_files_post", "cross_course_object_requires_resolution"],
    ["canvas_create_folder_accounts", "account_authority_required"],
    ["canvas_upload_file_sections", "learner_scope_requires_separate_authority"],
  ]) {
    assert.deepEqual(canvasOperationAdmission(operation(toolName)).write, { state: "held", reason }, toolName);
  }
});

test("a reading proves a file only when a course owns it, it is this file, and the course lists it", () => {
  const fileTarget = target("canvas_update_file");
  assert.equal(canvasSemanticResolvedCourseId(fileTarget, { ok: true, data: COURSE_FILE }, "601"), "42");
  assert.equal(canvasSemanticResolvedCourseId(fileTarget, { ok: true, data: OTHER_COURSE_FILE }, "701"), "43");
  // A file the account owns proves no course, whatever else the reading carries.
  assert.equal(canvasSemanticResolvedCourseId(fileTarget, { ok: true, data: ACCOUNT_FILE }, "702"), "");
  assert.equal(canvasSemanticResolvedCourseId(fileTarget, { ok: true, data: { ...ACCOUNT_FILE, context_id: "42" } }, "702"), "");
  // A file whose reading carries no owner at all is refused rather than assumed to be this course's.
  assert.equal(canvasSemanticResolvedCourseId(fileTarget, { ok: true, data: { id: "601", display_name: "Syllabus.pdf" } }, "601"), "");
  assert.equal(canvasSemanticResolvedCourseId(fileTarget, { ok: true, data: { id: 601, context_type: "Course", context_id: 42 } }, "601"), "42");
  assert.equal(canvasSemanticResolvedCourseId(fileTarget, { ok: true, data: COURSE_FILE }, "701"), "");
  assert.equal(canvasSemanticResolvedCourseId(fileTarget, { ok: true, truncated: true, data: COURSE_FILE }, "601"), "");
  assert.equal(canvasSemanticResolvedCourseId(fileTarget, { ok: false, status: 404 }, "601"), "");

  // The file reading alone is not the whole proof: the selected course's own complete list of files
  // has to name it, and a list that could not be read to its last page says nothing either way.
  assert.equal(fileTarget.courseCollectionProof, true);
  assert.equal(canvasSemanticCourseCollectionState(fileTarget, { ok: true, data: [{ id: "600" }, { id: 601 }] }, "601"), "listed");
  assert.equal(canvasSemanticCourseCollectionState(fileTarget, { ok: true, data: [{ id: "600" }] }, "601"), "absent");
  assert.equal(canvasSemanticCourseCollectionState(fileTarget, { ok: true, truncated: true, data: [{ id: "600" }] }, "601"), "unreadable");
  assert.equal(canvasSemanticCourseCollectionState(fileTarget, { ok: false, status: 403 }, "601"), "unreadable");

  const folderTarget = target("canvas_create_folder_folders");
  assert.equal(canvasSemanticResolvedCourseId(folderTarget, { ok: true, data: COURSE_FOLDER }, "84"), "42");
  assert.equal(canvasSemanticResolvedCourseId(folderTarget, { ok: true, data: { ...COURSE_FOLDER, context_type: "User" } }, "84"), "");
});

test("the frozen version says which saved file the change was sent for", () => {
  const fileTarget = target("canvas_update_file");
  const version = canvasSemanticObjectVersion(fileTarget, { ok: true, data: COURSE_FILE }, "601");
  assert.deepEqual(version, { id: "601", updated_at: "2026-09-06T12:00:00Z", size: 20480, "content-type": "application/pdf" });
  // The frozen version carries no link: a Canvas file link holds a signed verifier, and no verifier
  // belongs in a result or a saved record.
  assert.deepEqual(Object.keys(version).filter((key) => /url/i.test(key)), []);
  assert.equal(canvasSemanticObjectVersion(fileTarget, { ok: true, data: COURSE_FILE }, "701"), undefined);
  assert.equal(canvasSemanticObjectVersion(fileTarget, { ok: true, truncated: true, data: COURSE_FILE }, "601"), undefined);
  // A section carries no declared version, so nothing is frozen for one.
  assert.equal(canvasSemanticObjectVersion(target("canvas_edit_section"), { ok: true, data: { id: "302", course_id: "42" } }, "302"), undefined);

  // A rename keeps the bytes and moves the saved-at time forward.
  const renamed = { ...COURSE_FILE, display_name: "Syllabus 2026.pdf", updated_at: "2026-09-06T12:30:00Z" };
  assert.equal(canvasSemanticVersionState(fileTarget, version, { ok: true, data: renamed }, "601"), "same_object");
  assert.equal(canvasSemanticVersionState(fileTarget, version, { ok: true, data: COURSE_FILE }, "601"), "same_object");
  // Different bytes, a different type, or a different file are all a different saved object.
  assert.equal(canvasSemanticVersionState(fileTarget, version, { ok: true, data: { ...renamed, size: 40960 } }, "601"), "changed");
  assert.equal(canvasSemanticVersionState(fileTarget, version, { ok: true, data: { ...renamed, "content-type": "text/plain" } }, "601"), "changed");
  assert.equal(canvasSemanticVersionState(fileTarget, version, { ok: true, data: { ...renamed, id: "701" } }, "601"), "changed");
  // A reading older than the frozen one is an earlier copy, not proof of the change.
  assert.equal(canvasSemanticVersionState(fileTarget, version, { ok: true, data: { ...COURSE_FILE, updated_at: "2026-09-05T09:00:00Z" } }, "601"), "changed");
  // A frozen field the reading does not carry proves nothing either way.
  const withoutSize = { ...renamed };
  delete withoutSize.size;
  assert.equal(canvasSemanticVersionState(fileTarget, version, { ok: true, data: withoutSize }, "601"), "unreadable");
  assert.equal(canvasSemanticVersionState(fileTarget, version, { ok: false, status: 404 }, "601"), "unreadable");
  assert.equal(canvasSemanticVersionState(fileTarget, undefined, { ok: true, data: renamed }, "601"), "unreadable");
});

test("a frozen reading has to name this file, this course, its saved version and its destination", () => {
  const fileTarget = target("canvas_update_file");
  const now = Date.now();
  const expected = { objectId: "601", courseId: "42", now };
  assert.equal(canvasSemanticResolutionProblem(fileTarget, fileResolution(), expected), undefined);
  for (const [label, resolution] of [
    ["no reading at all", undefined],
    ["a reading of another course", fileResolution({ courseId: "43" })],
    ["a reading of another file", fileResolution({ objectId: "701" })],
    ["a reading taken through another route", fileResolution({ resolverTool: "canvas_list_files_courses" })],
    ["a reading with no snapshot", fileResolution({ snapshotDigest: "" })],
    ["a reading with no saved version", fileResolution({ objectVersion: undefined })],
    ["a saved version of another file", fileResolution({ objectVersion: { id: "701" } })],
    ["a destination this change did not ask for", fileResolution({ destinationId: "85" })],
  ]) {
    assert.equal(canvasSemanticResolutionProblem(fileTarget, resolution, expected), "canvas_semantic_target_course_mismatch", label);
  }
  // A move is proved for the exact destination it asks for, and for no other.
  const moving = { ...expected, destinationId: "85" };
  assert.equal(canvasSemanticResolutionProblem(fileTarget, fileResolution({ destinationId: "85" }), moving), undefined);
  assert.equal(canvasSemanticResolutionProblem(fileTarget, fileResolution(), moving), "canvas_semantic_target_course_mismatch");
  assert.equal(canvasSemanticResolutionProblem(fileTarget, fileResolution({ destinationId: "86" }), moving), "canvas_semantic_target_course_mismatch");

  const stale = fileResolution({ resolvedAt: new Date(now - CANVAS_SEMANTIC_RESOLUTION_MAX_AGE_MS - 1_000).toISOString() });
  assert.equal(canvasSemanticResolutionProblem(fileTarget, stale, expected), "canvas_semantic_target_resolution_stale");
});

test("the page sends a course file change only with a current reading of that exact file", async () => {
  const args = { id: "601", name: "Syllabus 2026.pdf", on_duplicate: "rename" };

  const withoutProof = await executeInPage("canvas_update_file", { resolution: undefined, args });
  assert.deepEqual(withoutProof.result, { ok: false, sent: false, error: "canvas_semantic_target_course_mismatch" });
  assert.deepEqual(withoutProof.requests, []);

  const otherCourse = await executeInPage("canvas_update_file", { resolution: fileResolution({ courseId: "43" }), args });
  assert.deepEqual(otherCourse.result, { ok: false, sent: false, error: "canvas_semantic_target_course_mismatch" });
  assert.deepEqual(otherCourse.requests, []);

  // A reading of another file, including one the account owns, never stands in for this one.
  for (const objectId of ["701", "702"]) {
    const otherFile = await executeInPage("canvas_update_file", { resolution: fileResolution({ objectId }), args });
    assert.deepEqual(otherFile.result, { ok: false, sent: false, error: "canvas_semantic_target_course_mismatch" }, objectId);
    assert.deepEqual(otherFile.requests, [], objectId);
  }

  const stale = await executeInPage("canvas_update_file", {
    resolution: fileResolution({ resolvedAt: new Date(Date.now() - CANVAS_SEMANTIC_RESOLUTION_MAX_AGE_MS - 5_000).toISOString() }),
    args,
  });
  assert.deepEqual(stale.result, { ok: false, sent: false, error: "canvas_semantic_target_resolution_stale" });
  assert.deepEqual(stale.requests, []);

  const renamed = await executeInPage("canvas_update_file", { resolution: fileResolution(), args });
  assert.equal(renamed.result.ok, true, JSON.stringify(renamed.result));
  assert.deepEqual(renamed.requests, [{ pathname: "/api/v1/files/601", method: "PUT" }]);

  // The reading names the file, so it cannot carry a change to a different file.
  const otherTarget = await executeInPage("canvas_update_file", { resolution: fileResolution(), args: { ...args, id: "701" } });
  assert.deepEqual(otherTarget.result, { ok: false, sent: false, error: "canvas_semantic_target_course_mismatch" });
  assert.deepEqual(otherTarget.requests, []);

  const removed = await executeInPage("canvas_delete_file", { resolution: fileResolution(), args: { id: "601" } });
  assert.equal(removed.result.ok, true, JSON.stringify(removed.result));
  assert.deepEqual(removed.requests, [{ pathname: "/api/v1/files/601", method: "DELETE" }]);
});

test("the page sends a move only to the folder the reading proved, and never overwrites a file", async () => {
  const args = { id: "601", parent_folder_id: "85", on_duplicate: "rename" };

  const moved = await executeInPage("canvas_update_file", { resolution: fileResolution({ destinationId: "85" }), args });
  assert.equal(moved.result.ok, true, JSON.stringify(moved.result));
  assert.deepEqual(moved.requests, [{ pathname: "/api/v1/files/601", method: "PUT" }]);

  // A reading that proves no destination, or proves a different one, does not carry this move.
  for (const [label, resolution] of [
    ["no destination", fileResolution()],
    ["another destination", fileResolution({ destinationId: "86" })],
  ]) {
    const refused = await executeInPage("canvas_update_file", { resolution, args });
    assert.deepEqual(refused.result, { ok: false, sent: false, error: "canvas_semantic_target_course_mismatch" }, label);
    assert.deepEqual(refused.requests, [], label);
  }

  // Canvas removes a file that already has the new name unless it is told to keep both, so Morrow
  // sends the change only with that instruction.
  for (const onDuplicate of [undefined, "overwrite"]) {
    const clash = await executeInPage("canvas_update_file", {
      resolution: fileResolution(),
      args: { id: "601", name: "Syllabus 2026.pdf", ...(onDuplicate === undefined ? {} : { on_duplicate: onDuplicate }) },
    });
    assert.deepEqual(clash.result, { ok: false, sent: false, error: "canvas_semantic_target_input_refused" }, String(onDuplicate));
    assert.deepEqual(clash.requests, [], String(onDuplicate));
  }
});

test("the page adds a folder only inside the folder the reading proved", async () => {
  const created = await executeInPage("canvas_create_folder_folders", {
    resolution: folderResolution(),
    args: { folder_id: "84", name: "Week 3" },
  });
  assert.equal(created.result.ok, true, JSON.stringify(created.result));
  assert.deepEqual(created.requests, [{ pathname: "/api/v1/folders/84/folders", method: "POST" }]);

  const otherParent = await executeInPage("canvas_create_folder_folders", {
    resolution: folderResolution({ objectId: "86" }),
    args: { folder_id: "84", name: "Week 3" },
  });
  assert.deepEqual(otherParent.result, { ok: false, sent: false, error: "canvas_semantic_target_course_mismatch" });
  assert.deepEqual(otherParent.requests, []);

  // A folder path names a place Morrow cannot read back to one course, so it is refused before
  // anything is sent, and so is a second parent folder the reading did not prove.
  const path = await executeInPage("canvas_create_folder_folders", {
    resolution: folderResolution(),
    args: { folder_id: "84", name: "Week 3", parent_folder_path: "course files/Week 2" },
  });
  assert.deepEqual(path.result, { ok: false, sent: false, error: "canvas_semantic_target_input_refused" });
  assert.deepEqual(path.requests, []);

  const secondParent = await executeInPage("canvas_create_folder_folders", {
    resolution: folderResolution(),
    args: { folder_id: "84", name: "Week 3", parent_folder_id: "85" },
  });
  assert.deepEqual(secondParent.result, { ok: false, sent: false, error: "canvas_semantic_target_input_refused" });
  assert.deepEqual(secondParent.requests, []);
});

test("the page still refuses every held file and folder route, proof or not", async () => {
  for (const toolName of ["canvas_copy_file", "canvas_copy_folder", "canvas_update_folder", "canvas_delete_folder"]) {
    const held = await executeInPage(toolName, {
      resolution: fileResolution(),
      args: { id: "84", dest_folder_id: "84", source_file_id: "601", source_folder_id: "84", name: "Week 1" },
    });
    assert.deepEqual(held.result, { ok: false, sent: false, error: "canvas_course_scope_required" }, toolName);
    assert.deepEqual(held.requests, [], toolName);
  }
});
