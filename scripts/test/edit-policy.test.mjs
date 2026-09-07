import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { categoriesForBinding, changedFields, createEditPermission } from "../../connector/extension/src/edit-policy.js";
import { matchesBridgeEditPermission } from "../../packages/bridge-protocol/dist/index.js";

const root = new URL("../../", import.meta.url);
const moodleOperations = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8")).operations;
const options = categoriesForBinding({ provider: "moodle" }, moodleOperations);
const option = (toolName) => options.find((entry) => entry.id === `action:moodle:${toolName}`);

const LIFECYCLE_GROUP = "Moodle · Course lifecycle";
const WHOLE_COURSE_TOOLS = ["moodle_hide_course", "moodle_show_course"];
// A course format change removes nothing, so it is not destructive, but it moves every section and
// activity in the course. It belongs with the other whole-course actions and carries its own note.
const COURSE_FORMAT_TOOL = "moodle_change_course_format";
const IDENTITY_ARGUMENTS = ["after_chapter_id", "category_id", "chapter_id", "grade_item_id", "section_name", "section_number", "slot_id", "user_id"];
// An enrolment or role write changes what one person can reach in the course rather than the
// course's content, so the whole family has its own group. Unenrolling is destructive and still
// belongs there, with the rest of the family, instead of with the content lifecycle actions.
const ENROLMENT_TOOLS = ["moodle_enrol_participant", "moodle_suspend_participant", "moodle_unenrol_participant", "moodle_assign_role", "moodle_remove_role"];
// Restoring a course copies a whole course into this one, so it carries the backup and reuse group
// rather than the per-content lifecycle group. It is destructive and stays with its own family.
const OWN_GROUP_TOOLS = [...ENROLMENT_TOOLS, "moodle_start_course_restore"];
const CATALOG_DIGEST = "b".repeat(64);
const binding = {
  sourceBindingId: "moodle:course-2",
  provider: "moodle",
  origin: "https://moodle.example.edu",
  siteUrl: "https://moodle.example.edu",
  principalFingerprint: "a".repeat(64),
  courseId: "2",
  sessionGeneration: 1,
};

function bridgeBinding(permission) {
  return { sourceBindingId: binding.sourceBindingId, provider: "moodle", courseId: binding.courseId, runtimeVerified: true, editPermission: permission };
}

test("a Moodle write that removes content or changes whole-course visibility states its wider effect", () => {
  const deleteChapter = option("moodle_delete_book_chapter");
  assert.equal(deleteChapter.availability, "edit");
  assert.equal(deleteChapter.group, LIFECYCLE_GROUP);
  assert.equal(deleteChapter.tier, "destructive");
  assert.match(deleteChapter.description, /It removes or replaces saved course content for everyone in the course, and Morrow cannot undo it\.$/);

  const replacePackage = option("moodle_replace_scorm_package");
  assert.equal(replacePackage.group, LIFECYCLE_GROUP);
  assert.match(replacePackage.description, /It removes or replaces saved course content for everyone in the course, and Morrow cannot undo it\.$/);
  assert.ok(replacePackage.description.length <= 1_000);

  for (const toolName of WHOLE_COURSE_TOOLS) {
    const wholeCourse = option(toolName);
    assert.equal(wholeCourse.availability, "edit", toolName);
    assert.equal(wholeCourse.group, LIFECYCLE_GROUP, toolName);
    assert.match(wholeCourse.description, /It changes whether the whole course is visible to every enrolled learner, not one activity in it\.$/, toolName);
  }

  const changeFormat = option(COURSE_FORMAT_TOOL);
  assert.equal(changeFormat.availability, "edit");
  assert.equal(changeFormat.group, LIFECYCLE_GROUP);
  assert.equal(changeFormat.tier, "standard");
  assert.match(changeFormat.description, /It changes where every section and every activity in the course appears for everyone in it, not one activity, and Morrow cannot put the previous layout back\.$/);
  assert.ok(changeFormat.description.length <= 1_000);
});

