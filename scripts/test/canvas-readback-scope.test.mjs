import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canvasOperationAdmission, canvasReadbackAssessment } from "../../connector/extension/generated/canvas-operation-admission.js";
import { hasNamedCanvasReadback, planBrowserReadback } from "../../connector/extension/generated/canvas-readback-plan.js";

const catalog = JSON.parse(readFileSync(new URL("../../artifacts/canvas-api/canvas-api-catalog.json", import.meta.url), "utf8"));
const operation = (name) => {
  const value = catalog.operations.find((candidate) => candidate.toolName === name);
  assert.ok(value, `missing catalog operation ${name}`);
  return value;
};

const route = (value) => String(value || "").replace(/\{[^}]+\}/g, "{}").replace(/\/$/, "");
const structuralArguments = (write) => Object.fromEntries((write.parameters || []).map((parameter) => [parameter.inputName, "1"]));
const structuralResponse = { id: "1", page_id: "1", rubric_id: "1", url: "morrow-structural-target" };

function routeTier(write, read) {
  const target = route(write.path);
  const candidate = route(read.path);
  if (candidate === target) return "exact";
  if (candidate === `${target}/{}`) return "created_child";
  // A create can also read the object it made through the object route its own route hangs from:
  // POST /v1/folders/{}/folders makes a folder, and one folder is read at /v1/folders/{}. This is
  // the same rule scripts/canvas-admission-report.mjs counts with.
  if (write.method === "POST" && `${candidate}/${target.split("/").pop()}` === target) return "created_child";
  if (`${candidate}/{}` === target) return "parent_collection";
  return "mismatched";
}

test("every generic Canvas readback reads the write target's own resource", () => {
  const mismatched = [];
  for (const write of catalog.operations) {
    if (write.readOnly) continue;
    if (canvasOperationAdmission(write).write.state !== "admitted") continue;
    if (hasNamedCanvasReadback(write)) continue;
    const plan = planBrowserReadback(catalog.operations, write, structuralArguments(write), structuralResponse);
    if (!plan) continue;
    const tier = routeTier(write, plan.readOperation);
    if (tier === "mismatched") mismatched.push(`${write.toolName}: ${write.method} ${write.path} -> ${plan.readOperation.path}`);
  }
  assert.deepEqual(mismatched, []);
});

// The Canvas file upload pre-flights were in this list until they were held before dispatch: an
// upload's first step creates nothing to read back, and only the reviewed course-file transfer runs
// all three steps.
test("Canvas writes with no same-resource read report an unavailable readback instead of a plan", () => {
  const withoutSafeRoute = [
    "canvas_reset_course",
    "canvas_grade_or_comment_on_multiple_submissions_courses_submissions",
    "canvas_create_score",
    "canvas_delete_rubricassociation",
  ];
  for (const name of withoutSafeRoute) {
    const write = operation(name);
    assert.equal(canvasOperationAdmission(write).write.state, "admitted", name);
    assert.equal(planBrowserReadback(catalog.operations, write, structuralArguments(write), structuralResponse), null, name);
    assert.deepEqual(canvasReadbackAssessment(catalog.operations, write), { state: "unavailable", reason: "no_safe_readback_route" }, name);
  }
});

test("a read route outside the written resource is refused even when a read exists", () => {
  const write = {
    toolName: "canvas_reset_course",
    nickname: "reset_course",
    service: "canvas",
    method: "POST",
    path: "/v1/courses/{course_id}/reset_content",
    readOnly: false,
    parameters: [{ inputName: "course_id", wireName: "course_id", location: "path" }],
  };
  const courseRead = {
    toolName: "canvas_get_single_course_courses",
    nickname: "get_single_course_courses",
    service: "canvas",
    method: "GET",
    path: "/v1/courses/{id}",
    readOnly: true,
    parameters: [{ inputName: "id", wireName: "id", location: "path" }],
  };
  assert.equal(planBrowserReadback([write, courseRead], write, { course_id: "42" }, { id: "77" }), null);

  const ownRead = { ...courseRead, path: "/v1/courses/{course_id}/reset_content", parameters: write.parameters };
  const plan = planBrowserReadback([write, ownRead], write, { course_id: "42" }, { id: "77" });
  assert.equal(plan?.readOperation.path, "/v1/courses/{course_id}/reset_content");
});

