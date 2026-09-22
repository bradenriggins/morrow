import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canvasOperationAdmission } from "../../connector/extension/generated/canvas-operation-admission.js";
import { categoriesForBinding } from "../../connector/extension/src/edit-policy.js";

// WI-3.1: `area`, `kind`, `reach` and `learnerVisible` are facts a generated catalog option carries
// with no person's judgment, computed from the operation alone (MORROW-UX-BUILD-SPEC.md, WI-3.1).
// A curated bundle (WI-3.2, WI-3.3) may carry `routine` and `rememberable` on its own spec, and
// those pass through unchanged; this file tests the four computed facts only.

const root = new URL("../../", import.meta.url);
const canvasOperations = JSON.parse(readFileSync(new URL("connector/extension/generated/canvas-api-catalog.json", root), "utf8"))
  .operations.map((operation) => ({ ...operation, provider: "canvas" }));
const moodleOperations = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8")).operations;

const canvasOptions = categoriesForBinding({ provider: "canvas" }, canvasOperations).filter((option) => option.id.startsWith("action:canvas:"));
const moodleOptions = categoriesForBinding({ provider: "moodle" }, moodleOperations).filter((option) => option.id.startsWith("action:moodle:"));
const generatedOptions = [...canvasOptions, ...moodleOptions];

const VALID_AREAS = new Set(["pages", "assignments", "quizzes", "discussions", "files", "calendar", "people", "accessibility", "beyond_course", "other"]);
const VALID_KINDS = new Set(["edit", "publish", "remove"]);

function canvasToolName(id) {
  return id.slice("action:canvas:".length);
}

function canvasOperation(toolName) {
  return canvasOperations.find((operation) => operation.toolName === toolName);
}

test("every generated option carries an area, a kind and a reach, each a valid value", () => {
  assert.ok(generatedOptions.length > 0);
  for (const option of generatedOptions) {
    assert.ok(VALID_AREAS.has(option.area), `${option.id} area "${option.area}"`);
    assert.ok(VALID_KINDS.has(option.kind), `${option.id} kind "${option.kind}"`);
    assert.ok(option.reach === "course" || option.reach === "beyond", `${option.id} reach "${option.reach}"`);
    assert.equal(typeof option.learnerVisible, "boolean", option.id);
  }
});

test("a Canvas option beyond the course is area beyond_course and reach beyond; one inside it is placed by its catalog resource", () => {
  const pages = ["canvas_create_page_courses", "canvas_delete_page_courses"];
  const assignments = ["canvas_edit_assignment", "canvas_delete_assignment"];
  const quizzes = ["canvas_create_quiz", "canvas_delete_quiz"];
  const discussions = ["canvas_create_new_discussion_topic_courses"];
  const files = ["canvas_update_file"];
  const calendar = ["canvas_create_calendar_event"];
  const people = ["canvas_create_course_section"];
  const expectedArea = new Map([
    ...pages.map((name) => [name, "pages"]),
    ...assignments.map((name) => [name, "assignments"]),
    ...quizzes.map((name) => [name, "quizzes"]),
    ...discussions.map((name) => [name, "discussions"]),
    ...files.map((name) => [name, "files"]),
    ...calendar.map((name) => [name, "calendar"]),
    ...people.map((name) => [name, "people"]),
  ]);
  for (const [toolName, area] of expectedArea) {
    const option = canvasOptions.find((entry) => entry.id === `action:canvas:${toolName}`);
    assert.ok(option, toolName);
    assert.equal(option.area, area, toolName);
    assert.equal(option.reach, "course", toolName);
  }

  const beyond = canvasOptions.filter((option) => canvasOperationAdmission(canvasOperation(canvasToolName(option.id))).authority === "site");
  assert.ok(beyond.length > 0);
  for (const option of beyond) {
    assert.equal(option.area, "beyond_course", option.id);
    assert.equal(option.reach, "beyond", option.id);
  }
});

// The build's own keyword pass over Canvas catalog resources (MORROW-UX-BUILD-SPEC.md, WI-3.1)
// documents that dozens of course-scoped Canvas options its resource table does not name stay
// "other", and that placing them is a person's job, not this function's. This pins the exact count
// so a catalog change that moves it is seen and corrected on purpose, the way every other pin in
// this build is (AGENT-BRIEF.md, "Pins are changed on purpose").
test("the Canvas options a resource table cannot place stay other, a fixed and reported count", () => {
  const courseScoped = canvasOptions.filter((option) => option.reach === "course");
  const other = courseScoped.filter((option) => option.area === "other");
  assert.equal(other.length, 84);
});

test("reach agrees with the admission class for every Canvas option", () => {
  for (const option of canvasOptions) {
    const operation = canvasOperation(canvasToolName(option.id));
    const beyond = canvasOperationAdmission(operation).authority === "site";
    assert.equal(option.reach, beyond ? "beyond" : "course", option.id);
    assert.equal(option.area === "beyond_course", beyond, option.id);
  }
});

test("every Moodle option is course reach, because the Bridge admits no Moodle site-level write", () => {
  assert.ok(moodleOptions.length > 0);
  for (const option of moodleOptions) {
    assert.equal(option.reach, "course", option.id);
  }
});

test("kind agrees with destructive: remove exactly when destructive, never otherwise", () => {
  for (const option of generatedOptions) {
    assert.equal(option.kind === "remove", option.destructive === true, option.id);
  }
});

test("a Moodle tool that only shows or hides existing content is kind publish, not edit", () => {
  const toggles = ["moodle_show_course", "moodle_hide_course", "moodle_show_section", "moodle_hide_section", "moodle_show_activity", "moodle_hide_activity"];
  for (const toolName of toggles) {
    const option = moodleOptions.find((entry) => entry.id === `action:moodle:${toolName}`);
    assert.ok(option, toolName);
    assert.equal(option.kind, "publish", toolName);
    assert.equal(option.destructive, false, toolName);
  }
});

test("learnerVisible is true for a tool named after a learner-facing action or resource, and for a changed field that names one", () => {
  for (const toolName of ["canvas_post_reply_courses", "canvas_post_entry_courses", "canvas_enroll_user_courses"]) {
    const option = canvasOptions.find((entry) => entry.id === `action:canvas:${toolName}`);
    assert.ok(option, toolName);
    assert.equal(option.learnerVisible, true, toolName);
  }
  // canvas_create_assignment changes assignment_published, assignment_due_at, assignment_lock_at
  // and assignment_unlock_at among 45 fields: no field alone is granted (requiresFieldSelection),
  // but the option itself is still learner-visible because one of those fields names a
  // learner-facing change.
  const createAssignment = canvasOptions.find((entry) => entry.id === "action:canvas:canvas_create_assignment");
  assert.equal(createAssignment.learnerVisible, true);

  // An Assignment Group carries a name, a weight and a position: no field that names a
  // learner-facing change, and its resource is not one of the learner-visible resources.
  const assignmentGroup = canvasOptions.find((entry) => entry.id === "action:canvas:canvas_create_assignment_group");
  assert.equal(assignmentGroup.learnerVisible, false);
});