test("the course lifecycle group holds exactly those actions and keeps them out of the per-noun groups", () => {
  const expected = moodleOperations
    .filter((operation) => operation.readOnly === false && !OWN_GROUP_TOOLS.includes(operation.toolName)
      && (operation.destructive === true || WHOLE_COURSE_TOOLS.includes(operation.toolName) || operation.toolName === COURSE_FORMAT_TOOL))
    .map((operation) => `action:moodle:${operation.toolName}`)
    .sort();
  assert.ok(expected.length > 0);
  assert.deepEqual(options.filter((entry) => entry.group === LIFECYCLE_GROUP).map((entry) => entry.id).sort(), expected);

  const bookChapterGroup = options.filter((entry) => entry.group === "Moodle · Book Chapter").map((entry) => entry.id);
  assert.ok(bookChapterGroup.includes("action:moodle:moodle_update_book_chapter"));
  assert.equal(bookChapterGroup.includes("action:moodle:moodle_delete_book_chapter"), false);

  const updateAssignment = option("moodle_update_assignment");
  assert.equal(updateAssignment.group, "Moodle · Assignment");
  assert.equal(updateAssignment.tier, "standard");
  assert.doesNotMatch(updateAssignment.description, /whole course|cannot undo it/);
});

test("no Moodle Edit action grants an identity argument as a changed field", async () => {
  const enabledCategories = options.filter((entry) => entry.availability === "edit").map((entry) => entry.id);
  assert.ok(enabledCategories.length > 0);
  const permission = await createEditPermission({ binding, catalogDigest: CATALOG_DIGEST, revision: 1, enabledCategories, operations: moodleOperations });
  const granted = new Set(permission.rules.flatMap((rule) => rule.allowedChangedFields));
  for (const field of IDENTITY_ARGUMENTS) assert.equal(granted.has(field), false, field);
  assert.ok(granted.has("title") && granted.has("content"), "the derived Moodle grants no longer name any editable field");
});

test("a granted Moodle Book chapter edit still authorizes the exact write it named", async () => {
  const permission = await createEditPermission({
    binding, catalogDigest: CATALOG_DIGEST, revision: 1, operations: moodleOperations,
    enabledCategories: ["action:moodle:moodle_update_book_chapter"],
  });
  assert.deepEqual(permission.rules, [{
    operationKey: "moodle.form.mod.book.chapter.write.v1",
    toolName: "moodle_update_book_chapter",
    allowedChangedFields: ["content", "title"],
  }]);
  const args = { course_id: 2, module_id: 7, chapter_id: 31, title: "Evidence", content: "<p>Cells move water.</p>", expected_digest: "d".repeat(64) };
  assert.deepEqual(changedFields(args), ["content", "title"]);
  assert.equal(matchesBridgeEditPermission(bridgeBinding(permission), {
    provider: "moodle",
    catalogDigest: CATALOG_DIGEST,
    operationKey: "moodle.form.mod.book.chapter.write.v1",
    toolName: "moodle_update_book_chapter",
    arguments: args,
  }), true);
});

test("a granted Moodle Book chapter deletion carries no field grant and still authorizes its own write", async () => {
  const permission = await createEditPermission({
    binding, catalogDigest: CATALOG_DIGEST, revision: 1, operations: moodleOperations,
    enabledCategories: ["action:moodle:moodle_delete_book_chapter"],
  });
  assert.deepEqual(permission.rules, [{
    operationKey: "moodle.form.mod.book.chapter.delete.write.v1",
    toolName: "moodle_delete_book_chapter",
    allowedChangedFields: [],
  }]);
  const args = { course_id: 2, module_id: 7, chapter_id: 31, expected_digest: "d".repeat(64) };
  assert.deepEqual(changedFields(args), []);
  assert.equal(matchesBridgeEditPermission(bridgeBinding(permission), {
    provider: "moodle",
    catalogDigest: CATALOG_DIGEST,
    operationKey: "moodle.form.mod.book.chapter.delete.write.v1",
    toolName: "moodle_delete_book_chapter",
    arguments: args,
  }), true);
  assert.equal(matchesBridgeEditPermission(bridgeBinding(permission), {
    provider: "moodle",
    catalogDigest: CATALOG_DIGEST,
    operationKey: "moodle.form.mod.book.chapter.delete.write.v1",
    toolName: "moodle_delete_book_chapter",
    arguments: { ...args, title: "Renamed" },
  }), false);
});
