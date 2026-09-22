import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  categoriesForBinding,
  CURATED_CATEGORY_SPECS,
  destructiveOperation,
  operationLearnerVisible,
  operationReach,
} from "../../connector/extension/src/edit-policy.js";

// WI-3.2: the 19 curated Canvas task bundles of canvas-bundles.draft.json, plus the merged
// `canvas_alt_text` bundle (MORROW-UX-BUILD-SPEC.md, WI-3.2). This file tests the bundles as they
// stand in `CURATED_CATEGORY_SPECS`, not the appendix JSON: the JSON is the source the bundles were
// authored from, and it carries no `canvas_alt_text` entry of its own.

const root = new URL("../../", import.meta.url);
const canvasOperations = JSON.parse(readFileSync(new URL("connector/extension/generated/canvas-api-catalog.json", root), "utf8"))
  .operations.map((operation) => ({ ...operation, provider: "canvas" }));
const byTool = new Map(canvasOperations.map((operation) => [operation.toolName, operation]));

const DRAFT_BUNDLE_IDS = [
  "canvas_pages_text", "canvas_modules_structure", "canvas_assignment_text", "canvas_discussion_text",
  "canvas_classic_quiz_text", "canvas_files_organize", "canvas_dates", "canvas_pages_create",
  "canvas_modules_create", "canvas_assignment_setup", "canvas_assignment_create", "canvas_publish_state",
  "canvas_rubrics", "canvas_classic_quiz_settings", "canvas_classic_quiz_questions", "canvas_new_quiz_items",
  "canvas_calendar", "canvas_gradebook_setup", "canvas_discussion_create",
];
const WI_3_2_BUNDLE_IDS = [...DRAFT_BUNDLE_IDS, "canvas_alt_text"];

const bundleSpecs = CURATED_CATEGORY_SPECS.filter((spec) => WI_3_2_BUNDLE_IDS.includes(spec.id));
const routineBundleSpecs = bundleSpecs.filter((spec) => spec.routine === true);
// A folder holds no content and is not shown to learners by itself, so `canvas_create_folder_courses`
// is the one POST a routine bundle may carry (MORROW-UX-BUILD-SPEC.md, WI-3.2, "The routine rule").
const ROUTINE_POST_EXCEPTION = "canvas_create_folder_courses";

const options = categoriesForBinding({ provider: "canvas" }, canvasOperations);
const option = (id) => options.find((entry) => entry.id === id);

test("the appendix's 19 draft bundles and the merged canvas_alt_text bundle are all present, once each", () => {
  assert.equal(bundleSpecs.length, WI_3_2_BUNDLE_IDS.length);
  assert.deepEqual(bundleSpecs.map((spec) => spec.id).sort(), [...WI_3_2_BUNDLE_IDS].sort());
});

test("each rule's tool is in the catalog, is Edit-available, and each allowed field is on that tool", () => {
  for (const spec of bundleSpecs) {
    assert.ok(spec.rules.length > 0, spec.id);
    for (const rule of spec.rules) {
      const operation = byTool.get(rule.toolName);
      assert.ok(operation, `${spec.id}: ${rule.toolName} is not in the catalog`);
      assert.equal(operation.key, rule.operationKey, `${spec.id}: ${rule.toolName} operationKey`);
      assert.equal(operation.readOnly, false, `${spec.id}: ${rule.toolName} is not a write`);
      const properties = new Set(Object.keys(operation.inputSchema?.properties || {}));
      for (const field of rule.allowedChangedFields) {
        assert.ok(properties.has(field), `${spec.id}: ${rule.toolName} has no field "${field}"`);
      }
    }
    const publicOption = option(spec.id);
    assert.ok(publicOption, `${spec.id} is not in categoriesForBinding`);
    assert.equal(publicOption.availability, "edit", spec.id);
  }
});

test("each bundle label is 40 characters or fewer, carries no markup, and is not a duplicate", () => {
  const seen = new Map();
  // The rule covers the task bundles. The older curated repairs keep their longer labels, and the
  // Customize view folds the seven alternative-text ones into `canvas_alt_text`.
  for (const entry of options.filter((item) => !item.id.startsWith("action:") && item.group === "Canvas task bundles")) {
    assert.ok(entry.label.length <= 40, `${entry.id} label "${entry.label}" is ${entry.label.length} characters`);
    assert.doesNotMatch(entry.label, /[<>&]/, entry.id);
    const prior = seen.get(entry.label);
    assert.ok(!prior, `${entry.id} and ${prior} share the label "${entry.label}"`);
    seen.set(entry.label, entry.id);
  }
});

test("a routine bundle changes what exists: no removal, no reach beyond the course, nothing learner-visible, and no POST or DELETE except the one named folder exception", () => {
  assert.equal(routineBundleSpecs.length, 7);
  for (const spec of routineBundleSpecs) {
    for (const rule of spec.rules) {
      const operation = byTool.get(rule.toolName);
      assert.equal(destructiveOperation(operation), false, `${spec.id}: ${rule.toolName} is a removal tool`);
      assert.equal(operationReach(operation), "course", `${spec.id}: ${rule.toolName} reaches beyond the course`);
      assert.equal(
        operationLearnerVisible(operation, rule.allowedChangedFields),
        false,
        `${spec.id}: ${rule.toolName} is learner-visible with fields [${rule.allowedChangedFields.join(", ")}]`,
      );
      const method = String(operation.method || "").toUpperCase();
      if (method === "POST" || method === "DELETE") {
        assert.equal(rule.toolName, ROUTINE_POST_EXCEPTION, `${spec.id}: ${rule.toolName} is a ${method} route`);
      }
    }
  }
});

