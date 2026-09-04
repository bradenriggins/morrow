import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateBrowserReadback, planBrowserReadback } from "../../connector/extension/src/verification.js";

const catalog = JSON.parse(readFileSync(new URL("../../artifacts/canvas-api/canvas-api-catalog.json", import.meta.url), "utf8"));
const operation = (name) => {
  const value = catalog.operations.find((candidate) => candidate.toolName === name);
  assert.ok(value, `missing catalog operation ${name}`);
  return value;
};

function verify(toolName, argumentsValue, writeData, readData, expectedReadTool) {
  const plan = planBrowserReadback(catalog.operations, operation(toolName), argumentsValue, writeData);
  assert.ok(plan, `${toolName} must have a readback plan`);
  assert.equal(plan.readOperation.toolName, expectedReadTool);
  const result = evaluateBrowserReadback(plan, readData);
  assert.equal(result.status, "verified", `${toolName}: ${JSON.stringify(result)}`);
  return plan;
}

test("connector-owned readback proves New Quiz postconditions", () => {
  const quizPlan = verify(
    "canvas_update_single_quiz",
    {
      course_id: "42",
      assignment_id: "77",
      quiz_title: "Verified New Quiz",
      quiz_points_possible: 10,
    },
    { id: "77" },
    {
      ok: true,
      status: 200,
      data: { id: "77", title: "Verified New Quiz", points_possible: 10 },
    },
    "canvas_get_new_quiz",
  );
  assert.deepEqual(quizPlan.arguments, { assignment_id: "77", course_id: "42" });
  assert.match(evaluateBrowserReadback(quizPlan, {
    ok: true,
    status: 200,
    data: { id: "77", title: "Wrong title", points_possible: 10 },
  }).evidence, /quiz_title/);

  const deletePlan = planBrowserReadback(catalog.operations, operation("canvas_delete_quiz_item"), {
    course_id: "42",
    assignment_id: "77",
    item_id: "88",
  }, null);
  assert.equal(evaluateBrowserReadback(deletePlan, { ok: false, status: 404 }).status, "verified");
});

test("every Item Bank write has an exact successful fresh-readback proof", () => {
  const cases = [
    {
      tool: "canvas_item_bank_create_bank",
      args: { title: "Reusable anatomy" },
      writeData: { id: "901" },
      readTool: "canvas_item_bank_get_bank",
      read: { ok: true, status: 200, data: { id: "901", title: "Reusable anatomy" } },
    },
    {
      tool: "canvas_item_bank_archive_bank",
      args: { bank_id: "901" },
      writeData: {},
      readTool: "canvas_item_bank_get_bank",
      read: { ok: true, status: 200, data: { id: "901", archived: true } },
    },
    {
      tool: "canvas_item_bank_attach_item",
      args: { bank_id: "901", item_id: "501" },
      writeData: { id: "701" },
      readTool: "canvas_item_bank_list_entries",
      read: { ok: true, status: 200, data: [{ id: "701", entry_id: "501", entry_type: "Item" }] },
    },
    {
      tool: "canvas_item_bank_create_item",
      args: { bank_id: "901", item: { title: "Reusable question", interaction_type_slug: "essay" } },
      writeData: { id: "502" },
      readTool: "canvas_item_bank_list_entries",
      read: { ok: true, status: 200, data: [{ entry_id: "502", item: { id: "502", title: "Reusable question", interaction_type_slug: "essay" } }] },
    },
    {
      tool: "canvas_item_bank_update_item",
      args: { bank_id: "901", item_id: "502", item: { title: "Revised question" } },
      writeData: { id: "502" },
      readTool: "canvas_item_bank_list_entries",
      read: { ok: true, status: 200, data: [{ entry_id: "502", item: { id: "502", title: "Revised question" } }] },
    },
    {
      tool: "canvas_item_bank_delete_entry",
      args: { bank_id: "901", bank_entry_id: "701" },
      writeData: {},
      readTool: "canvas_item_bank_get_entry",
      read: { ok: false, status: 404 },
    },
    {
      tool: "canvas_item_bank_share_bank",
      args: { bank_id: "901", entity_type: "Course", entity_id: "42" },
      writeData: { id: "801" },
      readTool: "canvas_item_bank_list_shares",
      read: { ok: true, status: 200, data: [{ id: "801", entity_id: "42", entity_type: "Course" }] },
    },
  ];

  assert.equal(cases.length, catalog.operations.filter((candidate) => candidate.service === "item_bank" && !candidate.readOnly).length);
  for (const entry of cases) {
    verify(entry.tool, entry.args, entry.writeData, entry.read, entry.readTool);
  }
});

test("Item Bank verification refuses mismatches and incomplete evidence", () => {
  const create = planBrowserReadback(catalog.operations, operation("canvas_item_bank_create_bank"), { title: "Expected" }, { id: "901" });
  assert.equal(evaluateBrowserReadback(create, { ok: true, status: 200, data: { id: "901", title: "Wrong" } }).status, "mismatch");

  const share = planBrowserReadback(catalog.operations, operation("canvas_item_bank_share_bank"), {
    bank_id: "901",
    entity_type: "Course",
    entity_id: "42",
  }, { id: "801" });
  assert.equal(evaluateBrowserReadback(share, { ok: true, status: 200, data: [] }).status, "mismatch");

  const update = planBrowserReadback(catalog.operations, operation("canvas_item_bank_update_item"), {
    bank_id: "901",
    item_id: "502",
    item: { title: "Revised" },
  }, { id: "502" });
  assert.equal(update.targetField, "entry_id");
  assert.equal(share.targetField, "entity_id");
  assert.equal(evaluateBrowserReadback(update, { ok: false, status: 503 }).status, "unconfirmed");

  const crossedUpdate = evaluateBrowserReadback(update, {
    ok: true,
    status: 200,
    data: [
      { entry_id: "502", item: { id: "502", title: "Old title" } },
      { entry_id: "503", item: { id: "503", title: "Revised" } },
    ],
  });
  assert.equal(crossedUpdate.status, "mismatch");

  const crossedShare = evaluateBrowserReadback(share, {
    ok: true,
    status: 200,
    data: [
      { entity_id: "42", entity_type: "User" },
      { entity_id: "99", entity_type: "Course" },
    ],
  });
  assert.equal(crossedShare.status, "mismatch");

  assert.equal(evaluateBrowserReadback(update, {
    ok: true,
    status: 200,
    data: [{ id: "502", entry_id: "701", item: { id: "502", title: "Revised" } }],
  }).status, "mismatch");
  assert.equal(evaluateBrowserReadback(share, {
    ok: true,
    status: 200,
    data: [{ id: "42", entity_id: "99", entity_type: "Course" }],
  }).status, "mismatch");

  assert.equal(evaluateBrowserReadback({
    strategy: "updated-resource",
    readOperation: { toolName: "canvas_item_bank_get_bank" },
    assertions: [],
  }, { ok: true, status: 200, data: { id: "901" } }).status, "unconfirmed");

  assert.equal(evaluateBrowserReadback({
    strategy: "collection-omits-target",
    targetId: "701",
    readOperation: { toolName: "canvas_item_bank_list_entries" },
    assertions: [],
  }, { ok: true, status: 200, data: { entries: [] }, truncated: true }).status, "unconfirmed");
  assert.equal(evaluateBrowserReadback({
    strategy: "collection-omits-target",
    targetId: "701",
    readOperation: { toolName: "canvas_item_bank_list_entries" },
    assertions: [],
  }, { ok: true, status: 200, data: [] }).status, "verified");
});