test("a read path parameter is never filled from an unrelated response id", () => {
  const write = {
    toolName: "canvas_create_thing",
    nickname: "create_thing",
    service: "canvas",
    method: "POST",
    path: "/v1/courses/{course_id}/things",
    readOnly: false,
    parameters: [{ inputName: "course_id", wireName: "course_id", location: "path" }, { inputName: "title", wireName: "title", location: "form" }],
  };
  const childRead = {
    toolName: "canvas_get_thing",
    nickname: "get_thing",
    service: "canvas",
    method: "GET",
    path: "/v1/courses/{course_id}/things/{thing_id}",
    readOnly: true,
    parameters: [{ inputName: "course_id", wireName: "course_id", location: "path" }, { inputName: "thing_id", wireName: "thing_id", location: "path" }],
  };
  const operations = [write, childRead];
  const args = { course_id: "42", title: "Week 1" };
  assert.equal(planBrowserReadback(operations, write, args, { id: "77" }), null);
  assert.equal(planBrowserReadback(operations, write, args, { thing_id: "77", id: "5" })?.arguments.thing_id, "77");
});

test("declared create readbacks keep reading the created child route", () => {
  const cases = [
    { tool: "canvas_create_assignment_group", read: "canvas_get_assignment_group", argument: "assignment_group_id" },
    { tool: "canvas_create_new_discussion_topic_courses", read: "canvas_get_single_topic_courses", argument: "topic_id" },
    { tool: "canvas_create_new_grading_standard_courses", read: "canvas_get_single_grading_standard_in_context_courses", argument: "grading_standard_id" },
    { tool: "canvas_create_external_tool_courses", read: "canvas_get_single_external_tool_courses", argument: "external_tool_id" },
  ];
  for (const entry of cases) {
    const write = operation(entry.tool);
    const plan = planBrowserReadback(catalog.operations, write, { course_id: "42" }, { id: "77" });
    assert.ok(plan, entry.tool);
    assert.equal(plan.readOperation.toolName, entry.read);
    assert.equal(plan.strategy, "created-resource");
    assert.equal(plan.arguments[entry.argument], "77");
    assert.equal(plan.targetId, "77");
    assert.equal(planBrowserReadback(catalog.operations, write, { course_id: "42" }, {}), null, entry.tool);
  }
});

test("New Quizzes and Item Bank readbacks keep their reviewed routes", () => {
  const cases = [
    { tool: "canvas_create_new_quiz", args: { course_id: "42" }, data: { id: "77" }, read: "canvas_get_new_quiz" },
    { tool: "canvas_update_single_quiz", args: { course_id: "42", assignment_id: "77" }, data: { id: "77" }, read: "canvas_get_new_quiz" },
    { tool: "canvas_delete_new_quiz", args: { course_id: "42", assignment_id: "77" }, data: null, read: "canvas_get_new_quiz" },
    { tool: "canvas_create_quiz_item", args: { course_id: "42", assignment_id: "77" }, data: { id: "88" }, read: "canvas_get_quiz_item" },
    { tool: "canvas_update_quiz_item", args: { course_id: "42", assignment_id: "77", item_id: "88" }, data: null, read: "canvas_get_quiz_item" },
    { tool: "canvas_delete_quiz_item", args: { course_id: "42", assignment_id: "77", item_id: "88" }, data: null, read: "canvas_get_quiz_item" },
    { tool: "canvas_item_bank_create_bank", args: { title: "Anatomy" }, data: { id: "901" }, read: "canvas_item_bank_get_bank" },
    { tool: "canvas_item_bank_archive_bank", args: { bank_id: "901" }, data: {}, read: "canvas_item_bank_get_bank" },
    { tool: "canvas_item_bank_attach_item", args: { bank_id: "901", item_id: "501" }, data: { id: "701" }, read: "canvas_item_bank_list_entries" },
    { tool: "canvas_item_bank_create_item", args: { bank_id: "901" }, data: { id: "502" }, read: "canvas_item_bank_get_item" },
    { tool: "canvas_item_bank_update_item", args: { bank_id: "901", item_id: "502" }, data: { id: "502" }, read: "canvas_item_bank_get_item" },
    { tool: "canvas_item_bank_delete_entry", args: { bank_id: "901", bank_entry_id: "701" }, data: {}, read: "canvas_item_bank_get_entry" },
    { tool: "canvas_item_bank_share_bank", args: { bank_id: "901", entity_type: "Course", entity_id: "42" }, data: { id: "801" }, read: "canvas_item_bank_list_shares" },
  ];
  for (const entry of cases) {
    const plan = planBrowserReadback(catalog.operations, operation(entry.tool), entry.args, entry.data);
    assert.ok(plan, entry.tool);
    assert.equal(plan.readOperation.toolName, entry.read, entry.tool);
  }
  for (const tool of ["canvas_create_new_quiz", "canvas_update_single_quiz", "canvas_delete_new_quiz", "canvas_create_quiz_item", "canvas_update_quiz_item", "canvas_delete_quiz_item"]) {
    assert.deepEqual(canvasReadbackAssessment(catalog.operations, operation(tool)), { state: "structurally_exact" }, tool);
  }
});