test("a rememberable bundle that is not routine is canvas_dates or the Moodle dates bundle, and no other", () => {
  const fixedList = new Set(["canvas_dates", "dates"]);
  for (const spec of CURATED_CATEGORY_SPECS) {
    if (spec.rememberable === true && spec.routine !== true) {
      assert.ok(fixedList.has(spec.id), `${spec.id} is rememberable and not routine, outside the fixed list`);
    }
  }
  assert.equal(CURATED_CATEGORY_SPECS.find((spec) => spec.id === "canvas_dates")?.rememberable, true);
});

// AGENT-BRIEF.md, "Pins are changed on purpose": this count moves only when a work item adds or
// removes a curated bundle on purpose, and the report for that work item states the old and the new
// value. WI-3.2 raised it from 13 (dates, content, organize, canvas_page_content, the seven
// alternative-text specs, canvas_inbox_messages, canvas_assignment_due_date) to 33, by adding the 19
// draft bundles and canvas_alt_text.
test("the curated bundle count is pinned", () => {
  assert.equal(CURATED_CATEGORY_SPECS.length, 33);
});

// WI-3.3: the three present Moodle bundle ids keep their rules unchanged and carry the routine and
// rememberable flags the spec part gives them: `content` is routine and rememberable, `dates` is
// rememberable only (D2b), and `organize` carries neither, because showing or hiding an existing
// section or activity is a publish change (Customize view only).
test("the three Moodle bundles carry the routine and rememberable flags WI-3.3 gives them, with their present rules unchanged", () => {
  const moodleContent = CURATED_CATEGORY_SPECS.find((spec) => spec.id === "content");
  assert.equal(moodleContent.routine, true);
  assert.equal(moodleContent.rememberable, true);
  assert.deepEqual(moodleContent.rules.map((rule) => rule.toolName), [
    "moodle_update_page", "moodle_update_label", "moodle_update_assignment", "moodle_update_quiz",
  ]);

  const moodleDates = CURATED_CATEGORY_SPECS.find((spec) => spec.id === "dates");
  assert.equal(moodleDates.routine, undefined);
  assert.equal(moodleDates.rememberable, true);
  assert.deepEqual(moodleDates.rules.map((rule) => rule.toolName), ["moodle_update_assignment", "moodle_update_quiz"]);

  const moodleOrganize = CURATED_CATEGORY_SPECS.find((spec) => spec.id === "organize");
  assert.equal(moodleOrganize.routine, undefined);
  assert.equal(moodleOrganize.rememberable, undefined);
  assert.deepEqual(moodleOrganize.rules.map((rule) => rule.toolName), [
    "moodle_move_activity", "moodle_show_section", "moodle_hide_section", "moodle_show_activity", "moodle_hide_activity",
  ]);
});

// The routine rule (D2a) is stated for the Canvas task bundles above; this proves the Moodle
// `content` bundle, the one Moodle bundle WI-3.3 makes routine, actually satisfies it: no removal,
// no reach beyond the course, and nothing learner-visible.
test("the Moodle content bundle satisfies the routine rule: no removal, no reach beyond the course, nothing learner-visible", () => {
  const moodleOperations = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8")).operations;
  const moodleByTool = new Map(moodleOperations.map((operation) => [operation.toolName, operation]));
  const moodleContent = CURATED_CATEGORY_SPECS.find((spec) => spec.id === "content");
  for (const rule of moodleContent.rules) {
    const operation = moodleByTool.get(rule.toolName);
    assert.ok(operation, rule.toolName);
    assert.equal(destructiveOperation(operation), false, rule.toolName);
    assert.equal(operationReach(operation), "course", rule.toolName);
    assert.equal(operationLearnerVisible(operation, rule.allowedChangedFields), false, rule.toolName);
  }
});

test("the seven alternative-text specs that canvas_alt_text joins keep their ids and stay in the option list, so a saved permission and the runtime's planners still find them", () => {
  const hiddenIds = [
    "canvas_page_image_alt", "canvas_assignment_image_alt", "canvas_discussion_image_alt",
    "canvas_classic_quiz_description_image_alt", "canvas_classic_quiz_question_image_alt",
    "canvas_new_quiz_item_image_alt", "canvas_new_quiz_nested_image_alt",
  ];
  for (const id of hiddenIds) {
    const spec = CURATED_CATEGORY_SPECS.find((entry) => entry.id === id);
    assert.ok(spec, id);
    assert.equal(spec.hiddenFromUi, true, id);
    assert.ok(option(id), `${id} must stay in categoriesForBinding`);
  }
  const altText = option("canvas_alt_text");
  assert.ok(altText);
  assert.equal(altText.routine, true);
  assert.equal(altText.rememberable, true);
  const altTextSpec = CURATED_CATEGORY_SPECS.find((entry) => entry.id === "canvas_alt_text");
  const mergedRuleCount = hiddenIds.reduce((total, id) => total + CURATED_CATEGORY_SPECS.find((entry) => entry.id === id).rules.length, 0);
  assert.equal(altTextSpec.rules.length, mergedRuleCount);
  for (const id of hiddenIds) {
    const originalRules = CURATED_CATEGORY_SPECS.find((entry) => entry.id === id).rules;
    for (const originalRule of originalRules) {
      assert.ok(
        altTextSpec.rules.some((rule) => rule.toolName === originalRule.toolName && rule.canvasContentGuardKind === originalRule.canvasContentGuardKind),
        `canvas_alt_text is missing the ${id} rule (${originalRule.canvasContentGuardKind})`,
      );
    }
  }
});
